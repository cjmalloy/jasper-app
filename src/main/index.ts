import axios, { type AxiosHeaders } from "axios";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import Electrobun, {
  BrowserView,
  BrowserWindow,
  PATHS,
  Screen,
  Tray,
  Updater,
  Utils,
} from "electrobun/main";
import type {
  ImageTags,
  JasperRPC,
  PtySize,
  SettingsData,
} from "../shared/rpc";

if (process.platform !== "win32") {
  process.env.PATH = `${process.env.PATH ?? ""}:/usr/local/bin`;
}

type WindowRole = "logs" | "main" | "settings";
type JasperMainRPC = ReturnType<typeof BrowserView.defineRPC<JasperRPC>>;
type JasperWindow = BrowserWindow<JasperMainRPC>;

const serverConfig = path.join(
  PATHS.VIEWS_FOLDER,
  "assets",
  "docker-compose.yaml",
);
const bridgePreload = "views://bridge/index.js";
const settingsDir = Utils.paths.userData;
const settingsPath = path.join(settingsDir, "settings.json");

fs.mkdirSync(settingsDir, { recursive: true });

function readSettings(): SettingsData | null {
  const candidates = [
    settingsPath,
    path.join(Utils.paths.appData, "Jasper", "settings.json"),
    path.join(Utils.paths.appData, "jasper-app", "settings.json"),
  ];

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (candidate !== settingsPath) {
        fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2));
      }
      return value;
    } catch {
      // Try the next location, then fall back to defaults.
    }
  }
  return null;
}

let data: SettingsData =
  readSettings() ??
  {
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    autoUpdate: true,
    serverVersion: "v1.3",
    pullServer: true,
    serverPort: "8081",
    serverProfiles: "prod,jwt,storage,scripts,proxy,file-cache",
    serverDefaultRole: "ROLE_ADMIN",
    serverRam: "1g",
    clientVersion: "v1.3",
    pullClient: true,
    clientPort: "8082",
    clientTitle: "Jasper",
    databaseVersion: "18",
    pullDatabase: true,
    dataDir: path.join(settingsDir, "data"),
    storageDir: path.join(settingsDir, "storage"),
    sshVersion: "v1.1",
    pullSsh: true,
    sshPort: "8022",
    cfToken: "",
    ngrokUrl: "",
    ngrokToken: "",
    showLogsOnStart: false,
  };

let appVersion = "1.1.23";
const appVersionReady = Updater.getLocalInfo()
  .then((info) => {
    appVersion = info.version;
  })
  .catch((error) => {
    console.error("Unable to read application version:", error);
  });

function writeData() {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

async function settingsForView() {
  await appVersionReady;
  return { ...data, appVersion };
}

function getEntry() {
  return `http://localhost:${data.clientPort}`;
}

function getServerHealthCheck() {
  return `http://localhost:${data.serverPort}/management/health/readiness`;
}

const maxLogBuffer = 512 * 1024;
let logBuffer = "";
let mainLogSubscriber = false;
let logsLogSubscriber = false;
const livePtys = new Set<Bun.Terminal>();
let ptySize: PtySize = { cols: 120, rows: 30 };
let winPtySize: PtySize | null = null;

function isWindowOpen(handle: JasperWindow | undefined): handle is JasperWindow {
  return !!handle && BrowserWindow.getById(handle.id) === handle;
}

function resizePtys(size: PtySize | null) {
  if (!size?.cols || !size?.rows) return;
  if (size.cols === ptySize.cols && size.rows === ptySize.rows) return;
  ptySize = { cols: size.cols, rows: size.rows };
  for (const pty of livePtys) {
    try {
      pty.resize(ptySize.cols, ptySize.rows);
    } catch (error) {
      console.error("Failed to resize PTY:", error);
    }
  }
}

function sendLogs(output: string) {
  process.stdout.write(output);
  logBuffer = (logBuffer + output).slice(-maxLogBuffer);
  if (
    isWindowOpen(win) &&
    mainLogSubscriber &&
    !firstLoad &&
    winRpc
  ) {
    void winRpc.send.streamLogs(output);
  }
  if (isWindowOpen(logs) && logsLogSubscriber && logsRpc) {
    void logsRpc.send.streamLogs(output);
  }
}

async function consumeOutput(stream: unknown) {
  if (!(stream instanceof ReadableStream)) return;
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sendLogs(decoder.decode(value, { stream: true }));
    }
    const final = decoder.decode();
    if (final) sendLogs(final);
  } finally {
    reader.releaseLock();
  }
}

function commandEnvironment() {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  env.COMPOSE_MENU = "false";
  return env;
}

function dc(command: string) {
  const emitter = new EventEmitter();
  const commandLine = [
    "docker",
    "compose",
    "--ansi",
    "always",
    "-f",
    serverConfig,
    ...(data.cfToken ? ["--profile", "cf"] : []),
    ...(data.ngrokToken ? ["--profile", "ngrok"] : []),
    command,
  ];

  try {
    if (process.platform !== "win32") {
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: ptySize.cols,
        rows: ptySize.rows,
        data: (_terminal, output) => {
          sendLogs(decoder.decode(output, { stream: true }));
        },
      });
      livePtys.add(terminal);
      const child = Bun.spawn(commandLine, {
        env: commandEnvironment(),
        terminal,
      });
      void child.exited.then(
        (exitCode) => {
          const final = decoder.decode();
          if (final) sendLogs(final);
          livePtys.delete(terminal);
          terminal.close();
          emitter.emit("exit", exitCode, null);
          emitter.emit("close", exitCode, null);
        },
        (error) => emitter.emit("error", error),
      );
    } else {
      const child = Bun.spawn(commandLine, {
        env: commandEnvironment(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      void consumeOutput(child.stdout).catch((error) =>
        console.error("Unable to read Docker output:", error),
      );
      void consumeOutput(child.stderr).catch((error) =>
        console.error("Unable to read Docker errors:", error),
      );
      void child.exited.then(
        (exitCode) => {
          emitter.emit("exit", exitCode, null);
          emitter.emit("close", exitCode, null);
        },
        (error) => emitter.emit("error", error),
      );
    }
  } catch (error) {
    setTimeout(() => emitter.emit("error", error), 0);
  }

  return emitter;
}

function notify(command: string) {
  const process = dc(command);
  process.once("close", () => {
    if (settingsRpc) void settingsRpc.send.finished(command);
  });
  process.once("error", (error) => {
    console.error(`Unable to run docker compose ${command}:`, error);
    if (settingsRpc) void settingsRpc.send.finished(command);
  });
  return process;
}

function getToken(userTag: string, secret: string) {
  const header = {
    alg: "HS512",
    typ: "JWT",
  };
  const payload = {
    aud: "",
    sub: userTag,
    auth: "ROLE_ADMIN",
  };
  const body =
    Buffer.from(JSON.stringify(header)).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto.createHmac("sha512", Buffer.from(secret, "base64"));
  const digest = hmac.update(body).digest("base64url");
  return `${body}.${digest}`;
}

function writeEnv() {
  const key = crypto
    .generateKeySync("hmac", { length: 1024 })
    .export()
    .toString("base64");
  process.env.JASPER_LOCALE = data.locale ?? "";
  process.env.JASPER_SERVER_PROFILES = data.serverProfiles ?? "";
  process.env.JASPER_SERVER_DEFAULT_ROLE =
    data.serverDefaultRole || "ROLE_ANONYMOUS";
  process.env.JASPER_PREFETCH = [
    "ROLE_VIEWER",
    "ROLE_ANONYMOUS",
  ].includes(data.serverDefaultRole || "ROLE_ANONYMOUS")
    ? "true"
    : "false";
  process.env.JASPER_SERVER_VERSION = data.serverVersion ?? "";
  process.env.JASPER_SERVER_PULL = data.pullServer ? "always" : "missing";
  process.env.JASPER_SERVER_PORT = data.serverPort;
  process.env.JASPER_SERVER_HEAP = data.serverRam ?? "";
  process.env.JASPER_SERVER_KEY = key;
  process.env.JASPER_CLIENT_VERSION = data.clientVersion ?? "";
  process.env.JASPER_CLIENT_PULL = data.pullClient ? "always" : "missing";
  process.env.JASPER_CLIENT_PORT = data.clientPort;
  process.env.JASPER_CLIENT_TITLE = data.clientTitle ?? "";
  process.env.JASPER_CLIENT_TOKEN = getToken("+user", key);
  process.env.JASPER_DATABASE_VERSION = data.databaseVersion ?? "";
  process.env.JASPER_DATABASE_PULL = data.pullDatabase ? "always" : "missing";
  process.env.JASPER_DATABASE_PASSWORD = data.dbPassword ?? "";
  process.env.JASPER_DATA_DIR = data.dataDir;
  process.env.JASPER_STORAGE_DIR = data.storageDir;
  process.env.JASPER_SSH_VERSION = data.sshVersion ?? "";
  process.env.JASPER_SSH_PULL = data.pullSsh ? "always" : "missing";
  process.env.JASPER_SSH_PORT = data.sshPort;
  process.env.JASPER_SSH_TOKEN = getToken("+user", key);
  process.env.CLOUDFLARE_TOKEN = data.cfToken;
  process.env.NGROK_URL = data.ngrokUrl;
  process.env.NGROK_TOKEN = data.ngrokToken;
}

function showError(title: string, message: string) {
  return Utils.showMessageBox({
    type: "error",
    title,
    message,
    buttons: ["OK"],
    defaultId: 0,
    cancelId: 0,
  });
}

function startServer() {
  writeEnv();
  if (data.showLogsOnStart) {
    createLogsWindow();
  }
  return dc("up")
    .once("error", (error) => {
      void showError(
        "Docker Compose Missing",
        "This application requires Docker Compose to be installed.\n" +
          "Download it at https://www.docker.com/products/docker-desktop/\n\n" +
          error,
      ).then(() => forceQuit());
    })
    .once("exit", (code, signal) => {
      if (code === 1) {
        void showError(
          "Docker Not Running",
          "This application requires Docker to be running.\n" +
            "Start Docker and try again.",
        );
      } else if (code !== null) {
        console.log(`docker process exited with code ${code}`);
      } else if (signal !== null) {
        console.log(`docker process terminated by signal ${signal}`);
      }
    });
}

let forceQuitting = false;
let shuttingDown = false;

function closeWindows() {
  if (isWindowOpen(win)) win.close();
  if (isWindowOpen(logs)) logs.close();
  if (isWindowOpen(settings)) settings.close();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  writeData();
  tray.setMenu([
    { type: "normal", label: "Shutting down...", enabled: false },
    { type: "normal", label: "Force Quit", action: "force-quit" },
  ]);
  dc("down")
    .once("close", forceQuit)
    .once("error", (error) => {
      console.error("Unable to stop Docker services:", error);
      forceQuit();
    });
  closeWindows();
}

function forceQuit() {
  forceQuitting = true;
  tray.remove();
  Utils.quit();
}

let availableUpdateVersion: string | null = null;
let checkingUpdates = false;

function trayMenu() {
  return [
    { type: "normal" as const, label: "Show Window", action: "show-window" },
    { type: "normal" as const, label: "Show Logs", action: "show-logs" },
    { type: "normal" as const, label: "Show Backups", action: "show-backups" },
    { type: "normal" as const, label: "Settings", action: "settings" },
    {
      type: "normal" as const,
      label: "Check for Updates",
      action: "check-updates",
    },
    ...(availableUpdateVersion
      ? [
          {
            type: "normal" as const,
            label: `🌟 Update to v${availableUpdateVersion}`,
            action: "install-update",
          },
        ]
      : []),
    { type: "separator" as const },
    { type: "normal" as const, label: "Quit", action: "quit" },
  ];
}

async function checkUpdates() {
  if (checkingUpdates) return;
  checkingUpdates = true;
  _imageTags = null;
  try {
    await appVersionReady;
    console.log("Jasper App Version:", appVersion);
    console.log(`Auto Update ${data.autoUpdate ? "on" : "off"}.`);
    const update = await Updater.checkForUpdate();
    if (!update.updateAvailable) return;
    availableUpdateVersion = update.version;
    tray.setMenu(trayMenu());
    Utils.showNotification({
      title: "Jasper Update Available",
      body: data.autoUpdate
        ? "Downloading the latest Jasper update..."
        : `Jasper ${update.version} is available.`,
    });
    if (data.autoUpdate) await Updater.downloadUpdate();
  } catch (error) {
    console.error("Unable to check for updates:", error);
  } finally {
    checkingUpdates = false;
  }
}

async function installUpdate() {
  if (process.platform === "darwin") {
    Utils.openExternal(
      "https://github.com/cjmalloy/jasper-app/releases/latest",
    );
    return;
  }

  try {
    if (!Updater.updateInfo().updateReady) {
      await Updater.downloadUpdate();
    }
    shuttingDown = true;
    tray.setMenu([
      { type: "normal", label: "Installing update...", enabled: false },
    ]);
    dc("down")
      .once("close", () => {
        forceQuitting = true;
        void Updater.applyUpdate().catch((error) => {
          forceQuitting = false;
          shuttingDown = false;
          tray.setMenu(trayMenu());
          console.error("Unable to apply update:", error);
        });
      })
      .once("error", (error) => {
        shuttingDown = false;
        tray.setMenu(trayMenu());
        console.error("Unable to stop Docker services:", error);
      });
  } catch (error) {
    console.error("Unable to download update:", error);
  }
}

function createRpc(role: WindowRole) {
  return BrowserView.defineRPC<JasperRPC>({
    handlers: {
      requests: {
        fetchSettings: async () =>
          role === "settings" ? settingsForView() : {},
        saveSettings: ({ settings: value }) => {
          if (role !== "settings") return { success: false };
          updateSettings(value);
          return { success: true };
        },
        patchSettings: ({ name, value }) => {
          if (role !== "settings") return { success: false };
          patchSettings(name, value);
          return { success: true };
        },
        command: ({ command }) => {
          const allowed = new Set([
            "down",
            "pause",
            "pull",
            "restart",
            "unpause",
            "up",
          ]);
          if (role !== "settings" || !allowed.has(command)) {
            return { accepted: false };
          }
          notify(command);
          return { accepted: true };
        },
        openDir: ({ path: directory }) => {
          if (role !== "settings" || !path.isAbsolute(directory)) {
            return { success: false };
          }
          return { success: Utils.openPath(directory) };
        },
        fetchLogs: () => {
          if (role === "main") mainLogSubscriber = true;
          if (role === "logs") logsLogSubscriber = true;
          return { logs: logBuffer };
        },
        resizePty: (size) => {
          if (!size?.cols || !size?.rows) return { success: false };
          const logsOpen = isWindowOpen(logs);
          if (role === "logs" && logsOpen) {
            resizePtys(size);
          } else if (role === "main") {
            winPtySize = size;
            if (!logsOpen) resizePtys(size);
          }
          return { success: true };
        },
      },
      messages: {},
    },
  });
}

function createWindow(
  config: SettingsData,
  role: WindowRole,
  url: string,
) {
  const workArea = Screen.getPrimaryDisplay().workArea;
  if (!config.bounds) {
    config.bounds = {
      width: Math.round(workArea.width * 0.8),
      height: Math.round(workArea.height * 0.8),
    };
  }
  const rpc = createRpc(role);
  const handle = new BrowserWindow({
    title: data.clientTitle || "Jasper",
    frame: config.bounds,
    url,
    preload: bridgePreload,
    rpc,
    navigationRules: JSON.stringify(["^*", "views://*", getEntry(), `${getEntry()}/*`]),
    spellCheck: true,
    hidden: true,
  });
  if (config.maximized) {
    handle.maximize();
  }
  handle.webview.on("dom-ready", () => handle.show());
  handle.on("resize", () => {
    config.maximized = handle.isMaximized();
    if (config.maximized) return;
    config.bounds = handle.getFrame();
  });
  handle.on("move", () => {
    config.maximized = handle.isMaximized();
    if (config.maximized) return;
    config.bounds = handle.getFrame();
  });
  handle.on("will-close", (event: unknown) => {
    if (forceQuitting || shuttingDown) return;
    (
      event as {
        response: { allow: boolean };
      }
    ).response = { allow: false };
    handle.hide();
  });
  handle.on("close", () => {
    if (role === "main") mainLogSubscriber = false;
    if (role === "logs") {
      logsLogSubscriber = false;
      resizePtys(winPtySize);
    }
  });
  return { handle, rpc };
}

function externalUrlFromEvent(event: unknown) {
  const detail = (
    event as {
      data?: {
        detail?: string | { url?: string };
      };
    }
  ).data?.detail;
  return typeof detail === "string" ? detail : detail?.url;
}

async function createMainWindow(showLoading = false) {
  if (!showLoading && isWindowOpen(win)) {
    win.show();
    return;
  }
  if (!isWindowOpen(win)) {
    const created = createWindow(
      data,
      "main",
      "views://loading/index.html",
    );
    win = created.handle;
    winRpc = created.rpc;
    const listen = win.webview.on as (
      name: string,
      handler: (event: unknown) => void,
    ) => void;
    listen("new-window-open", (event) => {
      const url = externalUrlFromEvent(event);
      if (url) Utils.openExternal(url);
    });
  }
  if (showLoading) {
    firstLoad = false;
    mainLogSubscriber = false;
    win.webview.loadURL("views://loading/index.html");
  }
  await waitFor200(getEntry(), showLoading ? 5000 : 100);
  await waitForHealth(getServerHealthCheck());
  firstLoad = true;
  if (isWindowOpen(win)) {
    win.webview.loadURL(getEntry());
  }
}

async function sendSettings() {
  if (!settingsRpc) return;
  void settingsRpc.send.updateSettings(await settingsForView());
  void getImageTags().then((tags) => settingsRpc?.send.imageTags(tags));
}

function createSettingsWindow() {
  if (!data.settings) {
    data.settings = {
      bounds: {
        width: 540,
        height: 620,
      },
    };
  }
  if (isWindowOpen(settings)) {
    settings.show();
    void sendSettings();
    return;
  }
  const created = createWindow(
    data.settings,
    "settings",
    "views://settings/index.html",
  );
  settings = created.handle;
  settingsRpc = created.rpc;
  settings.webview.on("dom-ready", () => void sendSettings());
}

let _imageTags: ImageTags | null = null;

async function getImageTags(): Promise<ImageTags> {
  if (_imageTags) return _imageTags;
  const versions: ImageTags = {
    server: [],
    client: [],
    database: ["11", "12", "13", "14", "15", "16", "17", "18"],
    ssh: [],
  };
  return ghDockerTags("cjmalloy/jasper")
    .then((tags) => (versions.server = tags.filter((tag) => tag.startsWith("v"))))
    .then(() => ghDockerTags("cjmalloy/jasper-ui"))
    .then((tags) => (versions.client = tags.filter((tag) => tag.startsWith("v"))))
    .then(() => ghDockerTags("cjmalloy/jasper-ssh"))
    .then((tags) => (versions.ssh = tags.filter((tag) => tag.startsWith("v"))))
    .then(() => (_imageTags = versions));
}

function ghDockerTags(repo: string): Promise<string[]> {
  return axios
    .get(`https://ghcr.io/token?scope=repository:${repo}:pull`)
    .catch((error) => {
      console.error(`Can't get registry token for ${repo}:`, error);
      throw error;
    })
    .then((response) =>
      dockerTags(
        "https://ghcr.io",
        `/v2/${repo}/tags/list`,
        response.data.token,
      ),
    );
}

function dockerTags(
  host: string,
  requestPath: string,
  token: string,
  tags: string[] = [],
): Promise<string[]> {
  return axios
    .get(host + requestPath, {
      headers: { Authorization: "Bearer " + token },
    })
    .catch((error) => {
      console.error(`Can't get tag list ${requestPath}:`, error);
      throw error;
    })
    .then((response) => {
      tags.push(...response.data.tags);
      const next = (response.headers as AxiosHeaders).get(
        "link",
        /<([^>]+)>; rel="next"/,
      );
      return next?.length
        ? dockerTags(host, next[1], token, tags)
        : tags;
    });
}

function createLogsWindow() {
  if (isWindowOpen(logs)) {
    logs.show();
    return;
  }
  if (!data.logs) data.logs = {};
  logsLogSubscriber = false;
  const created = createWindow(
    data.logs,
    "logs",
    "views://logs/index.html",
  );
  logs = created.handle;
  logsRpc = created.rpc;
}

function createTray() {
  const handle = new Tray({
    title: data.clientTitle || "Jasper",
    image: "views://assets/app.png",
    template: false,
    width: 32,
    height: 32,
  });
  handle.setMenu(trayMenu());
  handle.on("tray-clicked", (event: unknown) => {
    const action = (
      event as {
        data?: { action?: string };
      }
    ).data?.action;
    switch (action) {
      case "show-window":
        void createMainWindow();
        break;
      case "show-logs":
        createLogsWindow();
        break;
      case "show-backups":
        Utils.openPath(path.join(data.storageDir, "default/backups"));
        break;
      case "settings":
        createSettingsWindow();
        break;
      case "check-updates":
        void checkUpdates();
        break;
      case "install-update":
        void installUpdate();
        break;
      case "quit":
        shutdown();
        break;
      case "force-quit":
        forceQuit();
        break;
    }
  });
  return handle;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor200(
  url: string,
  firstDelay = 100,
): Promise<null> {
  return axios
    .get(url)
    .catch(() => ({ status: 0 }))
    .then((response) =>
      response.status === 200
        ? null
        : wait(firstDelay).then(() => waitFor200(url, 100)),
    );
}

async function waitForHealth(
  url: string,
  firstDelay = 100,
): Promise<null> {
  return axios
    .get(url)
    .catch(() => ({ data: {} }))
    .then((response) =>
      response.data.status === "UP"
        ? null
        : wait(firstDelay).then(() => waitForHealth(url, 100)),
    );
}

function updateSettings(value: SettingsData) {
  const { appVersion: _ignored, ...settingsValue } = value;
  data = {
    ...data,
    ...settingsValue,
  };
  writeEnv();
  writeData();
  firstLoad = false;
  mainLogSubscriber = false;
  if (isWindowOpen(win)) {
    win.webview.loadURL("views://loading/index.html");
    win.show();
  }
  dc("down")
    .once("close", () => {
      startServer();
      void createMainWindow(true);
      if (isWindowOpen(win)) win.show();
    })
    .once("error", (error) => {
      console.error("Unable to restart Docker services:", error);
    });
}

function patchSettings(name: string, value: unknown) {
  data[name] = value;
  writeEnv();
  writeData();
}

let firstLoad = false;
let tray: Tray;
let win: JasperWindow | undefined;
let logs: JasperWindow | undefined;
let settings: JasperWindow | undefined;
let winRpc: JasperMainRPC | undefined;
let logsRpc: JasperMainRPC | undefined;
let settingsRpc: JasperMainRPC | undefined;

Electrobun.events.on("reopen", () => {
  void createMainWindow();
});

Electrobun.events.on("before-quit", (event) => {
  if (forceQuitting) return;
  event.response = { allow: false };
  shutdown();
});

tray = createTray();
startServer();
void createMainWindow(true)
  .then(() => checkUpdates())
  .catch((error) => console.error("Unable to open Jasper:", error));

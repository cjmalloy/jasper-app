import axios, { AxiosHeaders } from 'axios';
import * as crypto from 'crypto';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray
} from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { spawn as ptySpawn } from '@lydell/node-pty';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

if (process.platform !== 'win32') {
  process.env.PATH = process.env.PATH + ':/usr/local/bin';
}

contextMenu({
  showSaveImageAs: true,
  showInspectElement: true,
});

const serverConfig = path.join(__dirname, 'docker-compose.yaml');
const lanConfig = path.join(__dirname, 'docker-compose.lan.yaml');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// New secret on every launch, only shared with the server
const serverKey = crypto.generateKeySync('hmac', {length: 1024}).export().toString('base64');
// Identity only (+user) for jasper-ssh, never carries roles
const sshToken = getToken('+user', serverKey);
// Admin token for the Jasper window. Only kept in memory here, and only sent by the auth hook.
const windowTokenLifetimeSeconds = 24 * 60 * 60;
let windowToken = { token: '', exp: 0 };
// Loaded from safeStorage once the app is ready
let dbPassword = '';
type ImageTags = {
  server: string[];
  client: string[];
  database: string[];
  ssh: string[];
};

let data: any = {};
try {
  data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch(e) {
  data = {
    locale: app.getLocale(),
    autoUpdate: true,
    serverVersion: 'v1.3',
    pullServer: true,
    serverProfiles: 'prod,jwt,storage,scripts,proxy,file-cache',
    serverRam: '1g',
    clientVersion: 'v1.3',
    pullClient: true,
    clientPort: '8082',
    clientTitle: 'Jasper',
    databaseVersion: '18',
    pullDatabase: true,
    dataDir: path.join(app.getPath('userData'), 'data'),
    storageDir: path.join(app.getPath('userData'), 'storage'),
    sshVersion: 'v1.1',
    pullSsh: true,
    sshPort: '8022',
    proxyPort: '',
    cfToken: '',
    ngrokUrl: '',
    ngrokToken: '',
    showLogsOnStart: false,
  };
}
// The server is no longer published, and the default role is always anonymous
delete data.serverPort;
delete data.serverDefaultRole;

const contextMenuTemplate = [
  {label: 'Show Window', click: () => createMainWindow(false)},
  {label: 'Show Logs', click: createLogsWindow},
  {label: 'Show Backups', click: () => shell.openPath(path.join(data.storageDir, 'default/backups'))},
  {label: 'Settings', click: createSettingsWindow},
  {label: 'Check for Updates', click: checkUpdates},
  {label: 'Quit', click: shutdown}
];

function writeData() {
  // Holds tunnel tokens and the (encrypted) database password
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getEntry() {
  return `http://localhost:${data.clientPort}`;
}

/** Client URL for requests from this process. The client is only published on 127.0.0.1. */
function getClientUrl(path: string) {
  return `http://127.0.0.1:${data.clientPort}${path}`;
}

/** Request config for this process. Never goes through an HTTP proxy. */
function clientRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    proxy: false as const,
    timeout: 5000,
  };
}

function notify(command: string) {
  return dc(command).once('close', () => {
    if (settings && !settings.isDestroyed()) {
      settings.webContents.send('finished', command);
    }
  });
}

const maxLogBuffer = 512 * 1024;
let logBuffer = '';
const logSubscribers = new WeakSet();
const livePtys = new Set<{ resize: (cols: number, rows: number) => void }>();
type PtySize = { cols: number, rows: number };
let ptySize: PtySize = { cols: 120, rows: 30 };
let winPtySize: PtySize | null = null;
function resizePtys(size: PtySize | null) {
  if (!size?.cols || !size?.rows) return;
  if (size.cols === ptySize.cols && size.rows === ptySize.rows) return;
  ptySize = { cols: size.cols, rows: size.rows };
  for (const pty of livePtys) {
    try {
      pty.resize(ptySize.cols, ptySize.rows);
    } catch (err) {
      console.log('Failed to resize pty: ' + err);
    }
  }
}
function dc(command: string) {
  // Spawn in a pseudo-TTY so docker compose emits ANSI colors and rewrites
  const emitter = new EventEmitter();
  const sendLogs = (data: string) => {
    process.stdout.write(data);
    logBuffer = (logBuffer + data).slice(-maxLogBuffer);
    // Only send live logs to subscribers; the buffer is replayed on subscribe
    if (win && !win.isDestroyed() && logSubscribers.has(win.webContents) && !firstLoad) {
      win.webContents.send('stream-logs', data);
    }
    if (logs && !logs.isDestroyed() && logSubscribers.has(logs.webContents)) {
      logs.webContents.send('stream-logs', data);
    }
  };
  try {
    const pty = ptySpawn('docker', [
      'compose',
      '-f', serverConfig,
      ...composeProfiles(command),
      command,
    ], {
      name: 'xterm-color',
      cols: ptySize.cols,
      rows: ptySize.rows,
      env: writeEnv(),
    });
    livePtys.add(pty);
    pty.onData(sendLogs);
    pty.onExit(({ exitCode, signal }) => {
      livePtys.delete(pty);
      emitter.emit('exit', exitCode, signal ?? null);
      emitter.emit('close', exitCode, signal ?? null);
    });
  } catch (err) {
    // Emit asynchronously so callers can attach 'error' listeners first
    setImmediate(() => emitter.emit('error', err));
  }
  return emitter;
}

function composeProfiles(command: string) {
  if (command === 'down') {
    // Stop everything, including tunnels that were disabled since they started
    return ['--profile', 'cf', '--profile', 'lan', '--profile', 'ngrok'];
  }
  return [
    ...data.cfToken ? ['--profile', 'cf'] : [],
    ...data.ngrokToken ? ['--profile', 'ngrok'] : [],
    ...data.proxyPort ? ['-f', lanConfig, '--profile', 'lan'] : [],
  ];
}

function getToken(userTag: string, secret: string) {
  return signToken({
    aud: '',
    sub: userTag,
  }, secret);
}

/**
 * Window token: +user with admin. No aud claim, since the server rejects any audience when the
 * client ID is blank. Re-minted once half of its lifetime has passed.
 */
function getWindowToken() {
  const now = Math.floor(Date.now() / 1000);
  if (windowToken.exp - now < windowTokenLifetimeSeconds / 2) {
    const exp = now + windowTokenLifetimeSeconds;
    windowToken = {
      exp,
      token: signToken({
        sub: '+user',
        auth: 'ROLE_ADMIN',
        iat: now,
        exp,
      }, serverKey),
    };
  }
  return windowToken.token;
}

function signToken(payload: object, secret: string) {
  const header = {
    alg: 'HS512',
    typ: 'JWT'
  };
  const body = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  const digest = hmac.update(body).digest('base64url');
  return body + '.' + digest;
}

/** Same endpoint jasper-ui uses to load the current user's roles */
const WHOAMI_PATH = '/api/v1/user/whoami';
/** Headers the page may never set on requests to the client */
const STRIPPED_HEADERS = ['authorization', 'user-role', 'x-jasper-key'];

/** Drop auth headers set by the page, and add the window token if given. */
function authHeaders(headers: Record<string, string>, token?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    if (STRIPPED_HEADERS.includes(name.toLowerCase())) continue;
    result[name] = headers[name];
  }
  if (token) result['Authorization'] = 'Bearer ' + token;
  return result;
}

/**
 * The window authenticates with a JWT signed with the per-launch HMAC key that only the server and
 * the Electron main process know. This hook is the only thing that adds it, so only the Electron
 * window is admin. Requests started by anything other than the Jasper UI or the browser itself
 * (no initiator, ex. window navigation), like an embedded third party iframe, are anonymous.
 * Registering again replaces the previous hook, so call again when the port changes.
 */
function registerAuthHook(port: string | number) {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const urls = [
    `http://localhost:${port}/*`,
    `http://127.0.0.1:${port}/*`,
    `ws://localhost:${port}/*`,
    `ws://127.0.0.1:${port}/*`,
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    let token: string | undefined;
    try {
      if (details.initiatorOrigin === undefined || origins.includes(details.initiatorOrigin)) token = getWindowToken();
    } catch {
      // Fail closed: send the request anonymously
    }
    callback({ requestHeaders: authHeaders(details.requestHeaders, token) });
  });
}

/**
 * Postgres 17 and older declare a volume at /var/lib/postgresql/data, which must be covered by a tmpfs.
 * Postgres 18 and newer must not have anything mounted there.
 */
function getDatabaseTmpfs(version: string) {
  const major = parseInt(version || '17');
  return major <= 17 ? '/var/lib/postgresql/data' : '/tmp';
}

/** Environment for docker compose only, secrets are never written to process.env */
function writeEnv(): { [key: string]: string } {
  const databaseVersion = data.databaseVersion ?? '';
  return {
    ...process.env as { [key: string]: string },
    // Disable the interactive "v View in Docker Desktop ..." menu
    COMPOSE_MENU: 'false',
    JASPER_LOCALE: data.locale ?? '',
    JASPER_SERVER_PROFILES: data.serverProfiles ?? '',
    JASPER_SERVER_VERSION: data.serverVersion ?? '',
    JASPER_SERVER_PULL: data.pullServer ? 'always' : 'missing',
    JASPER_SERVER_HEAP: data.serverRam ?? '',
    JASPER_SERVER_KEY: serverKey,
    JASPER_CLIENT_VERSION: data.clientVersion ?? '',
    JASPER_CLIENT_PULL: data.pullClient ? 'always' : 'missing',
    JASPER_CLIENT_PORT: data.clientPort ?? '',
    JASPER_CLIENT_TITLE: data.clientTitle ?? '',
    JASPER_PROXY_PORT: data.proxyPort ?? '',
    JASPER_DATABASE_VERSION: databaseVersion,
    JASPER_DATABASE_PULL: data.pullDatabase ? 'always' : 'missing',
    JASPER_DATABASE_PASSWORD: dbPassword,
    JASPER_DATABASE_TMPFS: getDatabaseTmpfs(databaseVersion),
    JASPER_DATA_DIR: data.dataDir ?? '',
    JASPER_STORAGE_DIR: data.storageDir ?? '',
    JASPER_SSH_VERSION: data.sshVersion ?? '',
    JASPER_SSH_PULL: data.pullSsh ? 'always' : 'missing',
    JASPER_SSH_PORT: data.sshPort ?? '',
    JASPER_SSH_TOKEN: sshToken,
    CLOUDFLARE_TOKEN: data.cfToken ?? '',
    NGROK_URL: data.ngrokUrl ?? '',
    NGROK_TOKEN: data.ngrokToken ?? '',
  };
}

/**
 * Random database password on first run, kept in safeStorage.
 * Existing installs keep the password their database was created with.
 * POSTGRES_PASSWORD is only used when the database is created, rotating it requires ALTER ROLE.
 */
function loadDatabasePassword() {
  const keyring = safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
  if (!keyring) log.warn('No OS keyring available, the database password in settings.json is not protected.');
  if (data.dbPasswordEnc) {
    return safeStorage.decryptString(Buffer.from(data.dbPasswordEnc, 'base64'));
  }
  const stored = data.dbPassword;
  // Existing databases were created with the old default password
  const password = stored || (hasData(data.dataDir) ? 'jasper' : crypto.randomBytes(32).toString('base64url'));
  if (safeStorage.isEncryptionAvailable()) {
    data.dbPasswordEnc = safeStorage.encryptString(password).toString('base64');
    delete data.dbPassword;
  } else if (stored) {
    return stored;
  } else {
    data.dbPassword = password;
  }
  writeData();
  if (!keyring) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'No Keyring',
      message: 'No OS keyring is available, so the database password is stored without encryption.',
      detail: 'Install and unlock a keyring such as GNOME Keyring or KWallet to protect it.\n\n' + settingsPath,
    });
  }
  return password;
}

/** Whether the directory has anything in it. If it can't be read, assume it does. */
function hasData(dir: string) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch (e: any) {
    return e?.code !== 'ENOENT';
  }
}

function startServer() {
  if (data.showLogsOnStart) {
    createLogsWindow();
  }
  return dc('up')
    .once('error', err => {
      dialog.showErrorBox('Docker Compose Missing',
        'This application requires Docker Compose to be installed.\n' +
        'Download it at https://www.docker.com/products/docker-desktop/\n\n' +
        err);
      app.quit();
    })
    .once('exit', (code, signal) => {
      if (code === 1) {
        dialog.showErrorBox('Docker Not Running',
          'This application requires Docker to be running.\n' +
          'Start Docker and try again.\n');
      } else if (code !== null) {
        console.log(`docker process exited with code ${code}`);
      } else if (signal !== null) {
        console.log(`docker process terminated by signal ${signal}`);
      }
    });
}

function shutdown() {
  writeData();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Shutting down...' },
    { label: 'Force Quit', click: forceQuit },
  ]));
  dc('down')
    .once('close', forceQuit);
  if (win) win.destroy();
  if (logs) logs.destroy();
  if (settings) settings.destroy();

}

let forceQuitting = false;
function forceQuit() {
  forceQuitting = true;
  app.quit();
}

function checkUpdates() {
  _imageTags = null;
  console.log('Jasper App Version: ', app.getVersion());
  console.log(`Auto Update ${data.autoUpdate ? 'on' : 'off'}.`);
  autoUpdater.logger = log;
  autoUpdater.autoDownload = data.autoUpdate;
  return autoUpdater.checkForUpdatesAndNotify({
    title: 'Jasper Update Available',
    body: 'Downloading latest Jasper update...'
  }).then(res => {
    if (!res) return;
    if (res.updateInfo.version <= app.getVersion()) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      ...contextMenuTemplate,
      {
        label: '🌟 Update to v' + res.updateInfo.version,
        click: () => {
          if (process.platform === 'darwin') {
            // Auto update will not work on mac until we get signing keys
            shell.openExternal('https://github.com/cjmalloy/jasper-app/releases/latest');
          } else {
            autoUpdater.downloadUpdate()
              .then(() => dc('down').once('close', () => autoUpdater.quitAndInstall()));
          }
        }
      },
    ]));
    return res.downloadPromise;
  });
}

function createWindow(config: any) {
  const size = screen.getPrimaryDisplay().workAreaSize;
  if (!config.bounds) config.bounds = {
    width: size.width * 0.8,
    height: size.height * 0.8,
  };
  const handle = new BrowserWindow({
    ...config.bounds,
    icon: path.join(__dirname, 'app.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      spellcheck: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  if (config.maximized) {
    handle.maximize();
  }
  handle.once('ready-to-show', () => {
    handle.show();
  });
  handle.on('resize', () => {
    if (handle.isDestroyed()) return;
    if (config.maximized) return;
    config.bounds = {
      ...config.bounds,
      ...handle.getBounds(),
    };
  });
  handle.on('move', () => {
    if (handle.isDestroyed()) return;
    if (config.maximized) return;
    config.bounds = {
      ...config.bounds,
      ...handle.getPosition(),
    };
  });
  handle.on('maximize', () => {
    if (handle.isDestroyed()) return;
    config.maximized = true;
  });
  handle.on('unmaximize', () => {
    if (handle.isDestroyed()) return;
    config.maximized = false;
  });
  handle.on('close', event => {
    if (!forceQuitting) {
      event.preventDefault()
      if (handle.isDestroyed()) return;
      handle.hide();
    }
  });
  return handle;
}

function createMainWindow(showLoading = false) {
  if (!showLoading && win && !win.isDestroyed()) {
    win.show();
    return Promise.resolve();
  }
  if (!win || win.isDestroyed()) {
    win = createWindow(data);
    win.webContents.setWindowOpenHandler(({url}) => {
      // Open any links in a browser
      // TODO: Not working for links in markdown
      shell.openExternal(url);
      return {action: 'deny'};
    });
  }
  if (showLoading && !win.webContents.getURL().endsWith('/loading.html')) {
    win.loadFile(path.join(__dirname, 'loading.html'));
  }
  return waitFor200(getClientUrl('/'), showLoading ? 5000 : 100)
    .then(() => {
      // Registering again replaces the previous hook, in case the port changed
      registerAuthHook(data.clientPort);
      return waitForServer();
    })
    .then(() => {
      firstLoad = true;
      if (win && !win.isDestroyed()) {
        win.loadURL(getEntry());
      }
    });
}

function createSettingsWindow() {
  if (!data.settings) data.settings = {
    bounds: {
      width: 540,
      height: 620,
    }
  };
  if (settings && !settings.isDestroyed()) {
    settings.show();
    data.appVersion = app.getVersion();
    settings.webContents.send('update-settings', data);
    getImageTags().then(data => {
      if (!settings.isDestroyed()) settings.webContents.send('image-tags', data);
    });
    return;
  }
  settings = createWindow(data.settings);
  settings.loadFile(path.join(__dirname, 'settings.html'));
  settings.once('ready-to-show', () => {
    data.appVersion = app.getVersion();
    settings.webContents.send('update-settings', data);
    getImageTags().then(data => {
      if (!settings.isDestroyed()) settings.webContents.send('image-tags', data);
    });
  });
}

let _imageTags: ImageTags | null = null;
async function getImageTags(): Promise<ImageTags> {
  if (_imageTags) return _imageTags;
  const versions: ImageTags = {
    server: [],
    client: [],
    database: ['11', '12', '13', '14', '15', '16', '17', '18'],
    ssh: [],
  };
  return ghDockerTags('cjmalloy/jasper')
    .then(tags => versions.server = tags.filter((t: string) => t.startsWith('v')))
    .then(() => ghDockerTags('cjmalloy/jasper-ui'))
    .then(tags => versions.client = tags.filter((t: string) => t.startsWith('v')))
    .then(() => ghDockerTags('cjmalloy/jasper-ssh'))
    .then(tags => versions.ssh = tags.filter((t: string) => t.startsWith('v')))
    .then(() => _imageTags = versions);
}

function ghDockerTags(repo: string): Promise<string[]> {
  return axios.get(`https://ghcr.io/token?scope=repository:${repo}:pull`, {})
    .catch(err => {
      console.log('Can\'t get fake login token: ' + repo);
      throw err
    })
    .then(res => dockerTags('https://ghcr.io', `/v2/${repo}/tags/list`, res.data.token));
}

function dockerTags(host: string, path: string, token: string, tags: string[] = [], page = 0): Promise<string[]> {
  return axios.get(host + path, {headers: {'Authorization': 'Bearer ' + token}})
    .catch(err => {
      console.log('Can\'t get tag list ' + path);
      throw err
    })
    .then(res => {
      tags.push(...res.data.tags)
      const next = (res.headers as AxiosHeaders).get('link', /<([^>]+)>; rel="next"/);
      if (next?.length) {
        return dockerTags(host, next[1], token, tags, page++);
      } else {
        return tags;
      }
    });
}

function createLogsWindow() {
  if (logs && !logs.isDestroyed()) {
    logs.show();
    return;
  }
  if (!data.logs) data.logs = {};
  logs = createWindow((data.logs));
  logs.loadFile(path.join(__dirname, 'logs.html'));
  logs.on('closed', () => resizePtys(winPtySize));
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'app.png'));
  if (process.platform === 'darwin') icon = icon.resize({width: 32});
  const tray = new Tray(icon);
  tray.setToolTip(data.clientTitle);
  tray.setContextMenu(Menu.buildFromTemplate(contextMenuTemplate));
  return tray;
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor200(url: string, firstDelay = 100): Promise<null> {
  return axios.get(url, clientRequest())
    .catch(() => ({status: 0}))
    .then(res => res.status === 200 ? null : wait(firstDelay).then(() => waitFor200(url, 100)));
}

/** Wait until the server answers through the client, and check that the window token is accepted */
async function waitForServer(): Promise<void> {
  // Same headers the auth hook sends for the Jasper window
  const roles = await axios.get(getClientUrl(WHOAMI_PATH), clientRequest(authHeaders({}, getWindowToken())))
    .then(res => res.status === 200 ? res.data : null, () => null);
  if (!roles) {
    await wait(100);
    return waitForServer();
  }
  if (roles.admin === true) {
    log.info('Jasper window is admin');
  } else {
    log.error('Jasper window token was not accepted, the window is not admin: ' + JSON.stringify(roles));
  }
}

function updateSettings(value: any) {
  data = {
    ...data,
    ...value,
  };
  writeData();
  firstLoad = false;
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, 'loading.html'));
    win.webContents.clearHistory();
    win.show();
  }
  dc('down').once('close', () => {
    startServer();
    createMainWindow(true);
    win.show();
  });
}

function patchSettings(name: string, value: any) {
  data[name] = value;
  writeData();
}

let firstLoad = false;
let tray: Tray;
let win: BrowserWindow;
let logs: BrowserWindow;
let settings: BrowserWindow;

app.on('ready', () => {
  ipcMain.on('fetch-settings', (_event) => settings.webContents.send('update-settings', data));
  ipcMain.on('settings-value', (_event, value) => updateSettings(value));
  ipcMain.on('settings-patch', (_event, patch) => patchSettings(patch.name, patch.value));
  ipcMain.on('command', (_event, value) => notify(value));
  ipcMain.on('open-dir', (_event, value) => shell.openPath(value));
  ipcMain.handle('save-as', async (event, buffer: ArrayBuffer, defaultFilename: string) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        new URL(event.senderFrame.url).origin !== new URL(getEntry()).origin) {
      throw new Error('File saving is only available from the Jasper window.');
    }
    if (!(buffer instanceof ArrayBuffer) || typeof defaultFilename !== 'string' ||
        !defaultFilename.trim() || defaultFilename.includes('\0')) {
      throw new Error('Expected an ArrayBuffer and a non-empty default filename.');
    }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(defaultFilename),
    });
    if (canceled || !filePath) return null;

    await fs.promises.writeFile(filePath, Buffer.from(buffer));
    try {
      const notification = new Notification({
        title: 'File saved',
        body: `${path.basename(filePath)} — Click to open`,
      });
      notification.on('click', () => {
        shell.openPath(filePath)
          .then(error => {
            if (error) dialog.showErrorBox('Unable to open file', error);
          })
          .catch(error => dialog.showErrorBox('Unable to open file', String(error)));
      });
      notification.on('failed', (_event, error) => log.warn('Save notification failed:', error));
      notification.show();
    } catch (error) {
      log.warn('Save notification failed:', error);
    }
    return filePath;
  });
  ipcMain.on('fetch-logs', event => {
    const wc = event.sender;
    if (!logSubscribers.has(wc)) {
      logSubscribers.add(wc);
      // Unsubscribe on reload; the new page must fetch again
      wc.on('did-start-loading', () => logSubscribers.delete(wc));
    }
    if (logBuffer) wc.send('stream-logs', logBuffer);
  });
  ipcMain.on('resize-pty', (event, size) => {
    if (!size?.cols || !size?.rows) return;
    const logsOpen = logs && !logs.isDestroyed();
    if (logsOpen && event.sender === logs.webContents) {
      resizePtys(size);
    } else {
      winPtySize = size;
      if (!logsOpen) resizePtys(size);
    }
  });
  tray = createTray();
  try {
    dbPassword = loadDatabasePassword();
  } catch (err) {
    dialog.showErrorBox('Database Password Unavailable',
      'Could not decrypt the database password with the OS keyring.\n' +
      'Unlock the keyring and try again.\n\n' +
      settingsPath + '\n\n' +
      err);
    forceQuit();
    return;
  }
  startServer();
  createMainWindow(true)
    .then(() => checkUpdates());
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('camera');
    systemPreferences.askForMediaAccess('microphone');
  }
});

app.on('activate', () => {
  createMainWindow();
});

app.on('before-quit', event => {
  if (!forceQuitting) {
    event.preventDefault();
    shutdown();
  }
});

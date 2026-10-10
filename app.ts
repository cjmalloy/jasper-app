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
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
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
    serverVersion: 'v1.4',
    pullServer: true,
    serverProfiles: 'prod,jwt,storage,scripts,proxy,file-cache',
    serverDefaultRole: 'ROLE_ANONYMOUS',
    serverRam: '1g',
    clientVersion: 'v1.4',
    pullClient: true,
    clientPort: '8082',
    clientTitle: 'Jasper',
    databaseVersion: '18',
    pullDatabase: true,
    dataDir: path.join(app.getPath('userData'), 'data'),
    storageDir: path.join(app.getPath('userData'), 'storage'),
    sshVersion: 'v1.3',
    pullSsh: true,
    sshPort: '8022',
    cfToken: '',
    ngrokUrl: '',
    ngrokToken: '',
    showLogsOnStart: false,
    logServices: ['web'],
  };
}

const contextMenuTemplate = [
  {label: 'Show Window', click: () => createMainWindow(false)},
  {label: 'Show Logs', click: createLogsWindow},
  {label: 'Show Backups', click: () => shell.openPath(path.join(data.storageDir, 'default/backups'))},
  {label: 'Settings', click: createSettingsWindow},
  {label: 'Check for Updates', click: checkUpdates},
  {label: 'Quit', click: shutdown}
];

function writeData() {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
}

function getEntry() {
  return `http://localhost:${data.clientPort}`;
}

function getServerHealthCheck() {
  return getEntry() + '/api/v1/user/whoami';
}

/**
 * Send the server key from the Jasper window only. Anything else, like a browser tab, is anonymous.
 * The filter omits the port so the hook still applies if the client port changes.
 */
function registerKeyHook() {
  const urls = ['http://localhost/*', 'http://127.0.0.1/*', 'ws://localhost/*', 'ws://127.0.0.1/*'];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    if (new URL(details.url).port !== String(data.clientPort)) return callback({});
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders)
      .filter(([name]) => name.toLowerCase() !== 'x-jasper-key'));
    if (key && win && !win.isDestroyed() && details.webContentsId === win.webContents.id) {
      requestHeaders['X-Jasper-Key'] = key;
    }
    callback({ requestHeaders });
  });
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
const logUnsubscribeHooked = new WeakSet();
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
function sendLogs(data: string) {
  process.stdout.write(data);
  logBuffer = (logBuffer + data).slice(-maxLogBuffer);
  // Only send live logs to subscribers; the buffer is replayed on subscribe
  if (win && !win.isDestroyed() && logSubscribers.has(win.webContents)) {
    win.webContents.send('stream-logs', data);
  }
  if (logs && !logs.isDestroyed() && logSubscribers.has(logs.webContents)) {
    logs.webContents.send('stream-logs', data);
  }
}

/**
 * All compose processes share one terminal. Progress output is redrawn by moving the
 * cursor up, so output from another process (like the attached `up` log stream) must
 * not be written in between frames. The newest running process owns the terminal and
 * the others are buffered until it exits. Ownership only changes at line boundaries.
 */
type LogStream = { id: number, buf: string, esc: string, done: boolean };
const logStreams: LogStream[] = [];
let logStreamId = 0;
let lastWriter: LogStream | null = null;
let midLine = false;
const ansiEscapes = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const partialEscape = /\x1b(?:\[[0-9;?]*|\][^\x07]*)?$/;
function emitLogs(stream: LogStream, chunk: string) {
  stream.buf = stream.buf.slice(chunk.length);
  lastWriter = stream;
  // Escape sequences may be split across chunks, so carry the incomplete tail over
  const plain = (stream.esc + chunk).replace(ansiEscapes, '');
  stream.esc = plain.match(partialEscape)?.[0] ?? '';
  const visible = plain.slice(0, plain.length - stream.esc.length);
  if (visible) midLine = !visible.endsWith('\n');
  sendLogs(chunk);
}
function pumpLogs() {
  while (true) {
    for (let i = logStreams.length - 1; i >= 0; i--) {
      if (logStreams[i].done && !logStreams[i].buf) logStreams.splice(i, 1);
    }
    if ((midLine || lastWriter?.esc) && lastWriter) {
      // Let the previous writer finish its line or escape sequence first
      const buf = lastWriter.buf;
      if (buf) {
        const i = buf.indexOf('\n');
        emitLogs(lastWriter, i < 0 ? buf : buf.slice(0, i + 1));
        continue;
      }
      if (!lastWriter.done) return;
      // Cancel the unfinished escape (CAN) and end the line before switching streams
      sendLogs((lastWriter.esc ? '\x18' : '') + (midLine ? '\r\n' : ''));
      midLine = false;
      lastWriter.esc = '';
    }
    const owner = logStreams[logStreams.length - 1];
    if (!owner?.buf) return;
    emitLogs(owner, owner.buf);
  }
}
function writeLogs(stream: LogStream, data: string) {
  // Late output after exit is reinserted in creation order, behind any newer stream
  if (!logStreams.includes(stream)) {
    const i = logStreams.findIndex(s => s.id > stream.id);
    logStreams.splice(i < 0 ? logStreams.length : i, 0, stream);
  }
  stream.buf = (stream.buf + data).slice(-maxLogBuffer);
  pumpLogs();
}

function dc(...command: string[]) {
  // Spawn in a pseudo-TTY so docker compose emits ANSI colors and rewrites
  const emitter = new EventEmitter();
  const stream: LogStream = { id: logStreamId++, buf: '', esc: '', done: false };
  try {
    const pty = ptySpawn('docker', [
      'compose',
      '-f', serverConfig,
      ...data.cfToken || command[0] === 'down' ? ['--profile', 'cf'] : [],
      ...data.ngrokToken || command[0] === 'down' ? ['--profile', 'ngrok'] : [],
      ...command,
    ], {
      name: 'xterm-color',
      cols: ptySize.cols,
      rows: ptySize.rows,
      env: getEnv(),
    });
    livePtys.add(pty);
    logStreams.push(stream);
    pty.onData(data => writeLogs(stream, data));
    pty.onExit(({ exitCode, signal }) => {
      livePtys.delete(pty);
      stream.done = true;
      pumpLogs();
      emitter.emit('exit', exitCode, signal ?? null);
      emitter.emit('close', exitCode, signal ?? null);
    });
  } catch (err) {
    // Emit asynchronously so callers can attach 'error' listeners first
    setImmediate(() => emitter.emit('error', err));
  }
  return emitter;
}

function getServices() {
  return [
    'web', 'db', 'client', 'ssh',
    ...data.cfToken ? ['cf', 'proxy'] : [],
    ...data.ngrokToken ? ['ngrok'] : [],
  ];
}

function sendLogServices() {
  if (!logs || logs.isDestroyed()) return;
  logs.webContents.send('log-services', {
    services: getServices(),
    enabled: Array.isArray(data.logServices) ? data.logServices : ['web'],
  });
}

let key = '';
function generateKey() {
  return crypto.generateKeySync('hmac', {length: 1024}).export().toString('base64');
}

function getEnv(): { [key: string]: string } {
  // Keep the key stable unless all services are restarting, so services
  // restarted individually still share the same key
  if (!key) key = generateKey();
  return {
    ...process.env as { [key: string]: string },
    // Disable the interactive "v View in Docker Desktop ..." menu
    COMPOSE_MENU: 'false',
    JASPER_LOCALE: data.locale ?? '',
    JASPER_SERVER_PROFILES: data.serverProfiles ?? '',
    JASPER_SERVER_DEFAULT_ROLE: data.serverDefaultRole || 'ROLE_ANONYMOUS',
    JASPER_PREFETCH: ['ROLE_VIEWER', 'ROLE_ANONYMOUS'].includes(data.serverDefaultRole || 'ROLE_ANONYMOUS') ? 'true' : 'false',
    JASPER_SERVER_VERSION: data.serverVersion ?? '',
    JASPER_SERVER_PULL: data.pullServer ? 'always' : 'missing',
    JASPER_SERVER_HEAP: data.serverRam ?? '',
    JASPER_SERVER_KEY: key,
    JASPER_CLIENT_VERSION: data.clientVersion ?? '',
    JASPER_CLIENT_PULL: data.pullClient ? 'always' : 'missing',
    JASPER_CLIENT_PORT: data.clientPort ?? '',
    JASPER_CLIENT_TITLE: data.clientTitle ?? '',
    JASPER_DATABASE_VERSION: data.databaseVersion ?? '',
    JASPER_DATABASE_PULL: data.pullDatabase ? 'always' : 'missing',
    JASPER_DATABASE_PASSWORD: data.dbPassword ?? '',
    JASPER_DATA_DIR: data.dataDir ?? '',
    JASPER_STORAGE_DIR: data.storageDir ?? '',
    JASPER_SSH_VERSION: data.sshVersion ?? '',
    JASPER_SSH_PULL: data.pullSsh ? 'always' : 'missing',
    JASPER_SSH_PORT: data.sshPort ?? '',
    CLOUDFLARE_TOKEN: data.cfToken ?? '',
    NGROK_URL: data.ngrokUrl ?? '',
    NGROK_TOKEN: data.ngrokToken ?? '',
  };
}

function startServer() {
  key = generateKey();
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

function isEntryUrl(url: string) {
  try {
    return new URL(url).origin === new URL(getEntry()).origin;
  } catch {
    return false;
  }
}

function isLoadingPage() {
  return !!win && !win.isDestroyed() && win.webContents.getURL().endsWith('/loading.html');
}

/**
 * Show the loading screen and start a new loading generation.
 * Only the most recent generation may replace the loading screen with the UI.
 */
function showLoadingScreen() {
  loadingGen++;
  if (win && !win.isDestroyed()) {
    if (!isLoadingPage()) {
      win.loadFile(path.join(__dirname, 'loading.html'));
      win.webContents.clearHistory();
    }
    win.show();
  }
  return loadingGen;
}

/**
 * Run docker compose commands one at a time so concurrent progress output
 * does not interleave in the logs.
 */
let composeQueue: Promise<void> = Promise.resolve();
function queueDc(...command: string[]): Promise<void> {
  const run = () => new Promise<void>((resolve, reject) => {
    dc(...command)
      .once('error', reject)
      .once('close', () => resolve());
  });
  const result = composeQueue.then(run);
  composeQueue = result.catch(() => {});
  return result;
}

function createMainWindow(showLoading = false, gen = loadingGen) {
  if (showLoading && gen !== loadingGen) return Promise.resolve();
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
  if (showLoading && !isLoadingPage()) {
    win.loadFile(path.join(__dirname, 'loading.html'));
  }
  // Stop polling once a newer update or settings change takes over the loading screen
  const current = () => gen === loadingGen;
  return waitFor200(getEntry(), showLoading ? 5000 : pollInterval, undefined, current)
    .then(() => waitFor200(getServerHealthCheck(), pollInterval, { 'X-Jasper-Key': key }, current))
    .then(() => {
      if (!current()) return;
      const url = resumeUrl && isEntryUrl(resumeUrl) ? resumeUrl : getEntry();
      resumeUrl = '';
      if (win && !win.isDestroyed()) {
        win.loadURL(url);
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

const pollInterval = 1000;
async function waitFor200(url: string, firstDelay = pollInterval, headers?: Record<string, string>, alive = () => true): Promise<null> {
  if (!alive()) return null;
  return axios.get(url, headers ? { headers, proxy: false } : {})
    .catch(() => ({status: 0}))
    .then(res => res.status === 200 || !alive() ? null : wait(firstDelay).then(() => waitFor200(url, pollInterval, headers, alive)));
}

function updateSettings(value: any) {
  data = {
    ...data,
    ...value,
  };
  writeData();
  sendLogServices();
  resumeUrl = '';
  // UI bundles have the same hashed names in every locale, so drop cached copies
  session.defaultSession.clearCache();
  const gen = showLoadingScreen();
  queueDc('down')
    .catch(err => console.log(`Failed to stop server: ${err}`))
    .then(() => {
      startServer();
      createMainWindow(true, gen);
      if (gen === loadingGen) win.show();
    });
}

const versionServices: Record<string, () => string[]> = {
  serverVersion: () => ['web'],
  clientVersion: () => data.cfToken ? ['client', 'proxy'] : ['client'],
  databaseVersion: () => ['db'],
  sshVersion: () => ['ssh'],
};

function updateVersion(name: string, value: any) {
  if (!Object.prototype.hasOwnProperty.call(versionServices, name) || typeof value !== 'string') return;
  const finished = () => {
    if (settings && !settings.isDestroyed()) {
      settings.webContents.send('finished', name);
    }
  };
  data[name] = value;
  writeData();
  const reloadUi = name !== 'sshVersion';
  let gen = loadingGen;
  if (reloadUi) {
    // Only the UI page is remembered, so back-to-back updates restore the first url
    if (win && !win.isDestroyed()) {
      const current = win.webContents.getURL();
      if (isEntryUrl(current)) resumeUrl = current;
    }
    gen = showLoadingScreen();
    if (settings && !settings.isDestroyed() && settings.isVisible()) settings.focus();
  }
  queueDc('up', '-d', '--no-deps', ...versionServices[name]())
    .then(() => {
      if (!reloadUi) return finished();
      createMainWindow(true, gen).then(finished, finished);
    }, err => {
      console.log(`Failed to update ${name}: ${err}`);
      finished();
    });
}

function patchSettings(name: string, value: any) {
  data[name] = value;
  writeData();
}

let loadingGen = 0;
let resumeUrl = '';
let tray: Tray;
let win: BrowserWindow;
let logs: BrowserWindow;
let settings: BrowserWindow;

app.on('ready', () => {
  registerKeyHook();
  ipcMain.on('fetch-settings', (_event) => settings.webContents.send('update-settings', data));
  ipcMain.on('settings-value', (_event, value) => updateSettings(value));
  ipcMain.on('update-version', (_event, name, value) => updateVersion(name, value));
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
    logSubscribers.add(wc);
    if (!logUnsubscribeHooked.has(wc)) {
      logUnsubscribeHooked.add(wc);
      // Unsubscribe on reload; the new page must fetch again
      wc.on('did-start-loading', () => logSubscribers.delete(wc));
    }
    if (logs && !logs.isDestroyed() && wc === logs.webContents) sendLogServices();
    if (logBuffer) wc.send('stream-logs', logBuffer);
  });
  ipcMain.on('set-log-services', (event, value) => {
    if (!logs || logs.isDestroyed() || event.sender !== logs.webContents) return;
    if (!Array.isArray(value) || !value.every(s => typeof s === 'string')) return;
    const services = getServices();
    data.logServices = [...new Set(value)].filter(s => services.includes(s));
    writeData();
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

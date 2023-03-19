import axios, { AxiosHeaders } from 'axios';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';

if (process.platform !== 'win32') {
  process.env.PATH = process.env.PATH + ':/usr/local/bin';
}

const serverConfig = path.join(__dirname, 'docker-compose.yaml');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

let data: any = {};
try {
  data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch(e) {
  data = {
    autoUpdate: true,
    serverVersion: 'v1.2',
    pullServer: true,
    serverPort: '8081',
    serverProfiles: 'prod,jwt,storage,feed-burst,repl-burst',
    clientVersion: 'v1.2',
    pullClient: true,
    clientPort: '8082',
    clientTitle: 'Jasper',
    databaseVersion: '14.5',
    pullDatabase: true,
    dataDir: path.join(app.getPath('userData'), 'data'),
    storageDir: path.join(app.getPath('userData'), 'storage'),
    showLogsOnStart: false,
  };
}

const contextMenuTemplate = [
  {label: 'Show Window', click: () => createMainWindow(false)},
  {label: 'Show Logs', click: createLogsWindow},
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
  return `http://localhost:${data.serverPort}/management/health/readiness`;
}

function notify(command: string) {
  return dc(command).once('close', () => {
    if (settings && !settings.isDestroyed()) {
      settings.webContents.send('finished', command);
    }
  });
}

function dc(command: string) {
  const dc = spawn('docker', ['compose', '-f', serverConfig, command]);
  dc.stdout.on('data', data => {
    console.log(`${data}`);
    if (win && !win.isDestroyed() && !firstLoad) {
      win.webContents.send('stream-logs', `${data}`);
    }
    if (logs && !logs.isDestroyed()) {
      logs.webContents.send('stream-logs', `${data}`);
    }
  });
  dc.stderr.on('data', data => {
    console.log(`${data}`);
    if (win && !win.isDestroyed() && !firstLoad) {
      win.webContents.send('stream-logs', `${data}`);
    }
    if (logs && !logs.isDestroyed()) {
      logs.webContents.send('stream-logs', `${data}`);
    }
  });
  return dc;
}

function getToken(secret) {
  const header = {
    alg: 'HS512',
    typ: 'JWT'
  };
  const payload = {
    aud: '',
    sub: '',
    auth: 'ROLE_ADMIN',
  };
  const body = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  const digest = hmac.update(body).digest();
  return body + '.' + digest.toString('base64url');
}

function writeEnv() {
  // DEBUG: Use with profile dev
  // let key = 'MjY0ZWY2ZTZhYmJhMTkyMmE5MTAxMTg3Zjc2ZDlmZWUwYjk0MDgzODA0MDJiOTgyNTk4MmNjYmQ4Yjg3MmVhYjk0MmE0OGFmNzE2YTQ5ZjliMTEyN2NlMWQ4MjA5OTczYjU2NzAxYTc4YThkMzYxNzdmOTk5MTIxODZhMTkwMDM=';
  let key = '';
  if (data.key) {
    if (safeStorage.isEncryptionAvailable()) {
      key = safeStorage.decryptString(Buffer.from(data.key, 'base64'));
    }
  } else {
    key = crypto.generateKeySync('hmac', {length: 512}).export().toString('base64');
    data.key = safeStorage.encryptString(key).toString('base64');
  }
  process.env.JASPER_PROFILES = data.serverProfiles ?? '';
  process.env.JASPER_SERVER_VERSION = data.serverVersion ?? '';
  process.env.JASPER_SERVER_PULL = data.pullServer ? 'always' : 'missing';
  process.env.JASPER_SERVER_PORT = data.serverPort;
  process.env.JASPER_SERVER_KEY = key;
  process.env.JASPER_CLIENT_VERSION = data.clientVersion ?? '';
  process.env.JASPER_CLIENT_PULL = data.pullClient ? 'always' : 'missing';
  process.env.JASPER_CLIENT_PORT = data.clientPort;
  process.env.JASPER_CLIENT_TITLE = data.clientTitle ?? '';
  process.env.JASPER_CLIENT_TOKEN = getToken(key) ?? '';
  process.env.JASPER_DATABASE_VERSION = data.databaseVersion ?? '';
  process.env.JASPER_DATABASE_PULL = data.pullDatabase ? 'always' : 'missing';
  process.env.JASPER_DATABASE_PASSWORD = data.dbPassword ?? '';
  process.env.JASPER_DATA_DIR = data.dataDir;
  process.env.JASPER_STORAGE_DIR = data.storageDir;
}

function startServer() {
  writeEnv();
  if (data.showLogsOnStart) {
    createLogsWindow();
  }
  return dc('up')
    .once('error', err => {
      dialog.showErrorBox('Docker Compose Missing',
        'This application requires docker compose to be installed.\n' +
        'Download it at https://www.docker.com/products/docker-desktop/\n\n' +
        err);
      app.quit();
    });
}

function shutdown() {
  writeData();
  if (win && !win.isDestroyed()) {
    win.close();
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: 'Shutting down...'},
    {label: 'Force Quit', click: app.quit},
  ]));
  dc('down')
    .once('close', app.quit);
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
            autoUpdater.downloadUpdate().then(() => autoUpdater.quitAndInstall())
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
  return handle;
}

function createMainWindow(showLoading = false) {
  if (win && !win.isDestroyed()) {
    win.show();
    return;
  }
  win = createWindow(data);
  win.webContents.setWindowOpenHandler(({url}) => {
    // Open any links in a browser
    shell.openExternal(url);
    return {action: 'deny'};
  });
  if (showLoading) {
    win.loadFile(path.join(__dirname, 'loading.html'));
  }
  return waitFor200(getEntry(), showLoading ? 5000 : 100)
    .then(() => waitForHealth(getServerHealthCheck()))
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
    getImageTags().then(data => settings.webContents.send('image-tags', data));
    return;
  }
  settings = createWindow(data.settings);
  settings.loadFile(path.join(__dirname, 'settings.html'));
  settings.once('ready-to-show', () => {
    data.appVersion = app.getVersion();
    settings.webContents.send('update-settings', data);
    getImageTags().then(data => settings.webContents.send('image-tags', data));
  });
}

let _imageTags;
async function getImageTags() {
  if (_imageTags) return _imageTags;
  const versions = {
    server: [],
    client: [],
    database: ['11', '12', '13', '14', '15'],
  };
  return ghDockerTags('cjmalloy/jasper')
    .then(tags => versions.server = tags.filter(t => t.startsWith('v')))
    .then(() => ghDockerTags('cjmalloy/jasper-ui'))
    .then(tags => versions.client = tags.filter(t => t.startsWith('v')))
    .then(() => _imageTags = versions);
}

function ghDockerTags(repo: string) {
  return axios.get(`https://ghcr.io/token?scope=repository:${repo}:pull`, {})
    .catch(err => {
      console.log('Can\'t get fake login token: ' + repo);
      throw err
    })
    .then(res => dockerTags('https://ghcr.io', `/v2/${repo}/tags/list`, res.data.token));
}

function dockerTags(host: string, path: string, token: string, tags = [], page = 0) {
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
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'app.png'));
  if (process.platform === 'darwin') icon = icon.resize({width: 32});
  const tray = new Tray(icon);
  tray.setToolTip(data.clientTitle);
  tray.setContextMenu(Menu.buildFromTemplate(contextMenuTemplate));
  return tray;
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor200(url, firstDelay = 100) {
  return axios.get(url)
    .catch(() => ({status: 0}))
    .then(res => res.status === 200 ? null : wait(firstDelay).then(() => waitFor200(url, 100)));
}

async function waitForHealth(url, firstDelay = 100) {
  return axios.get(url)
    .catch(() => ({data: {}}))
    .then(res => res.data.status === 'UP' ? null : wait(firstDelay).then(() => waitForHealth(url, 100)));
}

function updateSettings(value) {
  data = {
    ...data,
    ...value,
  };
  writeEnv();
  writeData();
  const openWin = win && !win.isDestroyed();
  if (openWin) win.hide();
  dc('down').once('close', () => {
    startServer();
    if (openWin) {
      win.once('closed', createMainWindow)
      win.close();
    }
  });
}

function patchSettings(name, value) {
  data[name] = value;
  writeEnv();
  writeData();
}

let firstLoad = false;
let tray: Tray;
let win: BrowserWindow;
let logs: BrowserWindow;
let settings: BrowserWindow;

app.on('ready', () => {
  ipcMain.on('settings-value', (_event, value) => updateSettings(value));
  ipcMain.on('settings-patch', (_event, patch) => patchSettings(patch.name, patch.value));
  ipcMain.on('command', (_event, value) => notify(value));
  ipcMain.on('open-dir', (_event, value) => shell.openPath(value));
  tray = createTray();
  startServer();
  createMainWindow(true)
    .then(() => checkUpdates());
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
});

app.on('activate', () => {
  if (win.isDestroyed()) {
    createMainWindow();
  }
});

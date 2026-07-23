import axios, { AxiosHeaders } from 'axios';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  Tray
} from 'electron';
import contextMenu from 'electron-context-menu';
import log from 'electron-log';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DockerCompose } from './docker-compose.js';
import { loadSettings, saveSettings, Settings, writeEnvironment } from './settings.js';
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

let data: Settings = loadSettings(settingsPath, app.getPath('userData'), app.getLocale());

const contextMenuTemplate = [
  {label: 'Show Window', click: () => createMainWindow(false)},
  {label: 'Show Logs', click: createLogsWindow},
  {label: 'Show Backups', click: () => shell.openPath(path.join(data.storageDir, 'default/backups'))},
  {label: 'Settings', click: createSettingsWindow},
  {label: 'Check for Updates', click: checkUpdates},
  {label: 'Quit', click: shutdown}
];

function writeData() {
  saveSettings(settingsPath, data);
}

function getEntry() {
  return `http://localhost:${data.clientPort}`;
}

function getServerHealthCheck() {
  return `http://localhost:${data.serverPort}/management/health/readiness`;
}

function notify(command: string) {
  return dockerCompose.run(command).once('close', () => {
    if (settings && !settings.isDestroyed()) {
      settings.webContents.send('finished', command);
    }
  });
}

const maxLogBuffer = 512 * 1024;
let logBuffer = '';
const logSubscribers = new WeakSet();
let winPtySize = null;
const dockerCompose = new DockerCompose(serverConfig, () => data, output => {
  process.stdout.write(output);
  logBuffer = (logBuffer + output).slice(-maxLogBuffer);
  if (win && !win.isDestroyed() && logSubscribers.has(win.webContents) && !firstLoad) {
    win.webContents.send('stream-logs', output);
  }
  if (logs && !logs.isDestroyed() && logSubscribers.has(logs.webContents)) {
    logs.webContents.send('stream-logs', output);
  }
});

function startServer() {
  writeEnvironment(data);
  if (data.showLogsOnStart) {
    createLogsWindow();
  }
  return dockerCompose.run('up')
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
  dockerCompose.run('down')
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
              .then(() => dockerCompose.run('down').once('close', () => autoUpdater.quitAndInstall()));
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
    return;
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

let _imageTags;
async function getImageTags() {
  if (_imageTags) return _imageTags;
  const versions = {
    server: [],
    client: [],
    database: ['11', '12', '13', '14', '15', '16', '17', '18'],
    ssh: [],
  };
  return ghDockerTags('cjmalloy/jasper')
    .then(tags => versions.server = tags.filter(t => t.startsWith('v')))
    .then(() => ghDockerTags('cjmalloy/jasper-ui'))
    .then(tags => versions.client = tags.filter(t => t.startsWith('v')))
    .then(() => ghDockerTags('cjmalloy/jasper-ssh'))
    .then(tags => versions.ssh = tags.filter(t => t.startsWith('v')))
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
  logs.on('closed', () => dockerCompose.resize(winPtySize));
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
  writeEnvironment(data);
  writeData();
  firstLoad = false;
  if (win && !win.isDestroyed()) {
    win.loadFile(path.join(__dirname, 'loading.html'));
    win.webContents.clearHistory();
    win.show();
  }
  dockerCompose.run('down').once('close', () => {
    startServer();
    createMainWindow(true);
    win.show();
  });
}

function patchSettings(name, value) {
  data[name] = value;
  writeEnvironment(data);
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
      dockerCompose.resize(size);
    } else {
      winPtySize = size;
      if (!logsOpen) dockerCompose.resize(size);
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

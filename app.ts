import { spawn } from 'child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';

if (process.platform !== 'win32') {
  process.env.PATH = process.env.PATH + ':/usr/local/bin';
}

const serverConfig = path.join(__dirname, 'docker-compose.yaml');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

let data: any = {};
try {
  data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}
catch(e) {
  data = {
    serverVersion: 'latest',
    serverPort: '8081',
    serverProfiles: 'prod,admin,storage,feed-burst,repl-burst',
    clientVersion: 'latest',
    clientPort: '8082',
    clientTitle: 'Jasper',
    dataDir: path.join(app.getPath('userData'), 'data'),
    storageDir: path.join(app.getPath('userData'), 'storage'),
  };
}

function writeData() {
  fs.writeFileSync(settingsPath, JSON.stringify(data));
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

function writeEnv() {
  process.env.JASPER_PROFILES = data.serverProfiles ?? '';
  process.env.JASPER_SERVER_VERSION = data.serverVersion ?? '';
  process.env.JASPER_SERVER_PORT = data.serverPort;
  process.env.JASPER_CLIENT_VERSION = data.clientVersion ?? '';
  process.env.JASPER_CLIENT_PORT = data.clientPort;
  process.env.JASPER_CLIENT_TITLE = data.clientTitle ?? '';
  process.env.JASPER_DATABASE_PASSWORD = data.dbPassword ?? '';
  process.env.JASPER_DATA_DIR = data.dataDir;
  process.env.JASPER_STORAGE_DIR = data.storageDir;
}

function startServer() {
  writeEnv();

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
      { label: 'Shutting down...' },
      { label: 'Force Quit', click: app.quit },
  ]));
  dc('down')
      .once('close', app.quit);
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Open any links with target="_blank" in a browser
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (showLoading) {
    win.loadFile(path.join(__dirname, 'loading.html'));
  }
  waitFor200(getEntry(), () => {
    waitFor200(getServerHealthCheck(), () => {
      firstLoad = true;
      win.loadURL(getEntry());
    });
  }, showLoading ? 5000 : 100);
}

function createSettingsWindow() {
  if (settings && !settings.isDestroyed()) {
    settings.show();
    return;
  }

  if (!data.settings) data.settings = {
    bounds: {
      width: 540,
      height: 620,
    }
  };
  settings = createWindow(data.settings);
  settings.loadFile(path.join(__dirname, 'settings.html'));
  settings.once('ready-to-show', () => {
    settings.webContents.send('update-settings', data);
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
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => createMainWindow(false) },
    { label: 'Show Logs', click: createLogsWindow },
    { label: 'Settings', click: createSettingsWindow },
    { label: 'Quit', click: shutdown },
  ]);
  tray.setToolTip('Jasper');
  tray.setContextMenu(contextMenu);
  return tray;
}

function waitFor200(url, cb, firstDelay = 100) {
  request(getEntry(), (error, response, body) => {
    if (!error && response.statusCode == 200) {
      cb();
    } else {
      setTimeout(() => waitFor200(url, cb), firstDelay);
    }
  });
}

function updateSettings(value) {
  data = {
    ...data,
    ...value,
  };
  writeEnv();
  writeData();
  dc('down').once('close', () => {
    startServer();
    if (win && !win.isDestroyed()) {
      win.once('closed', createMainWindow)
      win.close();
    }
  });
}

let firstLoad = false;
let tray: Tray;
let win: BrowserWindow;
let logs: BrowserWindow;
let settings: BrowserWindow;

app.on('ready', () => {
  ipcMain.on('settings-value', (_event, value) => updateSettings(value));
  ipcMain.on('command', (_event, value) => notify(value));
  tray = createTray();
  startServer();
  createMainWindow(true);
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

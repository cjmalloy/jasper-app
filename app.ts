import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { app, BrowserWindow, dialog, Menu, screen, Tray, ipcMain, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';

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
  return 'http://localhost:' + data.clientPort;
}

function dc(command: string) {
  const dc = spawn('docker', ['compose', '-f', serverConfig, command], {shell: true});
  dc.stdout.on('data', data => {
    console.log(`${data}`);
  });
  dc.stderr.on('data', data => {
    console.log(`${data}`);
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
  if (win) {
    win.close()
    win = null;
  }
  tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Shutting down...' },
      { label: 'Force Quit', click: app.quit },
  ]));
  dc('down')
      .once('close', app.quit);
}

function createWindow(showLoading = false) {
  if (win) {
    win.show();
    return;
  }

  const size = screen.getPrimaryDisplay().workAreaSize;
  if (!data.bounds) data.bounds = {
    width: size.width * 0.8,
    height: size.height * 0.8,
  };

  // Create the browser window.
  win = new BrowserWindow({
    ...data.bounds,
    autoHideMenuBar: true,
    show: false,
  });

  if (data.maximized) {
    win.maximize();
  }

  if (showLoading) {
    win.loadFile(path.join(__dirname, 'loading.html'));
  }
  waitForClient(() => {
    win.loadURL(getEntry());
  }, showLoading ? 5000 : 100);

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('resize', () => {
    if (!win) return;
    if (data.maximized) return;
    data.bounds = {
      ...data.bounds,
      ...win.getBounds(),
    };
  });

  win.on('move', () => {
    if (!win) return;
    if (data.maximized) return;
    data.bounds = {
      ...data.bounds,
      ...win.getPosition(),
    };
  });

  win.on('maximize', () => {
    if (!win) return;
    data.maximized = true;
  });

  win.on('unmaximize', () => {
    if (!win) return;
    data.maximized = false;
  });

  win.on('closed', () => {
    if (!win) return;
    win = null;
  });
}

function createSettingsWindow() {
  if (settings) {
    settings.show();
    return;
  }

  const size = screen.getPrimaryDisplay().workAreaSize;
  if (!data.settings) data.settings = {};
  if (!data.settings.bounds) data.settings.bounds = {
    width: Math.min(size.width, 600),
    height: Math.min(size.width, 600),
  };

  // Create the browser window.
  settings = new BrowserWindow({
    ...data.settings.bounds,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  settings.loadFile(path.join(__dirname, 'settings.html'));

  settings.once('ready-to-show', () => {
    if (!settings) return;
    settings.show();
    settings.webContents.send('update-settings', data);
  });

  settings.on('resize', () => {
    if (!settings) return;
    if (data.maximized) return;
    data.settings.bounds = {
      ...data.settings.bounds,
      ...settings.getBounds(),
    };
  });

  settings.on('move', () => {
    if (!settings) return;
    if (data.settings.maximized) return;
    data.settings.bounds = {
      ...data.settings.bounds,
      ...settings.getPosition(),
    };
  });

  settings.on('maximize', () => {
    if (!settings) return;
    data.settings.maximized = true;
  });

  settings.on('unmaximize', () => {
    if (!settings) return;
    data.settings.maximized = false;
  });

  settings.on('closed', () => {
    if (!settings) return;
    settings = null;
  });
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'app.png'));
  if (process.platform === 'darwin') icon = icon.resize({width: 32});
  const tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: () => createWindow(false) },
    { label: 'Settings', click: createSettingsWindow },
    { label: 'Quit', click: shutdown },
  ]);
  tray.setToolTip('Jasper');
  tray.setContextMenu(contextMenu);
  return tray;
}

function waitForClient(cb, firstDelay = 100) {
  request(getEntry(), (error, response, body) => {
    if (!error && response.statusCode == 200) {
      cb();
    } else {
      setTimeout(() => waitForClient(cb), firstDelay);
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
    server = startServer();
    if (win) {
      win.once('closed', createWindow)
      win.close();
    }
  });
}

let tray: Tray;
let win: BrowserWindow | null;
let settings: BrowserWindow | null;
let server: ChildProcessWithoutNullStreams;

app.on('ready', () => {
  ipcMain.on('settings-value', (_event, value) => updateSettings(value));
  ipcMain.on('restart', () => dc('restart'));
  ipcMain.on('update', () => dc('pull'));
  tray = createTray();
  server = startServer();
  createWindow(true);
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
});

app.on('activate', () => {
  if (win === null) {
    createWindow();
  }
});

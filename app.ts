import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { app, BrowserWindow, dialog, Menu, screen, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'request';

const serverConfig = path.join(__dirname, 'docker-compose.yaml');
const initPath = path.join(app.getPath('userData'), 'init.json');

let data: any = {};
try {
  data = JSON.parse(fs.readFileSync(initPath, 'utf8'));
}
catch(e) { }
function writeData() {
  fs.writeFileSync(initPath, JSON.stringify(data));
}

function getEntry() {
  return 'http://localhost:' + (data.clientPort ?? '8082');
}

function startServer() {
  process.env.JASPER_PROFILES = data.profiles ?? '';
  process.env.JASPER_SERVER_VERSION = data.serverVersion ?? '';
  process.env.JASPER_SERVER_PORT = data.serverPort ?? '8081';
  process.env.JASPER_CLIENT_VERSION = data.clientVersion ?? '';
  process.env.JASPER_CLIENT_PORT = data.clientPort ?? '8082';
  process.env.JASPER_DATABASE_PASSWORD = data.dbPassword ?? '';
  process.env.JASPER_DATA_DIR = data.dataDir ?? path.join(app.getPath('userData'), 'data');

  const server = spawn('docker', ['compose', '-f', serverConfig, 'up']);
  server.once('error', err => {
    dialog.showErrorBox('Docker Compose Missing',
        'This application requires docker compose to be installed.\n' +
        'Download it at https://www.docker.com/products/docker-desktop/\n\n' +
        ''+err);
    app.quit();
  });
  server.stdout.on('data', data => {
    console.log(`${data}`);
  });
  server.stderr.on('data', data => {
    console.log(`${data}`);
  });

  return server;
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
  const server = spawn('docker', ['compose', '-f', serverConfig, 'down']);
  server.once('close', app.quit);
}

function createWindow() {
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
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  if (data.maximized) {
    win.maximize();
  }

  win.loadURL(getEntry());

  win.once('ready-to-show', () => {
    win.show()
  })

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
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  settings.loadFile(path.join(__dirname, 'index.html'));

  settings.once('ready-to-show', () => {
    settings.show()
  })

  win.on('resize', () => {
    if (!win) return;
    if (data.maximized) return;
    data.settings.bounds = {
      ...data.settings.bounds,
      ...win.getBounds(),
    };
  });

  settings.on('move', () => {
    if (!settings) return;
    if (data.settings.maximized) return;
    data.settings.bounds = {
      ...data.settings.bounds,
      ...win.getPosition(),
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
  const tray = new Tray(path.join(__dirname, 'app.png'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Window', click: createWindow },
    { label: 'Settings', click: createSettingsWindow },
    { label: 'Quit', click: shutdown },
  ]);
  tray.setTitle('Jasper');
  tray.setToolTip('Jasper');
  tray.setContextMenu(contextMenu);
  return tray;
}

function waitForClient(cb) {
  request(getEntry(), (error, response, body) => {
    if (!error && response.statusCode == 200) {
      cb();
    }
    else {
      setTimeout(() => waitForClient(cb), 100);
    }
  });
}

let tray: Tray;
let win: BrowserWindow | null;
let settings: BrowserWindow | null;
let server: ChildProcessWithoutNullStreams;

app.on('ready', () => {
  tray = createTray();
  server = startServer();
  waitForClient(() => createWindow());
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

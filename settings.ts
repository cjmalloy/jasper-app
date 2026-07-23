import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type Settings = Record<string, any>;

export function loadSettings(settingsPath: string, userDataPath: string, locale: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {
      locale,
      autoUpdate: true,
      serverVersion: 'v1.3',
      pullServer: true,
      serverPort: '8081',
      serverProfiles: 'prod,jwt,storage,scripts,proxy,file-cache',
      serverDefaultRole: 'ROLE_ADMIN',
      serverRam: '1g',
      clientVersion: 'v1.3',
      pullClient: true,
      clientPort: '8082',
      clientTitle: 'Jasper',
      databaseVersion: '18',
      pullDatabase: true,
      dataDir: path.join(userDataPath, 'data'),
      storageDir: path.join(userDataPath, 'storage'),
      sshVersion: 'v1.1',
      pullSsh: true,
      sshPort: '8022',
      cfToken: '',
      ngrokUrl: '',
      ngrokToken: '',
      showLogsOnStart: false,
    };
  }
}

export function saveSettings(settingsPath: string, settings: Settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function getToken(userTag: string, secret: string) {
  const header = {
    alg: 'HS512',
    typ: 'JWT'
  };
  const payload = {
    aud: '',
    sub: userTag,
    auth: 'ROLE_ADMIN',
  };
  const body = Buffer.from(JSON.stringify(header)).toString('base64url') + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha512', Buffer.from(secret, 'base64'));
  const digest = hmac.update(body).digest('base64url');
  return body + '.' + digest;
}

export function writeEnvironment(settings: Settings) {
  const key = crypto.generateKeySync('hmac', {length: 1024}).export().toString('base64');
  process.env.JASPER_LOCALE = settings.locale ?? '';
  process.env.JASPER_SERVER_PROFILES = settings.serverProfiles ?? '';
  process.env.JASPER_SERVER_DEFAULT_ROLE = settings.serverDefaultRole || 'ROLE_ANONYMOUS';
  process.env.JASPER_PREFETCH = ['ROLE_VIEWER', 'ROLE_ANONYMOUS'].includes(settings.serverDefaultRole || 'ROLE_ANONYMOUS') ? 'true' : 'false';
  process.env.JASPER_SERVER_VERSION = settings.serverVersion ?? '';
  process.env.JASPER_SERVER_PULL = settings.pullServer ? 'always' : 'missing';
  process.env.JASPER_SERVER_PORT = settings.serverPort;
  process.env.JASPER_SERVER_HEAP = settings.serverRam ?? '';
  process.env.JASPER_SERVER_KEY = key;
  process.env.JASPER_CLIENT_VERSION = settings.clientVersion ?? '';
  process.env.JASPER_CLIENT_PULL = settings.pullClient ? 'always' : 'missing';
  process.env.JASPER_CLIENT_PORT = settings.clientPort;
  process.env.JASPER_CLIENT_TITLE = settings.clientTitle ?? '';
  process.env.JASPER_CLIENT_TOKEN = getToken('+user', key) ?? '';
  process.env.JASPER_DATABASE_VERSION = settings.databaseVersion ?? '';
  process.env.JASPER_DATABASE_PULL = settings.pullDatabase ? 'always' : 'missing';
  process.env.JASPER_DATABASE_PASSWORD = settings.dbPassword ?? '';
  process.env.JASPER_DATA_DIR = settings.dataDir;
  process.env.JASPER_STORAGE_DIR = settings.storageDir;
  process.env.JASPER_SSH_VERSION = settings.sshVersion ?? '';
  process.env.JASPER_SSH_PULL = settings.pullSsh ? 'always' : 'missing';
  process.env.JASPER_SSH_PORT = settings.sshPort;
  process.env.JASPER_SSH_TOKEN = getToken('+user', key) ?? '';
  process.env.CLOUDFLARE_TOKEN = settings.cfToken;
  process.env.NGROK_URL = settings.ngrokUrl;
  process.env.NGROK_TOKEN = settings.ngrokToken;
}

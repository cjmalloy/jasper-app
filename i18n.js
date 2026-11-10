// Renderer translations, keyed by the English text in the page
const translations = {
  ja: {
    'Jasper Settings': 'Jasper 設定',
    'Jasper Logs': 'Jasper ログ',
    'Jasper Application Settings': 'Jasper アプリケーション設定',
    'Language': '言語',
    'App Version': 'アプリのバージョン',
    'Check for updates on startup': '起動時に更新を確認する',
    'Server Version': 'サーバーのバージョン',
    'Restart this service with the new version': '新しいバージョンでこのサービスを再起動する',
    'Update': '更新',
    'Server Profiles': 'サーバープロファイル',
    'Server Scripts': 'サーバースクリプト',
    'Proxy': 'プロキシ',
    'File Cache': 'ファイルキャッシュ',
    'Recycler': 'リサイクラー',
    'Preload': 'プリロード',
    'Debug': 'デバッグ',
    'Archive': 'アーカイブ',
    'Database is an append-only log. Cannot be disabled once enabled.': 'データベースは追記専用のログになります。一度有効にすると無効にできません。',
    'Default Role': 'デフォルトのロール',
    'admin': '管理者',
    'mod': 'モデレーター',
    'editor': '編集者',
    'user': 'ユーザー',
    'viewer': '閲覧者',
    'anon': '匿名',
    'Server RAM': 'サーバーのメモリ',
    'Server Storage': 'サーバーのストレージ',
    'Open folder': 'フォルダーを開く',
    'UI Version': 'UI のバージョン',
    'UI Title': 'UI のタイトル',
    'UI Port': 'UI のポート',
    'Postgres Version': 'Postgres のバージョン',
    'Postgres Directory': 'Postgres のディレクトリ',
    'SSH Version': 'SSH のバージョン',
    'SSH Port': 'SSH のポート',
    'Cloudflare Token': 'Cloudflare トークン',
    'Ngrok URL': 'Ngrok URL',
    'Ngrok Token': 'Ngrok トークン',
    'Show Logs on Startup': '起動時にログを表示する',
    'Save & Hard Reload': '保存して完全に再読み込み',
    'Troubleshooting': 'トラブルシューティング',
    'Restart': '再起動',
    'Restart the servers and database': 'サーバーとデータベースを再起動する',
    'Pull New Images': '新しいイメージを取得',
    'Check for updates and download them if available': '更新を確認し、あればダウンロードする',
    'Stop': '停止',
    'Stop all servers and database': 'すべてのサーバーとデータベースを停止する',
    'Start': '開始',
    'Start all servers and database if not already started': 'まだ起動していなければ、すべてのサーバーとデータベースを起動する',
    'Pause': '一時停止',
    'Pause all servers and database': 'すべてのサーバーとデータベースを一時停止する',
    'Unpause': '再開',
    'Unpause all servers and database': 'すべてのサーバーとデータベースを再開する',
    'Enabling the Archive profile turns the database into an append-only log.\n\nOnce enabled and saved it cannot be disabled.\n\nAre you sure you want to enable it?':
      'アーカイブプロファイルを有効にすると、データベースは追記専用のログになります。\n\n一度有効にして保存すると、無効にできません。\n\n本当に有効にしますか？',
  },
};

let currentLocale = 'en';

function supportedLocale(locale) {
  return String(locale ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

function t(text) {
  return translations[currentLocale]?.[text] ?? text;
}

/**
 * Translate every element marked with data-i18n (text) or data-i18n-title (tooltip).
 * The English text is kept in the attribute so the page can switch back and forth.
 */
function applyLocale(locale) {
  currentLocale = supportedLocale(locale);
  document.documentElement.lang = currentLocale;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18n) el.dataset.i18n = el.textContent;
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-title]')) {
    if (!el.dataset.i18nTitle) el.dataset.i18nTitle = el.title;
    el.title = t(el.dataset.i18nTitle);
  }
}

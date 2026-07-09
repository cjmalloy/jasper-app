// Copies the frontend files into dist/ for Tauri's frontendDist.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

const files = [
  'loading.html',
  'logs.html',
  'settings.html',
  'tauri-shim.js',
  'jasper-dark.png',
  'app.png',
  'node_modules/jquery/dist/jquery.min.js',
];

fs.rmSync(dist, { recursive: true, force: true });
for (const file of files) {
  const dest = path.join(dist, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, file), dest);
}
console.log(`Copied ${files.length} files to dist/`);

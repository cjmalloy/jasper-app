// Downloads the podman and docker-compose binaries bundled with the app so
// that Docker Desktop is not required on macOS and Windows.
//
// Used as an electron-builder beforePack hook, or run directly to fetch the
// binaries for the current platform: `node scripts/fetch-podman.mjs [platform] [arch]`
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yauzl from 'yauzl';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const composeVersion = 'v5.5.1';
const compose = (asset, sha256) => ({
  url: `https://github.com/docker/compose/releases/download/${composeVersion}/${asset}`,
  sha256,
});
const podman = (version, asset, sha256) => ({
  version,
  url: `https://github.com/podman-container-tools/podman/releases/download/${version}/${asset}`,
  sha256,
});

// Podman v6 no longer ships Intel mac builds, so stay on v5 there
const targets = {
  'mac-arm64': {
    podman: podman('v6.1.3', 'podman-installer-macos-arm64.pkg', '84400d0539b5df0b2f00e9165463d4c17de51933244d1ea4b9cc54d8f05e4de9'),
    compose: compose('docker-compose-darwin-aarch64', '998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5'),
  },
  'mac-x64': {
    podman: podman('v5.8.7', 'podman-installer-macos-amd64.pkg', 'a05640de459ce1a7ecb8ece4af107f64523e5fa9ecda78f01df11d606394b1e2'),
    compose: compose('docker-compose-darwin-x86_64', 'a264d61e824bf08a78867e59cdf32eb09f0aee9ecdf9f6ebfa43f76dc52880f1'),
  },
  'win-x64': {
    podman: podman('v6.1.3', 'podman-remote-release-windows_amd64.zip', 'bb98562f5faf0df3f28bab7fb517ea9e2d807817978bfa9f68982b75e6e59c40'),
    compose: compose('docker-compose-windows-x86_64.exe', 'a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f'),
  },
  'win-arm64': {
    podman: podman('v6.1.3', 'podman-remote-release-windows_arm64.zip', '77ca4314d1b5bc20f9fbb386bc22abef1634253b56bc6cc40558a3002596a8f3'),
    compose: compose('docker-compose-windows-aarch64.exe', '4bbb5d1ecc75bde1a9ca4afac43f5907c0d3bd0f88c7f00bf481ee7c8c1737be'),
  },
};

// Helper binaries podman machine needs next to podman
const macBinaries = ['podman', 'gvproxy', 'vfkit'];
const winBinaries = ['podman.exe', 'gvproxy.exe', 'win-sshproxy.exe'];

const platforms = { darwin: 'mac', mac: 'mac', win32: 'win', win: 'win', linux: 'linux' };
const archs = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

async function download(url, sha256, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== sha256) throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${digest}`);
  fs.writeFileSync(dest, buffer);
}

function unzipEntries(zipFile, names, outDir) {
  return new Promise((resolve, reject) => {
    const remaining = new Set(names);
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('end', () => remaining.size
        ? reject(new Error(`Missing ${[...remaining].join(', ')} in ${zipFile}`))
        : resolve());
      zip.on('entry', entry => {
        const name = path.posix.basename(entry.fileName);
        if (!/\/usr\/bin\/[^/]+$/.test(entry.fileName) || !remaining.has(name)) return zip.readEntry();
        remaining.delete(name);
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const out = fs.createWriteStream(path.join(outDir, name), { mode: 0o755 });
          out.on('error', reject);
          out.on('finish', () => zip.readEntry());
          stream.on('error', reject);
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

function findDir(dir, test) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (test(full)) return full;
    const found = findDir(full, test);
    if (found) return found;
  }
  return null;
}

function extractPkg(pkgFile, names, outDir, tmp) {
  const expanded = path.join(tmp, 'pkg');
  execFileSync('pkgutil', ['--expand-full', pkgFile, expanded], { stdio: 'inherit' });
  const bin = findDir(expanded, dir => path.basename(dir) === 'bin' && fs.existsSync(path.join(dir, 'podman')));
  if (!bin) throw new Error(`Could not find podman in ${pkgFile}`);
  for (const name of names) {
    // Copy without altering the signatures, vfkit needs its virtualization entitlement
    execFileSync('cp', ['-p', path.join(bin, name), path.join(outDir, name)]);
  }
}

export async function fetchPodman(platform = process.platform, arch = process.arch) {
  const target = `${platforms[platform] ?? platform}-${arch}`;
  const outDir = path.join(root, 'bin', target);
  fs.mkdirSync(outDir, { recursive: true });
  const config = targets[target];
  if (!config) {
    console.log(`Not bundling podman for ${target}`);
    return outDir;
  }
  const stamp = path.join(outDir, '.version');
  const version = `${config.podman.url}\n${config.compose.url}\n`;
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === version) {
    console.log(`Podman already downloaded for ${target}`);
    return outDir;
  }
  if (target.startsWith('mac') && process.platform !== 'darwin') {
    throw new Error('Building for macOS requires a macOS host to extract the podman installer');
  }
  for (const f of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jasper-podman-'));
  try {
    const archive = path.join(tmp, path.posix.basename(config.podman.url));
    await download(config.podman.url, config.podman.sha256, archive);
    if (target.startsWith('mac')) {
      extractPkg(archive, macBinaries, outDir, tmp);
    } else {
      await unzipEntries(archive, winBinaries, outDir);
    }
    const composeFile = path.join(outDir, target.startsWith('win') ? 'docker-compose.exe' : 'docker-compose');
    await download(config.compose.url, config.compose.sha256, composeFile);
    fs.chmodSync(composeFile, 0o755);
    fs.writeFileSync(stamp, version);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Bundled podman ${config.podman.version} for ${target}`);
  return outDir;
}

// electron-builder beforePack hook
export default async function beforePack(context) {
  await fetchPodman(context.electronPlatformName, archs[context.arch] ?? context.arch);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchPodman(process.argv[2], process.argv[3]).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

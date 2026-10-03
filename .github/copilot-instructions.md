# Copilot Instructions for jasper-app

Electron desktop wrapper for [Jasper KM](https://github.com/cjmalloy/jasper). The app runs
`docker compose` (via a pseudo-TTY from `@lydell/node-pty`) against the bundled
`docker-compose.yaml` to start the Jasper server (`web`), Postgres (`db`), the UI (`client`),
and `ssh`. It then opens the UI at `http://localhost:<clientPort>` once the server health check
reports `UP`.

## Layout

| File | Purpose |
| --- | --- |
| `app.ts` | Electron main process: settings, tray, windows, docker compose lifecycle, IPC handlers, auto-update. Compiled to `app.js` (git-ignored). |
| `preload.js` | `contextBridge` exposes `window.electronAPI`. Plain JS, not compiled. Renderer→main requests must match an `ipcMain.on`/`handle` in `app.ts`; main→renderer subscriptions must match a `webContents.send` there. |
| `loading.html`, `logs.html`, `settings.html` | Renderer views. They load `@xterm/*` and `jquery` straight from `node_modules/...`. That's why those packages are runtime `dependencies` and why `asar` is `false`. Don't move them to `devDependencies`. |
| `docker-compose.yaml` | Services. Every value comes from `JASPER_*` env vars that `writeEnv()` in `app.ts` sets. |
| `build/` | Icon and macOS entitlements for electron-builder. |
| `package.json` `build` field | electron-builder config. Output goes to `release/` (git-ignored). |

There is **no test suite and no linter**. To validate a change, type-check it (`npm run tsc`),
then do a manual smoke run (below). If you need a packaging check, run a packaging build.

## Commands

```bash
npm ci                          # install exactly from the lockfile (preferred over npm install)
npm run tsc                     # type-check and compile app.ts to app.js. This is the only "lint/test"
npm start                       # tsc + electron app.js (needs a display and Docker)
npm run ci -- --linux --x64     # package without publishing, same as CI (--mac/--win on those OSes)
```

CI (`.github/workflows/build.yml`) runs on every push with **Node 24**: `npm ci`, then
`npm run ci -- --<platform> --<arch>` on mac x64/arm64, linux x64, and win x64.
`release.yml` does the same on `v*.*.*` tags and uploads the artifacts to a draft release.

## Pitfalls hit during a real debug session (and how to avoid them)

### Install / lockfile
- **Use Node 24 / npm 11 to match CI.** `package-lock.json` is `lockfileVersion: 3`.
  Different npm majors rewrite lockfile metadata (`"peer": true`, `libc`, and similar flags).
  That shows up as unexplained `package-lock.json` diffs or `npm ci` "lockfile out of sync"
  failures. Install with `npm ci`, not `npm install`. Only regenerate the lockfile when you change
  dependencies, and do it with npm 11. Never commit a lockfile churned by a different npm version.
  If you're on an older npm, run it as `npx -y npm@11 ...`.
- On Node 22 you get `EBADENGINE` for `electron-context-menu@5.1.0` (requires node >= 24).
  It's only a warning, because the code runs inside Electron's own Node at runtime. Still, it's
  another reason to use Node 24.
- npm 11.2x prints `install-scripts ... electron-winstaller ... not yet covered by allowScripts`.
  It's harmless on Linux and macOS. Don't add allowScripts config just to silence it.
- `postinstall` runs `electron-builder install-app-deps`, which rebuilds native deps
  (`@lydell/node-pty`) for Electron's ABI. If node-pty fails to load ("was compiled against a
  different Node.js version"), re-run `npx electron-builder install-app-deps`.
- **Electron 44 downloads its binary lazily** on the first `electron` run, not during `npm ci`.
  So `node_modules/electron/dist` is missing right after install. The first `npm start` needs
  network access to GitHub releases. To pre-fetch it, run `npx install-electron --no`. If it
  breaks, delete `node_modules/electron` and reinstall.
- `npm audit` reports about 12 vulnerabilities in transitive build tooling. Don't run
  `npm audit fix --force`, because it does breaking major bumps. Dependabot handles updates.

### TypeScript
- The project uses **TypeScript 7** (`typescript ~7.0.2`). `tsconfig.json` sets
  `"ignoreDeprecations": "6.0"`. Don't remove it, and don't downgrade TS to "fix" errors.
- Only `app.ts` is compiled (`"files": ["app.ts"]`). Output is ESM (`"type": "module"`,
  `module: es2022`), so use `import`. `__dirname` is derived from `import.meta.url`.
  `preload.js` stays CommonJS (`require`), because Electron preload scripts load it that way.

### Running the app headless (CI containers / agents)
- **No display:** wrap the command in `xvfb-run -a`.
- **`FATAL: The SUID sandbox helper binary was found, but is not configured correctly ...
  chrome-sandbox is owned by root and has mode 4755`, then exit with SIGTRAP.** This happens
  in containers and on Ubuntu 24.04+ (`kernel.apparmor_restrict_unprivileged_userns=1`). For
  local or agent debugging only, pass `--no-sandbox`. Don't add it to `package.json` or `app.ts`.
- Hundreds of `dbus/bus.cc Failed to connect to the bus` errors are harmless when headless.
  Filter them out with `grep -v dbus`.
- Docker logs stream through a PTY, so the output is full of ANSI escapes and `\r` progress
  frames. To read it, strip them: `sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tr '\r' '\n'`.

Working smoke-test recipe:

```bash
export XDG_CONFIG_HOME=/tmp/jasper-cfg      # isolate settings/data from your real install
npm run tsc
xvfb-run -a npx electron app.js --no-sandbox 2>&1 | grep -v dbus > /tmp/app.log &
# first run pulls images (server, ui, postgres, ssh); allow ~30-60s
curl -s localhost:8081/management/health/readiness   # expect {"status":"UP"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:8082  # expect 200
docker ps                                             # jasper-app-{web,db,client,ssh}-1
kill -TERM <pid of node_modules/electron/dist/electron>  # graceful: runs `docker compose down`
docker ps -a                                          # should be empty
sudo rm -rf /tmp/jasper-cfg                           # data dirs are root-owned (see below)
```

### Dev vs. packaged differences (easy to misdiagnose)
- `npm start` runs `electron app.js` (a file, not the app dir), so Electron does **not** read
  `package.json`. As a result:
  - `app.getPath('userData')` is `~/.config/Electron` (Linux), not `~/.config/Jasper`. Dev
    settings, Postgres data, and storage live there, separate from the installed app.
  - `app.getVersion()` returns the **Electron** version (for example `44.5.1`), not
    `1.1.25`. The log line `Jasper App Version: 44.5.1` is expected in dev. Version-based logic
    (auto-update comparison) only behaves correctly when packaged.
- `settings.json` is only written on shutdown or a settings change. On first launch, the defaults
  in `app.ts` are used (server/client `v1.3`, Postgres `18`, ssh `v1.1`, ports 8081/8082/8022,
  and `pull*: true`, which means `pull_policy: always`, so every start re-pulls images).
- The compose project name comes from the directory that holds `docker-compose.yaml`:
  `jasper-app` (the repo folder name) in dev, and `app` when packaged (`resources/app`).
  Containers don't collide, but **ports do**. Quit any installed Jasper app before `npm start`,
  or change the ports in Settings.

### Docker
- Docker must be running. If `docker compose up` exits with code 1, the app shows "Docker Not
  Running". If the `docker` binary is missing, it shows "Docker Compose Missing".
- Docker creates the bind-mounted `dataDir` and `storageDir` as **root**. Removing them
  afterwards needs `sudo`.
- If the app is killed hard (SIGKILL or a crash), containers keep running. Running plain
  `docker compose -f docker-compose.yaml down` then fails with
  `required variable JASPER_DATA_DIR is missing a value`. Prefix the command with the variable:
  `JASPER_DATA_DIR=/tmp/x docker compose -f docker-compose.yaml down`. You can also run
  `docker rm -f $(docker ps -aq --filter name=jasper-app-)`.
- Server-side `ERROR: relation ... already exists` and `databasechangeloglock does not exist`
  lines from Postgres on first boot are normal Liquibase noise.

### Packaging
- `npm run ci -- --linux --x64` takes about 20s and produces `release/Jasper-<ver>.AppImage`.
  It downloads Electron and AppImage tooling, so it needs network. Delete `release/` afterwards.
  It's git-ignored, but large.
- The warnings "asar usage is disabled", "duplicate dependency references", and "desktopName is
  not set" are expected. Don't enable asar, because the HTML views load files from
  `node_modules` at runtime.
- `*.ts`, `*.map`, `package.json`, and `package-lock.json` are excluded from the packaged
  files, but Electron still writes its own `package.json`.

## Conventions
- When adding a renderer→main feature: add the channel in `preload.js`, register it in the
  `app.on('ready')` block of `app.ts`, and validate inputs in main. See `update-version`
  (allow-list via `versionServices`) and `save-as` (sender/origin checks).
- When adding a compose setting: add a default in the `data` object, export it in `writeEnv()`,
  reference it as `${JASPER_...:-default}` in `docker-compose.yaml`, and expose it in
  `settings.html`.
- Version bumps: update `package.json`, `package-lock.json`, and the download links in
  `README.md` together.
- 2-space indentation and single quotes in `.ts` (`.editorconfig`). Keep changes minimal. Dependabot
  manages dependency bumps.

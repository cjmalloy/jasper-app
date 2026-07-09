# Jasper Desktop App
Desktop app for [Jasper KM](https://github.com/cjmalloy/jasper). Uses electron to wrap a docker compose config.  

- [Downloads](https://github.com/cjmalloy/jasper-app/releases/latest)

## Prerequisites
Docker Compose is required. Install from https://www.docker.com/products/docker-desktop/

### macOs 15
To allow on macOs 15 you must remove the quarantine flag and re-sign:
```shell
xattr -d com.apple.quarantine /Applications/Jasper.app
codesign --force --deep --sign - /Applications/Jasper.app
```

## Troubleshooting
If Docker is not running the app will not start.

## Developing
This project uses npm and typescript. Run `npm install` to install dependencies.

### Development application

Run `npm start` to compile and start electron. Editing `app.ts` will require restarting, but you can edit any of the html views,
`loading.html`, `logs.html`, `settings.html` and reload the electron window.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `release/` directory.

### Tauri port (in progress)

A Tauri v2 port of the Electron main process lives in `src-tauri/`. It requires a
[Rust toolchain](https://www.rust-lang.org/tools/install) (and the
[Tauri Linux system dependencies](https://tauri.app/start/prerequisites/) on Linux).

- Run `npm run tauri dev` to build and start the Tauri app.
- Run `npm run tauri build` to produce native bundles in `src-tauri/target/release/bundle/`.

The HTML views are shared between both apps: `tauri-shim.js` provides the same
`window.electronAPI` bridge as `preload.js` when running under Tauri.

### Debugging Jasper-UI

Right click on any electron window and click `Inspect` to open the debugger.

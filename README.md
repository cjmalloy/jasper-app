# Jasper Desktop App
Desktop app for [Jasper Knowledge Management](https://github.com/cjmalloy/jasper).  

[![Windows](https://img.shields.io/badge/-Windows_x64-blue.svg?style=for-the-badge&logo=windows)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper.Setup.1.1.25.exe)
[![Linux](https://img.shields.io/badge/-Linux-red.svg?style=for-the-badge&logo=linux)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.25.AppImage)
[![MacOS](https://img.shields.io/badge/-MacOS-lightblue.svg?style=for-the-badge&logo=apple)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.25-arm64.dmg)
[![Source Tarball](https://img.shields.io/badge/-Source_tar-green.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/archive/refs/tags/v1.1.25.tar.gz)
[![All versions](https://img.shields.io/badge/-All_Versions-lightgrey.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/releases)

## Prerequisites
On macOS and Windows, [Podman](https://podman.io/) and Docker Compose are bundled with the app, so Docker Desktop is not required.
On first start a Podman virtual machine is created, which downloads a VM image and may take a few minutes.
Windows requires [WSL 2](https://learn.microsoft.com/windows/wsl/install) (`wsl --install`).

On Linux, install either [Podman](https://podman.io/docs/installation) with Docker Compose, or Docker Engine with Docker Compose.

The container engine can be selected in Settings. By default Docker is used if it is already running, otherwise Podman.

### macOs 15+
To allow on macOs 15+ you must remove the quarantine flag and re-sign:
```shell
xattr -dr com.apple.quarantine /Applications/Jasper.app
codesign --force --deep --sign - /Applications/Jasper.app
```

## Troubleshooting
If the container engine cannot be started, check the logs (tray menu → Show Logs) for details.
A different container engine can be selected in Settings.

## Developing
This project uses npm and typescript. Run `npm install` to install dependencies.

### Development application

Run `npm start` to compile and start electron. Editing `app.ts` will require restarting, but you can edit any of the html views,
`loading.html`, `logs.html`, `settings.html` and reload the electron window.

Run `npm run fetch-podman` to download the bundled Podman and Docker Compose binaries for your platform into `bin/`.

### Build

Bundled Podman binaries are downloaded automatically before packaging. macOS builds must be run on macOS.

Run `npm run build` to build the project. The build artifacts will be stored in the `release/` directory.

### Debugging Jasper-UI

Right click on any electron window and click `Inspect` to open the debugger.

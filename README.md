# Jasper Desktop App
Desktop app for [Jasper Knowledge Management](https://github.com/cjmalloy/jasper).  

[![Windows](https://img.shields.io/badge/-Windows_x64-blue.svg?style=for-the-badge&logo=windows)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-Setup-1.1.16.exe)
[![Linux](https://img.shields.io/badge/-Linux-red.svg?style=for-the-badge&logo=linux)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.16.AppImage)
[![MacOS](https://img.shields.io/badge/-MacOS-lightblue.svg?style=for-the-badge&logo=apple)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.16-universal.dmg)
[![Source Tarball](https://img.shields.io/badge/-Source_tar-green.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/archive/refs/tags/v1.1.16.tar.gz)
[![All versions](https://img.shields.io/badge/-All_Versions-lightgrey.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/releases)

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

### Debugging Jasper-UI

Right click on any electron window and click `Inspect` to open the debugger.

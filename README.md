# Jasper Desktop App
Desktop app for [Jasper Knowledge Management](https://github.com/cjmalloy/jasper).  

[![Windows](https://img.shields.io/badge/-Windows_x64-blue.svg?style=for-the-badge&logo=windows)](https://github.com/cjmalloy/jasper-app/releases/latest/download/win-x64-Jasper-Setup.zip)
[![Linux](https://img.shields.io/badge/-Linux_x64-red.svg?style=for-the-badge&logo=linux)](https://github.com/cjmalloy/jasper-app/releases/latest/download/linux-x64-Jasper-Setup.tar.gz)
[![MacOS](https://img.shields.io/badge/-MacOS_ARM64-lightblue.svg?style=for-the-badge&logo=apple)](https://github.com/cjmalloy/jasper-app/releases/latest/download/macos-arm64-Jasper.dmg)
[![All versions](https://img.shields.io/badge/-All_Versions-lightgrey.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/releases)

## Prerequisites
Docker Compose is required. Install from https://www.docker.com/products/docker-desktop/  

### macOs 15+
To allow on macOs 15+ you must remove the quarantine flag and re-sign:
```shell
xattr -d com.apple.quarantine /Applications/Jasper.app
codesign --force --deep --sign - /Applications/Jasper.app
```

## Troubleshooting
If Docker is not running the app will not start.

## Developing
This project uses npm, TypeScript, and Electrobun. Run `npm install` to install dependencies.

### Development application

Run `npm start` to build and start the Electrobun app, or `npm run dev` to rebuild and relaunch automatically when files change.

### Build

Run `npm run build` to create a stable Electrobun build. The build artifacts will be stored in the `release/` directory.

### Debugging Jasper-UI

Electrobun development builds can be inspected with `npx electrobun run --env=dev --inspect`.

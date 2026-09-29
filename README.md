# Jasper Desktop App
Desktop app for [Jasper Knowledge Management](https://github.com/cjmalloy/jasper).  

[![Windows](https://img.shields.io/badge/-Windows_x64-blue.svg?style=for-the-badge&logo=windows)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper.Setup.1.1.25.exe)
[![Linux](https://img.shields.io/badge/-Linux-red.svg?style=for-the-badge&logo=linux)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.25.AppImage)
[![MacOS](https://img.shields.io/badge/-MacOS-lightblue.svg?style=for-the-badge&logo=apple)](https://github.com/cjmalloy/jasper-app/releases/latest/download/Jasper-1.1.25-arm64.dmg)
[![Source Tarball](https://img.shields.io/badge/-Source_tar-green.svg?style=for-the-badge)](https://github.com/cjmalloy/jasper-app/archive/refs/tags/v1.1.25.tar.gz)
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

## Security model
Only the Jasper window is admin. The app adds a JWT signed with a key generated on each launch to the window's
requests. Everything else, including browser tabs and Cloudflare, is anonymous, and SSH users get their own `User-Tag`.
`web` and `db` publish no ports, and `client` and `ssh` only listen on `127.0.0.1`.

## Upgrading to Postgres 17 data path
With Postgres 17 or earlier, the database now lives in `<data dir>/17/docker` instead of an anonymous Docker volume,
which could be lost when the container was recreated. The new path starts empty, so back up before upgrading and
restore after:
```shell
# Before upgrading, with the old version running:
docker exec <db container> pg_dump -U jasper -d jasper -Fc > jasper.dump
# After upgrading, with the new version running:
docker exec -i <db container> pg_restore -U jasper -d jasper --clean --if-exists < jasper.dump
```

## Developing
This project uses npm and typescript. Run `npm install` to install dependencies.

### Development application

Run `npm start` to compile and start electron. Editing `app.ts` will require restarting, but you can edit any of the html views,
`loading.html`, `logs.html`, `settings.html` and reload the electron window.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `release/` directory.

### Debugging Jasper-UI

Right click on any electron window and click `Inspect` to open the debugger.

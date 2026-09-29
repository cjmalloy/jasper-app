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
The OS user account is the security boundary:

* Only the Jasper window is admin. Its requests carry a JWT (`sub: +user`, `auth: ROLE_ADMIN`) signed with an HMAC key
  that is generated on each launch and only shared with the server. The token stays in the Electron main process and is
  added to requests at the network layer; anything the page sets for `Authorization` or `User-Role` is dropped.
* The `client` UI is published on `127.0.0.1` only. Anything else that reaches it, like a browser tab, has no token and
  is anonymous. The server ignores `User-Role` headers, and the default role is always `ROLE_ANONYMOUS`.
* Cloudflare goes through the `proxy` container, and only gets anonymous access.
* ngrok only forwards to the `ssh` container. SSH users get their own identity (`User-Tag`) from jasper-ssh.
* `web` and `db` publish no ports. `db` is on an internal network that only `web` can reach, and the tunnels can't
  reach `web` directly.
* The database password is random on new installs and stored with Electron `safeStorage`. On Linux, set up a keyring
  (gnome-keyring or kwallet), or the password is only obfuscated. `POSTGRES_PASSWORD` is only applied when the database
  is created, so changing the password needs an `ALTER ROLE jasper PASSWORD '...'` too.

This relies on the `jasper-ui` proxy stripping `User-Tag` and access headers from untrusted requests (and ideally
`Authorization`, as defense in depth), and on `jasper-ssh` binding each user's nginx to `127.0.0.1`.
It does not protect against malware running as your user, members of the `docker` / `docker-users` group, or anything
on a powered-on device.

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
Existing installs keep the old `jasper` database password.

## Developing
This project uses npm and typescript. Run `npm install` to install dependencies.

### Development application

Run `npm start` to compile and start electron. Editing `app.ts` will require restarting, but you can edit any of the html views,
`loading.html`, `logs.html`, `settings.html` and reload the electron window.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `release/` directory.

### Debugging Jasper-UI

Right click on any electron window and click `Inspect` to open the debugger.

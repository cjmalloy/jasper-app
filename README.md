# Jasper Desktop App
Desktop app for [Jasper KM](https://github.com/cjmalloy/jasper). Uses Tauri to wrap a docker compose config.  

- [Downloads](https://github.com/cjmalloy/jasper-app/releases/latest)

## Prerequisites
Docker Compose is required. Install from https://www.docker.com/products/docker-desktop/

### macOs 15
To allow on macOs 15 you must remove the quarantine flag:
```shell
xattr -d com.apple.quarantine /Applications/Jasper.app
```

## Troubleshooting
If Docker is not running the app will not start.

## Developing
This project uses npm, Rust, and Tauri. Run `npm install` to install Node.js dependencies. Rust dependencies will be fetched automatically when building.

### Development application

Run `npm start` to compile and start the Tauri app in development mode. The frontend HTML files are in the `build/` directory, and the Rust backend is in `src-tauri/src/`.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `src-tauri/target/release/` directory.

### Debugging Jasper-UI

Right click on any Tauri window and click `Inspect` to open the debugger (in development mode).

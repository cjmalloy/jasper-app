# Jasper Desktop App
Desktop app for [Jasper KM](https://github.com/cjmalloy/jasper). Uses Tauri to wrap a docker compose config.  

**Note**: This app was recently migrated from Electron to Tauri. See [MIGRATION.md](MIGRATION.md) for details.

- [Downloads](https://github.com/cjmalloy/jasper-app/releases/latest)

## Prerequisites
Docker Compose is required. Install from https://www.docker.com/products/docker-desktop/

**Additional Requirements:**
- Linux: webkit2gtk, libappindicator3 (usually installed automatically)
- macOS: macOS 10.15 or later
- Windows: Windows 7 or later (WebView2 runtime)

### macOs 15
To allow on macOs 15 you must remove the quarantine flag:
```shell
xattr -d com.apple.quarantine /Applications/Jasper.app
```

## Troubleshooting
If Docker is not running the app will not start.

## Developing
This project uses npm, Rust, and Tauri. Run `npm install` to install Node.js dependencies. Rust dependencies will be fetched automatically when building.

### Requirements
- Node.js 18+
- Rust 1.77.2+ ([Install Rust](https://rustup.rs/))
- Platform-specific dependencies:
  - **Linux**: `sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio C++ build tools

### Development application

Run `npm start` to compile and start the Tauri app in development mode. The frontend HTML files are in the `build/` directory, and the Rust backend is in `src-tauri/src/`.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `src-tauri/target/release/bundle/` directory.

### Debugging Jasper-UI

Right click on any Tauri window and click `Inspect` to open the debugger (in development mode).

## What's New in Tauri

- **Smaller Size**: App is now ~15MB instead of ~150MB
- **Better Performance**: Uses native webview instead of bundling Chromium
- **Improved Security**: Rust backend with granular permissions
- **Native Integration**: Better system tray and window management

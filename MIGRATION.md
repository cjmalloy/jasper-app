# Electron to Tauri Migration

This document describes the migration from Electron to Tauri for the Jasper Desktop App.

## What Changed

### Architecture
- **Before**: Electron app with Node.js backend (app.ts) and HTML/JavaScript frontend
- **After**: Tauri app with Rust backend (src-tauri/) and HTML/JavaScript frontend

### Key Benefits of Tauri
1. **Smaller Bundle Size**: Tauri apps are significantly smaller than Electron apps (typically 10-20MB vs 100-150MB)
2. **Better Performance**: Uses the system's native webview instead of bundling Chromium
3. **Enhanced Security**: Granular permission system and Rust's memory safety
4. **Native System Integration**: Better integration with system features like tray icons

### File Structure Changes

#### Removed Files (backed up in .electron-backup/)
- `app.ts` - Main Electron process
- `app.js` - Compiled JavaScript
- `preload.js` - Electron preload script
- `loading.html` - Old loading page
- `logs.html` - Old logs page
- `settings.html` - Old settings page

#### Added Files
- `src-tauri/` - Rust backend directory
  - `src/main.rs` - Entry point
  - `src/lib.rs` - Main application logic
  - `src/settings.rs` - Settings management
  - `Cargo.toml` - Rust dependencies
  - `tauri.conf.json` - Tauri configuration
- `build/` - Frontend HTML files
  - `loading.html` - Loading page with Tauri APIs
  - `logs.html` - Logs page with Tauri APIs
  - `settings.html` - Settings page with Tauri APIs

### API Changes

#### IPC Communication
**Electron (old):**
```javascript
// Renderer process
window.electronAPI.fetchSettings();
window.electronAPI.handleSettings((event, settings) => { ... });

// Main process
ipcMain.on('fetch-settings', (_event) => { ... });
```

**Tauri (new):**
```javascript
// Frontend
const { invoke } = window.__TAURI__.core;
const settings = await invoke('fetch_settings');

const { listen } = window.__TAURI__.event;
listen('update-settings', (event) => { ... });
```

```rust
// Backend
#[tauri::command]
async fn fetch_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    // Implementation
}
```

### Build Process

#### Before (Electron)
```bash
npm run build  # Uses electron-builder
# Output: release/Jasper-*.dmg, release/Jasper-*.AppImage, release/Jasper-*.exe
```

#### After (Tauri)
```bash
npm run build  # Uses Tauri CLI
# Output: src-tauri/target/release/bundle/
#   - deb/Jasper_*.deb (Linux)
#   - rpm/Jasper_*.rpm (Linux)
#   - dmg/Jasper_*.dmg (macOS)
#   - msi/Jasper_*.msi (Windows)
```

### GitHub Actions

Updated workflows to:
1. Install Rust toolchain
2. Install platform-specific dependencies (e.g., webkit2gtk on Linux)
3. Use `tauri-apps/tauri-action` for releases
4. Support multiple architectures (including Apple Silicon)

## Migration Checklist

✅ Project structure setup
✅ Tauri configuration
✅ Rust backend implementation
✅ Frontend HTML files converted
✅ IPC handlers implemented
✅ System tray integration
✅ Window management
✅ Settings persistence
✅ Docker compose integration
✅ Build scripts updated
✅ CI/CD workflows updated
✅ Documentation updated
✅ Old Electron files removed

## Known Differences

### Features Preserved
- Docker compose management
- Settings persistence
- Multiple windows (main, logs, settings)
- System tray icon
- Auto-updates (via GitHub releases)

### Implementation Differences
1. **jQuery**: Now loaded from CDN instead of node_modules
2. **Window Management**: Uses Tauri's window API instead of Electron's BrowserWindow
3. **File Paths**: Uses Tauri's path resolver instead of Node.js path module
4. **Child Processes**: Docker commands run via Rust's `std::process::Command`

## Development

### Running in Development
```bash
npm start  # or npm run dev
```

### Building for Production
```bash
npm run build
```

### Requirements
- Node.js 18+
- Rust 1.77.2+
- Platform-specific dependencies:
  - Linux: webkit2gtk, libappindicator3, librsvg2
  - macOS: Xcode Command Line Tools
  - Windows: WebView2 (usually pre-installed)

## Future Improvements

Possible enhancements for the future:
1. Implement actual Docker registry API calls for version checking
2. Add proper logging system using tauri-plugin-log
3. Implement updater functionality using tauri-plugin-updater
4. Add more robust error handling
5. Implement proper Docker compose output streaming to logs window
6. Add unit tests for Rust backend
7. Add integration tests

## Resources

- [Tauri Documentation](https://tauri.app/)
- [Tauri API Reference](https://tauri.app/v1/api/)
- [Rust Documentation](https://doc.rust-lang.org/)
- [Migration Guide](https://tauri.app/v1/guides/migration/from-electron/)

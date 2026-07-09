// Tauri replacement for the Electron preload.js contextBridge.
// Only takes effect when running inside Tauri (no-op under Electron, where
// preload.js has already defined window.electronAPI).
(() => {
  if (window.electronAPI || !window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const on = (channel, callback) => listen(channel, event => callback(event, event.payload));

  window.electronAPI = {
    handleSettings: (callback) => on('update-settings', callback),
    updateImageTags: (callback) => on('image-tags', callback),
    streamLogs: (callback) => on('stream-logs', callback),
    notifyFinished: (callback) => on('finished', callback),

    fetchSettings: () => invoke('fetch_settings'),
    saveSettings: (settings) => invoke('settings_value', { settings }),
    patchSettings: (patch) => invoke('settings_patch', { patch }),
    openDir: (dir) => invoke('open_dir', { path: dir }),
    command: (id, args) => invoke('command', { value: id }),
  };
})();

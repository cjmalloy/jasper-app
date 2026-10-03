const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    handleSettings: (callback) => ipcRenderer.on('update-settings', callback),
    updateImageTags: (callback) => ipcRenderer.on('image-tags', callback),
    streamLogs: (callback) => ipcRenderer.on('stream-logs', callback),
    handleLogServices: (callback) => ipcRenderer.on('log-services', callback),
    notifyFinished: (callback) => ipcRenderer.on('finished', callback),

  fetchLogs: () => ipcRenderer.send('fetch-logs'),
  resizePty: (size) => ipcRenderer.send('resize-pty', size),
  setLogServices: (services) => ipcRenderer.send('set-log-services', services),
  fetchSettings: () => ipcRenderer.send('fetch-settings'),
  saveSettings: (settings) => ipcRenderer.send('settings-value', settings),
  patchSettings: (patch) => ipcRenderer.send('settings-patch', patch),
  openDir: (dir) => ipcRenderer.send('open-dir', dir),
  saveAs: (buffer, defaultFilename) => ipcRenderer.invoke('save-as', buffer, defaultFilename),
  command: (id, args) => ipcRenderer.send('command', id, args),
  updateVersion: (name, value) => ipcRenderer.send('update-version', name, value),
});

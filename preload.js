const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    handleSettings: (callback) => ipcRenderer.on('update-settings', callback),
    updateImageTags: (callback) => ipcRenderer.on('image-tags', callback),
    streamLogs: (callback) => ipcRenderer.on('stream-logs', callback),
    notifyFinished: (callback) => ipcRenderer.on('finished', callback),

  fetchLogs: () => ipcRenderer.send('fetch-logs'),
  resizePty: (size) => ipcRenderer.send('resize-pty', size),
  replayLogs: (rows) => ipcRenderer.send('replay-logs', rows),
  fetchSettings: () => ipcRenderer.send('fetch-settings'),
  saveSettings: (settings) => ipcRenderer.send('settings-value', settings),
  patchSettings: (patch) => ipcRenderer.send('settings-patch', patch),
  openDir: (dir) => ipcRenderer.send('open-dir', dir),
  command: (id, args) => ipcRenderer.send('command', id, args),
});

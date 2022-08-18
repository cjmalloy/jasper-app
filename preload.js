const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    handleSettings: (callback) => ipcRenderer.on('update-settings', callback),
    streamLogs: (callback) => ipcRenderer.on('stream-logs', callback)
});

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    handleSettings: (callback) => ipcRenderer.on('update-settings', callback),
    updateImageTags: (callback) => ipcRenderer.on('image-tags', callback),
    streamLogs: (callback) => ipcRenderer.on('stream-logs', callback),
    notifyFinished: (callback) => ipcRenderer.on('finished', callback),
});

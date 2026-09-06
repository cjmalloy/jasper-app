const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__electronAPI', {
    handleSettings: (callback) => ipcRenderer.on('update-settings', callback),
    updateImageTags: (callback) => ipcRenderer.on('image-tags', callback),
    streamLogs: (callback) => ipcRenderer.on('stream-logs', callback),
    notifyFinished: (callback) => ipcRenderer.on('finished', callback),

  fetchLogs: () => ipcRenderer.send('fetch-logs'),
  resizePty: (size) => ipcRenderer.send('resize-pty', size),
  fetchSettings: () => ipcRenderer.send('fetch-settings'),
  saveSettings: (settings) => ipcRenderer.send('settings-value', settings),
  patchSettings: (patch) => ipcRenderer.send('settings-patch', patch),
  openDir: (dir) => ipcRenderer.send('open-dir', dir),
  saveFile: (buffer, defaultFilename) => ipcRenderer.invoke('save-file', buffer, defaultFilename),
  command: (id, args) => ipcRenderer.send('command', id, args),
});

// Blobs cannot cross contextBridge, so convert them in the browser's world.
contextBridge.executeInMainWorld({
  func: () => {
    const api = window.__electronAPI;
    Object.defineProperty(window, 'electronAPI', {
      enumerable: true,
      value: Object.freeze({
        ...api,
        saveAs: async (file, defaultFilename) => {
          const buffer = await Blob.prototype.arrayBuffer.call(file);
          return api.saveFile(buffer, defaultFilename);
        },
      }),
    });
  },
});

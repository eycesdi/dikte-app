const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dikte', {
  close: () => ipcRenderer.send('close-app'),
  resize: (h) => ipcRenderer.send('resize-bar', h)
});

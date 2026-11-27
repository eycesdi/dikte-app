const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dikte', {
  close: () => ipcRenderer.send('close-app')
});

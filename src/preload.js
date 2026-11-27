const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dikte', {
  close: () => ipcRenderer.send('close-app'),
  resize: (h, dir) => ipcRenderer.send('resize-bar', h, dir),
  audioStart: (lang) => ipcRenderer.send('audio-start', lang),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  minimize: () => ipcRenderer.send('minimize-to-tray'),
  audioStop: () => ipcRenderer.send('audio-stop'),
  copyText: (t) => ipcRenderer.invoke('copy-text', t),
  whisperStatus: () => ipcRenderer.invoke('whisper-status'),
  onWhisper: (cb) => ipcRenderer.on('whisper', (e, m) => cb(m)),
  audioChunk: (buf) => ipcRenderer.send('audio-chunk', buf),
  audioSave: () => ipcRenderer.invoke('audio-save')
});

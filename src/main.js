const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const BAR_W = 640;
const BAR_H = 52;

function createBar() {
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    x: Math.round(workArea.x + (workArea.width - BAR_W) / 2),
    y: workArea.y + workArea.height - BAR_H - 8,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  createBar();
  ipcMain.on('close-app', () => app.quit());
  ipcMain.on('resize-bar', (e, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const b = win.getBounds();
    const bottom = b.y + b.height;
    const height = Math.max(BAR_H, Math.min(Math.round(h), 360));
    win.setBounds({ x: b.x, y: bottom - height, width: b.width, height });
  });
});

app.on('window-all-closed', () => app.quit());

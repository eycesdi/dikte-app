const { app, BrowserWindow, screen, ipcMain, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
let chunks = [];
let sampleCount = 0;

// GİZLİLİK: ses ve metin varsayılan olarak ASLA diske yazılmaz.
// Sadece geliştirme sırasında DIKTE_KEEP_RECORDINGS=1 ile açılır; uygulama kapanınca her durumda silinir.
const KEEP = process.env.DIKTE_KEEP_RECORDINGS === '1';
const recordingsDir = () => path.join(app.getPath('userData'), 'recordings');
function wipeRecordings() {
  try { fs.rmSync(recordingsDir(), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(path.join(app.getPath('userData'), 'last-recording.wav'), { force: true }); } catch (e) {}
}

function writeWav(floatChunks, file) {
  const total = floatChunks.reduce((n, c) => n + c.length, 0);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  let o = 44;
  for (const c of floatChunks) for (let i = 0; i < c.length; i++) {
    const v = Math.max(-1, Math.min(1, c[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), o); o += 2;
  }
  fs.writeFileSync(file, buf);
  return total / SAMPLE_RATE;
}

const BAR_W = 640;
const BAR_H = 52;
let expanded = false;
let tray = null;

// Tek örnek: ikinci kez açılırsa mevcut çubuğu öne getir
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (mainWin) { mainWin.show(); } });

function showBar() { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); } }
function hideToTray() { if (mainWin && !mainWin.isDestroyed()) { mainWin.hide(); } }

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Dikte');
  tray.on('click', () => (mainWin.isVisible() ? hideToTray() : showBar()));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Göster', click: showBar },
    { label: "Tray'e küçült", click: hideToTray },
    { type: 'separator' },
    { label: 'Çıkış', click: () => app.quit() }
  ]));
}   // menü açıkken pencere büyük; o sırada sürükleme/yapışma yok

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

  // Bar ekranın üst/alt kenarına ve yatay ortaya yapışır; sürüklerken Windows gibi önizleme gösterilir
  const M = 8, T = 56;
  function snapTarget(b) {
    const wa = screen.getDisplayMatching(b).workArea;
    // Sadece üst ve alt kenara yapışır; yatay konum serbest (sadece ekran dışına çıkamaz)
    const x = Math.max(wa.x + M, Math.min(b.x, wa.x + wa.width - b.width - M));
    let y = Math.max(wa.y + M, Math.min(b.y, wa.y + wa.height - b.height - M));
    let snapped = false;
    const top = wa.y + M, bottom = wa.y + wa.height - b.height - M;
    if (Math.abs(y - top) < T) { y = top; snapped = true; }
    else if (Math.abs(y - bottom) < T) { y = bottom; snapped = true; }
    return { x, y, snapped };
  }

  // Önizleme penceresi baştan yüklenir, böylece sürüklerken anında görünür
  const preview = new BrowserWindow({
    width: BAR_W, height: BAR_H, show: false, frame: false, transparent: true, resizable: false,
    focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true
  });
  preview.setIgnoreMouseEvents(true);
  preview.setAlwaysOnTop(true, 'screen-saver');
  preview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:transparent;overflow:hidden">' +
    '<div style="position:fixed;inset:0;box-sizing:border-box;border-radius:26px;' +
    'background:rgba(120,170,255,.22);border:2px solid rgba(150,190,255,.9);' +
    'box-shadow:0 0 18px rgba(120,170,255,.45)"></div></body>'));
  const hidePreview = () => { if (!preview.isDestroyed() && preview.isVisible()) preview.hide(); };

  // Sürükleme: Windows'un kendi sürüklemesi yerine kendimiz yönetiyoruz (olaylar güvenilir olsun diye)
  let origin = null;
  win.dragStart = () => { origin = expanded ? null : win.getBounds(); };
  win.dragMove = (dx, dy) => {
    if (!origin) return;
    const b = { x: origin.x + Math.round(dx), y: origin.y + Math.round(dy), width: origin.width, height: origin.height };
    win.setBounds(b);
    const t = snapTarget(b);
    if (t.snapped && (t.x !== b.x || t.y !== b.y)) {
      preview.setBounds({ x: t.x, y: t.y, width: b.width, height: b.height });
      if (!preview.isVisible()) preview.showInactive();
    } else hidePreview();
  };
  win.dragEnd = () => {
    hidePreview();
    if (!origin) return;
    const b = win.getBounds();
    origin = null;
    if (expanded) return;
    const t = snapTarget(b);
    win.setBounds({ x: t.x, y: t.y, width: b.width, height: b.height });
  };
  win.on('closed', () => { if (!preview.isDestroyed()) preview.destroy(); });
  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

// ---- Whisper (Python) süreci ----
let whisper = null;
let whisperReady = false;
let whisperInfo = null;
let restarts = 0;
let take = { lang: 'auto', file: null, commits: [] };   // son kayıt: günlük için
let quitting = false;
let mainWin = null;

function startWhisper() {
  // Paketli sürümde Python ve model uygulamanın 'resources' klasöründe, geliştirmede proje klasöründe
  const res = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const py = app.isPackaged ? path.join(res, 'py', 'python.exe') : path.join(res, '.venv', 'Scripts', 'python.exe');
  const script = path.join(res, 'python', 'whisper_server.py');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (app.isPackaged) { env.DIKTE_MODELS_DIR = path.join(res, 'models'); env.HF_HUB_OFFLINE = '1'; }
  whisper = spawn(py, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let acc = '';
  whisper.stdout.setEncoding('utf8');
  whisper.stdout.on('data', (d) => {
    acc += d;
    let i;
    while ((i = acc.indexOf(String.fromCharCode(10))) >= 0) {
      const line = acc.slice(0, i).trim(); acc = acc.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.type === 'ready') { whisperReady = true; whisperInfo = msg; restarts = 0; }
      if (msg.type === 'commit' && KEEP) take.commits.push(msg.text);
      if (msg.type === 'done' && KEEP) logTake();
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('whisper', msg);
    }
  });
  whisper.stderr.on('data', (d) => console.error('[whisper]', String(d).trim()));
  whisper.on('exit', (code) => {
    whisperReady = false;
    if (quitting) return;
    const notify = (t) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('whisper', { type: t }); };
    if (restarts < 3) { restarts++; notify('restarting'); setTimeout(startWhisper, 1000); }
    else notify('failed');
  });
}

const send = (obj) => {
  if (whisper && whisper.stdin.writable) whisper.stdin.write(JSON.stringify(obj) + String.fromCharCode(10));
};

// Her kaydı (WAV) ve çıkan metni kaydet: tanıma kalitesini sonradan çözümlemek için
function logTake() {
  try {
    const dir = recordingsDir();
    fs.appendFileSync(path.join(dir, 'transcripts.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), lang: take.lang, file: take.file, text: take.commits.join(' ') }) + String.fromCharCode(10));
    const wavs = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
    wavs.slice(0, Math.max(0, wavs.length - 40)).forEach((f) => fs.unlinkSync(path.join(dir, f)));   // son 40 kayıt
  } catch (e) { console.error('[log]', e.message); }
}

function floatToB64Int16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return out.toString('base64');
}

// Geliştirme testi: DIKTE_SELFTEST=1 ile sahte sürükleme yapıp önizleme/yapışma sonuçlarını yazar
function runSnapSelftest(win) {
  const prev = BrowserWindow.getAllWindows().find((w) => w !== win);
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const log = (k, v) => console.log('[selftest]', k, JSON.stringify(v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (code) => win.webContents.executeJavaScript(code);
  const LONG = 'Bu çok uzun bir deneme cümlesidir ve pencerenin aşağıya ya da yukarıya doğru büyümesini sınamak için yazıldı. '.repeat(4);

  async function panelTest(label) {
    await run(`committed = ${JSON.stringify(LONG)}; partial = 'şu an söyleniyor'; recording = true; showLive();`);
    await sleep(700);
    const info = await run(`({ show: panel.classList.contains('show'), vis: panel.classList.contains('vis'), panelH: panel.offsetHeight, long: isLong(), dir: curDir })`);
    log(label, { bounds: win.getBounds(), ...info });
    await run(`recording = false; committed = ''; partial = ''; pinned = false; showLive();`);
    await sleep(700);
    log(label + ' / kapandi', { bounds: win.getBounds() });
  }

  setTimeout(async () => {
    const b0 = win.getBounds();
    log('baslangic', { bar: b0, workArea: wa });
    win.dragStart();
    win.dragMove(-60, -(b0.y - wa.y - 8) + 25);              // üst kenara 25 px yakın
    log('ust-yakin onizleme gorunur', { visible: prev.isVisible() });
    win.dragEnd();
    log('birakinca bar', { bar: win.getBounds() });
    await sleep(300);
    await panelTest('UST: pencere asagi buyumeli');
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: wa.y + wa.height - b.height - 8, width: b.width, height: b.height });
    await sleep(300);
    await panelTest('ALT: pencere yukari buyumeli');
    // gizlilik: sahte 3 sn'lik kayıt gönder, diske bir şey yazılıyor mu bak
    await run(`(async () => { window.dikte.audioStart('tr'); for (let i = 0; i < 30; i++) window.dikte.audioChunk(new Float32Array(1600).fill(0.1).buffer); return await window.dikte.audioSave(); })()`)
      .then((r) => log('gizlilik: kayit sonucu', r));
    log('gizlilik: kayit klasoru var mi (KEEP=' + KEEP + ')', { exists: fs.existsSync(recordingsDir()), files: fs.existsSync(recordingsDir()) ? fs.readdirSync(recordingsDir()) : [] });
    app.quit();
  }, 1500);
}

app.whenReady().then(() => {
  wipeRecordings();                      // önceki oturumdan kalan kayıt varsa sil
  mainWin = createBar();
  createTray();
  const selftest = !!process.env.DIKTE_SELFTEST;
  if (!selftest) startWhisper();
  ipcMain.handle('whisper-status', () => ({ ready: whisperReady, info: whisperInfo }));
  ipcMain.on('close-app', () => app.quit());
  ipcMain.on('minimize-to-tray', () => hideToTray());
  ipcMain.on('drag-start', () => mainWin.dragStart());
  ipcMain.on('drag-move', (e, dx, dy) => mainWin.dragMove(dx, dy));
  ipcMain.on('drag-end', () => mainWin.dragEnd());
  ipcMain.handle('copy-text', (e, t) => { clipboard.writeText(String(t || '')); return true; });
  ipcMain.on('audio-start', (e, lang) => { chunks = []; sampleCount = 0; take = { lang: lang || 'auto', file: null, commits: [] }; send({ cmd: 'start', lang: lang || 'auto' }); });
  ipcMain.on('audio-chunk', (e, buf) => {
    const f = new Float32Array(buf);
    sampleCount += f.length;
    if (KEEP) chunks.push(f);          // varsayılanda ses hiçbir yerde biriktirilmez
    send({ cmd: 'audio', data: floatToB64Int16(f) });
  });
  ipcMain.on('audio-stop', () => send({ cmd: 'stop' }));
  ipcMain.handle('audio-save', () => {
    const seconds = sampleCount / SAMPLE_RATE;
    if (KEEP) {
      const dir = recordingsDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rec-' + new Date().toISOString().replace(/[:.]/g, '-') + '.wav');
      writeWav(chunks, file);
      take.file = file;
    }
    chunks = []; sampleCount = 0;
    return { seconds };
  });
  ipcMain.on('resize-bar', (e, h, dir) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const b = win.getBounds();
    const height = Math.max(BAR_H, Math.min(Math.round(h), 470));
    expanded = height > BAR_H;
    // 'down': üst kenar sabit, aşağı büyür. 'up': alt kenar sabit, yukarı büyür.
    const y = dir === 'down' ? b.y : b.y + b.height - height;
    win.setBounds({ x: b.x, y, width: b.width, height });
  });
  if (selftest) runSnapSelftest(mainWin);
});

app.on('before-quit', () => { quitting = true; if (whisper) whisper.kill(); wipeRecordings(); });
app.on('window-all-closed', () => app.quit());

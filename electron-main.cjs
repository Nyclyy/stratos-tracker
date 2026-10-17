const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

let bridgeProcess = null;
let bridgeStartRequested = false;

// Safe mode (software rendering) for PCs where the graphics driver gives a blank window.
// Start with:  Stratos.exe --safe     (the app also switches to it by itself if the GPU crashes)
if (process.argv.includes('--safe')) app.disableHardwareAcceleration();

function note(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'stratos.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function messagePage(title, lines) {
  const html = '<!doctype html><meta charset="utf-8"><body style="background:#0b1118;color:#e6edf4;font:15px system-ui,sans-serif;padding:32px;max-width:780px">' +
    '<h2>' + esc(title) + '</h2>' + lines.map(l => '<p>' + esc(l) + '</p>').join('') +
    '<p style="color:#8696a8">Press Ctrl+Shift+I to open the developer tools.</p>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}
function listDir(d) { try { return fs.readdirSync(d).join(', '); } catch (e) { return '(cannot read: ' + e.message + ')'; } }

function bridgeIsRunning() {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const req = http.get({ hostname: '127.0.0.1', port: 8765, path: '/stream' }, res => {
      const isBridge = String(res.headers['content-type'] || '').includes('text/event-stream');
      res.destroy();
      finish(isBridge);
    });
    req.setTimeout(1500, () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
  });
}

function startBridge() {
  if (bridgeStartRequested) return;
  bridgeStartRequested = true;
  const bridgeDir = app.isPackaged ? path.join(process.resourcesPath, 'bridge') : __dirname;
  const script = path.join(bridgeDir, 'stratos_bridge.py');
  const addon = path.join(bridgeDir, 'bridge_logbook_addon.py');
  if (!fs.existsSync(script) || !fs.existsSync(addon)) {
    note('bridge files are missing from ' + bridgeDir);
    return;
  }

  const dataDir = path.join(app.getPath('userData'), 'bridge-data');
  try { fs.mkdirSync(dataDir, { recursive: true }); }
  catch (e) { note('could not create bridge data folder: ' + e.message); return; }

  bridgeIsRunning().then(alreadyRunning => {
    if (alreadyRunning) { note('bridge already running on port 8765'); return; }
    const commands = process.platform === 'win32'
      ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }, { command: 'python3', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

    const launch = index => {
      if (index >= commands.length) {
        note('could not start bridge: Python 3 was not found. Install Python 3 and relaunch Stratos.');
        return;
      }
      const item = commands[index];
      const child = spawn(item.command, item.args.concat(script), {
        cwd: bridgeDir,
        env: { ...process.env, STRATOS_DATA_DIR: dataDir },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      bridgeProcess = child;
      let spawned = false;
      let triedNext = false;
      const next = reason => {
        if (triedNext) return;
        triedNext = true;
        if (bridgeProcess === child) bridgeProcess = null;
        if (index + 1 < commands.length) launch(index + 1);
        else note('could not start bridge: ' + reason);
      };
      child.once('spawn', () => { spawned = true; note('started bridge with ' + item.command); });
      child.stdout.on('data', data => { const line = String(data).trim(); if (line) note('bridge: ' + line); });
      child.stderr.on('data', data => { const line = String(data).trim(); if (line) note('bridge error: ' + line); });
      child.once('error', err => {
        if (err.code === 'ENOENT') next(item.command + ' was not found');
        else note('could not start bridge: ' + err.message);
      });
      child.once('exit', (code, signal) => {
        if (bridgeProcess === child) bridgeProcess = null;
        if (!spawned && !triedNext) next(item.command + ' exited before it could start');
        else if (code !== 0) note('bridge stopped (code ' + code + (signal ? ', ' + signal : '') + ')');
      });
    };
    launch(0);
  }).catch(err => note('could not check bridge status: ' + err.message));
}

function stopBridge() {
  const child = bridgeProcess;
  bridgeProcess = null;
  if (!child || child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch (_) {} });
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    title: 'Stratos', backgroundColor: '#0b1118',
    icon: path.join(__dirname, 'app', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const index = path.join(__dirname, 'app', 'index.html');
  const wc = win.webContents;

  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && String(input.key).toLowerCase() === 'i'))) wc.toggleDevTools();
  });
  wc.on('console-message', (e, ...a) => {
    const level = e.level !== undefined ? e.level : a[0], msg = e.message !== undefined ? e.message : a[1];
    if (level === 'error' || level === 3 || level === 2) note('page error: ' + msg);
  });
  wc.on('render-process-gone', (e, d) => note('page process gone: ' + d.reason));
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && url && url.startsWith('file:')) win.loadURL(messagePage('Stratos could not load its page', [desc + ' (' + code + ')', url]));
  });
  // Links to other websites open in the normal browser, never inside the app window.
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });

  if (!fs.existsSync(index)) {
    note('missing ' + index);
    win.loadURL(messagePage('Stratos could not find its app files', [
      'Missing file: ' + index,
      'This installer was built without the "app" folder. Upload the whole project (including the app folder) to GitHub and build again.',
      'Files found next to the program: ' + listDir(__dirname)
    ]));
    return;
  }
  win.loadFile(index);
}

app.whenReady().then(() => {
  // The app is a local file, so web requests come from the "null" origin. Allow the public data
  // services (ADS-B traffic, map tiles, METAR) to answer it, and allow official chart PDFs to be
  // shown inside the app window instead of sending you to another site.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const h = {};
    for (const [k, v] of Object.entries(details.responseHeaders || {})) {
      const lk = k.toLowerCase();
      if (lk.startsWith('access-control-allow-') || lk === 'x-frame-options' || lk === 'content-security-policy') continue;
      h[k] = v;
    }
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['*'];
    h['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
    callback({ responseHeaders: h });
  });
  startBridge();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// If the graphics process crashes (blank window), restart once in safe mode.
app.on('child-process-gone', (e, d) => {
  if (d.type === 'GPU' && !process.argv.includes('--safe')) {
    note('GPU process gone (' + d.reason + '), restarting in safe mode');
    stopBridge();
    app.relaunch({ args: process.argv.slice(1).concat('--safe') });
    app.exit(0);
  }
});
app.on('before-quit', stopBridge);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

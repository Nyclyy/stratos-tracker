const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

// Optional at runtime: a build that somehow shipped without the dependency still
// opens, it just cannot update itself.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) { /* updates stay unavailable */ }

const BRIDGE_PORT = Number(process.env.STRATOS_HTTP_PORT || 8765);
const BRIDGE_HOST = '127.0.0.1';
const MAX_RESTARTS = 6;
const LOG_LIMIT = 120;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let bridgeChild = null;
let bridgeOwned = false;
let bridgeStarting = false;
let bridgeRestarts = 0;
let restartTimer = null;
let probeTimer = null;
let quitting = false;

const bridgeState = {
  state: 'starting',
  detail: 'Looking for the simulator bridge…',
  owned: false,
  pid: null,
  port: BRIDGE_PORT,
  version: null,
  simulator: null,
  attempts: 0,
  dataDir: '',
  log: [],
};

if (process.argv.includes('--safe')) app.disableHardwareAcceleration();
app.setAppUserModelId('com.stratos.aviationmap');

// ── Logging ──────────────────────────────────────────────────────────
function note(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'stratos.log'), line + '\n'); } catch (_) {}
  bridgeState.log.push(line);
  if (bridgeState.log.length > LOG_LIMIT) bridgeState.log.splice(0, bridgeState.log.length - LOG_LIMIT);
}

function broadcast() {
  const payload = { ...bridgeState, log: bridgeState.log.slice(-LOG_LIMIT) };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('bridge:status', payload);
  }
}

function setState(state, detail) {
  bridgeState.state = state;
  bridgeState.detail = detail || '';
  bridgeState.owned = bridgeOwned;
  bridgeState.pid = bridgeChild && bridgeChild.pid ? bridgeChild.pid : null;
  broadcast();
}

// ── Helpers ──────────────────────────────────────────────────────────
function bridgeDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'bridge') : __dirname;
}

function bridgeDataDir() {
  const dir = path.join(app.getPath('userData'), 'bridge-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function probeHealth(timeout = 1500) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const request = http.get({ hostname: BRIDGE_HOST, port: BRIDGE_PORT, path: '/health', timeout }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { if (body.length < 100000) body += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          finish(data && data.ok ? data : null);
        } catch (_) { finish(null); }
      });
    });
    request.on('timeout', () => { request.destroy(); finish(null); });
    request.on('error', () => finish(null));
  });
}

function portIsBusy() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(900, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function executableOnPath(command) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      try {
        if (fs.existsSync(path.join(dir, command + extension))) return true;
      } catch (_) {}
    }
  }
  return false;
}

function candidates() {
  const dir = bridgeDir();
  const script = path.join(dir, 'stratos_bridge.py');
  const list = [];
  const env = { ...process.env, STRATOS_HTTP_PORT: String(BRIDGE_PORT), STRATOS_HOST: BRIDGE_HOST, STRATOS_DATA_DIR: bridgeDataDir() };

  // Preferred packaged bridge: no Python installation required.
  if (process.platform === 'win32') {
    const exe = path.join(dir, 'stratos-bridge.exe');
    if (fs.existsSync(exe)) list.push({ command: exe, args: [], env, label: 'bundled bridge executable' });
  } else {
    const exe = path.join(dir, 'stratos-bridge');
    if (fs.existsSync(exe)) list.push({ command: exe, args: [], env, label: 'bundled bridge executable' });
  }

  // Optional bundled Python runtime, then a system Python installation.
  const bundledPython = process.platform === 'win32'
    ? path.join(dir, 'python', 'python.exe')
    : path.join(dir, 'python', 'bin', 'python3');
  if (fs.existsSync(bundledPython) && fs.existsSync(script)) {
    list.push({ command: bundledPython, args: ['-u', script], env, label: 'bundled Python' });
  }
  if (fs.existsSync(script)) {
    if (process.platform === 'win32') {
      if (executableOnPath('py')) list.push({ command: 'py', args: ['-3', '-u', script], env, label: 'Python (py)' });
      if (executableOnPath('python')) list.push({ command: 'python', args: ['-u', script], env, label: 'Python' });
    } else {
      if (executableOnPath('python3')) list.push({ command: 'python3', args: ['-u', script], env, label: 'Python 3' });
      if (executableOnPath('python')) list.push({ command: 'python', args: ['-u', script], env, label: 'Python' });
    }
  }
  return list;
}

// ── Bridge lifecycle ─────────────────────────────────────────────────
async function waitForHealth(timeoutMs = 22000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (quitting) return null;
    const health = await probeHealth(1200);
    if (health) return health;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function startBridge({ manual = false } = {}) {
  if (quitting) return;
  if (bridgeStarting) return;
  if (bridgeChild) {
    setState('connected', 'Bridge process is running.');
    return;
  }
  bridgeStarting = true;
  try {
    const existing = await probeHealth(1200);
    if (existing) {
      bridgeOwned = false;
      bridgeState.version = existing.version || null;
      bridgeState.simulator = existing.simulator || null;
      bridgeState.dataDir = existing.dataDir || '';
      setState('connected', 'Using a bridge that was already running.');
      return;
    }
    if (await portIsBusy()) {
      bridgeOwned = false;
      setState('error', `Port ${BRIDGE_PORT} is in use by another program. Close it or set STRATOS_HTTP_PORT before launching Stratos.`);
      return;
    }

    const options = candidates();
    if (!options.length) {
      setState('error', 'The bridge files are missing, or Python 3 is not installed. Reinstall Stratos from the official release.');
      return;
    }

    bridgeState.dataDir = bridgeDataDir();
    setState('starting', `Starting the simulator bridge (${options[0].label})…`);

    const attempt = index => {
      if (quitting) return;
      if (index >= options.length) {
        bridgeStarting = false;
        setState('error', 'The bridge could not start. Open diagnostics to see the Python error, or install Python 3 and retry.');
        return;
      }
      const item = options[index];
      let child;
      try {
        child = spawn(item.command, item.args, {
          cwd: bridgeDir(),
          env: item.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        note(`Could not launch ${item.label}: ${error.message}`);
        attempt(index + 1);
        return;
      }
      bridgeChild = child;
      bridgeOwned = true;
      let spawned = false;
      let movedOn = false;

      child.once('spawn', () => {
        spawned = true;
        bridgeRestarts = 0;
        note(`Started ${item.label} (pid ${child.pid}).`);
        setState('starting', 'Bridge started; waiting for its HTTP endpoint…');
        waitForHealth().then(health => {
          if (quitting) return;
          if (health) {
            bridgeState.version = health.version || null;
            bridgeState.simulator = health.simulator || null;
            bridgeState.dataDir = health.dataDir || bridgeState.dataDir;
            setState('connected', health.simulator && health.simulator.connected
              ? `Simulator connected (${health.simulator.source || 'telemetry'}).`
              : 'Bridge connected; waiting for the simulator.');
          } else if (child && child.exitCode === null) {
            setState('error', `The bridge is running but did not answer on 127.0.0.1:${BRIDGE_PORT}. Open diagnostics.`);
          }
        });
      });

      const capture = (stream, prefix) => {
        let buffer = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) if (line.trim()) note(`${prefix} ${line.trim()}`);
        });
      };
      capture(child.stdout, 'bridge:');
      capture(child.stderr, 'bridge!');

      child.once('error', error => {
        if (bridgeChild === child) bridgeChild = null;
        if (movedOn) return;
        movedOn = true;
        if (error.code === 'ENOENT') {
          note(`${item.label} was not found.`);
          attempt(index + 1);
        } else {
          bridgeStarting = false;
          setState('error', `Bridge launch failed: ${error.message}`);
        }
      });

      child.once('exit', (code, signal) => {
        if (bridgeChild === child) bridgeChild = null;
        bridgeOwned = false;
        const expected = quitting;
        note(`Bridge exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''}).`);
        if (expected) return;
        if (!spawned && !movedOn) {
          movedOn = true;
          attempt(index + 1);
          return;
        }
        bridgeStarting = false;
        if (bridgeRestarts >= MAX_RESTARTS) {
          setState('error', 'The bridge keeps stopping. Open diagnostics before restarting it manually.');
          return;
        }
        bridgeRestarts += 1;
        bridgeState.attempts = bridgeRestarts;
        const delay = Math.min(15000, 1200 * 2 ** (bridgeRestarts - 1));
        setState('error', `Bridge stopped unexpectedly. Restarting in ${Math.round(delay / 1000)} s…`);
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => startBridge(), delay);
      });
    };
    attempt(0);
  } finally {
    bridgeStarting = false;
  }
}

function stopBridge() {
  clearTimeout(restartTimer);
  clearInterval(probeTimer);
  const child = bridgeChild;
  bridgeChild = null;
  bridgeOwned = false;
  if (!child || child.killed || !child.pid) return;
  note(`Stopping bridge pid ${child.pid}.`);
  if (process.platform === 'win32') {
    // A synchronous tree-kill is important during app quit: an asynchronous
    // helper would die with the parent before PyInstaller's child exits.
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch (_) {
      try { child.kill(); } catch (_) {}
    }
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 4000).unref?.();
  }
}

// ── Updates ──────────────────────────────────────────────────────────
// A packaged build asks GitHub for the latest release shortly after the window
// appears, downloads in the background and installs the new version when the
// user quits. Development runs and unpacked builds never check.
function startAutoUpdate() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('error', error => note(`Update check failed: ${error && error.message ? error.message : error}`));
  autoUpdater.on('update-available', info => note(`Update ${info.version} is available; downloading in the background.`));
  autoUpdater.on('update-downloaded', info => note(`Update ${info.version} downloaded; it installs when Stratos quits.`));
  const check = () => {
    autoUpdater.checkForUpdates().catch(error => note(`Update check failed: ${error && error.message ? error.message : error}`));
  };
  // Let the map and the bridge settle first; start-up never waits on GitHub.
  setTimeout(check, 8000).unref?.();
  setInterval(check, UPDATE_INTERVAL_MS).unref?.();
}

// ── Window ───────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function messagePage(title, lines) {
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="background:#08151d;color:#e7f0f2;font:15px system-ui,sans-serif;padding:32px;max-width:780px">' +
    `<h2>${escapeHtml(title)}</h2>` + lines.map(line => `<p>${escapeHtml(line)}</p>`).join('') +
    '<p style="color:#91a8b1">Press Ctrl+Shift+I for developer tools.</p>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    title: 'Stratos',
    backgroundColor: '#08151d',
    icon: path.join(__dirname, 'app', 'icon-512.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  const window = mainWindow;
  const contents = window.webContents;
  const index = path.join(__dirname, 'app', 'index.html');

  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && String(input.key).toLowerCase() === 'i'))) {
      contents.toggleDevTools();
    }
  });
  contents.on('console-message', (event, ...legacy) => {
    const level = event.level !== undefined ? event.level : legacy[0];
    const message = event.message !== undefined ? event.message : legacy[1];
    if (level === 'error' || level === 3 || level === 2) note('page error: ' + message);
  });
  contents.on('render-process-gone', (event, details) => note('page process gone: ' + details.reason));
  contents.on('did-fail-load', (event, code, description, url, isMain) => {
    if (isMain && url && url.startsWith('file:')) {
      window.loadURL(messagePage('Stratos could not load its page', [description + ' (' + code + ')', url]));
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('data:')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (!fs.existsSync(index)) {
    window.loadURL(messagePage('Stratos could not find its app files', [
      'Missing file: ' + index,
      'This build was packaged without the app folder. Reinstall from the official release.',
    ]));
  } else {
    window.loadFile(index);
  }
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.on('did-finish-load', () => broadcast());
}

// ── IPC ──────────────────────────────────────────────────────────────
function diagnostics() {
  return {
    ...bridgeState,
    log: bridgeState.log.slice(-LOG_LIMIT),
    platform: process.platform,
    electron: process.versions.electron,
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    bridgeDir: bridgeDir(),
  };
}

ipcMain.handle('bridge:status', async () => {
  const health = await probeHealth(900);
  if (health) {
    bridgeState.version = health.version || bridgeState.version;
    bridgeState.simulator = health.simulator || bridgeState.simulator;
    bridgeState.dataDir = health.dataDir || bridgeState.dataDir;
    if (bridgeState.state !== 'connected') setState('connected', 'Bridge is reachable.');
  }
  return diagnostics();
});
ipcMain.handle('bridge:restart', async () => {
  stopBridge();
  await new Promise(resolve => setTimeout(resolve, 700));
  bridgeRestarts = 0;
  await startBridge({ manual: true });
  return { ok: true, message: 'Bridge restart requested.', state: bridgeState.state };
});
ipcMain.handle('bridge:stop', async () => {
  stopBridge();
  setState('stopped', 'Bridge stopped by the user. It will not restart until the app restarts or you press Restart.');
  return { ok: true };
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('bridge:diagnostics', () => diagnostics());

// ── App lifecycle ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // The renderer is a local file (origin "null"). Only the known public data
    // providers need CORS, and only official chart hosts may be framed.
    const corsHosts = new Set([
      'aviationweather.gov', 'adsb.fi', 'opensky-network.org', 'api.adsb.lol', 'airplanes.live',
      'ourairports.com', 'davidmegginson.github.io', 'raw.githubusercontent.com',
      'tile.openstreetmap.org', 'server.arcgisonline.com', 'overpass-api.de',
      'overpass.kumi.systems', 'overpass.private.coffee', 'simbrief.com',
      'www.simbrief.com', 'metar.vatsim.net', '127.0.0.1', 'localhost',
    ]);
    const frameHosts = new Set(['aeronav.faa.gov', 'www.faa.gov', 'chartfox.org', 'www.chartfox.org']);

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      let hostname = '';
      try { hostname = new URL(details.url).hostname; } catch (_) {}
      const headers = { ...(details.responseHeaders || {}) };
      if (corsHosts.has(hostname)) {
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Headers'] = ['Content-Type, X-Stratos-Token'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
      }
      if (frameHosts.has(hostname)) {
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'x-frame-options' || lower === 'content-security-policy') delete headers[key];
        }
      }
      callback({ responseHeaders: headers });
    });

    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      const allowed = new Set(['clipboard-sanitized-write']);
      callback(allowed.has(permission));
    });

    setState('starting', 'Starting the simulator bridge…');
    startBridge();
    createWindow();
    startAutoUpdate();
    clearInterval(probeTimer);
    probeTimer = setInterval(async () => {
      if (quitting) return;
      const health = await probeHealth(1000);
      if (health) {
        bridgeState.version = health.version || bridgeState.version;
        bridgeState.simulator = health.simulator || null;
        if (bridgeState.state !== 'connected') setState('connected', 'Bridge is reachable.');
      } else if (bridgeChild) {
        if (bridgeState.state === 'connected') setState('starting', 'Bridge process is running; waiting for a response…');
      } else if (bridgeState.state === 'connected') {
        setState('error', 'The bridge stopped responding.');
      }
    }, 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('child-process-gone', (event, details) => {
    if (details.type === 'GPU' && !process.argv.includes('--safe')) {
      note('GPU process gone (' + details.reason + '), restarting in safe mode');
      quitting = true;
      stopBridge();
      app.relaunch({ args: process.argv.slice(1).concat('--safe') });
      app.exit(0);
    }
  });
  app.on('before-quit', () => {
    quitting = true;
    stopBridge();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

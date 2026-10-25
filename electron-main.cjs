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
// The desktop app always talks to its bridge over loopback.
const BRIDGE_HOST = '127.0.0.1';
// The bridge itself must listen on the network, or no phone can ever reach it:
// a loopback-only bind makes one-tap pairing answer "reachable only on this PC"
// and leaves the phone with no route in. Requests from other hosts still need
// the bridge token or a phone pairing cookie, so listening is not the same as
// being open. STRATOS_HOST still forces a bind address when one is wanted.
const BRIDGE_BIND = process.env.STRATOS_HOST || '0.0.0.0';
const MAX_RESTARTS = 6;
const LOG_LIMIT = 120;const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A release published while Stratos is already open would otherwise wait for the
// six-hourly cycle; one extra look shortly after launch closes that gap.
const LAUNCH_RECHECK_MS = 20 * 60 * 1000;
// A verified update that was already downloaded is applied only during the first
// minutes after launch, so a running session is never restarted by a later check.
const LAUNCH_WINDOW_MS = 10 * 60 * 1000;

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
  const env = { ...process.env, STRATOS_HTTP_PORT: String(BRIDGE_PORT), STRATOS_HOST: BRIDGE_BIND, STRATOS_DATA_DIR: bridgeDataDir() };

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
//
// Settings can ask for a check on demand (no six-hour wait) and, once a build
// is downloaded, restart straight into it instead of waiting for a manual quit.
const updateState = {
  downloadedVersion: '',
  availableVersion: '',
  lastCheckedAt: '',
  // electron-updater verifies the downloaded package against the sha512 in the
  // release's latest.yml before it emits 'update-downloaded'. This flag records
  // that verification happened; it is never set optimistically.
  verified: false,
  progress: null,
  error: '',
};

// ── Update smoke test ────────────────────────────────────────────────
// The release workflow can install the previous build and launch it with
// `--update-smoke`. This path writes one JSON receipt and exits; a normal launch
// never sees it. Keeping it here means the test exercises the real updater, the
// real app-update.yml and the real published `latest.yml`, not a stand-in.
const smokeMode = app.isPackaged && process.argv.some(arg => arg === '--update-smoke' || arg.startsWith('--update-smoke='));
let smokeFile = '';
let smokeFinished = false;

function writeSmokeReceipt(payload, exitCode) {
  if (smokeFinished) return;
  smokeFinished = true;
  try { smokeFile = smokeFile || process.env.STRATOS_SMOKE_FILE || path.join(app.getPath('temp'), 'stratos-update-smoke.json'); }
  catch (_) { smokeFile = process.env.STRATOS_SMOKE_FILE || 'stratos-update-smoke.json'; }
  const receipt = {
    at: new Date().toISOString(),
    currentVersion: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    ...payload,
  };
  try {
    fs.mkdirSync(path.dirname(smokeFile), { recursive: true });
    fs.writeFileSync(smokeFile, JSON.stringify(receipt, null, 2));
    note(`Update smoke receipt: ${smokeFile}`);
    console.log(`[update-smoke] ${JSON.stringify(receipt)}`);
  } catch (error) {
    note(`Could not write the update smoke receipt: ${error && error.message ? error.message : error}`);
  }
  // The success path is shut down by quitAndInstall; only a failure exits here.
  if (exitCode != null) setTimeout(() => app.exit(exitCode), 1500);
}

function updateStatus() {
  return {
    supported: Boolean(app.isPackaged && autoUpdater),
    currentVersion: app.getVersion(),
    downloaded: Boolean(updateState.downloadedVersion),
    version: updateState.downloadedVersion || updateState.availableVersion || app.getVersion(),
    availableVersion: updateState.availableVersion,
    verified: updateState.verified,
    lastCheckedAt: updateState.lastCheckedAt,
    progress: updateState.progress,
    error: updateState.error,
    source: 'github',
  };
}

/** Send one update event to every open window; the renderer may have none. */
function broadcastUpdate(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:event', { ...updateStatus(), ...payload });
  }
}

function startAutoUpdate() {
  if (!app.isPackaged || !autoUpdater) return;
  if (smokeMode) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = console;
    autoUpdater.on('update-not-available', info => writeSmokeReceipt({
      error: 'The installed build is already the latest published version.',
      latestVersion: info && info.version ? info.version : app.getVersion(),
    }, 1));
    autoUpdater.on('update-downloaded', info => {
      const downloadedVersion = info && info.version ? info.version : 'unknown';
      updateState.downloadedVersion = downloadedVersion;
      updateState.verified = true;
      // `update-downloaded` only fires after electron-updater has checked the
      // package against latest.yml, so this receipt records a verified download.
      writeSmokeReceipt({ downloadedVersion, verified: true }, null);
      // Silent installer, no relaunch: CI checks the installed version itself.
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(true, false); } catch (_) { app.exit(0); }
      }, 700);
      setTimeout(() => app.exit(0), 15000).unref?.();
    });
    autoUpdater.on('error', error => writeSmokeReceipt({
      error: error && error.message ? error.message : String(error),
    }, 1));
    setTimeout(() => writeSmokeReceipt({ error: 'Timed out waiting for the update download.' }, 1), 6 * 60 * 1000).unref?.();
    autoUpdater.checkForUpdates().catch(error => writeSmokeReceipt({
      error: error && error.message ? error.message : String(error),
    }, 1));
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  const launchedAt = Date.now();
  // Set by any real download this run; a verified update found without one was
  // downloaded by an earlier session and is still in the updater's cache.
  let sawDownloadThisRun = false;
  autoUpdater.on('checking-for-update', () => {
    // A new check clears the previous download error, so a transient failure is
    // not shown forever.
    updateState.error = '';
    updateState.progress = null;
    broadcastUpdate({ state: 'checking' });
  });
  autoUpdater.on('error', error => {
    const message = error && error.message ? error.message : String(error);
    updateState.error = message;
    updateState.progress = { state: 'error', message };
    note(`Update check failed: ${message}`);
    broadcastUpdate({ state: 'error', message });
  });
  autoUpdater.on('update-available', info => {
    updateState.availableVersion = info && info.version ? info.version : '';
    updateState.error = '';
    updateState.progress = { state: 'available', version: updateState.availableVersion, percent: null };
    note(`Update ${updateState.availableVersion} is available; downloading in the background.`);
    broadcastUpdate({ state: 'available', version: updateState.availableVersion });
  });
  autoUpdater.on('update-not-available', () => {
    updateState.lastCheckedAt = new Date().toISOString();
    updateState.availableVersion = '';
    updateState.progress = null;
    note(`Stratos ${app.getVersion()} is the latest version.`);
    broadcastUpdate({ state: 'current' });
  });
  autoUpdater.on('download-progress', progress => {
    sawDownloadThisRun = true;
    const percent = Number(progress && progress.percent);
    updateState.progress = {
      state: 'downloading',
      percent: Number.isFinite(percent) ? percent : null,
      transferred: Number(progress?.transferred) || 0,
      total: Number(progress?.total) || 0,
      bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
    };
    // Coalesced by the renderer; this fires a handful of times a second while
    // the installer downloads and never touches the simulator.
    broadcastUpdate({ state: 'downloading' });
  });
  autoUpdater.on('update-downloaded', info => {
    updateState.downloadedVersion = info && info.version ? info.version : 'next';
    updateState.availableVersion = updateState.downloadedVersion;
    updateState.verified = true;
    updateState.lastCheckedAt = new Date().toISOString();
    updateState.progress = { state: 'downloaded', percent: 100, version: updateState.downloadedVersion };
    if (!sawDownloadThisRun && Date.now() - launchedAt < LAUNCH_WINDOW_MS) {
      // Apply on this launch: restart straight onto the new version, no prompt.
      note(`Update ${updateState.downloadedVersion} was downloaded before this launch; applying it now.`);
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(true, true); } catch (error) {
          note(`Could not apply the update at launch: ${error && error.message ? error.message : error}`);
        }
      }, 1500);
      return;
    }
    note(`Update ${updateState.downloadedVersion} downloaded and verified; it installs when Stratos quits, the next time it opens, or when you press Restart to update.`);
    broadcastUpdate({ state: 'downloaded', version: updateState.downloadedVersion });
  });
  const check = () => {
    autoUpdater.checkForUpdates()
      .then(() => { updateState.lastCheckedAt = new Date().toISOString(); })
      .catch(error => note(`Update check failed: ${error && error.message ? error.message : error}`));
  };
  // Let the map and the bridge settle first; start-up never waits on GitHub.
  setTimeout(check, 8000).unref?.();
  setTimeout(check, LAUNCH_RECHECK_MS).unref?.();
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

// ── Premium entitlement ──────────────────────────────────────────────
// The page can ask; it cannot decide. A licence is only "premium" when the
// configured licence service says so, or when this build was started with
// STRATOS_DEV_PREMIUM=1 (a clearly labelled development entitlement, not a
// purchase). No value in browser storage is ever trusted.
async function premiumStatus() {
  if (String(process.env.STRATOS_DEV_PREMIUM || '') === '1') {
    return {
      premium: true, verified: true, mode: 'development', plan: 'Development entitlement',
      expiresAt: null, reason: 'This build has no payment step; the entitlement is a development override.',
    };
  }
  // Running from source (`npm start`) is the developer's own checkout: report a
  // labelled development entitlement instead of asking for an environment
  // variable to test a feature being built. A packaged build never takes this
  // path, so a shipped installer still needs a licence or the explicit flag.
  if (!app.isPackaged) {
    return {
      premium: true, verified: true, mode: 'development', plan: 'Development build',
      expiresAt: null,
      reason: 'Running from source (npm start): development entitlement, not a purchase.',
    };
  }
  const endpoint = String(process.env.STRATOS_ENTITLEMENT_URL || '').trim();
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'entitlement.json'), 'utf8'));
  } catch (_) { /* no stored licence */ }
  if (!endpoint) {
    return {
      premium: false, verified: true, mode: 'none', plan: null, expiresAt: null,
      reason: 'No licence service is configured (STRATOS_ENTITLEMENT_URL), so a purchase cannot be verified on this device.',
    };
  }
  if (!record || typeof record.token !== 'string' || record.token.length < 8) {
    return {
      premium: false, verified: true, mode: 'none', plan: null, expiresAt: null,
      reason: 'No licence token is stored on this device.',
    };
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: record.token, product: 'stratos' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      note(`Licence check answered ${response.status}.`);
      return { premium: false, verified: true, mode: 'none', plan: null, expiresAt: null, reason: `The licence service answered ${response.status}.` };
    }
    const answer = await response.json();
    const active = answer && answer.active === true;
    note(`Licence check: ${active ? 'active' : 'not active'}.`);
    return {
      premium: active, verified: true, mode: active ? 'licence' : 'none',
      plan: (answer && answer.plan) || null, expiresAt: (answer && answer.expiresAt) || null,
      reason: active ? '' : 'The licence service reports that this licence is not active.',
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    note(`Licence check failed: ${message}`);
    return { premium: false, verified: true, mode: 'none', plan: null, expiresAt: null, reason: `The licence service could not be reached: ${message}` };
  }
}

ipcMain.handle('premium:status', () => premiumStatus());
ipcMain.handle('updater:status', () => updateStatus());
ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged || !autoUpdater) return { ...updateStatus(), available: false, supported: false };
  if (updateState.downloadedVersion) return { ...updateStatus(), available: true };
  updateState.error = '';
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result && result.updateInfo ? result.updateInfo.version : '';
    // electron-updater resolves with the running version when nothing is
    // published; comparing semantically keeps a stale manifest from looking new.
    const available = Boolean(version) && version !== app.getVersion();
    updateState.availableVersion = available ? version : '';
    updateState.lastCheckedAt = new Date().toISOString();
    if (!available) {
      note(`Stratos ${app.getVersion()} is the latest version.`);
      broadcastUpdate({ state: 'current' });
    }
    return { ...updateStatus(), available, version: version || app.getVersion() };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    updateState.error = message;
    note(`Update check failed: ${message}`);
    return { ...updateStatus(), available: false, error: message };
  }
});
ipcMain.handle('updater:install', () => {
  if (!app.isPackaged || !autoUpdater || !updateState.downloadedVersion) {
    return { ok: false, message: 'No downloaded update is ready to install yet.' };
  }
  note('Restarting to install the downloaded update.');
  // Defer the restart so this reply reaches the renderer before the app quits.
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

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
    // A smoke run is headless: no bridge, no window, just the updater and its
    // receipt. It must never start a second bridge on a developer machine.
    if (smokeMode) {
      if (!autoUpdater) {
        writeSmokeReceipt({ error: 'electron-updater is not available in this build.' }, 1);
        return;
      }
      startAutoUpdate();
      return;
    }

    // The renderer is a local file (origin "null"). Only the known public data
    // providers need CORS; charts arrive through the loopback bridge.
    const corsHosts = new Set([
      'aviationweather.gov', 'adsb.fi', 'api.adsb.one', 'api.adsb.lol', 'airplanes.live',
      'opensky-network.org', 'data.vatsim.net', 'hexdb.io',
      'ourairports.com', 'davidmegginson.github.io', 'raw.githubusercontent.com',
      'tile.openstreetmap.org', 'server.arcgisonline.com', 'overpass-api.de',
      'overpass.kumi.systems', 'overpass.private.coffee', 'simbrief.com',
      'www.simbrief.com', 'metar.vatsim.net', '127.0.0.1', 'localhost',
    ]);
    // Charts are rendered by the bundled pdf.js from bytes fetched through the
    // bridge, so no third-party site is framed any more.

    // The photo API refuses a browser User-Agent and asks for an application
    // name with a contact URL. A page cannot set that header, and the renderer
    // is the browser here, so the main process supplies it for that host only.
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      let hostname = '';
      try { hostname = new URL(details.url).hostname; } catch (_) {}
      const requestHeaders = { ...(details.requestHeaders || {}) };
      if (hostname === 'api.planespotters.net') {
        requestHeaders['User-Agent'] = `Stratos/${app.getVersion()} (+https://github.com/Nyclyy/stratos-tracker)`;
      }
      callback({ requestHeaders });
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      let hostname = '';
      try { hostname = new URL(details.url).hostname; } catch (_) {}
      const headers = { ...(details.responseHeaders || {}) };
      if (corsHosts.has(hostname)) {
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Headers'] = ['Content-Type, X-Stratos-Token'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
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

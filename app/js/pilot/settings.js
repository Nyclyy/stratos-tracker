import { RESOURCE_MODES, detectResourceMode } from '../lib/telemetry.js';
import { getSetting, setSetting, exportBackup, importBackup, getAllSettings, getFlights, downloadJson } from '../lib/store.js';
import {
  bridgeHealth, syncLogbook, saveAircraftIdentity, relayStatus, pairRelay, unpairRelay,
  relayDevices, revokeRelayDevice, defaultBridgeBase, isHostedPage,
} from '../bridge.js';
import { esc, fmtDateTime, relTime, toast, pickFile, currentTheme, setTheme, tag } from '../ui.js';

export async function mount(root, ctx) {
  let mode = (await getSetting('resourceMode', detectResourceMode()).catch(() => detectResourceMode())) || 'normal';
  if (!RESOURCE_MODES[mode]) mode = 'normal';
  let health = ctx.health;
  let relay = null;
  let devices = [];
  let busy = false;
  let relayUrl = 'https://';
  let identity = health?.identity || { aircraft: '', registration: '', callsign: '' };
  let message = '';
  let desktopStatus = null;
  let diagnostics = null;
  const desktop = window.stratosDesktop || null;

  async function refreshBridge() {
    busy = true;
    render();
    try {
      health = await bridgeHealth(defaultBridgeBase(), 3500);
      identity = health.identity || identity;
      message = 'Bridge status refreshed.';
    } catch (error) {
      message = error.name === 'BridgeAuthError'
        ? 'The bridge is running but this browser is not unlocked. Open the bridge URL and enter its access token.'
        : `Bridge not reachable: ${error.message}`;
      if (desktop) {
        try { desktopStatus = await desktop.getStatus(); } catch (_) { desktopStatus = null; }
      }
    }
    busy = false;
    render();
  }

  async function refreshRelay() {
    try {
      relay = await relayStatus(defaultBridgeBase());
      if (relay.configured) {
        devices = await relayDevices(defaultBridgeBase()).then(data => data.devices || []).catch(() => []);
      } else {
        devices = [];
      }
    } catch (error) {
      relay = { configured: false, lastError: error.message };
      devices = [];
    }
    render();
  }

  async function doPair() {
    if (isHostedPage()) { message = 'Relay pairing must be started from the Stratos desktop app on your PC. Open this page from the desktop app or the bridge address.'; render(); return; }
    if (!relayUrl || !/^https?:\/\//.test(relayUrl)) { toast('Enter the relay URL, for example https://your-relay.onrender.com', 'bad'); return; }
    busy = true;
    render();
    try {
      const result = await pairRelay(relayUrl.replace(/\/+$/, ''), 'Stratos desktop');
      message = `Pairing code ${result.code} — valid until ${new Date(result.expiresAt).toLocaleTimeString()}. Enter it in the phone dashboard.`;
      toast('Pairing code generated.', 'good');
    } catch (error) {
      message = `Pairing failed: ${error.message}`;
      toast(message, 'bad');
    }
    busy = false;
    await refreshRelay();
  }

  function render() {
    const sim = health && health.simulator;
    const bridgeOk = !!health;
    const modeInfo = RESOURCE_MODES[mode];
    root.innerHTML = `
      <div class="page-head">
        <div><h1>Settings</h1><p>Everything here is stored on this device unless stated otherwise. No account is required.</p></div>
      </div>

      <div class="section-title"><h2>Appearance and performance</h2></div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>Theme</h2></div>
          <div class="segmented" role="group" aria-label="Theme">
            <button data-theme="night" aria-pressed="${currentTheme() === 'night'}">Night</button>
            <button data-theme="day" aria-pressed="${currentTheme() === 'day'}">Day</button>
          </div>
          <p class="help" style="margin-top:10px">The map, logbook and pilot pages share the theme stored in this browser.</p>
        </div>
        <div class="card">
          <div class="card-head"><h2>Resource profile</h2><span class="spacer"></span>${tag(modeInfo.name, 'accent')}</div>
          <p class="small muted" style="margin-bottom:10px">Recording and logging are never reduced. Only display and polling rates change.</p>
          <div class="stack">
            ${Object.values(RESOURCE_MODES).map(profile => `<label class="row" style="align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid ${profile.key === mode ? 'var(--acc)' : 'var(--coast)'};border-radius:10px;cursor:pointer">
              <input type="radio" name="resource-mode" value="${profile.key}" ${profile.key === mode ? 'checked' : ''} style="margin-top:4px">
              <span><strong>${esc(profile.name)}</strong><br><span class="muted small">${esc(profile.description)}</span></span>
            </label>`).join('')}
          </div>
        </div>
      </div>

      <div class="section-title"><h2>Simulator bridge</h2><span class="hint">Runs on this PC, not in the cloud</span></div>
      <div class="grid grid-main">
        <div class="card">
          <div class="card-head">
            <h2>Connection</h2><span class="spacer"></span>
            ${bridgeOk ? `<span class="status-inline"><i class="dot ${sim?.connected ? 'dot-connected' : 'dot-waiting'}"></i>${sim?.connected ? esc(sim.source || 'Simulator') : 'Waiting for simulator'}</span>` : '<span class="status-inline"><i class="dot dot-disconnected"></i>Bridge offline</span>'}
          </div>
          ${bridgeOk ? `<dl class="kv">
            <dt>Bridge version</dt><dd>${esc(health.version)} · up ${Math.round(health.uptimeSeconds / 60)} min</dd>
            <dt>Telemetry</dt><dd>${sim?.connected ? `${esc(sim.source)} · ${sim.ageSeconds != null ? `${sim.ageSeconds.toFixed(1)} s old` : 'live'}` : 'No simulator data yet'}</dd>
            <dt>X-Plane UDP</dt><dd>${health.xplane?.ready ? `listening on ${health.ports.udp}` : esc(health.xplane?.error || 'not listening')}</dd>
            <dt>MSFS connector</dt><dd>${health.msfs?.available ? (health.msfs.connected ? 'connected' : 'installed, waiting for a flight') : 'not installed (optional)'}</dd>
            <dt>Airports</dt><dd>${health.airports ? `${health.airports.toLocaleString()} loaded` : 'still loading'}</dd>
            <dt>FAA charts</dt><dd>${health.faaCharts ? `${health.faaCharts.toLocaleString()} airports` : 'not loaded'}</dd>
            <dt>Bridge logbook</dt><dd>${health.logbook?.flights || 0} flights · ${health.logbook?.hours || 0} h</dd>
            <dt>Data folder</dt><dd class="mono">${esc(health.dataDir)}</dd>
            ${desktop ? `<dt>Desktop supervisor</dt><dd>${esc(desktopStatus ? `${desktopStatus.state}${desktopStatus.owned ? ' · started by Stratos' : ''}` : 'available')}</dd>` : ''}
          </dl>` : ''}
          <div class="btn-row" style="margin-top:12px">
            <button class="btn" id="refresh-bridge" ${busy ? 'disabled' : ''}>Refresh status</button>
            <button class="btn" id="sync-logbook">Import bridge flights</button>
            ${desktop ? '<button class="btn ghost" id="restart-bridge">Restart bridge</button><button class="btn ghost" id="bridge-diagnostics">Diagnostics</button>' : ''}
            <a class="btn ghost" href="${esc(defaultBridgeBase())}" target="_blank" rel="noopener">Open bridge</a>
          </div>
          ${desktop && desktopStatus ? `<div class="notice ${desktopStatus.state === 'error' ? 'bad' : ''}" style="margin-top:10px"><div><strong>Desktop supervisor:</strong> ${esc(desktopStatus.detail || desktopStatus.state)}</div></div>` : ''}
          ${diagnostics ? `<details open style="margin-top:10px"><summary>Bridge diagnostics</summary><pre class="mono" style="max-height:260px;overflow:auto;white-space:pre-wrap;font-size:11px">${esc(diagnostics)}</pre></details>` : ''}
          <div class="notice" style="margin-top:12px">
            <div><strong>Setup.</strong><br>
            X-Plane 11/12: Settings → Data Output, tick “Network via UDP” for rows 3, 17 and 20, send to this PC on port ${health?.ports?.udp || 49003}.<br>
            MSFS 2020/2024: run <code>pip install SimConnect</code> once (optional connector), then start a flight.<br>
            The bridge is started automatically by the Stratos desktop app. If you run it manually, <code>python stratos_bridge.py</code>.
            </div>
          </div>
          ${message ? `<div class="notice" style="margin-top:10px">${esc(message)}</div>` : ''}
        </div>

        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>Aircraft identity</h2></div>
            <p class="help" style="margin-bottom:10px">X-Plane's data output does not send aircraft type. Set it here so landing ratings use the right aircraft class. MSFS supplies its own title when available.</p>
            <div class="field"><label for="id-aircraft">Aircraft type</label><input class="input" id="id-aircraft" value="${esc(identity.aircraft || '')}" placeholder="e.g. B738, C172, TBM 930"></div>
            <div class="field" style="margin-top:8px"><label for="id-registration">Registration</label><input class="input" id="id-registration" value="${esc(identity.registration || '')}" placeholder="e.g. N12345"></div>
            <div class="field" style="margin-top:8px"><label for="id-callsign">Callsign</label><input class="input" id="id-callsign" value="${esc(identity.callsign || '')}" placeholder="e.g. STR123"></div>
            <button class="btn primary" id="save-identity" style="margin-top:10px" ${bridgeOk ? '' : 'disabled'}>Save to bridge</button>
            ${bridgeOk ? '' : '<p class="help" style="margin-top:8px">Start the bridge to save identity settings.</p>'}
          </div>
          <div class="card">
            <div class="card-head"><h2>Access token</h2></div>
            <p class="help">Requests from this PC are trusted. Other devices on your network must enter the bridge token once. The token is stored in <code>${esc(health?.dataDir || 'the bridge data folder')}/bridge_token.txt</code> and printed when the bridge starts.</p>
            <div class="btn-row" style="margin-top:10px"><a class="btn small" href="${esc(defaultBridgeBase())}" target="_blank" rel="noopener">Open unlock page</a></div>
          </div>
        </div>
      </div>

      <div class="section-title"><h2>Phone access</h2><span class="hint">Live telemetry without exposing your PC</span></div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>Relay pairing</h2><span class="spacer"></span>${relay?.configured ? tag('paired', 'good') : tag('not paired', 'muted')}</div>
          <p class="help" style="margin-bottom:10px">The relay receives snapshots pushed by this PC and serves them to your phone with a separate read token. It never accepts commands for your PC.</p>
          ${relay?.configured ? `<dl class="kv">
            <dt>Relay</dt><dd class="mono">${esc(relay.url)}</dd>
            <dt>Current code</dt><dd class="mono" style="font-size:16px;letter-spacing:.12em">${esc(relay.code || '—')}</dd>
            <dt>Code expires</dt><dd>${relay.expiresAt ? esc(new Date(relay.expiresAt).toLocaleTimeString()) : '—'}</dd>
            <dt>Last push</dt><dd>${relay.lastPushAt ? esc(relTime(relay.lastPushAt)) : 'not yet'}</dd>
            <dt>Phones</dt><dd>${devices.length}</dd>
          </dl>
          ${relay.lastError ? `<div class="notice bad" style="margin-top:10px">${esc(relay.lastError)}</div>` : ''}
          <div class="btn-row" style="margin-top:10px">
            <button class="btn small" id="refresh-relay">Refresh</button>
            <button class="btn small danger" id="unpair-relay">Disconnect relay</button>
            <a class="btn small primary" href="live.html?relay=${encodeURIComponent(relay.url)}&code=${encodeURIComponent(relay.code || '')}">Open phone dashboard</a>
          </div>` : `
          <div class="field"><label for="relay-url">Relay URL</label>
            <input class="input" id="relay-url" value="${esc(relayUrl)}" placeholder="https://your-relay.example.com"></div>
          <div class="btn-row" style="margin-top:10px"><button class="btn primary" id="pair-relay" ${bridgeOk ? '' : 'disabled'}>Generate pairing code</button>
            <button class="btn small ghost" id="refresh-relay">Check status</button></div>
          <p class="help" style="margin-top:8px">Deploy the small relay from <code>relay/server.mjs</code> (free tiers on Render/Fly work) and enter its HTTPS URL. Pairing codes expire after 5 minutes.</p>`}
        </div>
        <div class="card">
          <div class="card-head"><h2>Paired phones</h2><span class="spacer"></span><span class="tag">${devices.length}</span></div>
          ${devices.length ? `<div class="list">${devices.map(device => `<div class="list-item">
            <div class="main"><div class="title">${esc(device.label || 'Phone')}</div>
              <div class="sub">paired ${esc(relTime(device.createdAt))} · expires ${esc(fmtDateTime(device.expiresAt))}</div></div>
            <button class="btn small danger" data-revoke="${esc(device.id)}">Disconnect</button>
          </div>`).join('')}</div>` : '<p class="muted small">No phone has claimed a pairing code yet.</p>'}
          <p class="help" style="margin-top:10px">Disconnecting a phone revokes its read token immediately. “Disconnect relay” removes the whole session.</p>
        </div>
      </div>

      <div class="section-title"><h2>Data</h2></div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>Backup and restore</h2></div>
          <p class="help">Exports flights, saved routes, dashboard settings and profile from this browser as JSON. Nothing is uploaded.</p>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn" id="export-backup">Export backup</button>
            <button class="btn ghost" id="import-backup">Import backup</button>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>iPhone installation</h2></div>
          <ol class="help" style="padding-left:18px;line-height:1.7">
            <li>Open the Stratos site in <b>Safari</b>.</li>
            <li>Tap Share → <b>Add to Home Screen</b>.</li>
            <li>Open the installed app and go to <b>Live</b>, then enter your pairing code.</li>
          </ol>
          <p class="help" style="margin-top:8px">iOS may suspend the web app when it is in the background; live data resumes when you return. Notifications are not guaranteed by iOS for web apps.</p>
          <div class="btn-row" style="margin-top:10px"><button class="btn small ghost" id="check-update">Check for updates</button>
            <a class="btn small" href="live.html">Open phone dashboard</a></div>
        </div>
      </div>

      <div class="section-title"><h2>About</h2></div>
      <div class="card">
        <div class="row"><strong>Stratos</strong><span class="tag">v2.1.13</span></div>
        <p class="help" style="margin-top:8px">Independent flight-simulation companion. Map data © OpenStreetMap contributors. Airports: OurAirports (CC0). Weather: NOAA Aviation Weather Center (public domain). Charts: FAA Digital Terminal Procedures (U.S. Government work, public domain) fetched from the publishing authority. Licensed providers such as Jeppesen are never bundled, and Premium does not grant redistribution rights.</p>
        <p class="help" style="margin-top:6px">Not for real-world navigation. No analytics or personal data are collected by the app itself.</p>
      </div>
    `;

    // Narrow to the theme buttons: <html data-theme="…"> also matches a bare
    // [data-theme] selector, which made every click in Settings fall through to
    // the document element and re-render the whole page.
    document.querySelectorAll('button[data-theme]').forEach(button => button.addEventListener('click', () => {
      setTheme(button.dataset.theme);
      render();
    }));
    document.querySelectorAll('input[name="resource-mode"]').forEach(input => input.addEventListener('change', async () => {
      mode = input.value;
      try { localStorage.setItem('stratos.resourceMode', mode); } catch (_) {}
      await setSetting('resourceMode', mode);
      window.StratosPilot?.setResourceMode(mode);
      toast(`Resource profile: ${RESOURCE_MODES[mode].name}.`, 'good');
      render();
    }));
    document.getElementById('refresh-bridge')?.addEventListener('click', refreshBridge);
    document.getElementById('restart-bridge')?.addEventListener('click', async () => {
      try {
        const result = await window.stratosDesktop.restartBridge();
        message = result?.message || 'Bridge restart requested.';
      } catch (error) { message = `Restart failed: ${error.message}`; }
      diagnostics = null;
      await new Promise(resolve => setTimeout(resolve, 800));
      await refreshBridge();
    });
    document.getElementById('bridge-diagnostics')?.addEventListener('click', async () => {
      try {
        const info = await window.stratosDesktop.getDiagnostics();
        desktopStatus = info;
        diagnostics = [
          `State: ${info.state} (${info.detail || 'no detail'})`,
          `Owned by Stratos: ${info.owned} · PID: ${info.pid || '—'} · port ${info.port}`,
          `Version: ${info.version || '—'} · packaged: ${info.packaged} · Electron ${info.electron}`,
          `Bridge directory: ${info.bridgeDir}`,
          `Data directory: ${info.dataDir || '—'}`,
          '',
          ...(info.log || []),
        ].join('\n');
      } catch (error) {
        diagnostics = `Could not read diagnostics: ${error.message}`;
      }
      render();
    });
    document.getElementById('sync-logbook')?.addEventListener('click', async () => {
      busy = true;
      render();
      try {
        const result = await syncLogbook(defaultBridgeBase());
        message = `Imported ${result.added} new flight${result.added === 1 ? '' : 's'}; ${result.total} records in the local logbook.`;
        await ctx.reload();
      } catch (error) {
        message = `Import failed: ${error.message}`;
      }
      busy = false;
      await refreshBridge();
    });
    document.getElementById('save-identity')?.addEventListener('click', async () => {
      const next = {
        aircraft: document.getElementById('id-aircraft').value.trim(),
        registration: document.getElementById('id-registration').value.trim(),
        callsign: document.getElementById('id-callsign').value.trim(),
      };
      try {
        await saveAircraftIdentity(next);
        identity = next;
        message = 'Aircraft identity saved to the bridge.';
        toast('Saved.', 'good');
      } catch (error) {
        message = `Could not save: ${error.message}`;
      }
      render();
    });
    document.getElementById('pair-relay')?.addEventListener('click', doPair);
    document.getElementById('refresh-relay')?.addEventListener('click', refreshRelay);
    document.getElementById('relay-url')?.addEventListener('input', event => { relayUrl = event.target.value.trim(); });
    document.getElementById('unpair-relay')?.addEventListener('click', async () => {
      if (!confirm('Disconnect the relay? All paired phones lose access.')) return;
      try {
        await unpairRelay(defaultBridgeBase());
        relay = { configured: false };
        devices = [];
        toast('Relay disconnected.');
      } catch (error) { toast(error.message, 'bad'); }
      render();
    });
    document.querySelectorAll('[data-revoke]').forEach(button => button.addEventListener('click', async () => {
      try {
        await revokeRelayDevice(button.dataset.revoke, defaultBridgeBase());
        devices = devices.filter(device => device.id !== button.dataset.revoke);
        toast('Phone disconnected.');
      } catch (error) { toast(error.message, 'bad'); }
      render();
    }));
    document.getElementById('export-backup')?.addEventListener('click', async () => {
      const flights = await getFlights();
      const settings = await getAllSettings();
      const data = await exportBackup({ profile: settings.profile || null });
      downloadJson(`stratos-backup-${new Date().toISOString().slice(0, 10)}.json`, { ...data, flights, settings });
      toast('Backup downloaded.', 'good');
    });
    document.getElementById('import-backup')?.addEventListener('click', async () => {
      const file = await pickFile('application/json,.json');
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const result = await importBackup(data);
        toast(`Backup imported: ${result.total} flights in the local logbook.`, 'good');
        await ctx.reload();
      } catch (error) {
        toast(`Import failed: ${error.message}`, 'bad');
      }
    });
    // Inside the desktop app the same button drives the real updater: it checks
    // on demand and, once a build is downloaded, restarts straight into it
    // instead of waiting for the next quit. In the browser it still refreshes
    // the service worker.
    const updateButton = document.getElementById('check-update');
    const labelUpdateButton = status => {
      if (!updateButton || !status?.downloaded) return;
      updateButton.textContent = `Restart to update to v${status.version}`;
    };
    if (desktop?.getUpdateStatus) {
      desktop.getUpdateStatus()
        .then(status => { if (status?.supported) labelUpdateButton(status); })
        .catch(() => { /* the button still checks on demand */ });
    }
    updateButton?.addEventListener('click', async () => {
      try {
        if (desktop?.checkForUpdates) {
          const status = await desktop.getUpdateStatus();
          if (status?.downloaded && desktop.installUpdate) {
            await desktop.installUpdate();
            toast('Restarting to install the update…');
            return;
          }
          const result = await desktop.checkForUpdates();
          if (!result?.supported) {
            toast('Automatic updates apply to the installed Windows app, not this browser build.');
            return;
          }
          if (result.downloaded) {
            labelUpdateButton(result);
            toast(`Stratos v${result.version} is ready. Restart to install it.`, 'good');
            return;
          }
          if (result.available) {
            toast(`Downloading Stratos v${result.version} in the background. It installs when you quit or press Restart to update.`, 'good');
            return;
          }
          toast(`Stratos v${result.currentVersion} is the latest version.`, 'good');
          return;
        }
        const registration = await navigator.serviceWorker?.getRegistration();
        if (!registration) { toast('No service worker is active on this page.'); return; }
        await registration.update();
        toast('Update check complete. New versions load on the next visit.');
      } catch (error) {
        toast(`Update check failed: ${error.message}`, 'bad');
      }
    });
  }

  render();
  if (!health) refreshBridge();
  refreshRelay();
  return { destroy() { root.innerHTML = ''; } };
}

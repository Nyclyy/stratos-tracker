/* EFB · Settings.
 *
 * Preferences that apply across the whole bag, the SimBrief connection the EFB
 * shares with the tracker, the live-tracking state, the offline chart cache, and
 * an honest data-source list. Nothing here stores a credential the app could not
 * already use: the SimBrief Pilot ID is a plan identifier, not a password.
 */

import {
  connectionText, currentPlan, esc, fmtAge, forgetPlan, onLive, onPlanChange,
  refreshPlan, savePrefs,
} from './common.js';
import { chartCacheSize, clearChartCache } from '../lib/charts.js';
import { defaultBridgeBase, bridgeHealth } from '../bridge.js';
import { APP_VERSION, displayVersion } from '../lib/version.js';
import { EFB_AIRCRAFT, aircraftLabel } from '../data/efb-aircraft.js';

const WALLPAPERS = [
  { key: 'aurora', label: 'Aurora', css: 'linear-gradient(135deg,#0b1c3a,#101a2e 50%,#1b1030)' },
  { key: 'midnight', label: 'Midnight', css: 'linear-gradient(135deg,#040a16,#0a1426 60%,#061020)' },
  { key: 'horizon', label: 'Horizon', css: 'linear-gradient(135deg,#06202b,#0a2a3a 55%,#062018)' },
  { key: 'graphite', label: 'Graphite', css: 'linear-gradient(135deg,#12161d,#1c222b 60%,#0b0e12)' },
];

function bytesLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

export async function mount(root, ctx) {
  let destroyed = false;
  let prefs = ctx.prefs();
  let plan = currentPlan();
  let status = { status: 'offline', detail: '' };
  let health = null;
  let cacheBytes = null;
  let cacheBusy = false;
  let planMessage = '';

  root.innerHTML = '<div class="e-loading"><i></i>Reading preferences…</div>';

  const options = EFB_AIRCRAFT.flatMap(type => type.variants.map(variant => ({
    value: variant.icao,
    label: `${type.name} · ${variant.label}`,
  })));

  async function measureCache() {
    cacheBusy = true;
    render();
    cacheBytes = await chartCacheSize().catch(() => 0);
    cacheBusy = false;
    render();
  }

  async function checkBridge() {
    health = await bridgeHealth(defaultBridgeBase(), 2500).catch(() => null);
    render();
  }

  function render() {
    if (destroyed) return;
    prefs = ctx.prefs();
    const ofp = plan && plan.ofp;
    const liveTone = status.status === 'live' ? 'good' : status.status === 'connecting' || status.status === 'waiting' ? 'warn' : 'bad';
    root.innerHTML = `
      <div class="e-grid two" style="align-items:start">
        <div>
          <div class="e-card">
            <h3>Aircraft</h3>
            <div class="e-field">
              <label for="set-aircraft">Default variant</label>
              <select class="e-select" id="set-aircraft">
                <option value="">Not selected</option>
                ${options.map(option => `<option value="${esc(option.value)}" ${prefs.aircraft === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
              </select>
              <span class="e-hint">${prefs.aircraft ? esc(aircraftLabel(prefs.aircraft)) : 'Used by Performance and Weight & Balance as their starting type.'}</span>
            </div>
            <div class="set-row">
              <div class="set-main"><b>Weight unit</b><span>Applies to briefing, fuel, weights and performance.</span></div>
              <div class="set-control">
                <div class="e-seg" role="group" aria-label="Weight unit">
                  <button type="button" data-unit="kg" aria-pressed="${prefs.units !== 'lb'}">kg</button>
                  <button type="button" data-unit="lb" aria-pressed="${prefs.units === 'lb'}">lb</button>
                </div>
              </div>
            </div>
            <div class="set-row">
              <div class="set-main"><b>Motion</b><span>Turn off the home-screen and app transitions.</span></div>
              <div class="set-control">
                <div class="e-seg" role="group" aria-label="Motion">
                  <button type="button" data-motion="full" aria-pressed="${prefs.motion !== 'reduced'}">Full</button>
                  <button type="button" data-motion="reduced" aria-pressed="${prefs.motion === 'reduced'}">Reduced</button>
                </div>
              </div>
            </div>
            <div class="set-row">
              <div class="set-main"><b>Wallpaper</b><span>The home screen background.</span></div>
              <div class="set-control">
                <div class="wallpaper-swatches">
                  ${WALLPAPERS.map(wall => `<button type="button" data-wall="${wall.key}" aria-pressed="${prefs.wallpaper === wall.key}" title="${esc(wall.label)}" style="background:${wall.css}"></button>`).join('')}
                </div>
              </div>
            </div>
          </div>

          <div class="e-card" style="margin-top:12px">
            <h3>SimBrief</h3>
            <div class="e-field">
              <label for="set-simbrief">Pilot ID or username</label>
              <input class="e-input" id="set-simbrief" value="${esc(prefs.simbriefId || (plan && plan.simbriefId) || '')}" autocomplete="off" spellcheck="false" placeholder="e.g. 123456">
              <span class="e-hint">The same identifier the Flight Deck stores. Nothing is uploaded except the request for your plan.</span>
            </div>
            <div class="e-row" style="margin-top:9px">
              <button class="e-btn small primary" type="button" data-save-simbrief>Save and fetch</button>
              <button class="e-btn small ghost" type="button" data-forget-plan>Remove stored plan</button>
            </div>
            <div class="e-small ${planMessage || (plan && plan.error) ? '' : 'e-faint'}" style="margin-top:8px" role="status">
              ${planMessage ? esc(planMessage) : plan && plan.error ? esc(plan.error) : ofp
                ? `Plan for ${esc((ofp.origin && ofp.origin.icao) || '????')} → ${esc((ofp.destination && ofp.destination.icao) || '????')} imported ${esc(fmtAge(ofp.fetchedAt))}.`
                : 'No plan imported yet.'}
            </div>
          </div>
        </div>

        <div>
          <div class="e-card">
            <h3>Live tracking <span class="e-spacer"></span><span class="e-badge ${liveTone}">${esc(connectionText(status.status))}</span></h3>
            <dl class="e-kv">
              <dt>Bridge</dt><dd>${health ? `${esc(health.version || 'running')}${health.host ? ` · ${esc(health.host)}` : ''}` : 'not reachable'}</dd>
              <dt>Simulator</dt><dd>${health && health.simulator && health.simulator.connected ? esc(health.simulator.source || 'connected') : 'not detected'}</dd>
              <dt>Detail</dt><dd style="font-weight:500">${esc(status.detail || (status.status === 'live' ? 'receiving telemetry' : 'no telemetry'))}</dd>
            </dl>
            <div class="e-row" style="margin-top:10px">
              <button class="e-btn small" type="button" data-check-bridge>Check bridge</button>
              <a class="e-btn small ghost" href="pilot.html#settings">Phone relay settings ↗</a>
            </div>
            <div class="e-small e-faint" style="margin-top:8px">The EFB reads the bridge directly on this PC. A hosted page needs the relay, configured in the tracker's Settings.</div>
          </div>

          <div class="e-card" style="margin-top:12px">
            <h3>Weather and charts</h3>
            <dl class="e-kv">
              <dt>Weather source</dt><dd>NOAA Aviation Weather Center</dd>
              <dt>Charts</dt><dd>FAA d-TPP (public domain)</dd>
              <dt>Other regions</dt><dd>Official publisher links only</dd>
            </dl>
            <div class="e-small e-faint" style="margin-top:6px">No alternative weather provider is configured, so none is offered. Integrated charts cover the FAA's publications; elsewhere Stratos links the publisher instead of scraping it.</div>
            <div class="set-row" style="margin-top:8px">
              <div class="set-main"><b>Chart cache</b><span>${cacheBusy ? 'Measuring…' : cacheBytes == null ? 'Measure the documents stored for offline use.' : `${bytesLabel(cacheBytes)} stored on this device.`}</span></div>
              <div class="set-control">
                <div class="e-row" style="justify-content:flex-end">
                  <button class="e-btn small" type="button" data-measure-cache>Measure</button>
                  <button class="e-btn small ghost" type="button" data-clear-cache>Clear</button>
                </div>
              </div>
            </div>
          </div>

          <div class="e-card" style="margin-top:12px">
            <h3>About</h3>
            <dl class="e-kv">
              <dt>Stratos EFB</dt><dd>${esc(displayVersion(APP_VERSION))}</dd>
              <dt>Tracker</dt><dd><a href="index.html">Flight Deck</a> · <a href="logbook.html">Logbook</a> · <a href="discover.html">Explore</a></dd>
              <dt>Data</dt><dd style="font-weight:500;text-align:right">SimBrief plans, NOAA weather, OurAirports, FAA d-TPP, VATSIM/ADS-B traffic, the simulator through the bridge</dd>
            </dl>
            <div class="e-notice" style="margin-top:10px">Simulator companion. Performance figures are only shown from a dataset you import; nothing here is approved for real-world flight.</div>
            <div class="e-row" style="margin-top:10px">
              <button class="e-btn small ghost" type="button" data-reset-prefs>Reset EFB preferences</button>
            </div>
          </div>
        </div>
      </div>`;

    root.querySelector('#set-aircraft').addEventListener('change', event => {
      ctx.setPrefs({ aircraft: event.target.value });
    });
    root.querySelectorAll('[data-unit]').forEach(button => {
      button.addEventListener('click', () => { ctx.setPrefs({ units: button.dataset.unit }); render(); });
    });
    root.querySelectorAll('[data-motion]').forEach(button => {
      button.addEventListener('click', () => { ctx.setPrefs({ motion: button.dataset.motion }); render(); });
    });
    root.querySelectorAll('[data-wall]').forEach(button => {
      button.addEventListener('click', () => { ctx.setPrefs({ wallpaper: button.dataset.wall }); render(); });
    });
    root.querySelector('[data-save-simbrief]').addEventListener('click', async event => {
      const id = root.querySelector('#set-simbrief').value.trim();
      if (!id) { planMessage = 'Enter your SimBrief Pilot ID or username.'; render(); return; }
      event.currentTarget.disabled = true;
      planMessage = 'Asking SimBrief…';
      render();
      savePrefs({ simbriefId: id });
      const next = await refreshPlan(id);
      if (destroyed) return;
      plan = next;
      planMessage = next.error || 'Plan imported.';
      render();
    });
    root.querySelector('[data-forget-plan]').addEventListener('click', () => {
      forgetPlan();
      plan = currentPlan();
      planMessage = 'The stored plan was removed from this device.';
      render();
    });
    root.querySelector('[data-check-bridge]').addEventListener('click', checkBridge);
    root.querySelector('[data-measure-cache]').addEventListener('click', measureCache);
    root.querySelector('[data-clear-cache]').addEventListener('click', async () => {
      await clearChartCache();
      cacheBytes = 0;
      render();
    });
    root.querySelector('[data-reset-prefs]').addEventListener('click', () => {
      ctx.setPrefs({ units: 'kg', wallpaper: 'aurora', motion: 'full', aircraft: '' });
      render();
    });
  }

  const offLive = onLive(next => {
    status = next;
    if (!destroyed) render();
  });
  const offPlan = onPlanChange(next => {
    plan = next;
    if (!destroyed) render();
  });

  render();
  checkBridge();

  return {
    destroy() {
      destroyed = true;
      offLive();
      offPlan();
    },
  };
}

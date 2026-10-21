/* Aircraft checklists page.

   Progress is per flight (see the engine's flightKeyFor). The page never ticks
   an item from telemetry: the stream has no engine, gear or brake state, so the
   pilot checks items and the page only suggests the phase and section.

   Everything is stored locally. When a bridge is reachable the state is also
   pushed there so a paired phone can read and update it; the bridge only keeps
   the state in memory and never writes it to the log. */

import {
  CHECKLIST_PROFILES, GENERIC_PROFILE, detectAircraft, profileByKey, sectionsOf, itemKey,
  progressOf, inferPhase, recommendSection, phaseLabel, flightKeyFor, sanitizeChecks,
  makeState, mergeChecklistStates, profileLabel,
} from '../lib/checklists.js';
import { esc, tag, toast, askText, pickFile, downloadText } from '../ui.js';

const PROGRESS_KEY = 'stratos.checklists.v1';
const SELECTION_KEY = 'stratos.checklist.selection';
const CUSTOM_KEY = 'stratos.checklist.custom.v1';
const AUDIO_KEY = 'stratos.checklist.audio';
const SYNC_INTERVAL = 2500;

const CONNECTION_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting',
  offline: 'PC offline',
  unpaired: 'Pairing required',
  error: 'PC offline',
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) || fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

export async function mount(root, ctx) {
  let detected = detectAircraft({ aircraft: '', src: '' });
  let selection = readJson(SELECTION_KEY, null); // { aircraftKey, profileKey, customLabel }
  let liveFlightId = (ctx.live && ctx.live.currentFlight && ctx.live.currentFlight.id) || null;
  let flightKey = flightKeyFor({ flightId: liveFlightId, profileKey: selection?.profileKey || 'generic' });
  let state = makeState({ profileKey: selection?.profileKey || null, flightKey, checks: {} });
  let activeSection = null;
  let phase = { key: 'dispatch', confidence: 'none', reason: 'No telemetry yet.' };
  let compact = false;
  let fullscreen = false;
  let audio = readJson(AUDIO_KEY, false) === true;
  let suggestion = null;
  let custom = readJson(CUSTOM_KEY, null);
  let lastPhaseUpdate = 0;
  let syncTimer = null;
  let syncController = null;
  let connection = ctx.health ? 'connected' : 'connecting';
  let destroyed = false;

  const progressStore = () => readJson(PROGRESS_KEY, {});

  function saveState() {
    const store = progressStore();
    store[flightKey] = state;
    writeJson(PROGRESS_KEY, store);
    writeJson(SELECTION_KEY, { aircraftKey: selection?.aircraftKey || null, profileKey: state.profileKey });
  }

  function currentProfile() {
    if (custom && state.profileKey === 'custom' && Array.isArray(custom.sections)) return customProfileOf(custom);
    return profileByKey(state.profileKey) || null;
  }

  function customProfileOf(data) {
    return {
      key: 'custom',
      label: String(data.label || 'Custom checklist').slice(0, 80),
      family: 'Custom',
      variant: 'User checklist',
      simulator: 'Any',
      verification: 'custom',
      disclaimer: 'Custom checklist created or imported on this device. It has not been verified.',
      source: data.source || 'Created locally.',
      detect: [],
      sections: data.sections,
    };
  }

  function applyProfile(key, { silent = false } = {}) {
    // On the ground the key includes the aircraft, so a different checklist is
    // a different record; in flight it stays tied to the flight id.
    if (!liveFlightId) flightKey = flightKeyFor({ profileKey: key });
    state = makeState({
      profileKey: key,
      flightKey,
      checks: {},
      activeSection: activeSection,
      revision: (state.revision || 0) + 1,
      updatedAt: Date.now(),
    });
    activeSection = sectionsOf(currentProfile())[0]?.key || null;
    state.activeSection = activeSection;
    saveState();
    render();
    if (!silent) toast(`Loaded ${profileLabel(key)} for this flight.`);
    queueSync();
  }

  function loadFlight(nextFlightId, nextAircraft) {
    liveFlightId = nextFlightId;
    const profileForFlight = (readJson(SELECTION_KEY, null) || {}).profileKey;
    const key = flightKeyFor({ flightId: nextFlightId, profileKey: profileForFlight || 'generic' });
    if (key === flightKey) return;
    flightKey = key;
    const stored = progressStore()[key];
    if (stored && stored.flightKey === key) {
      state = makeState(stored);
      activeSection = state.activeSection;
    } else {
      state = makeState({ profileKey: state.profileKey, flightKey, checks: {} });
      activeSection = sectionsOf(currentProfile())[0]?.key || null;
      state.activeSection = activeSection;
      saveState();
    }
    if (nextAircraft) updateDetectionFor(nextAircraft);
    render();
  }

  function updateDetectionFor(raw) {
    const next = detectAircraft({ aircraft: raw.aircraft || (ctx.live && ctx.live.raw && ctx.live.raw.aircraft) || '', src: raw.src || '' });
    if (next.reported === detected.reported && next.simulator === detected.simulator) return false;
    detected = next;
    // A detected aircraft loads its profile unless the pilot explicitly chose
    // another one for this flight. A change of type starts clean: the previous
    // aircraft's item keys must never look complete on the new one.
    const manuallyChosen = Boolean(selection?.aircraftKey) && selection.aircraftKey !== next.reported;
    if (next.profileKey && !manuallyChosen) {
      if (!liveFlightId) flightKey = flightKeyFor({ profileKey: next.profileKey });
      state = makeState({ profileKey: next.profileKey, flightKey, checks: {}, activeSection: state.activeSection, revision: state.revision + 1, updatedAt: Date.now() });
      selection = { aircraftKey: next.reported, profileKey: next.profileKey };
      if (!activeSection) activeSection = sectionsOf(currentProfile())[0]?.key || null;
      state.activeSection = activeSection;
      saveState();
      queueSync();
      return true;
    }
    return true;
  }

  function setConnection(next, detail = '') {
    if (!next || connection === next) return;
    // Once the bridge says this phone is not paired, keep that action visible
    // instead of letting a reconnect attempt overwrite it with "Connecting".
    if (connection === 'unpaired' && next !== 'unpaired') return;
    connection = next;
    const node = document.getElementById('cl-conn');
    if (node) {
      node.dataset.state = next;
      node.innerHTML = `<i class="cl-dot"></i>${esc(CONNECTION_LABEL[next] || next)}`;
      node.title = detail || CONNECTION_LABEL[next] || '';
    }
  }

  function onBridgeStatus(event) {
    const status = (event && event.detail) || {};
    if (status.state === 'connected') setConnection('connected');
    else if (status.state === 'connecting') setConnection('connecting');
    else if (status.state === 'reconnecting') {
      if (connection === 'unpaired') return;
      setConnection('reconnecting');
      // EventSource keeps retrying a 401 without exposing the status, so ask
      // once whether this phone still holds a valid pairing.
      readRemoteState();
    }
    else if (status.state === 'offline') setConnection('offline');
    else if (status.state === 'disconnected') setConnection('offline');
  }

  function onOnline() { setConnection('connecting'); }
  function onOffline() { setConnection('offline'); }

  /** One read so a phone shows the PC's state before the first stream frame. */
  async function readRemoteState() {
    if (!ctx.bridgeBase) return;
    try {
      const response = await fetch(`${String(ctx.bridgeBase).replace(/\/+$/, '')}/checklist`, {
        cache: 'no-store',
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
      });
      if (response.status === 401 || response.status === 403) { setConnection('unpaired'); return; }
      if (!response.ok) { setConnection('offline'); return; }
      const remote = await response.json();
      if (!remote || remote.empty) return;
      const merged = mergeChecklistStates(state, remote);
      if (merged.source === 'remote') {
        state = merged.state;
        flightKey = state.flightKey || flightKey;
        activeSection = state.activeSection || activeSection;
        saveState();
        render();
      }
      setConnection('connected');
    } catch (_) {
      setConnection(navigator.onLine ? 'offline' : 'offline');
    }
  }

  function onTelemetry(message) {
    if (destroyed) return;
    setConnection('connected');
    const now = Date.now();
    if (now - lastPhaseUpdate < 900) return;
    lastPhaseUpdate = now;
    const telemetry = message && message.telemetry;
    const raw = (message && message.raw) || {};
    const rawFlight = message && message.currentFlight;
    if (raw.aircraft || raw.src) {
      if (updateDetectionFor(raw)) render();
    }
    if (rawFlight && rawFlight.id) loadFlight(rawFlight.id, raw);
    const nextPhase = inferPhase(telemetry, phase.key);
    if (nextPhase.key !== phase.key) {
      phase = nextPhase;
      suggestion = recommendSection(currentProfile(), telemetry, state.checks, null, phase.key);
      paintPhase();
      speak(`Checklist: ${phaseLabel(phase.key)}`);
    }
    // The bridge includes the phone's checklist state in the stream when one is
    // paired; adopt it only when it is newer than this page's state.
    if (raw.checklist) {
      const merged = mergeChecklistStates(state, raw.checklist);
      if (merged.source === 'remote' && merged.state.flightKey === flightKey) {
        state = merged.state;
        activeSection = state.activeSection || activeSection;
        saveState();
        render();
      }
    }
  }

  /* ── sync with the bridge (paired phone) ─────────────────────────── */

  async function queueSync() {
    if (!ctx.bridgeBase) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushState, SYNC_INTERVAL);
  }

  async function pushState() {
    try {
      syncController?.abort();
      syncController = new AbortController();
      const timer = setTimeout(() => syncController.abort(), 4000);
      const response = await fetch(`${String(ctx.bridgeBase).replace(/\/+$/, '')}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
        cache: 'no-store',
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
        signal: syncController.signal,
      });
      clearTimeout(timer);
      if (response.status === 401 || response.status === 403) { setConnection('unpaired'); return; }
      if (!response.ok) { setConnection('offline'); return; }
      const remote = await response.json().catch(() => null);
      if (remote && remote.revision > state.revision && remote.flightKey === flightKey) {
        state = makeState(remote);
        activeSection = state.activeSection || activeSection;
        saveState();
        render();
      }
    } catch (_) {
      // Offline bridge is normal; the phone simply sees the last state it had.
    }
  }

  /* ── audio ───────────────────────────────────────────────────────── */

  function speak(text) {
    if (!audio || !text) return;
    try {
      if (!window.speechSynthesis) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.volume = 0.7;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (_) {}
  }

  /* ── rendering ───────────────────────────────────────────────────── */

  function paintProgress() {
    const profile = currentProfile();
    if (!profile) return;
    const progress = progressOf(profile, state.checks);
    const bar = document.getElementById('cl-bar-fill');
    if (bar) bar.style.width = `${progress.percent}%`;
    const count = document.getElementById('cl-count');
    if (count) count.textContent = `${progress.done} of ${progress.total} · ${progress.percent}%`;
    const remaining = document.getElementById('cl-remaining');
    if (remaining) remaining.textContent = progress.remaining === 0
      ? 'All normal items checked.'
      : `${progress.remaining} item${progress.remaining === 1 ? '' : 's'} remaining`;
    const open = document.getElementById('cl-open-before');
    if (open) {
      const order = progress.bySection.map(row => row.key);
      const index = order.indexOf(activeSection);
      const behind = progress.bySection.filter(row => order.indexOf(row.key) < index && !row.complete);
      open.innerHTML = behind.length
        ? `<span class="cl-warn">${behind.map(row => `${esc(row.title)} ${row.done}/${row.total}`).join(' · ')} still open</span>`
        : '';
    }
    root.querySelectorAll('[data-section-count]').forEach(node => {
      const row = progress.bySection.find(item => item.key === node.dataset.sectionCount);
      if (row) node.textContent = row.complete ? '✓' : `${row.done}/${row.total}`;
    });
  }

  function paintPhase() {
    const node = document.getElementById('cl-phase');
    if (node) {
      node.innerHTML = `<i class="cl-dot"></i>${esc(phaseLabel(phase.key))}`
        + `<span class="cl-phase-why">${esc(phase.reason)}</span>`;
    }
    const suggest = document.getElementById('cl-suggest');
    if (suggest) {
      suggest.hidden = !suggestion || suggestion.key === activeSection;
      if (suggestion && suggestion.key !== activeSection) {
        suggest.innerHTML = `<span>Suggested next: <b>${esc(suggestion.title)}</b></span>`
          + `<button class="cl-btn" data-goto-suggest="${esc(suggestion.key)}">Open</button>`;
      }
    }
  }

  function renderSections() {
    const profile = currentProfile();
    if (!profile) return;
    const progress = progressOf(profile, state.checks);
    const normal = progress.bySection;
    const emergency = progress.emergency;
    root.querySelectorAll('[data-section-count]').forEach(node => {
      const row = [...normal, ...emergency].find(item => item.key === node.dataset.sectionCount);
      if (row) node.textContent = row.complete || row.done === row.total ? '✓' : `${row.done}/${row.total}`;
    });
  }

  function sectionHtml(section) {
    const checks = state.checks;
    const rows = section.items.map((item, index) => {
      const key = itemKey(section.key, index);
      const done = Boolean(checks[key]);
      return `<li class="cl-item${done ? ' is-done' : ''}" data-item="${esc(key)}">
        <label class="cl-check">
          <input type="checkbox" data-check="${esc(key)}" ${done ? 'checked' : ''} aria-label="${esc(item.action)}">
          <span class="cl-box" aria-hidden="true"></span>
        </label>
        <div class="cl-item-body">
          <div class="cl-item-head"><b>${esc(item.action)}</b>${done ? '<span class="cl-done">done</span>' : ''}</div>
          ${item.expect ? `<div class="cl-expect">${esc(item.expect)}</div>` : ''}
          ${item.note ? `<div class="cl-note">${esc(item.note)}</div>` : ''}
        </div>
      </li>`;
    }).join('');
    const progress = progressOf(currentProfile(), checks).bySection.find(row => row.key === section.key);
    return `<div class="cl-section-head">
        <div>
          <span class="cl-eyebrow">${esc(phaseLabel(section.phase))}${section.kind !== 'normal' ? ` · ${esc(section.kind)}` : ''}</span>
          <h2>${esc(section.title)}</h2>
        </div>
        <span class="cl-section-progress">${progress ? `${progress.done}/${progress.total}` : ''}</span>
      </div>
      <ol class="cl-items">${rows}</ol>`;
  }

  function render() {
    const profile = currentProfile();
    const progress = profile ? progressOf(profile, state.checks) : { done: 0, total: 0, percent: 0, bySection: [], supplementary: [], emergency: [] };
    const section = sectionsOf(profile).find(entry => entry.key === activeSection)
      || sectionsOf(profile)[0]
      || null;
    if (section) activeSection = section.key;

    const aircraftOptions = [
      ...CHECKLIST_PROFILES.map(entry => `<option value="${entry.key}" ${state.profileKey === entry.key ? 'selected' : ''}>${esc(entry.label)}</option>`),
      ...(custom ? [`<option value="custom" ${state.profileKey === 'custom' ? 'selected' : ''}>${esc(custom.label || 'Custom checklist')}</option>`] : []),
      `<option value="generic" ${state.profileKey === 'generic' ? 'selected' : ''}>${esc(GENERIC_PROFILE.label)}</option>`,
    ].join('');

    const detectionLine = detected.reported
      ? `Reported by ${esc(detected.simulator || 'the simulator')}: <b>${esc(detected.reported)}</b>`
      : 'The simulator has not reported an aircraft. Choose one below.';

    root.innerHTML = `
      <div class="cl-workspace${fullscreen ? ' is-full' : ''}${compact ? ' is-compact' : ''}" id="cl-workspace">
        <header class="cl-bar">
          <div class="cl-aircraft">
            <span class="cl-eyebrow">Aircraft checklist</span>
            <h1>${esc(profile ? profile.label : 'No aircraft selected')}</h1>
            <div class="cl-sub">${detectionLine}${profile && profile.variant ? ` · ${esc(profile.variant)}` : ''}
              ${profile && profile.verification === 'community' ? ` ${tag('community', 'warn', profile.disclaimer)}` : ''}</div>
          </div>
          <div class="cl-progress" aria-live="polite">
            <div class="cl-bar-track"><span id="cl-bar-fill" style="width:${progress.percent}%"></span></div>
            <div class="cl-progress-row"><b id="cl-count">${progress.done} of ${progress.total} · ${progress.percent}%</b>
              <span id="cl-remaining">${progress.remaining} remaining</span></div>
            <div id="cl-open-before" class="cl-open-before"></div>
          </div>
          <div class="cl-actions">
            <label class="cl-select"><span class="sr-only">Aircraft profile</span>
              <select id="cl-aircraft-select" aria-label="Aircraft profile">${aircraftOptions}</select></label>
            <button class="cl-btn" id="cl-compact" aria-pressed="${compact}" title="Compact mode">Compact</button>
            <button class="cl-btn" id="cl-full" aria-pressed="${fullscreen}" title="Full screen checklist">Full</button>
            <button class="cl-btn" id="cl-reset" title="Reset the checklist for this flight">Reset</button>
          </div>
          <span class="cl-conn" id="cl-conn" data-state="${esc(connection)}" title="${esc(connection === 'unpaired' ? 'This phone is no longer paired. Tap to pair again.' : (CONNECTION_LABEL[connection] || connection))}"${connection === 'unpaired' ? ' role="button" tabindex="0"' : ''}><i class="cl-dot"></i>${esc(CONNECTION_LABEL[connection] || connection)}</span>
        </header>

        <div class="cl-phase-bar">
          <span class="cl-phase" id="cl-phase"><i class="cl-dot"></i>${esc(phaseLabel(phase.key))}<span class="cl-phase-why">${esc(phase.reason)}</span></span>
          <span class="cl-phase-note">Phase is inferred from position and speed only. Choose a section whenever it is wrong.</span>
          <span id="cl-suggest" class="cl-suggest" ${suggestion && suggestion.key !== activeSection ? '' : 'hidden'}>
            ${suggestion && suggestion.key !== activeSection ? `<span>Suggested next: <b>${esc(suggestion.title)}</b></span><button class="cl-btn" data-goto-suggest="${esc(suggestion.key)}">Open</button>` : ''}
          </span>
        </div>

        <div class="cl-body">
          <nav class="cl-nav" aria-label="Checklist sections">
            <div class="cl-nav-head">Normal</div>
            ${progress.bySection.map(row => {
              const source = sectionsOf(profile).find(entry => entry.key === row.key);
              return `<button class="cl-nav-item${row.key === activeSection ? ' is-active' : ''}${row.complete ? ' is-complete' : ''}" data-goto="${esc(row.key)}">
                <span>${esc(source ? source.title : row.title)}</span><b data-section-count="${esc(row.key)}">${row.complete ? '✓' : `${row.done}/${row.total}`}</b>
              </button>`;
            }).join('')}
            ${progress.supplementary && progress.supplementary.length ? `<div class="cl-nav-head">Supplementary</div>
              ${progress.supplementary.map(row => `<button class="cl-nav-item${row.key === activeSection ? ' is-active' : ''}" data-goto="${esc(row.key)}">
                <span>${esc(row.title)}</span><b data-section-count="${esc(row.key)}">${row.done}/${row.total}</b>
              </button>`).join('')}` : ''}
            ${progress.emergency.length ? `<div class="cl-nav-head">Emergency</div>
              ${progress.emergency.map(row => `<button class="cl-nav-item is-emergency${row.key === activeSection ? ' is-active' : ''}" data-goto="${esc(row.key)}">
                <span>${esc(row.title)}</span><b data-section-count="${esc(row.key)}">${row.done}/${row.total}</b>
              </button>`).join('')}` : ''}
          </nav>

          <section class="cl-main" aria-live="polite">
            ${section ? sectionHtml(section) : '<p class="muted" style="padding:20px">Choose an aircraft to load a checklist.</p>'}
            <div class="cl-main-foot">
              <button class="cl-btn" data-prev ${progress.bySection[0]?.key === activeSection ? 'disabled' : ''}>Previous section</button>
              <button class="cl-btn" data-next ${progress.bySection[progress.bySection.length - 1]?.key === activeSection ? 'disabled' : ''}>Next section</button>
              <span class="spacer"></span>
              <button class="cl-btn" id="cl-new-aircraft">Different aircraft…</button>
            </div>
          </section>

          <aside class="cl-side">
            <section class="cl-side-block">
              <h3>About this checklist</h3>
              <p>${esc(profile ? profile.disclaimer : 'No checklist is loaded.')}</p>
              ${profile && profile.source ? `<p class="cl-source">${esc(profile.source)}</p>` : ''}
              <p class="cl-source">Stratos never ticks items for you. Phase and section suggestions use only groundspeed, altitude, vertical speed and on-ground state.</p>
            </section>
            <section class="cl-side-block">
              <h3>Callouts</h3>
              <label class="cl-switch"><input type="checkbox" id="cl-audio" ${audio ? 'checked' : ''}> <span>Speak phase changes</span></label>
              <p class="cl-source">Off by default. Uses your device's built-in speech voice; no audio leaves the device.</p>
            </section>
            <section class="cl-side-block">
              <h3>Custom checklist</h3>
              <div class="cl-btn-row">
                <button class="cl-btn" id="cl-add-item">Add item…</button>
                <button class="cl-btn" id="cl-import">Import…</button>
                <button class="cl-btn" id="cl-export">Export</button>
              </div>
              <p class="cl-source">A custom checklist is stored on this device. It is marked unverified and never replaces an aircraft profile until you select it.</p>
              <button class="cl-btn danger" id="cl-remove-custom" ${custom ? '' : 'disabled'}>Remove custom checklist</button>
            </section>
          </aside>
        </div>
      </div>`;

    paintProgress();
    paintPhase();
    bind();
  }

  function bind() {
    root.querySelectorAll('[data-check]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.dataset.check;
        if (input.checked) state.checks[key] = true;
        else delete state.checks[key];
        state.revision++;
        state.updatedAt = Date.now();
        state.activeSection = activeSection;
        input.closest('.cl-item')?.classList.toggle('is-done', input.checked);
        const head = input.closest('.cl-item')?.querySelector('.cl-item-head');
        if (head) {
          const badge = head.querySelector('.cl-done');
          if (input.checked && !badge) head.insertAdjacentHTML('beforeend', '<span class="cl-done">done</span>');
          if (!input.checked && badge) badge.remove();
        }
        saveState();
        paintProgress();
        renderSections();
        if (currentlyComplete()) {
          const remaining = progressOf(currentProfile(), state.checks).bySection.find(row => !row.complete);
          if (remaining) toast(`Section complete. Next: ${remaining.title}`, 'good');
        }
        queueSync();
      });
    });

    // The connection chip doubles as the recovery action on a phone: an
    // unpaired tab can go straight back to the pairing form.
    const connectionChip = document.getElementById('cl-conn');
    connectionChip?.addEventListener('click', () => {
      if (connection === 'unpaired' || connection === 'error') location.href = '/pair';
    });
    connectionChip?.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (connection === 'unpaired' || connection === 'error') location.href = '/pair';
      }
    });

    root.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => {
      activeSection = button.dataset.goto;
      state.activeSection = activeSection;
      state.updatedAt = Date.now();
      saveState();
      render();
      speak(sectionTitle());
    }));
    root.querySelectorAll('[data-goto-suggest]').forEach(button => button.addEventListener('click', () => {
      activeSection = button.dataset.gotoSuggest;
      state.activeSection = activeSection;
      saveState();
      render();
    }));

    const move = delta => {
      const rows = progressOf(currentProfile(), state.checks).bySection;
      const index = rows.findIndex(row => row.key === activeSection);
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
      if (!next || next.key === activeSection) return;
      activeSection = next.key;
      state.activeSection = activeSection;
      saveState();
      render();
    };
    root.querySelector('[data-prev]')?.addEventListener('click', () => move(-1));
    root.querySelector('[data-next]')?.addEventListener('click', () => move(1));

    document.getElementById('cl-aircraft-select')?.addEventListener('change', event => {
      const key = event.target.value;
      selection = { aircraftKey: null, profileKey: key };
      activeSection = null;
      applyProfile(key);
    });
    document.getElementById('cl-new-aircraft')?.addEventListener('click', () => {
      document.getElementById('cl-aircraft-select')?.focus();
    });
    document.getElementById('cl-compact')?.addEventListener('click', () => {
      compact = !compact;
      document.getElementById('cl-workspace')?.classList.toggle('is-compact', compact);
      document.getElementById('cl-compact')?.setAttribute('aria-pressed', String(compact));
    });
    document.getElementById('cl-full')?.addEventListener('click', () => {
      fullscreen = !fullscreen;
      document.getElementById('cl-workspace')?.classList.toggle('is-full', fullscreen);
      document.getElementById('cl-full')?.setAttribute('aria-pressed', String(fullscreen));
    });
    document.getElementById('cl-reset')?.addEventListener('click', () => {
      if (!confirm('Reset every checklist item for this flight? The items are only cleared for this flight.')) return;
      state = makeState({ profileKey: state.profileKey, flightKey, checks: {}, activeSection, revision: state.revision + 1, updatedAt: Date.now() });
      saveState();
      render();
      toast('Checklist reset for this flight.');
      queueSync();
    });
    document.getElementById('cl-audio')?.addEventListener('change', event => {
      audio = event.target.checked;
      writeJson(AUDIO_KEY, audio);
    });
    document.getElementById('cl-export')?.addEventListener('click', () => {
      const profile = currentProfile();
      if (!profile) { toast('Choose an aircraft first.', 'bad'); return; }
      const payload = {
        label: profile.label,
        source: profile.source,
        sections: profile.sections.map(entry => ({
          key: entry.key, title: entry.title, phase: entry.phase, kind: entry.kind,
          items: entry.items.map(item => ({ action: item.action, expect: item.expect, note: item.note })),
        })),
      };
      downloadText(`${profile.key}-checklist.json`, JSON.stringify(payload, null, 2), 'application/json');
    });
    document.getElementById('cl-import')?.addEventListener('click', importCustom);
    document.getElementById('cl-add-item')?.addEventListener('click', addCustomItem);
    document.getElementById('cl-remove-custom')?.addEventListener('click', () => {
      if (!confirm('Remove the custom checklist stored on this device?')) return;
      custom = null;
      try { localStorage.removeItem(CUSTOM_KEY); } catch (_) {}
      if (state.profileKey === 'custom') applyProfile('generic');
      else render();
    });
  }

  function currentlyComplete() {
    const profile = currentProfile();
    if (!profile) return false;
    const row = progressOf(profile, state.checks).bySection.find(entry => entry.key === activeSection);
    return Boolean(row && row.complete);
  }

  function sectionTitle() {
    const profile = currentProfile();
    const section = profile && sectionsOf(profile).find(entry => entry.key === activeSection);
    return section ? section.title : '';
  }

  async function importCustom() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const sections = sanitizeCustomSections(data.sections);
      if (!sections.length) throw new Error('No usable sections with items were found.');
      custom = {
        label: String(data.label || file.name.replace(/\.json$/i, '')).slice(0, 80),
        source: String(data.source || `Imported from ${file.name}`).slice(0, 200),
        sections,
      };
      writeJson(CUSTOM_KEY, custom);
      toast(`Imported ${custom.label}.`, 'good');
      selection = { aircraftKey: null, profileKey: 'custom' };
      applyProfile('custom', { silent: true });
    } catch (error) {
      toast(`Checklist import failed: ${error.message}`, 'bad');
    }
  }

  async function addCustomItem() {
    const profile = currentProfile();
    if (!profile) { toast('Choose an aircraft first.', 'bad'); return; }
    const action = await askText('Add checklist item', 'Action (for example: APU BLEED — ON)', '');
    if (!action) return;
    const expect = await askText('Add checklist item', 'Expected indication or note (optional)', '') || '';
    const base = custom && Array.isArray(custom.sections) ? custom.sections : {
      label: `${profile.label} (custom)`,
      source: 'Created locally in Stratos. Not verified.',
      sections: [],
    };
    const section = sectionsOf(profile).find(entry => entry.key === activeSection);
    const targetKey = section ? section.key : 'dispatch';
    let target = base.sections.find(entry => entry.key === targetKey);
    if (!target) {
      target = { key: targetKey, title: section ? section.title : 'Custom items', phase: section ? section.phase : 'dispatch', kind: 'normal', items: [] };
      base.sections.push(target);
    }
    target.items.push({ action: String(action).slice(0, 160), expect: String(expect).slice(0, 200), note: 'Added locally. Not verified.' });
    custom = base;
    writeJson(CUSTOM_KEY, custom);
    selection = { aircraftKey: null, profileKey: 'custom' };
    applyProfile('custom', { silent: true });
    toast('Item added to your custom checklist.', 'good');
  }

  /* ── lifecycle ───────────────────────────────────────────────────── */

  const stored = progressStore()[flightKey];
  if (stored && stored.flightKey === flightKey) {
    state = makeState(stored);
  } else if (selection?.profileKey) {
    state = makeState({ profileKey: selection.profileKey, flightKey, checks: {} });
  } else {
    // Nothing chosen yet: start from the generic checklist so the page is never
    // empty, and replace it as soon as the simulator reports an aircraft.
    state = makeState({ profileKey: 'generic', flightKey, checks: {} });
  }
  activeSection = state.activeSection || sectionsOf(currentProfile())[0]?.key || null;
  state.activeSection = activeSection;

  const initialRaw = (ctx.live && ctx.live.raw) || {};
  if (initialRaw.aircraft) updateDetectionFor(initialRaw);
  if (ctx.live && ctx.live.telemetry) phase = inferPhase(ctx.live.telemetry, phase.key);
  if (liveFlightId) {
    flightKey = flightKeyFor({ flightId: liveFlightId, profileKey: state.profileKey });
    const flightStored = progressStore()[flightKey];
    if (flightStored && flightStored.flightKey === flightKey) state = makeState(flightStored);
    else state = makeState({ profileKey: state.profileKey, flightKey, checks: {} });
    activeSection = state.activeSection || sectionsOf(currentProfile())[0]?.key || null;
  }
  suggestion = recommendSection(currentProfile(), ctx.live?.telemetry, state.checks, null, phase.key);
  saveState();

  window.addEventListener('stratos:telemetry', event => onTelemetry(event.detail));
  window.addEventListener('stratos:bridge-status', onBridgeStatus);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  render();
  // A bridge-only page still needs one state push so a paired phone has something
  // to show before the pilot touches a checkbox.
  queueSync();
  readRemoteState();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(syncTimer);
      try { syncController?.abort(); } catch (_) {}
      window.removeEventListener('stratos:telemetry', onTelemetry);
      window.removeEventListener('stratos:bridge-status', onBridgeStatus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      root.innerHTML = '';
    },
  };
}

function sanitizeCustomSections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw.slice(0, 40)) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.items)) continue;
    const items = entry.items.slice(0, 80)
      .filter(item => item && typeof item.action === 'string' && item.action.trim())
      .map(item => ({
        action: String(item.action).slice(0, 160),
        expect: String(item.expect || '').slice(0, 200),
        note: String(item.note || '').slice(0, 300),
      }));
    if (!items.length) continue;
    out.push({
      key: String(entry.key || `custom-${out.length}`).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || `custom-${out.length}`,
      title: String(entry.title || 'Custom section').slice(0, 80),
      phase: typeof entry.phase === 'string' ? entry.phase.slice(0, 40) : 'dispatch',
      kind: entry.kind === 'emergency' ? 'emergency' : entry.kind === 'supplementary' ? 'supplementary' : 'normal',
      items,
    });
  }
  return out;
}

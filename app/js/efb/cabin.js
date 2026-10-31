/* EFB · Cabin Experience.
 *
 * The tablet is the control head: every press here becomes one command to the
 * bridge, which plays the announcement on the PC's audio device. Nothing is
 * played in this page, so a tablet's own speakers are never mistaken for the
 * cabin.
 *
 * The page is honest about its two hard limits, in the interface rather than in
 * documentation: audio goes to the PC's output, not through X-Plane's sound bus
 * (that needs a plugin Stratos does not ship), and a sentence is only spoken
 * when a recorded pack or a configured neural voice exists for it.
 */

import { connectionText, esc, onLive, currentPlan, liveSnapshot } from './common.js';
import { BridgeAuthError, cabinAudio, cabinControl, cabinPlay, cabinState } from '../bridge.js';
import {
  AIRLINE_PROFILES, ANNOUNCEMENTS, CABIN_GLYPHS, CABIN_PHASES, DEFAULT_CABIN_SETTINGS,
  VOICE_SLOTS, announcementById, cabinContext, cabinEvents, fillAnnouncement,
  loadCabinSettings, newCabinState, outputForPhase, profileName, saveCabinSettings,
} from '../lib/cabin.js';

const POLL_PLAYING_MS = 700;
const POLL_IDLE_MS = 2000;

function glyph(name, size = 18) {
  const body = CABIN_GLYPHS[name] || CABIN_GLYPHS.welcome;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function clock(seconds) {
  const n = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
}

function messageOf(error) {
  if (error instanceof BridgeAuthError) return 'This tablet is not paired with the PC. Pair it in Stratos Settings, then reopen Cabin.';
  return (error && error.message) || 'The bridge did not answer.';
}

export async function mount(root, ctx) {
  let settings = loadCabinSettings();
  let bridge = null;
  let bridgeError = '';
  let playError = '';
  let busy = false;
  let autoBusy = false;
  let destroyed = false;
  let pollTimer = null;
  let lastSignature = '';
  let link = 'offline';
  let triggerState = newCabinState();

  const plan = currentPlan();
  const snapshot = liveSnapshot();
  let context = cabinContext({
    ofp: plan && plan.ofp,
    live: snapshot && snapshot.telemetry,
    airlineName: profileName(settings),
  });

  const save = patch => { settings = saveCabinSettings(patch); };
  const airlineName = () => profileName(settings);
  const slotFor = kind => (kind === 'captain' ? settings.voices.captain : settings.voices.crew);
  const voiceInfo = id => (bridge && Array.isArray(bridge.voices) ? bridge.voices.find(v => v.slot === id) : null);
  const voiceAvailable = id => {
    const info = voiceInfo(id);
    if (!info) return false;
    return Boolean((bridge.provider && bridge.provider.configured) || info.recorded > 0);
  };
  // The EFB output plays on the tablet, so it does not need the PC's audio player.
  const outputOf = item => outputForPhase(settings, item.phase);
  const audioReady = item => Boolean(bridge && bridge.output && (bridge.output.available || (item && outputOf(item) === 'efb')) && bridge.ready);
  let tablet = null;   // { audio, url } while the tablet is playing an announcement itself
  const stopTablet = () => {
    if (!tablet) return;
    tablet.audio.pause();
    URL.revokeObjectURL(tablet.url);
    tablet = null;
  };
  async function playOnTablet() {
    stopTablet();
    try {
      const url = URL.createObjectURL(await cabinAudio());
      const audio = new Audio(url);
      audio.volume = settings.volume ?? 0.8;
      audio.addEventListener('ended', stopTablet);
      tablet = { audio, url };
      await audio.play();
    } catch (error) {
      stopTablet();
      playError = error && error.name === 'NotAllowedError'
        ? 'The tablet blocked the sound. Press the announcement again to play it here.'
        : messageOf(error);
      paintNotice();
    }
  }
  const slotFiles = slot => {
    const info = voiceInfo(slot);
    return (info && Array.isArray(info.files)) ? info.files : [];
  };
  const speaks = item => Boolean(bridge && ((bridge.provider && bridge.provider.configured)
    || slotFiles(slotFor(item.kind)).includes(item.id)));
  const filled = item => fillAnnouncement(item, context);

  /* ── bridge state ─────────────────────────────────────────────────── */

  async function refresh() {
    try {
      bridge = await cabinState();
      bridgeError = '';
    } catch (error) {
      bridgeError = messageOf(error);
    }
    if (destroyed) return;
    const signature = [bridgeError, bridge ? '1' : '0', bridge && bridge.ready,
      bridge && bridge.provider && bridge.provider.configured,
      bridge && bridge.pack && bridge.pack.name,
      bridge && bridge.voices ? bridge.voices.map(v => v.recorded).join(',') : ''].join('|');
    if (signature !== lastSignature) {
      lastSignature = signature;
      render();
    } else {
      paintPanel();
    }
    paintNotice();
    schedule();
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (destroyed || document.hidden) return;
    const playing = Boolean(bridge && bridge.playing);
    pollTimer = setTimeout(async () => {
      await refresh();
    }, playing ? POLL_PLAYING_MS : POLL_IDLE_MS);
  }

  /* ── playback ─────────────────────────────────────────────────────── */

  async function send(id, text) {
    if (busy) return null;
    const item = announcementById(id);
    if (!item) return null;
    busy = true;
    playError = '';
    paintPanel();
    try {
      const voice = slotFor(item.kind);
      bridge = await cabinPlay({ id, voice, text, output: outputOf(item), volume: settings.volume ?? 0.8 });
      if (outputOf(item) === 'efb') await playOnTablet();
      return bridge;
    } catch (error) {
      playError = messageOf(error);
      paintNotice();
      return null;
    } finally {
      busy = false;
      paintPanel();
      schedule();
    }
  }

  async function playNow(id) {
    const item = announcementById(id);
    if (!item) return;
    if (!audioReady(item)) {
      playError = !bridge
        ? (bridgeError || 'The bridge on the PC is not answering.')
        : (bridge.output && !bridge.output.available && outputOf(item) !== 'efb'
          ? 'This PC reports no audio output device.'
          : 'No voice source is configured on the PC. See Cabin setup below.');
      paintNotice();
      return;
    }
    if (!speaks(item)) {
      playError = `There is no recording for “${item.title}” in that voice. Choose another voice or install its recording.`;
      paintNotice();
      return;
    }
    const said = filled(item);
    if (!said.ready) {
      playError = `“${item.title}” needs the ${said.missing.map(entry => entry.label).join(', ')}. Load a SimBrief plan that states them.`;
      paintNotice();
      return;
    }
    await send(item.id, said.text);
  }

  // Skip stops the announcement that is playing and starts the next one in the
  // list that the PC can speak right now. It never restarts the same one.
  async function skip() {
    const current = bridge && bridge.playing ? bridge.playing.id : '';
    const index = ANNOUNCEMENTS.findIndex(entry => entry.id === current);
    const next = ANNOUNCEMENTS.slice(index + 1).find(entry => {
      const said = filled(entry);
      return audioReady(entry) && speaks(entry) && said.ready;
    });
    await control('stop');
    if (!next) {
      playError = 'There is no next announcement ready to play.';
      paintNotice();
      return;
    }
    await playNow(next.id);
  }

  async function control(action, volume) {
    if (tablet) {
      if (action === 'pause') tablet.audio.pause();
      else if (action === 'resume') void tablet.audio.play();
      else if (action === 'stop') stopTablet();
      else if (action === 'volume') tablet.audio.volume = volume;
    }
    try {
      bridge = await cabinControl({ action, volume });
      bridgeError = '';
    } catch (error) {
      bridgeError = messageOf(error);
    }
    paintPanel();
    paintNotice();
    schedule();
  }

  /* ── automatic announcements ──────────────────────────────────────── */

  async function autoRun(ids) {
    if (autoBusy) return;
    autoBusy = true;
    try {
      for (const id of ids) {
        if (!settings.auto || busy) break;
        if (bridge && bridge.playing) continue;       // never talk over the crew
        if (settings.autoOn[id] === false) continue;
        const item = announcementById(id);
        if (!item) continue;
        if (!audioReady(item)) break;
        const said = filled(item);
        if (!said.ready) {
          playError = `Automatic “${item.title}” was skipped: the ${said.missing.map(entry => entry.label).join(', ')} is not in the plan.`;
          paintNotice();
          continue;
        }
        const state = await send(item.id, said.text);
        if (!state) break;                            // the bridge refused; do not hammer it
      }
    } finally {
      autoBusy = false;
    }
  }

  const unsubscribe = onLive(status => {
    link = (status && status.status) || 'offline';
    paintPanel();
    const snap = status && status.snapshot;
    if (!snap || !snap.telemetry) return;
    const ofp = (currentPlan() || {}).ofp || null;
    context = cabinContext({ ofp, live: snap.telemetry, airlineName: airlineName() });
    const phase = (snap.currentFlight && snap.currentFlight.phase) || snap.phase || '';
    const result = cabinEvents({ snapshot: snap.telemetry, phase, state: triggerState });
    triggerState = result.state;
    if (!settings.auto || !result.ids.length) return;
    void autoRun(result.ids);
  });

  /* ── painting ─────────────────────────────────────────────────────── */

  function reasonFor(item) {
    if (!bridge && bridgeError) return bridgeError;
    if (!bridge) return 'Waiting for the bridge on the PC.';
    if (outputOf(item) !== 'efb' && (!bridge.output || !bridge.output.available)) return 'This PC reports no audio output device.';
    if (!bridge.ready) return 'No voice source is configured on the PC.';
    if (!speaks(item)) return `No recording in the ${item.kind === 'captain' ? 'selected captain' : 'selected cabin crew'} voice for this announcement.`;
    const said = filled(item);
    if (!said.ready) return `Needs the ${said.missing.map(entry => entry.label).join(', ')}.`;
    return outputOf(item) === 'efb' ? 'Play on this tablet' : 'Play on the PC';
  }

  function tile(item) {
    const said = filled(item);
    const available = audioReady(item) && speaks(item) && said.ready && !busy;
    const badge = said.ready ? '' : '<span class="cab-needs">Needs plan</span>';
    const auto = item.auto
      ? `<label class="cab-auto" title="Play automatically when ${item.auto} is detected"><input type="checkbox" data-auto="${esc(item.id)}" ${settings.autoOn[item.id] === false ? '' : 'checked'}><span>Auto</span></label>`
      : `<span class="cab-manual" title="${esc(item.autoWhy || 'This announcement is manual.')}">Manual</span>`;
    return `<div class="cab-item">
      <button class="cab-tile${available ? '' : ' is-off'}" type="button" data-play="${esc(item.id)}"
        ${available ? '' : 'disabled'} title="${esc(reasonFor(item))}">
        <span class="cab-glyph">${glyph(item.icon)}</span>
        <span class="cab-tile-text"><b>${esc(item.title)}</b><span>${esc(item.note)}</span></span>
        <span class="cab-go" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.4 19 12 8 18.6z"/></svg></span>
      </button>
      <div class="cab-item-foot">${badge}${auto}</div>
    </div>`;
  }

  function phaseBlock(phase) {
    const items = ANNOUNCEMENTS.filter(item => item.phase === phase.id);
    const out = outputForPhase(settings, phase.id);
    return `<section class="cab-phase" aria-label="${esc(phase.name)}">
      <header class="cab-phase-head">
        <h3>${esc(phase.name)}</h3>
        <span class="e-small e-faint">${esc(phase.hint)}</span>
        <span class="e-spacer"></span>
        <select class="e-select small" data-phase-output="${esc(phase.id)}" aria-label="Play ${esc(phase.name)} announcements through" title="${out === 'efb' ? 'This tablet plays these; keep this page open with sound on.' : 'The PC plays these on X-Plane\'s sound bus.'}">
          <option value="xplane" ${out !== 'efb' ? 'selected' : ''}>X-Plane</option>
          <option value="efb" ${out === 'efb' ? 'selected' : ''}>This tablet</option>
        </select>
        <span class="e-badge">${items.length}</span>
      </header>
      <div class="cab-tiles">${items.map(tile).join('')}</div>
    </section>`;
  }

  function sourceText() {
    if (!bridge) return bridgeError || 'Bridge not answering';
    if (bridge.pack && bridge.pack.name && bridge.voices.some(v => v.recorded > 0)) {
      return `Recorded pack · ${bridge.pack.name}`;
    }
    if (bridge.provider && bridge.provider.configured) return `${bridge.provider.name} neural voice`;
    return 'None on the PC';
  }

  function setupCard() {
    const airline = AIRLINE_PROFILES.find(item => item.id === settings.airline);
    const captainVoices = VOICE_SLOTS.filter(v => v.role === 'captain');
    const crewVoices = VOICE_SLOTS.filter(v => v.role === 'crew');
    const option = voice => {
      const info = voiceInfo(voice.id);
      const missing = bridge && !(bridge.provider && bridge.provider.configured) && info && info.recorded === 0;
      return `<option value="${esc(voice.id)}" ${settings.voices[voice.role] === voice.id ? 'selected' : ''}>${esc(voice.label)}${missing ? ' — no recording' : ''}</option>`;
    };
    return `<div class="e-card cab-setup">
      <h3>Cabin setup <span class="e-spacer"></span><span class="e-badge ${audioReady() ? 'good' : 'warn'}">${esc(audioReady() ? 'Ready' : 'Not ready')}</span></h3>
      <div class="e-grid three" style="gap:10px">
        <div class="e-field">
          <label for="cab-airline">Airline</label>
          <select class="e-select" id="cab-airline">
            <option value="">House · no airline</option>
            ${AIRLINE_PROFILES.map(item => `<option value="${esc(item.id)}" ${settings.airline === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
          </select>
          <span class="e-hint">Scripts are Stratos's own generic wording${airline ? `, introduced as ${esc(airline.name)}` : ''}. No airline recording is reproduced.</span>
        </div>
        <div class="e-field">
          <label for="cab-captain-voice">Captain voice</label>
          <select class="e-select" id="cab-captain-voice">${captainVoices.map(option).join('')}</select>
        </div>
        <div class="e-field">
          <label for="cab-crew-voice">Cabin crew voice</label>
          <select class="e-select" id="cab-crew-voice">${crewVoices.map(option).join('')}</select>
        </div>
      </div>
      <span class="e-hint" style="display:block;margin-top:10px">Choose where each group of announcements plays, below in its section.</span>
      ${settings.airline === 'custom' ? `<div class="e-field" style="margin-top:10px">
        <label for="cab-custom">Custom airline name</label>
        <input class="e-input small" id="cab-custom" value="${esc(settings.customName || '')}" placeholder="Operator name spoken in the scripts">
        <span class="e-hint">Used in the scripts only. It does not claim that airline's recordings.</span>
      </div>` : ''}
      <div class="e-row" style="margin-top:12px">
        <label class="cab-switch"><input type="checkbox" id="cab-auto" ${settings.auto ? 'checked' : ''}> Automatic announcements</label>
        <span class="e-spacer"></span>
        <button class="e-btn small ghost" type="button" id="cab-defaults">Restore defaults</button>
      </div>
      <dl class="e-kv" style="margin-top:12px">
        <dt>Bridge</dt><dd>${esc(bridgeError || (bridge ? 'Connected' : 'Waiting'))}</dd>
        <dt>Voice source</dt><dd>${esc(sourceText())}</dd>
        <dt>Audio output</dt><dd>${esc(bridge && bridge.output ? bridge.output.bus : 'The PC plays the announcement unless a phase is set to this tablet.')}</dd>
        <dt>Automatic</dt><dd>${settings.auto ? 'On for the events the simulator reports' : 'Off — announcements are manual only'}</dd>
      </dl>
      <div class="e-notice" style="margin-top:10px">
        ${bridge && bridge.ready
          ? 'A sentence the plan cannot supply (flight number, destination, arrival time) is refused rather than guessed.'
          : 'To enable audio, put a licensed voice pack in <code>cabin/voices</code> on the PC, or set <code>STRATOS_TTS_KEY</code> and <code>STRATOS_TTS_REGION</code> before starting Stratos. No voice is generated by default.'}
      </div>
    </div>`;
  }

  function panel() {
    return `<div class="e-card cab-panel">
      <div class="cab-now">
        <span class="cab-now-glyph" id="cab-glyph">${glyph('welcome', 20)}</span>
        <div class="cab-now-text">
          <div class="e-label">Now playing</div>
          <b id="cab-title">Nothing playing</b>
          <div class="cab-sub" id="cab-sub">Choose an announcement below.</div>
        </div>
        <span class="e-spacer"></span>
        <span class="e-badge" id="cab-link">Offline</span>
        <button class="e-btn small" type="button" id="cab-pause" disabled>Pause</button>
          <button class="e-btn small ghost" type="button" id="cab-skip" disabled>Skip</button>
          <button class="e-btn small ghost" type="button" id="cab-stop" disabled>Stop</button>
      </div>
      <div class="cab-progress" role="progressbar" aria-label="Announcement progress"><i id="cab-fill"></i></div>
      <div class="e-row">
        <span class="e-small e-faint" id="cab-time">0:00 / 0:00</span>
        <span class="e-spacer"></span>
        <label class="e-label" for="cab-volume">Volume</label>
        <input class="cab-range" id="cab-volume" type="range" min="0" max="100" step="5" value="${Math.round((settings.volume ?? 0.8) * 100)}">
        <b class="e-small" id="cab-volume-value">${Math.round((settings.volume ?? 0.8) * 100)}%</b>
      </div>
    </div>`;
  }

  function notice() {
    if (!playError && !bridgeError) return '';
    const text = playError || bridgeError;
    return `<div class="e-notice cab-alert"><span>${esc(text)}</span><button class="e-btn small ghost" type="button" id="cab-dismiss">Dismiss</button></div>`;
  }

  function render() {
    root.innerHTML = `<div class="cab-alert-host">${notice()}</div>${panel()}${setupCard()}<div class="cab-phases">${CABIN_PHASES.map(phaseBlock).join('')}</div>
      <p class="e-small e-faint" style="margin:14px 2px 0">${esc(bridge && bridge.output ? bridge.output.bus : 'Audio is played by the PC, not by this tablet.')} Announcements are a simulator feature; they are not for real-world use.</p>`;
    bind();
    paintPanel();
  }

  function paintPanel() {
    const title = root.querySelector('#cab-title');
    if (!title) return;
    const playing = bridge && bridge.playing;
    const item = playing ? announcementById(playing.id) : null;
    const glyphBox = root.querySelector('#cab-glyph');
    title.textContent = busy && !playing
      ? 'Preparing the announcement…'
      : playing
        ? (item ? item.title : playing.id)
        : 'Nothing playing';
    const voice = playing ? VOICE_SLOTS.find(entry => entry.id === playing.slot) : null;
    root.querySelector('#cab-sub').textContent = busy && !playing
      ? 'The PC is fetching or synthesising the voice.'
      : playing
        ? [voice ? voice.label : playing.slot, playing.source === 'pack' ? 'recorded' : 'neural voice',
          playing.paused ? 'paused' : 'playing on the PC'].join(' · ')
        : 'Choose an announcement below.';
    const linkChip = root.querySelector('#cab-link');
    if (linkChip) {
      linkChip.textContent = connectionText(link);
      linkChip.className = `e-badge ${link === 'live' ? 'good' : link === 'offline' ? 'bad' : ''}`;
    }
    if (glyphBox) glyphBox.innerHTML = glyph(item ? item.icon : 'welcome', 20);
    const duration = playing ? Number(playing.duration) || 0 : 0;
    const position = playing ? Number(playing.position) || 0 : 0;
    const fill = root.querySelector('#cab-fill');
    if (fill) fill.style.width = `${duration ? Math.min(100, (position / duration) * 100) : 0}%`;
    const time = root.querySelector('#cab-time');
    if (time) time.textContent = `${clock(position)} / ${clock(duration)}`;
    const pause = root.querySelector('#cab-pause');
    if (pause) {
      pause.disabled = !playing;
      pause.textContent = playing && playing.paused ? 'Resume' : 'Pause';
    }
    const stop = root.querySelector('#cab-stop');
    if (stop) stop.disabled = !playing;
    const skipButton = root.querySelector('#cab-skip');
    if (skipButton) skipButton.disabled = !playing;
  }

  function paintNotice() {
    const host = root.querySelector('.cab-alert-host');
    if (!host) {
      if (!playError && !bridgeError) return;
      render();
      return;
    }
    if (host.innerHTML !== notice()) {
      host.innerHTML = notice();
      const dismiss = host.querySelector('#cab-dismiss');
      if (dismiss) dismiss.addEventListener('click', () => { playError = ''; render(); });
    }
  }

  /* ── events ───────────────────────────────────────────────────────── */

  function bind() {
    root.querySelectorAll('[data-play]').forEach(button => {
      button.addEventListener('click', () => { void playNow(button.dataset.play); });
    });

    root.querySelectorAll('[data-auto]').forEach(input => {
      input.addEventListener('change', () => {
        const next = { ...settings.autoOn };
        if (input.checked) delete next[input.dataset.auto];
        else next[input.dataset.auto] = false;
        save({ autoOn: next });
      });
    });

    const airline = root.querySelector('#cab-airline');
    if (airline) airline.addEventListener('change', () => {
      save({ airline: airline.value });
      context = cabinContext({ ofp: (currentPlan() || {}).ofp || null, live: liveSnapshot() && liveSnapshot().telemetry, airlineName: airlineName() });
      render();
    });

    root.querySelectorAll('[data-phase-output]').forEach(select => select.addEventListener('change', () => {
      stopTablet();
      save({ outputs: { ...settings.outputs, [select.dataset.phaseOutput]: select.value === 'efb' ? 'efb' : 'xplane' } });
      render();
    }));

    const custom = root.querySelector('#cab-custom');
    if (custom) custom.addEventListener('change', () => {
      save({ customName: custom.value.trim().slice(0, 60) });
      context = cabinContext({ ofp: (currentPlan() || {}).ofp || null, live: liveSnapshot() && liveSnapshot().telemetry, airlineName: airlineName() });
      render();
    });

    const captain = root.querySelector('#cab-captain-voice');
    if (captain) captain.addEventListener('change', () => { save({ voices: { ...settings.voices, captain: captain.value } }); render(); });
    const crew = root.querySelector('#cab-crew-voice');
    if (crew) crew.addEventListener('change', () => { save({ voices: { ...settings.voices, crew: crew.value } }); render(); });

    const auto = root.querySelector('#cab-auto');
    if (auto) auto.addEventListener('change', () => { save({ auto: auto.checked }); render(); });

    const defaults = root.querySelector('#cab-defaults');
    if (defaults) defaults.addEventListener('click', () => {
      settings = saveCabinSettings({ ...DEFAULT_CABIN_SETTINGS, voices: { ...DEFAULT_CABIN_SETTINGS.voices }, autoOn: {} });
      void control('volume', DEFAULT_CABIN_SETTINGS.volume);
      render();
    });

    const volume = root.querySelector('#cab-volume');
    if (volume) {
      const label = root.querySelector('#cab-volume-value');
      volume.addEventListener('input', () => { if (label) label.textContent = `${volume.value}%`; });
      volume.addEventListener('change', () => {
        const value = Number(volume.value) / 100;
        save({ volume: value });
        void control('volume', value);
      });
    }

    const pause = root.querySelector('#cab-pause');
    if (pause) pause.addEventListener('click', () => {
      const paused = Boolean(bridge && bridge.playing && bridge.playing.paused);
      void control(paused ? 'resume' : 'pause');
    });
    const stop = root.querySelector('#cab-stop');
    if (stop) stop.addEventListener('click', () => { void control('stop'); });
    const skipButton = root.querySelector('#cab-skip');
    if (skipButton) skipButton.addEventListener('click', () => { void skip(); });
    const dismiss = root.querySelector('#cab-dismiss');
    if (dismiss) dismiss.addEventListener('click', () => { playError = ''; render(); });
  }

  /* ── lifecycle ────────────────────────────────────────────────────── */

  const onVisibility = () => {
    if (document.hidden) clearTimeout(pollTimer);
    else { void refresh(); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  render();
  await refresh();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      // The ride-along page does not own the PC's speakers: leave nothing behind.
    },
  };
}

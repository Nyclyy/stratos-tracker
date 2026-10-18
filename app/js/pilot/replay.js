import { prepareReplay, sampleAt, formatElapsed, hasReplay } from '../lib/replay.js';
import { MiniMap } from '../minimap.js';
import { esc, fmtDate, num, tag, toast } from '../ui.js';

const SPEEDS = [0.5, 1, 2, 4, 8];
const PROFILE_W = 640;
const PROFILE_H = 150;

export async function mount(root, ctx) {
  const candidates = ctx.flights
    .filter(hasReplay)
    .sort((a, b) => (b.startTime || b.takeoffTime || 0) - (a.startTime || a.takeoffTime || 0));

  if (!candidates.length) {
    root.innerHTML = `<div class="page-head"><div><h1>Flight replay</h1>
      <p>Replay uses the position track recorded by the bridge while you fly.</p></div></div>
      <div class="card">${emptyReplay()}</div>`;
    return { destroy() { root.innerHTML = ''; } };
  }

  const requested = ctx.params.get('flight');
  let flight = candidates.find(f => f.id === requested) || candidates[0];
  let replay = prepareReplay(flight);
  let position = replay.available ? replay.start : 0;
  let playing = false;
  let speed = 1;
  let map = null;
  let raf = null;
  let lastFrame = 0;
  let lastMapDraw = 0;
  let dragging = false;

  function emptyReplay() {
    return `<div class="empty-state"><div class="empty-glyph">◷</div>
      <h2>No replayable flights yet</h2>
      <p>Replay is available for flights recorded after telemetry logging was enabled. Older logbook entries are kept exactly as they are, but they do not contain a position track, so Stratos will not invent one.</p>
      <div class="empty-actions"><a class="btn primary" href="index.html">Open the map</a>
      <a class="btn" href="logbook.html">Open logbook</a></div></div>`;
  }

  function flightOptions() {
    return candidates.map(f => {
      const date = fmtDate(f.startTime || f.takeoffTime);
      const label = `${f.depAirport || '????'} → ${f.arrAirport || '????'} · ${date}`;
      return `<option value="${esc(f.id)}" ${f.id === flight.id ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }

  function coverageLabel(field) {
    const coverage = replay.coverage[field];
    if (!coverage || !coverage.total) return '—';
    return `${Math.round(coverage.ratio * 100)}% recorded`;
  }

  function profileSvg() {
    const points = replay.profile.filter(p => Number.isFinite(p.alt) || Number.isFinite(p.gs));
    if (!replay.hasProfile && !replay.coverage.gs.ratio) {
      return '<div class="chart-empty">Altitude and speed were not recorded for this flight.</div>';
    }
    const start = replay.start;
    const span = replay.durationMs || 1;
    const usableH = PROFILE_H - 26;
    const altValues = replay.profile.map(p => Number(p.alt)).filter(Number.isFinite);
    const gsValues = replay.profile.map(p => Number(p.gs)).filter(Number.isFinite);
    const altMin = altValues.length ? Math.min(...altValues) : 0;
    const altMax = altValues.length ? Math.max(...altValues) : 1;
    const gsMin = gsValues.length ? Math.min(...gsValues) : 0;
    const gsMax = gsValues.length ? Math.max(...gsValues) : 1;
    const x = p => ((p.t - start) / span) * PROFILE_W;
    const yAlt = p => 14 + usableH - ((Number(p.alt) - altMin) / Math.max(1, altMax - altMin)) * usableH;
    const yGs = p => 14 + usableH - ((Number(p.gs) - gsMin) / Math.max(1, gsMax - gsMin)) * usableH;
    const altPath = altValues.length ? replay.profile.filter(p => Number.isFinite(p.alt)).map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${yAlt(p).toFixed(1)}`).join(' ') : '';
    const gsPath = gsValues.length ? replay.profile.filter(p => Number.isFinite(p.gs)).map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${yGs(p).toFixed(1)}`).join(' ') : '';
    void points;
    return `<svg id="profile-svg" class="chart" viewBox="0 0 ${PROFILE_W} ${PROFILE_H}" preserveAspectRatio="none" role="img" aria-label="Flight profile">
      ${altPath ? `<path d="${altPath}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
      ${gsPath ? `<path d="${gsPath}" fill="none" stroke="var(--warn)" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>` : ''}
      <line id="profile-cursor" x1="0" y1="0" x2="0" y2="${PROFILE_H}" stroke="var(--txt)" stroke-width="1" opacity=".7"/>
      <line x1="0" y1="${PROFILE_H - 12}" x2="${PROFILE_W}" y2="${PROFILE_H - 12}" stroke="var(--coast)" stroke-width="1"/>
    </svg>
    <div class="row small muted" style="justify-content:space-between">
      <span><span style="color:var(--acc)">■</span> Altitude ${num(altMin)}–${num(altMax)} ft</span>
      <span><span style="color:var(--warn)">■</span> Ground speed ${num(gsMin)}–${num(gsMax)} kt</span>
    </div>`;
  }

  function render() {
    const f = flight;
    const durationMin = Math.round(replay.durationMs / 60000);
    root.innerHTML = `
      <div class="page-head">
        <div><h1>Flight replay</h1>
        <p>${esc(f.depAirport || '????')} → ${esc(f.arrAirport || '????')} · ${esc(fmtDate(f.startTime || f.takeoffTime))} · ${esc(f.aircraft || 'Unknown aircraft')}</p></div>
        <span class="spacer"></span>
        <a class="btn small ghost" href="logbook.html">Logbook</a>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="field-row">
          <div class="field" style="flex:2 1 320px"><label for="replay-flight">Flight</label>
            <select class="input" id="replay-flight">${flightOptions()}</select></div>
          <div class="field"><label>Track</label>
            <div class="row" style="min-height:36px">
              ${tag(`${replay.recordedPoints.toLocaleString()} recorded samples`, 'accent')}
              ${tag(`${durationMin} min`, 'muted')}
            </div>
          </div>
          <div class="field"><label>Coverage</label>
            <div class="row small muted" style="min-height:36px">ALT ${coverageLabel('alt')} · GS ${coverageLabel('gs')} · VS ${coverageLabel('vs')}</div>
          </div>
        </div>
      </div>

      ${replay.available ? `
      <div class="grid grid-main">
        <div>
          <div class="map-wrap replay"><canvas id="replay-map" aria-label="Recorded flight path"></canvas>
            <div class="map-legend"><span>● recorded</span><span>◆ current</span><span>Click map to seek</span></div>
          </div>
          <div class="card" style="margin-top:12px">
            <div class="timeline">
              <input type="range" id="replay-range" min="0" max="${replay.durationMs}" step="100" value="0" aria-label="Replay position">
              <div class="timeline-meta"><span id="replay-elapsed">0:00</span><span id="replay-total">${formatElapsed(replay.durationMs)}</span></div>
            </div>
            <div class="row" style="margin-top:10px">
              <button class="btn icon" id="replay-start" aria-label="Return to start">⏮</button>
              <button class="btn icon" id="replay-back" aria-label="Back 10 seconds">−10</button>
              <button class="btn primary" id="replay-play" aria-label="Play">Play</button>
              <button class="btn icon" id="replay-forward" aria-label="Forward 10 seconds">+10</button>
              <span class="spacer"></span>
              <div class="segmented" role="group" aria-label="Playback speed">
                ${SPEEDS.map(value => `<button data-speed="${value}" aria-pressed="${value === speed}">${value}×</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="card" style="margin-top:12px">
            <div class="card-head"><h2>Synchronised profile</h2><span class="hint">Recorded telemetry</span></div>
            ${profileSvg()}
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><h2>At this point</h2><span class="spacer"></span><span id="sample-badge"></span></div>
            <div id="sample-readout"></div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Flight</h2></div>
            <dl class="kv">
              <dt>Departure</dt><dd>${esc(f.depAirport || 'not recorded')}</dd>
              <dt>Arrival</dt><dd>${esc(f.arrAirport || 'not recorded')}</dd>
              <dt>Distance</dt><dd>${f.distanceNm ? `${num(f.distanceNm)} nm` : '—'}</dd>
              <dt>Max altitude</dt><dd>${f.maxAlt ? `${num(f.maxAlt)} ft` : '—'}</dd>
              <dt>Landing</dt><dd>${f.landing && f.landing.vsFpm != null ? `${f.landing.vsFpm} fpm` : (f.landingVS != null ? `${f.landingVS} fpm` : '—')}</dd>
            </dl>
            <div class="btn-row" style="margin-top:12px"><button class="btn small" id="open-details">Flight details</button>
              <button class="btn small ghost" id="open-thresholds">Landing analytics</button></div>
          </div>
          ${replay.warnings.length ? `<div class="notice warn"><div><strong>Incomplete telemetry.</strong><br>${replay.warnings.map(esc).join('<br>')}</div></div>` : ''}
          <div class="notice"><div>Between recorded samples the replay interpolates position and telemetry. The badge above the readout always says which one you are seeing; the profile line never invents missing fields.</div></div>
        </div>
      </div>` : `<div class="card">${emptyReplay()}</div>`}
    `;

    document.getElementById('replay-flight').addEventListener('change', event => {
      selectFlight(event.target.value);
    });
    document.getElementById('open-details')?.addEventListener('click', () => ctx.openFlight(flight.id));
    document.getElementById('open-thresholds')?.addEventListener('click', () => ctx.go('landings'));
    if (!replay.available) return;

    const canvas = document.getElementById('replay-map');
    map = new MiniMap(canvas, {
      onSeek: index => {
        const point = replay.track[Math.max(0, Math.min(replay.track.length - 1, index))];
        if (!point) return;
        setPosition(point.t, { stop: true });
      },
    });
    map.setTrack(replay.track);
    bindControls();
    setPosition(replay.start, { stop: true });
  }

  function bindControls() {
    const range = document.getElementById('replay-range');
    const playButton = document.getElementById('replay-play');
    range.addEventListener('input', () => {
      dragging = true;
      setPosition(Number(range.value), { stop: true });
    });
    range.addEventListener('change', () => { dragging = false; });
    playButton.addEventListener('click', togglePlay);
    document.getElementById('replay-start').addEventListener('click', () => setPosition(replay.start, { stop: true }));
    document.getElementById('replay-back').addEventListener('click', () => setPosition(position - 10000, { stop: true }));
    document.getElementById('replay-forward').addEventListener('click', () => setPosition(position + 10000, { stop: true }));
    document.querySelectorAll('[data-speed]').forEach(button => {
      button.addEventListener('click', () => {
        speed = Number(button.dataset.speed);
        document.querySelectorAll('[data-speed]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      });
    });
    document.addEventListener('keydown', keyHandler);
  }

  function keyHandler(event) {
    if (!root.isConnected) { document.removeEventListener('keydown', keyHandler); return; }
    if (event.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); setPosition(position - 10000, { stop: true }); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); setPosition(position + 10000, { stop: true }); }
    else if (event.key === 'Home') { event.preventDefault(); setPosition(replay.start, { stop: true }); }
  }

  function togglePlay() {
    if (!replay.available) return;
    playing = !playing;
    const button = document.getElementById('replay-play');
    if (button) {
      button.textContent = playing ? 'Pause' : 'Play';
      button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }
    if (playing) {
      if (position >= replay.end - 100) position = replay.start;
      lastFrame = performance.now();
      if (!raf) raf = requestAnimationFrame(tick);
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function tick(now) {
    raf = null;
    if (!playing) return;
    const delta = Math.min(500, now - lastFrame) * speed;
    lastFrame = now;
    position += delta;
    if (position >= replay.end) {
      position = replay.end;
      setPosition(position, { stop: true });
      playing = false;
      const button = document.getElementById('replay-play');
      if (button) { button.textContent = 'Play'; button.setAttribute('aria-label', 'Play'); }
      return;
    }
    setPosition(position, { map: now - lastMapDraw > 66 });
    raf = requestAnimationFrame(tick);
  }

  function setPosition(time, options = {}) {
    if (options.stop) {
      playing = false;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      const button = document.getElementById('replay-play');
      if (button) { button.textContent = 'Play'; button.setAttribute('aria-label', 'Play'); }
    }
    position = Math.max(replay.start, Math.min(replay.end, time));
    const sample = sampleAt(replay, position);
    if (!sample) return;
    const range = document.getElementById('replay-range');
    if (range && !dragging) range.value = String(Math.round(position - replay.start));
    const elapsed = document.getElementById('replay-elapsed');
    if (elapsed) elapsed.textContent = formatElapsed(position - replay.start);
    const badge = document.getElementById('sample-badge');
    if (badge) {
      badge.innerHTML = sample.recorded
        ? '<span class="tag tag-good" title="This is a point the simulator actually reported">Recorded sample</span>'
        : '<span class="tag tag-warn" title="Interpolated between two recorded samples">Interpolated</span>';
    }
    const readout = document.getElementById('sample-readout');
    if (readout) {
      const fields = [
        ['Altitude', sample.alt != null ? `${num(sample.alt)} ft` : 'not recorded', sample.fieldInterpolated?.alt],
        ['Ground speed', sample.gs != null ? `${num(sample.gs)} kt` : 'not recorded', sample.fieldInterpolated?.gs],
        ['Vertical speed', sample.vs != null ? `${num(sample.vs)} fpm` : 'not recorded', sample.fieldInterpolated?.vs],
        ['Heading', sample.hdg != null ? `${String(Math.round(sample.hdg)).padStart(3, '0')}°` : 'not recorded', sample.fieldInterpolated?.hdg],
      ];
      readout.innerHTML = `<div class="grid grid-2">${fields.map(([label, value, interpolated]) => `
        <div><span class="stat-label">${label}${interpolated ? ' <span class="tag" title="Interpolated between samples">interp.</span>' : ''}</span>
        <b style="font-size:20px">${esc(value)}</b></div>`).join('')}</div>
        <div class="kv" style="margin-top:12px">
          <dt>Distance flown</dt><dd>${sample.alongNm != null ? `${sample.alongNm.toFixed(1)} nm` : '—'}</dd>
          <dt>Progress</dt><dd>${Math.round((sample.progress || 0) * 100)}%</dd>
          <dt>Sample time</dt><dd>${esc(new Date(sample.t).toLocaleTimeString())}</dd>
        </div>`;
    }
    const cursor = document.getElementById('profile-cursor');
    if (cursor) {
      const x = ((position - replay.start) / Math.max(1, replay.durationMs)) * PROFILE_W;
      cursor.setAttribute('x1', x.toFixed(1));
      cursor.setAttribute('x2', x.toFixed(1));
    }
    if (map && options.map !== false) {
      map.setPosition({ lat: sample.lat, lon: sample.lon }, sample.hdg || 0);
      if (options.map === true) lastMapDraw = performance.now();
    }
    if (sample.recorded) window.StratosReplaySample = sample;
  }

  function selectFlight(id) {
    const next = candidates.find(f => f.id === id);
    if (!next) return;
    stopLoop();
    flight = next;
    replay = prepareReplay(flight);
    position = replay.available ? replay.start : 0;
    map?.destroy();
    map = null;
    render();
  }

  function stopLoop() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    document.removeEventListener('keydown', keyHandler);
    map?.destroy();
    map = null;
  }

  render();
  return {
    destroy() {
      stopLoop();
      root.innerHTML = '';
    },
  };
}

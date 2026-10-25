/* EFB · Performance.
 *
 * Two panels, deliberately separate:
 *
 *   Conditions — pressure altitude, ISA, density altitude and runway wind
 *   components. These are physics and are always computed.
 *
 *   Aircraft data — V-speeds and field lengths. Stratos has no licensed approved
 *   dataset for the A340-600, A321 or 777, so these are only produced from a
 *   dataset the operator imports, and only inside its published range. The panel
 *   says which cells are unavailable and why; it never extrapolates, and it never
 *   fills a missing value with a plausible-looking number.
 *
 * The form is pre-filled from the imported plan and the departure METAR, and
 * every pre-filled value says where it came from.
 */

import {
  airportByCode, airportRunways, esc, fmtFt, fmtNum, currentPlan, weatherFor,
} from './common.js';
import {
  analyseConditions, datasetLabel, lookupPerformance, pressureAltitudeFt,
  SCHEMA, validateDataset,
} from '../lib/aircraftperformance.js';
import { EFB_AIRCRAFT, aircraftLabel } from '../data/efb-aircraft.js';
import { parseMetar } from '../lib/routeweather.js';
import { convertWeight } from '../lib/flightsummary.js';

const DATASET_KEY = 'stratos.efb.performanceDataset';
const INPUT_KEY = 'stratos.efb.performanceInputs';

const PHASE = {
  takeoff: { key: 'takeoff', label: 'Takeoff', speedKeys: ['v1Kt', 'vrKt', 'v2Kt'], distanceKey: 'distanceFt' },
  landing: { key: 'landing', label: 'Landing', speedKeys: ['vrefKt'], distanceKey: 'distanceFt' },
};

function loadDataset() {
  try {
    const raw = localStorage.getItem(DATASET_KEY);
    if (!raw) return { dataset: null, error: '' };
    const checked = validateDataset(JSON.parse(raw));
    if (!checked.ok) return { dataset: null, error: `The stored dataset is invalid: ${checked.problems[0]}` };
    return { dataset: checked.dataset, error: '' };
  } catch (_) {
    return { dataset: null, error: 'The stored dataset could not be read and is ignored.' };
  }
}

function loadInputs() {
  try {
    const raw = JSON.parse(localStorage.getItem(INPUT_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) { return {}; }
}

function saveInputs(values) {
  try { localStorage.setItem(INPUT_KEY, JSON.stringify(values)); } catch (_) { /* private mode */ }
}

function variantOptions(selected) {
  return EFB_AIRCRAFT.flatMap(type => type.variants.map(variant => {
    const value = variant.icao;
    return `<option value="${value}" ${value === selected ? 'selected' : ''}>${esc(type.name)} · ${esc(variant.label)}</option>`;
  })).join('');
}

function templateDataset() {
  const axes = {
    weight: [0, 0],
    pressureAltitudeFt: [0, 0],
    oatC: [0, 0],
  };
  // Two stops per axis make the shape valid while every cell stays unpublished.
  axes.weight = [60000, 80000];
  axes.pressureAltitudeFt = [0, 8000];
  axes.oatC = [0, 20];
  const grid = () => axes.weight.map(() => axes.pressureAltitudeFt.map(() => axes.oatC.map(() => null)));
  return {
    schema: SCHEMA,
    aircraft: { icao: 'A321', variant: 'A321-200' },
    source: 'Replace with the document these numbers come from',
    revision: 'YYYY-MM-DD',
    approved: false,
    mode: 'simulation',
    axes,
    takeoff: { distanceFt: grid(), v1Kt: grid(), vrKt: grid(), v2Kt: grid() },
    landing: { distanceFt: grid(), vrefKt: grid() },
    note: 'Every cell is null: replace the cells you are licensed to use. A null cell is shown as unavailable, never interpolated around.',
  };
}

export async function mount(root, ctx) {
  let destroyed = false;
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const saved = loadInputs();
  const loaded = loadDataset();
  let dataset = loaded.dataset;
  let datasetError = loaded.error;

  const unit = ofp && ofp.units === 'lb' ? 'lb' : ctx.prefs().units === 'lb' ? 'lb' : 'kg';
  const initialAircraft = saved.aircraft || (ofp && ofp.aircraft && ofp.aircraft.icao) || EFB_AIRCRAFT[0].variants[0].icao;

  const state = {
    phase: saved.phase === 'landing' ? 'landing' : 'takeoff',
    aircraft: initialAircraft,
    airport: saved.airport || (ofp && ofp.origin && ofp.origin.icao) || '',
    elevationFt: saved.elevationFt ?? '',
    qnhHpa: saved.qnhHpa ?? 1013,
    oatC: saved.oatC ?? '',
    runway: saved.runway ?? '',
    runwayLengthFt: saved.runwayLengthFt ?? '',
    slopePct: saved.slopePct ?? '',
    surface: saved.surface || 'dry',
    flap: saved.flap || '',
    thrust: saved.thrust || '',
    weight: saved.weight ?? '',
    windFromDeg: saved.windFromDeg ?? '',
    windKt: saved.windKt ?? '',
    gustKt: saved.gustKt ?? '',
    prefill: {},
  };

  root.innerHTML = `
    <div class="e-grid" style="grid-template-columns:minmax(0,400px) minmax(0,1fr);align-items:start" id="perf-layout">
      <div class="e-card" id="perf-form"></div>
      <div id="perf-results"></div>
    </div>`;

  const formEl = root.querySelector('#perf-form');
  const resultsEl = root.querySelector('#perf-results');

  function set(key, value, source = '') {
    state[key] = value;
    if (source) state.prefill[key] = source;
    else delete state.prefill[key];
    saveInputs(state);
  }

  function field(key, label, value, { type = 'text', hint = '', placeholder = '', step = 'any', unitLabel = '' } = {}) {
    const source = state.prefill[key] ? `<span class="e-badge accent" title="Pre-filled from ${esc(state.prefill[key])}">${esc(state.prefill[key])}</span>` : '';
    return `<div class="e-field">
      <label for="perf-${key}">${esc(label)} ${source}</label>
      <div class="e-row" style="gap:6px;flex-wrap:nowrap">
        <input class="e-input small" id="perf-${key}" data-key="${key}" type="${type}" step="${step}" value="${esc(value)}" placeholder="${esc(placeholder)}" inputmode="decimal">
        ${unitLabel ? `<span class="e-small e-faint" style="min-width:30px">${esc(unitLabel)}</span>` : ''}
      </div>
      ${hint ? `<span class="e-hint">${esc(hint)}</span>` : ''}
    </div>`;
  }

  function renderForm() {
    const airportRunwaysList = [];
    formEl.innerHTML = `
      <h3>Analysis <span class="e-spacer"></span><span class="e-badge">${esc(aircraftLabel(state.aircraft))}</span></h3>
      <div class="e-row" style="margin-bottom:10px">
        <div class="e-seg" role="group" aria-label="Phase">
          ${Object.values(PHASE).map(phase => `<button type="button" data-phase="${phase.key}" aria-pressed="${state.phase === phase.key ? 'true' : 'false'}">${phase.label}</button>`).join('')}
        </div>
        <span class="e-spacer"></span>
        <button class="e-btn small ghost" type="button" data-reset>Reset</button>
      </div>

      <div class="e-field" style="margin-bottom:8px">
        <label for="perf-aircraft">Aircraft variant</label>
        <select class="e-select" id="perf-aircraft">${variantOptions(state.aircraft)}</select>
      </div>

      <div class="e-field" style="margin-bottom:8px">
        <label for="perf-airport">Airport (ICAO)</label>
        <input class="e-input small" id="perf-airport" data-key="airport" value="${esc(state.airport)}" placeholder="LFPG" autocomplete="off">
      </div>

      <div class="e-grid two" style="gap:8px">
        ${field('elevationFt', 'Elevation', state.elevationFt, { unitLabel: 'ft' })}
        ${field('qnhHpa', 'QNH', state.qnhHpa, { unitLabel: 'hPa' })}
        ${field('oatC', 'OAT', state.oatC, { unitLabel: '°C' })}
        ${field('weight', `Aircraft weight`, state.weight, { unitLabel: unit, hint: 'Actual takeoff or landing weight' })}
      </div>

      <div class="e-grid two" style="gap:8px;margin-top:8px">
        <div class="e-field">
          <label for="perf-runway">Runway</label>
          <select class="e-select" id="perf-runway"><option value="">Not selected</option></select>
        </div>
        ${field('runwayLengthFt', 'TORA / LDA', state.runwayLengthFt, { unitLabel: 'ft' })}
        ${field('slopePct', 'Slope', state.slopePct, { unitLabel: '%', hint: 'Positive uphill in the direction of travel' })}
        <div class="e-field">
          <label for="perf-surface">Surface</label>
          <select class="e-select" id="perf-surface">
            ${[['dry', 'Dry'], ['wet', 'Wet'], ['contaminated', 'Contaminated']].map(([value, label]) => `<option value="${value}" ${state.surface === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        ${field('flap', 'Flap', state.flap, { placeholder: 'e.g. 1+F' })}
        ${field('thrust', 'Thrust / derate', state.thrust, { placeholder: 'e.g. TOGA' })}
      </div>

      <h3 style="margin-top:14px">Wind</h3>
      <div class="e-grid three" style="gap:8px">
        ${field('windFromDeg', 'From', state.windFromDeg, { unitLabel: '°' })}
        ${field('windKt', 'Speed', state.windKt, { unitLabel: 'kt' })}
        ${field('gustKt', 'Gust', state.gustKt, { unitLabel: 'kt' })}
      </div>
      <div class="e-small e-faint" style="margin-top:8px">Values marked <span class="e-badge accent" style="transform:scale(.9)">OFP</span> or <span class="e-badge accent" style="transform:scale(.9)">METAR</span> were filled from the plan or the observation; edit any of them.</div>`;

    const runwaySelect = formEl.querySelector('#perf-runway');
    function fillRunways() {
      const rows = airportRunwaysList;
      runwaySelect.innerHTML = ['<option value="">Not selected</option>', ...rows.map(row => `<option value="${row.heading}" ${String(row.heading) === String(state.runway) ? 'selected' : ''}>${esc(row.id)}${row.lengthFt ? ` · ${row.lengthFt.toLocaleString('en-US')} ft` : ''}</option>`)].join('');
    }
    fillRunways();

    (async () => {
      const airport = state.airport ? await airportByCode(state.airport).catch(() => null) : null;
      if (destroyed || !airport) return;
      airportRunwaysList.push(...airportRunways(airport));
      fillRunways();
    })();

    formEl.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('input', () => {
        set(input.dataset.key, input.value);
        renderResults();
      });
    });
    formEl.querySelector('#perf-aircraft').addEventListener('change', event => {
      set('aircraft', event.target.value);
      render();
    });
    formEl.querySelector('#perf-runway').addEventListener('change', event => {
      set('runway', event.target.value);
      const rows = airportRunwaysList.find(row => String(row.heading) === event.target.value);
      if (rows && rows.lengthFt) {
        // Only fill an empty length: a value the pilot typed is theirs.
        if (!String(state.runwayLengthFt || '').trim()) set('runwayLengthFt', rows.lengthFt);
      }
      render();
    });
    formEl.querySelector('#perf-surface').addEventListener('change', event => {
      set('surface', event.target.value);
      renderResults();
    });
    formEl.querySelectorAll('[data-phase]').forEach(button => {
      button.addEventListener('click', () => { set('phase', button.dataset.phase); render(); });
    });
    formEl.querySelector('[data-reset]').addEventListener('click', () => {
      for (const key of ['elevationFt', 'qnhHpa', 'oatC', 'runway', 'runwayLengthFt', 'slopePct', 'surface', 'flap', 'thrust', 'weight', 'windFromDeg', 'windKt', 'gustKt']) {
        delete state[key];
        delete state.prefill[key];
      }
      state.qnhHpa = 1013;
      state.surface = 'dry';
      saveInputs(state);
      render();
    });
  }

  function conditionRows(conditions) {
    return [
      ['Pressure altitude', conditions.pressureAltitudeFt != null ? fmtFt(conditions.pressureAltitudeFt) : '—'],
      ['ISA temperature', conditions.isaTemperatureC != null ? `${conditions.isaTemperatureC}°C` : '—'],
      ['ISA deviation', conditions.isaDeviationC != null ? `${conditions.isaDeviationC > 0 ? '+' : ''}${conditions.isaDeviationC}°C` : '—'],
      ['Density altitude', conditions.densityAltitudeFt != null ? fmtFt(conditions.densityAltitudeFt) : '—'],
    ];
  }

  function warningsFor(conditions) {
    const warnings = [];
    if (conditions.wind) {
      if (conditions.wind.tailwindKt > 0) warnings.push(`Tailwind of ${conditions.wind.tailwindKt} kt: performance data often excludes tailwind takeoffs.`);
      if (conditions.wind.crosswindKt >= 20) warnings.push(`Crosswind ${conditions.wind.crosswindKt} kt: check the type's demonstrated crosswind before dispatch.`);
      if (conditions.wind.gustKt && conditions.wind.gustKt > conditions.wind.speedKt) warnings.push(`Gusts to ${conditions.wind.gustKt} kt: use the gust for the wind components.`);
    }
    if (state.surface === 'contaminated') warnings.push('Contaminated runway: only a dataset that publishes contaminated distances can answer this. Surface condition factors are not applied by Stratos.');
    if (conditions.densityAltitudeFt != null && conditions.densityAltitudeFt > (state.elevationFt === '' ? 0 : Number(state.elevationFt)) + 2000) {
      warnings.push('Density altitude is more than 2,000 ft above field elevation.');
    }
    return warnings;
  }

  function conditionsCard(conditions) {
    const rows = conditionRows(conditions);
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>Conditions <em>computed</em></h3>
      <div class="e-grid two">
        <dl class="e-kv">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
        <div>
          ${conditions.wind ? `<dl class="e-kv">
            <dt>Runway</dt><dd>${conditions.wind.runwayHeading}°</dd>
            <dt>Wind</dt><dd>${String(conditions.wind.windFrom).padStart(3, '0')}° / ${conditions.wind.speedKt} kt${conditions.wind.gustKt ? ` G${conditions.wind.gustKt}` : ''}</dd>
            <dt>Head / tail</dt><dd>${conditions.wind.headwindKt >= 0 ? `${conditions.wind.headwindKt} kt head` : `${conditions.wind.tailwindKt} kt tail`}</dd>
            <dt>Crosswind</dt><dd>${conditions.wind.crosswindKt} kt${conditions.wind.crosswindSide !== 'none' ? ` from the ${conditions.wind.crosswindSide}` : ''}</dd>
          </dl>` : '<div class="e-small e-muted">Select a runway (or enter its heading) to resolve the wind.</div>'}
        </div>
      </div>
      ${state.runwayLengthFt ? `<div class="e-notice" style="margin-top:10px">Available ${esc(fmtFt(state.runwayLengthFt))}${state.slopePct ? ` · slope ${esc(state.slopePct)}%` : ''} · ${esc(state.surface)} runway</div>` : ''}
    </div>`;
  }

  function datasetCard() {
    const match = dataset && dataset.aircraft && String(dataset.aircraft.icao).toUpperCase() === String(state.aircraft).toUpperCase();
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>Aircraft dataset <span class="e-spacer"></span>
        ${dataset ? `<span class="e-badge ${match ? 'good' : 'warn'}">${match ? 'Loaded' : 'Different type'}</span>` : '<span class="e-badge bad">None</span>'}
      </h3>
      ${dataset ? `<div class="e-small e-muted">${esc(datasetLabel(dataset))}</div>
        ${match ? '' : `<div class="e-notice warn" style="margin-top:8px">The loaded dataset is for <b>${esc(aircraftLabel(dataset.aircraft.icao))}</b>. It will not be used for ${esc(aircraftLabel(state.aircraft))} — variant data is never shared.</div>`}
        <div class="e-row" style="margin-top:9px"><button class="e-btn small" type="button" data-replace>Replace dataset</button><button class="e-btn small ghost" type="button" data-clear>Remove</button></div>`
        : `<div class="e-notice warn"><div><b>No validated performance dataset is loaded.</b><br>V-speeds and field lengths are specific to one type, weight, flap, thrust and runway condition, and Stratos has not been licensed an approved dataset for the A340-600, A321 or 777. The app will not invent them.</div></div>
          <div class="e-small e-muted" style="margin-top:9px">Import an extract from a document you are entitled to use. Every result then names its source and revision, and any cell the dataset does not publish stays unavailable.</div>
          <div class="e-row" style="margin-top:9px"><button class="e-btn small primary" type="button" data-import>Import dataset…</button><button class="e-btn small" type="button" data-template>Download template</button></div>`}
      ${datasetError ? `<div class="e-notice bad" style="margin-top:8px">${esc(datasetError)}</div>` : ''}
      <input type="file" accept="application/json,.json" id="perf-file" hidden>
    </div>`;
  }

  function resultsCard() {
    if (!dataset) {
      return `<div class="e-card">
        <h3>Takeoff and landing figures</h3>
        <div class="e-empty"><b>Unavailable without an approved dataset</b>
          <p>This is not a missing feature: a V-speed or field length produced without the aircraft's own data would be a guess with a professional-looking font. Stratos shows the calculation framework and the conditions it can compute exactly, and refuses the rest.</p>
          <p class="e-small">A dataset is a JSON file with weight, pressure-altitude and temperature axes and the published values at each point. Download the template above for the exact shape.</p>
        </div>
      </div>`;
    }
    if (String(dataset.aircraft.icao).toUpperCase() !== String(state.aircraft).toUpperCase()) {
      return `<div class="e-card"><h3>Takeoff and landing figures</h3>
        <div class="e-notice warn">The loaded dataset is for another type, so no figures are produced. Load the dataset for ${esc(aircraftLabel(state.aircraft))}.</div></div>`;
    }
    const weight = Number(state.weight);
    const elevation = Number(state.elevationFt);
    const qnh = Number(state.qnhHpa);
    const oat = Number(state.oatC);
    if (![weight, elevation, qnh, oat].every(Number.isFinite)) {
      return `<div class="e-card"><h3>Takeoff and landing figures</h3><div class="e-notice">Enter the weight, elevation, QNH and OAT. The lookup needs all four.</div></div>`;
    }
    const pressureAltitude = pressureAltitudeFt(elevation, qnh);
    const lookup = lookupPerformance(dataset, state.phase, { weight, pressureAltitudeFt: pressureAltitude, oatC: oat });
    const phase = PHASE[state.phase];
    const distance = lookup[phase.distanceKey];
    const speeds = phase.speedKeys.map(key => [key, lookup[key]]);
    const available = Number(state.runwayLengthFt);
    const cell = entry => {
      if (!entry) return '<span class="e-faint">Not published</span>';
      if (entry.unavailable) return `<span class="e-faint">${esc(entry.unavailable)}</span>`;
      return fmtNum(entry.value);
    };
    const marginLine = distance && distance.value != null && Number.isFinite(available) && available > 0
      ? `<div class="e-notice ${available - distance.value < 0 ? 'bad' : 'good'}" style="margin-top:10px">${distance.value <= available ? `${fmtNum(available - distance.value)} ft of runway remaining` : `Required distance exceeds the available ${fmtFt(available)} by ${fmtNum(distance.value - available)} ft`}</div>`
      : '';
    return `<div class="e-card">
      <h3>${phase.label} figures <em>${esc(dataset.source)} · ${esc(dataset.revision)}</em></h3>
      <div class="e-grid three">
        <div><div class="e-label">${state.phase === 'takeoff' ? 'Takeoff distance' : 'Landing distance'}</div>
          <div class="e-big">${distance && distance.value != null ? `${fmtNum(distance.value)}<small class="e-small e-faint"> ft</small>` : '<span class="e-small e-faint">Unavailable</span>'}</div></div>
        ${speeds.map(([key, entry]) => `<div><div class="e-label">${esc(key.replace('Kt', '').toUpperCase())}</div>
          <div class="e-big">${entry && entry.value != null ? `${fmtNum(entry.value)}<small class="e-small e-faint"> kt</small>` : '<span class="e-small e-faint">Unavailable</span>'}</div></div>`).join('')}
      </div>
      ${marginLine}
      <dl class="e-kv" style="margin-top:12px">
        <dt>Lookup weight</dt><dd>${fmtNum(weight)} ${esc(unit)}</dd>
        <dt>Pressure altitude</dt><dd>${fmtFt(pressureAltitude)}</dd>
        <dt>OAT</dt><dd>${esc(oat)}°C</dd>
        <dt>Flap / thrust</dt><dd>${esc(state.flap || 'not specified')} · ${esc(state.thrust || 'not specified')}</dd>
      </dl>
      <div class="e-small e-faint" style="margin-top:9px">Interpolated between the dataset's published points. Not extrapolated. ${esc(dataset.mode === 'simulation' ? 'Simulation mode: not approved operational data.' : 'Operational dataset supplied by the operator.')}${dataset.approved ? '' : ' Unapproved.'}</div>
    </div>`;
  }

  function renderResults() {
    limitsAndWarnings();
  }

  function limitsAndWarnings() {
    const elevation = Number(state.elevationFt);
    const qnh = Number(state.qnhHpa);
    const oat = Number(state.oatC);
    const runwayHeading = state.runway !== '' ? Number(state.runway) : null;
    const conditions = analyseConditions({
      elevationFt: Number.isFinite(elevation) ? elevation : null,
      qnhHpa: Number.isFinite(qnh) ? qnh : 1013,
      oatC: Number.isFinite(oat) ? oat : null,
      runwayHeadingDeg: runwayHeading,
      windFromDeg: state.windFromDeg === '' ? null : Number(state.windFromDeg),
      windKt: state.windKt === '' ? null : Number(state.windKt),
      gustKt: state.gustKt === '' ? null : Number(state.gustKt),
      runwayLengthFt: state.runwayLengthFt,
      slopePct: state.slopePct,
    });
    const usable = Number.isFinite(elevation) && Number.isFinite(oat);
    const warnings = usable ? warningsFor(conditions) : [];
    resultsEl.innerHTML = `
      ${usable ? conditionsCard(conditions) : `<div class="e-card" style="margin-bottom:12px"><h3>Conditions</h3><div class="e-notice">Enter the airport elevation, QNH and OAT to compute pressure and density altitude.</div></div>`}
      ${warnings.length ? `<div class="e-notice warn" style="margin-bottom:12px"><div>${warnings.map(warning => esc(warning)).join('<br>')}</div></div>` : ''}
      ${datasetCard()}
      ${resultsCard()}
      <div class="e-card" style="margin-top:12px">
        <h3>Method and assumptions</h3>
        <dl class="e-kv">
          <dt>Pressure altitude</dt><dd>ISA barometric relationship from elevation and QNH</dd>
          <dt>Density altitude</dt><dd>Pressure altitude + 118.8 ft per °C from ISA</dd>
          <dt>Wind components</dt><dd>Vector resolution on the runway heading, gusts included</dd>
          <dt>Field length</dt><dd>Trilinear interpolation in the imported dataset, no extrapolation</dd>
          <dt>Not applied</dt><dd>Runway slope, contamination, bleed, anti-ice and obstacle corrections unless the dataset itself publishes the result</dd>
        </dl>
        <div class="e-small e-faint" style="margin-top:8px">Simulator planning aid. Not certified performance and not for real-world dispatch.</div>
      </div>`;
    wireDatasetButtons();
  }

  function wireDatasetButtons() {
    resultsEl.querySelector('[data-import]')?.addEventListener('click', () => resultsEl.querySelector('#perf-file')?.click());
    resultsEl.querySelector('[data-replace]')?.addEventListener('click', () => resultsEl.querySelector('#perf-file')?.click());
    resultsEl.querySelector('#perf-file')?.addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 400 * 1024) {
        datasetError = 'That file is larger than 400 KB. A dataset should be a small table, not a dump.';
        limitsAndWarnings();
        return;
      }
      try {
        const text = await file.text();
        const checked = validateDataset(JSON.parse(text));
        if (!checked.ok) {
          datasetError = `The dataset was rejected: ${checked.problems.slice(0, 3).join(' ')}`;
          limitsAndWarnings();
          return;
        }
        dataset = checked.dataset;
        datasetError = '';
        try { localStorage.setItem(DATASET_KEY, JSON.stringify(dataset)); } catch (_) { datasetError = 'The dataset works for this session but could not be stored on this device.'; }
        render();
      } catch (error) {
        datasetError = `That file is not valid JSON: ${error.message}`;
        limitsAndWarnings();
      }
    });
    resultsEl.querySelector('[data-clear]')?.addEventListener('click', () => {
      dataset = null;
      datasetError = '';
      try { localStorage.removeItem(DATASET_KEY); } catch (_) { /* nothing stored */ }
      render();
    });
    resultsEl.querySelector('[data-template]')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(templateDataset(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'stratos-performance-template.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  function render() {
    renderForm();
    limitsAndWarnings();
  }

  render();

  /* Prefill from the plan and the departure METAR, clearly labelled. */
  (async () => {
    if (!ofp) return;
    const origin = ofp.origin && ofp.origin.icao;
    if (origin && !state.airport) { state.airport = origin; state.prefill.airport = 'OFP'; }
    if (ofp.weights && ofp.weights.tow && !String(state.weight || '').trim()) {
      const value = unit === (ofp.units || 'kg') ? ofp.weights.tow : convertWeight(ofp.weights.tow, ofp.units || 'kg', unit);
      state.weight = Math.round(value);
      state.prefill.weight = 'OFP';
    }
    if (origin) {
      const airport = await airportByCode(origin).catch(() => null);
      if (airport && Number(airport.elev) && !String(state.elevationFt || '').trim()) {
        state.elevationFt = Number(airport.elev);
        state.prefill.elevationFt = 'airport';
      }
      const runwayId = ofp.origin.rwy;
      if (runwayId && !state.runway) {
        const row = airportRunways(airport).find(item => item.id.split('/').includes(runwayId));
        if (row) { state.runway = String(row.heading); state.prefill.runway = 'OFP'; }
      }
      const weather = await weatherFor(origin).catch(() => null);
      const metar = weather && weather.metar ? parseMetar(weather.metar) : null;
      if (metar) {
        if (metar.altimeter != null && !String(state.qnhHpa || '').trim()) {
          state.qnhHpa = metar.altimeterUnit === 'inHg' ? Math.round(metar.altimeter * 33.8639) : Math.round(metar.altimeter);
          state.prefill.qnhHpa = 'METAR';
        }
        if (metar.temperatureC != null && !String(state.oatC || '').trim()) {
          state.oatC = metar.temperatureC;
          state.prefill.oatC = 'METAR';
        }
        if (metar.wind && !String(state.windKt || '').trim()) {
          if (metar.wind.direction != null) { state.windFromDeg = metar.wind.direction; state.prefill.windFromDeg = 'METAR'; }
          state.windKt = metar.wind.speedKt;
          state.prefill.windKt = 'METAR';
          if (metar.wind.gustKt) { state.gustKt = metar.wind.gustKt; state.prefill.gustKt = 'METAR'; }
        }
      }
    }
    if (destroyed) return;
    saveInputs(state);
    render();
  })();

  return {
    destroy() { destroyed = true; },
  };
}

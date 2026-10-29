/* EFB · Performance.
 *
 * The page owns four things and nothing else:
 *
 *   Airframe   — the bundled profile, detected from X-Plane or chosen by hand.
 *   Inputs     — phase-correct airport and weight, weather/simulator prefill,
 *                every value editable.
 *   Calculate  — one explicit action that runs the engine.
 *   Results    — each figure labelled verified, interpolated, estimated or
 *                unavailable, with its source and limits.
 *
 * There is no file import. A profile ships with Stratos or the type is not
 * supported; the page says which.
 */

import {
  airportByCode, airportRunways, currentPlan, esc, fmtAge, fmtFt, fmtNum,
  liveStatus, loadPrefs, loadRouteMeta, onLive, weatherFor,
} from './common.js';
import { loadDatabase, profileById, profileLabel } from '../lib/performance-db.js';
import { matchAircraft } from '../lib/aircraft-match.js';
import { convertWeight, evaluatePhase } from '../lib/aircraftperformance.js';
import { parseMetar } from '../lib/routeweather.js';

const STATUS_TONE = { verified: 'good', interpolated: 'accent', estimated: 'warn', unavailable: 'bad' };
const STATUS_TEXT = { verified: 'Verified', interpolated: 'Interpolated', estimated: 'Estimated', unavailable: 'Unavailable' };
const CORRECTION_LABELS = {
  wind: 'wind', slope: 'runway slope', surface: 'surface/contamination', flaps: 'flaps',
  thrust: 'thrust/derate', antiIce: 'anti-ice', braking: 'braking', autobrake: 'autobrake',
};
const WEIGHT_RESULTS = new Set(['mtow', 'mlw', 'margin']);

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampOf(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function headingValue(row) {
  return row && numberOrNull(row.heading) != null ? String(row.heading) : '';
}

/* Match the planned runway to a real end. A suffix (16L) is used when the
 * source publishes it. A numeric snapshot cannot identify a parallel strip,
 * so a number shared by several runways is never guessed: the page asks. */
export function matchRunwayEnd(rows, planned) {
  const wanted = String(planned || '').trim().toUpperCase();
  if (!wanted) return { row: null, message: '' };
  const exact = rows.filter(row => String(row.id).trim().toUpperCase() === wanted);
  if (exact.length === 1) return { row: exact[0], message: '' };
  if (exact.length > 1) {
    return { row: null, message: `The plan names runway ${wanted}, but the airport record lists ${exact.length} runways with that identifier. Choose the one in use.` };
  }
  const number = wanted.replace(/[A-Z]$/, '');
  const sameNumber = rows.filter(row => String(row.id).trim().toUpperCase() === number);
  if (sameNumber.length === 1 && wanted === number) return { row: sameNumber[0], message: '' };
  if (sameNumber.length === 1) {
    return { row: null, message: `The plan names runway ${wanted}, but the airport record publishes only ${number}, without a parallel suffix. Choose the runway in use.` };
  }
  return {
    row: null,
    message: sameNumber.length > 1
      ? `The plan names runway ${wanted}, but the airport record lists ${sameNumber.length} parallel runways numbered ${number} and does not publish the suffix. Choose the one in use.`
      : `The plan names runway ${wanted}, which is not in the airport record. Choose one.`,
  };
}

/* A physical runway has two ends. The airport helper returns one row per pair
 * (08/26), so both ends are offered here with their own headings; otherwise a
 * plan that names 26 would be flown at 080°.
 *
 * Runway data from the simulator names the parallel strip (16L/34R); the
 * bundled snapshot sometimes carries only the numbers (16/34). Those are kept
 * as separate choices, marked ambiguous, because three physical runways cannot
 * honestly be collapsed into one "16". */
export function runwayEnds(rows) {
  const ends = [];
  const seen = new Set();
  for (const row of rows) {
    const heading = numberOrNull(row.heading);
    if (heading == null) continue;
    const [first, second] = String(row.id || '').split('/');
    for (const [id, endHeading] of [[first, heading], [second, (heading + 180) % 360]]) {
      if (!id) continue;
      const key = `${id}|${endHeading}|${row.lengthFt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ends.push({ key: String(ends.length + 1), id, heading: endHeading, lengthFt: row.lengthFt || null });
    }
  }
  const counts = {};
  for (const end of ends) counts[end.id] = (counts[end.id] || 0) + 1;
  return ends.map(end => ({ ...end, ambiguous: counts[end.id] > 1 }));
}

export async function mount(root, ctx) {
  let destroyed = false;
  const prefs = loadPrefs();
  const unit = prefs.units === 'lb' ? 'lb' : 'kg';
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const builtPlan = loadRouteMeta().plan;

  const state = {
    database: null,
    dbError: '',
    phase: 'takeoff',
    profileId: '',
    manualProfile: false,
    airport: '',
    airportName: '',
    airportMissing: false,
    elevationFt: '',
    qnhHpa: '',
    oatC: '',
    windFromDeg: '',
    windKt: '',
    gustKt: '',
    weight: '',
    runway: '',
    runwayLengthFt: '',
    prefill: {},
    manual: {},
    runwayRows: [],
    runwayMissing: '',
    weatherAt: 0,
    metarRaw: '',
    windVariable: false,
    detected: null,
    live: null,
    liveSignature: '',
    calculation: null,
    stale: false,
    errors: [],
    contextSeq: 0,
  };

  /* A SimBrief plan is used when one is stored. Without it, the route built in
   * the Flight Planner names its own airports and runways, so the page works
   * from that flight rather than asking for the airport a second time. */
  function phaseLeg() {
    if (ofp) return state.phase === 'landing' ? ofp.destination : ofp.origin;
    if (!builtPlan) return null;
    return state.phase === 'landing' ? builtPlan.destination : builtPlan.origin;
  }

  function phaseAirport() {
    const leg = phaseLeg();
    const code = leg && (leg.icao || leg.id);
    return String(code || '').trim().toUpperCase();
  }

  function phaseRunway() {
    const leg = phaseLeg();
    if (leg && leg.rwy) return String(leg.rwy).trim().toUpperCase();
    if (ofp) return '';
    const rwy = builtPlan && (state.phase === 'landing' ? builtPlan.arrivalRwy : builtPlan.departureRwy);
    return String(rwy || '').trim().toUpperCase();
  }

  function planWeightKg() {
    if (!ofp || !ofp.weights) return null;
    const value = state.phase === 'landing' ? ofp.weights.lw : ofp.weights.tow;
    return numberOrNull(value) != null ? convertWeight(value, ofp.units || 'kg', 'kg') : null;
  }

  function displayWeight(kg) {
    return kg == null ? '' : String(Math.round(convertWeight(kg, 'kg', unit)));
  }

  function setPrefill(key, value, source) {
    state[key] = value;
    state.prefill[key] = source;
  }

  function clearPhaseFields() {
    for (const key of ['airportName', 'elevationFt', 'qnhHpa', 'oatC', 'windFromDeg', 'windKt', 'gustKt', 'runway', 'runwayLengthFt']) {
      state[key] = '';
    }
    state.airport = '';
    state.airportMissing = false;
    state.weight = '';
    state.prefill = {};
    state.manual = {};
    state.runwayRows = [];
    state.runwayMissing = '';
    state.weatherAt = 0;
    state.metarRaw = '';
    state.windVariable = false;
    state.calculation = null;
    state.stale = false;
    state.errors = [];
  }

  function loadPlanPhase() {
    clearPhaseFields();
    state.airport = phaseAirport();
    const kg = planWeightKg();
    if (kg != null) setPrefill('weight', displayWeight(kg), 'flight plan');
  }

  function simPerformance() {
    return state.live && state.live.performance ? state.live.performance : null;
  }

  function applySimulatorFields() {
    const sim = simPerformance();
    if (!sim) return;
    const simWeight = numberOrNull(sim.weightKg);
    if (simWeight != null && !state.manual.weight) {
      if (state.phase === 'takeoff' || planWeightKg() == null) {
        setPrefill('weight', displayWeight(simWeight), 'X-Plane');
      }
    }
    const qnh = numberOrNull(sim.qnhHpa);
    if (qnh != null && !state.manual.qnhHpa) setPrefill('qnhHpa', String(Math.round(qnh)), 'X-Plane');
  }

  function airportRunwayRows() {
    return state.runwayRows;
  }

  function adoptRunway(row) {
    if (!state.manual.runway) state.runway = row.key;
    if (!state.manual.runwayLengthFt && row.lengthFt) setPrefill('runwayLengthFt', String(row.lengthFt), 'airport database');
  }

  function matchPlannedRunway() {
    // A runway belongs to the airport the plan names. After the pilot types a
    // different airport, its runway is not a fact about this one.
    const planned = state.airport === phaseAirport() ? phaseRunway() : '';
    const match = matchRunwayEnd(airportRunwayRows(), planned);
    state.runwayMissing = match.message;
    if (match.row) adoptRunway(match.row);
  }

  async function hydratePhase() {
    const token = ++state.contextSeq;
    const code = String(state.airport || '').trim().toUpperCase();
    state.airport = code;
    state.airportName = '';
    state.airportMissing = false;
    state.runwayRows = [];
    if (!code) {
      state.runwayMissing = '';
      if (!destroyed && token === state.contextSeq) render();
      return;
    }

    const airport = await airportByCode(code).catch(() => null);
    if (destroyed || token !== state.contextSeq) return;
    if (airport) {
      state.airportName = String(airport.name || '');
      state.runwayRows = runwayEnds(airportRunways(airport));
      const elevation = numberOrNull(airport.elev);
      if (elevation != null && !state.manual.elevationFt) setPrefill('elevationFt', String(Math.round(elevation)), 'airport database');
      matchPlannedRunway();
    } else {
      state.runwayRows = [];
      state.airportMissing = true;
    }
    // The airport record is local; weather is not. Draw the elevation, runway
    // and length as soon as they are known instead of holding them behind a
    // network request.
    if (!destroyed && token === state.contextSeq) render();

    const weather = await weatherFor(code).catch(() => null);
    if (destroyed || token !== state.contextSeq) return;
    const metar = weather && weather.metar ? parseMetar(weather.metar) : null;
    if (metar) {
      state.metarRaw = weather.metar;
      state.weatherAt = timestampOf((weather.decoded && weather.decoded.obs_time) || weather.obs_time || weather.fetchedAt);
      if (metar.temperatureC != null && !state.manual.oatC) setPrefill('oatC', String(metar.temperatureC), 'METAR');
      if (metar.altimeter != null && !state.manual.qnhHpa && state.prefill.qnhHpa !== 'X-Plane') {
        const qnh = metar.altimeterUnit === 'inHg' ? metar.altimeter * 33.8639 : metar.altimeter;
        setPrefill('qnhHpa', String(Math.round(qnh)), 'METAR');
      }
      if (metar.wind) {
        state.windVariable = metar.wind.direction == null;
        if (metar.wind.direction != null && !state.manual.windFromDeg) setPrefill('windFromDeg', String(metar.wind.direction), 'METAR');
        if (metar.wind.speedKt != null && !state.manual.windKt) setPrefill('windKt', String(metar.wind.speedKt), 'METAR');
        if (metar.wind.gustKt != null && !state.manual.gustKt) setPrefill('gustKt', String(metar.wind.gustKt), 'METAR');
      }
    }
    applySimulatorFields();
    if (!destroyed && token === state.contextSeq) render();
  }

  function profile() {
    return profileById(state.database, state.profileId);
  }

  function detect() {
    const health = liveStatus().health;
    const identity = (health && health.xplaneIdentity) || {};
    const stored = (health && health.identity) || {};
    const snapshot = liveStatus().snapshot || {};
    const telemetry = snapshot.telemetry || snapshot.parsed || {};
    const description = String(stored.aircraft || telemetry.aircraft || '').trim();
    const type = String(identity.type || telemetry.aircraftType || '').trim();
    const match = matchAircraft(state.database, { icaoType: type, description });
    state.detected = { ...match, type, description };
    if (!state.manualProfile) {
      if (match.profile) {
        if (state.profileId !== match.profile.id) {
          state.profileId = match.profile.id;
          state.calculation = null;
          state.stale = false;
        }
      } else if (type) {
        // X-Plane now reports a type the database does not cover. Keeping the
        // previous airframe's profile would silently calculate for the wrong
        // aircraft; clear it and let the page say the type is unsupported.
        state.profileId = '';
        state.calculation = null;
        state.stale = false;
      }
    }
  }

  function applyLive(status) {
    if (destroyed || !state.database) return;
    const health = status && status.health;
    const identity = (health && health.xplaneIdentity) || {};
    const performance = (health && health.xplanePerformance) || null;
    const stored = (health && health.identity) || {};
    // The performance inputs are a pre-takeoff snapshot. Fuel burn changes the
    // simulated weight every refresh; re-rendering the whole page for that would
    // move the fields under the pilot. Only a new airframe re-runs detection and
    // prefill. The latest values are still kept for the next phase switch.
    const signature = JSON.stringify({
      type: identity.type || '',
      description: stored.aircraft || '',
      available: Boolean(identity.available),
    });
    state.live = { performance };
    if (signature !== state.liveSignature) {
      state.liveSignature = signature;
      detect();
      applySimulatorFields();
      if (state.calculation) state.stale = true;
      render();
    }
  }

  function field(key, label, value, options = {}) {
    const source = state.prefill[key] ? `<span class="e-badge accent">${esc(state.prefill[key])}</span>` : '';
    return `<div class="e-field">
      <label for="perf-${key}">${esc(label)} ${source}</label>
      <div class="e-row" style="gap:6px;flex-wrap:nowrap">
        <input class="e-input small" id="perf-${key}" data-key="${key}" type="${options.type || 'text'}" inputmode="decimal" value="${esc(value)}" placeholder="${esc(options.placeholder || '')}">
        ${options.unit ? `<span class="e-small e-faint" style="min-width:28px">${esc(options.unit)}</span>` : ''}
      </div>
      ${options.hint ? `<span class="e-hint">${esc(options.hint)}</span>` : ''}
    </div>`;
  }

  function detectionCard() {
    const detected = state.detected;
    const live = liveStatus();
    const current = profile();
    const detectedHere = Boolean(detected && detected.profile && current && detected.profile.id === current.id);
    let line;
    let tone;
    if (detectedHere) {
      line = `Detected ${profileLabel(current)} — ${detected.reason}`;
      tone = 'good';
    } else if (current) {
      line = `Using ${profileLabel(current)}${state.manualProfile ? ', chosen by hand' : ''}.`;
      if (live.status !== 'offline' && detected && detected.reason) line += ` ${detected.reason}`;
      tone = 'accent';
    } else if (detected && detected.profile) {
      line = `Detection found ${profileLabel(detected.profile)}. Choose it below or select another profile.`;
      tone = 'warn';
    } else if (detected && detected.type) {
      line = detected.reason;
      tone = 'warn';
    } else {
      line = live.status === 'offline'
        ? 'The Stratos bridge is offline, so no airframe can be detected. Choose a profile below.'
        : live.status === 'waiting' || live.status === 'connecting'
          ? 'The bridge is running but X-Plane has not reported an airframe yet. Choose a profile below.'
          : 'No airframe reported by X-Plane. Choose a profile below.';
      tone = 'warn';
    }
    const badge = detectedHere ? 'Detected' : current ? 'Selected' : 'No profile';
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>Airframe <span class="e-spacer"></span><span class="e-badge ${tone}">${badge}</span></h3>
      <p class="e-small ${tone === 'warn' ? 'e-muted' : ''}" role="status">${esc(line)}</p>
      <div class="e-field" style="margin-top:10px">
        <label for="perf-profile">Aircraft profile</label>
        <select class="e-select" id="perf-profile">
          <option value="">Choose a profile…</option>
          ${(state.database ? state.database.profiles : []).map(item => `<option value="${esc(item.id)}" ${item.id === state.profileId ? 'selected' : ''}>${esc(profileLabel(item))} · ${esc(item.icao)}</option>`).join('')}
        </select>
      </div>
      <div class="e-small e-faint" style="margin-top:6px">${current
        ? 'The profile ships with Stratos; no file is imported.'
        : 'No profile is selected. Detection is a convenience, not a requirement.'}</div>
      ${state.manualProfile && detected && detected.profile && detected.profile.id !== state.profileId
        ? `<div class="e-row" style="margin-top:8px"><button class="e-btn small" type="button" data-use-detected>Use detected ${esc(profileLabel(detected.profile))}</button></div>`
        : ''}
    </div>`;
  }

  function formCard() {
    const runwayOptions = ['<option value="">Not selected</option>', ...state.runwayRows.map(row => `<option value="${esc(row.key)}" ${row.key === state.runway ? 'selected' : ''}>${esc(row.id)} · ${esc(headingValue(row))}°${row.lengthFt ? ` · ${fmtNum(row.lengthFt)} ft` : ''}${row.ambiguous ? ' · suffix not published' : ''}</option>`)].join('');
    return `<div class="e-card">
      <h3>Inputs <span class="e-spacer"></span><span class="e-badge">${state.phase === 'takeoff' ? 'Takeoff' : 'Landing'}</span></h3>
      <div class="e-row" style="margin-bottom:10px">
        <div class="e-seg" role="group" aria-label="Phase">
          <button type="button" data-phase="takeoff" aria-pressed="${state.phase === 'takeoff'}">Takeoff</button>
          <button type="button" data-phase="landing" aria-pressed="${state.phase === 'landing'}">Landing</button>
        </div>
      </div>

      <div class="e-grid two" style="gap:8px">
        <div class="e-field">
          <label for="perf-airport">Airport (ICAO)</label>
          <input class="e-input small" id="perf-airport" value="${esc(state.airport)}" placeholder="LFPG" autocomplete="off" spellcheck="false">
          ${state.airportName ? `<span class="e-hint">${esc(state.airportName)}</span>` : ''}
          ${state.airportMissing ? '<span class="e-hint">No airport record for this code; enter elevation and runway length manually. Wind components stay unresolved without a runway heading.</span>' : ''}
        </div>
        ${field('weight', state.phase === 'takeoff' ? 'Takeoff weight' : 'Landing weight', state.weight, { unit, hint: 'From X-Plane or the plan; edit it here' })}
        ${field('elevationFt', 'Elevation', state.elevationFt, { unit: 'ft' })}
        ${field('qnhHpa', 'QNH', state.qnhHpa, { unit: 'hPa' })}
        ${field('oatC', 'OAT', state.oatC, { unit: '°C' })}
        <div class="e-field">
          <label for="perf-runway">Runway</label>
          <select class="e-select" id="perf-runway">${runwayOptions}</select>
          ${state.runwayMissing ? `<span class="e-hint">${esc(state.runwayMissing)}</span>` : ''}
        </div>
        ${field('runwayLengthFt', 'TORA / LDA', state.runwayLengthFt, { unit: 'ft', hint: 'Used for the margin when a licensed field-length table exists.' })}
      </div>

      <h3 style="margin-top:14px">Wind</h3>
      <div class="e-grid three" style="gap:8px">
        ${field('windFromDeg', 'From', state.windFromDeg, { unit: '°' })}
        ${field('windKt', 'Speed', state.windKt, { unit: 'kt' })}
        ${field('gustKt', 'Gust', state.gustKt, { unit: 'kt' })}
      </div>
      ${state.windVariable ? '<div class="e-small e-faint" style="margin-top:6px">The observation reports a variable wind direction; enter the runway-relevant direction.</div>' : ''}
      ${correctionNotice()}
      <div class="e-row" style="margin-top:12px">
        <button class="e-btn primary" type="button" data-calculate>Calculate</button>
        ${state.stale ? '<span class="e-badge warn">Inputs changed</span>' : ''}
      </div>
      <div class="e-small e-faint" style="margin-top:8px">Every value can be edited. Badges show where a prefill came from; an edit replaces it.</div>
      <div class="e-small e-faint" style="margin-top:4px">Airframe data: ${state.database ? `${esc(state.database.source.name)} · version ${esc(state.database.version)}` : 'not loaded'}.</div>
      ${state.weatherAt ? `<div class="e-small e-faint" style="margin-top:4px">Weather prefill: METAR observed ${esc(fmtAge(state.weatherAt))}.${state.metarRaw ? `<details style="margin-top:3px"><summary>Raw observation</summary><div style="word-break:break-word">${esc(state.metarRaw)}</div></details>` : ''}</div>` : ''}
    </div>`;
  }

  function correctionNotice() {
    const current = profile();
    const corrections = current && current.corrections;
    if (!corrections || corrections.status !== 'unsupported') return '';
    const axes = (corrections.axes || []).map(axis => CORRECTION_LABELS[axis] || axis);
    return `<div class="e-notice" style="margin-top:12px"><div>
      <b>No performance correction is applied for ${esc(axes.join(', '))}.</b><br>${esc(corrections.reason)}
      These inputs are not offered, because a value would not change any result.
    </div></div>`;
  }

  function conditionsCard(conditions) {
    const rows = [
      ['Pressure altitude', conditions.pressureAltitudeFt != null ? fmtFt(conditions.pressureAltitudeFt) : '—'],
      ['ISA temperature', conditions.isaTemperatureC != null ? `${conditions.isaTemperatureC}°C` : '—'],
      ['ISA deviation', conditions.isaDeviationC != null ? `${conditions.isaDeviationC > 0 ? '+' : ''}${conditions.isaDeviationC}°C` : '—'],
      ['Density altitude', conditions.densityAltitudeFt != null ? fmtFt(conditions.densityAltitudeFt) : '—'],
    ];
    const wind = conditions.wind;
    return `<div class="e-card" style="margin-bottom:12px">
      <h3>Conditions <em>computed</em></h3>
      <div class="e-grid two">
        <dl class="e-kv">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
        <div>
          ${wind ? `<dl class="e-kv">
            <dt>Runway</dt><dd>${wind.runwayHeading}°</dd>
            <dt>Wind</dt><dd>${String(wind.windFrom).padStart(3, '0')}° / ${wind.speedKt} kt${wind.gustKt ? ` G${wind.gustKt}` : ''}</dd>
            <dt>Head / tail</dt><dd>${wind.headwindKt >= 0 ? `${wind.headwindKt} kt head` : `${wind.tailwindKt} kt tail`}</dd>
            <dt>Crosswind</dt><dd>${wind.crosswindKt} kt${wind.crosswindSide !== 'none' ? ` from the ${wind.crosswindSide}` : ''}</dd>
          </dl>` : '<div class="e-small e-muted">Select a runway and enter wind to resolve the components.</div>'}
        </div>
      </div>
      <div class="e-small e-faint" style="margin-top:9px">Atmosphere and wind are computed from the inputs; they are not aircraft-specific data. Missing values stay missing.</div>
    </div>`;
  }

  function tile(item) {
    const isWeight = WEIGHT_RESULTS.has(item.id);
    const value = isWeight && item.value != null ? convertWeight(item.value, 'kg', unit) : item.value;
    const unitText = item.unit ? ` ${esc(isWeight ? unit : item.unit)}` : '';
    const tone = STATUS_TONE[item.status] || '';
    return `<div class="perf-tile">
      <div class="e-label">${esc(item.label)}</div>
      <div class="e-big">${value != null ? `${fmtNum(value)}<small class="e-small e-faint">${unitText}</small>` : '<span class="e-small e-faint">Unavailable</span>'}</div>
      <div class="e-row" style="margin-top:4px"><span class="e-badge ${tone}">${esc(STATUS_TEXT[item.status] || item.status)}</span></div>
      <div class="e-small e-faint" style="margin-top:5px">${esc(item.note)}</div>
      ${item.source ? `<div class="perf-source">${esc(item.source)}</div>` : ''}
    </div>`;
  }

  function sourceCard(profileData, evaluation) {
    const source = profileData.source || {};
    const range = profileData.operatingRange || {};
    return `<div class="e-card" style="margin-top:12px">
      <h3>Data source and limits</h3>
      <dl class="e-kv">
        <dt>Profile</dt><dd>${esc(profileLabel(profileData))} (${esc(profileData.icao)})</dd>
        <dt>Source</dt><dd>${esc(source.name || '')} · record ${esc(source.record || '')} · ${esc(source.release || '')}${source.retrieved ? ` · retrieved ${esc(source.retrieved)}` : ''}${source.url ? `<br><a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.url)}</a>` : ''}</dd>
        <dt>Database</dt><dd>${esc(state.database.version)} · released ${esc(state.database.released)} · ${esc(state.database.schema)}</dd>
        <dt>Verification</dt><dd>${esc(profileData.verification)}</dd>
        <dt>Data units</dt><dd>${esc(profileData.units.weight)}, ${esc(profileData.units.distance)}, ${esc(profileData.units.speed)}</dd>
        <dt>Input window</dt><dd>${range.weightKg ? `${range.weightKg[0]}–${range.weightKg[1]} kg` : '—'} · ${range.pressureAltitudeFt ? `${range.pressureAltitudeFt[0]}–${range.pressureAltitudeFt[1]} ft PA` : '—'} · ${range.oatC ? `${range.oatC[0]}–${range.oatC[1]}°C` : '—'}${range.basis ? `<br><span class="e-faint">${esc(range.basis)}</span>` : ''}</dd>
        <dt>${evaluation.phase === 'takeoff' ? 'Takeoff data' : 'Landing data'}</dt><dd>${profileData[evaluation.phase].status === 'supported' ? 'Licensed table bundled' : esc(profileData[evaluation.phase].reason)}</dd>
      </dl>
      <div class="e-small e-faint" style="margin-top:9px">${esc((profileData.corrections && profileData.corrections.reason) || 'This profile publishes no correction factors.')} A field length is never shown unless a licensed table publishes it.</div>
    </div>`;
  }

  function outputHtml() {
    if (state.dbError) {
      return `<div class="e-card"><h3>Performance database</h3><div class="e-notice bad"><div>${esc(state.dbError)}</div></div></div>`;
    }
    if (!state.database) return '<div class="e-card"><h3>Performance database</h3><div class="e-small e-muted">Loading…</div></div>';

    const current = profile();
    const errors = state.errors.length
      ? `<div class="e-notice warn" style="margin-bottom:12px"><div>${state.errors.map(error => esc(error)).join('<br>')}</div></div>`
      : '';

    if (!current) {
      return `${errors}<div class="e-card"><h3>Calculate</h3>
        <div class="e-empty"><b>Choose an aircraft profile</b>
          <p>Detection uses the X-Plane airframe. If it reports a type that is not in the bundled database, select a profile by hand or accept that this type is unsupported.</p>
          <p class="e-small">Supported profiles: ${state.database.profiles.map(item => esc(`${item.manufacturer} ${item.name}`)).join(', ')}.</p>
        </div></div>`;
    }

    if (!state.calculation) {
      const blocked = state.errors.length > 0;
      return `${errors}<div class="e-card"><h3>Calculate</h3>
        <div class="e-empty"><b>${blocked ? 'Not ready to calculate' : 'Review the inputs'}</b>
          <p>${blocked
            ? 'Enter the missing values above, then press Calculate.'
            : 'The inputs are prefilled from X-Plane, the flight plan, the airport database and the METAR where available. Check them, then press Calculate.'}</p>
          <p class="e-small">${esc(current.takeoff.status === 'unsupported' || current.landing.status === 'unsupported'
            ? 'This profile publishes weight limits and approach speed, but no licensed field-length table; field lengths will be shown as unavailable.'
            : 'This profile publishes a licensed field-length table.')}</p>
        </div></div>`;
    }

    const evaluation = state.calculation;
    const profileData = current;
    const supported = evaluation.supported;
    const phaseName = evaluation.phase === 'takeoff' ? 'Takeoff' : 'Landing';
    return `${errors}<div class="e-card" style="margin-bottom:12px">
      <h3>${phaseName} · ${esc(profileLabel(profileData))} <span class="e-spacer"></span><span class="e-badge ${supported ? 'good' : 'warn'}">${supported ? 'Table' : 'Limits only'}</span></h3>
      ${state.stale ? '<div class="e-notice warn" style="margin-bottom:10px"><div>Inputs changed since the calculation. Press Calculate again.</div></div>' : ''}
      <div class="perf-results">${evaluation.results.map(tile).join('')}</div>
      ${evaluation.warnings.length ? `<div class="e-notice warn" style="margin-top:12px"><div>${evaluation.warnings.map(esc).join('<br>')}</div></div>` : ''}
      <div class="e-small e-faint" style="margin-top:10px">${esc(evaluation.note || '')}</div>
    </div>
    ${conditionsCard(evaluation.conditions)}
    ${sourceCard(profileData, evaluation)}
    <div class="e-card" style="margin-top:12px">
      <h3>Method</h3>
      <dl class="e-kv">
        <dt>Pressure altitude</dt><dd>ISA barometric relationship from field elevation and QNH</dd>
        <dt>Density altitude</dt><dd>Pressure altitude + 118.8 ft per °C from ISA</dd>
        <dt>Wind</dt><dd>Vector resolution on the selected runway heading, gusts included</dd>
        <dt>Limits</dt><dd>Published MTOW/MLW from the FAA ACD; the margin is the limit minus the entered weight</dd>
        <dt>Field lengths</dt><dd>Published table interpolation only, inside its axes. No extrapolation and no model.</dd>
      </dl>
      <div class="e-small e-faint" style="margin-top:8px">Simulator planning aid. Not certified performance and not for real-world dispatch.</div>
    </div>`;
  }

  function render() {
    root.innerHTML = `<div class="perf-layout" id="perf-layout">
      <div class="perf-column">${detectionCard()}${formCard()}</div>
      <div class="perf-column" id="perf-output">${outputHtml()}</div>
    </div>`;
    wire();
  }

  function readInput(input) {
    const key = input.dataset.key;
    if (!key) return;
    state[key] = input.value;
    state.manual[key] = true;
    // The value is now the pilot's, so the source badge must stop claiming it
    // came from METAR or X-Plane.
    delete state.prefill[key];
    input.closest('.e-field')?.querySelector('.e-badge.accent')?.remove();
    state.errors = [];
    if (state.calculation) state.stale = true;
    updateOutput();
  }

  function updateOutput() {
    const output = root.querySelector('#perf-output');
    if (output) output.innerHTML = outputHtml();
    const stale = root.querySelector('[data-calculate]');
    if (stale) {
      const row = stale.closest('.e-row');
      if (row) {
        const badge = row.querySelector('.e-badge.warn');
        if (state.stale && !badge) row.insertAdjacentHTML('beforeend', '<span class="e-badge warn">Inputs changed</span>');
        if (!state.stale && badge) badge.remove();
      }
    }
  }

  function calculate() {
    const current = profile();
    const errors = [];
    if (!current) errors.push('Choose an aircraft profile.');
    if (!String(state.airport || '').trim()) errors.push('Enter the airport ICAO.');
    if (numberOrNull(state.weight) == null || Number(state.weight) <= 0) errors.push('Enter the aircraft weight.');
    if (numberOrNull(state.elevationFt) == null) errors.push('Enter the airport elevation.');
    const qnh = numberOrNull(state.qnhHpa);
    if (qnh == null) errors.push('Enter the QNH.');
    else if (qnh < 850 || qnh > 1085) errors.push('Enter a QNH between 850 and 1085 hPa.');
    if (numberOrNull(state.oatC) == null) errors.push('Enter the OAT.');
    const wind = numberOrNull(state.windKt);
    if (wind != null && wind < 0) errors.push('Wind speed cannot be negative.');
    const gust = numberOrNull(state.gustKt);
    if (gust != null && gust < 0) errors.push('Gust cannot be negative.');
    const runwayLength = numberOrNull(state.runwayLengthFt);
    if (runwayLength != null && runwayLength <= 0) errors.push('Runway length must be positive.');
    if (errors.length) {
      state.errors = errors;
      state.calculation = null;
      updateOutput();
      return;
    }
    state.errors = [];
    const evaluation = evaluatePhase(current, state.phase, {
      weight: state.weight,
      elevationFt: state.elevationFt,
      qnhHpa: state.qnhHpa,
      oatC: state.oatC,
      windFromDeg: state.windFromDeg,
      windKt: state.windKt,
      gustKt: state.gustKt,
      runwayHeadingDeg: numberOrNull((state.runwayRows.find(row => row.key === state.runway) || {}).heading),
      runwayLengthFt: state.runwayLengthFt,
      units: { weight: unit, distance: 'ft' },
    });
    state.calculation = evaluation;
    state.stale = false;
    render();
  }

  function switchPhase(phase) {
    if (phase === state.phase) return;
    state.phase = phase;
    loadPlanPhase();
    applySimulatorFields();
    state.calculation = null;
    state.stale = false;
    state.errors = [];
    render();
    hydratePhase();
  }

  function wire() {
    root.querySelector('#perf-profile')?.addEventListener('change', event => {
      state.manualProfile = true;
      state.profileId = event.target.value;
      state.calculation = null;
      state.stale = false;
      state.errors = [];
      render();
    });
    root.querySelector('[data-use-detected]')?.addEventListener('click', () => {
      if (!state.detected || !state.detected.profile) return;
      state.manualProfile = false;
      state.profileId = state.detected.profile.id;
      state.calculation = null;
      state.stale = false;
      state.errors = [];
      render();
    });
    root.querySelectorAll('[data-phase]').forEach(button => {
      button.addEventListener('click', () => switchPhase(button.dataset.phase));
    });
    root.querySelector('#perf-airport')?.addEventListener('change', async event => {
      state.airport = String(event.target.value || '').trim().toUpperCase();
      for (const key of ['elevationFt', 'qnhHpa', 'oatC', 'windFromDeg', 'windKt', 'gustKt', 'runway', 'runwayLengthFt']) {
        state[key] = '';
        delete state.prefill[key];
        delete state.manual[key];
      }
      state.runwayRows = [];
      state.runwayMissing = '';
      state.weatherAt = 0;
      state.metarRaw = '';
      state.calculation = null;
      state.stale = false;
      state.errors = [];
      render();
      await hydratePhase();
    });
    root.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('input', () => readInput(input));
    });
    root.querySelector('#perf-runway')?.addEventListener('change', event => {
      state.runway = String(event.target.value || '');
      state.manual.runway = true;
      const row = state.runwayRows.find(item => item.key === state.runway);
      if (row && row.lengthFt && !state.manual.runwayLengthFt) setPrefill('runwayLengthFt', String(row.lengthFt), 'airport database');
      if (state.calculation) state.stale = true;
      state.errors = [];
      render();
    });
    root.querySelector('[data-calculate]')?.addEventListener('click', calculate);
  }

  root.innerHTML = '<div class="e-card"><h3>Performance</h3><div class="e-small e-muted">Loading the bundled performance database…</div></div>';

  try {
    state.database = await loadDatabase();
  } catch (error) {
    state.dbError = error.message;
    if (!destroyed) render();
    return { destroy() { destroyed = true; } };
  }
  if (destroyed) return { destroy() { destroyed = true; } };

  loadPlanPhase();
  applySimulatorFields();
  detect();
  render();

  const unsubscribe = onLive(applyLive);
  hydratePhase();

  return {
    destroy() {
      destroyed = true;
      unsubscribe?.();
    },
  };
}

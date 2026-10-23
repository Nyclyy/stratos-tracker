// Flight summary panel for the Flight Planning sheet. Builds the summary from the
// route and the saved SimBrief plan, then renders it as HTML. Pure apart from
// buildSummary's clock, so the Flight Deck page can call it from its classic script.
import { overviewHeader, overviewAircraft, OVERVIEW_TABS, activeTab } from './lib/overview.js';
import {
  buildSummary,
  parseOfp,
  saveOfp,
  loadOfp,
  clearOfp,
  fmtMinutes,
  fmtUtc,
} from './lib/flightsummary.js';

export { parseOfp, saveOfp, loadOfp, clearOfp };

/** Planned altitude (ft) for a fix in the saved SimBrief plan, or null when the plan has none. */
export function plannedAltitudeFt(ofp, ident) {
  if (!ofp || !Array.isArray(ofp.fixes) || !ident) return null;
  const key = String(ident).toUpperCase();
  const fix = ofp.fixes.find(f => String(f.ident || '').toUpperCase() === key);
  return fix && fix.altFt > 0 ? fix.altFt : null;
}

const SOURCE_LABEL = { ofp: 'SimBrief', stratos: 'Stratos', live: 'Live' };
const spriteAtlas = typeof Image === 'undefined' ? null : new Image();
if (spriteAtlas) spriteAtlas.src = 'images/aircraft/spritesheet.png';

function queueAircraftSprite() {
  // HTML is inserted by the caller immediately after rendering the panel.
  if (!spriteAtlas || typeof document === 'undefined') return;
  const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
  schedule(() => {
    document.querySelectorAll('canvas[data-aircraft-sprite]').forEach(canvas => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const ids = (canvas.dataset.aircraftFrames || '').split(',').map(Number).filter(Number.isFinite);
      if (!ids.length) return;
      let frame = 0;
      const paint = () => {
        if (!canvas.isConnected) return;
        if (spriteAtlas?.complete && spriteAtlas.naturalWidth) {
          ctx.clearRect(0, 0, 72, 72);
          ctx.drawImage(spriteAtlas, (ids[frame] % 8) * 72, Math.floor(ids[frame] / 8) * 72, 72, 72, 0, 0, 72, 72);
        }
        if (ids.length > 1) setTimeout(() => { frame = (frame + 1) % ids.length; paint(); }, 50);
      };
      if (!spriteAtlas) return;
      if (spriteAtlas.complete) paint();
      else spriteAtlas.addEventListener('load', paint, { once: true });
    });
  });
}

/** Header and aircraft block for the overview. Every value is real or a dash. */
export function overviewBlockHtml({ header, aircraft }) {
  const img = aircraft.sprite
    ? `<canvas class="ov-aircraft-img ov-aircraft-sprite" width="72" height="72" data-aircraft-sprite="${esc(aircraft.sprite.name)}" data-aircraft-frames="${esc(aircraft.sprite.ids.join(','))}" aria-label="${esc(aircraft.name)} icon" role="img"></canvas>`
    : aircraft.image
      ? `<img class="ov-aircraft-img" src="${esc(aircraft.image)}" alt="${esc(aircraft.name)} illustration" loading="lazy">`
      : '<div class="ov-aircraft-img ov-aircraft-none">No image</div>';
  const time = (t) => `${esc(t.scheduled)} sched · ${esc(t.estimated)} est`;
  const status = (t) => (t.status ? `<span class="ov-status ov-${esc(t.status.key)}">${esc(t.status.label)}</span>` : '');
  return `<div class="ov-head">
    <div><b class="ov-callsign">${esc(header.callsign)}</b> <span class="m">${esc(header.operator)}</span></div>
    <div class="ov-route"><b>${esc(header.dep)}</b> <span class="m">→</span> <b>${esc(header.arr)}</b>${header.alternate ? ` <span class="m">· alt ${esc(header.alternate.icao)}${header.alternate.name !== '\u2014' ? ' ' + esc(header.alternate.name) : ''}</span>` : ''}</div>
    <div class="m">Dep ${time(header.departure)} ${status(header.departure)} · Arr ${time(header.arrival)} ${status(header.arrival)} <span class="m">(${esc(header.timeZone)})</span></div>
  </div>
  <div class="ov-aircraft">${img}
    <div><b>${esc(aircraft.name)}</b> <span class="m">${esc(aircraft.type)}</span>
    <div class="m">Registration ${esc(aircraft.registration)}${aircraft.livery ? ' · ' + esc(aircraft.livery) : ''}</div></div>
  </div>`;
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function sourceTag(source) {
  return source && SOURCE_LABEL[source] ? `<span class="fs-src">${SOURCE_LABEL[source]}</span>` : '';
}

function valueOrDash(text) {
  return text == null || text === '' ? '<span class="m">–</span>' : esc(text);
}

// Sections are native <details> so they collapse on phones and keep their state while the sheet is open.
function section(title, body, open = true) {
  return `<details class="fs-sec"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="fs-body">${body}</div></details>`;
}

function focusLink(id, text) {
  if (!id) return esc(text);
  return `<button type="button" class="fs-link" data-fs-focus="${esc(id)}">${esc(text)}</button>`;
}

function overviewHtml(summary) {
  const rows = summary.overview.map(r => {
    if (r.icao) {
      return { label: r.label, value: focusLink(r.icao, r.value), source: r.source, raw: true };
    }
    return r;
  });
  return `<table class="fs-t">${rows.map(r => `<tr><td class="m">${esc(r.label)}</td><td>${r.raw ? r.value : valueOrDash(r.value)} ${sourceTag(r.source)}</td></tr>`).join('')}</table>`;
}

function proceduresHtml(summary) {
  const icaoFor = key => {
    const dep = summary.overview.find(r => r.key === 'departure');
    const dest = summary.overview.find(r => r.key === 'destination');
    if (key === 'depRwy' || key === 'sid') return dep && dep.icao;
    return dest && dest.icao;
  };
  const rows = summary.procedures.map(p => {
    const icao = icaoFor(p.key);
    const text = p.value ? (icao ? focusLink(icao, p.value) : esc(p.value)) : '<span class="m">–</span>';
    const cls = p.selected ? ' class="fs-on"' : '';
    const heading = p.heading != null ? ` · HDG ${String(Math.round(p.heading)).padStart(3, '0')}°` : '';
    return `<tr${cls}><td class="m">${esc(p.label)}</td><td>${text}${heading ? esc(heading) : ''} ${sourceTag(p.source)}</td></tr>`;
  });
  return `<table class="fs-t">${rows.join('')}</table>`;
}

function routeHtml(summary) {
  const route = summary.route;
  if (!route.waypoints.length) return '<div class="m">The route is empty. Add waypoints on the map to see distances and times.</div>';
  const head = `<div class="m">${route.totalNm != null ? Math.round(route.totalNm) + ' nm' : '–'}${route.greatCircleNm != null ? ' · great circle ' + Math.round(route.greatCircleNm) + ' nm' : ''} ${sourceTag(route.source)}</div>`;
  const progress = route.progress
    ? `<div class="m">Flown ${Math.round(route.progress.flownNm)} nm · remaining ${Math.round(route.progress.remainingNm)} nm${route.progress.onRoute ? '' : ' · off route'}</div>`
    : '';
  const rows = route.waypoints.map(w => {
    const alt = w.altFt != null ? Math.round(w.altFt).toLocaleString() + ' ft' : '–';
    const course = w.courseDeg != null ? String(w.courseDeg).padStart(3, '0') + '°' : '–';
    const leg = w.legNm != null ? Math.round(w.legNm) + ' nm' : '';
    const cum = Math.round(w.cumNm) + ' nm';
    const est = w.estMin != null ? fmtMinutes(w.estMin) : '–';
    return `<tr><td>${w.index + 1}</td><td>${focusLink(w.id, w.id)}</td><td>${esc(alt)}</td><td>${esc(course)}</td><td>${esc(leg)}</td><td>${esc(cum)}</td><td>${esc(est)}</td></tr>`;
  }).join('');
  return `${head}${progress}<table class="fs-t fs-route"><tr><th></th><th>Fix</th><th>Alt</th><th>Crs</th><th>Leg</th><th>Cum</th><th>Time</th></tr>${rows}</table>`;
}

function weightsHtml(summary) {
  if (!summary.weights.length) return '<div class="m">Weights come from the SimBrief plan.</div>';
  const rows = summary.weights.map(w => {
    const limit = w.limitText ? ` <span class="m">/ max ${esc(w.limitText)}</span>` : '';
    const over = w.over ? ' <b class="fs-warn">over limit</b>' : '';
    return `<tr><td class="m">${esc(w.label)}</td><td>${valueOrDash(w.text)}${limit}${over} ${sourceTag(w.source)}</td></tr>`;
  }).join('');
  return `<table class="fs-t">${rows}</table>`;
}

function fuelHtml(summary) {
  if (!summary.fuel.length) return '<div class="m">Fuel comes from the SimBrief plan.</div>';
  const rows = summary.fuel.map(f => `<tr><td class="m">${esc(f.label)}</td><td>${valueOrDash(f.text)} ${sourceTag(f.source)}</td></tr>`).join('');
  const landing = summary.fuelAtDestination
    ? `<div class="m">Fuel at destination: <b>${esc(summary.fuelAtDestination.text)}</b></div>`
    : '';
  return `<table class="fs-t">${rows}</table>${landing}`;
}

function windText(wind) {
  if (!wind) return '–';
  const dir = wind.direction == null ? 'VRB' : String(Math.round(wind.direction)).padStart(3, '0') + '°';
  return `${dir} ${Math.round(wind.speedKt || 0)} kt${wind.gustKt ? ' G' + Math.round(wind.gustKt) : ''}`;
}

function weatherHtml(summary) {
  const stations = summary.weather.stations;
  if (!stations.length) return '<div class="m">Add an origin or destination to see weather.</div>';
  return stations.map(s => {
    const status = s.status === 'missing'
      ? 'No live METAR yet. Open the airport on the map to fetch one.'
      : s.status === 'empty' ? 'METAR had no usable observation.' : null;
    const comp = s.runwayComponents
      ? ` · RWY ${esc(s.runway || '')}: ${s.runwayComponents.headwindKt >= 0 ? s.runwayComponents.headwindKt + ' kt head' : Math.abs(s.runwayComponents.headwindKt) + ' kt tail'}, ${Math.abs(s.runwayComponents.crosswindKt)} kt cross`
      : '';
    const age = s.ageMin != null ? ` · ${s.ageMin} min old` : '';
    return `<div class="fs-wx"><div><b>${esc(s.icao)}</b> <span class="m">${esc(s.role)}</span>${s.category ? ' · ' + esc(s.category) : ''}</div>`
      + `<div class="m">Wind ${esc(windText(s.wind))}${esc(comp)}${esc(age)}</div>`
      + (status ? `<div class="m">${esc(status)}</div>` : '')
      + (s.metar ? `<code class="fs-metar">${esc(s.metar)}</code>` : '')
      + `</div>`;
  }).join('');
}

function headerHtml(summary) {
  if (!summary.hasOfp) {
    return '<div class="m">No SimBrief flight plan loaded. Import one to see weights, fuel and procedures.</div>';
  }
  const when = summary.ofpFetchedAt ? `Imported ${fmtUtc(summary.ofpFetchedAt)}` : 'Imported plan';
  const status = summary.ofpStatus === 'changed'
    ? '<b class="fs-warn">Route edited since import. Refresh the OFP to use SimBrief figures.</b>'
    : '';
  return `<div class="m">${esc(when)} · weights in ${esc(summary.units.weight)}</div>${status}`;
}

/** Full panel HTML for an already-built summary. */
export function renderFlightPanel(summary, tab = 'overview') {
  queueAircraftSprite();
  const notes = summary.notes.length
    ? `<div class="fs-notes">${summary.notes.map(n => `<div class="m">${esc(n)}</div>`).join('')}</div>`
    : '';
  const current = activeTab(tab);
  const bar = `<div class="ov-tabs" role="tablist" aria-label="Flight overview sections">${OVERVIEW_TABS.map(t => `<button type="button" role="tab" class="ov-tab${t.key === current ? ' on' : ''}" data-ov-tab="${t.key}" aria-selected="${t.key === current}">${esc(t.label)}</button>`).join('')}</div>`;
  // Each tab keeps the same panel; it only changes which sections are shown.
  const sections = {
    overview: [    summary.identity ? overviewBlockHtml(summary.identity) : '', section('Overview', overviewHtml(summary))],
    route: [section('Procedures', proceduresHtml(summary)), section('Route', routeHtml(summary))],
    data: [section('Weights', weightsHtml(summary), false), section('Fuel', fuelHtml(summary), false)],
    weather: [section('Weather', weatherHtml(summary), false)],
  };
  return [
    headerHtml(summary),
    notes,
    bar,
    ...sections[current],
  ].join('');
}

/**
 * Convenience wrapper for the page: takes raw route points and the stored OFP.
 * route: [{ id, name, lat, lon, k }] as kept by the Flight Planning sheet.
 */
export function flightSummaryHtml({ route, ofp, cruiseKts, weightUnit, metars, position, now, tab } = {}) {
  const summary = buildSummary({
    route: (route || []).map(p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, kind: p.k })),
    ofp: ofp || null,
    cruiseKts,
    weightUnit,
    metars: metars || {},
    position: position || null,
    now,
  });
  summary.identity = {
    header: overviewHeader({ ofp: ofp || null, route: (route || []).map(p => ({ id: p.id })) }),
    aircraft: overviewAircraft({ simbrief: ofp && ofp.aircraft ? ofp.aircraft.icao : null, registration: ofp && ofp.aircraft ? ofp.aircraft.reg : null }),
  };
  return renderFlightPanel(summary, tab);
}

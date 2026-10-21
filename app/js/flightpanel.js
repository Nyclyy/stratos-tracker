// Flight summary panel for the Flight Planning sheet. Builds the summary from the
// route and the saved SimBrief plan, then renders it as HTML. Pure apart from
// buildSummary's clock, so the Flight Deck page can call it from its classic script.
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
export function renderFlightPanel(summary) {
  const notes = summary.notes.length
    ? `<div class="fs-notes">${summary.notes.map(n => `<div class="m">${esc(n)}</div>`).join('')}</div>`
    : '';
  return [
    headerHtml(summary),
    notes,
    section('Overview', overviewHtml(summary)),
    section('Procedures', proceduresHtml(summary)),
    section('Route', routeHtml(summary)),
    section('Weights', weightsHtml(summary), false),
    section('Fuel', fuelHtml(summary), false),
    section('Weather', weatherHtml(summary), false),
  ].join('');
}

/**
 * Convenience wrapper for the page: takes raw route points and the stored OFP.
 * route: [{ id, name, lat, lon, k }] as kept by the Flight Planning sheet.
 */
export function flightSummaryHtml({ route, ofp, cruiseKts, weightUnit, metars, position, now } = {}) {
  const summary = buildSummary({
    route: (route || []).map(p => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, kind: p.k })),
    ofp: ofp || null,
    cruiseKts,
    weightUnit,
    metars: metars || {},
    position: position || null,
    now,
  });
  return renderFlightPanel(summary);
}

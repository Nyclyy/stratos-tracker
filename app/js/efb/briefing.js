/* EFB · Flight Briefing.
 *
 * The operational flight plan, read from the same stored SimBrief import the
 * Flight Deck uses: identity, times, route, procedures, weights, fuel, weather
 * for departure/destination/alternate, and the published OFP document when
 * SimBrief generated one. Nothing is filled in: a missing value is shown as
 * missing, and the panel says when the route has drifted from the imported plan.
 */

import {
  esc, fmtAge, fmtDateUtc, fmtFl, fmtFt, fmtMinutes, fmtNum, fmtUtc,
  plannedRouteFromOfp, refreshPlan, weatherFor,
} from './common.js';
import { buildSummary } from '../lib/flightsummary.js';
import { parseMetar } from '../lib/routeweather.js';

const CATEGORY_TONE = { VFR: 'good', MVFR: 'accent', IFR: 'warn', LIFR: 'bad' };

function sourceTag(source) {
  if (source === 'ofp') return '<span class="e-badge accent" title="From the imported SimBrief plan">OFP</span>';
  if (source === 'stratos') return '<span class="e-badge" title="Calculated by Stratos from the route">Calc</span>';
  if (source === 'live') return '<span class="e-badge good" title="Live simulator data">Live</span>';
  return '';
}

function kvRows(rows) {
  return rows
    .map(row => {
      const value = row.text != null ? row.text : row.value;
      const shown = value == null || value === '' ? '<span class="e-faint">Not available</span>' : esc(value);
      return `<dt>${esc(row.label)}</dt><dd>${shown} ${sourceTag(row.source)}</dd>`;
    })
    .join('');
}

function procedureCards(summary) {
  const byKey = new Map(summary.procedures.map(row => [row.key, row]));
  const dep = byKey.get('depRwy');
  const sid = byKey.get('sid');
  const star = byKey.get('star');
  const app = byKey.get('approach');
  const arr = byKey.get('arrRwy');
  const card = (label, row, extra = '') => `<div class="e-card" style="padding:12px 14px">
      <div class="e-label">${label}</div>
      <div class="e-value" style="margin-top:4px">${row && row.value ? esc(row.value) : '<span class="e-faint">Not in this plan</span>'}</div>
      ${extra ? `<div class="e-small e-faint" style="margin-top:2px">${esc(extra)}</div>` : ''}
    </div>`;
  return `<div class="e-grid four">
    ${card('Departure runway', dep)}
    ${card('SID', sid, sid && sid.extra && sid.extra.transition ? `transition ${sid.extra.transition}` : '')}
    ${card('STAR', star)}
    ${card('Approach / arrival', app && app.value ? app : arr)}
  </div>`;
}

function routeTable(summary) {
  const route = summary.route;
  if (!route.waypoints.length) {
    return `<div class="e-empty"><b>No route waypoints</b><p>The imported plan carries no navlog and the Flight Deck has no route loaded, so there is no leg-by-leg table to show.</p></div>`;
  }
  const rows = route.waypoints.map(point => `<tr>
      <td>${esc(point.id)}${point.name && point.name !== point.id ? `<div class="e-small e-faint">${esc(point.name)}</div>` : ''}</td>
      <td class="num">${point.altFt ? esc(fmtFt(point.altFt)) : '—'}</td>
      <td class="num">${point.legNm != null ? fmtNum(point.legNm, 1) : '—'}</td>
      <td class="num">${point.cumNm != null ? fmtNum(point.cumNm, 0) : '—'}</td>
      <td class="num">${point.estMin != null ? fmtMinutes(point.estMin) : '—'}</td>
    </tr>`).join('');
  return `<div class="e-card" style="padding:6px 12px 8px">
    <table class="e-table">
      <thead><tr><th>Waypoint</th><th class="num">Planned alt</th><th class="num">Leg nm</th><th class="num">Cum nm</th><th class="num">ETE</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="e-small e-faint" style="padding:6px 2px 0">${route.totalNm != null ? `${fmtNum(route.totalNm, 0)} nm total · ` : ''}Source: ${route.source === 'ofp' ? 'SimBrief plan' : 'Stratos route'}${route.progress ? ` · flown ${fmtNum(route.progress.flownNm, 0)} nm, remaining ${fmtNum(route.progress.remainingNm, 0)} nm` : ''}</div>
  </div>`;
}

function weightsCard(summary) {
  if (!summary.weights.length) {
    return `<div class="e-empty"><b>No weights</b><p>SimBrief did not report weights for this plan. Import a plan with a full load sheet to see them.</p></div>`;
  }
  return `<div class="e-card"><h3>Weights <em>${summary.units.weight.toUpperCase()}</em></h3><dl class="e-kv">${kvRows(summary.weights)}</dl></div>`;
}

function fuelCard(summary) {
  if (!summary.fuel.length) {
    return `<div class="e-empty"><b>No fuel figures</b><p>SimBrief did not report fuel for this plan.</p></div>`;
  }
  return `<div class="e-card"><h3>Fuel <em>${summary.units.weight.toUpperCase()}</em></h3><dl class="e-kv">${kvRows(summary.fuel)}</dl>
    ${summary.fuelAtDestination ? `<div class="e-notice" style="margin-top:10px">At destination: <b>${esc(summary.fuelAtDestination.text)}</b></div>` : ''}</div>`;
}

function weatherCards(summary, metars) {
  const stations = (summary.weather && summary.weather.stations) || [];
  if (!stations.length) {
    return `<div class="e-empty"><b>No stations</b><p>Load a plan or a route so the briefing knows which airports to ask about.</p></div>`;
  }
  return `<div class="e-grid three">${stations.map(station => {
    const record = metars[station.icao] || null;
    const decoded = record && record.metar ? parseMetar(record.metar) : null;
    const category = station.category || (decoded && decoded.flightCategory);
    const tone = CATEGORY_TONE[category] || '';
    const wind = station.runwayComponents;
    return `<div class="e-card">
      <h3>${esc(station.role)} <span class="e-spacer"></span>${category ? `<span class="e-badge ${tone}">${esc(category)}</span>` : ''}</h3>
      <div class="e-hero"><b>${esc(station.icao)}</b>${station.runway ? `<span>rw ${esc(station.runway)}</span>` : ''}</div>
      ${station.metar ? `<code class="e-code" style="margin-top:9px">${esc(station.metar)}</code>` : '<div class="e-small e-muted" style="margin-top:8px">No METAR is published for this station.</div>'}
      ${decoded ? `<dl class="e-kv" style="margin-top:9px">
        <dt>Wind</dt><dd>${decoded.wind ? `${decoded.wind.direction == null ? 'VRB' : String(decoded.wind.direction).padStart(3, '0')}° / ${decoded.wind.speedKt} kt${decoded.wind.gustKt ? ` G${decoded.wind.gustKt}` : ''}` : '—'}</dd>
        <dt>Visibility</dt><dd>${decoded.visibilitySm != null ? `${decoded.visibilitySm} SM` : '—'}</dd>
        <dt>Ceiling</dt><dd>${decoded.ceilingFt != null ? fmtFt(decoded.ceilingFt) : 'No ceiling'}</dd>
        <dt>Temp / dew</dt><dd>${decoded.temperatureC != null ? `${decoded.temperatureC}° / ${decoded.dewpointC}°C` : '—'}</dd>
        <dt>Altimeter</dt><dd>${decoded.altimeter != null ? `${decoded.altimeter} ${decoded.altimeterUnit === 'inHg' ? 'inHg' : 'hPa'}` : '—'}</dd>
      </dl>` : ''}
      ${wind ? `<div class="e-notice" style="margin-top:9px">Runway wind: <b>${wind.headwindKt >= 0 ? `${wind.headwindKt} kt head` : `${Math.abs(wind.headwindKt)} kt tail`}</b> · ${Math.abs(wind.crosswindKt)} kt ${wind.crosswindKt > 0 ? 'right' : wind.crosswindKt < 0 ? 'left' : ''}</div>` : ''}
      <div class="e-small e-faint" style="margin-top:8px">${station.fetchedAt ? `Observed ${fmtAge(station.fetchedAt)}` : 'Not loaded'}${station.source ? ` · ${esc(station.source)}` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function ofpDocument(summary) {
  if (summary.ofpText) {
    return `<div class="e-card"><h3>Operational flight plan <em>SimBrief text</em></h3>
      <pre class="e-code" style="max-height:420px;overflow:auto">${esc(summary.ofpText)}</pre></div>`;
  }
  if (summary.ofpDocumentUrl) {
    const safe = esc(summary.ofpDocumentUrl);
    return `<div class="e-card"><h3>Operational flight plan <em>published PDF</em></h3>
      <p class="e-small e-muted" style="margin:0 0 10px">SimBrief published this plan as a PDF. It opens in a new tab, where your browser's own PDF viewer can print or save it.</p>
      <div class="e-row">
        <a class="e-btn primary" href="${safe}" target="_blank" rel="noopener">Open the OFP PDF ↗</a>
        <button class="e-btn" type="button" data-copy="${safe}">Copy link</button>
      </div>
      <div class="e-small e-faint" style="margin-top:9px;overflow-wrap:anywhere">${safe}</div>
    </div>`;
  }
  return `<div class="e-card"><h3>Operational flight plan</h3>
    <div class="e-notice warn">This plan did not include a published PDF or the formatted OFP text. SimBrief only generates those when the plan has been built with an OFP format selected — rebuild the plan in SimBrief, then refresh here.</div></div>`;
}

function emptyState(plan, ctx) {
  const id = (plan && plan.simbriefId) || '';
  return `<div class="e-grid two">
    <div class="e-card">
      <h3>Import your SimBrief plan</h3>
      <p class="e-small e-muted" style="margin-top:0">The EFB reads the same stored plan as the Flight Deck, so you only load it once. Your Pilot ID is kept on this device.</p>
      <div class="e-field" style="margin-top:10px">
        <label for="efb-simbrief">SimBrief Pilot ID or username</label>
        <input class="e-input" id="efb-simbrief" value="${esc(id)}" autocomplete="off" spellcheck="false" placeholder="e.g. 123456">
      </div>
      <div class="e-row" style="margin-top:10px">
        <button class="e-btn primary" type="button" data-import>Fetch latest plan</button>
        <a class="e-btn ghost" href="index.html#plan">Open Flight Planning</a>
      </div>
      <div id="efb-import-status" class="e-small e-faint" style="margin-top:8px">${plan && plan.error ? esc(plan.error) : ''}</div>
    </div>
    <div class="e-card">
      <h3>What you will get</h3>
      <dl class="e-kv">
        <dt>Identity</dt><dd>Flight number, callsign, aircraft, registration</dd>
        <dt>Route</dt><dd>Waypoints, legs, SID, STAR, runways</dd>
        <dt>Numbers</dt><dd>Weights, fuel, times and alternates</dd>
        <dt>Document</dt><dd>The published OFP, when SimBrief generated one</dd>
      </dl>
      <div class="e-notice" style="margin-top:10px">No plan yet, so nothing here is estimated — the EFB shows only what the plan actually states.</div>
    </div>
  </div>`;
}

export async function mount(root, ctx) {
  let destroyed = false;
  let plan = ctx.plan();
  const route = ctx.route();
  const metars = {};

  root.innerHTML = '<div class="e-loading"><i></i>Reading the flight plan…</div>';

  async function loadWeather(ofp) {
    const codes = [
      ofp && ofp.origin && ofp.origin.icao,
      ofp && ofp.destination && ofp.destination.icao,
      ofp && ofp.alternate && ofp.alternate.icao,
    ].filter(Boolean);
    await Promise.all(codes.map(async code => {
      const record = await weatherFor(code);
      if (record && record.metar) metars[code] = record;
    }));
  }

  function render() {
    if (destroyed) return;
    plan = ctx.plan();
    const ofp = plan && plan.ofp;
    if (!ofp && !route.length) {
      ctx.setSubtitle('No plan imported');
      root.innerHTML = emptyState(plan, ctx);
      wireEmptyState();
      return;
    }
    // With no Flight Deck route, the plan's own navlog is the route: it is the
    // ordered fix list SimBrief filed, not a great-circle guess.
    const points = route.length ? route : plannedRouteFromOfp(ofp);
    const summary = buildSummary({
      route: points,
      ofp,
      metars,
      weightUnit: ctx.prefs().units === 'lb' ? 'lb' : 'kg',
    });
    const identity = ofp
      ? [ofp.flight && ofp.flight.callsign, ofp.aircraft && ofp.aircraft.icao, ofp.aircraft && ofp.aircraft.reg]
        .filter(Boolean).join(' · ')
      : '';
    const statusBadge = !ofp
      ? '<span class="e-badge warn">No OFP</span>'
      : summary.ofpStatus === 'changed'
        ? '<span class="e-badge warn">Route edited after import</span>'
        : '<span class="e-badge good">Plan loaded</span>';

    ctx.setSubtitle(ofp ? `${ofp.origin ? ofp.origin.icao : '????'} → ${ofp.destination ? ofp.destination.icao : '????'}` : 'Route only');
    ctx.setActions(`
      ${ofp && ofp.documentUrl ? `<a class="e-btn small" href="${esc(ofp.documentUrl)}" target="_blank" rel="noopener">OFP ↗</a>` : ''}
      <button class="e-btn small" type="button" data-refresh>Refresh from SimBrief</button>`);

    const routeHero = (ofp
      ? `${esc((ofp.origin && ofp.origin.icao) || '????')} <s>→</s> ${esc((ofp.destination && ofp.destination.icao) || '????')}`
      : route.length
        ? `${esc(route[0].id)} <s>→</s> ${esc(route[route.length - 1].id)}`
        : 'No route');

    root.innerHTML = `
      <div class="e-card" style="margin-bottom:12px">
        <div class="e-row" style="align-items:flex-start">
          <div style="min-width:0">
            <div class="e-hero">${routeHero}</div>
            <div class="e-small e-muted" style="margin-top:3px">${esc(identity || 'Aircraft not stated')}</div>
          </div>
          <span class="e-spacer"></span>
          <div class="e-row" style="justify-content:flex-end">
            ${statusBadge}
            ${ofp && ofp.fetchedAt ? `<span class="e-badge">imported ${esc(fmtAge(ofp.fetchedAt))}</span>` : ''}
          </div>
        </div>
        <div class="e-grid four" style="margin-top:14px">
          <div><div class="e-label">Cruise</div><div class="e-big">${ofp && ofp.flight && ofp.flight.cruiseFt ? esc(fmtFl(ofp.flight.cruiseFt)) : '—'}</div></div>
          <div><div class="e-label">Distance</div><div class="e-big">${summary.route.totalNm != null ? `${fmtNum(summary.route.totalNm, 0)}<small class="e-small e-faint"> nm</small>` : '—'}</div></div>
          <div><div class="e-label">Flight time</div><div class="e-big">${(() => {
            const row = summary.overview.find(item => item.key === 'ete');
            return row && row.value ? esc(row.value) : '—';
          })()}</div></div>
          <div><div class="e-label">Departure</div><div class="e-big">${ofp && ofp.times && ofp.times.depUtc ? esc(fmtUtc(ofp.times.depUtc)) : '—'}</div></div>
        </div>
      </div>

      ${summary.notes.length ? `<div class="e-notice" style="margin-bottom:12px">${summary.notes.map(note => esc(note)).join('<br>')}</div>` : ''}

      <div class="e-grid two" style="margin-bottom:12px">
        <div class="e-card"><h3>Flight plan</h3><dl class="e-kv">${kvRows(summary.overview)}</dl></div>
        <div class="e-card"><h3>Times</h3><dl class="e-kv">
          <dt>Scheduled out</dt><dd>${ofp && ofp.times && ofp.times.depUtc ? `${esc(fmtUtc(ofp.times.depUtc))} <span class="e-faint">${esc(fmtDateUtc(ofp.times.depUtc))}</span>` : '—'}</dd>
          <dt>Scheduled in</dt><dd>${ofp && ofp.times && ofp.times.arrUtc ? `${esc(fmtUtc(ofp.times.arrUtc))} <span class="e-faint">${esc(fmtDateUtc(ofp.times.arrUtc))}</span>` : '—'}</dd>
          <dt>En-route</dt><dd>${ofp && ofp.times && ofp.times.enrouteMin != null ? esc(fmtMinutes(ofp.times.enrouteMin)) : '—'}</dd>
          <dt>Block</dt><dd>${ofp && ofp.times && ofp.times.blockMin != null ? esc(fmtMinutes(ofp.times.blockMin)) : '—'}</dd>
          <dt>Cruise TAS</dt><dd>${ofp && ofp.flight && ofp.flight.cruiseTasKt ? `${esc(ofp.flight.cruiseTasKt)} kt` : '—'}</dd>
          <dt>Step climbs</dt><dd><span class="e-faint">Not in the SimBrief record</span></dd>
        </dl>
        ${ofp && ofp.alternate && ofp.alternate.icao ? `<div class="e-notice" style="margin-top:10px">Alternate <b>${esc(ofp.alternate.icao)}</b>${ofp.alternate.name ? ` · ${esc(ofp.alternate.name)}` : ''}</div>` : ''}
        </div>
      </div>

      <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:18px 2px 8px">Procedures</h2>
      ${procedureCards(summary)}

      <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:18px 2px 8px">Route</h2>
      ${routeTable(summary)}

      <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:18px 2px 8px">Load and fuel</h2>
      <div class="e-grid two" style="margin-bottom:12px">${weightsCard(summary)}${fuelCard(summary)}</div>

      <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:18px 2px 8px">Weather at the airports</h2>
      ${weatherCards(summary, metars)}

      <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:18px 2px 8px">Operational flight plan</h2>
      ${ofpDocument(summary)}

      <div class="e-small e-faint" style="margin:16px 2px 0">Simulator planning aid. SimBrief provides the plan; weather is NOAA METAR. Not for real-world flight.</div>`;

    root.querySelector('[data-refresh]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Refreshing…';
      const next = await refreshPlan();
      if (destroyed) return;
      plan = next;
      if (next.error) {
        button.disabled = false;
        button.textContent = 'Refresh from SimBrief';
        const notice = document.createElement('div');
        notice.className = 'e-notice bad';
        notice.style.marginBottom = '12px';
        notice.textContent = next.error;
        root.prepend(notice);
        return;
      }
      await loadWeather(next.ofp);
      render();
    });
    root.querySelectorAll('[data-copy]').forEach(button => {
      button.addEventListener('click', async () => {
        const url = button.getAttribute('data-copy');
        try {
          await navigator.clipboard.writeText(url);
          button.textContent = 'Copied';
        } catch (_) {
          button.textContent = 'Copy failed';
        }
        setTimeout(() => { button.textContent = 'Copy link'; }, 2000);
      });
    });
  }

  function wireEmptyState() {
    root.querySelector('[data-import]')?.addEventListener('click', async event => {
      const input = root.querySelector('#efb-simbrief');
      const status = root.querySelector('#efb-import-status');
      const id = (input && input.value || '').trim();
      if (!id) {
        if (status) status.textContent = 'Enter your SimBrief Pilot ID or username.';
        return;
      }
      event.currentTarget.disabled = true;
      if (status) status.textContent = 'Asking SimBrief…';
      const next = await refreshPlan(id);
      if (destroyed) return;
      if (next.error) {
        event.currentTarget.disabled = false;
        if (status) status.textContent = next.error;
        return;
      }
      plan = next;
      await loadWeather(next.ofp);
      render();
    });
    root.querySelector('#efb-simbrief')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') root.querySelector('[data-import]')?.click();
    });
  }

  if (plan && plan.ofp) await loadWeather(plan.ofp);
  render();

  const unsubscribe = (await import('./common.js')).onPlanChange(() => {
    if (!destroyed) render();
  });

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
    },
  };
}

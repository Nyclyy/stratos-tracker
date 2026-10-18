import { computeMilestones, weeklyActivity } from '../lib/stats.js';
import { getDashboardLayout, saveDashboardLayout } from '../lib/store.js';
import { esc, fmtDate, hoursText, num, statTile, barChart, lineChart, tag, emptyState } from '../ui.js';
import { flightRow } from './common.js';

export async function mount(root, ctx) {
  const career = ctx.career;
  const flights = ctx.flights;
  let drill = null;
  let dialog = null;

  const DEFAULT_CARDS = ['hours', 'flights', 'distance', 'airports'];
  const CARD_META = {
    hours: { label: 'Flight hours', render: () => statTile('Flight hours', hoursText(career.hours), `${career.flights} completed flights`, 'accent') },
    flights: { label: 'Completed flights', render: () => statTile('Completed flights', num(career.flights), `${num(career.landings.count)} landings logged`) },
    distance: { label: 'Distance', render: () => statTile('Distance', `${num(career.distanceNm)} nm`, `avg ${num(career.averageDistanceNm)} nm per flight`) },
    airports: { label: 'Airports visited', render: () => statTile('Airports visited', num(career.airportsVisited), `${career.aircraftFlown} aircraft types`) },
    landings: { label: 'Landing quality', render: () => statTile('Landing quality', career.landings.averageFpm != null ? `${career.landings.averageFpm} fpm` : '—', career.landings.count ? `average over ${career.landings.count} landings` : 'no landing data yet') },
    aircraft: { label: 'Aircraft flown', render: () => statTile('Aircraft flown', num(career.aircraftFlown), `${career.airportsVisited} airports visited`) },
    rank: { label: 'Current rank', render: () => statTile('Current rank', esc(career.rank.name), `${hoursText(career.hours)} recorded`) },
    week: { label: 'Flights this week', render: () => statTile('This week', num(career.windows.week), 'completed flights') },
    month: { label: 'Flights this month', render: () => statTile('This month', num(career.windows.month), 'completed flights') },
  };
  const saved = await getDashboardLayout().catch(() => null);
  let cards = Array.isArray(saved?.cards) ? saved.cards.filter(key => CARD_META[key]) : DEFAULT_CARDS.slice();
  if (!cards.length) cards = DEFAULT_CARDS.slice();
  let dense = Boolean(saved?.dense);
  root.classList.toggle('dash-dense', dense);

  const completed = flights.filter(f => f.complete && !f.incomplete);
  const incomplete = flights.filter(f => !f.complete || f.incomplete);

  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthly = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const found = career.monthly.find(m => m.month === key);
    monthly.push({ month: key, hours: found ? found.seconds / 3600 : 0, flights: found ? found.flights : 0, label: monthLabels[d.getMonth()] });
  }
  const weekly = weeklyActivity(flights, 12, now);
  const milestones = computeMilestones(career);

  const underlying = () => {
    if (!drill) return '';
    let list = [];
    let title = '';
    if (drill.type === 'airport') {
      title = `Flights at ${drill.value}`;
      list = completed.filter(f => f.depAirport === drill.value || f.arrAirport === drill.value);
    } else if (drill.type === 'aircraft') {
      title = `Flights in ${drill.value}`;
      list = completed.filter(f => (f.aircraft || 'Unknown aircraft') === drill.value);
    } else if (drill.type === 'route') {
      title = `Flights on ${drill.value}`;
      const [dep, arr] = drill.value.split(' → ');
      list = completed.filter(f => (f.depAirport || '????') === dep && (f.arrAirport || '????') === arr);
    } else if (drill.type === 'flights') {
      title = 'All completed flights counted in these totals';
      list = completed;
    }
    return `<div class="card" id="drill" style="margin-top:12px">
      <div class="card-head"><h2>${esc(title)}</h2>
        <span class="tag">${list.length} flight${list.length === 1 ? '' : 's'}</span>
        <span class="spacer"></span><button class="btn small ghost" data-close-drill>Close</button></div>
      ${list.length ? `<div class="list">${list
        .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
        .slice(0, 60)
        .map(f => flightRow(f, `<button class="btn small" data-flight="${esc(f.id)}">Details</button>`)).join('')}</div>`
        : '<p class="muted small">No completed flights match this total.</p>'}
      ${list.length > 60 ? `<p class="help">Showing the 60 most recent of ${list.length} flights.</p>` : ''}
    </div>`;
  };

  const render = () => {
    root.innerHTML = `
      <div class="page-head">
        <div>
          <h1>${esc(career.flights ? 'Your flight deck' : 'Start your career')}</h1>
          <p>Every number below is calculated from your recorded flights${incomplete.length ? `; ${incomplete.length} incomplete record${incomplete.length === 1 ? ' is' : 's are'} kept but excluded from totals` : ''}.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn small ghost" data-customize>Customize</button>
        <span class="tag tag-accent">${esc(career.rank.name)}</span>
      </div>

      <div class="grid grid-4 dashboard-cards">
        ${cards.map(key => `<div data-card="${key}">${CARD_META[key].render()}</div>`).join('')}
      </div>

      <div class="section-title"><h2>Progress</h2><span class="hint">Ranks are milestones based on recorded hours, not a licence.</span></div>
      <div class="grid grid-main">
        <div class="card">
          <div class="card-head"><h2>${esc(career.rank.name)}</h2><span class="spacer"></span>
            ${career.nextRank ? `<span class="muted small">${num(Math.max(0, career.nextRank.hours - career.hours), 1)} h to ${esc(career.nextRank.name)}</span>` : '<span class="tag tag-good">Top rank</span>'}
          </div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(career.rankProgress * 100)}"><span style="width:${Math.round(career.rankProgress * 100)}%"></span></div>
          <div class="row" style="margin-top:10px">
            <span class="muted small">${hoursText(career.hours)} recorded</span><span class="spacer"></span>
            <span class="muted small">${career.nextRank ? `${hoursText(career.nextRank.hours)} for ${esc(career.nextRank.name)}` : 'Highest rank reached'}</span>
          </div>
          <div class="grid grid-3" style="margin-top:16px">
            <div><span class="stat-label">This week</span><b>${career.windows.week}</b></div>
            <div><span class="stat-label">This month</span><b>${career.windows.month}</b></div>
            <div><span class="stat-label">This year</span><b>${career.windows.year}</b></div>
          </div>
          <button class="btn small ghost" data-drill="flights" style="margin-top:14px">Inspect the ${career.flights} flights behind these totals</button>
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent activity</h2></div>
          <div class="list">
            ${career.recent.length ? career.recent.slice(0, 5).map(f => flightRow(f, `<button class="btn small" data-flight="${esc(f.id)}">Details</button>`)).join('') : '<p class="muted small">No completed flights yet.</p>'}
          </div>
        </div>
      </div>

      <div class="section-title"><h2>Monthly hours</h2><span class="hint">Last 12 months</span></div>
      <div class="card">
        ${barChart(monthly.map(m => ({ label: m.label, value: Number(m.hours.toFixed(2)), title: `${m.month}: ${hoursText(m.hours)} across ${m.flights} flights` })), { height: 140, aria: 'Flight hours per month' })}
      </div>

      <div class="section-title"><h2>Weekly rhythm</h2><span class="hint">Flights per week, last 12 weeks</span></div>
      <div class="card">
        ${lineChart(weekly.map(w => w.flights), { height: 110, aria: 'Flights per week' })}
        <div class="row muted small" style="justify-content:space-between;margin-top:4px"><span>${esc(weekly[0].start)}</span><span>${esc(weekly[weekly.length - 1].end)}</span></div>
      </div>

      <div class="section-title"><h2>Most flown</h2></div>
      <div class="grid grid-2">
        <div class="card flush">
          <div style="padding:14px 16px 4px"><h2>Routes</h2></div>
          ${career.topRoutes.length ? `<div class="table-wrap" style="border:0;border-radius:0">
            <table class="data"><thead><tr><th>Route</th><th class="num">Flights</th><th class="num">Hours</th></tr></thead><tbody>
            ${career.topRoutes.slice(0, 8).map(r => `<tr>
              <td><button class="btn small ghost" data-drill="route" data-value="${esc(r.route)}">${esc(r.route)}</button></td>
              <td class="num">${r.count}</td><td class="num">${num(r.seconds / 3600, 1)}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted small" style="padding:0 16px 16px">Fly a route to start building this list.</p>'}
        </div>
        <div class="card flush">
          <div style="padding:14px 16px 4px"><h2>Airports</h2></div>
          ${career.airports.length ? `<div class="table-wrap" style="border:0;border-radius:0">
            <table class="data"><thead><tr><th>Airport</th><th class="num">Dep</th><th class="num">Arr</th></tr></thead><tbody>
            ${career.airports.slice(0, 8).map(a => `<tr>
              <td><button class="btn small ghost" data-drill="airport" data-value="${esc(a.code)}">${esc(a.code)}</button></td>
              <td class="num">${a.departures}</td><td class="num">${a.arrivals}</td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted small" style="padding:0 16px 16px">Airport visits appear once a flight has a departure or arrival airport.</p>'}
        </div>
      </div>

      <div class="section-title"><h2>Milestones</h2><span class="hint">Derived from real totals</span></div>
      <div class="grid grid-auto">
        ${milestones.map(m => `<div class="card" style="padding:13px 15px">
          <div class="row"><span class="tag ${m.reached ? 'tag-good' : ''}">${m.reached ? 'Reached' : 'In progress'}</span></div>
          <div style="font-weight:650;margin:8px 0 2px">${esc(m.label)}</div>
          <div class="muted small">${num(m.value, m.unit === 'hours' ? 1 : 0)} / ${num(m.target)} ${esc(m.unit)}</div>
          <div class="progress" style="margin-top:8px"><span style="width:${Math.round(m.progress * 100)}%"></span></div>
        </div>`).join('')}
      </div>

      <div class="section-title"><h2>Records</h2></div>
      <div class="grid grid-3">
        <div class="card"><span class="stat-label">Longest flight</span>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${career.longestFlight ? `${esc(career.longestFlight.depAirport || '????')} → ${esc(career.longestFlight.arrAirport || '????')}` : '—'}</div>
          <div class="muted small">${career.longestFlight ? `${hoursText(career.longestSeconds / 3600)} · ${esc(fmtDate(career.longestFlight.startTime))}` : 'No completed flights'}</div></div>
        <div class="card"><span class="stat-label">Longest distance</span>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${career.farthestFlight ? `${num(career.farthestNm)} nm` : '—'}</div>
          <div class="muted small">${career.farthestFlight ? `${esc(career.farthestFlight.depAirport || '????')} → ${esc(career.farthestFlight.arrAirport || '????')}` : 'No completed flights'}</div></div>
        <div class="card"><span class="stat-label">Highest altitude</span>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${career.highestAltitudeFt ? `${num(career.highestAltitudeFt)} ft` : '—'}</div>
          <div class="muted small">From recorded telemetry</div></div>
      </div>

      ${incomplete.length ? `<div class="notice warn" style="margin-top:22px">
        <div><strong>${incomplete.length} incomplete record${incomplete.length === 1 ? '' : 's'} preserved.</strong>
        <br>They are excluded from totals so they cannot inflate your hours, but nothing was deleted. Open the logbook to review them.</div>
        <span class="spacer"></span><a class="btn small" href="logbook.html">Open logbook</a></div>` : ''}

      ${underlying()}
    `;

    root.querySelectorAll('[data-drill]').forEach(button => {
      button.addEventListener('click', () => {
        drill = { type: button.dataset.drill, value: button.dataset.value || '' };
        render();
        document.getElementById('drill')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    root.querySelectorAll('[data-close-drill]').forEach(button => {
      button.addEventListener('click', () => { drill = null; render(); });
    });
    root.querySelectorAll('[data-flight]').forEach(button => {
      button.addEventListener('click', () => ctx.openFlight(button.dataset.flight));
    });
    root.querySelector('[data-customize]')?.addEventListener('click', openCustomize);
  };

  function openCustomize() {
    dialog?.remove();
    dialog = document.createElement('div');
    dialog.className = 'dialog-backdrop';
    const enabled = new Set(cards);
    dialog.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="Customize dashboard">
      <div class="row" style="margin-bottom:12px"><h2>Dashboard widgets</h2><span class="spacer"></span><button class="btn small" data-close>Close</button></div>
      <p class="help" style="margin-top:0">Choose the tiles shown at the top and put them in the order you want. Layout is stored on this device.</p>
      <div id="widget-list" class="stack">
        ${Object.keys(CARD_META).map(key => `<div class="row widget-row" data-key="${key}" style="align-items:center;gap:8px;border:1px solid var(--coast);border-radius:10px;padding:8px 10px">
          <label class="row" style="align-items:center;gap:8px;flex:1;cursor:pointer"><input type="checkbox" value="${key}" ${enabled.has(key) ? 'checked' : ''}> <span>${esc(CARD_META[key].label)}</span></label>
          <button class="btn small ghost" data-up="${key}" aria-label="Move up">↑</button>
          <button class="btn small ghost" data-down="${key}" aria-label="Move down">↓</button>
        </div>`).join('')}
      </div>
      <label class="row" style="align-items:center;gap:8px;margin-top:12px;cursor:pointer"><input type="checkbox" id="dash-dense" ${dense ? 'checked' : ''}> Compact tiles</label>
      <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-save>Save layout</button><button class="btn ghost" data-reset>Reset default</button></div>
    </div>`;
    document.body.appendChild(dialog);
    const close = () => { dialog?.remove(); dialog = null; };
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.querySelector('[data-close]').addEventListener('click', close);
    dialog.querySelectorAll('[data-up]').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('.widget-row');
      const previous = row.previousElementSibling;
      if (previous) row.parentElement.insertBefore(row, previous);
    }));
    dialog.querySelectorAll('[data-down]').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('.widget-row');
      const next = row.nextElementSibling;
      if (next) row.parentElement.insertBefore(next, row);
    }));
    dialog.querySelector('[data-reset]').addEventListener('click', async () => {
      cards = DEFAULT_CARDS.slice();
      dense = false;
      try { await saveDashboardLayout({ cards, dense }); }
      catch (_) { ctx.toast('The layout could not be saved on this device.', 'bad'); return; }
      root.classList.toggle('dash-dense', dense);
      close();
      render();
      ctx.toast('Dashboard layout reset.');
    });
    dialog.querySelector('[data-save]').addEventListener('click', async () => {
      const chosen = [...dialog.querySelectorAll('#widget-list input:checked')].map(input => input.value).filter(key => CARD_META[key]);
      if (!chosen.length) { ctx.toast('Choose at least one widget.', 'bad'); return; }
      cards = chosen;
      const nextDense = Boolean(dialog.querySelector('#dash-dense').checked);
      try { await saveDashboardLayout({ cards, dense: nextDense }); }
      catch (_) { ctx.toast('The layout could not be saved on this device.', 'bad'); return; }
      dense = nextDense;
      root.classList.toggle('dash-dense', dense);
      close();
      render();
      ctx.toast('Dashboard layout saved.', 'good');
    });
  }

  render();
  return { destroy() { dialog?.remove(); dialog = null; root.innerHTML = ''; root.classList.remove('dash-dense'); } };
}

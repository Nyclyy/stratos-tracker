import { DEFAULT_THRESHOLDS, saveThresholdOverrides } from '../lib/landing.js';
import { esc, fmtDate, lineChart, num, statTile, tag, toast } from '../ui.js';
import { landingTag } from './common.js';

const CLASS_NAMES = { jet: 'Jet', turboprop: 'Turboprop', piston: 'Piston', glider: 'Glider', helicopter: 'Helicopter', unknown: 'Unknown type' };

export async function mount(root, ctx) {
  let search = '';
  let grade = 'all';
  let classFilter = 'all';
  let sort = 'date-desc';
  let editing = false;

  const render = () => {
    const summary = ctx.landings;
    const all = summary.landings;
    const filtered = all.filter(item => {
      if (grade !== 'all' && item.classification.key !== grade) return false;
      if (classFilter !== 'all' && (item.classification.classKey || 'unknown') !== classFilter) return false;
      if (search) {
        const haystack = `${item.departure || ''} ${item.airport || ''} ${item.aircraft || ''} ${item.runway ? item.runway.id : ''}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => {
      if (sort === 'date-asc') return (a.at || 0) - (b.at || 0);
      if (sort === 'vs-best') return b.vsFpm - a.vsFpm;
      if (sort === 'vs-worst') return a.vsFpm - b.vsFpm;
      return (b.at || 0) - (a.at || 0);
    });

    const classRows = Object.entries(summary.byClass).sort((a, b) => b[1].count - a[1].count);
    const trend = summary.trend.map(t => t.averageFpm);
    const trendLabels = summary.trend.map(t => t.month.slice(5));

    root.innerHTML = `
      <div class="page-head">
        <div><h1>Landing analytics</h1>
        <p>Vertical speed is derived from the simulator's recorded altitude in the touchdown window. Ratings are configurable guidelines by aircraft class, not operational limits.</p></div>
        <span class="spacer"></span>
        <button class="btn small" id="toggle-thresholds">${editing ? 'Hide thresholds' : 'Rating thresholds'}</button>
      </div>

      <div class="grid grid-4">
        ${statTile('Landings analysed', num(summary.count), `${summary.skipped.noRecord} flights without landing data`)}
        ${statTile('Average', summary.averageFpm != null ? `${summary.averageFpm} fpm` : '—', 'Across all aircraft classes')}
        ${statTile('Best', summary.best ? `${summary.best.vsFpm} fpm` : '—', summary.best ? `${esc(summary.best.aircraft)} · ${esc(fmtDate(summary.best.at))}` : 'No data', 'good')}
        ${statTile('Most recent', summary.landings[0] ? `${summary.landings[0].vsFpm} fpm` : '—', summary.landings[0] ? `${esc(summary.landings[0].airport || summary.landings[0].departure || 'Unknown airport')} · ${esc(fmtDate(summary.landings[0].at))}` : 'No data')}
      </div>

      ${editing ? thresholdEditor(ctx.thresholds) : ''}

      <div class="section-title"><h2>Trend</h2><span class="hint">Average touchdown rate per month</span></div>
      <div class="card">
        ${summary.trend.length >= 2 ? lineChart(trend, { height: 120, aria: 'Average landing rate by month' }) : '<p class="muted small">At least two months of landing data are needed for a trend.</p>'}
        ${summary.trend.length ? `<div class="row muted small" style="justify-content:space-between">${trendLabels.map(label => `<span>${esc(label)}</span>`).join('')}</div>` : ''}
      </div>

      <div class="section-title"><h2>By aircraft class</h2><span class="hint">A jet and a light piston are not judged the same</span></div>
      <div class="grid grid-auto">
        ${classRows.length ? classRows.map(([key, value]) => `<div class="card">
          <div class="row"><strong>${esc(CLASS_NAMES[key] || key)}</strong><span class="spacer"></span><span class="tag">${value.count}</span></div>
          <div class="grid grid-3" style="margin-top:10px">
            <div><span class="stat-label">Average</span><b>${value.average} fpm</b></div>
            <div><span class="stat-label">Best</span><b>${value.best} fpm</b></div>
            <div><span class="stat-label">Firmest</span><b>${value.worst} fpm</b></div>
          </div>
        </div>`).join('') : '<div class="card muted small">No landings with a vertical-speed sample yet.</div>'}
      </div>

      ${summary.skipped.noRecord ? `<div class="notice" style="margin-top:18px">
        <div><strong>${summary.skipped.noRecord} flight${summary.skipped.noRecord === 1 ? '' : 's'} have no landing data.</strong>
        <br>Landing analytics only exist for flights recorded after this feature was enabled. Older records are untouched and still appear in the logbook.</div>
      </div>` : ''}

      <div class="section-title"><h2>History</h2><span class="hint">${filtered.length} of ${all.length} landings</span></div>
      <div class="card" style="margin-bottom:12px">
        <div class="field-row">
          <div class="field" style="flex:2 1 220px"><label for="landing-search">Search</label>
            <input class="input" id="landing-search" placeholder="Airport, runway or aircraft" value="${esc(search)}"></div>
          <div class="field"><label for="landing-grade">Rating</label>
            <select class="input" id="landing-grade">${['all', 'smooth', 'good', 'firm', 'hard', 'severe', 'unclassified'].map(key => `<option value="${key}" ${grade === key ? 'selected' : ''}>${key === 'all' ? 'All ratings' : key[0].toUpperCase() + key.slice(1)}</option>`).join('')}</select></div>
          <div class="field"><label for="landing-class">Aircraft class</label>
            <select class="input" id="landing-class"><option value="all">All classes</option>${Object.keys(CLASS_NAMES).map(key => `<option value="${key}" ${classFilter === key ? 'selected' : ''}>${CLASS_NAMES[key]}</option>`).join('')}</select></div>
          <div class="field"><label for="landing-sort">Sort</label>
            <select class="input" id="landing-sort">
              <option value="date-desc" ${sort === 'date-desc' ? 'selected' : ''}>Newest first</option>
              <option value="date-asc" ${sort === 'date-asc' ? 'selected' : ''}>Oldest first</option>
              <option value="vs-best" ${sort === 'vs-best' ? 'selected' : ''}>Softest touchdown</option>
              <option value="vs-worst" ${sort === 'vs-worst' ? 'selected' : ''}>Firmest touchdown</option>
            </select></div>
        </div>
      </div>

      ${filtered.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Flight</th><th>Aircraft</th><th class="num">Touchdown</th><th class="num">GS</th><th>Runway</th><th class="num">From threshold</th><th>Rating</th><th></th></tr></thead>
        <tbody>${filtered.map(item => `<tr>
          <td class="nowrap">${esc(fmtDate(item.at))}</td>
          <td><span class="route-id">${esc(item.departure || '????')}</span> <span class="route-arrow">→</span> ${esc(item.airport || '????')}</td>
          <td>${esc(item.aircraft)}</td>
          <td class="num"><b>${item.vsFpm}</b> fpm</td>
          <td class="num">${item.gsKt != null ? `${item.gsKt} kt` : '—'}</td>
          <td>${item.runway ? `${esc(item.runway.id)} ${item.runway.headingAligned === false ? tag('heading mismatch', 'warn') : ''}` : '<span class="muted">not matched</span>'}</td>
          <td class="num">${item.runway ? `${num(item.runway.distanceFromThresholdFt)} ft` : '—'}</td>
          <td>${landingTag(item.classification, `${item.classification.description} (${item.classification.basis || ''})`)}${item.estimated && item.estimated.vs ? ' <span class="tag" title="Vertical speed was not measured in a dedicated touchdown window">est.</span>' : ''}</td>
          <td class="right"><button class="btn small" data-flight="${esc(item.flightId)}">Details</button>
            <button class="btn small ghost" data-replay="${esc(item.flightId)}">Replay</button></td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="card">${all.length ? '<p class="muted small">No landings match these filters.</p>' : '<p class="muted small">No landing data yet. Fly with the bridge running and land; the next landing will be analysed automatically.</p>'}</div>`}

      <p class="help" style="margin-top:14px">Touchdown location and runway distance are estimates from the recorded position, not certified runway measurements. Where a measurement is unavailable it is shown as “—” rather than guessed.</p>
    `;

    root.querySelector('#toggle-thresholds').addEventListener('click', () => { editing = !editing; render(); });
    root.querySelector('#landing-search').addEventListener('input', event => { search = event.target.value; render(); });
    root.querySelector('#landing-grade').addEventListener('change', event => { grade = event.target.value; render(); });
    root.querySelector('#landing-class').addEventListener('change', event => { classFilter = event.target.value; render(); });
    root.querySelector('#landing-sort').addEventListener('change', event => { sort = event.target.value; render(); });
    root.querySelectorAll('[data-flight]').forEach(button => button.addEventListener('click', () => ctx.openFlight(button.dataset.flight)));
    root.querySelectorAll('[data-replay]').forEach(button => button.addEventListener('click', () => ctx.go('replay', { flight: button.dataset.replay })));
    const save = root.querySelector('#save-thresholds');
    if (save) {
      save.addEventListener('click', async () => {
        const next = {};
        for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
          const values = ['smooth', 'good', 'firm', 'hard'].map(field => {
            const input = root.querySelector(`[data-threshold="${key}.${field}"]`);
            return input ? Number(input.value) : DEFAULT_THRESHOLDS[key][field];
          });
          const ordered = values.every((value, index) => index === 0 || value <= values[index - 1]);
          if (!ordered) { toast(`Thresholds for ${CLASS_NAMES[key]} must get firmer from left to right.`, 'bad'); return; }
          next[key] = { smooth: values[0], good: values[1], firm: values[2], hard: values[3] };
        }
        saveThresholdOverrides(next);
        await ctx.setThresholds(next);
        toast('Landing thresholds saved on this device.', 'good');
        editing = false;
        render();
      });
      root.querySelector('#reset-thresholds').addEventListener('click', async () => {
        saveThresholdOverrides({});
        await ctx.setThresholds({});
        toast('Thresholds reset to the Stratos defaults.');
        render();
      });
    }
  };

  function thresholdEditor(overrides) {
    return `<div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Rating thresholds (fpm)</h2><span class="hint">Negative values: closer to zero is softer</span></div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Class</th><th>Smooth</th><th>Good</th><th>Firm</th><th>Hard</th></tr></thead><tbody>
      ${Object.entries(DEFAULT_THRESHOLDS).map(([key, defaults]) => {
        const values = { ...defaults, ...(overrides[key] || {}) };
        return `<tr><td>${CLASS_NAMES[key]}</td>
          ${['smooth', 'good', 'firm', 'hard'].map(field => `<td><input class="input" style="min-width:88px" type="number" step="10" max="0" data-threshold="${key}.${field}" value="${values[field]}" aria-label="${CLASS_NAMES[key]} ${field} fpm"></td>`).join('')}
        </tr>`;
      }).join('')}
      </tbody></table></div>
      <div class="notice" style="margin-top:10px">These thresholds only change the label shown here. Existing records keep the values recorded with them; nothing is rewritten.</div>
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="save-thresholds">Save thresholds</button>
        <button class="btn ghost" id="reset-thresholds">Reset defaults</button></div>
    </div>`;
  }

  render();
  return { destroy() { root.innerHTML = ''; } };
}

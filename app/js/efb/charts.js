/* EFB · Charts.
 *
 * The FAA's public d-TPP catalogue, read through the same bridge/API endpoints
 * and rendered by the same pdf.js viewer as the tracker's Charts page. A chart
 * is only opened from a publisher Stratos has integrated; everything else shows
 * the publisher's own links instead of a scraped copy. Validity is never assumed:
 * each document carries the cycle window the source published, or says it could
 * not be verified.
 */

import {
  esc, fmtAge, searchAirports, loadChartCatalogue, filterCharts, chartSourcesFor,
} from './common.js';
import {
  canOpenChart, chartCacheKey, isPdfBytes, officialChartUrl, readChartCache,
  validityState, validityText, writeChartCache,
} from '../lib/charts.js';
import { getEntitlement, isPremium } from '../lib/entitlement.js';
import { defaultBridgeBase, isHostedPage } from '../bridge.js';
import { ChartViewer } from '../pilot/charts.js';

const RECENT_KEY = 'stratos.efb.charts.recent';
const CATEGORY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'airport', label: 'Airport' },
  { key: 'sid', label: 'SID' },
  { key: 'star', label: 'STAR' },
  { key: 'approach', label: 'Approach' },
];

function recentAirports() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(item => item && /^[A-Z0-9]{3,5}$/.test(item.icao)).slice(0, 6) : [];
  } catch (_) { return []; }
}

function rememberAirport(icao, name) {
  const list = recentAirports().filter(item => item.icao !== icao);
  list.unshift({ icao, name: name || '' });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6))); } catch (_) { /* private mode */ }
}

function documentUrls(chart) {
  const urls = [];
  if (!isHostedPage()) {
    urls.push(`${defaultBridgeBase().replace(/\/+$/, '')}/chart?cycle=${encodeURIComponent(chart.cycle || '')}&file=${encodeURIComponent(chart.pdf)}`);
  }
  urls.push(`/api/chart?cycle=${encodeURIComponent(chart.cycle || '')}&file=${encodeURIComponent(chart.pdf)}`);
  return urls;
}

export async function mount(root, ctx) {
  const plan = ctx.plan();
  const ofp = plan && plan.ofp;
  const planned = [ofp && ofp.origin && ofp.origin.icao, ofp && ofp.destination && ofp.destination.icao]
    .filter(Boolean)
    .map(code => String(code).toUpperCase());

  let icao = String(ctx.params.get('icao') || recentAirports()[0]?.icao || planned[0] || '').toUpperCase();
  let catalogue = null;
  let groups = [];
  let coverage = null;
  let sourceLinks = [];
  let error = '';
  let loading = false;
  let query = '';
  let category = 'all';
  let selected = null;
  let documentState = { status: 'idle' };
  let viewer = null;
  let entitlement = null;
  let destroyed = false;

  root.innerHTML = `
    <div class="ch-workspace">
      <aside class="ch-side" aria-label="Chart library">
        <div class="ch-side-top">
          <div class="e-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.6"/><path d="m15 15 4.4 4.4"/></svg>
            <input class="e-input" id="chart-icao" placeholder="Airport ICAO or name" value="${esc(icao)}" autocomplete="off" spellcheck="false" aria-label="Search charts by airport">
            <div class="e-results" id="chart-results" hidden></div>
          </div>
          <div class="e-row" style="gap:6px">
            <button class="e-btn small" type="button" data-load>Load charts</button>
            <span class="e-spacer"></span>
            <span class="e-small e-faint" id="chart-count"></span>
          </div>
          <div id="chart-quick" class="ch-quick"></div>
          <div class="e-seg ch-seg" id="chart-filter" role="group" aria-label="Chart type filter">
            ${CATEGORY_FILTERS.map(item => `<button type="button" data-cat="${item.key}" aria-pressed="${item.key === 'all' ? 'true' : 'false'}">${item.label}</button>`).join('')}
          </div>
          <input class="e-input small" id="chart-query" placeholder="Filter documents" aria-label="Filter charts">
        </div>
        <div id="chart-list" class="e-list ch-list"></div>
      </aside>
      <section class="ch-main">
        <div id="chart-notice"></div>
        <div class="e-card chart-frame" id="chart-viewer-card"></div>
      </section>
    </div>`;

  const listEl = root.querySelector('#chart-list');
  const countEl = root.querySelector('#chart-count');
  const noticeEl = root.querySelector('#chart-notice');
  const viewerCard = root.querySelector('#chart-viewer-card');

  function renderQuick() {
    const host = root.querySelector('#chart-quick');
    const recent = recentAirports();
    const items = [];
    for (const code of planned) items.push({ icao: code, label: `Plan · ${code}` });
    for (const item of recent) if (!items.some(entry => entry.icao === item.icao)) items.push({ icao: item.icao, label: item.name || item.icao });
    host.innerHTML = items.length
      ? items.map(item => `<button class="e-btn small ${item.icao === icao ? 'primary' : 'ghost'}" type="button" data-quick="${esc(item.icao)}">${esc(item.label)}</button>`).join('')
      : '<span class="e-small e-faint">Recently opened airports appear here.</span>';
    host.querySelectorAll('[data-quick]').forEach(button => {
      button.addEventListener('click', () => {
        icao = button.dataset.quick;
        root.querySelector('#chart-icao').value = icao;
        load();
      });
    });
  }

  function visibleCharts() {
    if (!catalogue) return [];
    const byCategory = category === 'all'
      ? catalogue.charts
      : catalogue.charts.filter(chart => {
        if (category === 'approach') return ['ils', 'loc', 'rnav', 'vor', 'ndb', 'approach'].includes(chart.category);
        return chart.category === category;
      });
    return filterCharts(byCategory, query);
  }

  function renderList() {
    renderQuick();
    if (loading) {
      listEl.innerHTML = '<div class="e-loading"><i></i>Loading the catalogue…</div>';
      countEl.textContent = '';
      return;
    }
    if (!catalogue) {
      listEl.innerHTML = `<div class="ch-hint">
        <b>No charts loaded</b>
        <span>Search for an airport above, or open one of the airports on this flight.</span>
      </div>`;
      countEl.textContent = '';
      return;
    }
    const charts = visibleCharts();
    countEl.textContent = `${charts.length} doc${charts.length === 1 ? '' : 's'}`;
    if (!charts.length) {
      listEl.innerHTML = `<div class="ch-hint"><b>No matching charts</b><span>Nothing in this catalogue matches the current filter.</span></div>`;
      return;
    }
    listEl.innerHTML = charts.map(chart => {
      const validity = validityState(chart);
      const tone = validity === 'current' ? 'good' : validity === 'expired' ? 'bad' : '';
      return `<button class="e-list-item" type="button" data-chart="${esc(chart.id)}" aria-current="${selected && selected.id === chart.id ? 'true' : 'false'}">
        <div class="li-main"><b>${esc(chart.title || chart.pdf)}</b>
          <span>${esc(chart.categoryLabel || chart.category || 'Chart')}${chart.runways && chart.runways.length ? ` · rw ${esc(chart.runways.join(', '))}` : ''}</span></div>
        <span class="e-badge ${tone}">${validity === 'current' ? 'Current' : validity === 'expired' ? 'Expired' : 'Unverified'}</span>
      </button>`;
    }).join('');
    listEl.querySelectorAll('[data-chart]').forEach(button => {
      button.addEventListener('click', () => {
        const chart = catalogue.charts.find(item => item.id === button.dataset.chart);
        if (chart) openChart(chart);
      });
    });
  }

  function summaryLine(chart) {
    if (!chart) return '';
    return [chart.sourceName || 'FAA d-TPP', chart.format || 'PDF', chart.cycle ? `cycle ${chart.cycle}` : null]
      .filter(Boolean).join(' · ');
  }

  function sourcesPanel() {
    if (!sourceLinks.length) return '';
    return `<div class="ch-sources">
      <div class="ch-sources-head">
        <div class="e-label">Official sources</div>
        <div class="ch-sources-note">These publishers hold the documents for this airport.</div>
      </div>
      <div class="ch-source-list">${sourceLinks.map(source => `<a class="ch-source" href="${esc(source.url)}" target="_blank" rel="noopener">
        <div class="ch-source-main"><b>${esc(source.name || source.label || 'Publisher')}</b><span>${esc(source.note || 'Official aeronautical documents')}</span></div>
        <span class="e-badge">Open ↗</span>
      </a>`).join('')}</div>
      <div class="e-small e-faint">Stratos will not copy or scrape a publisher that has not licensed its documents.</div>
    </div>`;
  }

  function renderViewer() {
    if (!viewerCard) return;
    if (!selected) {
      const external = !catalogue && sourceLinks.length > 0;
      viewerCard.classList.toggle('is-centred', external);
      if (external) {
        viewerCard.innerHTML = `<div class="ch-viewer-head">
            <div class="e-label">Charts · ${esc(icao)}
            </div>
            <div class="ch-viewer-title">No licensed chart to display</div>
            <p class="ch-viewer-text">${esc((coverage && coverage.message) || 'The charts for this airport are published by an external provider.')} Stratos links to the publisher instead of embedding a copy.</p>
          </div>${sourcesPanel()}`;
        return;
      }
      viewerCard.innerHTML = `<div class="ch-viewer-empty">
        <b>No chart open</b>
        <p>Search for an airport, then choose a document from the list. Charts open in the same viewer the tracker uses: wheel or pinch to zoom, drag to pan, Page Up/Down for pages.</p>
      </div>`;
      return;
    }
    viewerCard.classList.remove('is-centred');
    const unlocked = canOpenChart(selected, isPremium(entitlement));
    const official = selected.pdf && selected.cycle ? officialChartUrl(selected.cycle, selected.pdf) : null;
    if (!unlocked) {
      viewerCard.innerHTML = `<div class="e-card" style="border:0;background:none">
        <h3>${esc(selected.title || selected.pdf)} <span class="e-spacer"></span><span class="e-badge warn">Licence required</span></h3>
        <p class="e-small e-muted">This document is part of the integrated chart service. A verified Premium licence is required to open it inside Stratos.</p>
        ${official ? `<a class="e-btn" href="${esc(official)}" target="_blank" rel="noopener">Open the official PDF ↗</a>` : ''}
      </div>`;
      return;
    }
    viewerCard.innerHTML = `
      <div class="e-row" style="margin-bottom:8px">
        <div style="min-width:0">
          <div class="e-value" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(selected.title || selected.pdf)}</div>
          <div class="e-small e-faint">${esc(summaryLine(selected))}</div>
        </div>
        <span class="e-spacer"></span>
        <div class="chart-toolbar">
          <button class="e-btn small" type="button" data-zoom="out" title="Zoom out">−</button>
          <span class="e-small e-faint" id="chart-zoom">—</span>
          <button class="e-btn small" type="button" data-zoom="in" title="Zoom in">+</button>
          <button class="e-btn small" type="button" data-fit="width">Fit width</button>
          <button class="e-btn small" type="button" data-fit="page">Fit page</button>
          <span class="e-small e-faint" id="chart-pages"></span>
          <button class="e-btn small" type="button" data-page="-1" title="Previous page">‹</button>
          <button class="e-btn small" type="button" data-page="1" title="Next page">›</button>
          ${official ? `<a class="e-btn small" href="${esc(official)}" target="_blank" rel="noopener">Official ↗</a>` : ''}
        </div>
      </div>
      <div class="chart-host" id="chart-host"></div>
      <div class="e-small ${validityState(selected) === 'expired' ? 'e-faint' : 'e-muted'}" style="margin-top:8px" id="chart-validity">
        ${selected.local ? 'Local file — not from a verified source.' : esc(validityText(selected))}
      </div>`;

    const host = viewerCard.querySelector('#chart-host');
    if (documentState.status === 'loading') {
      host.innerHTML = '<div class="e-loading" style="padding:24px"><i></i>Opening the document…</div>';
      return;
    }
    if (documentState.status === 'error') {
      host.innerHTML = `<div class="e-notice bad" style="margin:14px"><div><b>The document could not be opened.</b><br>${esc(documentState.error)}</div></div>`;
      return;
    }
    try {
      viewer = new ChartViewer(host, {
        onState: state => {
          if (destroyed) return;
          if (state.error) {
            documentState = { status: 'error', error: state.error };
            renderViewer();
            return;
          }
          const zoom = viewerCard.querySelector('#chart-zoom');
          if (zoom && state.scale) zoom.textContent = `${Math.round(state.scale * 100)}%`;
          const pages = viewerCard.querySelector('#chart-pages');
          if (pages) pages.textContent = state.pages > 1 ? `${state.page} / ${state.pages}` : '';
        },
      });
    } catch (error) {
      host.innerHTML = `<div class="e-notice bad" style="margin:14px">${esc(error.message)}</div>`;
      return;
    }
    viewerCard.querySelectorAll('[data-zoom]').forEach(button => {
      button.addEventListener('click', () => viewer.zoomBy(button.dataset.zoom === 'in' ? 1.25 : 0.8));
    });
    viewerCard.querySelectorAll('[data-fit]').forEach(button => {
      button.addEventListener('click', () => viewer.fit(button.dataset.fit === 'page' ? 'fit-page' : 'fit-width'));
    });
    viewerCard.querySelectorAll('[data-page]').forEach(button => {
      button.addEventListener('click', () => viewer.setPage(viewer.pageNumber + Number(button.dataset.page)));
    });
    if (documentState.bytes) {
      viewer.load(documentState.bytes).catch(error => {
        if (destroyed) return;
        documentState = { status: 'error', error: error && error.message ? error.message : String(error) };
        renderViewer();
      });
    }
  }

  async function openChart(chart) {
    destroyViewer();
    selected = chart;
    documentState = { status: 'loading' };
    renderList();
    renderViewer();
    const url = selected.url || null;
    void url;
    try {
      const key = chartCacheKey(selected);
      const cached = await readChartCache(key);
      let bytes = cached && cached.bytes ? new Uint8Array(cached.bytes) : null;
      let fromCache = Boolean(bytes && isPdfBytes(bytes));
      if (!fromCache) {
        let lastError = 'The document source did not answer.';
        for (const candidate of documentUrls(selected)) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            const response = await fetch(candidate, { cache: 'no-store', signal: controller.signal });
            clearTimeout(timer);
            if (!response.ok) { lastError = `The document source answered ${response.status}.`; continue; }
            const buffer = await response.arrayBuffer();
            if (!isPdfBytes(buffer)) { lastError = 'The source did not return a PDF document.'; continue; }
            bytes = new Uint8Array(buffer);
            fromCache = false;
            await writeChartCache(key, bytes);
            break;
          } catch (error) {
            lastError = error.name === 'AbortError' ? 'The document request timed out.' : error.message;
          }
        }
        if (!bytes) throw new Error(lastError);
      }
      if (destroyed) return;
      documentState = { status: 'ready', bytes, fromCache };
      renderViewer();
    } catch (error) {
      if (destroyed) return;
      documentState = { status: 'error', error: error.message };
      renderViewer();
    }
  }

  function destroyViewer() {
    if (viewer) {
      try { viewer.destroy(); } catch (_) { /* already gone */ }
      viewer = null;
    }
  }

  async function load() {
    icao = String(icao || '').trim().toUpperCase();
    if (!icao) {
      noticeEl.innerHTML = '<div class="e-notice warn">Enter an airport ICAO code or pick one of the suggestions.</div>';
      return;
    }
    destroyViewer();
    selected = null;
    catalogue = null;
    groups = [];
    loading = true;
    error = '';
    sourceLinks = [];
    docShow();
    renderList();
    renderViewer();
    const result = await loadChartCatalogue(icao);
    if (destroyed) return;
    loading = false;
    coverage = result.coverage;
    sourceLinks = result.sources || chartSourcesFor(icao);
    if (!result.ok) {
      error = result.error || '';
      if (result.unsupported) {
        // The viewer pane explains the coverage gap and lists the publishers, so
        // a second banner would only repeat it.
        noticeEl.innerHTML = '';
      } else {
        noticeEl.innerHTML = `<div class="e-notice bad"><div><b>No charts loaded for ${esc(icao)}.</b><br>${esc(error)}</div></div>`;
      }
      renderList();
      renderViewer();
      return;
    }
    catalogue = result.catalogue;
    groups = result.groups;
    noticeEl.innerHTML = `<div class="e-notice"><div><b>${esc(icao)}</b> · ${catalogue.charts.length} documents · ${esc(result.source || 'FAA d-TPP')}${catalogue.cycle ? ` · cycle ${esc(catalogue.cycle)}` : ''}${result.coverage && result.coverage.message ? `<br>${esc(result.coverage.message)}` : ''}</div></div>`;
    rememberAirport(icao, (result.coverage && result.coverage.name) || '');
    renderList();
    if (catalogue.charts.length) {
      const first = visibleCharts()[0] || catalogue.charts[0];
      if (first) openChart(first);
    } else {
      renderViewer();
    }
  }

  function docShow() {
    noticeEl.innerHTML = '';
  }

  /* airport search */
  const searchInput = root.querySelector('#chart-icao');
  const results = root.querySelector('#chart-results');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (term.length < 1) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const rows = await searchAirports(term, 8);
      if (destroyed) return;
      results.hidden = false;
      results.innerHTML = rows.length
        ? rows.map(row => `<button type="button" data-pick="${esc(row.id)}"><b>${esc(row.id)}</b><span>${esc(row.name || '')}</span></button>`).join('')
        : '<div class="e-empty-small">No airports match.</div>';
      results.querySelectorAll('[data-pick]').forEach(button => {
        button.addEventListener('click', () => {
          searchInput.value = button.dataset.pick;
          icao = button.dataset.pick;
          results.hidden = true;
          load();
        });
      });
    }, 180);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      results.hidden = true;
      icao = searchInput.value.trim().toUpperCase();
      load();
    }
    if (event.key === 'Escape') results.hidden = true;
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 160));

  root.querySelector('[data-load]').addEventListener('click', () => {
    icao = searchInput.value.trim().toUpperCase();
    load();
  });

  root.querySelector('#chart-query').addEventListener('input', event => {
    query = event.target.value;
    renderList();
  });

  root.querySelectorAll('[data-cat]').forEach(button => {
    button.addEventListener('click', () => {
      category = button.dataset.cat;
      root.querySelectorAll('[data-cat]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
      renderList();
    });
  });

  entitlement = await getEntitlement().catch(() => null);
  if (destroyed) return {};

  renderQuick();
  if (icao) load();
  else {
    noticeEl.innerHTML = `<div class="e-notice"><div>${planned.length ? `Charts for this flight: ${esc(planned.join(' → '))}.` : 'Search for an airport to see its published charts.'}</div></div>`;
    renderViewer();
  }

  return {
    destroy() {
      destroyed = true;
      destroyViewer();
    },
  };
}

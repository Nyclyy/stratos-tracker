/* Charts — the native chart viewer.
 *
 * The list is real catalogue data from the FAA d-TPP publication, fetched per
 * airport (never a bundled snapshot of URLs, which would go stale every 28
 * days). The document is a PDF rendered by a locally bundled pdf.js build, so
 * the chart stays inside Stratos: no redirect and no third-party frame.
 *
 * ILS approaches are free for everyone. Every other document needs a verified
 * Premium entitlement; the catalogue itself is visible either way.
 */

import { esc, fmtDateTime, num, tag, toast } from '../ui.js';
import { airportResultHtml, searchDirectory, wireSearch } from './common.js';
import {
  describeEntitlement, getEntitlement, isPremium, premiumSetupNotes,
} from '../lib/entitlement.js';
import {
  FAA_SOURCE, accessLevel, canOpenChart, chartCacheKey, groupCharts, isPdfBytes,
  normaliseCatalogue, readChartCache, searchCharts, validityState, validityText, writeChartCache,
} from '../lib/charts.js';
import { coverageText, officialSourcesFor } from '../lib/chartdir.js';
import { chartCoverage, coverageSummary, providerCategories } from '../lib/chartproviders.js';

const FETCH_TIMEOUT = 12000;
const SELECTION_KEY = 'stratos.charts.selection';

let pdfjsPromise = null;

/**
 * Lazy: pdf.js is only fetched when a pilot actually opens a chart.
 *
 * The compat module runs first: the Chromium inside Electron 37 lacks the
 * typed-array hex/base64 helpers pdf.js 6 calls, and without them every
 * document fails with "a.toHex is not a function". The worker loads the same
 * polyfills through worker-compat.mjs, which is the worker entry below.
 */
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../vendor/pdfjs/compat.mjs')
      .then(() => import('../../vendor/pdfjs/pdf.min.mjs'))
      .then(library => {
        library.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/worker-compat.mjs', import.meta.url).href;
        return library;
      })
      .catch(error => { pdfjsPromise = null; throw error; });
  }
  return pdfjsPromise;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function formatWindow(from, to) {
  if (!from || !to) return '';
  const fmt = value => new Date(value).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  return `${fmt(from)} → ${fmt(to)}`;
}

function bytesLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

/* ── the viewer ───────────────────────────────────────────────────────── */

/* Exported so the EFB can render a document with the same viewer the Charts
   page uses: one PDF implementation, one set of gestures, one renderer. */
export class ChartViewer {
  constructor(host, { onState } = {}) {
    this.host = host;
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.doc = null;
    this.pageNumber = 1;
    this.mode = 'fit-width';
    this.zoom = 1;
    this.scale = 1;
    this.pageWidth = 1;
    this.pageHeight = 1;
    this.offset = { x: 0, y: 0 };
    this.renderTask = null;
    this.frame = 0;
    this.destroyed = false;      this.stage = document.createElement('div');
    this.stage.className = 'chart-stage';
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'region');
    this.stage.setAttribute('aria-label', 'Chart document. Use the wheel to zoom, drag to pan, and Page Up or Page Down for other pages.');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-page';
    this.stage.appendChild(this.canvas);
    this.host.appendChild(this.stage);
    this.bind();
  }

  bind() {
    this.onWheel = event => {
      if (!this.doc) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      this.zoomAt(factor, event.clientX, event.clientY);
    };
    this.onPointerDown = event => {
      if (!this.doc || event.button !== 0) return;
      this.drag = { x: event.clientX, y: event.clientY, ox: this.offset.x, oy: this.offset.y };
      this.stage.setPointerCapture(event.pointerId);
      this.stage.classList.add('is-dragging');
    };
    this.onPointerMove = event => {
      if (!this.drag) return;
      this.offset.x = this.drag.ox + (event.clientX - this.drag.x);
      this.offset.y = this.drag.oy + (event.clientY - this.drag.y);
      this.clamp();
      this.apply();
    };
    this.onPointerUp = () => {
      if (!this.drag) return;
      this.drag = null;
      this.stage.classList.remove('is-dragging');
    };
    this.onDoubleClick = () => {
      if (!this.doc) return;
      if (this.mode === 'custom' && this.zoom > 1.2) this.fit('fit-width');
      else this.zoomAt(1.8);
    };
    this.onKey = event => {
      if (!this.doc) return;
      const step = 90;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoomAt(1.25); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); this.zoomAt(0.8); }
      else if (event.key === 'ArrowLeft') { this.offset.x += step; this.clamp(); this.apply(); }
      else if (event.key === 'ArrowRight') { this.offset.x -= step; this.clamp(); this.apply(); }
      else if (event.key === 'ArrowUp') { this.offset.y += step; this.clamp(); this.apply(); }
      else if (event.key === 'ArrowDown') { this.offset.y -= step; this.clamp(); this.apply(); }
      else if (event.key === 'PageDown') { event.preventDefault(); this.setPage(this.pageNumber + 1); }
      else if (event.key === 'PageUp') { event.preventDefault(); this.setPage(this.pageNumber - 1); }
    };
    this.onResize = () => { if (this.mode !== 'custom') this.scheduleRender(); };

    this.stage.addEventListener('wheel', this.onWheel, { passive: false });
    this.stage.addEventListener('pointerdown', this.onPointerDown);
    this.stage.addEventListener('pointermove', this.onPointerMove);
    this.stage.addEventListener('pointerup', this.onPointerUp);
    this.stage.addEventListener('pointercancel', this.onPointerUp);
    this.stage.addEventListener('dblclick', this.onDoubleClick);
    this.stage.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
  }

  async load(bytes) {
    const pdfjs = await loadPdfjs();
    this.doc = await pdfjs.getDocument({
      data: bytes,
      standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
      isEvalSupported: false,
    }).promise;
    if (this.destroyed) { this.doc.destroy(); return; }
    this.pageNumber = 1;
    this.mode = 'fit-width';
    await this.render();
  }

  setPage(number) {
    if (!this.doc) return;
    const next = Math.max(1, Math.min(this.doc.numPages, Math.round(number)));
    if (next === this.pageNumber) return;
    this.pageNumber = next;
    this.offset = { x: 0, y: 0 };
    this.render().catch(error => this.onState({ error: error.message }));
  }

  fit(mode) {
    this.mode = mode === 'fit-page' ? 'fit-page' : 'fit-width';
    this.scheduleRender();
  }

  zoomAt(factor, clientX, clientY) {
    if (!this.doc) return;
    const next = Math.max(0.15, Math.min(6, this.scale * factor));
    if (!Number.isFinite(next) || next === this.scale) return;
    const rect = this.stage.getBoundingClientRect();
    const cx = clientX == null ? rect.width / 2 : clientX - rect.left;
    const cy = clientY == null ? rect.height / 2 : clientY - rect.top;
    const ratio = next / this.scale;
    this.offset.x = cx - (cx - this.offset.x) * ratio;
    this.offset.y = cy - (cy - this.offset.y) * ratio;
    this.mode = 'custom';
    this.zoom = next;
    // Scale the existing bitmap now so the gesture never feels blocked, then
    // re-render at the new resolution on the next frame.
    this.scale = next;
    this.pageWidth *= ratio;
    this.pageHeight *= ratio;
    this.canvas.style.width = `${this.pageWidth}px`;
    this.canvas.style.height = `${this.pageHeight}px`;
    this.clamp();
    this.apply();
    this.scheduleRender();
  }

  zoomBy(factor) {
    this.zoomAt(factor, null, null);
  }

  scheduleRender() {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render().catch(error => {
        if (this.destroyed) return;
        this.onState({ error: error && error.message ? error.message : String(error) });
      });
    });
  }

  async render() {
    if (!this.doc || this.destroyed) return;
    const page = await this.doc.getPage(this.pageNumber);
    if (this.destroyed) return;
    const base = page.getViewport({ scale: 1 });
    const width = this.stage.clientWidth || 640;
    const height = this.stage.clientHeight || 520;
    const fitWidth = (width - 20) / base.width;
    const fitPage = Math.min(fitWidth, (height - 20) / base.height);
    let scale = this.mode === 'fit-page' ? fitPage : this.mode === 'fit-width' ? fitWidth : this.zoom;
    scale = Math.max(0.15, Math.min(6, scale));
    this.scale = scale;
    // Keep the backing store near the CSS size; 3x on a 400% chart costs memory
    // for no visible gain and competes with the simulator for GPU bandwidth.
    const dpr = Math.min(scale > 2 ? 1.25 : 2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: scale * dpr });
    this.canvas.width = Math.max(1, Math.round(viewport.width));
    this.canvas.height = Math.max(1, Math.round(viewport.height));
    this.pageWidth = viewport.width / dpr;
    this.pageHeight = viewport.height / dpr;
    this.canvas.style.width = `${this.pageWidth}px`;
    this.canvas.style.height = `${this.pageHeight}px`;

    const context = this.canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch (_) {}
      this.renderTask = null;
    }
    this.renderTask = page.render({ canvasContext: context, viewport });
    try {
      await this.renderTask.promise;
    } catch (error) {
      if (error && error.name === 'RenderingCancelledException') return;
      throw error;
    } finally {
      this.renderTask = null;
    }
    if (this.destroyed) return;
    if (this.mode !== 'custom') this.offset = { x: 0, y: 0 };
    this.clamp();
    this.apply();
    this.onState({
      ready: true,
      page: this.pageNumber,
      pages: this.doc.numPages,
      scale: this.scale,
      mode: this.mode,
    });
  }

  clamp() {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (this.pageWidth <= width) this.offset.x = (width - this.pageWidth) / 2;
    else this.offset.x = Math.min(0, Math.max(width - this.pageWidth, this.offset.x));
    if (this.pageHeight <= height) this.offset.y = (height - this.pageHeight) / 2;
    else this.offset.y = Math.min(0, Math.max(height - this.pageHeight, this.offset.y));
  }

  apply() {
    this.canvas.style.transform = `translate3d(${this.offset.x.toFixed(1)}px, ${this.offset.y.toFixed(1)}px, 0)`;
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.renderTask) { try { this.renderTask.cancel(); } catch (_) {} }
    this.stage.removeEventListener('wheel', this.onWheel);
    this.stage.removeEventListener('pointerdown', this.onPointerDown);
    this.stage.removeEventListener('pointermove', this.onPointerMove);
    this.stage.removeEventListener('pointerup', this.onPointerUp);
    this.stage.removeEventListener('pointercancel', this.onPointerUp);
    this.stage.removeEventListener('dblclick', this.onDoubleClick);
    this.stage.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    if (this.doc) {
      try { this.doc.destroy(); } catch (_) {}
      this.doc = null;
    }
    this.stage.remove();
  }
}

/* ── the page ─────────────────────────────────────────────────────────── */

export async function mount(root, ctx) {
  let icao = String(ctx.params.get('icao') || '').trim().toUpperCase();
  const saved = icao ? null : readSelection();
  if (saved && saved.icao) icao = String(saved.icao).trim().toUpperCase();
  let catalogue = null;
  let source = null;
  let phase = 'idle';            // idle | loading | ready | missing | unsupported | error
  let message = '';
  let filter = '';
  let selected = null;
  let entitlement = null;
  let documentState = { status: 'idle' };  // idle | loading | ready | error
  let viewer = null;
  let cleanups = [];
  let coverage = chartCoverage(icao);
  let collapsedGroups = new Set();
  let pendingChartId = saved && saved.chartId ? String(saved.chartId) : null;

  // Only the airport and the chart id are kept, and only for this session. No
  // licence state is ever written here: entitlement comes from the main process.
  function readSelection() {
    try {
      const value = globalThis.sessionStorage && globalThis.sessionStorage.getItem(SELECTION_KEY);
      return value ? JSON.parse(value) : null;
    } catch (_) { return null; }
  }

  function saveSelection(chart) {
    try {
      if (!globalThis.sessionStorage) return;
      globalThis.sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ icao, chartId: chart ? chart.id : null }));
    } catch (_) { /* private mode or a full quota: the page still works */ }
  }

  function airportName(code) {
    const found = (Array.isArray(ctx.directory) ? ctx.directory : []).find(airport => airport.id === code);
    return found && found.name ? found.name : '';
  }

  /** Documents in the same order as the visible list, for previous/next. */
  function visibleCharts() {
    return catalogue ? searchCharts(catalogue.charts, filter) : [];
  }

  const sources = () => {
    const list = [];
    const bridge = String(ctx.bridgeBase || '').replace(/\/+$/, '');
    if (bridge) {
      list.push({
        kind: 'bridge',
        meta: code => `${bridge}/charts?icao=${encodeURIComponent(code)}`,
        doc: chart => `${bridge}/chart?cycle=${encodeURIComponent(chart.cycle || '')}&file=${encodeURIComponent(chart.pdf)}`,
      });
    }
    const hosted = /^https?:$/.test(location.protocol) && !/^127\.0\.0\.1$|^localhost$/.test(location.hostname);
    if (hosted) {
      list.push({
        kind: 'hosted',
        meta: code => `/api/charts?icao=${encodeURIComponent(code)}`,
        doc: chart => `/api/chart?cycle=${encodeURIComponent(chart.cycle || '')}&file=${encodeURIComponent(chart.pdf)}`,
      });
    }
    return list;
  };

  function setStatus(text) {
    const el = document.getElementById('chart-viewer-status');
    if (el) el.textContent = text;
  }

  function destroyViewer() {
    if (viewer) { viewer.destroy(); viewer = null; }
  }

  async function loadCatalogue(code) {
    if (!code) { phase = 'idle'; renderList(); return; }
    coverage = chartCoverage(code);
    phase = 'loading';
    message = '';
    catalogue = null;
    selected = null;
    documentState = { status: 'idle' };
    saveSelection(null);
    destroyViewer();
    renderList();
    renderViewer();

    // Never fetch a publisher that has not licensed its documents to Stratos.
    // The publisher links are the honest result, not a failed request.
    if (!coverage.integrated) {
      phase = 'unsupported';
      message = coverage.message;
      renderList();
      renderViewer();
      return;
    }

    let lastError = '';
    for (const candidate of sources()) {
      const timeout = withTimeout(FETCH_TIMEOUT);
      try {
        const response = await fetch(candidate.meta(code), { signal: timeout.signal, cache: 'no-store' });
        timeout.done();
        if (response.status === 404) {
          const payload = await response.json().catch(() => ({}));
          source = candidate;
          phase = payload && payload.unsupported ? 'unsupported' : 'missing';
          message = (payload && (payload.message || payload.error)) || 'No published charts were found for this airport.';
          renderList();
          renderViewer();
          return;
        }
        if (!response.ok) throw new Error(`The chart source answered ${response.status}.`);
        const payload = await response.json();
        source = candidate;
        catalogue = {
          cycle: payload.cycle || null,
          effective: Number(payload.effective) || null,
          expires: Number(payload.expires) || null,
          checkedAt: Number(payload.checkedAt) || null,
          sourceName: payload.sourceName || FAA_SOURCE.name,
          sourceId: payload.source || FAA_SOURCE.id,
          licence: payload.license || FAA_SOURCE.license,
          charts: normaliseCatalogue(payload, code),
        };
        phase = catalogue.charts.length ? 'ready' : 'missing';
        if (!catalogue.charts.length) {
          message = 'This airport has no published terminal procedures in the current cycle.';
          pendingChartId = null;
        }
        renderList();
        renderViewer();
        // Returning to Charts after visiting another page reopens the chart the
        // pilot last had open, but only when it is still in this cycle.
        if (pendingChartId) {
          const restore = catalogue.charts.find(chart => chart.id === pendingChartId);
          pendingChartId = null;
          if (restore) openChart(restore);
        }
        return;
      } catch (error) {
        timeout.done();
        lastError = error && error.name === 'AbortError' ? 'The chart source did not answer in time.' : (error.message || String(error));
      }
    }
    phase = 'error';
    message = lastError || 'The chart source is not reachable.';
    renderList();
    renderViewer();
  }

  function renderHeader() {
    const count = document.getElementById('chart-count');
    const freeCount = catalogue ? catalogue.charts.filter(chart => accessLevel(chart) === 'free').length : 0;
    if (count) count.textContent = catalogue ? `${catalogue.charts.length} documents · ${freeCount} free` : '';
    const el = document.getElementById('charts-head');
    if (!el) return;
    const cycle = catalogue && catalogue.cycle;
    const window = catalogue ? formatWindow(catalogue.effective, catalogue.expires) : '';
    const premium = isPremium(entitlement);
    el.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Charts</h1>
          <p>Official terminal procedures inside Stratos. The catalogue is fetched from the publishing authority; documents are downloaded only when you open one.</p>
        </div>
        <span class="spacer"></span>
        ${catalogue && cycle ? `<span class="tag" title="${esc(catalogue.sourceName)} publication cycle">Cycle ${esc(String(cycle))}</span>` : ''}
        ${premium
          ? tag('Premium', 'good', describeEntitlement(entitlement))
          : tag('ILS/LOC free', 'accent', 'ILS and LOC approach charts open without a licence. Every other category needs a verified Premium licence.')}
      </div>
      ${catalogue ? `<div class="chart-meta">
        <span><b>${esc(catalogue.sourceName)}</b></span>
        <span>${esc(catalogue.licence)}</span>
        ${window ? `<span>${esc(window)}</span>` : ''}
        ${premium ? '' : `<span>${freeCount} ILS/LOC charts open free</span>`}
        ${catalogue.checkedAt ? `<span>Checked ${esc(fmtDateTime(catalogue.checkedAt))}</span>` : ''}
        <span class="spacer"></span>
        <a href="${esc((coverage.provider && coverage.provider.terms) || FAA_SOURCE.terms)}" target="_blank" rel="noopener">Source ↗</a>
      </div>` : `<div class="chart-meta"><span>${esc(coverageSummary())}</span></div>`}
    `;
  }

  /** Links to the publisher instead of copying charts Stratos may not mirror. */
  function officialSourcesHtml(code) {
    const sources = officialSourcesFor(code);
    if (!sources.length) return '';
    return `<span>${esc(coverageText(code))}</span>
      <div class="chart-sources">${sources.map(source => `
        <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">
          <b>${esc(source.name)}</b>
          <span>${esc(source.note)}</span>
        </a>`).join('')}</div>`;
  }

  function airportCard() {
    if (!catalogue) return '';
    const name = airportName(icao);
    const groups = groupCharts(catalogue.charts);
    const free = catalogue.charts.filter(chart => accessLevel(chart) === 'free').length;
    const premium = catalogue.charts.length - free;
    return `<div class="chart-airport">
      <div class="chart-airport-id">
        <span class="route-id">${esc(icao)}</span>
        <div><b title="${esc(name || icao)}">${esc(name || icao)}</b><span>${esc(coverage.country || 'Country not listed')}</span></div>
      </div>
      <div class="chart-airport-stats">
        <span><b>${catalogue.charts.length}</b> documents</span>
        <span class="is-free"><b>${free}</b> free</span>
        <span><b>${premium}</b> Premium</span>
      </div>
      <div class="chart-airport-cats">${groups.map(group => `<span class="chart-cat">${esc(group.label)} <b>${group.charts.length}</b></span>`).join('')}</div>
    </div>`;
  }

  function renderList() {
    const host = document.getElementById('chart-list');
    if (!host) return;
    renderHeader();
    if (phase === 'idle') {
      host.innerHTML = `<div class="chart-empty">
        <strong>Search an airport to see its published charts</strong>
        <span>Type an ICAO code or an airport name — KJFK, Kennedy, CYYZ, EGLL. ILS and LOC approaches are free; every other category is Premium.</span>
        <span>${esc(coverageSummary())}</span>
      </div>`;
      return;
    }
    if (phase === 'loading') {
      host.innerHTML = `<div class="chart-empty"><span class="spinner" aria-hidden="true"></span><strong>Looking up charts for ${esc(icao)}…</strong></div>`;
      return;
    }
    if (phase === 'unsupported') {
      const provider = coverage.provider;
      host.innerHTML = `<div class="chart-empty">
        <strong>${esc(icao)}${coverage.country ? ` · ${esc(coverage.country)}` : ''} — no integrated charts</strong>
        <span>${esc(message || coverage.message)}</span>
        ${provider ? `<span>${esc(provider.name)} publishes: ${esc(providerCategories(provider).join(', ') || 'terminal procedures')}.</span>` : ''}
        <span>Stratos will not copy or scrape a publisher that has not licensed its charts. You can still open a PDF you downloaded from the publisher with <b>Open PDF…</b>; it stays on this device.</span>
        ${officialSourcesHtml(icao)}
      </div>`;
      return;
    }
    if (phase === 'missing') {
      host.innerHTML = `<div class="chart-empty">
        <strong>No published charts for ${esc(icao)}</strong>
        <span>${esc(message || 'The source has no terminal procedures for this airport in the current cycle.')}</span>
        ${officialSourcesHtml(icao)}
      </div>`;
      return;
    }
    if (phase === 'error') {
      host.innerHTML = `<div class="chart-empty bad">
        <strong>Charts could not be loaded</strong>
        <span>${esc(message)}</span>
        <button class="btn small" id="chart-retry">Try again</button>
      </div>`;
      document.getElementById('chart-retry')?.addEventListener('click', () => loadCatalogue(icao));
      return;
    }
    const charts = searchCharts(catalogue.charts, filter);
    if (!charts.length) {
      host.innerHTML = `${airportCard()}<div class="chart-empty"><strong>No chart matches “${esc(filter)}”</strong><span>Clear the filter to see all ${num(catalogue.charts.length)} documents.</span></div>`;
      return;
    }
    const premium = isPremium(entitlement);
    host.innerHTML = `${airportCard()}${groupCharts(charts).map(group => `
      <details class="chart-group" data-group="${esc(group.key)}" ${collapsedGroups.has(group.key) ? '' : 'open'}>
        <summary class="chart-group-head">
          <h3>${esc(group.label)}</h3>
          <span class="hint">${group.charts.length} · ${group.charts.filter(chart => accessLevel(chart) === 'free').length} free</span>
        </summary>
        ${group.charts.map(chart => {
          const level = accessLevel(chart);
          const open = canOpenChart(chart, premium);
          return `
          <button class="chart-row${selected && selected.id === chart.id ? ' is-active' : ''}" data-chart="${esc(chart.id)}" type="button">
            <span class="chart-row-main">
              <b>${esc(chart.title || chart.pdf)}</b>
              <span class="chart-row-sub">
                ${chart.runways.length ? `RWY ${esc(chart.runways.join('/'))} · ` : ''}
                ${chart.approach ? `${esc(chart.approach)} · ` : ''}
                ${esc(chart.code)}
                ${chart.amended ? ` · amended ${esc(new Date(chart.amended).toISOString().slice(0, 10))}` : ''}
              </span>
            </span>
            ${validityState(chart) === 'expired' ? tag('expired', 'bad', validityText(chart)) : ''}
            ${level === 'free'
              ? '<span class="chart-access is-free" title="Open to every pilot">Free</span>'
              : `<span class="chart-access is-premium${open ? '' : ' chart-row-lock'}" title="${open ? 'Included in your licence' : 'Requires a verified Premium licence'}">Premium</span>`}
            ${open ? '<span class="chart-row-go">Open</span>' : ''}
          </button>`;
        }).join('')}
      </details>`).join('')}`;

    host.querySelectorAll('[data-chart]').forEach(button => {
      button.addEventListener('click', () => {
        const chart = catalogue.charts.find(item => item.id === button.dataset.chart);
        if (chart) openChart(chart);
      });
    });
    host.querySelectorAll('details.chart-group').forEach(details => {
      details.addEventListener('toggle', () => {
        if (details.open) collapsedGroups.delete(details.dataset.group);
        else collapsedGroups.add(details.dataset.group);
      });
    });
  }

  function renderViewer() {
    const host = document.getElementById('chart-viewer');
    if (!host) return;
    // An ILS or LOC approach is free, and a PDF the pilot opened from their own
    // disk is theirs; the Premium dialog covers neither.
    const unlocked = canOpenChart(selected, isPremium(entitlement)) || Boolean(selected && selected.local);

    if (!selected) {
      destroyViewer();
      host.innerHTML = `<div class="chart-empty tall">
        <strong>Select a chart</strong>
        <span>ILS and LOC approaches open for every pilot. Zoom with the wheel, drag to pan, double-click to toggle fit, and use the toolbar for pages, reset and full screen.</span>
        <span class="chart-empty-hint">${esc(coverageSummary())}</span>
      </div>`;
      return;
    }
    if (!unlocked) {
      destroyViewer();
      host.innerHTML = premiumPanel();
      wirePremiumPanel(host);
      return;
    }
    if (documentState.status === 'error') {
      destroyViewer();
      host.innerHTML = `<div class="chart-empty tall bad">
        <strong>That chart could not be opened</strong>
        <span>${esc(documentState.error)}</span>
        <button class="btn small" id="chart-open-retry">Try again</button>
      </div>`;
      document.getElementById('chart-open-retry')?.addEventListener('click', () => openChart(selected, true));
      return;
    }
    if (documentState.status !== 'ready') {
      destroyViewer();
      host.innerHTML = `<div class="chart-empty tall">
        <span class="spinner" aria-hidden="true"></span>
        <strong>Opening ${esc(selected.title || selected.pdf)}…</strong>
        <span>${esc(selected.sourceName)} · cycle ${esc(selected.cycle || '—')}</span>
      </div>`;
      return;
    }

    const list = visibleCharts();
    const index = list.findIndex(chart => chart.id === selected.id);
    const previous = index > 0 ? list[index - 1] : null;
    const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;
    host.innerHTML = `
      <div class="chart-toolbar">
        <button class="btn small" data-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
        <button class="btn small" data-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
        <span class="chart-zoom" id="chart-zoom">100%</span>
        <span class="chart-tool-sep"></span>
        <button class="btn small" data-fit="width">Fit width</button>
        <button class="btn small" data-fit="page">Fit page</button>
        <button class="btn small" data-reset title="Reset zoom and pan">Reset view</button>
        <span class="chart-pager" id="chart-pager" hidden>
          <span class="chart-tool-sep"></span>
          <button class="btn small icon" data-page="-1" aria-label="Previous page" title="Previous page">‹</button>
          <span class="chart-pages" id="chart-pages">1 / 1</span>
          <button class="btn small icon" data-page="1" aria-label="Next page" title="Next page">›</button>
        </span>
        <span class="chart-tool-sep"></span>
        <button class="btn small icon" data-doc="-1" ${previous ? '' : 'disabled'} aria-label="Previous chart" title="Previous chart">‹</button>
        <span class="chart-doc-index" title="Chart ${index >= 0 ? index + 1 : '—'} of ${list.length}">${index >= 0 ? `${index + 1} / ${list.length}` : '—'}</span>
        <button class="btn small icon" data-doc="1" ${next ? '' : 'disabled'} aria-label="Next chart" title="Next chart">›</button>
        <span class="spacer"></span>
        <button class="btn small" data-full>Full screen</button>
      </div>
      <div class="chart-canvas" id="chart-canvas"></div>
      <div class="chart-footer">
        <div class="chart-footer-main">
          <b>${esc(selected.title || selected.pdf)}</b>
          <span>${selected.local
            ? 'Local file · opened from this device · not cached or uploaded'
            : `${esc(selected.sourceName)} · ${esc(selected.format || 'PDF')} · cycle ${esc(selected.cycle || '—')}${selected.effective ? ` · effective ${esc(new Date(selected.effective).toISOString().slice(0, 10))}` : ''}${selected.expires ? ` · expires ${esc(new Date(selected.expires).toISOString().slice(0, 10))}` : ''}`}</span>
          ${selected.local ? '' : '<span class="chart-footer-licence">Source attribution: publishing authority · not for navigation</span>'}
          ${selected.url ? `<a class="chart-footer-link" href="${esc(selected.url)}" target="_blank" rel="noopener" title="Open the official document in your browser">Official PDF ↗</a>` : ''}
        </div>
        <div class="chart-validity${selected.local || validityState(selected) === 'expired' ? ' bad' : ''}">
          <span id="chart-viewer-status">${selected.local
            ? 'Local file — not from a verified source. Check the chart cycle and applicability yourself.'
            : esc(validityText(selected))}</span>
        </div>
      </div>`;

    const canvasHost = document.getElementById('chart-canvas');
    viewer = new ChartViewer(canvasHost, {
      onState: state => {
        if (state.error) { documentState = { status: 'error', error: state.error }; renderViewer(); return; }
        const zoom = document.getElementById('chart-zoom');
        if (zoom) zoom.textContent = `${Math.round(state.scale * 100)}%`;
        const pages = document.getElementById('chart-pages');
        if (pages) pages.textContent = `${state.page} / ${state.pages}`;
        const pager = document.getElementById('chart-pager');
        if (pager) pager.hidden = !(state.pages > 1);
      },
    });
    document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => {
      viewer.zoomBy(button.dataset.zoom === 'in' ? 1.25 : 0.8);
    }));
    document.querySelectorAll('[data-fit]').forEach(button => button.addEventListener('click', () => viewer.fit(button.dataset.fit === 'page' ? 'fit-page' : 'fit-width')));
    document.querySelector('[data-reset]')?.addEventListener('click', () => {
      viewer.mode = 'fit-width';
      viewer.offset = { x: 0, y: 0 };
      viewer.scheduleRender();
    });
    document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => viewer.setPage(viewer.pageNumber + Number(button.dataset.page))));
    document.querySelectorAll('[data-doc]').forEach(button => button.addEventListener('click', () => {
      const current = visibleCharts();
      const at = current.findIndex(chart => chart.id === selected.id);
      const target = current[at + Number(button.dataset.doc)];
      if (target) openChart(target);
    }));
    document.querySelector('[data-full]')?.addEventListener('click', () => toggleFullscreen(host, viewer));
  }

  /** On a phone the viewer sits below the catalogue, so bring it into view. */
  function revealViewer() {
    try {
      if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 960px)').matches) return;
      document.querySelector('.chart-viewer-card')?.scrollIntoView?.({ block: 'start' });
    } catch (_) { /* scrolling is an enhancement */ }
  }

  function toggleFullscreen(host, instance) {
    const surface = host.closest('.chart-viewer-card') || host;
    if (!document.fullscreenElement) {
      const request = surface.requestFullscreen || surface.webkitRequestFullscreen;
      if (!request) { toast('Full screen is not available in this window.', 'bad'); return; }
      Promise.resolve(request.call(surface)).then(() => setTimeout(() => instance.scheduleRender(), 60)).catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  /** Open a PDF the pilot downloaded from a publisher that licenses its own charts. */
  async function openLocalFile(file) {
    const name = String(file && file.name ? file.name : 'chart.pdf');
    if (!/\.pdf$/i.test(name) && file.type !== 'application/pdf') {
      toast('Choose a PDF file.', 'bad');
      return;
    }
    if (Number(file.size) > 25 * 1024 * 1024) {
      toast('That PDF is larger than 25 MB.', 'bad');
      return;
    }
    selected = {
      id: `local:${name}:${file.size}`, icao, code: 'LOCAL', category: 'local',
      categoryLabel: 'Local file', title: name.replace(/\.pdf$/i, ''), procedure: null,
      approach: null, runways: [], pdf: name, source: 'local', sourceName: 'Local file',
      cycle: null, effective: null, expires: null, amended: null, checkedAt: null,
      url: null, local: true,
    };
    documentState = { status: 'loading' };
    renderList();
    renderViewer();
    revealViewer();
    try {
      const bytes = await file.arrayBuffer();
      if (!isPdfBytes(bytes)) throw new Error('That file does not start with a PDF header.');
      documentState = { status: 'ready' };
      renderViewer();
      await viewer.load(bytes);
    } catch (error) {
      documentState = { status: 'error', error: error && error.message ? error.message : String(error) };
      renderViewer();
    }
  }

  async function openChart(chart, force = false) {
    selected = chart;
    documentState = { status: 'loading' };
    renderList();
    renderViewer();
    if (!canOpenChart(chart, isPremium(entitlement))) {
      // Nothing was requested: leave no "opening" state behind for a licence
      // check that succeeds later. The dialog is what the pilot sees.
      documentState = { status: 'idle' };
      return;
    }
    saveSelection(chart);
    revealViewer();
    try {
      const key = chartCacheKey(chart);
      let bytes = force ? null : (await readChartCache(key))?.bytes || null;
      if (!bytes) {
        const timeout = withTimeout(20000);
        const response = await fetch(source.doc(chart), { signal: timeout.signal });
        timeout.done();
        if (!response.ok) throw new Error(`The chart document answered ${response.status}.`);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 2048) throw new Error('The chart document is empty.');
        bytes = buffer;
        writeChartCache(key, buffer).catch(() => {});
        setStatus(`${bytesLabel(buffer.byteLength)} downloaded · ${validityText(chart)}`);
      }
      if (!bytes) throw new Error('The chart document could not be read.');
      documentState = { status: 'ready' };
      renderViewer();
      await viewer.load(bytes);
    } catch (error) {
      documentState = { status: 'error', error: error && error.name === 'AbortError' ? 'The download timed out.' : (error.message || String(error)) };
      renderViewer();
    }
  }

  function premiumPanel() {
    const notes = premiumSetupNotes().map(note => `<li>${esc(note)}</li>`).join('');
    const title = selected && (selected.title || selected.pdf);
    return `<div class="chart-lock-panel premium-panel" role="dialog" aria-modal="true" aria-labelledby="chart-lock-title">
      <div class="chart-lock-top">
        <span class="premium-kicker">Stratos Premium</span>
        <button class="chart-lock-close" data-premium-close aria-label="Close" title="Back to the catalogue">×</button>
      </div>
      <h2 id="chart-lock-title">This chart needs Premium</h2>
      <p class="premium-lede"><b>ILS and LOC approach charts are free.</b> Diagrams, SIDs, STARs, RNAV/VOR/NDB approaches and the other supported categories open inside Stratos with a verified Premium licence — zoom, pan, fit, pages and full screen, with no redirect and no embedded third-party site.</p>
      ${title ? `<div class="premium-target">Selected: <b>${esc(selected.icao)} · ${esc(title)}</b></div>` : ''}
      <ul class="premium-list">
        <li><b>Airport diagrams</b><span>Aerodrome and parking charts.</span></li>
        <li><b>Departures and arrivals</b><span>SIDs, STARs and obstacle departures.</span></li>
        <li><b>Other approaches</b><span>RNAV/RNP, VOR, NDB and additional supported procedures.</span></li>
        <li><b>Supplements</b><span>Minimums, hot spots and supplementary documents.</span></li>
      </ul>
      <p class="premium-setup">Only categories the selected source actually publishes appear in the catalogue. Canada, Europe and Australia currently offer official publisher links, because Stratos has no licence to embed those charts.</p>
      <div class="premium-status">
        <b>${isPremium(entitlement) ? 'Premium active' : entitlement && entitlement.mode === 'unavailable' ? 'Premium unavailable here' : 'No active licence'}</b>
        <span>${esc(describeEntitlement(entitlement))}</span>
      </div>
      <details class="premium-setup">
        <summary>What still has to be configured</summary>
        <p>Charts are gated by the app's trusted entitlement channel. This build does not process payments, and a value in browser storage is never treated as a purchase.</p>
        <ol>${notes}</ol>
        <p>For testing, start the desktop app with <code>STRATOS_DEV_PREMIUM=1</code>; it reports a clearly labelled development entitlement.</p>
      </details>
      <div class="btn-row">
        <a class="btn" id="premium-upgrade" href="#settings" title="Open Settings to connect or refresh a licence">Upgrade</a>
        <button class="btn ghost" data-premium-close>Back to charts</button>
        <button class="btn ghost" id="premium-retry">Re-check licence</button>
      </div>
    </div>`;
  }

  function wirePremiumPanel(host) {
    const close = () => {
      selected = null;
      documentState = { status: 'idle' };
      saveSelection(null);
      renderList();
      renderViewer();
    };
    host.querySelectorAll('[data-premium-close]').forEach(button => button.addEventListener('click', close));
    document.getElementById('premium-retry')?.addEventListener('click', async () => {
      entitlement = await getEntitlement({ force: true });
      renderList();
      // If the pilot had already picked a locked chart, honour that pick now.
      if (isPremium(entitlement) && selected) { await openChart(selected); return; }
      renderViewer();
      toast(isPremium(entitlement) ? 'Premium licence verified.' : 'No verified Premium licence on this device.', isPremium(entitlement) ? 'good' : '');
    });
  }

  root.innerHTML = `
    <div id="charts-head"></div>
    <div class="charts-layout">
      <div class="stack charts-viewer-col">
        <div class="card chart-viewer-card">
          <div class="card-head"><h2>Viewer</h2><span class="spacer"></span>
            <button class="btn small" id="chart-open-file" title="Open a PDF you downloaded from an official publisher">Open PDF…</button>
            <span class="hint">Official sources or your own file</span></div>
          <input type="file" id="chart-file" accept="application/pdf,.pdf" hidden>
          <div id="chart-viewer"></div>
        </div>
        <div class="notice"><div><strong>Not for navigation.</strong><br>The documents are reproduced from the publishing authority. Stratos does not verify that the installed cycle matches your simulator's AIRAC, and a chart is flagged when its published cycle has expired.</div></div>
      </div>
      <div class="stack charts-list-col">
        <div class="card">
          <div class="card-head"><h2>Chart catalogue</h2><span class="spacer"></span><span class="hint" id="chart-count"></span></div>
          <div class="chart-search">
            <input class="input" id="chart-airport" placeholder="Airport ICAO or name — KJFK, Kennedy, CYYZ, EGLL" autocomplete="off" spellcheck="false" value="${esc(icao)}">
            <div class="chart-filter-wrap">
              <input class="input" id="chart-filter" placeholder="Filter — ILS 04R, SID, RNAV" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div id="chart-list" class="chart-list" aria-live="polite"></div>
        </div>
      </div>
    </div>
  `;

  // A pilot may download a chart from NAV CANADA or a national AIS portal and
  // open it here. The bytes never leave the device and are not cached as an
  // official document.
  const fileInput = document.getElementById('chart-file');
  document.getElementById('chart-open-file')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    try { fileInput.value = ''; } catch (_) { /* file inputs always allow a reset */ }
    if (file) openLocalFile(file);
  });

  const airportInput = document.getElementById('chart-airport');
  cleanups.push(wireSearch(airportInput, {
    getItems: query => searchDirectory(ctx.directory, query, 8),
    renderItem: airportResultHtml,
    onPick: item => {
      icao = item.id;
      airportInput.value = item.id;
      airportInput.blur();
      pendingChartId = null;
      collapsedGroups.clear();
      loadCatalogue(icao);
      if (history.replaceState) history.replaceState(null, '', `#charts?icao=${encodeURIComponent(icao)}`);
    },
  }));
  airportInput.addEventListener('change', () => {
    const code = airportInput.value.trim().toUpperCase();
    if (!code) return;
    icao = code;
    pendingChartId = null;
    collapsedGroups.clear();
    loadCatalogue(icao);
    if (history.replaceState) history.replaceState(null, '', `#charts?icao=${encodeURIComponent(icao)}`);
  });

  const filterInput = document.getElementById('chart-filter');
  let filterTimer = null;
  filterInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filter = filterInput.value; renderList(); }, 120);
  });
  cleanups.push(() => clearTimeout(filterTimer));

  // Resolve the entitlement first, so the list never opens with a lock icon
  // that belongs to an unverified state.
  entitlement = await getEntitlement();
  if (icao) {
    // The catalogue is a network read; showing the shell first keeps the page
    // responsive and gives the loading state somewhere to live.
    loadCatalogue(icao);
  } else {
    renderList();
    renderViewer();
  }

  return {
    destroy() {
      destroyViewer();
      cleanups.forEach(fn => { try { fn(); } catch (_) {} });
      cleanups = [];
      root.innerHTML = '';
    },
  };
}

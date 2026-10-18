/* Shared UI helpers for the Stratos pages. No framework, no external assets. */

import { formatDuration, formatHours } from './lib/geo.js';

export const $ = selector => document.querySelector(selector);
export const $$ = selector => [...document.querySelectorAll(selector)];

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function num(value, digits = 0, fallback = '—') {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ms) {
  if (!ms) return '—';
  return `${fmtDate(ms)} · ${fmtTime(ms)}`;
}

export function relTime(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const units = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute'], [1000, 'second']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const value = Math.round(abs / size);
      return `${value} ${name}${value === 1 ? '' : 's'} ${diff >= 0 ? 'ago' : 'from now'}`;
    }
  }
  return 'just now';
}

export function hoursText(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '0h 00m';
  return `${Math.floor(hours)}h ${String(Math.round((hours % 1) * 60)).padStart(2, '0')}m`;
}

export function durationText(seconds) {
  return formatDuration(seconds);
}

export { formatHours };

export function setTheme(theme) {
  const value = theme === 'day' ? 'day' : 'night';
  document.documentElement.dataset.theme = value;
  try { localStorage.setItem('dl.theme', value); } catch (_) {}
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'day' ? 'day' : 'night';
}

export function initTheme() {
  let theme = 'night';
  try {
    const stored = localStorage.getItem('dl.theme');
    if (stored === 'day' || stored === 'night' || stored === 'contrast') theme = stored === 'contrast' ? 'night' : stored;
  } catch (_) {}
  setTheme(theme);
  return theme;
}

export function bindThemeToggle(button) {
  if (!button) return;
  const sync = () => {
    const next = currentTheme() === 'night' ? 'day' : 'night';
    button.textContent = next === 'day' ? 'Day mode' : 'Night mode';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  sync();
  button.addEventListener('click', () => {
    setTheme(currentTheme() === 'night' ? 'day' : 'night');
    sync();
  });
}

let toastTimer = null;
export function toast(message, tone = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

export function tag(text, tone = 'muted', title = '') {
  return `<span class="tag tag-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

export function statusDot(state, label) {
  return `<span class="status-inline"><i class="dot dot-${esc(state)}"></i>${esc(label)}</span>`;
}

export function emptyState(title, body, actions = '') {
  return `<div class="empty-state">
    <div class="empty-glyph" aria-hidden="true">✈</div>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${actions ? `<div class="empty-actions">${actions}</div>` : ''}
  </div>`;
}

export function statTile(label, value, hint = '', extraClass = '') {
  return `<div class="stat ${extraClass}">
    <span class="stat-label">${esc(label)}</span>
    <b class="stat-value">${esc(value)}</b>
    ${hint ? `<span class="stat-hint">${hint}</span>` : ''}
  </div>`;
}

/** Simple bar chart as inline SVG (no canvas, no library, crisp on retina). */
export function barChart(data, options = {}) {
  const items = (data || []).filter(d => d && Number.isFinite(Number(d.value)));
  if (!items.length) return `<div class="chart-empty">${esc(options.empty || 'No data yet.')}</div>`;
  const height = options.height || 120;
  const width = 640;
  const padding = { top: 12, right: 8, bottom: 22, left: 8 };
  const max = Math.max(...items.map(d => Number(d.value)), options.minMax || 1);
  const barWidth = (width - padding.left - padding.right) / items.length;
  const bars = items.map((item, index) => {
    const value = Number(item.value);
    const h = Math.max(value > 0 ? 3 : 0, ((height - padding.top - padding.bottom) * value) / max);
    const x = padding.left + index * barWidth + barWidth * 0.16;
    const w = barWidth * 0.68;
    const y = height - padding.bottom - h;
    const label = item.label || '';
    return `<g class="chart-bar"><title>${esc(item.title || `${label}: ${value}`)}</title>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2"></rect>
      ${items.length <= 14 ? `<text x="${(x + w / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="chart-x">${esc(label)}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(options.aria || 'Bar chart')}">${bars}</svg>`;
}

/** Line/spark chart. */
export function lineChart(points, options = {}) {
  const values = (points || []).filter(v => Number.isFinite(Number(v)));
  if (values.length < 2) return `<div class="chart-empty">${esc(options.empty || 'Not enough data yet.')}</div>`;
  const width = 640, height = options.height || 120;
  const min = options.min != null ? options.min : Math.min(...values);
  const max = options.max != null ? options.max : Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const coords = values.map((v, i) => [i * step, height - 8 - ((v - min) / span) * (height - 24)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return `<svg class="chart chart-line" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(options.aria || 'Trend')}">
    <path d="${area}" class="chart-area"></path>
    <path d="${line}" class="chart-stroke"></path>
    ${options.marker ? `<circle cx="${coords[options.marker].x}" cy="${coords[options.marker].y}" r="4" class="chart-marker"></circle>` : ''}
  </svg>`;
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch (_) {}
  area.remove();
  return Promise.resolve();
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.click();
  });
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function initResourceBadge() {
  let mode = 'normal';
  try { mode = localStorage.getItem('stratos.resourceMode') || 'normal'; } catch (_) {}
  const labels = { normal: 'Normal', low: 'Low resource', minimal: 'Minimal' };
  const el = document.getElementById('resource-badge');
  if (el) el.textContent = labels[mode] || 'Normal';
  return mode;
}

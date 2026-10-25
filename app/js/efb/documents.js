/* EFB · Documents & Checklists.
 *
 * Interactive normal, supplementary and emergency checklists from the same
 * community profiles the tracker ships, with the same disclaimer attached: these
 * are simulator aids derived from public procedures, not manufacturer manuals.
 *
 * Progress, bookmarks and the last opened PDF live on this device. A PDF the
 * pilot already owns can be opened here with the same viewer the charts use; it
 * is not uploaded, copied into the app or presented as approved documentation.
 */

import { esc, currentPlan } from './common.js';
import {
  CHECKLIST_PROFILES, GENERIC_PROFILE, detectAircraft, itemKey, phaseLabel,
  progressOf, sectionsOf,
} from '../lib/checklists.js';

const CHECK_KEY = 'stratos.efb.checklist.';
const BOOKMARKS_KEY = 'stratos.efb.documents.bookmarks';
const RECENT_KEY = 'stratos.efb.documents.recent';

function loadJson(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw == null ? fallback : raw;
  } catch (_) { return fallback; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ }
}

function profileName(profile) { return profile.label || profile.key; }

export async function mount(root, ctx) {
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const reported = ofp && ofp.aircraft ? ofp.aircraft.icao : '';
  const matched = detectAircraft({ aircraft: reported });
  let profileKey = matched.profileKey || GENERIC_PROFILE.key;
  let profile = CHECKLIST_PROFILES.find(item => item.key === profileKey) || GENERIC_PROFILE;
  let kind = 'normal';
  let checks = loadJson(CHECK_KEY + profile.key, {}) || {};
  let bookmarks = loadJson(BOOKMARKS_KEY, []) || [];
  let query = '';
  let recent = loadJson(RECENT_KEY, []) || [];
  let viewer = null;
  let destroyed = false;

  root.innerHTML = `
    <div class="e-row" style="margin-bottom:10px">
      <div class="e-field" style="min-width:280px">
        <label for="doc-profile">Aircraft profile</label>
        <select class="e-select" id="doc-profile">
          ${[...CHECKLIST_PROFILES, GENERIC_PROFILE].map(item => `<option value="${esc(item.key)}" ${item.key === profile.key ? 'selected' : ''}>${esc(profileName(item))}</option>`).join('')}
        </select>
      </div>
      <span class="e-spacer"></span>
      <div class="e-seg" id="doc-kind" role="group" aria-label="Procedure type">
        <button type="button" data-kind="normal" aria-pressed="true">Normal</button>
        <button type="button" data-kind="supplementary" aria-pressed="false">Supplementary</button>
        <button type="button" data-kind="emergency" aria-pressed="false">Emergency</button>
        <button type="button" data-kind="bookmarks" aria-pressed="false">Bookmarks</button>
      </div>
    </div>
    <div class="e-row" style="margin-bottom:10px">
      <input class="e-input small" id="doc-search" placeholder="Search this checklist" style="max-width:280px" aria-label="Search checklist items">
      <span class="e-spacer"></span>
      <span class="e-small e-faint" id="doc-progress-label"></span>
      <button class="e-btn small ghost" type="button" data-reset-checklist>Reset progress</button>
    </div>
    <div id="doc-disclaimer"></div>
    <div id="doc-progress"></div>
    <div id="doc-sections" class="e-grid" style="gap:10px;margin-top:10px"></div>

    <h2 style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--efb-muted);margin:20px 2px 8px">Aircraft documents</h2>
    <div class="e-card">
      <h3>Open a PDF from this device</h3>
      <p class="e-small e-muted" style="margin-top:0">Stratos does not bundle manufacturer manuals or pretend a community document is an approved one. Open a PDF you already have — an FCOM, QRH or operator document — and it is rendered here without being uploaded.</p>
      <div class="e-row">
        <button class="e-btn small primary" type="button" data-open-pdf>Open PDF…</button>
        ${recent.length ? `<span class="e-small e-faint">Recent: ${recent.map(name => esc(name)).join(' · ')}</span>` : ''}
      </div>
      <input type="file" accept="application/pdf,.pdf" id="doc-file" hidden>
      <div id="doc-viewer" style="margin-top:10px"></div>
      <div class="e-small e-faint" style="margin-top:8px">A local document carries no verified source or revision. Check its applicability yourself.</div>
    </div>`;

  const sectionsEl = root.querySelector('#doc-sections');
  const progressEl = root.querySelector('#doc-progress');
  const labelEl = root.querySelector('#doc-progress-label');
  const disclaimerEl = root.querySelector('#doc-disclaimer');
  const searchInput = root.querySelector('#doc-search');

  function saveChecks() { saveJson(CHECK_KEY + profile.key, checks); }

  function renderDisclaimer() {
    const text = profile.disclaimer || GENERIC_PROFILE.disclaimer;
    disclaimerEl.innerHTML = `<div class="e-notice warn"><div><b>${esc(profileName(profile))}</b> · ${esc(profile.verification || 'community')}<br>${esc(text)}</div></div>`;
    ctx.setSubtitle(profile.variant || profile.family || '');
  }

  function renderProgress() {
    const progress = progressOf(profile, checks);
    labelEl.textContent = `${progress.done} / ${progress.total} normal items · ${progress.percent}%`;
    progressEl.innerHTML = `<div class="e-bar" data-state="${progress.complete ? 'good' : progress.percent > 0 ? 'warn' : ''}"><b style="width:${progress.percent}%"></b></div>
      <div class="e-small e-faint" style="margin-top:5px">${progress.complete ? 'Every normal item is checked.' : `${progress.remaining} item${progress.remaining === 1 ? '' : 's'} remaining.`} Emergency and supplementary items are counted separately.</div>`;
  }

  function bookmarkKey(sectionKey, index) { return `${profile.key}:${sectionKey}.${index}`; }

  function itemRow(section, item, index) {
    const key = itemKey(section.key, index);
    const done = Boolean(checks[key]);
    const marked = bookmarks.includes(bookmarkKey(section.key, index));
    const hay = `${item.action} ${item.expect} ${item.note || ''} ${section.title}`.toLowerCase();
    if (query && !hay.includes(query.toLowerCase())) return '';
    return `<div class="check-item ${done ? 'done' : ''}" data-item="${esc(key)}">
      <input type="checkbox" id="chk-${esc(key)}" data-check="${esc(key)}" ${done ? 'checked' : ''}>
      <label class="ci-main" for="chk-${esc(key)}">
        <b>${esc(item.action)}</b>
        ${item.expect ? `<span>${esc(item.expect)}</span>` : ''}
        ${item.note ? `<em>${esc(item.note)}</em>` : ''}
      </label>
      <button class="e-btn small ghost" type="button" data-bookmark="${esc(section.key)}:${index}" aria-pressed="${marked}" title="${marked ? 'Remove bookmark' : 'Bookmark this item'}">${marked ? '★' : '☆'}</button>
    </div>`;
  }

  function renderSections() {
    if (kind === 'bookmarks') {
      const rows = bookmarks
        .map(entry => {
          const [profileKey2, itemRef] = entry.split(':');
          const dot = itemRef.lastIndexOf('.');
          const sectionKey = itemRef.slice(0, dot);
          const index = Number(itemRef.slice(dot + 1));
          const source = [...CHECKLIST_PROFILES, GENERIC_PROFILE].find(item => item.key === profileKey2);
          const section = source && (source.sections || []).find(item => item.key === sectionKey);
          const item = section && section.items[index];
          if (!item) return '';
          return `<div class="e-list-item"><div class="li-main"><b>${esc(item.action)}</b><span>${esc(source.label)} · ${esc(section.title)}</span></div>
            <button class="e-btn small ghost" type="button" data-bookmark-full="${esc(entry)}" title="Remove bookmark">★</button></div>`;
        })
        .filter(Boolean);
      sectionsEl.innerHTML = rows.length
        ? rows.join('')
        : `<div class="e-empty"><b>No bookmarks</b><p>Use the star beside an item to keep it here.</p></div>`;
      sectionsEl.querySelectorAll('[data-bookmark-full]').forEach(button => {
        button.addEventListener('click', () => {
          bookmarks = bookmarks.filter(entry => entry !== button.dataset.bookmarkFull);
          saveJson(BOOKMARKS_KEY, bookmarks);
          renderSections();
        });
      });
      return;
    }
    const sections = sectionsOf(profile, kind);
    if (!sections.length) {
      sectionsEl.innerHTML = `<div class="e-empty"><b>No ${esc(kind)} procedures</b><p>This profile does not publish ${esc(kind)} sections.</p></div>`;
      return;
    }
    const html = sections.map(section => {
      const done = section.items.filter((_, index) => checks[itemKey(section.key, index)]).length;
      const rows = section.items.map((item, index) => itemRow(section, item, index)).filter(Boolean).join('');
      if (!rows) return '';
      return `<div class="check-section">
        <header><b>${esc(section.title)}</b><span class="e-badge">${esc(phaseLabel(section.phase))}</span><span class="e-spacer"></span><span class="e-small e-faint">${done} / ${section.items.length}</span></header>
        ${rows}
      </div>`;
    }).filter(Boolean).join('');
    sectionsEl.innerHTML = html || `<div class="e-empty"><b>Nothing matches</b><p>No item in this checklist matches “${esc(query)}”.</p></div>`;

    sectionsEl.querySelectorAll('[data-check]').forEach(input => {
      input.addEventListener('change', () => {
        checks[input.dataset.check] = input.checked;
        saveChecks();
        const row = input.closest('.check-item');
        if (row) row.classList.toggle('done', input.checked);
        renderProgress();
      });
    });
    wireBookmarks(sectionsEl);
  }

  function wireBookmarks(host) {
    host.querySelectorAll('[data-bookmark]').forEach(button => {
      button.addEventListener('click', () => {
        const localKey = `${profile.key}:${button.dataset.bookmark}`;
        const at = bookmarks.indexOf(localKey);
        if (at === -1) bookmarks.push(localKey);
        else bookmarks.splice(at, 1);
        bookmarks = bookmarks.slice(0, 200);
        saveJson(BOOKMARKS_KEY, bookmarks);
        renderSections();
      });
    });
  }

  function render() {
    renderDisclaimer();
    renderProgress();
    renderSections();
  }

  root.querySelector('#doc-profile').addEventListener('change', event => {
    profileKey = event.target.value;
    profile = CHECKLIST_PROFILES.find(item => item.key === profileKey) || GENERIC_PROFILE;
    checks = loadJson(CHECK_KEY + profile.key, {}) || {};
    render();
  });

  root.querySelectorAll('[data-kind]').forEach(button => {
    button.addEventListener('click', () => {
      kind = button.dataset.kind;
      root.querySelectorAll('[data-kind]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
      renderSections();
    });
  });

  searchInput.addEventListener('input', event => {
    query = event.target.value;
    renderSections();
  });

  root.querySelector('[data-reset-checklist]').addEventListener('click', () => {
    if (!Object.keys(checks).length) return;
    checks = {};
    saveChecks();
    render();
  });

  root.querySelector('[data-open-pdf]').addEventListener('click', () => root.querySelector('#doc-file').click());
  root.querySelector('#doc-file').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const host = root.querySelector('#doc-viewer');
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      host.innerHTML = '<div class="e-notice bad">Choose a PDF file.</div>';
      return;
    }
    if (Number(file.size) > 25 * 1024 * 1024) {
      host.innerHTML = '<div class="e-notice bad">That file is larger than 25 MB.</div>';
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength < 5 || new Uint8Array(bytes, 0, 5)[0] !== 0x25) throw new Error('That file does not start with a PDF header.');
      if (viewer) { viewer.destroy(); viewer = null; }
      host.innerHTML = '<div class="e-row" style="margin-bottom:6px"><b class="e-small"></b><span class="e-spacer"></span><span class="e-small e-faint"></span></div><div class="chart-host" style="height:420px" id="doc-pdf"></div>';
      host.querySelector('b').textContent = file.name;
      host.querySelector('.e-faint').textContent = `${(file.size / 1048576).toFixed(1)} MB · local file`;
      const { ChartViewer } = await import('../pilot/charts.js');
      viewer = new ChartViewer(host.querySelector('#doc-pdf'), {
        onState: state => {
          if (state.error) host.querySelector('#doc-pdf').innerHTML = `<div class="e-notice bad" style="margin:12px">${esc(state.error)}</div>`;
        },
      });
      await viewer.load(bytes);
      recent = [file.name, ...recent.filter(name => name !== file.name)].slice(0, 5);
      saveJson(RECENT_KEY, recent);
    } catch (error) {
      host.innerHTML = `<div class="e-notice bad">${esc(error.message)}</div>`;
    }
  });

  render();

  return {
    destroy() {
      destroyed = true;
      if (viewer) { try { viewer.destroy(); } catch (_) { /* gone */ } viewer = null; }
    },
  };
}

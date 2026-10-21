/* The visible half of the update system: the announcement dialog and the
   Settings → Updates centre.

   Both are drawn here so the desktop app, the website and the installed iPhone
   app show the same wording and the same states. The component keeps its styles
   in one injected stylesheet: it is opened from many pages, and a dialog must
   never depend on which page stylesheet happens to be loaded. */

import {
  SEVERITY_LABEL,
  CHECK_INTERVAL_MS,
  checkForUpdate,
  changelogGroups,
  formatChecked,
  formatDate,
  isRequired,
  readCache,
  readDismissed,
  shouldPrompt,
  totalChanges,
  writeDismissed,
  updateKind,
  watchServiceWorker,
  activateServiceWorker,
  refreshServiceWorker,
} from './lib/updates.js';
import { APP_VERSION } from './lib/version.js';

const STYLE_ID = 'stratos-update-styles';

const CSS = `
.su-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(3,7,12,.68);backdrop-filter:blur(3px)}
.su-modal{width:min(620px,100%);max-height:min(86vh,780px);overflow:auto;box-sizing:border-box;
  background:#0b1621;color:#e7eef7;border:1px solid rgba(122,160,205,.22);border-radius:16px;
  box-shadow:0 28px 70px rgba(0,0,0,.55);font-family:"Bahnschrift","Segoe UI Variable","Segoe UI",system-ui,sans-serif}
.su-head{padding:22px 24px 0}
.su-eyebrow{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:#7f95ab}
.su-eyebrow i{width:7px;height:7px;border-radius:50%;background:#4d9fe8;flex:0 0 auto}
.su-eyebrow.is-important i{background:#e9c05e}
.su-eyebrow.is-critical i{background:#f0736a}
.su-modal h2{margin:8px 0 6px;font-size:22px;letter-spacing:.005em;line-height:1.2}
.su-sub{margin:0;color:#9db0c3;font-size:13px;line-height:1.55}
.su-versions{display:flex;align-items:center;gap:12px;margin:18px 0 0;padding:14px 16px;
  background:rgba(255,255,255,.035);border:1px solid rgba(122,160,205,.14);border-radius:12px}
.su-version{display:flex;flex-direction:column;gap:2px;min-width:0}
.su-version span{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#7f95ab}
.su-version b{font-size:17px;font-weight:700;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.su-version.is-new b{color:#6fb6f5}
.su-arrow{flex:0 0 auto;color:#61748a;font-size:15px}
.su-meta{margin-left:auto;text-align:right;font-size:11px;color:#8397ac;line-height:1.5}
.su-meta b{display:block;color:#e7eef7;font-size:11.5px}
.su-severity{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:3px 9px;border-radius:999px;
  font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  border:1px solid rgba(122,160,205,.24);color:#9db0c3}
.su-severity.is-important{color:#e9c05e;border-color:rgba(233,192,94,.34);background:rgba(233,192,94,.08)}
.su-severity.is-critical{color:#f0736a;border-color:rgba(240,115,106,.36);background:rgba(240,115,106,.08)}
.su-reason{margin:14px 0 0;padding:11px 13px;border-left:2px solid #f0736a;background:rgba(240,115,106,.07);
  border-radius:0 8px 8px 0;font-size:12.5px;line-height:1.55;color:#e7c3bf}
.su-body{padding:16px 24px 0}
.su-group{margin:0 0 14px}
.su-group h3{margin:0 0 6px;font-size:10.5px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#7f95ab}
.su-group ul{margin:0;padding:0;list-style:none}
.su-group li{position:relative;padding:3px 0 3px 15px;font-size:12.5px;line-height:1.55;color:#c3d1df}
.su-group li::before{content:"";position:absolute;left:2px;top:11px;width:4px;height:4px;border-radius:50%;background:#4d9fe8}
.su-empty{margin:0;color:#8397ac;font-size:12.5px}
.su-more{align-self:flex-start;background:none;border:0;padding:2px 0;color:#6fb6f5;font:inherit;font-size:12px;font-weight:650;cursor:pointer}
.su-more:hover{color:#9dcbf7}
.su-progress{margin:16px 0 0;padding:12px 14px;border:1px solid rgba(122,160,205,.16);border-radius:10px;background:rgba(255,255,255,.025)}
.su-progress-row{display:flex;align-items:baseline;gap:10px;font-size:11.5px;color:#9db0c3}
.su-progress-row b{margin-left:auto;color:#e7eef7;font-variant-numeric:tabular-nums}
.su-bar{height:5px;margin-top:9px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden}
.su-bar span{display:block;height:100%;width:0;background:#4d9fe8;border-radius:3px;transition:width .2s ease}
.su-progress.is-error{border-color:rgba(240,115,106,.34)}
.su-progress.is-error .su-bar span{background:#f0736a}
.su-progress-note{margin:7px 0 0;font-size:11.5px;line-height:1.5;color:#9db0c3}
.su-progress.is-error .su-progress-note{color:#f0a9a3}
.su-foot{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding:14px 24px 16px;margin-top:6px;background:#0b1621;
  border-top:1px solid rgba(122,160,205,.12)}
.su-foot .su-spacer{flex:1 1 auto}
.su-btn{height:34px;padding:0 14px;border-radius:8px;border:1px solid rgba(122,160,205,.22);
  background:rgba(255,255,255,.04);color:#e7eef7;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;
  transition:background-color .12s ease,border-color .12s ease}
.su-btn:hover:not(:disabled){background:rgba(255,255,255,.08);border-color:rgba(122,160,205,.34)}
.su-btn.primary{background:#2f7fc4;border-color:#3f92d8;color:#fff}
.su-btn.primary:hover:not(:disabled){background:#3a8bd0}
.su-btn.ghost{background:none;border-color:transparent;color:#9db0c3}
.su-btn.ghost:hover:not(:disabled){background:rgba(255,255,255,.05);color:#e7eef7}
.su-btn:disabled{opacity:.55;cursor:default}
.su-btn:focus-visible,.su-more:focus-visible,.su-release:focus-visible{outline:2px solid #6fb6f5;outline-offset:2px}
.su-note{margin:0;padding:0 24px 18px;font-size:11px;line-height:1.5;color:#6f8498}

/* Settings centre */
.su-centre{display:flex;flex-direction:column;gap:14px}
.su-centre-top{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.su-fact{background:rgba(255,255,255,.03);border:1px solid rgba(122,160,205,.14);border-radius:10px;padding:10px 12px}
.su-fact span{display:block;font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7f95ab}
.su-fact b{display:block;margin-top:3px;font-size:15px;font-weight:700;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.su-fact small{display:block;margin-top:2px;font-size:10.5px;color:#8397ac}
.su-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.su-status{font-size:12px;color:#9db0c3;line-height:1.5}
.su-status b{color:#e7eef7}
.su-status.is-error{color:#f0a9a3}
.su-history{display:flex;flex-direction:column;gap:6px}
.su-release{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;width:100%;
  padding:9px 11px;border-radius:9px;border:1px solid rgba(122,160,205,.13);background:rgba(255,255,255,.02);
  color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.su-release:hover{background:rgba(255,255,255,.05);border-color:rgba(122,160,205,.26)}
.su-release b{font-size:12.5px;font-variant-numeric:tabular-nums}
.su-release span{font-size:11.5px;color:#9db0c3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.su-release em{font-style:normal;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7f95ab}
.su-release.is-latest{border-color:rgba(111,182,245,.32);background:rgba(77,159,232,.07)}
.su-release.is-latest em{color:#6fb6f5}
.su-centre-empty{margin:0;font-size:12px;color:#8397ac}
@media (max-width:560px){
  .su-centre-top{grid-template-columns:1fr}
  .su-modal h2{font-size:19px}
  .su-versions{flex-wrap:wrap}
  .su-meta{margin-left:0;text-align:left;width:100%}
  .su-foot{padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}
  .su-foot .su-btn.primary{flex:1 1 100%;order:-1}
  .su-head,.su-body{padding-left:16px;padding-right:16px}
  .su-modal{max-height:92vh}
}
@media (prefers-reduced-motion:reduce){
  .su-bar span{transition:none}
}
`;

function ensureStyles(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A dialog shell shared by the announcement and the changelog viewer. */
function mountDialog({ label, onClose }) {
  ensureStyles();
  const backdrop = el('div', 'su-backdrop');
  const modal = el('div', 'su-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', label);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const previous = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    try { previous?.focus?.({ preventScroll: true }); } catch (_) { /* gone */ }
    onClose?.();
  };
  const onKey = event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    // Keep focus inside the dialog while it is open.
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button,a[href],input,select,[tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => modal.querySelector('button.primary, button')?.focus?.({ preventScroll: true }), 30);
  return { backdrop, modal, close };
}

function groupsMarkup(groups) {
  return groups.map(group => `<div class="su-group"><h3>${esc(group.label)}</h3>
    <ul>${group.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`).join('');
}

/** The full notes for one release, in a dialog (used by history and details). */
export function showChangelogDialog(release, { installedVersion = APP_VERSION } = {}) {
  const groups = changelogGroups(release);
  const { modal, close } = mountDialog({ label: `Stratos ${release.version} release notes` });
  modal.innerHTML = `
    <div class="su-head">
      <div class="su-eyebrow ${release.severity === 'critical' ? 'is-critical' : release.severity === 'important' ? 'is-important' : ''}">
        <i></i><span>${esc(SEVERITY_LABEL[release.severity] || 'Release')}</span>
      </div>
      <h2>Stratos ${esc(release.version)}</h2>
      <p class="su-sub">${esc(release.summary || 'Release notes for this build.')}</p>
      <div class="su-versions">
        <div class="su-version"><span>Released</span><b>${esc(formatDate(release.releasedAt) || 'unscheduled')}</b></div>
        <div class="su-meta"><b>${esc(String(totalChanges(release)))} changes</b>listed in these notes</div>
      </div>
      ${release.reason ? `<p class="su-reason"><strong>Why this matters:</strong> ${esc(release.reason)}</p>` : ''}
    </div>
    <div class="su-body">
      ${groups.length ? groupsMarkup(groups) : '<p class="su-empty">No detailed notes were published for this build.</p>'}
    </div>
    <div class="su-foot">
      <span class="su-spacer"></span>
      <button class="su-btn primary" data-close type="button">Close</button>
    </div>
    <p class="su-note">These notes were generated from the release's own changes.${installedVersion ? ` Installed build: v${esc(installedVersion)}.` : ''}</p>`;
  for (const button of modal.querySelectorAll('[data-close]')) {
    button.addEventListener('click', close);
  }
}

/**
 * The announcement. `onApply` performs the update the platform supports: the
 * desktop app starts a verified installer download, the browser activates the
 * waiting service worker (or reloads for a newer build).
 */
export function showUpdateDialog({
  release,
  installedVersion,
  platform = 'web',
  onApply,
  onLater,
  onDetails,
  onClose,
  applyLabel = 'Update now',
  laterLabel = 'Remind me later',
} = {}) {
  const { modal, close } = mountDialog({ label: 'Stratos update available', onClose });
  const kind = updateKind(release, installedVersion);
  const required = isRequired(release, installedVersion);
  const groups = changelogGroups(release);
  const preview = [];
  for (const group of groups) {
    if (preview.length >= 7) break;
    for (const item of group.items) {
      if (preview.length >= 7) break;
      preview.push({ label: group.label, item });
    }
  }

  modal.innerHTML = `
    <div class="su-head">
      <div class="su-eyebrow ${kind === 'critical' ? 'is-critical' : kind === 'important' ? 'is-important' : ''}">
        <i></i><span>${esc(SEVERITY_LABEL[kind] || 'Update available')}</span>
      </div>
      <h2>A new Stratos update is available.</h2>
      <p class="su-sub">Stratos ${esc(release.version)} is published${release.releasedAt ? ` on ${esc(formatDate(release.releasedAt))}` : ''}.
        ${platform === 'desktop' ? 'The signed installer is downloaded from the official release and verified before it runs.' : 'Your logbook, routes and settings stay on this device.'}</p>
      <div class="su-versions">
        <div class="su-version"><span>Installed</span><b>v${esc(installedVersion)}</b></div>
        <span class="su-arrow" aria-hidden="true">→</span>
        <div class="su-version is-new"><span>Available</span><b>v${esc(release.version)}</b></div>
        <div class="su-meta"><b>${esc(formatDate(release.releasedAt) || 'Date not published')}</b>${esc(release.summary || '')}</div>
      </div>
      ${required ? `<p class="su-reason"><strong>Why this update is required:</strong> ${esc(release.reason || `This build is older than the supported minimum of v${release.minimumSupported}.`)}</p>` : ''}
      ${!required && kind === 'critical' && release.reason ? `<p class="su-reason"><strong>Why this update matters:</strong> ${esc(release.reason)}</p>` : ''}
    </div>
    <div class="su-body">
      ${preview.length ? `<div class="su-group" data-preview><h3>What changed</h3>
        <ul>${preview.map(entry => `<li>${esc(entry.item)}</li>`).join('')}</ul>
        ${groups.reduce((n, g) => n + g.items.length, 0) > preview.length
          ? `<button class="su-more" data-details type="button">View full changelog</button>` : ''}
      </div>` : '<p class="su-empty">This release was published without detailed notes.</p>'}
      <div class="su-progress" data-progress hidden>
        <div class="su-progress-row"><span data-progress-label>Preparing…</span><b data-progress-value></b></div>
        <div class="su-bar"><span data-progress-bar></span></div>
        <p class="su-progress-note" data-progress-note></p>
      </div>
    </div>
    <div class="su-foot">
      ${required ? '' : `<button class="su-btn ghost" data-later type="button">${esc(laterLabel)}</button>`}
      <span class="su-spacer"></span>
      <button class="su-btn primary" data-apply type="button">${esc(applyLabel)}</button>
    </div>
    <p class="su-note" data-foot-note>${platform === 'desktop'
      ? 'Stratos closes while the installer runs. The version is confirmed in Settings → Updates after it restarts.'
      : 'Stratos never reloads while you are flight tracking without asking. Your saved flights are untouched.'}</p>`;

  const progress = modal.querySelector('[data-progress]');
  const progressLabel = modal.querySelector('[data-progress-label]');
  const progressValue = modal.querySelector('[data-progress-value]');
  const progressBar = modal.querySelector('[data-progress-bar]');
  const progressNote = modal.querySelector('[data-progress-note]');
  const applyButton = modal.querySelector('[data-apply]');
  const laterButton = modal.querySelector('[data-later]');

  let busy = false;
  const setProgress = ({ percent = null, label = 'Downloading…', note = '', error = false } = {}) => {
    progress.hidden = false;
    progress.classList.toggle('is-error', Boolean(error));
    progressLabel.textContent = label;
    progressValue.textContent = percent == null ? '' : `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
    progressBar.style.width = percent == null ? (error ? '100%' : '12%') : `${Math.max(0, Math.min(100, percent))}%`;
    progressNote.textContent = note;
  };

  modal.querySelector('[data-details]')?.addEventListener('click', () => {
    close();
    if (onDetails) onDetails();
    else showChangelogDialog(release, { installedVersion });
  });
  laterButton?.addEventListener('click', () => {
    if (busy) return;
    close();
    onLater?.();
  });
  applyButton?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    applyButton.disabled = true;
    if (laterButton) laterButton.disabled = true;
    setProgress({ percent: null, label: platform === 'desktop' ? 'Asking for the release…' : 'Applying the update…', note: '' });
    try {
      const result = await onApply?.({ setProgress, close });
      if (result === false) {
        busy = false;
        applyButton.disabled = false;
        if (laterButton) laterButton.disabled = false;
      }
    } catch (error) {
      busy = false;
      applyButton.disabled = false;
      if (laterButton) laterButton.disabled = false;
      setProgress({ percent: null, label: 'The update could not start.', note: error?.message || String(error), error: true });
      applyButton.textContent = 'Retry update';
    }
  });

  return { close, setProgress, element: modal };
}

/* ── Settings → Updates ─────────────────────────────────────────────── */

/**
 * Render the update centre into `root` (a plain container inside a Settings
 * card). It owns its own state: check, retry, history and the dialog.
 */
export async function mountUpdateCenter({ root, installedVersion = APP_VERSION, desktop = null, toast = () => {}, fetchImpl, urls } = {}) {
  ensureStyles();
  let state = {
    checking: false,
    result: null,
    desktop: null,
    error: '',
    progress: null,
  };
  let destroyed = false;
  let progressOff = null;

  const storedCache = readCache();
  if (storedCache) {
    const release = storedCache.manifest.latest;
    state.result = {
      state: release && release.version !== installedVersion ? 'available' : 'current',
      installedVersion,
      latestVersion: release?.version || installedVersion,
      release,
      releases: storedCache.manifest.releases,
      checkedAt: storedCache.checkedAt,
      source: 'cache',
      cached: true,
    };
  }
  if (desktop?.getUpdateStatus) {
    state.desktop = await desktop.getUpdateStatus().catch(() => null);
    if (state.desktop?.currentVersion) installedVersion = state.desktop.currentVersion;
    progressOff = desktop.onUpdateProgress?.(event => {
      if (destroyed || !event) return;
      state.progress = event;
      if (event.state === 'downloaded') {
        state.desktop = { ...(state.desktop || {}), downloaded: true, version: event.version };
        toast(`Stratos v${event.version} is downloaded and verified.`, 'good');
      }
      if (event.state === 'error') state.error = event.message || 'The download failed.';
      paint();
    });
  }

  // `release` is only set when the build is newer than the installed one; the
  // published version's date and notes still come from the history when the app
  // is already current.
  const latestRelease = () => state.result?.release
    || (state.result?.releases || []).find(item => item.version === state.result?.latestVersion)
    || null;
  const latestVersion = () => state.result?.latestVersion || installedVersion;

  async function runCheck({ quiet = false } = {}) {
    if (state.checking) return;
    state.checking = true;
    state.error = '';
    if (!quiet) paint();
    if (desktop?.checkForUpdates) {
      // The desktop updater answers with what it can actually download; the
      // manifest supplies the notes. Both are reported, never merged blindly.
      const desktopStatus = await desktop.checkForUpdates().catch(error => ({ error: error.message }));
      state.desktop = desktopStatus?.supported === false ? { ...(state.desktop || {}), supported: false } : { ...(state.desktop || {}), ...desktopStatus };
    }
    const result = await checkForUpdate({ installedVersion, fetchImpl, urls });
    state.result = result;
    state.checking = false;
    if (result.error) state.error = result.error;
    paint();
    if (!quiet) {
      if (result.state === 'available') toast(`Stratos v${result.latestVersion} is available.`, 'good');
      else if (result.state === 'current') toast(`Stratos v${installedVersion} is the latest version.`, 'good');
      else toast(`Update check failed: ${result.error}`, 'bad');
    }
  }

  function paint() {
    if (destroyed) return;
    const release = latestRelease();
    const checked = state.result?.checkedAt;
    const supported = state.desktop ? state.desktop.supported !== false : true;
    const downloaded = Boolean(state.desktop?.downloaded);
    const statusTone = state.error ? 'is-error' : '';
    const progress = state.progress;
    const percent = progress && Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : null;

    root.innerHTML = `<div class="su-centre">
      <div class="su-centre-top">
        <div class="su-fact"><span>Installed</span><b>v${esc(installedVersion)}</b><small>${esc(platformName())}</small></div>
        <div class="su-fact"><span>Latest published</span><b>${latestVersion() ? `v${esc(latestVersion())}` : '—'}</b>
          <small>${release ? esc(formatDate(release.releasedAt) || 'date not published') : 'not checked yet'}</small></div>
        <div class="su-fact"><span>Last successful check</span><b>${esc(formatChecked(checked))}</b>
          <small>${state.result?.cached ? 'from the last saved answer' : 'live from the release manifest'}</small></div>
      </div>
      ${release && release.version !== installedVersion ? `
        <div class="su-fact" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div style="min-width:0">
            <span>${esc(SEVERITY_LABEL[release.severity] || 'Update available')}</span>
            <b>v${esc(release.version)} · ${esc(release.summary || 'notes published')}</b>
            <small>${esc(String(totalChanges(release)))} changes listed${downloaded ? ' · downloaded and verified' : ''}</small>
          </div>
          <span style="flex:1"></span>
          <button class="su-btn" data-history type="button">Read the notes</button>
          <button class="su-btn primary" data-apply type="button">${downloaded ? 'Restart to update' : 'Update now'}</button>
        </div>` : ''}
      ${progress ? `<div class="su-progress ${progress.state === 'error' ? 'is-error' : ''}">
        <div class="su-progress-row"><span>${esc(progress.label || (progress.state === 'error' ? 'Download failed' : 'Downloading the installer'))}</span>
          <b>${percent == null ? '' : `${Math.round(percent)}%`}</b></div>
        <div class="su-bar"><span style="width:${percent == null ? (progress.state === 'error' ? 100 : 8) : Math.max(0, Math.min(100, percent))}%"></span></div>
        <p class="su-progress-note">${esc(progress.message || progress.note || (progress.state === 'downloaded' ? 'Verified against the published checksum. Restart Stratos to finish.' : ''))}</p>
      </div>` : ''}
      <div class="su-actions">
        <button class="su-btn" data-check type="button" ${state.checking || !supported ? 'disabled' : ''}>${state.checking ? 'Checking…' : 'Check for updates'}</button>
        ${state.error ? '<button class="su-btn" data-retry type="button">Retry</button>' : ''}
        <span class="su-status ${statusTone}">${statusText()}</span>
      </div>
      ${state.result?.cached && state.result.error ? `<p class="su-centre-empty">The release server could not be reached (${esc(state.result.error)}). This panel is showing the saved answer from ${esc(formatChecked(state.result.checkedAt))}; nothing was invented.</p>` : ''}
      ${!supported ? '<p class="su-centre-empty">This build cannot download updates itself. Installed Windows copies update from the official GitHub release.</p>' : ''}
      <div class="su-history" aria-label="Release history">
        ${(state.result?.releases || []).slice(0, 8).map(item => `
          <button class="su-release ${item.version === latestVersion() ? 'is-latest' : ''}" data-release="${esc(item.version)}" type="button">
            <b>v${esc(item.version)}</b>
            <span>${esc(item.summary || 'No summary published')}</span>
            <em>${esc(item.version === installedVersion ? 'Installed' : item.version === latestVersion() ? 'Latest' : formatDate(item.releasedAt))}</em>
          </button>`).join('') || '<p class="su-centre-empty">Release history appears after the first successful check.</p>'}
      </div>
      <p class="su-centre-empty">Updates are published from the project's GitHub releases. Downloads use HTTPS and are verified before they run; flight logs and settings are never touched.</p>
    </div>`;

    root.querySelector('[data-check]')?.addEventListener('click', () => runCheck());
    root.querySelector('[data-retry]')?.addEventListener('click', () => runCheck());
    root.querySelector('[data-history]')?.addEventListener('click', () => {
      if (release) showChangelogDialog(release, { installedVersion });
    });
    root.querySelector('[data-apply]')?.addEventListener('click', () => applyUpdate());
    for (const button of root.querySelectorAll('[data-release]')) {
      button.addEventListener('click', () => {
        const item = (state.result?.releases || []).find(candidate => candidate.version === button.dataset.release);
        if (item) showChangelogDialog(item, { installedVersion });
      });
    }
  }

  function statusText() {
    if (state.checking) return 'Contacting the release manifest…';
    if (state.progress?.state === 'error') return state.progress.message || 'The download failed.';
    // A cached answer is still a real answer: the release it names is available.
    // The network failure is reported beside it, not instead of it.
    if (state.result?.state === 'available') {
      return `v${state.result.latestVersion} is available.${state.result.cached ? ' This is the last saved answer; the release server could not be reached.' : ''}`;
    }
    if (state.result?.state === 'current') {
      return `v${installedVersion} is current.${state.result.error ? ' This is the last saved answer; the release server could not be reached.' : ''}`;
    }
    if (state.desktop?.error) return state.desktop.error;
    if (state.error) return `Update check failed: ${state.error}`;
    if (state.result?.state === 'error') return `Update check failed: ${state.result.error}`;
    return 'Not checked yet.';
  }

  function platformName() {
    if (desktop) return 'Stratos desktop';
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'Installed web app';
    return 'Browser build';
  }

  async function applyUpdate() {
    const release = latestRelease();
    if (desktop?.installUpdate && state.desktop?.downloaded) {
      await desktop.installUpdate().catch(error => { state.error = error.message; });
      return;
    }
    if (desktop?.checkForUpdates) {
      state.progress = { state: 'checking', label: 'Asking for the release…', percent: null };
      paint();
      const result = await desktop.checkForUpdates().catch(error => ({ error: error.message }));
      if (result?.supported === false) {
        state.error = 'This build cannot update itself. Install the published Windows release.';
      } else if (result?.error) {
        state.error = result.error;
      } else if (result?.downloaded) {
        await desktop.installUpdate?.();
      } else if (result?.available) {
        state.progress = { state: 'downloading', label: 'Downloading the installer…', percent: null, message: 'Stratos verifies the package before it runs.' };
      } else {
        state.progress = null;
      }
      paint();
      return;
    }
    const registration = await navigator.serviceWorker?.getRegistration().catch(() => null);
    if (registration?.waiting) {
      await activateServiceWorker(registration);
      window.location.reload();
      return;
    }
    // A newer manifest with no waiting worker means the HTML/asset cache is
    // behind; a network-first reload is the safe way to pick it up.
    window.location.reload();
  }

  paint();
  // A cache hit is shown immediately; refresh it in the background.
  runCheck({ quiet: true });

  return {
    refresh: () => runCheck(),
    destroy() {
      destroyed = true;
      progressOff?.();
      root.innerHTML = '';
    },
  };
}

/* ── App-wide mounting ──────────────────────────────────────────────── */

/**
 * Startup checking, once per page. The check never blocks the app and the
 * prompt is raised only for a release that was not already dismissed.
 *
 * `desktop` is window.stratosDesktop when the page runs inside Electron.
 */
export function initAppUpdates({ desktop = null, installedVersion = APP_VERSION, delay = 2500 } = {}) {
  ensureStyles();
  const state = { registration: null, waiting: null, result: null, dialogOpen: false, timer: null, setProgress: null };

  // Keep the open dialog honest while the installer downloads: the main
  // process reports the percentage, and a finished download has been verified
  // against latest.yml before this event exists.
  const progressOff = desktop?.onUpdateProgress?.(event => {
    if (!state.dialogOpen || !state.setProgress || !event) return;
    if (event.state === 'downloading') {
      state.setProgress({
        percent: Number.isFinite(Number(event.percent)) ? Number(event.percent) : null,
        label: 'Downloading the verified installer…',
        note: 'You can keep using Stratos; it restarts when the download is verified.',
      });
    } else if (event.state === 'downloaded') {
      state.setProgress({
        percent: 100,
        label: `Stratos ${event.version || ''} is downloaded and verified`.trim(),
        note: 'It installs when Stratos quits or next opens, or press Restart to update in Settings → Updates.',
      });
    } else if (event.state === 'error') {
      state.setProgress({
        percent: null,
        label: 'The download did not finish.',
        note: event.message || 'Check the connection and try again; nothing was installed.',
        error: true,
      });
    }
  });

  // One banner, however many times the registration and the updatefound event
  // report the same waiting worker.
  let buildBanner = null;
  const notifyBuild = () => {
    if (state.dialogOpen) return;
    if (buildBanner && buildBanner.isConnected) return;
    const banner = document.createElement('div');
    buildBanner = banner;
    banner.className = 'su-toast';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `<b>A new Stratos build is ready.</b>
      <span>Reload to use it. Nothing is lost, and a flight in progress stays recorded.</span>
      <button type="button" data-reload>Reload now</button>
      <button type="button" data-dismiss aria-label="Dismiss">Later</button>`;
    Object.assign(banner.style, {
      position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      zIndex: '110', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
      maxWidth: 'min(680px, calc(100vw - 24px))', padding: '10px 12px 10px 14px',
      background: '#0b1621', color: '#e7eef7', border: '1px solid rgba(122,160,205,.26)',
      borderRadius: '11px', boxShadow: '0 16px 40px rgba(0,0,0,.45)',
      font: '12.5px/1.45 "Bahnschrift","Segoe UI Variable","Segoe UI",system-ui,sans-serif',
    });
    for (const button of banner.querySelectorAll('button')) {
      Object.assign(button.style, {
        height: '28px', padding: '0 10px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid rgba(122,160,205,.28)', background: 'rgba(255,255,255,.05)', color: '#e7eef7',
        font: 'inherit', fontWeight: '650',
      });
    }
    banner.querySelector('[data-reload]').addEventListener('click', async () => {
      banner.remove();
      buildBanner = null;
      await applyBuild();
    });
    banner.querySelector('[data-dismiss]').addEventListener('click', () => {
      banner.remove();
      buildBanner = null;
    });
    document.body.appendChild(banner);
  };

  const announce = result => {
    if (!result || result.state !== 'available' || !result.release) return;
    if (result.cached && result.error) return;
    const dismissed = readDismissed();
    if (!shouldPrompt(result.release, { installedVersion, dismissed })) return;
    if (state.dialogOpen) return;
    state.dialogOpen = true;
    showUpdateDialog({
      release: result.release,
      installedVersion,
      platform: desktop ? 'desktop' : 'web',
      laterLabel: 'Remind me later',
      onLater: () => {
        state.dialogOpen = false;
        writeDismissed(null, result.release);
      },
      onApply: async ({ setProgress, close }) => {
        state.setProgress = setProgress;
        if (desktop?.checkForUpdates) {
          setProgress({ percent: null, label: 'Asking for the release…', note: 'The installer is verified against the published checksum before it runs.' });
          const status = await desktop.checkForUpdates().catch(error => ({ error: error.message }));
          if (status?.supported === false) throw new Error('This build cannot update itself. Install the published Windows release.');
          if (status?.error) throw new Error(status.error);
          if (status?.downloaded) {
            await desktop.installUpdate?.();
            close();
            return;
          }
          setProgress({ percent: null, label: 'Downloading the signed installer…', note: 'You can keep using Stratos; it restarts when the download is verified.' });
          return;
        }
        if (!state.registration && navigator.serviceWorker) {
          state.registration = await navigator.serviceWorker.getRegistration().catch(() => null);
        }
        // Ask the browser for the deployed shell first: a reload alone can keep
        // serving the cached HTML if a new worker is waiting to take over.
        if (state.registration) {
          setProgress({ percent: null, label: 'Checking the deployed build…', note: '' });
          await refreshServiceWorker(state.registration);
          await new Promise(resolve => setTimeout(resolve, 600));
        }
        if (state.registration?.waiting) {
          setProgress({ percent: null, label: 'Activating the new build…', note: 'The page reloads once. Open flights keep their recorded track.' });
          await activateServiceWorker(state.registration);
          location.reload();
          return;
        }
        setProgress({ percent: null, label: 'Loading the new build…', note: 'The page reloads once; saved flights stay in the logbook.' });
        setTimeout(() => location.reload(), 350);
      },
      onDetails: () => showChangelogDialog(result.release, { installedVersion }),
      onClose: () => { state.dialogOpen = false; },
    });
  };

  const run = async () => {
    const result = await checkForUpdate({ installedVersion });
    state.result = result;
    // A manifest newer than the page means a build update; a waiting service
    // worker means the assets are already downloaded.
    if (result.state === 'available' && result.release) announce(result);
    else if (state.waiting) notifyBuild();
  };

  const start = () => {
    setTimeout(run, delay).unref?.();
    // Keep checking while the app stays open, but never wake a hidden tab: a
    // phone in the background has better uses for its battery.
    state.timer = setInterval(() => {
      if (document.hidden) return;
      checkForUpdate({ installedVersion }).then(result => {
        state.result = result;
        if (result.state === 'available') announce(result);
      });
    }, CHECK_INTERVAL_MS);
    // A browser interval is a number; Node's timer is unref'd so a test process
    // that mounts the shell can still exit.
    state.timer?.unref?.();
    // Re-check when the app returns to the foreground, at most every six hours.
    const last = Number(sessionStorage?.getItem('stratos.update.lastCheck') || 0);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - last < 60 * 60 * 1000) return;
      try { sessionStorage.setItem('stratos.update.lastCheck', String(now)); } catch (_) { /* private mode */ }
      checkForUpdate({ installedVersion }).then(result => {
        if (result.state === 'available') announce(result);
      });
    });
  };

  const applyBuild = async () => {
    if (state.registration?.waiting) {
      await activateServiceWorker(state.registration);
      location.reload();
    } else {
      location.reload();
    }
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(registration => {
      state.registration = registration;
      watchServiceWorker(registration, worker => {
        state.waiting = worker;
        notifyBuild();
      });
      // Compare the deployed build with the cached one without reloading.
      refreshServiceWorker(registration);
    }).catch(() => { /* offline or unsupported; the manifest check still runs */ });
  }

  start();

  const api = {
    check: () => checkForUpdate({ installedVersion }),
    get cached() { return readCache(); },
    lastResult: () => state.result,
    installedVersion,
    applyBuild,
    destroy() {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      progressOff?.();
    },
  };
  try { window.StratosUpdates = api; } catch (_) { /* frozen window */ }
  return api;
}

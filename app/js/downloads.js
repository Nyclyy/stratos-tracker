/* The website's download offer.

   The landing page explains Stratos; this is the offer that meets a visitor on
   the tracker itself, where they are already using the map and may want the
   packaged desktop build. It is website chrome only:

   - it mounts only on an https page that is not loopback, so the desktop app
     (file://), the PC bridge page (http, usually on the LAN), a local dev
     server and the tablet EFB never show it;
   - it lists only the installers the published manifest actually carries, with
     that release's sizes, and links each one to this site's own
     /api/download?p=… endpoint rather than to a third-party file host, so the
     page exposes no external download address;
   - dismissing it leaves a small Downloads control in the same corner, so the
     panel can be reopened without reloading the map or interrupting a flight,
     and a later version may ask once more.

   Nothing here touches the map: the panel is a sibling of the map boxes, the
   canvas keeps running underneath it, and no map state is read or written.
   tests/downloads.test.mjs exercises the decisions and the parsing directly. */

const REPO = 'Nyclyy/stratos-tracker';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const MANIFEST_URL = 'releases.json';
const DOWNLOAD_ENDPOINT = '/api/download';
const DISMISS_KEY = 'stratos.downloads.dismissed';

/* One row per installer that is genuinely published. `asset` is the name
   electron-builder gives that platform's file, and the same name the release
   workflow uploads and checks. */
export const PLATFORMS = [
  { key: 'windows', label: 'Windows', note: 'Installer · x64', asset: /^Stratos-Setup\.exe$/i },
  { key: 'mac-arm64', label: 'macOS', note: 'Apple silicon', asset: /mac-arm64\.dmg$/i },
  { key: 'mac-x64', label: 'macOS', note: 'Intel', asset: /mac-x64\.dmg$/i },
  { key: 'linux-x64', label: 'Linux', note: 'AppImage · x64', asset: /linux-x64\.AppImage$/i },
];

/* The site's own link, resolved server-side to the current file. */
export function downloadUrl(key) {
  return `${DOWNLOAD_ENDPOINT}?p=${encodeURIComponent(key)}`;
}

/* A binary is worth its size on the button; an unknown size is simply left off
   rather than guessed. */
export function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  const mb = size / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function isWebUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

/* The manifest's own table: the release workflow writes it for every platform
   it built, with the asset's URL, digest and size. The URL is only evidence
   that the file exists — the button points at this site's endpoint. */
export function installersFromManifest(manifest) {
  const latest = manifest && manifest.latest;
  const downloads = latest && latest.downloads;
  const version = latest && typeof latest.version === 'string' ? latest.version : '';
  const items = [];
  if (downloads && typeof downloads === 'object') {
    for (const platform of PLATFORMS) {
      const entry = downloads[platform.key];
      if (!entry || !isWebUrl(entry.url)) continue;
      items.push({
        key: platform.key,
        label: platform.label,
        note: platform.note,
        url: downloadUrl(platform.key),
        size: formatSize(entry.size),
      });
    }
  }
  return { version, items };
}

/* The newest release as published, used only when the manifest predates its own
   download table, so a release that has just shipped is still offered. Blockmaps,
   update feeds and the zips the updater reads are not installers for a person. */
export function installersFromRelease(release) {
  const version = String((release && release.tag_name) || '').replace(/^v/i, '');
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const items = [];
  for (const platform of PLATFORMS) {
    const asset = assets.find(item => item && platform.asset.test(String(item.name || '')) && isWebUrl(item.browser_download_url));
    if (!asset) continue;
    items.push({
      key: platform.key,
      label: platform.label,
      note: platform.note,
      url: downloadUrl(platform.key),
      size: formatSize(asset.size),
    });
  }
  return { version, items };
}

/* Website only. The desktop build loads its pages over file:// and exposes
   window.stratosDesktop; the bridge serves over plain http, usually from a LAN
   address; a dev server runs on loopback. None of those is the public site. */
export function downloadPromptEligible(options = {}) {
  const desktop = options.desktop !== undefined
    ? options.desktop
    : (typeof window !== 'undefined' && window.stratosDesktop ? window.stratosDesktop : null);
  if (desktop) return false;
  const protocol = options.protocol !== undefined
    ? options.protocol
    : (typeof location !== 'undefined' ? location.protocol : '');
  const hostname = options.hostname !== undefined
    ? options.hostname
    : (typeof location !== 'undefined' ? location.hostname : '');
  if (protocol !== 'https:') return false;
  return !/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(String(hostname));
}

async function readInstallers(fetchImpl) {
  // The site serves the manifest from its own origin, so this is the normal
  // path and it costs no rate limit.
  try {
    const response = await fetchImpl(MANIFEST_URL, { cache: 'no-cache', headers: { Accept: 'application/json' } });
    if (response && response.ok) {
      const result = installersFromManifest(await response.json());
      if (result.items.length) return result;
    }
  } catch (_) { /* fall through to the published release */ }
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (response && response.ok) {
      const result = installersFromRelease(await response.json());
      if (result.items.length) return result;
    }
  } catch (_) { /* the panel says so and offers a retry */ }
  return { version: '', items: [] };
}

function safeStorage(win) {
  try {
    const storage = win.localStorage;
    const probe = `${DISMISS_KEY}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch (_) {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function buildPanel(doc, state, handlers) {
  const panel = element(doc, 'aside', 'dl-offer');
  panel.id = 'dlOffer';
  panel.setAttribute('role', 'complementary');
  panel.setAttribute('aria-label', 'Download Stratos for your PC');

  const top = element(doc, 'div', 'dl-top');
  top.append(element(doc, 'span', 'dl-eyebrow', 'Download Stratos'));
  if (state.version) top.append(element(doc, 'b', 'dl-ver', `v${state.version}`));
  const close = element(doc, 'button', 'dl-x', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Hide the download options');
  close.title = 'Hide — Downloads brings it back';
  close.addEventListener('click', handlers.hide);
  top.append(element(doc, 'span', 'dl-sp'), close);
  panel.append(top);

  panel.append(element(doc, 'p', 'dl-line',
    'For your PC: the same build the app updates itself from — map, logbook, replay and phone access.'));

  if (state.items.length) {
    const grid = element(doc, 'div', 'dl-grid');
    for (const item of state.items) {
      const link = element(doc, 'a', 'dl-btn');
      link.href = item.url;
      link.setAttribute('download', '');
      link.setAttribute('aria-label', `Download Stratos for ${item.label} (${item.note})`);
      link.append(element(doc, 'span', 'dl-plat', item.label));
      link.append(element(doc, 'small', 'dl-note', item.size ? `${item.note} · ${item.size}` : item.note));
      grid.append(link);
    }
    panel.append(grid);
  } else {
    panel.append(element(doc, 'p', 'dl-line dl-warn',
      state.busy ? 'Looking for the current installers…' : 'The installer list could not be read just now.'));
    const retry = element(doc, 'button', 'dl-retry', state.busy ? 'Trying…' : 'Try again');
    retry.type = 'button';
    retry.disabled = Boolean(state.busy);
    retry.addEventListener('click', handlers.retry);
    panel.append(retry);
  }

  const foot = element(doc, 'div', 'dl-foot');
  foot.append(element(doc, 'span', 'dl-ver-note', 'Windows · macOS · Linux · verified installers'));
  panel.append(foot);
  panel.hidden = Boolean(state.hidden);
  return panel;
}

function buildChip(doc, handlers) {
  const chip = element(doc, 'button', 'dl-chip', '↓ Downloads');
  chip.id = 'dlChip';
  chip.type = 'button';
  chip.hidden = true;
  chip.setAttribute('aria-label', 'Show the Stratos download options');
  chip.title = 'Download Stratos for your PC';
  chip.addEventListener('click', handlers.show);
  return chip;
}

export async function initDownloadPrompt(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const win = options.window || (typeof window !== 'undefined' ? window : null);
  if (!doc || !win || !doc.body) return null;
  if (!downloadPromptEligible(options)) return null;
  if (doc.getElementById('dlOffer')) return null;

  const host = doc.getElementById('app') || doc.body;
  const storage = options.storage || safeStorage(win);
  const fetchImpl = options.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  const read = options.readInstallers || (fetchImpl ? () => readInstallers(fetchImpl) : async () => ({ version: '', items: [] }));
  const state = { version: '', items: [], hidden: false, busy: false };
  let panel = null;
  let chip = null;

  const paint = () => {
    const next = buildPanel(doc, state, { hide, retry });
    if (panel) panel.replaceWith(next);
    else host.append(next);
    panel = next;
    if (chip) chip.hidden = !state.hidden;
  };

  const hide = () => {
    state.hidden = true;
    if (panel) panel.hidden = true;
    if (chip) chip.hidden = false;
    try {
      storage.setItem(DISMISS_KEY, state.version || 'any');
    } catch (_) { /* private mode: the panel simply comes back next visit */ }
  };

  const show = () => {
    state.hidden = false;
    if (panel) panel.hidden = false;
    if (chip) chip.hidden = true;
  };

  const retry = async () => {
    if (state.busy) return;
    state.busy = true;
    paint();
    try {
      const installers = await read();
      if (installers && Array.isArray(installers.items) && installers.items.length) {
        state.version = installers.version || '';
        state.items = installers.items;
      }
    } catch (_) { /* stays on the retry state */ }
    state.busy = false;
    paint();
  };

  let installers;
  try {
    installers = await read();
  } catch (_) {
    installers = { version: '', items: [] };
  }
  if (!installers || !Array.isArray(installers.items)) installers = { version: '', items: [] };
  state.version = installers.version || '';
  state.items = installers.items;

  let dismissed = null;
  try {
    dismissed = storage.getItem(DISMISS_KEY);
  } catch (_) { dismissed = null; }
  // A dismissal applies to the build it was given for: a newer installer may
  // ask once, and an unreadable manifest keeps the quiet state.
  state.hidden = Boolean(dismissed) && (!state.version || dismissed === state.version || dismissed === 'any');

  chip = buildChip(doc, { show });
  paint();
  host.append(chip);
  chip.hidden = !state.hidden;

  const onKey = event => {
    if (event.key === 'Escape' && !state.hidden) hide();
  };
  win.addEventListener('keydown', onKey);
  return {
    panel,
    chip,
    state,
    show,
    hide,
    retry,
    destroy() {
      win.removeEventListener('keydown', onKey);
      if (panel) panel.remove();
      if (chip) chip.remove();
    },
  };
}

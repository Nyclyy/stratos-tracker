/* A TAF decoder for the EFB weather page.
 *
 * The raw forecast is always shown first and never replaced. This module turns
 * the parts a pilot reads at a glance — validity, wind, visibility, weather,
 * cloud — into plain language, for the initial group and for each FM/TEMPO/
 * BECMG group that follows. Anything it does not recognise stays in the raw
 * text instead of being guessed at.
 *
 * No DOM. Pure functions.
 */

import { utcStampNear } from './windsaloft.js';

const WEATHER_WORDS = {
  RA: 'rain', SHRA: 'rain showers', '-RA': 'light rain', '+RA': 'heavy rain',
  DZ: 'drizzle', '-DZ': 'light drizzle', '+DZ': 'heavy drizzle',
  SN: 'snow', SHSN: 'snow showers', '-SN': 'light snow', '+SN': 'heavy snow',
  TS: 'thunderstorm', TSRA: 'thunderstorm with rain', TSSN: 'thunderstorm with snow',
  FZRA: 'freezing rain', FZDZ: 'freezing drizzle', FZFG: 'freezing fog',
  BR: 'mist', FG: 'fog', HZ: 'haze', FU: 'smoke', DU: 'dust',
  SQ: 'squalls', FC: 'funnel cloud', GR: 'hail', GS: 'small hail',
  VCSH: 'showers in the vicinity', VCTS: 'thunderstorm in the vicinity',
  NSW: 'no significant weather', NOSIG: 'no significant change expected',
  '-SHRA': 'light rain showers', '+SHRA': 'heavy rain showers',
  '-TSRA': 'light thunderstorm rain', '+TSRA': 'heavy thunderstorm rain',
};

function decimalVisibility(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text === 'CAVOK') return { sm: 10, metres: 10000, text: 'CAVOK (10 km or more, no significant cloud)' };
  if (text === '9999') return { sm: 6.2, metres: 9999, text: '10 km or more' };
  if (/^P?\d+SM$/.test(text)) {
    const metres = null;
    const n = Number(text.replace(/[PSM]/g, ''));
    if (Number.isFinite(n)) return { sm: text.startsWith('P') ? n : n, metres, text: `${text.startsWith('P') ? 'more than ' : ''}${n} SM` };
  }
  if (/^\d{4}$/.test(text)) {
    const metres = Number(text);
    return { sm: Math.round((metres / 1609.34) * 10) / 10, metres, text: `${metres} m` };
  }
  return null;
}

function parseWind(token) {
  const match = /^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(String(token || '').trim());
  if (!match) return null;
  const factor = match[4] === 'MPS' ? 1.94384 : 1;
  return {
    direction: match[1] === 'VRB' ? null : Number(match[1]),
    speedKt: Math.round(Number(match[2]) * factor),
    gustKt: match[3] ? Math.round(Number(match[3]) * factor) : null,
    text: match[1] === 'VRB'
      ? `variable at ${Math.round(Number(match[2]) * factor)} kt${match[3] ? ` gusting ${Math.round(Number(match[3]) * factor)}` : ''}`
      : `${String(Number(match[1])).padStart(3, '0')}° at ${Math.round(Number(match[2]) * factor)} kt${match[3] ? ` gusting ${Math.round(Number(match[3]) * factor)}` : ''}`,
  };
}

function parseClouds(token) {
  const match = /^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/.exec(String(token || '').trim());
  if (!match) return null;
  const baseFt = Number(match[2]) * 100;
  const cover = { FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast', VV: 'vertical visibility' }[match[1]];
  const type = match[3] === 'CB' ? ' cumulonimbus' : match[3] === 'TCU' ? ' towering cumulus' : '';
  return { cover, baseFt, cb: Boolean(match[3]), text: `${cover} at ${baseFt.toLocaleString('en-US')} ft${type}` };
}

/** Resolve a day-hour stamp to the first instant at or after `afterMs`. */
function after(stamp, afterMs) {
  const match = /^(\d{2})(\d{2})$/.exec(String(stamp || '').trim());
  if (!match) return null;
  const base = new Date(afterMs);
  let best = null;
  for (const offset of [-1, 0, 1, 2]) {
    const candidate = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, Number(match[1]), Number(match[2]));
    if (candidate >= afterMs - 3600 * 1000 && (best === null || candidate < best)) best = candidate;
  }
  return best;
}

function newGroup(type, label) {
  return { type, label, wind: null, visibility: null, weather: [], clouds: [], cavok: false, unknown: [] };
}

/**
 * Decode a TAF.
 * Returns null for empty input; otherwise the initial conditions, the validity
 * window and every change group the text publishes.
 */
export function decodeTaf(raw, now = Date.now()) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const tokens = text.split(' ');
  const station = tokens.find((token, index) => index > 0 && /^[A-Z]{4}$/.test(token)) || null;
  const issue = tokens.find(token => /^\d{6}Z$/.test(token)) || null;
  const validityToken = tokens.find(token => /^\d{4}\/\d{4}$/.test(token)) || null;

  let validFromMs = null;
  let validToMs = null;
  if (validityToken) {
    const [from, to] = validityToken.split('/');
    validFromMs = after(from, now - 36 * 3600 * 1000);
    validToMs = after(to, (validFromMs || now) + 3600 * 1000);
  }

  const initial = newGroup('INITIAL', 'Initial conditions');
  const changes = [];
  let group = initial;

  const read = token => {
    const wind = parseWind(token);
    if (wind) { group.wind = wind; return true; }
    const cloud = parseClouds(token);
    if (cloud) { group.clouds.push(cloud); return true; }
    const vis = decimalVisibility(token);
    if (vis) { group.visibility = vis; group.cavok = token === 'CAVOK'; return true; }
    if (WEATHER_WORDS[token]) {
      group.weather.push(WEATHER_WORDS[token]);
      return true;
    }
    if (/^(PROB\d{2}|FM\d{6}|TEMPO|BECMG|INTER)$/.test(token)) return false;
    if (/^\d{4}\/\d{4}$/.test(token) || /^\d{6}Z$/.test(token) || token === 'TAF' || token === 'AMD' || token === 'COR' || token === 'NIL') return true;
    group.unknown.push(token);
    return true;
  };

  for (const token of tokens) {
    if (/^FM\d{6}$/.test(token)) {
      const time = after(`${token.slice(2, 4)}${token.slice(4, 6)}`, validFromMs || now);
      group = newGroup('FM', `From ${token.slice(2, 4)}/${token.slice(4, 6)}Z`);
      group.atMs = time;
      changes.push(group);
      continue;
    }
    if (token === 'TEMPO' || token === 'BECMG' || token === 'INTER') {
      group = newGroup(token, token === 'TEMPO' ? 'Temporarily' : token === 'BECMG' ? 'Becoming' : 'Intermittent');
      changes.push(group);
      continue;
    }
    if (/^PROB\d{2}$/.test(token)) {
      group = newGroup('PROB', `${token.slice(4)}% probability`);
      changes.push(group);
      continue;
    }
    read(token);
  }

  return {
    station,
    issue,
    issuedMs: issue ? utcStampNear(issue, now) : null,
    validFromMs,
    validToMs,
    initial,
    changes,
    raw: text,
  };
}

export { parseWind, parseClouds, decimalVisibility };

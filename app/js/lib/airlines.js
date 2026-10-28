/* Airline identity for the EFB — the operator's designator, colours and the
 * rules for finding them in a flight plan.
 *
 * Two things worth knowing before editing the table:
 *
 *  1. Logo artwork. A profile may name one file under `images/airlines/`, and
 *     that file is bundled with the app rather than hotlinked. Every bundled
 *     mark came from Wikimedia Commons where the file is published as public
 *     domain; `images/airlines/ATTRIBUTION.md` records the source and licence
 *     of each one. The marks remain the trademarks of their airlines and are
 *     used only to identify the operator whose designator the flight plan
 *     filed. An airline without a bundled file is drawn as a typographic
 *     roundel instead — never as an imitation of a logo.
 *  2. Guesses. A three-letter string is not an airline until it is found in this
 *     table, and a callsign only names an airline when it is a designator
 *     followed by a flight number — never a registration, an airport or a
 *     random identifier.
 *
 * The colour values are the airlines' published brand tones. Where a brand tone
 * is too dark to read as text on the EFB's charcoal surfaces it is lightened to
 * a readable tint of the same hue; the dark brand tone is kept separately and
 * used only for the wallpaper glow.
 */

/**
 * Designator, IATA code, name, readable accent, the brand's deep tone and the
 * bundled mark (a path relative to the EFB page, or null when no licensed file
 * is available and the interface should fall back to the typographic roundel).
 */
export const AIRLINES = Object.freeze([
  { icao: 'ACA', iata: 'AC', name: 'Air Canada', accent: '#ff5563', deep: '#3a0910', logo: 'images/airlines/ACA.svg' },
  { icao: 'AAL', iata: 'AA', name: 'American Airlines', accent: '#4da3ff', deep: '#062440', logo: 'images/airlines/AAL.svg' },
  { icao: 'BAW', iata: 'BA', name: 'British Airways', accent: '#8ab4f8', deep: '#04182e', logo: 'images/airlines/BAW.svg' },
  { icao: 'DAL', iata: 'DL', name: 'Delta Air Lines', accent: '#ff5d73', deep: '#330610', logo: 'images/airlines/DAL.svg' },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa', accent: '#ffc233', deep: '#2b1d02', logo: 'images/airlines/DLH.svg' },
  { icao: 'EZY', iata: 'U2', name: 'easyJet', accent: '#ff8a3d', deep: '#3a1c07', logo: 'images/airlines/EZY.svg' },
  { icao: 'KLM', iata: 'KL', name: 'KLM', accent: '#2fd0ff', deep: '#032a3a', logo: 'images/airlines/KLM.svg' },
  { icao: 'QFA', iata: 'QF', name: 'Qantas', accent: '#ff7a5c', deep: '#3a0d06', logo: 'images/airlines/QFA.svg' },
  { icao: 'RYR', iata: 'FR', name: 'Ryanair', accent: '#5d8fff', deep: '#041a3a', logo: 'images/airlines/RYR.svg' },
  // United's current globe and wordmark are not published under a licence that
  // allows redistribution, so its theme is drawn as the typographic roundel.
  { icao: 'UAL', iata: 'UA', name: 'United Airlines', accent: '#8c9cff', deep: '#0a1030', logo: null },

  /* The rest of the table. None of these carries a bundled mark: a logo is only
     drawn when a file published under a licence that allows redistribution sits
     in `images/airlines/`, and inventing artwork for an airline would be an
     imitation of its trademark. Each is drawn as the typographic roundel of its
     designator, in the brand's own tone. */
  { icao: 'AFR', iata: 'AF', name: 'Air France', accent: '#7f9cff', deep: '#04122e', logo: null },
  { icao: 'SWR', iata: 'LX', name: 'Swiss International Air Lines', accent: '#ff5b52', deep: '#3a0703', logo: null },
  { icao: 'AUA', iata: 'OS', name: 'Austrian Airlines', accent: '#ff6a6a', deep: '#3a0808', logo: null },
  { icao: 'IBE', iata: 'IB', name: 'Iberia', accent: '#ff6b5a', deep: '#380b06', logo: null },
  { icao: 'AEA', iata: 'UX', name: 'Air Europa', accent: '#5f9bff', deep: '#03142e', logo: null },
  { icao: 'TAP', iata: 'TP', name: 'TAP Air Portugal', accent: '#3ddc91', deep: '#04261a', logo: null },
  { icao: 'SAS', iata: 'SK', name: 'Scandinavian Airlines', accent: '#62a9ff', deep: '#04162b', logo: null },
  { icao: 'FIN', iata: 'AY', name: 'Finnair', accent: '#7f9cff', deep: '#050a2b', logo: null },
  { icao: 'NAX', iata: 'DY', name: 'Norwegian', accent: '#ff5f78', deep: '#33060f', logo: null },
  { icao: 'WZZ', iata: 'W6', name: 'Wizz Air', accent: '#ff6bd0', deep: '#33052a', logo: null },
  { icao: 'VLG', iata: 'VY', name: 'Vueling', accent: '#ffd54a', deep: '#332b00', logo: null },
  { icao: 'EIN', iata: 'EI', name: 'Aer Lingus', accent: '#3ddc91', deep: '#04261a', logo: null },
  { icao: 'LOT', iata: 'LO', name: 'LOT Polish Airlines', accent: '#5f9dff', deep: '#04142b', logo: null },
  { icao: 'AEE', iata: 'A3', name: 'Aegean Airlines', accent: '#5f9dff', deep: '#04142b', logo: null },
  { icao: 'THY', iata: 'TK', name: 'Turkish Airlines', accent: '#ff5f5f', deep: '#330404', logo: null },
  { icao: 'UAE', iata: 'EK', name: 'Emirates', accent: '#ff5a5f', deep: '#33070a', logo: null },
  { icao: 'ETD', iata: 'EY', name: 'Etihad Airways', accent: '#e8bb4e', deep: '#2b2103', logo: null },
  { icao: 'QTR', iata: 'QR', name: 'Qatar Airways', accent: '#d76a9f', deep: '#2b0416', logo: null },
  { icao: 'SVA', iata: 'SV', name: 'Saudia', accent: '#4ce08b', deep: '#04261a', logo: null },
  { icao: 'SIA', iata: 'SQ', name: 'Singapore Airlines', accent: '#ffc247', deep: '#33230a', logo: null },
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific', accent: '#3dd6c0', deep: '#032622', logo: null },
  { icao: 'JAL', iata: 'JL', name: 'Japan Airlines', accent: '#ff5c5c', deep: '#330404', logo: null },
  { icao: 'ANA', iata: 'NH', name: 'All Nippon Airways', accent: '#5f9dff', deep: '#04142b', logo: null },
  { icao: 'KAL', iata: 'KE', name: 'Korean Air', accent: '#6f96ff', deep: '#03102e', logo: null },
  { icao: 'CCA', iata: 'CA', name: 'Air China', accent: '#ff5f57', deep: '#330404', logo: null },
  { icao: 'CES', iata: 'MU', name: 'China Eastern Airlines', accent: '#ff6b6b', deep: '#330707', logo: null },
  { icao: 'CSN', iata: 'CZ', name: 'China Southern Airlines', accent: '#59b7ff', deep: '#03192b', logo: null },
  { icao: 'THA', iata: 'TG', name: 'Thai Airways', accent: '#b184f5', deep: '#180a2e', logo: null },
  { icao: 'MAS', iata: 'MH', name: 'Malaysia Airlines', accent: '#5c9fe0', deep: '#031628', logo: null },
  { icao: 'GIA', iata: 'GA', name: 'Garuda Indonesia', accent: '#57b6ff', deep: '#03192b', logo: null },
  { icao: 'EVA', iata: 'BR', name: 'EVA Air', accent: '#3ddc95', deep: '#04261a', logo: null },
  { icao: 'AIC', iata: 'AI', name: 'Air India', accent: '#ff6a5c', deep: '#380b06', logo: null },
  { icao: 'ETH', iata: 'ET', name: 'Ethiopian Airlines', accent: '#4ce08b', deep: '#04261a', logo: null },
  { icao: 'TAM', iata: 'JJ', name: 'LATAM Brasil', accent: '#7f9cff', deep: '#04122e', logo: null },
  { icao: 'AVA', iata: 'AV', name: 'Avianca', accent: '#ff6b6b', deep: '#330707', logo: null },
  { icao: 'AMX', iata: 'AM', name: 'Aeroméxico', accent: '#ff7b7b', deep: '#330909', logo: null },
  { icao: 'JBU', iata: 'B6', name: 'JetBlue', accent: '#5aa9ff', deep: '#03192b', logo: null },
  { icao: 'SWA', iata: 'WN', name: 'Southwest Airlines', accent: '#ffb43d', deep: '#33230a', logo: null },
  { icao: 'ASA', iata: 'AS', name: 'Alaska Airlines', accent: '#3fd6e0', deep: '#032528', logo: null },
  { icao: 'WJA', iata: 'WS', name: 'WestJet', accent: '#3fd6d6', deep: '#032525', logo: null },
  { icao: 'FDX', iata: 'FX', name: 'FedEx Express', accent: '#b184f5', deep: '#180a2e', logo: null },
  { icao: 'UPS', iata: '5X', name: 'UPS Airlines', accent: '#d8a24a', deep: '#2b2008', logo: null },
  { icao: 'TOM', iata: 'BY', name: 'TUI Airways', accent: '#5aa9ff', deep: '#03192b', logo: null },
]);

/** The house identity, used whenever no airline is selected or recognised. */
export const STRATOS_AIRLINE = Object.freeze({
  icao: '', iata: '', name: 'Stratos', accent: '#22d3ee', deep: '#06222b', house: true,
});

const BY_ICAO = new Map(AIRLINES.map(airline => [airline.icao, airline]));

/** An airline record for an ICAO designator, or null. Never a fuzzy match. */
export function airlineByIcao(code) {
  return BY_ICAO.get(String(code || '').trim().toUpperCase()) || null;
}

export function airlineText(airline) {
  if (!airline || airline.house) return 'Stratos';
  return airline.iata || airline.icao;
}

export function airlineTitle(airline) {
  if (!airline || airline.house) return 'Stratos default';
  return `${airline.name} (${airline.icao}${airline.iata ? ` / ${airline.iata}` : ''})`;
}

/**
 * Split a callsign into its airline designator and flight number.
 *
 * Accepted: `ACA123`, `ACA 123`, `ACA123A` — a three-letter ICAO designator and
 * a flight number of one to four digits, optionally with one suffix letter.
 * Anything else is ambiguous and returns null rather than a guess: a
 * registration (`C-FACA`), an airport pair, or a bare number is not a callsign.
 */
export function parseCallsign(callsign) {
  const raw = String(callsign || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw || raw.length > 8) return null;
  const match = raw.match(/^([A-Z]{3})(\d{1,4})([A-Z]?)$/);
  if (!match) return null;
  return { designator: match[1], number: match[2], suffix: match[3] || '', callsign: raw };
}

/**
 * Which airline a flight plan belongs to, and how that was worked out.
 *
 * The plan's own `icao_airline` field is authoritative when it is a designator
 * this table knows. Otherwise the callsign is parsed; a live callsign from the
 * simulator is the last source tried. `source` says which one won so the
 * settings page can state it, and null means nothing recognised — the house
 * theme is then used, never an invented airline.
 */
export function detectAirline(plan, liveCallsign = '') {
  const ofp = plan && plan.ofp ? plan.ofp : null;
  const flight = (ofp && ofp.flight) || {};
  const planCallsign = String(flight.callsign || '').trim().toUpperCase();

  const stated = airlineByIcao(flight.airline);
  if (stated) {
    return { airline: stated, source: 'plan', callsign: planCallsign, designator: stated.icao };
  }

  const fromPlan = parseCallsign(planCallsign);
  const planAirline = fromPlan && airlineByIcao(fromPlan.designator);
  if (planAirline) {
    return { airline: planAirline, source: 'callsign', callsign: planCallsign, designator: fromPlan.designator };
  }

  const live = parseCallsign(liveCallsign);
  const liveAirline = live && airlineByIcao(live.designator);
  if (liveAirline) {
    return { airline: liveAirline, source: 'live', callsign: live.callsign, designator: live.designator };
  }

  return { airline: null, source: null, callsign: planCallsign || String(liveCallsign || ''), designator: '' };
}

/**
 * The airline the EFB should look like right now.
 *
 * A manual choice always wins, so a pilot can override a wrong callsign. In
 * automatic mode the plan decides, and the house theme is the fallback. A
 * manual designator that is not in the table is ignored rather than applied.
 */
export function resolveAirline(prefs = {}, plan = null, liveCallsign = '') {
  const mode = prefs.airlineMode === 'manual' ? 'manual' : 'auto';
  const manual = airlineByIcao(prefs.airline);
  const detected = detectAirline(plan, liveCallsign);
  if (mode === 'manual' && manual) {
    return { airline: manual, mode, detected, source: 'manual', designator: manual.icao };
  }
  if (detected.airline) {
    return { airline: detected.airline, mode, detected, source: detected.source, designator: detected.designator };
  }
  return { airline: null, mode, detected, source: null, designator: '' };
}

export function searchAirlines(query) {
  const q = String(query || '').trim().toUpperCase();
  const list = AIRLINES.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!q) return list;
  return list.filter(airline => airline.icao.startsWith(q)
    || airline.iata === q
    || airline.name.toUpperCase().includes(q));
}

/* ── theme ───────────────────────────────────────────────────────────── */

function channel(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, alpha) {
  const [r, g, b] = channel(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function luminance(hex) {
  const [r, g, b] = channel(hex).map(value => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The accent tokens a section reads, derived from one brand tone. */
export function airlineVars(airline) {
  const air = airline || STRATOS_AIRLINE;
  const accent = /^#[0-9a-f]{6}$/i.test(air.accent || '') ? air.accent : STRATOS_AIRLINE.accent;
  const deep = /^#[0-9a-f]{6}$/i.test(air.deep || '') ? air.deep : STRATOS_AIRLINE.deep;
  return {
    '--efb-accent': accent,
    '--efb-accent-2': accent,
    '--efb-accent-soft': rgba(accent, 0.12),
    '--efb-accent-line': rgba(accent, 0.42),
    // Text on a filled accent control has to be chosen from the accent itself.
    '--efb-accent-ink': luminance(accent) > 0.45 ? '#06121a' : '#ffffff',
    '--efb-airline-deep': deep,
    '--efb-airline-glow': rgba(accent, 0.26),
    '--efb-airline-wash': rgba(deep, 0.9),
  };
}

/**
 * Write the airline's identity onto the document. Called with the resolved
 * airline so every section, including the ones loaded later, reads the same
 * tokens without knowing which airline is active.
 */
export function applyAirline(airline) {
  if (typeof document === 'undefined') return null;
  const air = airline && !airline.house ? airline : null;
  const root = document.documentElement;
  const vars = airlineVars(air);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  document.body.dataset.airline = air ? air.icao : '';
  root.dataset.airline = air ? air.icao : '';
  return air;
}

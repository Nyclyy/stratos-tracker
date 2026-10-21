/* Official chart publishers outside the FAA publication.
 *
 * Stratos only mirrors the FAA d-TPP today, because that is the one source
 * that is public domain and can be fetched per cycle. NAV CANADA, Airservices
 * Australia and the European AIS providers publish their own charts and, on
 * the evidence available, do not grant third-party apps a right to
 * redistribute them: some sell a licence, several state that reproduction
 * needs written permission, and the rest grant nothing explicitly. So this
 * module describes each publisher — region, categories, format, update method
 * and licence position — and links to it instead of copying it.
 *
 * Every entry is a publisher's own portal. Nothing here is scraped, framed or
 * proxied, and a link is not a redistribution licence. A provider that becomes
 * licensed later can be switched to `status: 'integrated'` in
 * chartproviders.js without changing the viewer.
 */

const ALL_CATEGORIES = ['diagram', 'sid', 'star', 'approach', 'odp', 'minimums', 'hotspot', 'supplement'];

function publisher(spec) {
  return {
    status: 'link-only',
    format: 'PDF',
    update: 'AIP amendment cycle',
    categories: ALL_CATEGORIES,
    attribution: 'Publisher name and chart cycle required on display',
    ...spec,
  };
}

const EUROCONTROL_EAD = publisher({
  id: 'ead-basic',
  name: 'EUROCONTROL EAD Basic',
  url: 'https://www.ead.eurocontrol.int/cms-eadbasic/opencms/en/ead-solutions/ead-basic/',
  note: 'Free after registration. A consultation tool, not an app feed.',
  country: 'Europe',
  regions: ['Europe'],
  status: 'portal',
  licence: 'Free consultation for registered users; no redistribution grant',
  update: 'AIRAC / AIP amendment',
});

const AIS_INDEX = publisher({
  id: 'ais-online',
  name: 'EUROCONTROL — AIS Online index',
  url: 'https://www.eurocontrol.int/articles/ais-online',
  note: 'Links to each national AIS portal.',
  country: 'Europe',
  regions: ['Europe'],
  status: 'portal',
  licence: 'Index only; each national portal sets its own terms',
  update: 'Follows the national AIP',
});

const CANADA = publisher({
  id: 'navcanada',
  name: 'NAV CANADA — AIP Canada',
  url: 'https://www.navcanada.ca/en/aeronautical-information/aip-canada.aspx',
  note: 'CAP and IFR charts are licensed by NAV CANADA; Stratos does not mirror them.',
  country: 'Canada',
  regions: ['Canada'],
  licence: 'Commercial licence required; not redistributable without agreement',
});

const NATS = publisher({
  id: 'nats-uk',
  name: 'NATS AIS — AIP United Kingdom',
  url: 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/AIP/',
  note: 'Free to view. No third-party redistribution grant was found.',
  country: 'United Kingdom',
  regions: ['Europe'],
  licence: 'Free to view; no redistribution grant found',
});

const DFS = publisher({
  id: 'dfs',
  name: 'DFS AIS — AIP Germany',
  url: 'https://ais.dfs.de/pilotservice/briefing/aip_online/aip_online.jsp',
  note: 'Free AIP access. The charts are copyright DFS and reuse needs written approval.',
  country: 'Germany',
  regions: ['Europe'],
  licence: 'Copyright DFS; written approval needed for reuse',
});

const SIA = publisher({
  id: 'sia',
  name: 'SIA — AIP France',
  url: 'https://www.sia.aviation-civile.gouv.fr/?___store=english',
  note: 'Free online AIP. No reuse licence was found on the portal.',
  country: 'France',
  regions: ['Europe'],
  licence: 'Free online AIP; no reuse licence found',
});

const ENAIRE = publisher({
  id: 'enaire',
  name: 'ENAIRE — AIP Spain',
  url: 'https://aip.enaire.es/aip/aip-en.html',
  note: 'Free online AIP. No reuse licence was found on the portal.',
  country: 'Spain',
  regions: ['Europe'],
  licence: 'Free online AIP; no reuse licence found',
});

const ENAV = publisher({
  id: 'enav',
  name: 'ENAV — AIP Italy',
  url: 'https://www.enav.it/en/login-required',
  note: 'Registration required for the online service.',
  country: 'Italy',
  regions: ['Europe'],
  licence: 'Registered access; redistribution not granted',
});

const LVNL = publisher({
  id: 'lvnl',
  name: 'LVNL — eAIP Netherlands',
  url: 'https://eaip.lvnl.nl/web/eaip/default.html',
  note: 'Reproduction needs LVNL written permission.',
  country: 'Netherlands',
  regions: ['Europe'],
  licence: 'Written permission required for reproduction',
});

const SKYGUIDE = publisher({
  id: 'skyguide',
  name: 'Skyguide — Aeronautical information',
  url: 'https://www.skyguide.ch/services/aeronautical-information-management',
  note: 'Registration required; charts are published by Skyguide.',
  country: 'Switzerland',
  regions: ['Europe'],
  licence: 'Registration required; redistribution not granted',
});

const AVINOR = publisher({
  id: 'avinor',
  name: 'Avinor — AIP Norway',
  url: 'https://partner.avinor.no/en/ais/aip/',
  note: 'AIP Norway is copyright Avinor; use outside copyright law needs permission.',
  country: 'Norway',
  regions: ['Europe'],
  licence: 'Copyright Avinor; permission needed beyond copyright law',
});

const LFV = publisher({
  id: 'lfv',
  name: 'LFV AIS — Sweden',
  url: 'https://lfv.se/en/services/information-services/aeronautical-information',
  note: 'AIP Sweden is published through LFV AROWeb.',
  country: 'Sweden',
  regions: ['Europe'],
  licence: 'Published by LFV; redistribution not granted',
});

const AIRNAV = publisher({
  id: 'airnav-ie',
  name: 'AirNav Ireland — AIP Ireland',
  url: 'https://www.airnav.ie/air-traffic-management/aeronautical-information-management',
  note: 'Current eAIP and amendments are listed online.',
  country: 'Ireland',
  regions: ['Europe'],
  licence: 'Published by AirNav Ireland; redistribution not granted',
});

const AUSTRO = publisher({
  id: 'austrocontrol',
  name: 'Austro Control — AIP Austria',
  url: 'https://eaip.austrocontrol.at/',
  note: 'Copyright Austro Control; commercial reproduction needs written consent.',
  country: 'Austria',
  regions: ['Europe'],
  licence: 'Copyright Austro Control; written consent for reproduction',
});

const PANSA = publisher({
  id: 'pansa',
  name: 'PANSA AIS — AIP Poland',
  url: 'https://www.ais.pansa.pl/',
  note: 'Reproduction and redistribution need PANSA written permission.',
  country: 'Poland',
  regions: ['Europe'],
  licence: 'Written permission required for reproduction',
});

const AIRSERVICES = publisher({
  id: 'airservices-au',
  name: 'Airservices Australia — AIP',
  url: 'https://www.airservicesaustralia.com/aip/aip.asp',
  note: 'AIP and terminal procedures are published by Airservices; no redistribution grant was found.',
  country: 'Australia',
  regions: ['Australia'],
  licence: 'Published by Airservices Australia; no redistribution grant found',
  update: 'AIRAC amendment cycle',
});

/* ICAO prefix -> national publisher. Only the states listed are resolved;
   every other European/Balkan prefix falls back to the EUROCONTROL index. */
const PREFIX = {
  CY: 'ca', CZ: 'ca',
  EG: 'uk', ED: 'de', ET: 'de', LF: 'fr', LE: 'es', LI: 'it', EH: 'nl',
  LS: 'ch', EN: 'no', ES: 'se', EI: 'ie', LO: 'at', EP: 'pl',
  Y: 'au',
};

const NATIONAL = {
  ca: CANADA, uk: NATS, de: DFS, fr: SIA, es: ENAIRE, it: ENAV, nl: LVNL,
  ch: SKYGUIDE, no: AVINOR, se: LFV, ie: AIRNAV, at: AUSTRO, pl: PANSA, au: AIRSERVICES,
};

/** Publishers that own charts for a region, for documentation and audits. */
export const LISTED_PUBLISHERS = [...Object.values(NATIONAL), EUROCONTROL_EAD, AIS_INDEX];

/** True for the ICAO regions this directory covers (Canada, Europe, Australia). */
export function isListedRegion(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return false;
  if (/^C[YZ]/.test(code)) return true;
  if (/^Y/.test(code)) return true;
  return /^[ELB]/.test(code);
}

/** The publisher that owns an airport's charts, or null when none is listed. */
export function publisherFor(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return null;
  return NATIONAL[PREFIX[code.slice(0, 2)]] || (PREFIX[code.slice(0, 1)] && NATIONAL[PREFIX[code.slice(0, 1)]]) || null;
}

/**
 * Official sources for an airport, in the order a pilot should try them.
 * An empty list means no source is listed for that part of the world.
 */
export function officialSourcesFor(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return [];
  const national = publisherFor(code);
  if (national) {
    return national.id === 'navcanada' || national.id === 'airservices-au'
      ? [national]
      : [national, EUROCONTROL_EAD, AIS_INDEX];
  }
  if (/^C[YZ]/.test(code)) return [CANADA];
  if (/^Y/.test(code)) return [AIRSERVICES];
  if (/^[ELB]/.test(code)) return [EUROCONTROL_EAD, AIS_INDEX];
  return [];
}

/** One-line explanation for the catalogue's outside-coverage state. */
export function coverageText(icao) {
  const sources = officialSourcesFor(icao);
  if (!sources.length) return 'Stratos does not have a listed chart source for this region.';
  return 'Stratos does not mirror this publisher. Open the official source, then load the PDF you downloaded with “Open PDF…”.';
}

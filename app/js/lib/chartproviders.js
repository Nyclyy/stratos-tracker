/* Chart providers.
 *
 * One provider is integrated: the FAA d-TPP publication, a U.S. Government
 * work that can be fetched per cycle and rendered inside Stratos. Every other
 * publisher in chartdir.js is declared but not integrated, because Stratos has
 * no redistribution licence for its charts. The viewer asks this module what
 * is actually available for an airport, so it can never label a category
 * "Premium" (or "free") for a region that has no permitted source.
 *
 * Adding a licensed provider later means adding one descriptor with
 * `status: 'integrated'` and a fetch adapter; the catalogue and viewer are
 * source-agnostic.
 */

import { FAA_SOURCE, categoryLabel } from './charts.js';
import { LISTED_PUBLISHERS, officialSourcesFor, publisherFor } from './chartdir.js';

const ALL_CATEGORIES = ['diagram', 'sid', 'star', 'approach', 'odp', 'minimums', 'hotspot', 'supplement'];

export const FAA_PROVIDER = {
  id: FAA_SOURCE.id,
  name: FAA_SOURCE.name,
  publisher: FAA_SOURCE.publisher,
  status: 'integrated',
  country: 'United States',
  regions: ['United States and territories'],
  categories: ALL_CATEGORIES,
  format: 'PDF',
  update: '28-day d-TPP publication cycle',
  retrieval: 'cycle',
  attribution: FAA_SOURCE.license,
  licence: FAA_SOURCE.license,
  terms: FAA_SOURCE.terms,
  redistributable: true,
};

/** Every provider Stratos knows about, integrated or not. */
export const CHART_PROVIDERS = [FAA_PROVIDER, ...LISTED_PUBLISHERS.map(publisher => ({
  id: publisher.id,
  name: publisher.name,
  publisher: publisher.name,
  status: publisher.status,
  country: publisher.country,
  regions: publisher.regions,
  categories: publisher.categories,
  format: publisher.format,
  update: publisher.update,
  retrieval: 'publisher-portal',
  attribution: publisher.attribution,
  licence: publisher.licence,
  terms: publisher.url,
  redistributable: false,
  url: publisher.url,
}))];

/** True when the FAA d-TPP publishes terminal procedures for this airport. */
export function isFaaIcao(icao) {
  const code = String(icao || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) && /^(K|P[A-Z]|TJ|TI)/.test(code);
}

/**
 * What is available for one airport. `integrated` means Stratos can list and
 * open the documents itself; a listed publisher with `integrated: false` is a
 * link, not a chart source.
 */
export function chartCoverage(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (isFaaIcao(code)) {
    return {
      icao: code,
      integrated: true,
      country: FAA_PROVIDER.country,
      provider: FAA_PROVIDER,
      sources: [FAA_PROVIDER],
      categories: FAA_PROVIDER.categories,
      message: '',
    };
  }
  const publisher = publisherFor(code);
  if (publisher) {
    return {
      icao: code,
      integrated: false,
      country: publisher.country,
      provider: { ...publisher },
      sources: officialSourcesFor(code),
      categories: publisher.categories,
      message: `${publisher.name} publishes charts for ${publisher.country}, but Stratos does not hold a redistribution licence for them, so they cannot be embedded.`,
    };
  }
  // A European state without a national entry still has the EUROCONTROL
  // portals; that is coverage information, not an integrated chart source.
  const portals = officialSourcesFor(code);
  if (portals.length) {
    return {
      icao: code,
      integrated: false,
      country: 'Europe',
      provider: { ...portals[0] },
      sources: portals,
      categories: portals[0].categories || [],
      message: `${portals[0].name} indexes the charts for this state, but Stratos does not hold a redistribution licence for them, so they cannot be embedded.`,
    };
  }
  return {
    icao: code,
    integrated: false,
    country: null,
    provider: null,
    sources: [],
    categories: [],
    message: 'Stratos has no listed chart publisher for this airport.',
  };
}

/** Providers that can actually serve documents today. */
export function availableProviders() {
  return CHART_PROVIDERS.filter(provider => provider.status === 'integrated');
}

/** Human labels for the categories a provider publishes, in catalogue order. */
export function providerCategories(provider) {
  return (provider && provider.categories ? provider.categories : []).map(categoryLabel);
}

/** Short coverage sentence for the page header; never claims worldwide cover. */
export function coverageSummary() {
  return 'Integrated charts: United States and territories (FAA d-TPP). Canada, Europe and Australia: official publisher links only until a licence is agreed.';
}

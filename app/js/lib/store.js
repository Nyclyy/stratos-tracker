/* Backward-compatible local storage.
   Database: stratos_logbook. v2 (existing) had `flights` and `profile`; v3 adds
   `settings`. The upgrade never deletes or rewrites existing records. */

import { dedupeFlights } from './stats.js';

export const DB_NAME = 'stratos_logbook';
export const DB_VERSION = 3;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('flights')) {
        const flights = database.createObjectStore('flights', { keyPath: 'id' });
        flights.createIndex('startTime', 'startTime');
        flights.createIndex('state', 'state');
      }
      if (!database.objectStoreNames.contains('profile')) {
        database.createObjectStore('profile', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the Stratos database.'));
    req.onblocked = () => reject(new Error('The Stratos database is open in another tab. Close it and retry.'));
  }).catch(err => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getFlights() {
  const db = await openDB();
  const rows = await request(tx(db, 'flights', 'readonly').getAll());
  return Array.isArray(rows) ? rows : [];
}

export async function putFlight(flight) {
  if (!flight || !flight.id) throw new Error('A flight record needs an id.');
  const db = await openDB();
  return request(tx(db, 'flights', 'readwrite').put(flight));
}

export async function putFlights(flights) {
  const list = (flights || []).filter(f => f && f.id);
  if (!list.length) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('flights', 'readwrite');
    const store = transaction.objectStore('flights');
    for (const flight of list) store.put(flight);
    transaction.oncomplete = () => resolve(list.length);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Import cancelled.'));
  });
}

export async function deleteFlight(id) {
  const db = await openDB();
  return request(tx(db, 'flights', 'readwrite').delete(id));
}

export async function getProfileRow(key = 'main') {
  const db = await openDB();
  return request(tx(db, 'profile', 'readonly').get(key));
}

export async function setProfileRow(key, value) {
  const db = await openDB();
  return request(tx(db, 'profile', 'readwrite').put({ key, value }));
}

export async function getSetting(key, fallback = null) {
  try {
    const db = await openDB();
    const row = await request(tx(db, 'settings', 'readonly').get(key));
    return row ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

export async function setSetting(key, value) {
  const db = await openDB();
  return request(tx(db, 'settings', 'readwrite').put({ key, value }));
}

export async function getAllSettings() {
  try {
    const db = await openDB();
    const rows = await request(tx(db, 'settings', 'readonly').getAll());
    const out = {};
    for (const row of rows || []) out[row.key] = row.value;
    return out;
  } catch (_) {
    return {};
  }
}

export async function getSavedRoutes() {
  const rows = await getSetting('routes', []);
  return Array.isArray(rows) ? rows : [];
}

export async function saveRoutes(routes) {
  await setSetting('routes', routes || []);
  return routes;
}

export async function getRouteBook() {
  return getSetting('routeBook', { active: [], saved: [] });
}

export async function saveRouteBook(book) {
  await setSetting('routeBook', book || { active: [], saved: [] });
  return book;
}

export async function getDashboardLayout() {
  return getSetting('dashboardLayout', null);
}

export async function saveDashboardLayout(layout) {
  await setSetting('dashboardLayout', layout);
  return layout;
}

/** Merge remote records without losing local ones; richer copies win. */
export async function mergeFlights(remote) {
  const local = await getFlights();
  const merged = dedupeFlights([...local, ...(remote || [])]);
  const localIds = new Set(local.map(f => f.id));
  const added = merged.filter(f => !localIds.has(f.id));
  await putFlights(merged);
  return { total: merged.length, added: added.length, records: merged };
}

export async function exportBackup({ profile = null } = {}) {
  const [flights, settings] = await Promise.all([getFlights(), getAllSettings()]);
  return {
    format: 'stratos-backup',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    flights,
    settings,
    profile,
  };
}

export async function importBackup(backup) {
  if (!backup || backup.format !== 'stratos-backup' || !Array.isArray(backup.flights)) {
    throw new Error('This file is not a Stratos backup.');
  }
  const merged = await mergeFlights(backup.flights);
  if (backup.settings && typeof backup.settings === 'object') {
    for (const [key, value] of Object.entries(backup.settings)) {
      if (key.startsWith('__')) continue;
      await setSetting(key, value);
    }
  }
  return merged;
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

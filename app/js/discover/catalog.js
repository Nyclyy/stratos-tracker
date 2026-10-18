// Presentation and capability metadata for Route Discovery.
//
// The engine owns selection logic; this file owns what the user sees. Adding a
// category is a single entry here plus a `prefer` rule in the engine.

const ICON = {
  scenic: '<path d="M3 17l4.5-6 3 3.6L14 10l7 7"/><circle cx="7.5" cy="6.5" r="1.6"/>',
  storm: '<path d="M6 15a3.5 3.5 0 0 1 .4-7 5 5 0 0 1 9.5 1.2A3.2 3.2 0 0 1 17 15"/><path d="M12 16l-2 5h3l-2 4"/>',
  challenging: '<path d="M3 20l6-15 4 8 3-4 5 11z"/>',
  islands: '<path d="M3 17c2-2 4-1 5 .5M10 12c2-3 5-3 6.5.5"/><path d="M15 19h5"/><circle cx="17" cy="7" r="2"/>',
  mountain: '<path d="M2 19l7-14 5 9 3-4 5 9z"/><path d="M7.5 11l2.5 2 2-1"/>',
  longhaul: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  short: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.5l3 2"/>',
  bush: '<path d="M4 18c1.5-5 4-9 8-9s6 4 7 9z"/><path d="M8 18v3M16 18v3"/>',
  night: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/><path d="M17 4l.8 1.8L20 6.6l-1.8.9L17 9.2l-.9-1.7L14.3 6.6l1.8-.8z"/>',
  random: '<path d="M4 7h4l8 10h4M4 17h4l3-3.6M16 7h4"/><path d="M17 4l3 3-3 3M17 14l3 3-3 3"/>',
};

export const CATEGORIES = [
  {
    id: 'scenic', label: 'Scenic', accent: '#38bdf8', icon: ICON.scenic,
    blurb: 'Mountains, coastlines, islands, fjords and the views worth the detour.',
  },
  {
    id: 'storm', label: 'Storm Chasing', accent: '#a78bfa', icon: ICON.storm,
    blurb: 'Dramatic weather. Simulated scenarios, never a real storm report.',
  },
  {
    id: 'challenging', label: 'Challenging', accent: '#fb7185', icon: ICON.challenging,
    blurb: 'High-elevation fields, short runways and terrain that asks for care.',
  },
  {
    id: 'islands', label: 'Island Hopping', accent: '#34d399', icon: ICON.islands,
    blurb: 'Island chains, coastal strips and several short legs in one sitting.',
  },
  {
    id: 'mountain', label: 'Mountain Flying', accent: '#f6c453', icon: ICON.mountain,
    blurb: 'Routes that genuinely cross mountain country, with elevated destinations.',
  },
  {
    id: 'longhaul', label: 'Long Haul', accent: '#60a5fa', icon: ICON.longhaul,
    blurb: 'Longer legs for airliners and sessions that last an evening.',
  },
  {
    id: 'short', label: 'Short & Sweet', accent: '#22d3ee', icon: ICON.short,
    blurb: 'Quick, interesting flights that fit into a spare hour.',
  },
  {
    id: 'bush', label: 'Bush Flying', accent: '#a3e635', icon: ICON.bush,
    blurb: 'Short strips and remote fields, limited to airports with real runway data.',
  },
  {
    id: 'night', label: 'Night Flight', accent: '#818cf8', icon: ICON.night,
    blurb: 'Evening departures into city lights. Scenery quality varies by sim.',
  },
  {
    id: 'random', label: 'Random Adventure', accent: '#f472b6', icon: ICON.random,
    blurb: 'Hand the decision over. A varied idea, different each time you ask.',
  },
];

export const DURATIONS = [
  { id: 'short', label: '30–60 min', min: 0.5, max: 1 },
  { id: 'medium', label: '1–2 hours', min: 1, max: 2 },
  { id: 'long', label: '2–4 hours', min: 2, max: 4 },
  { id: 'extra', label: '4–8 hours', min: 4, max: 8 },
  { id: 'ultra', label: '8+ hours', min: 8, max: 14 },
];

// Cruise speeds are planning values for the simulator, not certified figures.
export const AIRCRAFT = [
  { id: 'ga', label: 'General aviation', kt: 125, note: 'around 125 kt cruise' },
  { id: 'turboprop', label: 'Turboprop', kt: 250, note: 'around 250 kt cruise' },
  { id: 'regional', label: 'Regional airliner', kt: 400, note: 'around 400 kt cruise' },
  { id: 'narrowbody', label: 'Narrow-body airliner', kt: 450, note: 'around 450 kt cruise' },
  { id: 'widebody', label: 'Wide-body airliner', kt: 470, note: 'around 470 kt cruise' },
  { id: 'helicopter', label: 'Helicopter', kt: 110, note: 'around 110 kt cruise' },
  { id: 'any', label: 'Any aircraft', kt: null, note: 'picked per route' },
];

export const categoryById = id => CATEGORIES.find(category => category.id === id) || CATEGORIES[0];
export const durationById = id => DURATIONS.find(band => band.id === id) || DURATIONS[1];
export const aircraftById = id => AIRCRAFT.find(type => type.id === id) || AIRCRAFT[AIRCRAFT.length - 1];

/* Aircraft identification from an ICAO type code. */
import spriteMap from '../../images/aircraft/sprite-map.json' with { type: 'json' };

const TYPES = {
  A321: { name: 'Airbus A321', maker: 'Airbus' },
  A346: { name: 'Airbus A340-600', maker: 'Airbus' },
  A359: { name: 'Airbus A350-900', maker: 'Airbus' },
  A35K: { name: 'Airbus A350-1000', maker: 'Airbus' },
  A388: { name: 'Airbus A380-800', maker: 'Airbus' },
  A333: { name: 'Airbus A330-300', maker: 'Airbus' }, A306: { name: 'Airbus A300-600', maker: 'Airbus' },
  A310: { name: 'Airbus A310', maker: 'Airbus' }, A318: { name: 'Airbus A318', maker: 'Airbus' },
  A319: { name: 'Airbus A319', maker: 'Airbus' }, A320: { name: 'Airbus A320', maker: 'Airbus' },
  A332: { name: 'Airbus A330-200', maker: 'Airbus' }, A339: { name: 'Airbus A330-900', maker: 'Airbus' },
  A346: { name: 'Airbus A340-600', maker: 'Airbus' }, A359: { name: 'Airbus A350-900', maker: 'Airbus' },
  A35K: { name: 'Airbus A350-1000', maker: 'Airbus' },  B712: { name: 'Boeing 717-200', maker: 'Boeing' }, B733: { name: 'Boeing 737-300', maker: 'Boeing' },
  B734: { name: 'Boeing 737-400', maker: 'Boeing' }, B735: { name: 'Boeing 737-500', maker: 'Boeing' },
  B736: { name: 'Boeing 737-600', maker: 'Boeing' }, B737: { name: 'Boeing 737-700', maker: 'Boeing' },
  B738: { name: 'Boeing 737-800', maker: 'Boeing' }, B739: { name: 'Boeing 737-900', maker: 'Boeing' },
  B744: { name: 'Boeing 747-400', maker: 'Boeing' }, B748: { name: 'Boeing 747-8', maker: 'Boeing' },
  B752: { name: 'Boeing 757-200', maker: 'Boeing' }, B753: { name: 'Boeing 757-300', maker: 'Boeing' },
  B762: { name: 'Boeing 767-200', maker: 'Boeing' }, B763: { name: 'Boeing 767-300', maker: 'Boeing' },
  B764: { name: 'Boeing 767-400', maker: 'Boeing' }, B772: { name: 'Boeing 777-200', maker: 'Boeing' },
  B77W: { name: 'Boeing 777-300ER', maker: 'Boeing' }, B788: { name: 'Boeing 787-8', maker: 'Boeing' },
  B789: { name: 'Boeing 787-9', maker: 'Boeing' }, B78X: { name: 'Boeing 787-10', maker: 'Boeing' },
  E190: { name: 'Embraer E190', maker: 'Embraer' }, E195: { name: 'Embraer E195', maker: 'Embraer' },
  AT72: { name: 'ATR 72', maker: 'ATR' }, DH8D: { name: 'Dash 8 Q400', maker: 'De Havilland' },
  C208: { name: 'Cessna 208 Caravan', maker: 'Cessna' }, PA28: { name: 'Piper PA-28', maker: 'Piper' },
  BE58: { name: 'Beechcraft Baron 58', maker: 'Beechcraft' }, R44: { name: 'Robinson R44', maker: 'Robinson' },
  EC35: { name: 'Airbus H135', maker: 'Airbus Helicopters' }, C172: { name: 'Cessna 172', maker: 'Cessna' },
};

/** Existing Commons fallback images for types not included in the provided atlas. */
export const IMAGES = {
  a380: 'images/aircraft/a380.svg', b747: 'images/aircraft/b747.svg', b757: 'images/aircraft/b757.svg',
  b737: 'images/aircraft/b737.svg', b777: 'images/aircraft/b777.svg', b787: 'images/aircraft/b787.svg',
  'b787-9': 'images/aircraft/b787-9.svg', 'generic-narrowbody': 'images/aircraft/generic-narrowbody.svg',
  'generic-widebody': 'images/aircraft/generic-widebody.svg', 'generic-light': 'images/aircraft/generic-light.svg',
  generic: 'images/aircraft/generic.svg',
};

const FALLBACK = {
  A388: 'a380', B744: 'b747', B748: 'b747', B752: 'b757', B753: 'b757',
  B772: 'b777', B77W: 'b777', B788: 'b787', B789: 'b787-9', B78X: 'b787-9',
};

/** Normalize a type code: uppercase, letters and digits only. */
export function normaliseType(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Return sprite sheet geometry for an ICAO type, or null if the atlas has no match. */
export function aircraftSprite(value) {
  const type = normaliseType(value);
  const spriteName = spriteMap.airframeToSprite[type];
  if (!spriteName) return null;
  const sprite = spriteMap.sprites[spriteName];
  if (!sprite) return null;
  return { name: spriteName, ...sprite, width: 72, height: 72, sheet: 'images/aircraft/spritesheet.png' };
}

/**
 * Identify the aircraft from the first source that has a type.
 * The sprite atlas is preferred; a distinct Commons image is used where available.
 */
export function identifyAircraft({ simulator, simbrief, profile } = {}) {
  const candidates = [
    { source: 'simulator', value: simulator },
    { source: 'simbrief', value: simbrief },
    { source: 'profile', value: profile },
  ];
  for (const { source, value } of candidates) {
    const type = normaliseType(value);
    if (!type) continue;
    const known = TYPES[type];
    if (!known) return { type, source, name: type, maker: null, image: IMAGES.generic, sprite: null, known: false };
    const sprite = aircraftSprite(type);
    return {
      type, source, name: known.name, maker: known.maker,
      image: sprite && !FALLBACK[type] ? null : (IMAGES[FALLBACK[type]] || IMAGES.generic),
      sprite, known: true,
    };
  }
  return { type: null, source: null, name: null, maker: null, image: null, sprite: null, known: false };
}

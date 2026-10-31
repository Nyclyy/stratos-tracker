/* Cabin announcements: the script library, the voice slots, airline profiles
 * and the automatic trigger rules.
 *
 * This module holds no audio. It decides what would be said, from the plan and
 * the simulator's own telemetry, and the bridge decides whether a voice exists
 * to say it. Nothing here invents a fact: a script that needs the flight number
 * reports the token as missing rather than filling it with a placeholder, and a
 * trigger that the simulator cannot report is not offered as automatic.
 */

export const CABIN_PHASES = [
  { id: 'preboarding', name: 'Pre-boarding & Boarding', hint: 'Before the doors close' },
  { id: 'departure', name: 'Before Departure', hint: 'Doors, safety and cabin secure' },
  { id: 'taxi', name: 'Taxi & Takeoff', hint: 'Pushback to airborne' },
  { id: 'climb', name: 'Climb & Cruise', hint: 'Seatbelt sign to top of descent' },
  { id: 'descent', name: 'Descent & Approach', hint: 'Top of descent to short final' },
  { id: 'arrival', name: 'Landing & Arrival', hint: 'Touchdown to the gate' },
  { id: 'special', name: 'Special Situations', hint: 'Only when the crew decides' },
];

/* One stroke set, 24-unit grid, the same line weight as the rest of the bag. */
export const CABIN_GLYPHS = {
  welcome: '<path d="M4 19.5h16"/><path d="M6 19.5V9l6-4 6 4v10.5"/><path d="M10 19.5v-5h4v5"/>',
  seat: '<path d="M7 4.5v8.2h6.4a2 2 0 0 1 2 2v4.8"/><path d="M5 19.5h13.5"/><path d="M7 12.7H5.4a1.4 1.4 0 0 1-1.4-1.4V4.5"/>',
  bag: '<path d="M5 8.5h14v8.2a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 16.7z"/><path d="M9.2 8.5V6.4A1.9 1.9 0 0 1 11.1 4.5h1.8a1.9 1.9 0 0 1 1.9 1.9v2.1"/><path d="M9.6 12.4v3M14.4 12.4v3"/>',
  phone: '<rect x="7.4" y="3.4" width="9.2" height="17.2" rx="1.8"/><path d="M10.6 6.2h2.8"/><path d="M11 17.6h2"/>',
  door: '<path d="M6 20V5.4A1.4 1.4 0 0 1 7.4 4h6.2A1.4 1.4 0 0 1 15 5.4V20"/><path d="M4.5 20h15"/><path d="M13 12.4h.01"/><path d="M17.6 9.4v5.2"/>',
  mask: '<path d="M4.4 10.2c2.4-1.4 4.9-2 7.6-2s5.2.6 7.6 2"/><path d="M8.2 10.8c0 3.2 1.5 5.2 3.8 5.2s3.8-2 3.8-5.2"/><path d="M5.6 13.6c0 2.7 2.4 4.9 6.4 4.9s6.4-2.2 6.4-4.9"/>',
  vest: '<path d="M9 4.5 12 8l3-3.5"/><path d="M9 4.5 6.6 6.2v13.3h10.8V6.2L15 4.5"/><path d="M9.4 11.6h5.2M9.4 14.6h5.2"/>',
  exit: '<path d="M14 4.5h4.5V20H14"/><path d="M4.5 12h9.2"/><path d="m10.9 8.6 3.4 3.4-3.4 3.4"/>',
  brace: '<circle cx="12" cy="5.4" r="2.1"/><path d="m12 8 0 5.4"/><path d="m12 9.4-3.4 2.2M12 9.4l3.4 2.2"/><path d="m12 13.4-2.6 4.4M12 13.4l2.6 4.4"/>',
  card: '<path d="M6 4.5h9.4L19 8.1v11.4H6z"/><path d="M14.8 4.6v3.6H19"/><path d="M9 12.2h5.6M9 15.4h5.6"/>',
  check: '<path d="M5 12.6 9.4 17 19 6.8"/>',
  crew: '<circle cx="9" cy="8.2" r="2.6"/><path d="M4.4 19.4c0-3.1 2.1-5.2 4.6-5.2s4.6 2.1 4.6 5.2"/><path d="M15.4 6.4a2.6 2.6 0 0 1 0 5M17 14.6c1.6.6 2.6 2.3 2.6 4.8"/>',
  captain: '<path d="M4.6 17.6 12 4.4l7.4 13.2z"/><path d="M8.6 13.2h6.8"/><path d="M12 8.2v2"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.2 1.9"/>',
  route: '<circle cx="5.8" cy="18.2" r="1.9"/><circle cx="18.2" cy="5.8" r="1.9"/><path d="M7.2 17 10 13.6l3.2 1.4 3.7-6.6"/>',
  meal: '<path d="M6 4.5v7.2M8.6 4.5v7.2M7.3 11.7v7.8"/><path d="M16.4 19.5v-6.2a3.2 3.2 0 0 1 0-6.4v12.6z"/>',
  wifi: '<path d="M3.8 9.2a12 12 0 0 1 16.4 0"/><path d="M6.8 12.4a8 8 0 0 1 10.4 0"/><path d="M9.8 15.6a4 4 0 0 1 4.4 0"/><circle cx="12" cy="18.4" r=".9"/>',
  wind: '<path d="M3.6 9.4h10.2a2.7 2.7 0 1 0-2.7-2.7"/><path d="M3.6 14.6h13.2a2.7 2.7 0 1 1-2.7 2.7"/><path d="M3.6 12h6.6"/>',
  altitude: '<path d="M4 19.4h16"/><path d="M6.4 15.8 10 9.6l2.6 3.6 2-2.9 3 5.5"/><path d="M12 4.2v2.6"/>',
  descend: '<path d="M4 5h16"/><path d="m7 15.4 5 4.4 5-4.4"/><path d="M12 5.4v14"/>',
  runway: '<path d="m12 3.4 4.6 17.2M12 3.4 7.4 20.6"/><path d="M12 8.2v2.4M12 13.4v2.4"/>',
  hold: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6v4.8l3.4 2"/>',
  upright: '<path d="M6 19.4h12"/><path d="M9 19.4V9.2a3 3 0 0 1 3-3h4"/><path d="m14.6 4.4 1.8 1.8-1.8 1.8"/>',
  shade: '<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="1.6"/><path d="M4.8 10.4h14.4M4.8 14.2h14.4"/><path d="M12 4.8v14.4"/>',
  bins: '<path d="M4 10.4h16"/><path d="M5.6 10.4V8a1.8 1.8 0 0 1 1.8-1.8h9.2A1.8 1.8 0 0 1 18.4 8v2.4"/><path d="M6.4 10.4v8.2h11.2v-8.2"/><path d="M6.4 14.6h11.2"/>',
  terminal: '<path d="M3.6 20h16.8"/><path d="M5.4 20V9.2L12 4.6l6.6 4.6V20"/><path d="M9.4 20v-5.4h5.2V20"/>',
  thanks: '<path d="M12 19.6s-7.4-4.4-7.4-9.1A4 4 0 0 1 12 7.6a4 4 0 0 1 7.4 2.9c0 4.7-7.4 9.1-7.4 9.1z"/>',
  medical: '<path d="M12 4.4v15.2M4.4 12h15.2"/>',
  alert: '<path d="M12 3.8 21 19.6H3z"/><path d="M12 9.6v4.4"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 3.6 19 6v6.2c0 4-2.8 7.1-7 8.2-4.2-1.1-7-4.2-7-8.2V6z"/><path d="M9.2 12.2 11.4 14.4l3.8-4"/>',
  swap: '<path d="M4.4 8.4h13.2l-3-3"/><path d="M19.6 15.6H6.4l3 3"/>',
  delay: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6v4.8"/><path d="M9.2 18.2 12 15.4l2.8 2.8"/>',
  fuel: '<path d="M6 20V5.4h7V20"/><path d="M6 9.2h7"/><path d="M13 12h2.4a1.8 1.8 0 0 1 1.8 1.8v3.4a1.2 1.2 0 0 0 2.4 0V9.6l-2.2-2.2"/><path d="M4.6 20h9.8"/>',
  turbulence: '<path d="M3.6 8.4c2.4-1.8 4.4 1.8 6.8 0s4.4-1.8 6.8 0 3.2.6 3.2.6"/><path d="M3.6 13.2c2.4-1.8 4.4 1.8 6.8 0s4.4-1.8 6.8 0 3.2.6 3.2.6"/><path d="M3.6 18c2.4-1.8 4.4 1.8 6.8 0s4.4-1.8 6.8 0 3.2.6 3.2.6"/>',
};

/* The four voices the bridge can speak in. These are slots, not claims: the
 * bridge reports which of them actually exist on the PC. */
export const VOICE_SLOTS = [
  { id: 'captain-male', label: 'Captain · male', role: 'captain' },
  { id: 'captain-female', label: 'Captain · female', role: 'captain' },
  { id: 'crew-male', label: 'Cabin crew · male', role: 'crew' },
  { id: 'crew-female', label: 'Cabin crew · female', role: 'crew' },
];

/* Airline profiles carry a name and terminology only. No airline script or
 * recording is reproduced, so every profile says so in the interface. */
export const AIRLINE_PROFILES = [
  { id: 'air-canada', name: 'Air Canada', icao: 'ACA', callsignPrefix: 'ACA' },
  { id: 'lufthansa', name: 'Lufthansa', icao: 'DLH', callsignPrefix: 'DLH' },
  { id: 'united', name: 'United Airlines', icao: 'UAL', callsignPrefix: 'UAL' },
  { id: 'american', name: 'American Airlines', icao: 'AAL', callsignPrefix: 'AAL' },
  { id: 'british-airways', name: 'British Airways', icao: 'BAW', callsignPrefix: 'BAW' },
  { id: 'easyjet', name: 'easyJet', icao: 'EZY', callsignPrefix: 'EZY' },
  { id: 'emirates', name: 'Emirates', icao: 'UAE', callsignPrefix: 'UAE' },
  { id: 'qatar', name: 'Qatar Airways', icao: 'QTR', callsignPrefix: 'QTR' },
  { id: 'custom', name: 'Custom airline', icao: '', callsignPrefix: '' },
];

export const DEFAULT_CABIN_SETTINGS = {
  airline: '',
  customName: '',
  voices: { captain: 'captain-male', crew: 'crew-female' },
  volume: 0.8,
  outputs: {},
  auto: false,
  autoOn: {},
};

/* What an announcement can put into a sentence. A token with no value is
 * reported, never replaced with an invented one. */
export const TOKEN_LABELS = {
  airline: 'airline',
  flight: 'flight number',
  origin: 'departure airport',
  destination: 'destination airport',
  duration: 'flight time',
  altitude: 'cruising level',
  arrival: 'arrival time',
  localTime: 'destination local time',
  partOfDay: 'time of day',
};

const A = (id, phase, title, note, icon, kind, script, extra = {}) =>
  ({ id, phase, title, note, icon, kind, script, auto: null,
     autoWhy: 'Manual — the simulator does not report this event.', ...extra });

export const ANNOUNCEMENTS = [
  /* ── 01 · Pre-boarding & Boarding ─────────────────────────────────── */
  A('pre.special-assistance', 'preboarding', 'Special assistance boarding', 'Boarding · assistance', 'crew', 'crew',
    'Passengers requiring special assistance are invited to board now. Please let a member of the {airline} team know if you need extra time or support.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.families', 'preboarding', 'Families with young children', 'Boarding · families', 'crew', 'crew',
    'We now invite families travelling with young children to board. Please make your way to the gate with your boarding documents ready.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.priority', 'preboarding', 'Priority and elite boarding', 'Boarding · priority', 'crew', 'crew',
    'Passengers in our premium cabins, along with elite and priority members, are invited to board.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.general', 'preboarding', 'General boarding', 'Boarding · all passengers', 'door', 'crew',
    'Boarding is now open for all remaining passengers, by zone as shown on your boarding pass.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.welcome', 'preboarding', 'Welcome aboard', 'Welcome', 'welcome', 'crew',
    'Good {partOfDay}, and welcome aboard {airline} flight {flight} to {destination}.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.route', 'preboarding', 'Flight number and destination', 'Route', 'route', 'crew',
    'This service is {origin} to {destination}. Our flight time today is {duration} and we plan to cruise at {altitude}.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.baggage', 'preboarding', 'Baggage stowage', 'Cabin · baggage', 'bag', 'crew',
    'Please stow larger bags in the overhead lockers, wheels first, and place smaller items under the seat in front of you.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.seats', 'preboarding', 'Finding your seat', 'Cabin · seating', 'seat', 'crew',
    'Your seat number is shown on your boarding pass. If you need help finding your seat, please ask a member of the cabin crew.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.seatbelt', 'preboarding', 'Seatbelt instructions', 'Safety · seatbelt', 'seat', 'crew',
    'Please take your seat and fasten your seatbelt low and tight across your lap.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.devices', 'preboarding', 'Electronic devices', 'Cabin · devices', 'phone', 'crew',
    'Electronic devices may be used in flight mode until we close the doors. Larger items must be stowed for departure.',
    { autoWhy: 'X-Plane does not report boarding.' }),
  A('pre.exit-row', 'preboarding', 'Exit-row briefing', 'Safety · exits', 'exit', 'crew',
    'Passengers seated at an emergency exit: please confirm you are willing and able to assist in an evacuation, and review the briefing card.',
    { autoWhy: 'X-Plane does not report boarding.' }),

  /* ── 02 · Before departure ────────────────────────────────────────── */
  A('dep.doors-auto', 'departure', 'Doors to automatic', 'Crew · doors', 'door', 'crew',
    'Cabin crew, doors to automatic and cross-check.',
    { autoWhy: 'Door arming is not in the simulator feed.' }),
  A('dep.safety-demo', 'departure', 'Safety demonstration', 'Safety · demonstration', 'shield', 'crew',
    'Ladies and gentlemen, we will now demonstrate the safety equipment on board this aircraft. Please give us your attention.',
    { autoWhy: 'The demo is a crew action, not a simulator event.' }),
  A('dep.seatbelts', 'departure', 'Seatbelts', 'Safety · seatbelt', 'seat', 'crew',
    'Fasten your seatbelt low and tight. The sign is on whenever you are seated.',
    { autoWhy: 'The seatbelt sign is not in the simulator feed.' }),
  A('dep.oxygen', 'departure', 'Oxygen masks', 'Safety · oxygen', 'mask', 'crew',
    'Oxygen masks are stowed above you. If they deploy, pull the mask towards you, place it over your nose and mouth, and breathe normally.',
    { autoWhy: 'Safety briefing is a crew action.' }),
  A('dep.life-vest', 'departure', 'Life vests', 'Safety · life vest', 'vest', 'crew',
    'Your life vest is under the seat. Slip it over your head, fasten the waist strap, and pull the tabs to inflate.',
    { autoWhy: 'Safety briefing is a crew action.' }),
  A('dep.exits', 'departure', 'Emergency exits', 'Safety · exits', 'exit', 'crew',
    'Your nearest exits are ahead of and behind you. Take a moment now to note their location.',
    { autoWhy: 'Safety briefing is a crew action.' }),
  A('dep.brace', 'departure', 'Brace position', 'Safety · brace', 'brace', 'crew',
    'If we must evacuate, leave all belongings behind and follow the cabin crew commands.',
    { autoWhy: 'Safety briefing is a crew action.' }),
  A('dep.safety-card', 'departure', 'Safety card', 'Safety · card', 'card', 'crew',
    'A safety card is in the seat pocket in front of you. Please read it before departure.',
    { autoWhy: 'Safety briefing is a crew action.' }),
  A('dep.final-cabin', 'departure', 'Final cabin secure', 'Crew · secure', 'check', 'crew',
    'Cabin crew, final cabin secure for departure.',
    { autoWhy: 'Securing the cabin is a crew action, not a simulator event.' }),
  A('dep.crew-seats', 'departure', 'Cabin crew take seats', 'Crew · seats', 'crew', 'crew',
    'Cabin crew, take your seats for departure.'),
  A('dep.captain-welcome', 'departure', "Captain's welcome", 'Captain', 'captain', 'captain',
    'Good {partOfDay}. This is your captain speaking. Welcome aboard {airline} flight {flight} to {destination}.'),
  A('dep.flight-info', 'departure', 'Flight time and arrival', 'Captain · route', 'clock', 'captain',
    'Our flight time today is {duration}. We will cruise at {altitude} and expect to arrive at {arrival}.'),

  /* ── 03 · Taxi & takeoff ──────────────────────────────────────────── */
  A('taxi.remain-seated', 'taxi', 'Remain seated', 'Taxi · seatbelts', 'seat', 'crew',
    'Please remain seated with your seatbelt fastened until we are airborne.'),
  A('taxi.ground-delay', 'taxi', 'Ground delay update', 'Taxi · delay', 'delay', 'captain',
    'We are waiting for our departure slot. I will keep you informed as soon as we have an update.',
    { autoWhy: 'A slot delay is not a simulator event.' }),
  A('taxi.runway-sequence', 'taxi', 'Runway sequencing', 'Taxi · ATC', 'runway', 'captain',
    'We are number two for departure and expect to be airborne shortly.',
    { autoWhy: 'ATC sequencing is not in the simulator feed.' }),
  A('taxi.crew-prepare', 'taxi', 'Cabin crew prepare for takeoff', 'Crew · takeoff', 'crew', 'crew',
    'Cabin crew, prepare the cabin for takeoff.', { auto: 'taxiStart' }),
  A('taxi.after-takeoff', 'taxi', 'After takeoff', 'Takeoff · airborne', 'altitude', 'captain',
    'We are now airborne and climbing. Please keep your seatbelt fastened until the sign is switched off.',
    { auto: 'airborne' }),
  A('taxi.seatbelt-sign', 'taxi', 'Seatbelt sign update', 'Seatbelt · off', 'seat', 'crew',
    'The seatbelt sign is now off. You are welcome to move about the cabin, but please keep your belt fastened while seated.',
    { auto: 'tenThousand' }),

  /* ── 04 · Climb & cruise ──────────────────────────────────────────── */
  A('climb.reaching-altitude', 'climb', 'Reaching cruising altitude', 'Cruise · level', 'altitude', 'captain',
    'We have reached our cruising altitude of {altitude}. You may now move about the cabin.', { auto: 'cruise' }),
  A('climb.belts-off', 'climb', 'Seatbelt sign off', 'Seatbelt · off', 'seat', 'crew',
    'The seatbelt sign is off. Please keep your seatbelt loosely fastened while you are seated.',
    { autoWhy: 'The seatbelt sign is not in the simulator feed.' }),
  A('climb.conditions', 'climb', 'Weather and conditions', 'Cruise · conditions', 'wind', 'captain',
    'The weather ahead is forecast to be smooth for most of the flight. We will let you know if that changes.',
    { autoWhy: 'Forecast conditions are not part of the trigger.' }),
  A('climb.arrival-time', 'climb', 'Estimated arrival', 'Cruise · ETA', 'clock', 'captain',
    'We expect to arrive at {destination} at {arrival}.'),
  A('climb.meal', 'climb', 'Meal and beverage service', 'Service · meal', 'meal', 'crew',
    'We will shortly begin our meal service. Please lower your tray table when it is served.',
    { autoWhy: 'Catering is a crew action.' }),
  A('climb.duty-free', 'climb', 'Duty-free service', 'Service · retail', 'bag', 'crew',
    'Duty-free service will follow the meal. Please have your boarding pass ready.',
    { autoWhy: 'Retail service is a crew action.' }),
  A('climb.wifi', 'climb', 'Wi-Fi and entertainment', 'Cabin · connectivity', 'wifi', 'crew',
    'Onboard Wi-Fi and entertainment are available. You can connect from your device settings.'),
  A('climb.turbulence', 'climb', 'Turbulence warning', 'Safety · turbulence', 'turbulence', 'captain',
    'We are expecting some turbulence ahead. Please return to your seat and fasten your seatbelt.',
    { autoWhy: 'Turbulence is not predicted by the feed.' }),
  A('climb.return-seats', 'climb', 'Return to seats', 'Safety · seatbelts', 'seat', 'crew',
    'Please return to your seat and fasten your seatbelt. The sign is now on.',
    { autoWhy: 'The seatbelt sign is not in the simulator feed.' }),
  A('climb.progress', 'climb', 'Flight progress', 'Cruise · progress', 'route', 'captain',
    'We are making good progress towards {destination}. The moving map on Stratos shows exactly where we are.'),
  A('climb.points-of-interest', 'climb', 'Points of interest', 'Cruise · view', 'route', 'crew',
    'Our route today crosses some interesting airspace. The Stratos map can show what is below you; ask the crew if you would like to know more.'),

  /* ── 05 · Descent & approach ──────────────────────────────────────── */
  A('desc.begin', 'descent', 'Beginning descent', 'Descent · start', 'descend', 'captain',
    'We have started our descent towards {destination}. Please make sure your seatbelt is fastened.',
    { auto: 'descent' }),
  A('desc.arrival', 'descent', 'Estimated arrival', 'Descent · ETA', 'clock', 'captain',
    'We expect to be on the ground at {arrival}.'),
  A('desc.weather', 'descent', 'Destination weather', 'Descent · weather', 'wind', 'captain',
    'The latest destination weather is on the Stratos weather page. Conditions may affect our approach, and I will update you if they do.',
    { autoWhy: 'Weather is not part of the trigger.' }),
  A('desc.holding', 'descent', 'Delays and holding', 'Descent · holding', 'hold', 'captain',
    'We have been asked to hold for a short while before commencing our approach. I will update you as soon as we have clearance.',
    { autoWhy: 'A hold is not a simulator event.' }),
  A('desc.prepare-cabin', 'descent', 'Prepare cabin for landing', 'Crew · landing', 'crew', 'crew',
    'Cabin crew, prepare the cabin for landing.'),
  A('desc.seats-upright', 'descent', 'Seats upright', 'Landing · cabin', 'upright', 'crew',
    'Please bring your seat back to the upright position.'),
  A('desc.trays', 'descent', 'Tray tables stowed', 'Landing · cabin', 'meal', 'crew',
    'Please stow your tray table and any loose items.'),
  A('desc.shades', 'descent', 'Window shades', 'Landing · cabin', 'shade', 'crew',
    'Please raise the window shades for landing.'),
  A('desc.devices', 'descent', 'Electronic devices stowed', 'Landing · devices', 'phone', 'crew',
    'Please stow larger electronic devices. Smaller devices may stay in flight mode.'),
  A('desc.seatbelts', 'descent', 'Seatbelts fastened', 'Landing · seatbelts', 'seat', 'crew',
    'Please fasten your seatbelt low and tight. The sign is on for the remainder of the flight.',
    { autoWhy: 'The seatbelt sign is not in the simulator feed.' }),
  A('desc.crew-seats', 'descent', 'Cabin crew seats for landing', 'Crew · landing', 'crew', 'crew',
    'Cabin crew, take your seats for landing.'),
  A('desc.final-approach', 'descent', 'Final approach', 'Approach · short final', 'runway', 'captain',
    'We are on final approach to {destination}. Cabin crew, remain seated.', { auto: 'approach' }),

  /* ── 06 · Landing & arrival ──────────────────────────────────────── */
  A('arr.welcome', 'arrival', 'Welcome to destination', 'Arrival · welcome', 'welcome', 'crew',
    'Welcome to {destination}.', { auto: 'touchdown' }),
  A('arr.local-time', 'arrival', 'Local time', 'Arrival · time', 'clock', 'crew',
    'The local time at {destination} is {localTime}.'),
  A('arr.remain-seated', 'arrival', 'Remain seated until parked', 'Arrival · seatbelts', 'seat', 'crew',
    'Please remain seated with your seatbelt fastened until the aircraft has come to a complete stop at the gate.'),
  A('arr.seatbelt-reminder', 'arrival', 'Seatbelt sign reminder', 'Arrival · seatbelts', 'seat', 'crew',
    'The seatbelt sign is still on. Please remain seated.',
    { autoWhy: 'The seatbelt sign is not in the simulator feed.' }),
  A('arr.bins', 'arrival', 'Overhead bin caution', 'Arrival · baggage', 'bins', 'crew',
    'Please take care when opening the overhead lockers, as items may have shifted during the flight.'),
  A('arr.doors-manual', 'arrival', 'Doors to manual', 'Crew · doors', 'door', 'crew',
    'Cabin crew, doors to manual and cross-check.',
    { autoWhy: 'Door disarming is not in the simulator feed.' }),
  A('arr.disembark', 'arrival', 'Disembarkation', 'Arrival · disembark', 'door', 'crew',
    'You may now disembark. Please take all of your belongings with you.', { auto: 'atGate' }),
  A('arr.terminal', 'arrival', 'Terminal and baggage claim', 'Arrival · terminal', 'terminal', 'crew',
    'Terminal and baggage claim information is shown on the screens in the terminal as you arrive.',
    { autoWhy: 'Gate and belt data are not in the plan.' }),
  A('arr.connections', 'arrival', 'Connecting flights', 'Arrival · connections', 'route', 'crew',
    'Passengers with onward connections should follow the transfer signs. Please allow time for security.'),
  A('arr.thanks', 'arrival', 'Thank you for flying', 'Arrival · close', 'thanks', 'captain',
    'Thank you for flying with {airline}. We look forward to seeing you on board again soon.'),

  /* ── 07 · Special situations ─────────────────────────────────────── */
  A('special.medical', 'special', 'Medical assistance request', 'Emergency · medical', 'medical', 'crew',
    'Is there a doctor or qualified medical professional on board? Please identify yourself to a member of the cabin crew.',
    { autoWhy: 'A medical event is never automatic.' }),
  A('special.severe-turbulence', 'special', 'Severe turbulence', 'Emergency · turbulence', 'turbulence', 'captain',
    'We are experiencing severe turbulence. Return to your seat immediately and fasten your seatbelt.',
    { autoWhy: 'A turbulence report is never automatic.' }),
  A('special.service-suspended', 'special', 'Service suspension', 'Cabin · service', 'alert', 'crew',
    'We have suspended the cabin service for the moment. It will resume as soon as conditions allow.',
    { autoWhy: 'A service decision is never automatic.' }),
  A('special.holding', 'special', 'Holding pattern', 'Aircraft · holding', 'hold', 'captain',
    'We are holding as directed by air traffic control. I will update you when we have further clearance.',
    { autoWhy: 'A hold is not a simulator event.' }),
  A('special.diversion', 'special', 'Diversion', 'Aircraft · diversion', 'swap', 'captain',
    'We are diverting to an alternate airport. I will give you more information as soon as it is confirmed.',
    { autoWhy: 'A diversion is never automatic.' }),
  A('special.technical', 'special', 'Technical issue', 'Aircraft · technical', 'alert', 'captain',
    'The crew are dealing with a technical issue. There is no cause for concern, and I will keep you informed.',
    { autoWhy: 'A technical event is never automatic.' }),
  A('special.refuelling', 'special', 'Refuelling with passengers aboard', 'Ground · fuel', 'fuel', 'captain',
    'We will be refuelling with passengers on board. Please remain seated and keep your seatbelt fastened.',
    { autoWhy: 'Refuelling is not in the simulator feed.' }),
  A('special.security', 'special', 'Security announcement', 'Safety · security', 'shield', 'crew',
    'Please pay attention to this security announcement. Report any unattended baggage to a member of the crew.',
    { autoWhy: 'A security event is never automatic.' }),
  A('special.aircraft-change', 'special', 'Aircraft change', 'Ground · equipment', 'swap', 'crew',
    'There has been a change of aircraft for this service. Please check the screens for your new gate and seat.',
    { autoWhy: 'An equipment change is not a simulator event.' }),
  A('special.delay', 'special', 'Unexpected delay', 'Ground · delay', 'delay', 'captain',
    'We are sorry for the delay. We will keep you updated and expect to depart as soon as possible.',
    { autoWhy: 'A delay reason is not in the simulator feed.' }),
];

export const ANNOUNCEMENTS_BY_ID = new Map(ANNOUNCEMENTS.map(item => [item.id, item]));

export function announcementById(id) {
  return ANNOUNCEMENTS_BY_ID.get(String(id || '')) || null;
}

export function announcementsForPhase(phase) {
  return ANNOUNCEMENTS.filter(item => item.phase === phase);
}

/* Events the bridge's telemetry can actually witness. A rule that needs a
 * dataref the UDP feed does not carry is absent from this list on purpose. */
export const AUTO_EVENTS = {
  taxiStart: 'The aircraft starts to taxi',
  airborne: 'The aircraft becomes airborne',
  tenThousand: 'Climbing through 10,000 ft',
  cruise: 'Level at cruise',
  descent: 'Descent begins',
  approach: 'Short final',
  touchdown: 'Touchdown',
  atGate: 'Parked at the gate',
};

/* ── context ─────────────────────────────────────────────────────────── */

function clockText(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return null;
  return `${new Date(Number(ms)).toISOString().slice(11, 16)}Z`;
}

function durationText(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const total = Math.round(n);
  return `${Math.floor(total / 60)} hours ${String(total % 60).padStart(2, '0')} minutes`;
}

/**
 * Values an announcement may speak. `airline` is the profile the pilot chose;
 * the rest come from the loaded SimBrief plan and live telemetry. A value that
 * cannot be established stays null so the page can refuse the announcement.
 */
export function cabinContext({ ofp = null, live = null, airlineName = '', now = Date.now() } = {}) {
  const flight = (ofp && ofp.flight) || {};
  const times = (ofp && ofp.times) || {};
  const origin = (ofp && ofp.origin) || {};
  const destination = (ofp && ofp.destination) || {};
  const liveAlt = Number(live && live.alt);
  const cruiseFt = Number(flight.cruiseFt);
  const level = Number.isFinite(liveAlt) && liveAlt > 5000 ? liveAlt : cruiseFt;
  const hour = new Date(now).getHours();
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const tz = Number(destination.timezone);
  const localTime = Number.isFinite(tz) && tz !== 0
    ? new Date(now + tz * 3600000).toISOString().slice(11, 16)
    : null;
  return {
    airline: airlineName || null,
    flight: flight.callsign || (live && live.callsign) || null,
    origin: origin.icao || null,
    destination: destination.icao || null,
    duration: durationText(times.enrouteMin),
    altitude: Number.isFinite(level) && level > 0
      ? (level >= 18000 ? `flight level ${Math.round(level / 100)}` : `${Math.round(level)} feet`)
      : null,
    arrival: clockText(times.arrUtc),
    localTime,
    partOfDay,
  };
}

/**
 * Fill an announcement's tokens. Returns what is missing rather than a sentence
 * with a hole silently patched; the caller refuses to play it while `ready` is
 * false.
 */
export function fillAnnouncement(item, context = {}) {
  const missing = [];
  const seen = new Set();
  const text = String((item && item.script) || '').replace(/\{([a-zA-Z]+)\}/g, (whole, token) => {
    const value = context[token];
    if (value == null || value === '') {
      if (!seen.has(token)) {
        seen.add(token);
        missing.push({ token, label: TOKEN_LABELS[token] || token });
      }
      return whole;
    }
    return String(value);
  }).replace(/\s+/g, ' ').trim();
  return { text, missing, ready: missing.length === 0 };
}

/* ── automatic triggers ──────────────────────────────────────────────── */

export function newCabinState() {
  return { flightKey: '', done: {}, prev: null, lastAt: 0 };
}

function flightKeyOf(snapshot) {
  return String((snapshot && snapshot.callsign) || '');
}

/**
 * Events the current sample justifies, with each one fired at most once per
 * flight. Only the simulator's own values are read: phase transitions, altitude
 * and vertical speed. There is no clock here, so nothing fires simply because
 * time passed.
 */
export function cabinEvents({ raw = null, snapshot = null, phase = '', state = newCabinState(), now = Date.now() } = {}) {
  const next = { ...state, done: { ...(state.done || {}) }, prev: state.prev || null };
  if (!snapshot) return { ids: [], state: next };
  const age = Number.isFinite(Number(snapshot.receivedAt)) ? now - Number(snapshot.receivedAt) : Infinity;
  if (age > 5000) return { ids: [], state: next };

  const key = flightKeyOf(snapshot);
  if (key && key !== next.flightKey) {
    next.flightKey = key;
    next.done = {};
    next.prev = null;
    next.cruiseFt = null;
  }

  const ph = String(phase || '').toUpperCase();
  const alt = Number(snapshot.alt);
  const agl = Number.isFinite(Number(snapshot.agl)) ? Number(snapshot.agl) : null;
  const vs = Number(snapshot.vs);
  const prev = next.prev;
  const ids = [];
  const fire = (event, id) => {
    if (next.done[event]) return;
    next.done[event] = 1;
    ids.push(id);
  };

  if (prev) {
    if (prev.phase === 'PARKED' && ph === 'TAXI') fire('taxiStart', 'taxi.crew-prepare');
    if (prev.phase === 'TAXI' && ph === 'AIRBORNE') fire('airborne', 'taxi.after-takeoff');
    if (prev.phase === 'AIRBORNE' && ph === 'LANDED') fire('touchdown', 'arr.welcome');
    if (prev.phase === 'LANDED' && ph === 'PARKED') {
      fire('atGate', 'arr.disembark');
      // The next taxi begins a new flight, and its announcements may fire again.
      next.done = {};
      next.cruiseFt = null;
    }
  }
  if (Number.isFinite(alt)) {
    if (prev && Number.isFinite(prev.alt) && prev.alt < 10000 && alt >= 10000) fire('tenThousand', 'taxi.seatbelt-sign');
    if (ph === 'AIRBORNE' && alt >= 18000 && Math.abs(vs) <= 400) {
      next.cruiseFt = alt;
      fire('cruise', 'climb.reaching-altitude');
    }
    if (ph === 'AIRBORNE' && next.cruiseFt && alt < next.cruiseFt - 2000 && vs < -300) {
      fire('descent', 'desc.begin');
    }
  }
  if (ph === 'AIRBORNE' && agl != null && agl < 3000 && agl > 50 && vs < -200) {
    fire('approach', 'desc.final-approach');
  }

  next.prev = { phase: ph, alt: Number.isFinite(alt) ? alt : prev ? prev.alt : null };
  next.lastAt = ids.length ? now : state.lastAt || 0;
  return { ids, state: next };
}

/* ── settings ────────────────────────────────────────────────────────── */

export const CABIN_KEY = 'stratos.cabin';

export function loadCabinSettings(storage) {
  try {
    const raw = JSON.parse((storage || localStorage).getItem(CABIN_KEY) || '{}');
    return {
      ...DEFAULT_CABIN_SETTINGS,
      ...(raw && typeof raw === 'object' ? raw : {}),
      voices: { ...DEFAULT_CABIN_SETTINGS.voices, ...((raw && raw.voices) || {}) },
      outputs: { ...((raw && raw.outputs) || {}) },
      autoOn: { ...((raw && raw.autoOn) || {}) },
    };
  } catch (_) {
    return { ...DEFAULT_CABIN_SETTINGS, voices: { ...DEFAULT_CABIN_SETTINGS.voices }, outputs: {}, autoOn: {} };
  }
}

/* Where a phase's announcements play: 'efb' (this tablet) or 'xplane' (the PC).
 * Phases with no choice saved use X-Plane. */
export function outputForPhase(settings, phase) {
  const value = settings && settings.outputs ? settings.outputs[phase] : '';
  return value === 'efb' ? 'efb' : 'xplane';
}

export function saveCabinSettings(patch, storage) {
  const next = {
    ...loadCabinSettings(storage),
    ...(patch || {}),
  };
  try { (storage || localStorage).setItem(CABIN_KEY, JSON.stringify(next)); } catch (_) { /* private mode */ }
  return next;
}

/** The airline name a profile contributes, or the operator's own name. */
export function profileName(settings) {
  const chosen = AIRLINE_PROFILES.find(item => item.id === (settings && settings.airline));
  if (!chosen) return '';
  if (chosen.id === 'custom') return String((settings && settings.customName) || '').trim();
  return chosen.name;
}

/* Aircraft checklist content for Stratos.

   These are simulator aids built from publicly documented flows. They are not
   copies of any aircraft manual and are NOT verified against the ToLiss,
   FlightFactor, Aerosoft or Microsoft aircraft. Every profile says so in the
   interface; the `verification` field is deliberately 'community' everywhere.

   Structure: a profile owns `sections`. Each section has a phase, a kind
   (normal | supplementary | emergency) and items. Item ids are generated from
   the section key and position, so progress stays stable as long as content is
   not reordered. New aircraft are added by pushing another profile: nothing in
   the app is hard-coded to a particular type. */

export const CHECKLIST_PHASES = [
  { key: 'dispatch', label: 'Pre-flight and dispatch' },
  { key: 'cockpit', label: 'Cockpit preparation' },
  { key: 'walkaround', label: 'Walkaround' },
  { key: 'beforeStart', label: 'Before start' },
  { key: 'engineStart', label: 'Engine start' },
  { key: 'afterStart', label: 'After start' },
  { key: 'taxi', label: 'Taxi' },
  { key: 'beforeTakeoff', label: 'Before takeoff' },
  { key: 'takeoff', label: 'Takeoff' },
  { key: 'climb', label: 'Climb' },
  { key: 'cruise', label: 'Cruise' },
  { key: 'descentPrep', label: 'Descent preparation' },
  { key: 'approachBrief', label: 'Approach briefing' },
  { key: 'approach', label: 'Approach' },
  { key: 'beforeLanding', label: 'Before landing' },
  { key: 'landing', label: 'Landing' },
  { key: 'afterLanding', label: 'After landing' },
  { key: 'taxiIn', label: 'Taxi to gate' },
  { key: 'parking', label: 'Parking' },
  { key: 'shutdown', label: 'Shutdown and securing' },
];

const DISCLAIMER = 'Simulator aid only. Community checklist derived from publicly documented procedures; '
  + 'not verified against the aircraft manufacturer or add-on manual and not for real-world flight.';

function item(action, expect = '', note = '') {
  return { action, expect, note };
}

function section(key, title, phase, items, kind = 'normal') {
  return { key, title, phase, kind, items };
}

/* ── Airbus A320 family ───────────────────────────────────────────
   The cockpit flow is common to the family; the profiles differ by variant
   label and by the documented differences noted in each profile, not by
   invented switch positions. */

function airbusSections(variant) {
  const neo = variant.neo;
  const isA321 = variant.ceoCode === 'A321';
  const isA319 = variant.ceoCode === 'A319';
  return [
    section('dispatch', 'Pre-flight planning and dispatch', 'dispatch', [
      item('Flight plan and ATC clearance', 'Route, level and alternates checked'),
      item('Weather and NOTAMs', 'Departure, destination and alternate reviewed'),
      item('Fuel and load sheet', 'Fuel on board matches the plan; load sheet received'),
      item('Performance calculation', 'Takeoff and landing data computed for the actual conditions', 'Use the add-on EFB or your operator tool. Stratos does not compute performance.'),
      item('Aircraft status', 'Technical log reviewed; no open item affecting the flight'),
    ]),
    section('cockpit', 'Cockpit preparation / cold and dark', 'cockpit', [
      item('BATTERY 1 and 2', 'AUTO'),
      item('EXT PWR', 'AVAIL, then ON as required'),
      item('APU MASTER SW', 'ON; APU START as required'),
      item('APU AVAIL / APU BLEED', 'AVAIL / ON as required'),
      item('ADIRS 1, 2, 3', 'NAV', 'Align; check alignment complete before taxi.'),
      item('FMS', 'INIT page completed; flight plan and performance entered'),
      item('LIGHTS and SIGNS', 'As required for the phase'),
      item('Cockpit preparation scan', 'ECAM memo and status reviewed'),
    ]),
    section('walkaround', 'External inspection and walkaround', 'walkaround', [
      item('Chocks, covers and ground equipment', 'Removed or clear as applicable'),
      item('Fuselage, doors and windows', 'Condition checked; doors closed and latched'),
      item('Wings, slats and flaps', 'No damage, obstruction or ice'),
      item('Engine intakes and exhausts', 'Clear; no FOD, covers removed'),
      item('Landing gear and tyres', 'Condition, tyre wear and chocks checked'),
      item('Static ports, pitots and sensors', 'Clear and undamaged'),
      item('Fuel panels and vents', 'Closed; no leaks'),
    ]),
    section('beforeStart', 'Before start', 'beforeStart', [
      item('Parking brake', 'ON'),
      item('Doors', 'Closed and armed as required'),
      item('Beacon', 'ON'),
      item('Fuel pumps', 'ON; ECAM fuel page checked'),
      item('Engine mode selector', 'NORMAL (or IGN/START as required)'),
      item('Thrust levers', 'IDLE'),
      item('Takeoff data', 'FMS performance and V-speeds confirmed'),
      item('Cabin ready', 'Reported by cabin crew'),
    ]),
    section('engineStart', 'Engine start', 'engineStart', [
      item('ENG 2 (or ENG 1) master switch', 'ON'),
      item('Start valve and ignition', 'Open / ON; N2 rising'),
      item('Start parameters', 'Start sequence within limits; no ECAM warning'),
      item('Second engine master switch', 'ON when the first engine is stable'),
      item('Start parameters, second engine', 'Within limits'),
      item('Engine mode selector', 'NORMAL after both engines stable'),
      item('Anti-ice', 'As required by conditions'),
    ]),
    section('afterStart', 'After start', 'afterStart', [
      item('APU', 'OFF (BLEED off after engine bleed is available)'),
      item('Flight controls', 'Checked in the flight-control ECAM page'),
      item('Flight instruments', 'Normal; no flags'),
      item('Autobrake', 'Set as required'),
      item('Pitch trim', 'Set for takeoff'),
      item('ECAM status', 'No abnormal item'),
      item('Taxi clearance', 'Obtained'),
    ]),
    section('taxi', 'Taxi', 'taxi', [
      item('Taxi lights', 'ON'),
      item('Brakes', 'Checked during the initial taxi'),
      item('Nosewheel steering', 'Checked'),
      item('Flight instruments and heading', 'Aligned with the runway or taxi direction'),
      item('Takeoff configuration', 'Checked before entering the runway'),
    ]),
    section('beforeTakeoff', 'Before takeoff', 'beforeTakeoff', [
      item('Doors and slides', 'Closed and armed'),
      item('Seat belts and no smoking signs', 'ON'),
      item('TO CONFIG test', 'Normal; no warning'),
      item('Takeoff clearance', 'Obtained'),
      item('Runway and wind', 'Confirmed; crosswind within limits'),
      item('Landing lights', 'ON'),
      item('TCAS', 'TA/RA'),
    ]),
    section('takeoff', 'Takeoff', 'takeoff', [
      item('Thrust', 'Set; parameters stabilised before 80 kt'),
      item('80 kt callout', 'Checked'),
      item('V1, VR, V2', 'Called and rotated at VR'),
      item('Positive climb', 'Gear UP'),
      item('Flight mode annunciator', 'THR CLB / CLB as expected'),
    ]),
    section('climb', 'Climb', 'climb', [
      item('Climb thrust', 'Set; thrust levers in CL detent'),
      item('Autopilot', 'Engaged as required'),
      item('Altitude and clearance', 'Set and checked'),
      item('Anti-ice', 'As required'),
      item('Seat belt signs', 'As required'),
      item('ECAM', 'No abnormal item'),
    ]),
    section('cruise', 'Cruise', 'cruise', [
      item('Fuel', 'Predicted fuel at destination checked against the plan'),
      item('Systems', 'ECAM pages reviewed periodically'),
      item('Weather', 'Destination and en-route weather reviewed'),
      item('Position and route', 'Checked against the flight plan'),
      item('Step climb', 'As required by the flight plan'),
    ]),
    section('descentPrep', 'Descent preparation', 'descentPrep', [
      item('Descent clearance and arrival', 'Obtained and programmed'),
      item('Destination weather and runway', 'ATIS or METAR reviewed'),
      item('Approach and minima', 'Selected; minima set'),
      item('Landing performance', 'Computed for the expected conditions'),
      item('Fuel', 'Checked against the plan'),
      item('Cabin', 'Descent brief completed'),
    ]),
    section('approachBrief', 'Approach briefing', 'approachBrief', [
      item('Approach type and runway', 'Briefed'),
      item('Missed approach', 'Briefed and reviewed'),
      item('Go-around decision', 'Criteria agreed'),
      item('Autopilot and autothrust plan', 'Briefed'),
      item('Taxi-in plan', 'Briefed as applicable'),
    ]),
    section('approach', 'Approach', 'approach', [
      item('Approach phase armed', 'APPR or approach mode as required'),
      item('Localiser and glideslope', 'Captured; deviation checked'),
      item('Landing configuration', 'Gear DOWN, flaps as required, speed checked'),
      item('Autopilot', 'Disconnected as required by the approach'),
      item('Stabilised approach gate', 'Stabilised by the operator gate'),
    ]),
    section('beforeLanding', 'Before landing', 'beforeLanding', [
      item('Cabin crew', 'Advised'),
      item('Seat belt signs', 'ON'),
      item('Autobrake', 'Set'),
      item('Landing lights and strobes', 'ON'),
      item('Missed approach altitude', 'Set'),
      item('Go-around', 'Reviewed'),
    ]),
    section('landing', 'Landing', 'landing', [
      item('Touchdown', 'Within the touchdown zone'),
      item('Reverse thrust', 'As required'),
      item('Autobrake or brakes', 'As required; deceleration normal'),
      item('Spoilers', 'Deployed on landing'),
      item('Runway exit', 'Vacated as cleared'),
    ]),
    section('afterLanding', 'After landing', 'afterLanding', [
      item('Flaps', 'Retracted'),
      item('Spoilers', 'Disarmed'),
      item('APU', 'Started as required'),
      item('Landing lights and strobes', 'OFF'),
      item('TCAS', 'Set to standby as required by the operator'),
      item('Anti-ice', 'OFF unless required'),
      item('Transponder', 'Set as required by ground movement'),
    ]),
    section('taxiIn', 'Taxi to gate', 'taxiIn', [
      item('Taxi clearance', 'Obtained'),
      item('Brakes and steering', 'Normal'),
      item('Taxi lights', 'ON'),
      item('Ground crew', 'In position'),
      item('Parking brake', 'ON at the stand'),
    ]),
    section('parking', 'Parking and securing', 'parking', [
      item('Parking brake', 'ON'),
      item('Engines', 'Shut down as briefed'),
      item('Seat belt signs', 'OFF'),
      item('Doors and slides', 'Disarmed'),
      item('Ground power', 'As required'),
      item('Wheel chocks', 'Set by ground crew'),
      item('Beacon', 'OFF'),
    ]),
    section('shutdown', 'Shutdown and securing', 'shutdown', [
      item('Engine master switches', 'OFF'),
      item('APU', 'As required; OFF before leaving the aircraft'),
      item('Fuel pumps', 'OFF'),
      item('BATTERY', 'OFF'),
      item('External power', 'As required by the operator'),
      item('Flight crew deviation and technical log', 'Completed'),
      item('Cabin and doors', 'Secured'),
    ]),
    section('supplementary', 'Supplementary procedures (as required)', 'cruise', [
      item('RVSM entry', 'Altimeters and autopilot checked before entering RVSM airspace'),
      item('Oceanic or remote area entry', 'Position report and contingency procedure briefed'),
      item('Cold weather operations', 'Anti-ice and engine warm-up as required by the conditions'),
      item('Volcanic ash', 'Avoid the ash; follow the operator procedure'),
    ], 'supplementary'),
    section('emergency', 'Emergency and abnormal procedures', 'emergency', [
      item('Memory items', 'Apply the aircraft memory items first, then the QRH', 'Stratos does not replace the QRH. Use the aircraft checklist for the actual procedure.'),
      item('ENGINE FIRE or severe damage', 'Affected engine secured per the QRH'),
      item('CABIN DEPRESSURIZATION', 'Oxygen masks and emergency descent as required'),
      item('REJECTED TAKEOFF', 'Thrust idle, brakes, speed as required'),
      item('WINDSHEAR', 'TOGA and the published escape manoeuvre'),
    ], 'emergency'),
    ...(variant.extraSections || []),
  ].map(entry => ({
    ...entry,
    // Variant label and note are shown once per profile, not repeated per item.
    variantNote: variant.note,
  }));
}

function airbusProfile({ key, label, variant, ceoCode, neo = false, detect, extraSections = [] }) {
  return {
    key,
    label,
    family: 'Airbus A320 family',
    variant,
    simulator: 'X-Plane 12 / MSFS',
    verification: 'community',
    disclaimer: DISCLAIMER,
    source: `Publicly documented Airbus A320-family normal flows. ${neo
      ? 'NEO engines use the same cockpit flow; performance and thrust ratings differ.'
      : 'CEO engines use the same cockpit flow; performance differs by variant.'} Simulator-specific notes are labelled.`,
    detect,
    sections: airbusSections({ ceoCode, neo, note: `${label} specific note: ${variant}.`, extraSections }),
  };
}

/* ── Airbus A340-600 (ToLiss) ─────────────────────────────────────
   Four engines and a trim-tank fuel system change the flow enough to warrant a
   dedicated profile. Fuel items name the A340-600 system; they do not claim a
   switch position that varies by add-on. */

const a346Sections = [
  section('dispatch', 'Pre-flight planning and dispatch', 'dispatch', [
    item('Flight plan and ETOPS/remote diversion plan', 'Route, level, alternates and equal-time point reviewed'),
    item('Weather and NOTAMs', 'Departure, destination, en-route and alternate reviewed'),
    item('Fuel plan', 'Block fuel, trip fuel, contingency and reserves checked'),
    item('Weight and balance', 'Load sheet and trim sheet received'),
    item('Performance', 'Takeoff, climb, landing and any obstacle data computed'),
    item('Aircraft status', 'Technical log and deferred items reviewed'),
    item('Long-haul crew and rest plan', 'Confirmed for the planned sector'),
  ]),
  section('cockpit', 'Cockpit preparation / cold and dark', 'cockpit', [
    item('BATTERY 1 and 2', 'AUTO'),
    item('EXT PWR', 'AVAIL, then ON as required'),
    item('APU MASTER SW', 'ON; APU START'),
    item('APU AVAIL and APU BLEED', 'AVAIL / ON as required'),
    item('ADIRS 1, 2, 3', 'NAV; alignment complete'),
    item('FMS', 'INIT, flight plan, performance and fuel entered'),
    item('FUEL panel', 'All pumps as required; fuel quantity checked against the load sheet'),
    item('TRIM TANK', 'Transfer system checked as required for the sector', 'The A340-600 trim tank moves fuel to the horizontal stabiliser. Follow the add-on and QRH for transfer logic.'),
    item('ECAM memo and status', 'Reviewed; no abnormal item'),
  ]),
  section('walkaround', 'External inspection and walkaround', 'walkaround', [
    item('Chocks, covers and ground equipment', 'Clear'),
    item('Fuselage and doors', 'Condition checked; doors closed'),
    item('Wings and flight controls', 'No damage or obstruction'),
    item('Engines 1 to 4', 'Intakes and exhausts clear; covers removed'),
    item('Landing gear and tyres', 'Condition and tyre pressure indications checked'),
    item('Static ports, pitots and sensors', 'Clear'),
    item('Fuel vents and panels', 'Closed; no leaks'),
  ]),
  section('beforeStart', 'Before start', 'beforeStart', [
    item('Parking brake', 'ON'),
    item('Doors', 'Closed and armed as required'),
    item('Beacon', 'ON'),
    item('Fuel pumps', 'ON; fuel page checked'),
    item('Engine mode selector', 'NORMAL or IGN/START as required'),
    item('Thrust levers', 'IDLE'),
    item('Takeoff data', 'V-speeds and flex/thrust confirmed'),
    item('Cabin ready', 'Reported'),
  ]),
  section('engineStart', 'Engine start (four engines)', 'engineStart', [
    item('ENG 4 master switch', 'ON; start sequence monitored', 'Start order is operator and add-on specific; follow the add-on procedure if it differs.'),
    item('ENG 4 start parameters', 'Within limits'),
    item('ENG 3 master switch', 'ON; parameters within limits'),
    item('ENG 2 master switch', 'ON; parameters within limits'),
    item('ENG 1 master switch', 'ON; parameters within limits'),
    item('All four engines stable', 'Idle parameters checked; no ECAM warning'),
    item('Engine mode selector', 'NORMAL'),
    item('Anti-ice', 'As required'),
  ]),
  section('afterStart', 'After start', 'afterStart', [
    item('APU', 'OFF after engine bleed is available'),
    item('Flight controls', 'Checked'),
    item('Flight instruments', 'Normal; no flags'),
    item('Autobrake', 'Set as required'),
    item('Pitch trim', 'Set for takeoff'),
    item('Fuel', 'Total and trim tank state checked'),
    item('ECAM status', 'No abnormal item'),
    item('Taxi clearance', 'Obtained'),
  ]),
  section('taxi', 'Taxi', 'taxi', [
    item('Taxi lights', 'ON'),
    item('Brakes', 'Checked'),
    item('Nosewheel steering', 'Checked'),
    item('Flight instruments', 'Aligned'),
    item('Takeoff configuration', 'Checked'),
    item('Fuel transfer', 'Trim tank transfer monitored if applicable'),
  ]),
  section('beforeTakeoff', 'Before takeoff', 'beforeTakeoff', [
    item('Doors and slides', 'Closed and armed'),
    item('Signs', 'ON'),
    item('TO CONFIG test', 'Normal'),
    item('Takeoff clearance', 'Obtained'),
    item('Runway, wind and crosswind', 'Confirmed within limits'),
    item('Landing lights', 'ON'),
    item('TCAS', 'TA/RA'),
  ]),
  section('takeoff', 'Takeoff', 'takeoff', [
    item('Thrust', 'Set; stabilised before 80 kt'),
    item('80 kt', 'Checked'),
    item('V1, VR, V2', 'Called; rotate at VR'),
    item('Positive climb', 'Gear UP'),
    item('FMA', 'THR CLB / CLB as expected'),
    item('Engine parameters', 'All four engines normal'),
  ]),
  section('climb', 'Climb', 'climb', [
    item('Climb thrust', 'Set; levers in CL detent'),
    item('Autopilot', 'Engaged'),
    item('Altitude and clearance', 'Set and checked'),
    item('Anti-ice', 'As required'),
    item('Fuel', 'Burn and trim tank transfer checked'),
    item('ECAM', 'No abnormal item'),
  ]),
  section('cruise', 'Cruise and long-haul management', 'cruise', [
    item('Fuel', 'Predicted fuel at destination checked; reserves intact'),
    item('Trim tank', 'Transfer complete; memo understood', 'A normal T TK XFRD memo means the transfer finished. Do not action a normal memo.'),
    item('Step climb', 'As required by the flight plan'),
    item('Systems', 'ECAM pages and cabin status reviewed'),
    item('Weather', 'Destination and en-route weather reviewed'),
    item('Position reporting', 'As required for the airspace'),
    item('Crew rest and handover', 'Completed as applicable'),
  ]),
  section('descentPrep', 'Descent preparation', 'descentPrep', [
    item('Descent clearance and arrival', 'Obtained and programmed'),
    item('Destination weather and runway', 'Reviewed'),
    item('Approach and minima', 'Selected'),
    item('Landing performance', 'Computed'),
    item('Fuel and trim', 'Checked for landing'),
    item('Cabin', 'Descent brief completed'),
  ]),
  section('approachBrief', 'Approach briefing', 'approachBrief', [
    item('Approach type and runway', 'Briefed'),
    item('Missed approach', 'Briefed'),
    item('Go-around criteria', 'Agreed'),
    item('Autopilot and autothrust plan', 'Briefed'),
    item('Taxi-in plan', 'Briefed as applicable'),
  ]),
  section('approach', 'Approach', 'approach', [
    item('Approach phase armed', 'APPR as required'),
    item('Localiser and glideslope', 'Captured; deviations checked'),
    item('Landing configuration', 'Gear DOWN; flaps as required; speed checked'),
    item('Autopilot', 'Disconnected as required'),
    item('Stabilised approach gate', 'Stabilised'),
  ]),
  section('beforeLanding', 'Before landing', 'beforeLanding', [
    item('Cabin crew', 'Advised'),
    item('Signs', 'ON'),
    item('Autobrake', 'Set'),
    item('Landing lights', 'ON'),
    item('Missed approach altitude', 'Set'),
    item('Go-around', 'Reviewed'),
  ]),
  section('landing', 'Landing', 'landing', [
    item('Touchdown', 'Within the touchdown zone'),
    item('Reverse thrust', 'As required'),
    item('Brakes and spoilers', 'Deceleration normal'),
    item('Runway exit', 'Vacated as cleared'),
  ]),
  section('afterLanding', 'After landing', 'afterLanding', [
    item('Flaps', 'Retracted'),
    item('Spoilers', 'Disarmed'),
    item('APU', 'Started as required'),
    item('Landing lights and strobes', 'OFF'),
    item('Anti-ice', 'OFF unless required'),
    item('Fuel', 'Transfer and quantity checked'),
  ]),
  section('taxiIn', 'Taxi to gate', 'taxiIn', [
    item('Taxi clearance', 'Obtained'),
    item('Brakes and steering', 'Normal'),
    item('Ground crew', 'In position'),
    item('Parking brake', 'ON at the stand'),
  ]),
  section('parking', 'Parking and securing', 'parking', [
    item('Parking brake', 'ON'),
    item('Engines', 'Shut down as briefed'),
    item('Signs', 'OFF'),
    item('Doors and slides', 'Disarmed'),
    item('Ground power', 'As required'),
    item('Chocks', 'Set'),
    item('Beacon', 'OFF'),
  ]),
  section('shutdown', 'Shutdown and securing', 'shutdown', [
    item('Engine master switches', 'OFF'),
    item('APU', 'OFF before leaving the aircraft'),
    item('Fuel pumps', 'OFF'),
    item('BATTERY', 'OFF'),
    item('Technical log', 'Completed'),
    item('Cabin and doors', 'Secured'),
  ]),
  section('supplementary', 'Supplementary procedures (as required)', 'cruise', [
    item('Oceanic or remote area entry', 'Position report and contingency procedure briefed'),
    item('ETOPS or remote diversion', 'Alternate and equal-time point reviewed'),
    item('Cold weather operations', 'Anti-ice and engine warm-up as required'),
    item('RVSM entry', 'Altimeters and autopilot checked'),
  ], 'supplementary'),
  section('emergency', 'Emergency and abnormal procedures', 'emergency', [
    item('Memory items', 'Apply memory items, then the QRH', 'Stratos does not replace the QRH or the add-on failure procedures.'),
    item('ENGINE FIRE or severe damage', 'Affected engine secured per the QRH'),
    item('CABIN DEPRESSURIZATION', 'Masks and emergency descent as required'),
    item('REJECTED TAKEOFF', 'Thrust idle, brakes and speed as required'),
    item('WINDSHEAR', 'TOGA and published escape manoeuvre'),
    item('FUEL IMBALANCE or trim tank fault', 'Follow the QRH fuel procedure', 'Fuel transfer logic is aircraft specific; do not improvise a transfer.'),
  ], 'emergency'),
];

/* ── Boeing 777 (FlightFactor) ───────────────────────────────────── */

function boeing777Sections(variant) {
  const is300 = /300/.test(variant);
  return [
    section('dispatch', 'Pre-flight planning and dispatch', 'dispatch', [
      item('Flight plan and clearance', 'Route, level and alternates reviewed'),
      item('Weather and NOTAMs', 'Reviewed'),
      item('Fuel and load sheet', 'Fuel and load within plan'),
      item('Performance', 'Takeoff and landing data computed'),
      item('Technical log', 'No open item affecting the flight'),
    ]),
    section('cockpit', 'Cockpit preparation / cold and dark', 'cockpit', [
      item('BATTERY', 'ON'),
      item('EXT PWR', 'ON as required'),
      item('APU', 'Started; APU bleed as required'),
      item('IRS', 'ALIGN; alignment complete'),
      item('FMC', 'POS INIT, route, performance and fuel entered'),
      item('EICAS', 'Memo and status reviewed'),
      item('Lights and signs', 'As required'),
    ]),
    section('walkaround', 'External inspection and walkaround', 'walkaround', [
      item('Chocks, covers and ground equipment', 'Clear'),
      item('Fuselage and doors', 'Condition checked'),
      item('Wings and flight controls', 'No damage or obstruction'),
      item('Engines', 'Intakes and exhausts clear'),
      item('Landing gear and tyres', 'Condition checked'),
      item('Sensors and ports', 'Clear'),
    ]),
    section('beforeStart', 'Before start', 'beforeStart', [
      item('Parking brake', 'SET'),
      item('Doors', 'Closed'),
      item('Beacon', 'ON'),
      item('Fuel pumps', 'ON as required'),
      item('Thrust levers', 'IDLE'),
      item('Takeoff data', 'V-speeds set'),
      item('Cabin ready', 'Reported'),
    ]),
    section('engineStart', 'Engine start', 'engineStart', [
      item('ENG 2 start', 'Selected; N2 and EGT within limits'),
      item('ENG 1 start', 'Selected when the first engine is stable'),
      item('Start parameters', 'Within limits; no EICAS warning'),
      item('Engine bleed', 'As required'),
      item('Anti-ice', 'As required'),
    ]),
    section('afterStart', 'After start', 'afterStart', [
      item('APU', 'OFF as required'),
      item('Flight controls', 'Checked'),
      item('Autobrake', 'Set'),
      item('Stab trim', 'Set for takeoff'),
      item('EICAS', 'No abnormal item'),
      item('Taxi clearance', 'Obtained'),
    ]),
    section('taxi', 'Taxi', 'taxi', [
      item('Taxi lights', 'ON'),
      item('Brakes', 'Checked'),
      item('Steering', 'Checked'),
      item('Takeoff configuration', 'Checked'),
    ]),
    section('beforeTakeoff', 'Before takeoff', 'beforeTakeoff', [
      item('Doors and slides', 'Closed and armed'),
      item('Signs', 'ON'),
      item('Takeoff configuration warning', 'Checked normal'),
      item('Takeoff clearance', 'Obtained'),
      item('Landing lights', 'ON'),
      item('TCAS', 'TA/RA'),
    ]),
    section('takeoff', 'Takeoff', 'takeoff', [
      item('Thrust', 'Set; stabilised before 80 kt'),
      item('V1, VR, V2', 'Called and rotated at VR'),
      item('Positive climb', 'Gear UP'),
      item('Flight mode annunciation', 'As expected'),
      item('Engine parameters', 'Normal'),
    ]),
    section('climb', 'Climb', 'climb', [
      item('Climb thrust', 'Set'),
      item('Autopilot', 'Engaged'),
      item('Altitude and clearance', 'Set and checked'),
      item('Anti-ice', 'As required'),
      item('EICAS', 'No abnormal item'),
    ]),
    section('cruise', 'Cruise', 'cruise', [
      item('Fuel', 'Predicted fuel checked'),
      item('Systems', 'EICAS pages reviewed'),
      item('Weather', 'Destination weather reviewed'),
      item('Position', 'Checked against the plan'),
    ]),
    section('descentPrep', 'Descent preparation', 'descentPrep', [
      item('Arrival and clearance', 'Programmed'),
      item('Destination weather', 'Reviewed'),
      item('Approach and minima', 'Set'),
      item('Landing performance', 'Computed'),
      item('Cabin', 'Descent brief completed'),
    ]),
    section('approachBrief', 'Approach briefing', 'approachBrief', [
      item('Approach and runway', 'Briefed'),
      item('Missed approach', 'Briefed'),
      item('Go-around criteria', 'Agreed'),
    ]),
    section('approach', 'Approach', 'approach', [
      item('Approach mode', 'Armed or engaged as required'),
      item('Localiser and glideslope', 'Captured; deviations checked'),
      item('Landing configuration', `Gear DOWN; flaps as required${is300 ? ' for the -300ER landing weight' : ''}`),
      item('Autopilot', 'Disconnected as required'),
      item('Stabilised approach gate', 'Stabilised'),
    ]),
    section('beforeLanding', 'Before landing', 'beforeLanding', [
      item('Cabin crew', 'Advised'),
      item('Signs', 'ON'),
      item('Autobrake', 'Set'),
      item('Landing lights', 'ON'),
      item('Missed approach altitude', 'Set'),
    ]),
    section('landing', 'Landing', 'landing', [
      item('Touchdown', 'Within the touchdown zone'),
      item('Reverse thrust', 'As required'),
      item('Spoilers and brakes', 'Deployed; deceleration normal'),
      item('Runway exit', 'Vacated as cleared'),
    ]),
    section('afterLanding', 'After landing', 'afterLanding', [
      item('Flaps', 'Retracted'),
      item('Spoilers', 'Disarmed'),
      item('APU', 'Started as required'),
      item('Landing lights', 'OFF'),
      item('Transponder', 'As required'),
    ]),
    section('taxiIn', 'Taxi to gate', 'taxiIn', [
      item('Taxi clearance', 'Obtained'),
      item('Ground crew', 'In position'),
      item('Parking brake', 'SET at the stand'),
    ]),
    section('parking', 'Parking and securing', 'parking', [
      item('Parking brake', 'SET'),
      item('Engines', 'Shut down'),
      item('Doors and slides', 'Disarmed'),
      item('Chocks', 'Set'),
      item('Beacon', 'OFF'),
    ]),
    section('shutdown', 'Shutdown and securing', 'shutdown', [
      item('Engine start switches', 'OFF'),
      item('Fuel pumps', 'OFF'),
      item('BATTERY', 'OFF'),
      item('Technical log', 'Completed'),
    ]),
    section('supplementary', 'Supplementary procedures (as required)', 'cruise', [
      item('Oceanic entry', 'Position report and contingency procedure briefed'),
      item('RVSM entry', 'Altimeters and autopilot checked'),
      item('Cold weather operations', 'Anti-ice and engine warm-up as required'),
    ], 'supplementary'),
    section('emergency', 'Emergency and abnormal procedures', 'emergency', [
      item('Memory items and QRH', 'Apply the aircraft procedure', 'Stratos does not replace the QRH.'),
      item('ENGINE FIRE', 'Affected engine secured per the QRH'),
      item('CABIN DEPRESSURIZATION', 'Masks and emergency descent'),
      item('REJECTED TAKEOFF', 'Thrust idle, brakes, speed'),
      item('WINDSHEAR', 'TOGA and escape manoeuvre'),
    ], 'emergency'),
  ];
}

/* ── Airbus A350 (FlightFactor) ─────────────────────────────────── */

const a350Sections = [
  section('dispatch', 'Pre-flight planning and dispatch', 'dispatch', [
    item('Flight plan and clearance', 'Reviewed'),
    item('Weather and NOTAMs', 'Reviewed'),
    item('Fuel and load', 'Checked against the plan'),
    item('Performance', 'Computed'),
    item('Technical log', 'Reviewed'),
  ]),
  section('cockpit', 'Cockpit preparation / cold and dark', 'cockpit', [
    item('BATTERY', 'ON'),
    item('EXT PWR', 'ON as required'),
    item('APU', 'Started; bleed as required'),
    item('ADIRS', 'NAV; alignment complete'),
    item('FMS', 'INIT and flight plan entered'),
    item('ECAM memo and status', 'Reviewed'),
  ]),
  section('walkaround', 'External inspection and walkaround', 'walkaround', [
    item('Chocks, covers and equipment', 'Clear'),
    item('Fuselage and doors', 'Checked'),
    item('Wings and flight controls', 'Checked'),
    item('Engines', 'Clear'),
    item('Landing gear and tyres', 'Checked'),
  ]),
  section('beforeStart', 'Before start', 'beforeStart', [
    item('Parking brake', 'ON'),
    item('Doors', 'Closed'),
    item('Beacon', 'ON'),
    item('Fuel pumps', 'ON as required'),
    item('Takeoff data', 'Confirmed'),
    item('Cabin ready', 'Reported'),
  ]),
  section('engineStart', 'Engine start', 'engineStart', [
    item('ENG 2 start', 'Selected; parameters within limits'),
    item('ENG 1 start', 'Selected; parameters within limits'),
    item('Start parameters', 'Normal; no ECAM warning'),
    item('Anti-ice', 'As required'),
  ]),
  section('afterStart', 'After start', 'afterStart', [
    item('APU', 'OFF as required'),
    item('Flight controls', 'Checked'),
    item('Autobrake', 'Set'),
    item('ECAM status', 'No abnormal item'),
    item('Taxi clearance', 'Obtained'),
  ]),
  section('taxi', 'Taxi', 'taxi', [
    item('Taxi lights', 'ON'),
    item('Brakes', 'Checked'),
    item('Steering', 'Checked'),
    item('Takeoff configuration', 'Checked'),
  ]),
  section('beforeTakeoff', 'Before takeoff', 'beforeTakeoff', [
    item('Doors and slides', 'Closed and armed'),
    item('Signs', 'ON'),
    item('Takeoff configuration test', 'Normal'),
    item('Takeoff clearance', 'Obtained'),
    item('Landing lights', 'ON'),
    item('TCAS', 'TA/RA'),
  ]),
  section('takeoff', 'Takeoff', 'takeoff', [
    item('Thrust', 'Set'),
    item('V1, VR, V2', 'Called'),
    item('Positive climb', 'Gear UP'),
    item('FMA', 'As expected'),
  ]),
  section('climb', 'Climb', 'climb', [
    item('Climb thrust', 'Set'),
    item('Autopilot', 'Engaged'),
    item('Altitude', 'Set and checked'),
    item('ECAM', 'No abnormal item'),
  ]),
  section('cruise', 'Cruise', 'cruise', [
    item('Fuel', 'Predicted fuel checked'),
    item('Systems', 'Reviewed'),
    item('Weather', 'Destination reviewed'),
  ]),
  section('descentPrep', 'Descent preparation', 'descentPrep', [
    item('Arrival', 'Programmed'),
    item('Weather and runway', 'Reviewed'),
    item('Approach and minima', 'Set'),
    item('Landing performance', 'Computed'),
  ]),
  section('approachBrief', 'Approach briefing', 'approachBrief', [
    item('Approach and runway', 'Briefed'),
    item('Missed approach', 'Briefed'),
    item('Go-around criteria', 'Agreed'),
  ]),
  section('approach', 'Approach', 'approach', [
    item('Approach mode', 'Armed or engaged'),
    item('Localiser and glideslope', 'Captured'),
    item('Landing configuration', 'Gear DOWN; flaps as required'),
    item('Stabilised approach gate', 'Stabilised'),
  ]),
  section('beforeLanding', 'Before landing', 'beforeLanding', [
    item('Cabin crew', 'Advised'),
    item('Signs', 'ON'),
    item('Autobrake', 'Set'),
    item('Landing lights', 'ON'),
  ]),
  section('landing', 'Landing', 'landing', [
    item('Touchdown', 'Within the touchdown zone'),
    item('Reverse thrust', 'As required'),
    item('Spoilers and brakes', 'Normal'),
    item('Runway exit', 'Vacated as cleared'),
  ]),
  section('afterLanding', 'After landing', 'afterLanding', [
    item('Flaps', 'Retracted'),
    item('Spoilers', 'Disarmed'),
    item('APU', 'Started as required'),
    item('Landing lights', 'OFF'),
  ]),
  section('taxiIn', 'Taxi to gate', 'taxiIn', [
    item('Taxi clearance', 'Obtained'),
    item('Ground crew', 'In position'),
    item('Parking brake', 'ON at the stand'),
  ]),
  section('parking', 'Parking and securing', 'parking', [
    item('Parking brake', 'ON'),
    item('Engines', 'Shut down'),
    item('Doors and slides', 'Disarmed'),
    item('Chocks', 'Set'),
  ]),
  section('shutdown', 'Shutdown and securing', 'shutdown', [
    item('Engine masters', 'OFF'),
    item('Fuel pumps', 'OFF'),
    item('BATTERY', 'OFF'),
    item('Technical log', 'Completed'),
  ]),
  section('supplementary', 'Supplementary procedures (as required)', 'cruise', [
    item('Oceanic entry', 'Position report and contingency procedure briefed'),
    item('RVSM entry', 'Altimeters and autopilot checked'),
    item('Cold weather operations', 'Anti-ice and engine warm-up as required'),
  ], 'supplementary'),
  section('emergency', 'Emergency and abnormal procedures', 'emergency', [
    item('Memory items and QRH', 'Apply the aircraft procedure', 'Stratos does not replace the QRH.'),
    item('ENGINE FIRE', 'Affected engine secured'),
    item('CABIN DEPRESSURIZATION', 'Masks and emergency descent'),
    item('REJECTED TAKEOFF', 'Thrust idle, brakes'),
  ], 'emergency'),
];

function boeingProfile({ key, label, variant, detect }) {
  return {
    key,
    label,
    family: 'Boeing 777',
    variant,
    simulator: 'X-Plane 12 / MSFS',
    verification: 'community',
    disclaimer: DISCLAIMER,
    source: 'Publicly documented Boeing 777 normal flows. Not verified against the FlightFactor or manufacturer manual.',
    detect,
    sections: boeing777Sections(variant),
  };
}

function airbusLongHaulProfile({ key, label, variant, detect, sections, family }) {
  return {
    key,
    label,
    family,
    variant,
    simulator: 'X-Plane 12 / MSFS',
    verification: 'community',
    disclaimer: DISCLAIMER,
    source: 'Publicly documented Airbus normal flows. Not verified against the add-on or manufacturer manual.',
    detect,
    sections,
  };
}

export const CHECKLIST_PROFILES = [
  airbusProfile({
    key: 'a319-toliss',
    label: 'Airbus A319 (ToLiss)',
    variant: 'A319',
    ceoCode: 'A319',
    detect: [/a319/i, /\ba319\b/i],
  }),
  airbusProfile({
    key: 'a320-toliss',
    label: 'Airbus A320 CEO (ToLiss)',
    variant: 'A320-200 CEO',
    ceoCode: 'A320',
    detect: [/a320(?!.*neo)/i, /\ba320\b/i],
  }),
  airbusProfile({
    key: 'a320neo-toliss',
    label: 'Airbus A320neo (ToLiss)',
    variant: 'A320neo',
    ceoCode: 'A320',
    neo: true,
    detect: [/a320\s*neo/i, /\ba20n\b/i],
  }),
  airbusProfile({
    key: 'a321-toliss',
    label: 'Airbus A321 CEO (ToLiss)',
    variant: 'A321-200 CEO',
    ceoCode: 'A321',
    detect: [/a321(?!.*neo)(?!.*lr)/i, /\ba321\b/i],
  }),
  airbusProfile({
    key: 'a321neo-toliss',
    label: 'Airbus A321neo (ToLiss)',
    variant: 'A321neo / A321LR',
    ceoCode: 'A321',
    neo: true,
    detect: [/a321\s*neo/i, /a321\s*lr/i, /\ba21n\b/i],
  }),
  airbusLongHaulProfile({
    key: 'a339-toliss',
    label: 'Airbus A330-900 (ToLiss)',
    variant: 'A330-900neo',
    family: 'Airbus A330',
    detect: [/a330\s*[- ]?900/i, /\ba339\b/i],
    // Two engines and no trim tank: the A350 flow is the honest starting point,
    // not the four-engine A340 sequence.
    sections: a350Sections,
  }),
  airbusLongHaulProfile({
    key: 'a346-toliss',
    label: 'Airbus A340-600 (ToLiss)',
    variant: 'A340-600',
    family: 'Airbus A340',
    detect: [/a340\s*[- ]?600/i, /\ba346\b/i, /toliss.*a340/i],
    sections: a346Sections,
  }),
  airbusLongHaulProfile({
    key: 'a350-ff',
    label: 'Airbus A350-900 (FlightFactor)',
    variant: 'A350-900',
    family: 'Airbus A350',
    detect: [/a350\s*[- ]?900/i, /\ba359\b/i, /a350/i],
    sections: a350Sections,
  }),
  boeingProfile({
    key: 'b772-ff',
    label: 'Boeing 777-200LR/F (FlightFactor)',
    variant: '777-200LR / 777F',
    detect: [/777\s*[- ]?200/i, /\bb77l\b/i, /\bb772\b/i],
  }),
  boeingProfile({
    key: 'b77w-ff',
    label: 'Boeing 777-300ER (FlightFactor)',
    variant: '777-300ER',
    detect: [/777\s*[- ]?300/i, /\bb77w\b/i],
  }),
];

/** A last-resort profile for an aircraft no bundled profile matches. */
export const GENERIC_PROFILE = {
  key: 'generic',
  label: 'Generic aircraft checklist',
  family: 'Generic',
  variant: 'Unspecified type',
  simulator: 'Any',
  verification: 'generic',
  disclaimer: 'Generic simulator aid. It is not an aircraft-specific checklist; use the aircraft documentation.',
  source: 'Generic light-aircraft and airliner shared flow. No systems or limitations are asserted.',
  detect: [],
  sections: [
    section('dispatch', 'Pre-flight planning', 'dispatch', [
      item('Weather and NOTAMs', 'Reviewed'),
      item('Flight plan and fuel', 'Planned and checked'),
      item('Weight and performance', 'Within limits'),
    ]),
    section('cockpit', 'Cockpit preparation', 'cockpit', [
      item('Battery and electrical power', 'On as required'),
      item('Avionics and flight instruments', 'Powered and checked'),
      item('Fuel quantity', 'Checked against the plan'),
      item('Flight plan entered', 'Route and altitude checked'),
    ]),
    section('walkaround', 'Walkaround', 'walkaround', [
      item('Control surfaces', 'Free and undamaged'),
      item('Fuel, oil and vents', 'Checked; caps secure'),
      item('Tyres and gear', 'Condition checked'),
      item('Pitot and static ports', 'Clear'),
    ]),
    section('beforeStart', 'Before start', 'beforeStart', [
      item('Parking brake', 'SET'),
      item('Doors and belts', 'Closed; signs on'),
      item('Beacon', 'ON'),
      item('Fuel selector and pumps', 'As required'),
    ]),
    section('engineStart', 'Engine start', 'engineStart', [
      item('Start sequence', 'Follow the aircraft procedure'),
      item('Oil pressure and parameters', 'Within limits'),
    ]),
    section('afterStart', 'After start', 'afterStart', [
      item('Generators and avionics', 'Online'),
      item('Flight controls', 'Checked'),
      item('Flight instruments', 'Checked'),
      item('Trim', 'Set for takeoff'),
    ]),
    section('taxi', 'Taxi', 'taxi', [
      item('Brakes', 'Checked'),
      item('Steering', 'Checked'),
      item('Taxi clearance', 'Obtained'),
    ]),
    section('beforeTakeoff', 'Before takeoff', 'beforeTakeoff', [
      item('Doors and signs', 'Closed; signs on'),
      item('Takeoff configuration', 'Checked'),
      item('Clearance', 'Obtained'),
      item('Lights', 'As required'),
    ]),
    section('takeoff', 'Takeoff', 'takeoff', [
      item('Thrust', 'Set'),
      item('Rotate', 'At the computed speed'),
      item('Positive climb', 'Gear up'),
    ]),
    section('climb', 'Climb', 'climb', [
      item('Climb power', 'Set'),
      item('Altitude', 'Set and checked'),
      item('Anti-ice', 'As required'),
    ]),
    section('cruise', 'Cruise', 'cruise', [
      item('Fuel', 'Checked'),
      item('Weather', 'Destination reviewed'),
    ]),
    section('descentPrep', 'Descent preparation', 'descentPrep', [
      item('Arrival and weather', 'Reviewed'),
      item('Landing performance', 'Computed'),
    ]),
    section('approachBrief', 'Approach briefing', 'approachBrief', [
      item('Approach and missed approach', 'Briefed'),
    ]),
    section('approach', 'Approach', 'approach', [
      item('Landing configuration', 'Set'),
      item('Stabilised approach', 'Achieved'),
    ]),
    section('beforeLanding', 'Before landing', 'beforeLanding', [
      item('Signs and lights', 'Set'),
      item('Go-around', 'Reviewed'),
    ]),
    section('landing', 'Landing', 'landing', [
      item('Touchdown', 'Within the touchdown zone'),
      item('Brakes and reverse', 'As required'),
    ]),
    section('afterLanding', 'After landing', 'afterLanding', [
      item('Flaps', 'Retracted'),
      item('Lights', 'As required'),
    ]),
    section('taxiIn', 'Taxi to gate', 'taxiIn', [
      item('Taxi clearance', 'Obtained'),
      item('Parking brake', 'Set at the stand'),
    ]),
    section('parking', 'Parking', 'parking', [
      item('Parking brake', 'SET'),
      item('Engines', 'Shut down'),
      item('Chocks', 'Set'),
    ]),
    section('shutdown', 'Securing', 'shutdown', [
      item('Avionics and battery', 'Off'),
      item('Aircraft secured', 'Doors and controls'),
    ]),
    section('emergency', 'Emergency procedures', 'emergency', [
      item('Aircraft checklist and QRH', 'Use the aircraft documentation', 'Stratos does not replace the aircraft checklist.'),
    ], 'emergency'),
  ],
};

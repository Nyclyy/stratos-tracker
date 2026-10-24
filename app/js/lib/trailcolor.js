/* The colour a flown path is drawn in, from how high the aircraft was.
 *
 * A tracking app colours the recorded trajectory by altitude so the climb and
 * the descent are readable without reading numbers: white on the ground, then a
 * steady ramp through blue, green, yellow and orange to magenta at the flight
 * levels. Both maps use this one ramp so the phone and the desktop show the same
 * flight in the same colours.
 *
 * Height is height above ground: the recorder stores AGL per sample, which keeps
 * a taxiway at a high-altitude airport white. A recording without AGL is coloured
 * by height above its own lowest point, which is the departure elevation for a
 * flight recorded from the gate.
 */

export const TRAIL_RAMP = [
  [0, '#ffffff'],
  [2000, '#93c5fd'],
  [7000, '#34d399'],
  [12000, '#a3e635'],
  [18000, '#fde047'],
  [26000, '#fb923c'],
  [34000, '#f87171'],
  [42000, '#d946ef'],
];

const STOPS = TRAIL_RAMP.map(([height, hex]) => [
  height,
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)],
]);

function channel(value) {
  return Math.min(255, Math.max(0, Math.round(value / 8) * 8));
}

/** The colour of a path point at this height above the ground, in feet. */
export function trailInk(heightFt) {
  const h = Number(heightFt) > 0 ? Number(heightFt) : 0;
  let i = 1;
  while (i < STOPS.length && h > STOPS[i][0]) i++;
  if (i >= STOPS.length) {
    const top = STOPS[STOPS.length - 1][1].map(channel);
    return `rgb(${top[0]},${top[1]},${top[2]})`;
  }
  const [h0, c0] = STOPS[i - 1];
  const [h1, c1] = STOPS[i];
  const f = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  return `rgb(${channel(c0[0] + (c1[0] - c0[0]) * f)},${channel(c0[1] + (c1[1] - c0[1]) * f)},${channel(c0[2] + (c1[2] - c0[2]) * f)})`;
}

/** The colour ramp as CSS stops, for a legend. */
export function trailGradient() {
  return TRAIL_RAMP.map(([height, hex]) => `${hex} ${(height / 42000) * 100}%`).join(', ');
}

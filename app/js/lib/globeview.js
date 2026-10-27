/* Orthographic globe geometry, shared by every Stratos map that can show one.

   A globe is a camera: a place on the sphere it looks at, plus a radius in
   pixels. Everything else — where a coordinate lands on screen, what a tap
   under the pointer means, which half of a country outline is the far side,
   what colour each pixel of the sphere is — follows from those two numbers, and
   it is the same arithmetic in the Flight Planner, the Navigator and the
   tracker's Flight Deck.

   So it lives here once, as pure functions with no canvas, no DOM and no state.
   Two maps that draw the same sphere from two copies of this would eventually
   disagree about where the horizon is; one copy cannot.

   The raster pass below is the other half: painting the sphere needs the
   inverse projection once per output pixel, and that is a hot loop measured in
   hundreds of thousands of calls per redraw. It writes into the caller's own
   buffer — the caller's ImageData — so a pass allocates nothing. */

import { DEG, validLatLon } from './geo.js';

/** A coordinate as a unit vector on the sphere. */
export function unitVector(lat, lon) {
  const phi = Number(lat) * DEG;
  const lam = Number(lon) * DEG;
  const cos = Math.cos(phi);
  return { x: cos * Math.cos(lam), y: cos * Math.sin(lam), z: Math.sin(phi) };
}

/**
 * Radius of the sphere on screen, in pixels. The sphere is the largest one that
 * fits the canvas box with the page's own padding left for its controls, times
 * the pilot's zoom.
 */
export function globeRadiusFor(width, height, padding, zoom = 1) {
  const pad = Number(padding) || 0;
  const z = Number(zoom) > 0 ? Number(zoom) : 1;
  return Math.max(40, Math.min(width - pad, height - pad * 2) * 0.46 * z);
}

/** The camera a projection reads: a centre in degrees, a radius and a screen centre. */
export function cameraFor(center, radius, cx, cy) {
  return {
    center: center || { lat: 0, lon: 0 },
    radius: Math.max(1, Number(radius) || 1),
    cx: Number(cx) || 0,
    cy: Number(cy) || 0,
  };
}

/**
 * Orthographic projection: the point is on screen when it faces the camera.
 * Returns null for the far side, which is what cuts every outline at the limb
 * and what tells a caller a symbol must not be drawn at all.
 */
export function globeProject(lat, lon, camera) {
  const { center, radius, cx, cy } = camera;
  const phi0 = center.lat * DEG;
  const lam0 = center.lon * DEG;
  const phi = Number(lat) * DEG;
  const lam = Number(lon) * DEG;
  if (!Number.isFinite(phi) || !Number.isFinite(lam)) return null;
  const dLam = lam - lam0;
  const z = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLam);
  if (z < 0) return null;
  return {
    x: cx + radius * Math.cos(phi) * Math.sin(dLam),
    y: cy - radius * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLam)),
    z,
  };
}

/** The inverse orthographic projection, or null outside the disc. */
export function globeUnproject(x, y, camera) {
  const { center, radius, cx, cy } = camera;
  if (!radius) return null;
  const px = (x - cx) / radius;
  const py = (cy - y) / radius;
  const rho = Math.hypot(px, py);
  if (rho > 1) return null;
  const phi0 = center.lat * DEG;
  const c = Math.asin(Math.min(1, rho));
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);
  const lat = rho === 0 ? phi0 : Math.asin(Math.max(-1, Math.min(1, cosC * Math.sin(phi0) + (py * sinC * Math.cos(phi0)) / rho)));
  const lon = center.lon * DEG + Math.atan2(px * sinC, rho * cosC * Math.cos(phi0) - py * sinC * Math.sin(phi0));
  return { lat: lat / DEG, lon: ((lon / DEG + 540) % 360) - 180 };
}

/**
 * The same projection for a caller that must have a screen position — a line
 * through a sequence of coordinates, say. A point on the far side has no
 * position of its own, so it is placed on the limb in its own direction: the
 * line then runs to the horizon and stops there, which is what a line crossing
 * the edge of a sphere does, instead of leaving a chord across the face.
 *
 * A point exactly behind the camera has no direction at all; the camera's own
 * axis is used for that one degenerate position, so a line through the
 * antipode is stable rather than jittering.
 */
export function globeProjectClamped(lat, lon, camera) {
  const front = globeProject(lat, lon, camera);
  if (front) return front;
  const { center, radius, cx, cy } = camera;
  const phi0 = center.lat * DEG;
  const lam0 = center.lon * DEG;
  const phi = Number(lat) * DEG;
  const lam = Number(lon) * DEG;
  if (!Number.isFinite(phi) || !Number.isFinite(lam)) return { x: cx, y: cy, z: -1 };
  const v = unitVector(lat, lon);
  const across = [-Math.sin(lam0), Math.cos(lam0), 0];
  const up = [-Math.sin(phi0) * Math.cos(lam0), -Math.sin(phi0) * Math.sin(lam0), Math.cos(phi0)];
  let ax = v.x * across[0] + v.y * across[1] + v.z * across[2];
  let ay = v.x * up[0] + v.y * up[1] + v.z * up[2];
  let rho = Math.hypot(ax, ay);
  if (rho < 1e-9) {
    const dLam = lam - lam0;
    ax = Math.cos(dLam);
    ay = -Math.sin(dLam);
    rho = Math.hypot(ax, ay) || 1;
  }
  return { x: cx + (radius * ax) / rho, y: cy - (radius * ay) / rho, z: -1 };
}

/** The unit vector pointing at the camera: the centre of the visible face. */
export function cameraDirection(center) {
  const phi0 = (center || { lat: 0, lon: 0 }).lat * DEG;
  const lam0 = (center || { lat: 0, lon: 0 }).lon * DEG;
  return { x: Math.cos(phi0) * Math.cos(lam0), y: Math.cos(phi0) * Math.sin(lam0), z: Math.sin(phi0) };
}

/** A unit vector on the sphere, on screen. Null when it is on the far side. */
export function globeProjectVector(v, camera) {
  const { center, radius, cx, cy } = camera;
  const phi0 = center.lat * DEG;
  const lam0 = center.lon * DEG;
  const cos0 = Math.cos(phi0);
  const sin0 = Math.sin(phi0);
  // Facing test first: a point is visible when it is on the camera's side.
  const dot = v.x * cos0 * Math.cos(lam0) + v.y * cos0 * Math.sin(lam0) + v.z * sin0;
  if (dot < 0) return null;
  const phi = Math.asin(Math.max(-1, Math.min(1, v.z)));
  const dLam = Math.atan2(v.y, v.x) - lam0;
  return {
    x: cx + radius * Math.cos(phi) * Math.sin(dLam),
    y: cy - radius * (cos0 * Math.sin(phi) - sin0 * Math.cos(phi) * Math.cos(dLam)),
    z: dot,
  };
}

/**
 * A ring of unit vectors clipped to the visible hemisphere, with the horizon
 * itself walked rather than cut across.
 *
 * A straight chord across the limb would slice a bite out of a continent that
 * crosses the horizon. Every point the cut generates lies in the plane through
 * the sphere's centre that faces the camera, so blending two of them and
 * normalising keeps the result on that circle — which is exactly the limb.
 */
export function clipToHemisphere(ring, camera = { x: 0, y: 0, z: 1 }) {
  const dot = v => v.x * camera.x + v.y * camera.y + v.z * camera.z;
  const out = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const da = dot(a);
    const db = dot(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      const n = Math.hypot(x, y, z) || 1;
      out.push({ x: x / n, y: y / n, z: z / n, limb: true });
    }
  }
  if (out.length < 3) return out;
  const dense = [];
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    dense.push(a);
    if (a.limb && b.limb) {
      for (let step = 1; step < 8; step += 1) {
        const t = step / 8;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const z = a.z + (b.z - a.z) * t;
        const n = Math.hypot(x, y, z) || 1;
        dense.push({ x: x / n, y: y / n, z: z / n, limb: true });
      }
    }
  }
  return dense;
}

/**
 * The middle of a set of points, as the mean of their unit vectors rather than
 * the mean of their coordinates: a set that straddles the date line has no
 * sensible average longitude, while the vector mean is the same calculation
 * anywhere on the sphere. Null when there is nothing to average.
 */
export function vectorMeanCentre(points) {
  const list = (points || []).filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
  if (!list.length) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of list) {
    const phi = Number(point.lat) * DEG;
    const lam = Number(point.lon) * DEG;
    x += Math.cos(phi) * Math.cos(lam);
    y += Math.cos(phi) * Math.sin(lam);
    z += Math.sin(phi);
  }
  const norm = Math.hypot(x, y, z);
  if (!(norm > 1e-6)) return { lat: 0, lon: 0 };
  return { lat: Math.asin(Math.max(-1, Math.min(1, z / norm))) / DEG, lon: Math.atan2(y, x) / DEG };
}

/**
 * The centre after a drag of (dx, dy) pixels. The globe turns under the
 * pointer: sideways spins it, up and down rolls it. The spin is divided by the
 * cosine of the latitude so a drag feels the same speed near the poles as at
 * the equator.
 */
export function orbitBy(center, dx, dy, radius) {
  const r = radius || 1;
  const base = center || { lat: 0, lon: 0 };
  const lat = Math.max(-89.5, Math.min(89.5, base.lat + (dy / r) * (180 / Math.PI)));
  const spin = (dx / r) * (180 / Math.PI) / Math.max(0.25, Math.cos(lat * DEG));
  return { lat, lon: ((base.lon - spin + 540) % 360) - 180 };
}

/**
 * The ground distance, in nautical miles, that the pixel offset from the middle
 * of the sphere covers. One pixel at the centre is an angle of 1/radius
 * radians, which is 3437.75/radius nautical miles — the same relation at every
 * latitude, because the sphere is round.
 */
export function nmPerPixelAtCentre(radius) {
  return 3437.7468 / Math.max(1, radius);
}

/**
 * One pass of the inverse projection into `data` — an ImageData buffer the
 * caller already owns. `sample(lat, lon, out)` writes the colour for a
 * coordinate into a four-slot array and returns null where nothing is loaded
 * yet, in which case the sphere's own flat base colour is written instead.
 *
 * Returns how many pixels asked for a colour and how many got one, so the
 * caller can decide whether the picture is complete enough to show rather than
 * showing a plausible-looking empty sphere.
 */
export function rasteriseGlobe({ size, center, sample, base, data }) {
  const phi0 = center.lat * DEG;
  const lam0 = center.lon * DEG;
  const sin0 = Math.sin(phi0);
  const cos0 = Math.cos(phi0);
  const cosLam = Math.cos(lam0);
  const sinLam = Math.sin(lam0);
  /* The camera as three unit vectors: across, up and forward. Turning a screen
     offset into a place on the sphere is then three multiply-adds and two
     inverse trigonometric calls, where the textbook inverse orthographic
     formula spends four transcendentals on every pixel. This raster is rebuilt
     on each turn of the globe, so that difference is the difference between a
     sphere that keeps up with a drag and one that stutters behind it. */
  const acrossVec = [-sinLam, cosLam, 0];
  const upVec = [-sin0 * cosLam, -sin0 * sinLam, cos0];
  const forwardVec = [cos0 * cosLam, cos0 * sinLam, sin0];
  const half = size / 2;
  const pixel = [0, 0, 0, 0];
  let painted = 0;
  let asked = 0;
  for (let y = 0; y < size; y += 1) {
    // Only the rows inside the disc, and only the columns inside it on this
    // row: the corners are a quarter of the square and are never drawn.
    const ry = (half - y - 0.5) / half;
    const rhoY = ry * ry;
    if (!(rhoY < 1)) continue;
    const span = Math.sqrt(1 - rhoY);
    const x0 = Math.max(0, Math.round(half - span * half));
    const x1 = Math.min(size - 1, Math.round(half + span * half) - 1);
    // The row is fixed for the whole run of x, so its share of the up vector
    // is worked out once instead of per pixel.
    const upx = upVec[0] * ry;
    const upy = upVec[1] * ry;
    const upz = upVec[2] * ry;
    for (let x = x0; x <= x1; x += 1) {
      const rx = (x + 0.5 - half) / half;
      const rho2 = rx * rx + rhoY;
      if (rho2 > 1) continue;
      const zc = Math.sqrt(1 - rho2);
      const vx = acrossVec[0] * rx + upx + forwardVec[0] * zc;
      const vy = acrossVec[1] * rx + upy + forwardVec[1] * zc;
      const vz = acrossVec[2] * rx + upz + forwardVec[2] * zc;
      const lat = Math.asin(vz > 1 ? 1 : vz < -1 ? -1 : vz);
      const colour = sample(lat / DEG, ((Math.atan2(vy, vx) / DEG + 540) % 360) - 180, pixel);
      const index = (y * size + x) * 4;
      asked += 1;
      if (colour && colour[3] > 0) {
        painted += 1;
        data[index] = colour[0];
        data[index + 1] = colour[1];
        data[index + 2] = colour[2];
      } else {
        data[index] = base[0];
        data[index + 1] = base[1];
        data[index + 2] = base[2];
      }
      data[index + 3] = 255;
    }
  }
  return { painted, asked, share: asked ? painted / asked : 0 };
}

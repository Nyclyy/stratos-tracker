/* Small canvas map used by the live, replay, route and discovery screens.

   Tiles come from Esri's World Light/Dark Gray canvas (no key, no sign-up) and
   are only requested for the visible area at replay/preview time — not
   continuously. Attribution is rendered in the corner and must remain visible.
   No tile is shown as live traffic.

   Layers: tiles, the recorded track, and a planned route (waypoints in order).
   Each layer can be hidden. Follow mode keeps the aircraft centred at a fixed
   zoom. Zoom changes only redraw; route and track geometry are re-projected
   from the stored lat/lon, which is cheap for a route of tens of points.

   When `onSelect` / `onDragWaypoint` are supplied the planned route becomes
   interactive: a tap selects a leg or waypoint and a waypoint can be dragged.
   Hit testing is done in screen space against the projected geometry, so it
   stays accurate at every zoom level without a second data model. */

import { DEG, destination, distanceNm, validLatLon } from './lib/geo.js';
import { trailInk } from './lib/trailcolor.js';
import { smoothPath } from './lib/trailpath.js';
import { earthStyle, EarthView } from './lib/earthview.js';
import {
  cameraDirection,
  cameraFor,
  clipToHemisphere,
  globeProject,
  globeProjectVector,
  globeRadiusFor,
  globeUnproject,
  orbitBy,
  rasteriseGlobe,
  unitVector,
  vectorMeanCentre,
} from './lib/globeview.js';

const TILE = 256;
const TILE_LIMIT = 160;
const MIN_ZOOM = 2;
const MAX_ZOOM = 13;
const FOLLOW_ZOOM = 9;

function lonToX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToY(lat, z) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** z;
}
function xToLon(x, z) { return (x / 2 ** z) * 360 - 180; }
function yToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/* Own aircraft, drawn as an aircraft rather than a triangle: a swept silhouette
   that points along the track, a dashed vector ahead of it, and a soft halo so
   the symbol stays findable over a busy chart. Used by pages that ask for it
   (`ownSymbol: 'aircraft'`); every other page keeps the compact marker. */
function drawAircraftSymbol(ctx, p, heading = 0, label = '') {
  const hdg = Number(heading) || 0;
  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.arc(0, 0, 17, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(4,9,15,.55)';
  ctx.fill();

  ctx.save();
  ctx.rotate((hdg * Math.PI) / 180);
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = 'rgba(34,211,238,.9)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -13);
  ctx.lineTo(0, -46);
  ctx.stroke();
  ctx.setLineDash([]);

  const half = [[0, -14], [2.2, -6.2], [13, 1.2], [13, 3.8], [2.6, 2.4], [2.6, 8.6], [6.6, 11.6], [6.6, 13.6], [0, 12.4]];
  ctx.beginPath();
  half.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  for (let i = half.length - 1; i >= 0; i -= 1) ctx.lineTo(-half[i][0], half[i][1]);
  ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.75)';
  ctx.shadowBlur = 5;
  ctx.fillStyle = '#f2f8ff';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#050b12';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  if (label) {
    ctx.font = '600 11px system-ui, sans-serif';
    const width = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(4,9,15,.72)';
    ctx.fillRect(18, -8, width + 10, 16);
    ctx.fillStyle = '#dff3ff';
    ctx.fillText(label, 23, 3.5);
  }
  ctx.restore();
}

/* One waypoint symbol, drawn in screen space so it stays the same size at every
   zoom. Airport is a ringed dot, a navaid a hexagon and a fix a triangle — the
   shapes an enroute chart uses, so the type of a point is readable before its
   label is. */
function drawNavPoint(ctx, x, y, options) {
  const { kind, accent, end, isNext, active, invert } = options;
  const base = invert ? '#0f172a' : '#eaf3ff';
  ctx.save();
  ctx.translate(x, y);

  if (isNext) {
    ctx.beginPath();
    ctx.arc(0, 0, 10.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34, 211, 238, .16)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const shape = () => {
    ctx.beginPath();
    if (kind === 'apt') {
      ctx.arc(0, 0, 5.2, 0, Math.PI * 2);
    } else if (kind === 'nav') {
      for (let i = 0; i < 6; i += 1) {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        const px = Math.cos(angle) * 4.6;
        const py = Math.sin(angle) * 4.6;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.moveTo(0, -4.8);
      ctx.lineTo(4.4, 3.6);
      ctx.lineTo(-4.4, 3.6);
      ctx.closePath();
    }
  };

  shape();
  ctx.fillStyle = 'rgba(4, 9, 15, .82)';
  ctx.fill();
  shape();
  ctx.strokeStyle = end === 'origin' ? '#34d399' : end === 'destination' ? '#f87171' : base;
  ctx.lineWidth = end ? 2 : 1.5;
  ctx.stroke();

  if (kind === 'apt') {
    ctx.beginPath();
    ctx.arc(0, 0, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = base;
    ctx.fill();
  }

  if (active) {
    ctx.beginPath();
    ctx.arc(0, 0, 8.6, 0, Math.PI * 2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

export class MiniMap {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.track = [];
    this.route = [];
    // Real navigation points around the view: airports, navaids and published
    // fixes, each with the source that supplied it. The page fills this from
    // the nav-data index; the map never invents a point to fill the ring.
    this.navPoints = [];
    this.navMeta = null;
    this.rangeNm = Number(options.rangeNm) > 0 ? Number(options.rangeNm) : 40;
    this.showRange = options.showRange === true;
    this.showScale = options.showScale === true;
    this.traffic = [];
    this.trafficTrail = [];
    this.trafficSelected = '';
    this.position = null;
    this.heading = null;
    this.options = { padding: 34, attribution: true, ...options };
    // The radius ring and the distance scale are a planning chart's tools, so a
    // page asks for them; a map that never set navigation points draws nothing
    // for `nav` either way, and gains no ring or scale bar it did not ask for.
    this.layers = { tiles: true, track: true, route: true, traffic: true, nav: true, range: false, scale: false, ...(options.layers || {}) };
    this.follow = false;
    this.manualZoom = null;
    // A panned view is kept as a place, not as pixels, so it survives a resize.
    this.manualCenter = null;
    // Which waypoint the aircraft has passed and which one is next, when a
    // page has live progress to report.
    this.routeState = null;
    this.panMovedAt = 0;
    this.autoZoom = 6;
    /* Flat chart or movable globe. Both draw the same route, the same navigation
       points and the same centred query, so switching mode changes only how the
       world is drawn — never what the plan contains. */
    this.mode = options.mode === 'globe' ? 'globe' : 'plane';
    this.globeZoom = Number(options.globeZoom) > 0 ? Number(options.globeZoom) : 1;
    this.globeCenter = null;   // the camera target, in degrees
    this.globeRingsCache = null;
    this.globeLandState = 'idle';   // idle | loading | ready | unavailable
    this.globeLandPromise = null;
    /* What the globe is painted with. Outlines is the default: it needs no
       network and no decoder, and a pilot who never asks for imagery or
       terrain never pays for either. */
    this.globeStyleId = earthStyle(options.globeStyle).id;
    this.earth = null;
    this.globeRasterCache = null;
    this.rasterHost = null;
    this.globeMovedAt = 0;
    this.globeRedrawTimer = 0;
    this.tiles = new Map();
    this.failedTiles = 0;
    this.onSeek = options.onSeek || null;
    this.onSelect = options.onSelect || null;
    this.onDragWaypoint = options.onDragWaypoint || null;
    // A page that builds a route can accept a point from an empty part of the
    // chart. Off unless the page asks, so no other map gains a stray click.
    this.onPick = options.onPick || null;
    this.selection = { segmentIndex: null, waypointIndex: null };
    this.drag = null;
    // Touch targets are larger on phones and tablets; the pointer events below
    // work the same way for a mouse, a pen and a finger.
    this.touch = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    this.onTileLoad = () => this.draw();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    canvas.addEventListener('click', event => this.handleClick(event));
    // Kept on the element so a page (or a browser test) can reach the map that
    // owns a canvas after a re-render without a module-level registry.
    canvas.stratosMap = this;
    this.bindPointer(canvas);
    this.bindPan(canvas);
    this.resize();
  }

  /**
   * Drag to pan and wheel to zoom, only on a page that asks for it. The view is
   * stored as a centre and a zoom so a re-render, a rotation or a resize keeps
   * the pilot looking at the same piece of the chart.
   */
  bindPan(canvas) {
    if (!this.options.pannable) return;
    const local = event => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    let active = null;
    const move = event => {
      if (!active) return;
      const { x, y } = local(event);
      const dx = x - active.x;
      const dy = y - active.y;
      if (!active.moved && Math.hypot(dx, dy) < 3) return;
      active.moved = true;
      this.panBy(dx, dy);
      active.x = x;
      active.y = y;
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    };
    const release = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
      canvas.style.cursor = '';
      // A drag that ends over a waypoint must not also count as a tap on it.
      if (active && active.moved) {
        this.panMovedAt = Date.now();
        this.options.onViewChange?.({ pan: true });
      }
      active = null;
    };

    canvas.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      if (this.drag) return;
      const { x, y } = local(event);
      const hit = this.onSelect || this.onDragWaypoint ? this.hitTest(x, y) : null;
      if (hit && hit.kind === 'waypoint' && this.onDragWaypoint) return;
      active = { x, y, moved: false };
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) { /* optional */ }
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
    });

    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const { x, y } = local(event);
      this.zoomAt(x, y, event.deltaY > 0 ? -1 : 1);
    }, { passive: false });
  }

  /** Move the chart under the pointer by a screen-space offset. */
  panBy(dx, dy) {
    if (this.mode === 'globe') {
      // The globe turns under the pointer: sideways spins it, up and down rolls
      // it. The spin is divided by the cosine of the latitude so a drag feels
      // the same speed near the poles as at the equator.
      const radius = this.globeRadius() || 1;
      const center = this.globeCenter || { lat: 0, lon: 0 };
      this.globeCenter = orbitBy(center, dx, dy, radius);
      this.globeMovedAt = performance.now();
      this.draw();
      return;
    }
    const view = this.fit();
    if (!view) return;
    const centerX = view.centerX - dx / TILE;
    const centerY = view.centerY - dy / TILE;
    this.manualCenter = { lat: yToLat(centerY, view.zoom), lon: xToLon(centerX, view.zoom) };
    if (this.follow) this.follow = false;
    this.draw();
  }

  /** Zoom a level while keeping the point under (x, y) where it is. */
  zoomAt(x, y, delta) {
    if (this.mode === 'globe') {
      const before = this.globeUnproject(x, y);
      const factor = delta > 0 ? 1.4 : 1 / 1.4;
      const next = Math.max(1, Math.min(40, this.globeZoom * factor));
      if (next === this.globeZoom) return;
      this.globeZoom = next;
      // Keep the place under the pointer where it is: the camera turns toward it
      // as the sphere grows.
      const after = this.globeUnproject(x, y);
      if (before && after) {
        const center = this.globeCenter || { lat: 0, lon: 0 };
        this.globeCenter = {
          lat: Math.max(-89.5, Math.min(89.5, center.lat + (before.lat - after.lat) * 0.35)),
          lon: ((center.lon + (before.lon - after.lon) * 0.35 + 540) % 360) - 180,
        };
      }
      this.draw();
      this.options.onViewChange?.({ zoom: true });
      return;
    }
    const view = this.fit();
    if (!view) return;
    const base = this.manualZoom ?? view.zoom;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base + delta));
    if (zoom === base) return;
    const before = this.unproject(x, y, view);
    const centerX = lonToX(before.lon, zoom) - (x - this.width / 2) / TILE;
    const centerY = latToY(before.lat, zoom) - (y - this.height / 2) / TILE;
    this.manualZoom = zoom;
    this.manualCenter = { lat: yToLat(centerY, zoom), lon: xToLon(centerX, zoom) };
    if (this.follow) this.follow = false;
    this.draw();
    this.options.onViewChange?.({ zoom: true });
  }

  /**
   * Live route progress, as waypoint indexes. `passedIndex` is the waypoint the
   * aircraft last crossed, so the leg from there to the next one is the leg it
   * is flying.
   */
  setRouteState(state) {
    this.routeState = state && typeof state === 'object' ? state : null;
    this.draw();
  }

  /** Frame the whole planned route again, dropping any manual pan or zoom. */
  fitRoute() {
    if (this.mode === 'globe') {
      this.globeFit();
      this.draw();
      this.options.onViewChange?.({ fit: true });
      return;
    }
    this.manualZoom = null;
    this.manualCenter = null;
    this.draw();
    this.options.onViewChange?.({ fit: true });
  }

  /** Put a place in the middle of the chart at a sensible zoom. */
  centerOn(lat, lon, zoom = null) {
    if (!validLatLon(Number(lat), Number(lon))) return;
    if (this.follow) this.follow = false;
    if (zoom != null) this.manualZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(zoom)));
    this.manualCenter = { lat: Number(lat), lon: Number(lon) };
    this.draw();
    this.options.onViewChange?.({ center: true });
  }

  /**
   * Highlight legs and/or a waypoint without rebuilding the route.
   * `segments` is a list of leg indexes (a waypoint highlights its connected
   * legs); `segmentIndex` is the single selected leg.
   */
  setSelection(selection = {}) {
    const segments = Array.isArray(selection.segments)
      ? selection.segments.map(Number).filter(Number.isFinite)
      : (selection.segmentIndex == null ? [] : [Number(selection.segmentIndex)]);
    this.selection = {
      segments,
      segmentIndex: segments.length === 1 ? segments[0] : (selection.segmentIndex == null ? null : Number(selection.segmentIndex)),
      waypointIndex: selection.waypointIndex == null ? null : Number(selection.waypointIndex),
    };
    this.draw();
  }

  /** Other aircraft near the flight, as { key, lat, lon, hdg, type, ... }. */
  setTraffic(list) {
    this.traffic = (Array.isArray(list) ? list : []).filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
    if (this.trafficSelected && !this.traffic.some(p => p.key === this.trafficSelected)) {
      this.trafficSelected = '';
      this.trafficTrail = [];
    }
    this.draw();
  }

  /** The selected aircraft's recorded path, oldest first. */
  setTrafficTrail(points) {
    this.trafficTrail = (Array.isArray(points) ? points : [])
      .filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
    this.draw();
  }

  /** Highlight one target by key; an empty key clears the selection. */
  selectTraffic(key) {
    this.trafficSelected = key ? String(key) : '';
    if (!this.trafficSelected) this.trafficTrail = [];
    this.draw();
  }

  /** Screen-space hit test. Returns { kind, index } or null. */
  hitTest(x, y) {
    const view = this.fit();
    if (!view) return null;
    // Aircraft are the smallest targets, so they are tested before the route.
    if (this.layers.traffic && this.traffic.length) {
      const radius = this.touch || this.options.touchFriendly ? 22 : 14;
      let nearest = null;
      this.traffic.forEach((target, index) => {
        const p = this.project(target.lat, target.lon, view);
        const distance = Math.hypot(p.x - x, p.y - y);
        if (distance <= radius && (!nearest || distance < nearest.distance)) nearest = { index, distance };
      });
      if (nearest) return { kind: 'traffic', index: nearest.index };
    }
    if (!this.route.length) return null;
    const projected = this.route.map((point, index) => ({
      index,
      point,
      ...this.project(point.lat, point.lon, view),
    }));
    const radius = this.touch || this.options.touchFriendly ? 20 : 12;
    let nearest = null;
    for (const node of projected) {
      const distance = Math.hypot(node.x - x, node.y - y);
      if (distance <= radius && (!nearest || distance < nearest.distance)) {
        nearest = { kind: 'waypoint', index: node.index, distance };
      }
    }
    if (nearest) return { kind: nearest.kind, index: nearest.index };
    const segmentRadius = this.touch || this.options.touchFriendly ? 18 : 10;
    let best = null;
    for (let i = 1; i < projected.length; i++) {
      const a = projected[i - 1];
      const b = projected[i];
      const distance = distanceToSegment(x, y, a.x, a.y, b.x, b.y);
      if (distance <= segmentRadius && (!best || distance < best.distance)) {
        best = { kind: 'segment', index: i - 1, distance };
      }
    }
    return best ? { kind: best.kind, index: best.index } : null;
  }

  bindPointer(canvas) {
    if (!this.onSelect && !this.onDragWaypoint) return;
    const pointFromEvent = event => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const view = () => this.fit();

    const move = event => {
      const { x, y } = pointFromEvent(event);
      const active = this.drag;
      if (!active) {
        if (!this.onSelect) return;
        const hit = this.hitTest(x, y);
        canvas.style.cursor = hit
          ? (hit.kind === 'waypoint' && this.onDragWaypoint ? 'grab' : 'pointer')
          : this.onPick ? 'crosshair' : '';
        return;
      }
      if (Math.hypot(x - active.startX, y - active.startY) < 4 && !active.moved) return;
      active.moved = true;
      const currentView = view();
      if (!currentView) return;
      const latlon = this.unproject(x, y, currentView);
      active.lat = latlon.lat;
      active.lon = latlon.lon;
      canvas.style.cursor = 'grabbing';
      // Live preview: the caller owns the route array, so only report the move.
      this.onDragWaypoint(active.index, latlon, { committed: false });
      event.preventDefault();
    };

    const release = () => {
      const active = this.drag;
      this.drag = null;
      canvas.style.cursor = '';
      if (!active) return;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
      if (active.moved && this.onDragWaypoint) {
        this.onDragWaypoint(active.index, { lat: active.lat, lon: active.lon }, { committed: true });
      } else if (this.onSelect) {
        const hit = this.hitTest(active.startX, active.startY);
        this.onSelect(hit ? { kind: hit.kind, index: hit.index } : null);
      }
    };

    canvas.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      const { x, y } = pointFromEvent(event);
      const hit = this.hitTest(x, y);
      if (!hit || hit.kind !== 'waypoint' || !this.onDragWaypoint) return;
      this.drag = { index: hit.index, startX: x, startY: y, moved: false, lat: null, lon: null };
      // Capture keeps the drag alive when the pointer leaves the canvas. It is
      // an enhancement: a browser that refuses it still gets a working drag.
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
    });
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(240, Math.round(rect.width));
    const height = Math.max(180, Math.round(rect.height));
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.draw();
  }

  /**
   * Move the canvas into a container, observing that container for resizes.
   * Used when a screen re-renders its markup: the map keeps its tile cache,
   * view state and listeners instead of being rebuilt on every update.
   */
  attach(container) {
    if (!container || this.canvas.parentElement === container) return;
    container.replaceChildren(this.canvas);
    this.resizeObserver.disconnect();
    this.resizeObserver.observe(container);
    this.resize();
  }

  setTrack(points) {
    this.track = (Array.isArray(points) ? points : []).filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
    this.draw();
  }

  /**
   * Height above the ground for every recorded point, or null when the track
   * carries no altitudes at all (a route preview). AGL is used where the
   * recorder stored it; otherwise the height above the track's own lowest point,
   * which is the departure elevation for a flight recorded from the gate.
   */
  trackHeights() {
    if (!this.track.some(point => Number.isFinite(Number(point.alt)) || Number.isFinite(Number(point.agl)))) return null;
    const alts = this.track.map(point => Number(point.alt)).filter(Number.isFinite);
    const floor = alts.length ? Math.min(...alts) : 0;
    return this.track.map(point => {
      const agl = Number(point.agl);
      if (point.agl != null && Number.isFinite(agl)) return Math.max(0, agl);
      const alt = Number(point.alt);
      return Math.max(0, (Number.isFinite(alt) ? alt : 0) - floor);
    });
  }

  /** Planned route as an ordered list of { lat, lon, id }. */
  setRoute(points) {
    this.route = (Array.isArray(points) ? points : []).filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
    this.draw();
  }

  setPosition(position, heading = null) {
    this.position = position && validLatLon(Number(position.lat), Number(position.lon)) ? position : null;
    this.heading = heading;
    this.draw();
  }

  setLayers(next = {}) {
    this.layers = { ...this.layers, ...next };
    this.draw();
  }

  /** Keep the aircraft centred at a fixed zoom while it moves. */
  setFollow(on) {
    this.follow = Boolean(on);
    this.draw();
  }

  /** Step the zoom by whole levels. Returns the new zoom. */
  zoomBy(delta) {
    if (this.mode === 'globe') {
      this.globeZoom = Math.max(1, Math.min(40, this.globeZoom * (delta > 0 ? 1.5 : 1 / 1.5)));
      this.draw();
      this.options.onViewChange?.({ zoom: true });
      return this.globeZoom;
    }
    const base = this.manualZoom ?? (this.follow ? FOLLOW_ZOOM : this.autoZoom);
    this.manualZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base + delta));
    this.draw();
    // A button zoom moves the view exactly as a wheel zoom does, so the page is
    // told about it: a readout or a radius query has to follow.
    this.options.onViewChange?.({ zoom: true });
    return this.manualZoom;
  }

  /** Return to the automatic fit of the visible geometry. */
  resetZoom() {
    if (this.mode === 'globe') {
      this.globeZoom = 1;
      this.draw();
      return;
    }
    this.manualZoom = null;
    this.draw();
  }

  theme() {
    // A page can own its chart style (a night chart inside a dark app) without
    // changing the document theme the rest of the tracker reads.
    if (this.options.chartTheme === 'day') return 'light';
    if (this.options.chartTheme === 'night') return 'dark';
    return document.documentElement.dataset.theme === 'day' ? 'light' : 'dark';
  }

  /** Screen space a page keeps clear on each side — a route panel, a sheet. */
  insets() {
    const pad = this.options.padding;
    return {
      left: Number(this.options.paddingLeft) || pad,
      right: Number(this.options.paddingRight) || pad,
    };
  }

  fit() {
    const pad = this.options.padding;
    const insets = this.insets();
    // The globe projects through its own camera, so the flat view is only a
    // carrier for the values the shared drawing code reads (label sizes).
    if (this.mode === 'globe') return { zoom: this.manualZoom ?? 7, centerX: 0, centerY: 0 };
    // Geometry is centred in the part of the canvas the page has not covered,
    // so a route panel does not sit on top of the aircraft it is describing.
    const shiftX = (insets.left - insets.right) / 2;
    if (this.follow && this.position) {
      const zoom = this.manualZoom ?? FOLLOW_ZOOM;
      return {
        zoom,
        centerX: lonToX(this.position.lon, zoom) - shiftX / TILE,
        centerY: latToY(this.position.lat, zoom),
      };
    }
    const points = [];
    if (this.layers.track) points.push(...this.track);
    if (this.layers.route) points.push(...this.route);
    if (!points.length && this.position) points.push(this.position);
    if (!points.length) return null;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of points) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const usableWidth = Math.max(60, this.width - insets.left - insets.right);
    const usableHeight = Math.max(60, this.height - pad * 2);
    // A single point has no span to fit: use the tracking zoom rather than
    // zooming all the way in on the aircraft itself.
    if (points.length < 2) {
      const zoom = this.manualZoom ?? FOLLOW_ZOOM;
      return {
        zoom,
        centerX: lonToX(points[0].lon, zoom) - shiftX / TILE,
        centerY: latToY(points[0].lat, zoom),
      };
    }
    let zoom = 3;
    for (let z = MAX_ZOOM; z >= 2; z--) {
      const xSpan = Math.abs(lonToX(maxLon, z) - lonToX(minLon, z)) * TILE;
      const ySpan = Math.abs(latToY(minLat, z) - latToY(maxLat, z)) * TILE;
      if (xSpan <= usableWidth && ySpan <= usableHeight) { zoom = z; break; }
    }
    this.autoZoom = zoom;
    if (this.manualZoom != null) zoom = this.manualZoom;
    const centerX = this.manualCenter
      ? lonToX(this.manualCenter.lon, zoom)
      : (lonToX(minLon, zoom) + lonToX(maxLon, zoom)) / 2 - shiftX / TILE;
    const centerY = this.manualCenter
      ? latToY(this.manualCenter.lat, zoom)
      : (latToY(minLat, zoom) + latToY(maxLat, zoom)) / 2;
    return { zoom, centerX, centerY };
  }

  project(lat, lon, view) {
    if (this.mode === 'globe') return this.globeProject(lat, lon) || { x: NaN, y: NaN };
    return {
      x: this.width / 2 + (lonToX(lon, view.zoom) - view.centerX) * TILE,
      y: this.height / 2 + (latToY(lat, view.zoom) - view.centerY) * TILE,
    };
  }

  unproject(x, y, view) {
    if (this.mode === 'globe') return this.globeUnproject(x, y);
    const worldX = view.centerX + (x - this.width / 2) / TILE;
    const worldY = view.centerY + (y - this.height / 2) / TILE;
    return { lat: yToLat(worldY, view.zoom), lon: xToLon(worldX, view.zoom) };
  }

  /* ── the globe ───────────────────────────────────────────────────────── */

  /** Radius of the sphere on screen, in pixels. */
  globeRadius() {
    return globeRadiusFor(this.width, this.height, this.options.padding, this.globeZoom);
  }

  /**
   * The camera every projection below reads: the place it is aimed at, how big
   * the sphere is drawn, and the middle of the canvas. The arithmetic itself is
   * `lib/globeview.js`, which the tracker's own map draws from as well, so the
   * same coordinate lands in the same place on both maps.
   */
  globeCamera() {
    return cameraFor(this.globeCenter, this.globeRadius(), this.width / 2, this.height / 2);
  }

  /**
   * Orthographic projection: the point is on screen when it faces the camera.
   * Returns null for the far side, which is what cuts every outline at the limb.
   */
  globeProject(lat, lon) {
    return globeProject(lat, lon, this.globeCamera());
  }

  /** The inverse orthographic projection, or null outside the disc. */
  globeUnproject(x, y) {
    return globeUnproject(x, y, this.globeCamera());
  }

  /**
   * The middle of the route, used to open the globe over the plan: the mean of
   * the points as unit vectors, so a route across the date line has a sensible
   * centre instead of an average of -179 and +179.
   */
  routeCentre() {
    return vectorMeanCentre(this.route);
  }

  /**
   * The bundled coastlines, loaded only when a globe is first asked for. Stratos
   * ships Natural Earth 1:110m country outlines as a plain script for the
   * tracker; the globe reads the same public-domain data. Without it the globe
   * still draws its graticule, route and points — it never invents a coastline.
   */
  loadGlobeLand() {
    if (typeof window === 'undefined' || typeof document === 'undefined'
      || typeof document.createElement !== 'function') {
      this.globeLandState = 'unavailable';
      return Promise.resolve(null);
    }
    if (window.STRATOS_WORLD) { this.globeLandState = 'ready'; return Promise.resolve(window.STRATOS_WORLD); }
    if (this.globeLandPromise) return this.globeLandPromise;
    this.globeLandState = 'loading';
    this.globeLandPromise = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = new URL('data/world.js', import.meta.url).href;
      script.async = true;
      script.onload = () => {
        this.globeLandState = window.STRATOS_WORLD ? 'ready' : 'unavailable';
        resolve(window.STRATOS_WORLD || null);
        this.draw();
      };
      script.onerror = () => { this.globeLandState = 'unavailable'; resolve(null); this.draw(); };
      document.head.appendChild(script);
    });
    return this.globeLandPromise;
  }

  /**
   * Every country outline, as unit vectors on the sphere so the horizon test is
   * a sign check. Only a non-empty list is cached: the world script is loaded on
   * demand, and an empty list cached before it arrives would leave the globe bare
   * for the rest of the session.
   */
  globeRings() {
    if (this.globeRingsCache) return this.globeRingsCache;
    const world = typeof window !== 'undefined' ? window.STRATOS_WORLD : null;
    const rings = [];
    for (const country of (world && world.countries) || []) {
      for (const flat of country.p || []) {
        if (!flat || flat.length < 6) continue;
        const ring = [];
        for (let i = 0; i < flat.length; i += 2) ring.push(unitVector(flat[i + 1], flat[i]));
        rings.push(ring);
      }
    }
    if (rings.length) this.globeRingsCache = rings;
    return rings;
  }

  /** The unit vector pointing at the camera: the centre of the visible face. */
  cameraDirection() {
    return cameraDirection(this.globeCenter);
  }

  /** A unit vector on the sphere, on screen. Null when it is on the far side. */
  globeProjectVector(v) {
    return globeProjectVector(v, this.globeCamera());
  }

  /** A ring of unit vectors clipped to the visible hemisphere, horizon walked. */
  clipToHemisphere(ring, camera = this.cameraDirection()) {
    return clipToHemisphere(ring, camera);
  }

  /** Flat chart or globe. The place in view is kept across the switch. */
  setMode(mode) {
    const next = mode === 'globe' ? 'globe' : 'plane';
    if (next === this.mode) return this.mode;
    const here = this.mode === 'globe' ? this.globeCenter : this.viewCenter();
    this.mode = next;
    if (next === 'globe') {
      this.globeCenter = here || this.routeCentre() || { lat: 40, lon: -95 };
      this.globeZoom = 1;
      this.loadGlobeLand();
    } else if (here) {
      this.manualCenter = { ...here };
    }
    this.draw();
    this.options.onViewChange?.({ mode: true });
    return this.mode;
  }

  /** Frame the whole route on the globe. */
  globeFit() {
    const centre = this.routeCentre();
    if (!centre) { this.globeZoom = 1; return; }
    this.globeCenter = centre;
    const farthest = Math.max(...this.route.map(point => distanceNm(centre, point)), 1);
    const theta = Math.min(Math.PI / 2.05, (farthest / 60) * DEG);
    this.globeZoom = Math.max(1, Math.min(40, 0.8 / Math.max(0.02, Math.sin(theta))));
  }

  /* ── imagery and terrain ─────────────────────────────────────────────── */

  /**
   * The tile store for the globe, built the first time a style needs one. An
   * outlines globe never builds it: no request is made and no decoder is made
   * for a pilot who never leaves the vector chart.
   */
  earthView() {
    if (!this.earth) {
      this.earth = new EarthView({
        style: this.globeStyleId,
        onTiles: () => this.scheduleGlobeRedraw(),
      });
    }
    return this.earth;
  }

  /** Which surface the globe is painted with: outlines, imagery, relief or elevation. */
  setGlobeStyle(id) {
    const style = earthStyle(id);
    if (style.id === this.globeStyleId) return this.globeStyleId;
    this.globeStyleId = style.id;
    this.globeRasterCache = null;
    if (style.source) this.earthView().setStyle(style.id);
    else if (this.earth) this.earth.setStyle(style.id);
    this.draw();
    this.options.onViewChange?.({ globeStyle: true });
    return this.globeStyleId;
  }

  /**
   * Read terrain elevations around the centre without changing what is drawn,
   * so an outlines globe can still answer how high the ground is here.
   */
  readTerrain() {
    const center = this.globeCenter || this.viewCenter();
    if (!center) return null;
    const view = this.earthView();
    const size = Math.max(48, Math.min(this.globeRasterCap(), Math.round(this.globeRadius() * 2)));
    view.readTerrain(center.lat, center.lon, { radiusNm: this.rangeNm, rasterPx: size });
    return view;
  }

  /** Centre the globe on the route again, at the zoom that frames it. */
  globeReset() {
    this.globeCenter = this.routeCentre() || { lat: 40, lon: -95 };
    this.globeZoom = 1;
    this.globeRasterCache = null;
    this.draw();
    this.options.onViewChange?.({ globeReset: true });
  }

  /**
   * Tile arrivals are coalesced into one redraw. A globe filling in twenty
   * tiles would otherwise redraw twenty times in a second, and every one of
   * those redraws is a full pass of the projection.
   */
  scheduleGlobeRedraw() {
    if (this.globeRedrawTimer) return;
    this.globeRedrawTimer = setTimeout(() => {
      this.globeRedrawTimer = 0;
      this.globeRasterCache = null;
      this.draw();
    }, 200);
  }

  /**
   * The raster is built at a bounded resolution, and a coarser one while the
   * globe is being turned: the pilot is watching geography move, not reading
   * pixels, and a 168-pixel hemisphere is a quarter of the work of a 320-pixel
   * one. While tiles are still arriving the middle size is used as well, because
   * the pass will be repeated the moment they land and paying full price twice
   * for the same picture is the whole cost of the feature.
   */
  globeRasterCap() {
    if (performance.now() - this.globeMovedAt < 240) return 168;
    if (this.earth && this.earth.stats().waiting > 0) return 224;
    return 320;
  }

  /** The canvas the finished raster is blitted from, reused across frames. */
  rasterCanvas(size) {
    if (this.rasterHost && this.rasterHost.width === size) return this.rasterHost;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    this.rasterHost = canvas;
    return canvas;
  }

  /**
   * Real imagery or real terrain, painted through the inverse orthographic
   * projection: one output pixel at a time, each asking the tile store what
   * colour the earth is at that coordinate.
   *
   * Returns false when the raster cannot carry the globe yet — nothing loaded,
   * or so little of the visible face is read that the shapes would be missing
   * rather than coarse. The caller draws the bundled outlines instead, and the
   * readout reports what is still on its way.
   */
  drawGlobeRaster(radius) {
    const style = earthStyle(this.globeStyleId);
    if (!style.source) { this.globeRasterCache = null; return false; }
    const center = this.globeCenter || { lat: 0, lon: 0 };
    const view = this.earthView();
    if (view.styleId !== style.id) view.setStyle(style.id);
    const size = Math.max(48, Math.min(this.globeRasterCap(), Math.round(radius * 2)));
    // The levels are chosen from how many pixels the sphere is actually drawn
    // with, not from how large it is on the screen.
    view.setResolution(size);
    view.ensureAround(center.lat, center.lon, size);
    const key = `${style.id}|${size}|${center.lat.toFixed(3)}|${center.lon.toFixed(3)}|${view.readyCount()}`;
    if (!this.globeRasterCache || this.globeRasterCache.key !== key) {
      this.globeRasterCache = { key, ...this.buildGlobeRaster(view, center, size) };
    }
    const raster = this.globeRasterCache;
    if (!raster || !raster.image || raster.share < 0.35) return false;
    const host = this.rasterCanvas(size);
    if (!host) return false;
    host.getContext('2d').putImageData(raster.image, 0, 0);
    const ctx = this.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(host, this.width / 2 - radius, this.height / 2 - radius, radius * 2, radius * 2);
    ctx.restore();
    return true;
  }

  /**
   * One pass of the inverse projection into this globe's own ImageData. The
   * arithmetic — including the camera-vector form that keeps a turn of the
   * sphere off the transcendentals — is `lib/globeview.js`, shared with the
   * tracker's map so both spheres are painted by the same code.
   */
  buildGlobeRaster(view, center, size) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return { image: null, share: 0 };
    const host = document.createElement('canvas');
    host.width = size;
    host.height = size;
    const image = host.getContext('2d').createImageData(size, size);
    const light = this.theme() === 'light';
    const base = light ? [214, 228, 240] : [10, 22, 34];
    const stats = rasteriseGlobe({
      size,
      center,
      base,
      data: image.data,
      sample: (lat, lon, out) => view.sample(lat, lon, out),
    });
    return { image, ...stats };
  }

  /** Who supplied what is on the globe, written on the globe. */
  drawGlobeCredit(radius) {
    const style = earthStyle(this.globeStyleId);
    if (!style.source) return;
    const ctx = this.ctx;
    const text = style.source === 'nasa'
      ? 'Imagery: NASA Earth Observatory Blue Marble · NASA GIBS/ESDIS'
      : 'Terrain: AWS Open Data Terrain Tiles (Mapzen) · 3DEP/SRTM/GMTED2010/ETOPO1';
    ctx.save();
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(text).width;
    const x = this.width / 2;
    const y = Math.min(this.height / 2 + radius * 0.84, this.height / 2 + radius - 7);
    ctx.fillStyle = 'rgba(2, 6, 12, .58)';
    ctx.fillRect(x - width / 2 - 6, y - 7, width + 12, 14);
    ctx.fillStyle = 'rgba(233, 242, 250, .92)';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** Ocean, coastlines and a graticule, all from real data or from geometry. */
  drawGlobe() {
    const ctx = this.ctx;
    const light = this.theme() === 'light';
    const cx = this.width / 2;
    const cy = this.height / 2;
    const radius = this.globeRadius();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = light ? '#dce8f2' : '#081420';
    ctx.fill();
    ctx.save();
    ctx.clip();
    // Real imagery or real terrain when the pilot asked for it and enough of
    // the visible face has arrived; the bundled outlines otherwise.
    if (!this.drawGlobeRaster(radius)) this.drawCoastlines();
    this.drawGraticule();
    this.drawGlobeCredit(radius);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = light ? 'rgba(15,23,42,.35)' : 'rgba(148,178,205,.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  /** Country outlines: land filled and coastlines stroked, clipped to the disc. */
  drawCoastlines() {
    const rings = this.globeRings();
    if (!rings.length) return;
    const ctx = this.ctx;
    const light = this.theme() === 'light';
    const land = light ? '#c3d5e3' : '#152838';
    ctx.lineJoin = 'round';
    for (const ring of rings) {
      const clipped = this.clipToHemisphere(ring);
      if (clipped.length < 3) continue;
      ctx.beginPath();
      let started = false;
      for (const vertex of clipped) {
        const point = this.globeProjectVector(vertex);
        if (!point) { started = false; continue; }
        if (started) ctx.lineTo(point.x, point.y);
        else { ctx.moveTo(point.x, point.y); started = true; }
      }
      if (!started) continue;
      ctx.closePath();
      // The cut runs along the limb, so the closed loop is the visible part of
      // the land and filling it paints only land.
      ctx.fillStyle = land;
      ctx.fill();
      ctx.strokeStyle = light ? 'rgba(30,58,84,.5)' : 'rgba(126,178,214,.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  /** Meridians and parallels every 15 degrees, cut at the limb. */
  drawGraticule() {
    const ctx = this.ctx;
    const light = this.theme() === 'light';
    ctx.strokeStyle = light ? 'rgba(30,58,84,.16)' : 'rgba(126,178,214,.15)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const gap = this.globeRadius() * 0.35;
    for (let lon = -180; lon < 180; lon += 15) {
      let pen = false;
      let last = null;
      for (let lat = -88; lat <= 88; lat += 2) {
        const point = this.globeProject(lat, lon);
        if (!point || (pen && last && Math.hypot(point.x - last.x, point.y - last.y) > gap)) {
          pen = false;
          if (!point) continue;
        }
        if (pen) ctx.lineTo(point.x, point.y);
        else { ctx.moveTo(point.x, point.y); pen = true; }
        last = point;
      }
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      let pen = false;
      let last = null;
      for (let lon = -180; lon <= 180; lon += 3) {
        const point = this.globeProject(lat, lon);
        if (!point || (pen && last && Math.hypot(point.x - last.x, point.y - last.y) > gap)) {
          pen = false;
          if (!point) continue;
        }
        if (pen) ctx.lineTo(point.x, point.y);
        else { ctx.moveTo(point.x, point.y); pen = true; }
        last = point;
      }
    }
    ctx.stroke();
    // The equator reads a little stronger than the rest of the graticule.
    ctx.beginPath();
    let pen = false;
    let last = null;
    for (let lon = -180; lon <= 180; lon += 3) {
      const point = this.globeProject(0, lon);
      if (!point || (pen && last && Math.hypot(point.x - last.x, point.y - last.y) > gap)) {
        pen = false;
        if (!point) continue;
      }
      if (pen) ctx.lineTo(point.x, point.y);
      else { ctx.moveTo(point.x, point.y); pen = true; }
      last = point;
    }
    ctx.strokeStyle = light ? 'rgba(30,58,84,.3)' : 'rgba(126,178,214,.28)';
    ctx.stroke();
  }

  tile(url) {
    let entry = this.tiles.get(url);
    if (entry) return entry;
    entry = { image: new Image(), loaded: false, failed: false };
    entry.image.onload = () => { entry.loaded = true; this.onTileLoad(); };
    entry.image.onerror = () => { entry.failed = true; this.failedTiles++; };
    entry.image.src = url;
    this.tiles.set(url, entry);
    if (this.tiles.size > TILE_LIMIT) this.tiles.delete(this.tiles.keys().next().value);
    return entry;
  }

  drawTiles(view) {
    const z = Math.min(16, Math.round(view.zoom));
    const scale = 2 ** (view.zoom - z);
    const tileSize = TILE * scale;
    const halfW = this.width / 2, halfH = this.height / 2;
    const left = view.centerX * TILE - halfW;
    const top = view.centerY * TILE - halfH;
    const style = this.theme();
    const service = style === 'dark' ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
    const x0 = Math.floor(left / tileSize);
    const x1 = Math.floor((left + this.width) / tileSize);
    const y0 = Math.floor(top / tileSize);
    const y1 = Math.floor((top + this.height) / tileSize);
    const max = 2 ** z;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= max) continue;
      for (let x = x0; x <= x1; x++) {
        const wrapped = ((x % max) + max) % max;
        const entry = this.tile(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${service}/MapServer/tile/${z}/${y}/${wrapped}`);
        const sx = x * tileSize - left;
        const sy = y * tileSize - top;
        if (entry.loaded) {
          this.ctx.drawImage(entry.image, sx, sy, tileSize + 0.5, tileSize + 0.5);
        }
      }
    }
  }

  /**
   * The geographic centre of what is on screen. This is the point every radius
   * query and every "distance from the centre" readout is measured from, and it
   * is the view's centre — not the aircraft's position — so the map is useful
   * with no simulator running at all.
   */
  viewCenter(view = this.fit()) {
    if (this.mode === 'globe') return this.globeCenter;
    if (!view) return null;
    return this.unproject(this.width / 2, this.height / 2, view);
  }

  /** How much of the world is on screen, in nautical miles across the short side. */
  viewSpanNm(view = this.fit()) {
    if (this.mode === 'globe') {
      // Exact at the centre of an orthographic view: one radian of arc spans
      // `globeRadius()` pixels there.
      const radius = this.globeRadius();
      if (!radius) return null;
      const across = Math.min(this.width, this.height);
      return (across / radius) * (60 * 180 / Math.PI);
    }
    if (!view) return null;
    const inset = this.insets();
    const left = this.unproject(inset.left, this.height / 2, view);
    const right = this.unproject(this.width - inset.right, this.height / 2, view);
    const top = this.unproject(this.width / 2, this.options.padding, view);
    const bottom = this.unproject(this.width / 2, this.height - this.options.padding, view);
    return Math.max(distanceNm(left, right), distanceNm(top, bottom)) || 0;
  }

  /** Real navigation points to draw, and what the query that produced them covered. */
  setNavPoints(points, meta = null) {
    this.navPoints = Array.isArray(points) ? points : [];
    this.navMeta = meta || null;
    this.draw();
  }

  setRange(nm) {
    const value = Number(nm);
    if (Number.isFinite(value) && value > 0) this.rangeNm = value;
    this.draw();
  }

  /**
   * The radius ring. Built from real geodesic destinations on the circle, so it
   * is the same physical size at every latitude: a pixel circle would be a
   * different distance at 60 N than at the equator.
   */
  drawRange(view) {
    if (!this.layers.range || !this.showRange) return;
    const center = this.viewCenter(view);
    if (!center) return;
    const ctx = this.ctx;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#79c9bb';
    ctx.save();
    ctx.beginPath();
    const steps = 180;
    for (let i = 0; i <= steps; i += 1) {
      const ring = destination(center, (i / steps) * 360, this.rangeNm);
      const p = this.project(ring.lat, ring.lon, view);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const label = `${this.rangeNm >= 100 ? Math.round(this.rangeNm) : this.rangeNm} NM`;
    const top = this.project(destination(center, 0, this.rangeNm).lat, destination(center, 0, this.rangeNm).lon, view);
    ctx.font = '600 10px system-ui, sans-serif';
    const width = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(4,9,15,.78)';
    ctx.fillRect(top.x - width / 2 - 6, top.y - 17, width + 12, 14);
    ctx.fillStyle = accent;
    ctx.textAlign = 'center';
    ctx.fillText(label, top.x, top.y - 7);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /**
   * The chart's own scale: a bar whose label is the real distance it spans at
   * the current zoom and latitude. Measured through the same geodesic helper the
   * route uses, so a bar labelled 20 NM is 20 NM on the ground.
   */
  drawScale(view) {
    if (!this.layers.scale || !this.showScale) return;
    const center = this.viewCenter(view);
    if (!center) return;
    const ctx = this.ctx;
    const y = this.height - 26;
    const inset = this.insets();
    const startX = Math.max(12, inset.left + 6);
    const probePx = 120;
    // On the globe the scale at the centre of an orthographic view is exact in
    // closed form: one radian of arc spans `globeRadius()` pixels there.
    const nmPerPx = this.mode === 'globe'
      ? (60 * 180 / Math.PI) / this.globeRadius()
      : distanceNm(center, this.unproject(startX + probePx, y, view)) / probePx;
    if (!(nmPerPx > 0)) return;
    // A ladder of readings a pilot recognises, chosen so the bar stays legible.
    const ladder = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    let nm = ladder[0];
    for (const step of ladder) {
      if (step / nmPerPx <= 150) nm = step;
      else break;
    }
    const barPx = nm / nmPerPx;
    if (!(barPx > 12)) return;

    ctx.save();
    ctx.font = '600 10px system-ui, sans-serif';
    const label = nm >= 1 ? `${nm} NM` : `${nm * 1000} m`;
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(4,9,15,.72)';
    ctx.fillRect(startX - 5, y - 22, Math.max(barPx, textWidth) + 14, 24);
    ctx.strokeStyle = 'rgba(233,242,252,.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(startX, y - 6);
    ctx.lineTo(startX + barPx, y - 6);
    ctx.moveTo(startX, y - 11);
    ctx.lineTo(startX, y - 1);
    ctx.moveTo(startX + barPx, y - 11);
    ctx.lineTo(startX + barPx, y - 1);
    ctx.stroke();
    ctx.fillStyle = '#e9f2fc';
    ctx.fillText(label, startX, y - 16);
    ctx.restore();
  }

  /**
   * The real points around the view. Airports and navaids are always drawn: a
   * pilot needs the ground references before anything else. Published fixes
   * appear as the chart gets local, and the number of labels is capped by what
   * fits, nearest first — the cap is a drawing decision, and it never removes a
   * point from the page's own search, which asks the same index for every
   * record inside the radius.
   */
  drawNavPoints(view) {
    if (!this.layers.nav || !this.navPoints.length) return;
    const ctx = this.ctx;
    const span = this.viewSpanNm(view);
    const routeIds = new Set(this.route.map(point => String(point.id || '').toUpperCase()));
    const inset = this.insets();
    const onScreen = point => {
      const p = this.project(point.lat, point.lon, view);
      return p.x > inset.left - 40 && p.x < this.width + 40 && p.y > -40 && p.y < this.height + 40 ? p : null;
    };
    // How many fix labels the chart can carry without becoming a wall of text.
    const fixBudget = span == null ? 0 : span > 900 ? 0 : span > 400 ? 24 : span > 160 ? 60 : 110;
    const placed = [];
    const fits = (x, y, width) => {
      const box = { x: x - 3, y: y - 11, w: width + 6, h: 14 };
      for (const other of placed) {
        if (box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y) return false;
      }
      placed.push(box);
      return true;
    };

    const ordered = [...this.navPoints].sort((a, b) => {
      const rank = point => (routeIds.has(String(point.id || '').toUpperCase()) ? 0 : point.kind === 'apt' ? 1 : point.kind === 'nav' ? 2 : 3);
      return rank(a) - rank(b) || (a.distanceNm || 0) - (b.distanceNm || 0);
    });
    let fixesDrawn = 0;
    let hidden = 0;

    for (const point of ordered) {
      const isRoute = routeIds.has(String(point.id || '').toUpperCase());
      const isFix = point.kind === 'fix' && !isRoute;
      if (isFix && fixesDrawn >= fixBudget) { hidden += 1; continue; }
      const p = onScreen(point);
      if (!p) continue;
      if (isFix) fixesDrawn += 1;
      ctx.save();
      drawNavPoint(ctx, p.x, p.y, {
        kind: point.kind,
        accent: '#22d3ee',
        end: point.kind === 'apt' ? null : null,
        invert: this.theme() === 'light',
      });
      ctx.restore();
      const label = String(point.id || '');
      ctx.font = isFix ? '600 9.5px system-ui, sans-serif' : '600 10.5px system-ui, sans-serif';
      const width = ctx.measureText(label).width;
      if (fits(p.x + 8, p.y + 3.5, width)) {
        ctx.fillStyle = 'rgba(4,9,15,.6)';
        ctx.fillRect(p.x + 6, p.y - 6, width + 5, 12);
        ctx.fillStyle = this.theme() === 'light' ? '#0f172a' : '#cfe9f5';
        ctx.fillText(label, p.x + 8, p.y + 3.5);
      } else {
        hidden += 1;
      }
    }
    this.navLabelState = { drawn: ordered.length - hidden, hidden, fixesDrawn, fixBudget };
  }

  drawRoute(view) {
    const ctx = this.ctx;
    const drag = this.drag && this.drag.moved && this.drag.lat != null ? this.drag : null;
    const points = this.route.map((p, index) => {
      const live = drag && drag.index === index ? { lat: drag.lat, lon: drag.lon } : p;
      return { ...this.project(live.lat, live.lon, view), id: p.id || '', index };
    });
    if (!points.length) return;
    const { segmentIndex, waypointIndex } = this.selection;
    const highlighted = new Set(this.selection.segments || []);
    if (segmentIndex != null) highlighted.add(segmentIndex);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#79c9bb';
    if (points.length > 1) {
      ctx.lineJoin = 'round';
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.strokeStyle = '#9bb7ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // Selected legs are drawn on top with a wider underlay so they read at a
      // glance on both map styles.
      for (const legIndex of highlighted) {
        const a = points[legIndex];
        const b = points[legIndex + 1];
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = accent;
        ctx.lineWidth = legIndex === segmentIndex ? 4 : 3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // Waypoint markers; labels only when the route is short enough to read.
    const labels = points.length <= 30;
    points.forEach((p, i) => {
      const origin = i === 0;
      const destination = i === points.length - 1;
      const end = origin || destination;
      const active = waypointIndex === i || (drag && drag.index === i);
      const radius = active ? 7 : end ? 5 : 3;
      if (active) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(121,201,187,.24)';
        ctx.fill();
      }
      // Route ends use distinct airport-style markers; en-route fixes remain
      // small numbered dots so dense routes stay readable.
      if (origin || destination) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
        ctx.fillStyle = origin ? '#34d399' : '#f17b89';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#07131a';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = active ? accent : '#9bb7ff';
        ctx.fill();
      }
      if (active) {
        ctx.strokeStyle = '#06121a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (labels && p.id && (end || active || points.length <= 12)) {
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.fillStyle = '#e7f0f2';
        ctx.fillText(p.id, p.x + 10, p.y - 8);
      }
    });
  }

  /**
   * The planned route drawn the way a chart draws it: a bright route line over a
   * dark underlay, a shape per point type, leg distances along the legs, and the
   * part already flown dimmed behind the aircraft. Labels are placed through one
   * collision list, so a dense arrival loses labels instead of turning into a
   * block of overlapping text.
   */
  drawNavRoute(view) {
    const ctx = this.ctx;
    if (!this.route.length) return;
    const points = this.route.map((point, index) => ({
      ...this.project(point.lat, point.lon, view),
      point,
      index,
    }));
    const accent = this.options.accent || '#22d3ee';
    const state = this.routeState || {};
    const passed = Number.isInteger(state.passedIndex) ? state.passedIndex : -1;
    const nextIndex = Number.isInteger(state.nextIndex) ? state.nextIndex : -1;
    const selectedWp = this.selection.waypointIndex;
    const segments = Array.isArray(this.selection.segments) ? this.selection.segments : [];
    const selectedLeg = this.selection.segmentIndex != null ? this.selection.segmentIndex : null;
    const invert = this.theme() === 'light';
    const ink = invert ? 'rgba(30, 41, 59, .95)' : 'rgba(198, 214, 242, .95)';
    const flown = invert ? 'rgba(100, 116, 139, .5)' : 'rgba(148, 170, 200, .4)';

    const line = (a, b, width, color, dash) => {
      ctx.save();
      ctx.setLineDash(dash || []);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const isFlown = passed >= 0 && i < passed;
      line(a, b, 4.4, 'rgba(0, 0, 0, .45)');
      line(a, b, isFlown ? 1.6 : 2.2, isFlown ? flown : ink, isFlown ? [4, 4] : []);
    }

    // The leg under the aircraft, then a selected leg on top of the plan.
    if (passed >= 0 && points[passed] && points[passed + 1]) {
      line(points[passed], points[passed + 1], 3.4, accent);
    }
    for (const legIndex of new Set([selectedLeg, ...segments])) {
      if (legIndex == null || !points[legIndex] || !points[legIndex + 1]) continue;
      line(points[legIndex], points[legIndex + 1], 8, 'rgba(0, 0, 0, .35)');
      line(points[legIndex], points[legIndex + 1], 3.6, accent);
    }

    points.forEach(node => {
      const end = node.index === 0 ? 'origin' : node.index === points.length - 1 ? 'destination' : '';
      drawNavPoint(ctx, node.x, node.y, {
        kind: end || node.point.kind === 'apt' ? 'apt' : node.point.kind === 'nav' ? 'nav' : 'fix',
        accent,
        end,
        isNext: node.index === nextIndex,
        active: node.index === selectedWp,
        invert,
      });
    });

    /* Labels share one list of occupied boxes. Endpoints, the next waypoint and
       the selected one are placed first so they always survive. */
    const taken = [];
    // The aircraft and its level label are already drawn, so the route keeps
    // clear of them instead of stacking text under the wing.
    if (this.position) {
      const own = this.project(this.position.lat, this.position.lon, view);
      taken.push({ x: own.x - 13, y: own.y - 13, w: 26, h: 26 });
      if (this.options.ownLabel) {
        ctx.save();
        ctx.font = '600 11px system-ui, sans-serif';
        const ownWidth = ctx.measureText(this.options.ownLabel).width;
        ctx.restore();
        taken.push({ x: own.x + 16, y: own.y - 9, w: ownWidth + 12, h: 18 });
      }
    }
    const place = (text, x, y, color, font = '600 10px system-ui, sans-serif') => {
      if (!text) return false;
      ctx.save();
      ctx.font = font;
      const width = ctx.measureText(text).width;
      const box = { x: x - 2, y: y - 11, w: width + 4, h: 13 };
      const clash = taken.some(other => !(box.x + box.w < other.x || other.x + other.w < box.x
        || box.y + box.h < other.y || other.y + other.h < box.y));
      if (clash) { ctx.restore(); return false; }
      taken.push(box);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = invert ? 'rgba(255, 255, 255, .88)' : 'rgba(3, 7, 12, .85)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
      return true;
    };

    const important = [];
    const rest = [];
    points.forEach(node => {
      const end = node.index === 0 || node.index === points.length - 1;
      const priority = end || node.index === nextIndex || node.index === selectedWp;
      (priority ? important : rest).push(node);
    });

    const labelFor = node => {
      const isFlown = passed >= 0 && node.index < passed;
      const color = isFlown ? flown : (invert ? '#0b1220' : '#eaf3ff');
      if (place(String(node.point.id || ''), node.x + 9, node.y - 7, color)) {
        const alt = Number(node.point.altFt);
        if (Number.isFinite(alt) && alt > 0 && (node.index === nextIndex || node.index === selectedWp || node.index === 0)) {
          place(`FL${String(Math.round(alt / 100)).padStart(3, '0')}`, node.x + 9, node.y + 5, isFlown ? flown : accent, '600 9px system-ui, sans-serif');
        }
      }
    };
    important.forEach(labelFor);
    // Enroute points label themselves once the chart is readable; below that
    // every other label would collide anyway.
    if (points.length <= 16 || (this.manualZoom ?? view.zoom) >= 6) rest.forEach(labelFor);

    if (this.options.legLabels === false) return;
    for (let i = 0; i < points.length - 1; i += 1) {
      const nm = Number(points[i].point.legNm);
      if (!Number.isFinite(nm) || nm <= 0) continue;
      if (points.length > 30 && i !== selectedLeg && i !== passed && i !== nextIndex - 1) continue;
      const a = points[i];
      const b = points[i + 1];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const offset = 9;
      place(`${Math.round(nm)} nm`, mx + (-(b.y - a.y) / length) * offset, my + ((b.x - a.x) / length) * offset + 2,
        invert ? 'rgba(51, 65, 85, .9)' : 'rgba(178, 197, 224, .92)', '600 9px system-ui, sans-serif');
    }
  }

  draw() {
    if (!this.ctx || !this.width) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--land').trim() || '#10242e';
    const text = styles.getPropertyValue('--txt').trim() || '#e7f0f2';
    const accent = styles.getPropertyValue('--acc').trim() || '#79c9bb';
    const mut = styles.getPropertyValue('--mut').trim() || '#91a8b1';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const view = this.fit();
    if (!view) {
      ctx.fillStyle = mut;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No recorded positions to display', this.width / 2, this.height / 2);
      ctx.textAlign = 'left';
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();
    if (this.mode === 'globe') {
      this.drawGlobe();
    } else if (this.layers.tiles) {
      this.drawTiles(view);
    }
    // A page that wants a night chart over the same tiles dims them here rather
    // than filtering the canvas, so the route and the aircraft keep their own
    // contrast. Only drawn when the page asks for it.
    if (this.mode !== 'globe' && this.layers.tiles && this.options.tint) {
      ctx.fillStyle = this.options.tint;
      ctx.fillRect(0, 0, this.width, this.height);
    }
    // Vignette while tiles load, so gaps are not mistaken for terrain.
    if (this.mode !== 'globe' && this.layers.tiles && !this.track.length && this.failedTiles > 4) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // The radius ring belongs under everything else: it is a reference, not a
    // feature of the flight.
    if (this.layers.range) this.drawRange(view);
    if (this.layers.nav) this.drawNavPoints(view);

    if (this.layers.route) {
      if (this.options.routeStyle === 'nav') this.drawNavRoute(view);
      else this.drawRoute(view);
    }

    const positions = this.layers.track ? this.track.map(p => this.project(p.lat, p.lon, view)) : [];
    if (positions.length > 1) {
      /* The line is drawn through rounded corners so a turn looks like a turn
         rather than a kink at the sample rate; the recorded points themselves
         are unchanged and still marked below. */
      const heights = this.trackHeights();
      const line = smoothPath(
        positions.map(p => [p.x, p.y]),
        heights || null,
        { passes: 2, maxPoints: 2400 },
      );
      const linePoints = line.points;
      const lineHeights = heights ? (line.heights.length ? line.heights : heights) : null;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      linePoints.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      /* A recorded flight is coloured by height above the ground, the same ramp
         the desktop map uses: white on the ground, then up through blue, green,
         yellow and orange to magenta. A track without altitudes — a route
         preview — keeps the plain accent line. */
      ctx.lineWidth = 2.5;
      if (lineHeights) {
        const inks = lineHeights.map(trailInk);
        let start = 0;
        let ink = inks[0];
        const run = (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i += 1) {
            const p = linePoints[i];
            i === from ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]);
          }
          ctx.strokeStyle = ink;
          ctx.stroke();
        };
        for (let i = 1; i < inks.length; i += 1) {
          if (inks[i] !== ink) { run(start, i); start = i; ink = inks[i]; }
        }
        run(start, inks.length - 1);
      } else {
        ctx.strokeStyle = accent;
        ctx.beginPath();
        linePoints.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }

      // Recorded sample dots (not interpolated) so recorded data is visible.
      if (this.track.length <= 400) {
        this.track.forEach((point, index) => {
          ctx.fillStyle = heights ? trailInk(heights[index]) : accent;
          const p = positions[index];
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      const start = positions[0];
      const end = positions[positions.length - 1];
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(start.x, start.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f17b89';
      ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fill();
    }

    /* Other aircraft, after your own path so both stay readable. The selected
       one keeps its recorded trail, drawn in the same altitude ramp as your own
       flight; the others are small heading glyphs. */
    if (this.layers.traffic && this.traffic.length) {
      const selected = this.traffic.find(target => target.key === this.trafficSelected);
      if (selected && this.trafficTrail.length > 1) {
        const heights = this.trafficTrail.map(point => {
          const value = Number(point.alt);
          return Number.isFinite(value) ? Math.max(0, value) : 0;
        });
        const inks = heights.map(trailInk);
        const path = this.trafficTrail.map(point => this.project(point.lat, point.lon, view));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.lineWidth = 5;
        ctx.stroke();
        let start = 0;
        let ink = inks[0];
        const run = (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i += 1) {
            i === from ? ctx.moveTo(path[i].x, path[i].y) : ctx.lineTo(path[i].x, path[i].y);
          }
          ctx.strokeStyle = ink;
          ctx.lineWidth = 3;
          ctx.stroke();
        };
        for (let i = 1; i < inks.length; i += 1) {
          if (inks[i] !== ink) { run(start, i); start = i; ink = inks[i]; }
        }
        run(start, inks.length - 1);
      }
      // The selected aircraft is painted last so no neighbour can cover it.
      const ordered = this.traffic
        .map((target, index) => ({ target, index }))
        .sort((a, b) => Number(a.target.key === this.trafficSelected) - Number(b.target.key === this.trafficSelected) || a.index - b.index);
      for (const { target } of ordered) {
        const p = this.project(target.lat, target.lon, view);
        if (p.x < -20 || p.x > this.width + 20 || p.y < -20 || p.y > this.height + 20) continue;
        const active = target.key === this.trafficSelected;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((Number(target.hdg) || 0) * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(4.5, 5);
        ctx.lineTo(0, 2.5);
        ctx.lineTo(-4.5, 5);
        ctx.closePath();
        ctx.fillStyle = active ? '#ffffff' : (this.theme() === 'light' ? '#1d4ed8' : '#8fb8ff');
        ctx.fill();
        ctx.restore();
        if (active) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.font = '600 11px system-ui, sans-serif';
          ctx.fillStyle = text;
          ctx.fillText(String(target.id || ''), p.x + 13, p.y + 4);
        }
      }
    }

    if (this.position) {
      const p = this.project(this.position.lat, this.position.lon, view);
      if (this.options.ownSymbol === 'aircraft') {
        drawAircraftSymbol(ctx, p, this.heading, this.options.ownLabel);
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((this.heading || 0) * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -11);
        ctx.lineTo(7, 8);
        ctx.lineTo(0, 4);
        ctx.lineTo(-7, 8);
        ctx.closePath();
        ctx.fillStyle = '#f2b65f';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();

    // The scale bar is drawn after the clip is released so it sits over the
    // chart's edge rather than being cut by it.
    if (this.layers.scale) this.drawScale(view);

    if (this.options.attribution && this.layers.tiles) {
      const label = '© Esri, HERE, Garmin · © OpenStreetMap contributors';
      ctx.font = '10px system-ui, sans-serif';
      const width = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(this.width - width - 10, this.height - 18, width + 8, 14);
      ctx.fillStyle = text;
      ctx.fillText(label, this.width - width - 6, this.height - 7);
    }
  }

  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // A click follows a drag; the drag was a pan, not a selection.
    if (this.options.pannable && Date.now() - this.panMovedAt < 260) return;
    if (this.onSelect) {
      const hit = this.hitTest(x, y);
      if (hit) { this.onSelect(hit); return; }
      if (this.onPick) {
        // Adding a point is the primary action on a planning chart, so an empty
        // tap places one instead of only clearing the previous highlight.
        if (this.selection.segmentIndex != null || this.selection.waypointIndex != null) this.onSelect(null);
        const view = this.fit();
        if (!view) return;
        this.onPick(this.unproject(x, y, view));
        return;
      }
      if (this.selection.segmentIndex != null || this.selection.waypointIndex != null) {
        this.onSelect(null);
        return;
      }
    }
    if (!this.onSeek || !this.track.length) return;
    const view = this.fit();
    if (!view) return;
    const point = this.unproject(x, y, view);
    let best = 0, bestDistance = Infinity;
    this.track.forEach((p, index) => {
      const distance = (p.lat - point.lat) ** 2 + ((p.lon - point.lon) * Math.cos(point.lat * Math.PI / 180)) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    this.onSeek(best);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.tiles.clear();
    this.drag = null;
    clearTimeout(this.globeRedrawTimer);
    this.globeRedrawTimer = 0;
    if (this.earth) { this.earth.destroy(); this.earth = null; }
    this.globeRasterCache = null;
  }
}

/** Shortest distance from a point to a line segment, in the same units as the input. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (!lengthSq) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

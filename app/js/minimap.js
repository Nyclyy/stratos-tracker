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

import { validLatLon } from './lib/geo.js';

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

export class MiniMap {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.track = [];
    this.route = [];
    this.position = null;
    this.heading = null;
    this.options = { padding: 34, attribution: true, ...options };
    this.layers = { tiles: true, track: true, route: true, ...(options.layers || {}) };
    this.follow = false;
    this.manualZoom = null;
    this.autoZoom = 6;
    this.tiles = new Map();
    this.failedTiles = 0;
    this.onSeek = options.onSeek || null;
    this.onSelect = options.onSelect || null;
    this.onDragWaypoint = options.onDragWaypoint || null;
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
    this.resize();
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

  /** Screen-space hit test. Returns { kind, index } or null. */
  hitTest(x, y) {
    if (!this.route.length) return null;
    const view = this.fit();
    if (!view) return null;
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
        canvas.style.cursor = hit ? (hit.kind === 'waypoint' && this.onDragWaypoint ? 'grab' : 'pointer') : '';
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
    const base = this.manualZoom ?? (this.follow ? FOLLOW_ZOOM : this.autoZoom);
    this.manualZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base + delta));
    this.draw();
    return this.manualZoom;
  }

  /** Return to the automatic fit of the visible geometry. */
  resetZoom() {
    this.manualZoom = null;
    this.draw();
  }

  theme() {
    return document.documentElement.dataset.theme === 'day' ? 'light' : 'dark';
  }

  fit() {
    if (this.follow && this.position) {
      const zoom = this.manualZoom ?? FOLLOW_ZOOM;
      return {
        zoom,
        centerX: lonToX(this.position.lon, zoom),
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
    const pad = this.options.padding;
    const usableWidth = Math.max(60, this.width - pad * 2);
    const usableHeight = Math.max(60, this.height - pad * 2);
    let zoom = 3;
    for (let z = MAX_ZOOM; z >= 2; z--) {
      const xSpan = Math.abs(lonToX(maxLon, z) - lonToX(minLon, z)) * TILE;
      const ySpan = Math.abs(latToY(minLat, z) - latToY(maxLat, z)) * TILE;
      if (xSpan <= usableWidth && ySpan <= usableHeight) { zoom = z; break; }
    }
    this.autoZoom = zoom;
    if (this.manualZoom != null) zoom = this.manualZoom;
    const centerX = (lonToX(minLon, zoom) + lonToX(maxLon, zoom)) / 2;
    const centerY = (latToY(minLat, zoom) + latToY(maxLat, zoom)) / 2;
    return { zoom, centerX, centerY };
  }

  project(lat, lon, view) {
    return {
      x: this.width / 2 + (lonToX(lon, view.zoom) - view.centerX) * TILE,
      y: this.height / 2 + (latToY(lat, view.zoom) - view.centerY) * TILE,
    };
  }

  unproject(x, y, view) {
    const worldX = view.centerX + (x - this.width / 2) / TILE;
    const worldY = view.centerY + (y - this.height / 2) / TILE;
    return { lat: yToLat(worldY, view.zoom), lon: xToLon(worldX, view.zoom) };
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
    if (this.layers.tiles) this.drawTiles(view);
    // Vignette while tiles load, so gaps are not mistaken for terrain.
    if (this.layers.tiles && !this.track.length && this.failedTiles > 4) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    if (this.layers.route) this.drawRoute(view);

    const positions = this.layers.track ? this.track.map(p => this.project(p.lat, p.lon, view)) : [];
    if (positions.length > 1) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      positions.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      positions.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();

      // Recorded sample dots (not interpolated) so recorded data is visible.
      if (this.track.length <= 400) {
        ctx.fillStyle = accent;
        for (const p of positions) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const start = positions[0];
      const end = positions[positions.length - 1];
      ctx.fillStyle = '#34d399';
      ctx.beginPath(); ctx.arc(start.x, start.y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f17b89';
      ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fill();
    }

    if (this.position) {
      const p = this.project(this.position.lat, this.position.lon, view);
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
    ctx.restore();

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
    if (this.onSelect) {
      const hit = this.hitTest(x, y);
      if (hit) { this.onSelect(hit); return; }
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

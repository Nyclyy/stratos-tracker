/* Small canvas map used by the replay and route preview screens.

   Tiles come from CARTO/OpenStreetMap and are only requested for the visible
   area at replay/preview time — not continuously. Attribution is rendered in
   the corner and must remain visible. No tile is shown as live traffic. */

import { validLatLon } from './lib/geo.js';

const TILE = 256;
const TILE_LIMIT = 160;

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
    this.position = null;
    this.heading = null;
    this.options = { padding: 34, attribution: true, ...options };
    this.tiles = new Map();
    this.failedTiles = 0;
    this.onSeek = options.onSeek || null;
    this.onTileLoad = () => this.draw();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    canvas.addEventListener('click', event => this.handleClick(event));
    this.resize();
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

  setTrack(points) {
    this.track = (Array.isArray(points) ? points : []).filter(p => p && validLatLon(Number(p.lat), Number(p.lon)));
    this.draw();
  }

  setPosition(position, heading = null) {
    this.position = position && validLatLon(Number(position.lat), Number(position.lon)) ? position : null;
    this.heading = heading;
    this.draw();
  }

  theme() {
    return document.documentElement.dataset.theme === 'day' ? 'light_all' : 'dark_all';
  }

  fit() {
    const points = this.track.length ? this.track : (this.position ? [this.position] : []);
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
    for (let z = 13; z >= 2; z--) {
      const xSpan = Math.abs(lonToX(maxLon, z) - lonToX(minLon, z)) * TILE;
      const ySpan = Math.abs(latToY(minLat, z) - latToY(maxLat, z)) * TILE;
      if (xSpan <= usableWidth && ySpan <= usableHeight) { zoom = z; break; }
    }
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
    const z = Math.round(view.zoom);
    const scale = 2 ** (view.zoom - z);
    const tileSize = TILE * scale;
    const halfW = this.width / 2, halfH = this.height / 2;
    const left = view.centerX * TILE - halfW;
    const top = view.centerY * TILE - halfH;
    const style = this.theme();
    const subdomains = ['a', 'b', 'c'];
    const x0 = Math.floor(left / tileSize);
    const x1 = Math.floor((left + this.width) / tileSize);
    const y0 = Math.floor(top / tileSize);
    const y1 = Math.floor((top + this.height) / tileSize);
    const max = 2 ** z;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= max) continue;
      for (let x = x0; x <= x1; x++) {
        const wrapped = ((x % max) + max) % max;
        const entry = this.tile(`https://${subdomains[(x + y) % 3]}.basemaps.cartocdn.com/${style}/${z}/${wrapped}/${y}.png`);
        const sx = x * tileSize - left;
        const sy = y * tileSize - top;
        if (entry.loaded) {
          this.ctx.drawImage(entry.image, sx, sy, tileSize + 0.5, tileSize + 0.5);
        }
      }
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
    this.drawTiles(view);
    // Vignette while tiles load, so gaps are not mistaken for terrain.
    if (!this.track.length && this.failedTiles > 4) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    const positions = this.track.map(p => this.project(p.lat, p.lon, view));
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

    if (this.options.attribution) {
      const label = '© OpenStreetMap contributors · © CARTO';
      ctx.font = '10px system-ui, sans-serif';
      const width = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(this.width - width - 10, this.height - 18, width + 8, 14);
      ctx.fillStyle = text;
      ctx.fillText(label, this.width - width - 6, this.height - 7);
    }
  }

  handleClick(event) {
    if (!this.onSeek || !this.track.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
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
  }
}

/* EFB · Notepad.
 *
 * A scratchpad with two surfaces: a lined page you type on, and a blank one you
 * draw on with a finger, a pen or the mouse. Both are kept on this device — the
 * note is the pilot's, so it is not sent to the bridge, the tracker or anywhere
 * else. Clearing asks first, because a cleared pad is not recoverable.
 *
 * Strokes are stored in normalised coordinates so the pad survives a rotation or
 * a window resize without going blurry or moving off the page.
 */

const TEXT_KEY = 'stratos.efb.notepad.text';
const STROKES_KEY = 'stratos.efb.notepad.strokes';
const MODE_KEY = 'stratos.efb.notepad.mode';

const COLORS = [
  { key: 'cyan', value: '#22d3ee', label: 'Cyan' },
  { key: 'white', value: '#e6edf6', label: 'White' },
  { key: 'amber', value: '#f2b544', label: 'Amber' },
  { key: 'green', value: '#34d399', label: 'Green' },
];

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch (_) { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* private mode */ }
}

function readStrokes() {
  try {
    const raw = JSON.parse(read(STROKES_KEY, '[]'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(stroke => stroke && stroke.pts && stroke.pts.length)
      .map(stroke => ({
        c: typeof stroke.c === 'string' ? stroke.c : '#22d3ee',
        w: Number(stroke.w) || 2,
        e: Boolean(stroke.e),
        pts: stroke.pts.filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)),
      }))
      .filter(stroke => stroke.pts.length);
  } catch (_) { return []; }
}

export async function mount(root, ctx) {
  let destroyed = false;
  let mode = read(MODE_KEY, 'type') === 'draw' ? 'draw' : 'type';
  let strokes = readStrokes();
  let current = null;
  let color = COLORS[0].value;
  let width = 2;
  let eraser = false;
  let saveTimer = null;

  root.innerHTML = `
    <div class="e-card np-card">
      <div class="np-toolbar">
        <div class="e-seg" role="group" aria-label="Notepad mode">
          <button type="button" data-mode="type" aria-pressed="${mode === 'type'}">Type</button>
          <button type="button" data-mode="draw" aria-pressed="${mode === 'draw'}">Draw</button>
        </div>
        <div class="np-draw-tools" id="np-draw-tools" ${mode === 'draw' ? '' : 'hidden'}>
          <div class="np-swatches" role="group" aria-label="Pen colour">
            ${COLORS.map(item => `<button class="np-swatch" type="button" data-color="${item.value}" aria-label="${item.label}" aria-pressed="${item.value === color}" style="background:${item.value}"></button>`).join('')}
          </div>
          <button class="e-btn small ghost" type="button" data-eraser aria-pressed="false">Eraser</button>
          <button class="e-btn small ghost" type="button" data-undo>Undo</button>
        </div>
        <span class="e-spacer"></span>
        <span class="e-small e-faint" id="np-status" aria-live="polite"></span>
        <button class="e-btn small ghost" type="button" data-clear>Clear</button>
      </div>

      <div class="np-board" id="np-board">
        <div class="np-pane" id="np-type" ${mode === 'type' ? '' : 'hidden'}>
          <textarea class="np-text" id="np-text" spellcheck="true" aria-label="Typed note" placeholder="Type a note — frequencies, clearances, anything you would write on the pad."></textarea>
        </div>
        <div class="np-pane" id="np-draw" ${mode === 'draw' ? '' : 'hidden'}>
          <canvas class="np-canvas" id="np-canvas" aria-label="Drawn note"></canvas>
        </div>
      </div>

      <div class="e-small e-faint">Saved on this device only. Nothing on this pad is uploaded, synced or shared.</div>
    </div>`;

  const textEl = root.querySelector('#np-text');
  const drawHost = root.querySelector('#np-draw');
  const typePane = root.querySelector('#np-type');
  const drawPane = root.querySelector('#np-draw');
  const tools = root.querySelector('#np-draw-tools');
  const statusEl = root.querySelector('#np-status');
  const canvas = root.querySelector('#np-canvas');
  const context = canvas.getContext('2d');

  textEl.value = read(TEXT_KEY, '');

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function saveStrokes() {
    write(STROKES_KEY, JSON.stringify(strokes));
    setStatus('Saved');
  }

  /* ── drawing ──────────────────────────────────────────────────────── */

  function sizeCanvas() {
    const rect = drawHost.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  function paintStroke(stroke) {
    if (!stroke.pts.length) return;
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = stroke.e ? 'rgba(0,0,0,1)' : stroke.c;
    context.globalCompositeOperation = stroke.e ? 'destination-out' : 'source-over';
    context.lineWidth = stroke.e ? Math.max(10, stroke.w * 5) : stroke.w;
    context.beginPath();
    const w = drawHost.clientWidth;
    const h = drawHost.clientHeight;
    stroke.pts.forEach((point, index) => {
      const x = point[0] * w;
      const y = point[1] * h;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.restore();
  }

  function paint() {
    const w = drawHost.clientWidth;
    const h = drawHost.clientHeight;
    context.clearRect(0, 0, w, h);
    for (const stroke of strokes) paintStroke(stroke);
    if (current) paintStroke(current);
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    ];
  }

  canvas.addEventListener('pointerdown', event => {
    if (mode !== 'draw') return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    current = { c: color, w: width, e: eraser, pts: [pointFrom(event)] };
    paint();
  });

  canvas.addEventListener('pointermove', event => {
    if (!current) return;
    const point = pointFrom(event);
    const last = current.pts[current.pts.length - 1];
    if (Math.abs(last[0] - point[0]) + Math.abs(last[1] - point[1]) < 0.0015) return;
    current.pts.push(point);
    paint();
  });

  function endStroke() {
    if (!current) return;
    if (current.pts.length < 2) current.pts.push([current.pts[0][0] + 0.0006, current.pts[0][1]]);
    strokes.push(current);
    current = null;
    paint();
    saveStrokes();
  }

  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', event => { if (event.buttons === 0) endStroke(); });

  /* ── modes and controls ───────────────────────────────────────────── */

  function setMode(next) {
    mode = next === 'draw' ? 'draw' : 'type';
    write(MODE_KEY, mode);
    typePane.hidden = mode !== 'type';
    drawPane.hidden = mode !== 'draw';
    tools.hidden = mode !== 'draw';
    root.querySelectorAll('[data-mode]').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
    });
    ctx.setSubtitle(mode === 'draw' ? 'Draw with a pen, finger or mouse' : 'Typed note, kept on this device');
    if (mode === 'draw') {
      sizeCanvas();
      paint();
    } else {
      textEl.focus({ preventScroll: true });
    }
  }

  root.querySelectorAll('[data-mode]').forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  root.querySelectorAll('[data-color]').forEach(button => {
    button.addEventListener('click', () => {
      color = button.dataset.color;
      eraser = false;
      root.querySelector('[data-eraser]')?.setAttribute('aria-pressed', 'false');
      root.querySelectorAll('[data-color]').forEach(other => {
        other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      });
    });
  });

  const eraserButton = root.querySelector('[data-eraser]');
  eraserButton.addEventListener('click', () => {
    eraser = !eraser;
    eraserButton.setAttribute('aria-pressed', eraser ? 'true' : 'false');
  });

  root.querySelector('[data-undo]').addEventListener('click', () => {
    if (!strokes.length) { setStatus('Nothing to undo'); return; }
    strokes.pop();
    paint();
    saveStrokes();
  });

  root.querySelector('[data-clear]').addEventListener('click', () => {
    if (mode === 'draw') {
      if (!strokes.length) return;
      if (!window.confirm('Clear the drawing on this device?')) return;
      strokes = [];
      paint();
      saveStrokes();
      return;
    }
    if (!textEl.value) return;
    if (!window.confirm('Clear the typed note on this device?')) return;
    textEl.value = '';
    write(TEXT_KEY, '');
    setStatus('Cleared');
  });

  textEl.addEventListener('input', () => {
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      write(TEXT_KEY, textEl.value);
      setStatus('Saved');
    }, 350);
  });

  const observer = new ResizeObserver(() => {
    if (mode !== 'draw') return;
    sizeCanvas();
    paint();
  });
  observer.observe(drawHost);

  setMode(mode);
  setStatus('');

  return {
    destroy() {
      destroyed = true;
      clearTimeout(saveTimer);
      observer.disconnect();
      if (mode === 'type') write(TEXT_KEY, textEl.value);
    },
  };
}

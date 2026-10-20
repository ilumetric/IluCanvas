// Ink: freehand strokes — pen, highlighter, tape. The geometry that does not
// depend on drawing (frames, hit tests), shared by the app and the CLI. The
// outlines themselves (perfect-freehand, the italic nib, torn tape ends) are
// drawn by src/app/ink.js.
//
// A stroke keeps its samples in its own units: `pts` is a flat list
// x, y, pressure, x, y, pressure, … measured from the top-left of a `vw` × `vh`
// box, which is drawn stretched into the item's x, y, w, h. Moving and
// resizing a stroke never rewrite its points. `tw` (optional) holds the
// stylus barrel rotation per sample, in degrees (turns the italic nib).

export const INK_TOOLS = ['pen', 'highlighter', 'tape'];
export const NIBS = ['round', 'italic'];
/** Width presets per tool (board units at 100 %). */
export const INK_WIDTHS = { pen: [2, 3.5, 5, 8, 12], highlighter: [8, 12, 18, 24, 32], tape: [16, 22, 30, 40, 52] };
/** Translucency belongs to the tool, not the colour. */
export const INK_ALPHA = { pen: 1, highlighter: 0.4, tape: 0.55 };
export const INK_DEFAULTS = { pen: { color: 'white', width: 3.5 }, highlighter: { color: 'yellow', width: 18 }, tape: { color: 'pink', width: 30 } };

/** Width presets are on-screen sizes: drawn zoomed out, ink gets wider in steps of 2× (zoom `z`). */
export const inkScale = (z) => 2 ** Math.round(Math.log2(Math.min(64, Math.max(1 / 16, 1 / z))));

/** How far ink can reach from the centre line, in the stroke's own units (pressure fattens a pen). */
export const inkReach = (s) => (s.tool === 'pen' ? s.width * 0.8 : s.width / 2 + (s.tool === 'tape' ? s.width * 0.23 : 0));

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * A stroke frame around samples given in board units ([{ x, y, p?, t? }]):
 * { x, y, w, h, vw, vh, pts, tw? } — the box hugs the ink, the points are
 * stored relative to it. Null when there are no samples.
 */
export function strokeFrame({ tool = 'pen', width = 3.5 }, samples) {
  if (!samples?.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of samples) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y); }
  const pad = inkReach({ tool, width }) + 1;
  const x = Math.floor((x0 - pad) * 100) / 100;
  const y = Math.floor((y0 - pad) * 100) / 100;
  const w = r2(Math.max(1, x1 + pad - x));
  const h = r2(Math.max(1, y1 + pad - y));
  const pts = [];
  for (const s of samples) pts.push(r2(s.x - x), r2(s.y - y), Math.round(Math.min(1, Math.max(0, s.p ?? 0.5)) * 100) / 100);
  const f = { x, y, w, h, vw: w, vh: h, pts };
  if (samples.some((s) => s.t)) f.tw = samples.map((s) => Math.round((s.t || 0) * 10) / 10);
  return f;
}

/** The samples of a stroke in its own units: [{ x, y, p, t }]. */
export function strokeSamples(it) {
  const out = [];
  const pts = it.pts || [];
  for (let i = 0, k = 0; i + 2 < pts.length; i += 3, k++) out.push({ x: pts[i], y: pts[i + 1], p: pts[i + 2], t: it.tw ? it.tw[k] || 0 : 0 });
  return out;
}

/** How much a stroke is stretched from its own units (resized strokes draw wider ink too). */
export const strokeScale = (it) => Math.sqrt((it.w / (it.vw || it.w)) * (it.h / (it.vh || it.h)));

/**
 * The stroke with `changes` (tool, width in board units…) and a fresh frame:
 * the points are re-measured in board units, so the box hugs the new ink.
 */
export function reframe(it, changes = {}) {
  const sx = it.w / (it.vw || it.w);
  const sy = it.h / (it.vh || it.h);
  const n = { ...it, ...changes };
  n.width = changes.width ?? it.width * strokeScale(it);
  const samples = strokeSamples(it).map((q) => ({ x: it.x + q.x * sx, y: it.y + q.y * sy, p: q.p, t: q.t }));
  const f = strokeFrame({ tool: n.tool, width: n.width }, samples);
  if (!f) return n;
  Object.assign(n, f);
  if (!f.tw) delete n.tw;
  return n;
}

/** Board point → the stroke's own units. */
function toLocal(it, p) {
  return { x: ((p.x - it.x) * (it.vw || it.w)) / it.w, y: ((p.y - it.y) * (it.vh || it.h)) / it.h };
}

/** A board point in a turned item's own frame (about its centre). */
function unturn(it, p) {
  if (!it.rot) return p;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const a = (-it.rot * Math.PI) / 180;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** Does a circle at board point `p` (radius `r`, board units) touch the ink of stroke `it`? */
export function strokeHits(it, p, r) {
  p = unturn(it, p);
  if (p.x < it.x - r || p.y < it.y - r || p.x > it.x + it.w + r || p.y > it.y + it.h + r) return false;
  const k = (it.vw || it.w) / it.w;
  const q = toLocal(it, p);
  const reach = r * k + inkReach(it) * 0.85;
  const reach2 = reach * reach;
  const pts = it.pts || [];
  if (pts.length < 6) return pts.length >= 2 && (pts[0] - q.x) ** 2 + (pts[1] - q.y) ** 2 <= reach2;
  for (let i = 3; i + 2 < pts.length; i += 3) {
    const ax = pts[i - 3]; const ay = pts[i - 2];
    const dx = pts[i] - ax; const dy = pts[i + 1] - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((q.x - ax) * dx + (q.y - ay) * dy) / len)) : 0;
    if ((ax + dx * t - q.x) ** 2 + (ay + dy * t - q.y) ** 2 <= reach2) return true;
  }
  return false;
}

/** Does a board rectangle touch the ink of stroke `it` (marquee selection)? */
export function strokeInRect(it, rect) {
  if (it.rot) return turnedInRect(it, rect);
  if (rect.x > it.x + it.w || rect.y > it.y + it.h || rect.x + rect.w < it.x || rect.y + rect.h < it.y) return false;
  const a = toLocal(it, rect);
  const b = toLocal(it, { x: rect.x + rect.w, y: rect.y + rect.h });
  const reach = inkReach(it) * 0.85;
  const [x0, y0, x1, y1] = [a.x - reach, a.y - reach, b.x + reach, b.y + reach];
  const pts = it.pts || [];
  if (pts.length >= 2 && pts.length < 6) return pts[0] >= x0 && pts[0] <= x1 && pts[1] >= y0 && pts[1] <= y1;
  for (let i = 3; i + 2 < pts.length; i += 3) if (segmentInBox(pts[i - 3], pts[i - 2], pts[i], pts[i + 1], x0, y0, x1, y1)) return true;
  return false;
}

/** strokeInRect for a turned stroke: its samples taken to the board, then the same test. */
function turnedInRect(it, rect) {
  const sx = it.w / (it.vw || it.w);
  const sy = it.h / (it.vh || it.h);
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const a = (it.rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const reach = inkReach(it) * 0.85 * Math.sqrt(sx * sy);
  const [x0, y0, x1, y1] = [rect.x - reach, rect.y - reach, rect.x + rect.w + reach, rect.y + rect.h + reach];
  const pts = it.pts || [];
  const at = (i) => {
    const dx = it.x + pts[i] * sx - cx;
    const dy = it.y + pts[i + 1] * sy - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  };
  if (pts.length >= 2 && pts.length < 6) { const [px, py] = at(0); return px >= x0 && px <= x1 && py >= y0 && py <= y1; }
  for (let i = 3; i + 2 < pts.length; i += 3) {
    const [ax, ay] = at(i - 3);
    const [bx, by] = at(i);
    if (segmentInBox(ax, ay, bx, by, x0, y0, x1, y1)) return true;
  }
  return false;
}

/** Does segment a→b cross the box x0..x1 × y0..y1 (Liang–Barsky)? */
function segmentInBox(ax, ay, bx, by, x0, y0, x1, y1) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay);
}

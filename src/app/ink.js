// Drawing ink strokes: outlines (perfect-freehand for the round pen and the
// highlighter, a swept oval for the italic nib, a ribbon with torn ends for
// tape), cached as Path2D per stroke. Behaviour follows GuitarCanvas's ink:
// pressure changes thickness only, never opacity; a mouse draws an even line.

import { getStroke } from './vendor/perfect-freehand.js';
import { INK_ALPHA, strokeSamples, arrowLength } from '../core/ink.js';
import { isHexColor } from '../core/model.js';

/** Ink colours: Apple's dark-mode system colours, legible on a dark board. */
export const INK_COLOR = {
  white: '#ffffff', grey: '#98989d', black: '#1c1c1e', red: '#ff453a', orange: '#ff9f0a',
  yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', violet: '#bf5af2', pink: '#ff375f',
};
/** A stroke's colour on screen: a palette name or its own #rrggbb. */
export const inkColor = (c) => INK_COLOR[c] || (isHexColor(c) ? c : INK_COLOR.white);

const THINNING = 0.55;
const FREEHAND = {
  pen: { thinning: THINNING, smoothing: 0.5, streamline: 0.45 },
  highlighter: { thinning: 0, smoothing: 0.6, streamline: 0.55, start: { cap: false, taper: 0 }, end: { cap: false, taper: 0 } },
};
/** Italic nib: a stretched oval fixed at a half-tilt (lower-left → upper-right); barrel twist turns it. */
const NIB_ANGLE = -45;
const NIB_MINOR = 0.24;
const halfWidth = (width, p) => width * (0.5 - THINNING * (0.5 - p));
export const nibMinor = (width) => Math.max(1, width * NIB_MINOR);

/** The outline polygon ([[x, y], …]) of a stroke given as samples [{ x, y, p, t }]. */
export function outline({ tool, nib, width }, samples, last = true) {
  if (!samples.length) return null;
  if (tool === 'tape') return tapeOutline(samples, width);
  if (tool === 'pen' && nib === 'italic') return italicOutline(samples, width);
  const o = FREEHAND[tool] || FREEHAND.pen;
  return getStroke(samples.map((s) => [s.x, s.y, s.p]), { size: width, simulatePressure: false, last, ...o });
}

function italicOutline(points, width) {
  const nibAt = (pt) => {
    const a = ((NIB_ANGLE + (pt.t || 0)) * Math.PI) / 180;
    const half = halfWidth(width, pt.p);
    return { x: Math.cos(a) * half, y: Math.sin(a) * half };
  };
  if (points.length === 1) {
    // a tap: an oval stamp along the nib
    const c = points[0];
    const major = nibAt(c);
    const minor = { x: -major.y * NIB_MINOR, y: major.x * NIB_MINOR };
    const oval = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      oval.push([c.x + major.x * Math.cos(a) + minor.x * Math.sin(a), c.y + major.y * Math.cos(a) + minor.y * Math.sin(a)]);
    }
    return oval;
  }
  // light smoothing (the round pen gets it from perfect-freehand's streamline)
  const line = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < line.length - 1; i++) {
      line[i].x = (line[i - 1].x + line[i].x * 2 + line[i + 1].x) / 4;
      line[i].y = (line[i - 1].y + line[i].y * 2 + line[i + 1].y) / 4;
    }
  }
  const left = [];
  const right = [];
  for (const pt of line) {
    const n = nibAt(pt);
    left.push([pt.x + n.x, pt.y + n.y]);
    right.push([pt.x - n.x, pt.y - n.y]);
  }
  return [...left, ...right.reverse()];
}

// ---- tape: a constant-width ribbon along a smoothed path, serrated torn ends ----

const TEETH = 3;

function tapeOutline(points, width) {
  const raw = [];
  for (const p of points) {
    const q = raw[raw.length - 1];
    if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) raw.push({ x: p.x, y: p.y });
  }
  if (raw.length < 2) return null;
  let len = 0;
  for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
  if (len < width * 0.6) return null;
  const hw = width / 2;
  const line = smooth(resample(raw, Math.max(4, width / 3)), 3);
  if (line.length < 2) return null;
  const last = line.length - 1;
  const normals = line.map((_, i) => {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(last, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d };
  });
  const left = line.map((p, i) => ({ x: p.x + normals[i].x * hw, y: p.y + normals[i].y * hw }));
  const right = line.map((p, i) => ({ x: p.x - normals[i].x * hw, y: p.y - normals[i].y * hw }));
  const unit = (v) => { const d = Math.hypot(v.x, v.y) || 1; return { x: v.x / d, y: v.y / d }; };
  const startDir = unit({ x: line[0].x - line[1].x, y: line[0].y - line[1].y });
  const endDir = unit({ x: line[last].x - line[last - 1].x, y: line[last].y - line[last - 1].y });
  const depth = Math.min(hw * 0.6, width * 0.23); // ~7 at the usual widths, deeper on wide tape
  const poly = [
    ...serrated(right[0], left[0], startDir, depth),
    ...left.slice(1, last),
    ...serrated(left[last], right[last], endDir, depth),
    ...right.slice(1, last).reverse(),
  ];
  return poly.map((p) => [p.x, p.y]);
}

function resample(pts, spacing) {
  const out = [pts[0]];
  let prev = pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    let seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    while (acc + seg >= spacing && seg > 0) {
      const t = (spacing - acc) / seg;
      const next = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
      out.push(next);
      prev = next;
      seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      acc = 0;
    }
    acc += seg;
    prev = cur;
  }
  const end = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(end.x - tail.x, end.y - tail.y) > spacing * 0.35) out.push({ x: end.x, y: end.y });
  else if (out.length > 1) out[out.length - 1] = { x: end.x, y: end.y };
  return out;
}

function smooth(pts, passes) {
  let a = pts;
  for (let k = 0; k < passes && a.length >= 3; k++) {
    a = a.map((p, i) => (i === 0 || i === a.length - 1 ? p : { x: (a[i - 1].x + p.x * 2 + a[i + 1].x) / 4, y: (a[i - 1].y + p.y * 2 + a[i + 1].y) / 4 }));
  }
  return a;
}

/** A zig-zag from `from` to `to`; every other vertex pokes out along `dir`. */
function serrated(from, to, dir, depth) {
  const out = [from];
  const steps = TEETH * 2;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const push = i % 2 ? depth : 0;
    out.push({ x: from.x + (to.x - from.x) * t + dir.x * push, y: from.y + (to.y - from.y) * t + dir.y * push });
  }
  out.push(to);
  return out;
}

// ---- paths -------------------------------------------------------------------------------------

/** A closed path through the outline with midpoint quadratics (soft edges). */
function smoothPath(o) {
  const path = new Path2D();
  if (o.length < 3) return path;
  path.moveTo(o[0][0], o[0][1]);
  for (let i = 0; i < o.length; i++) {
    const [x0, y0] = o[i];
    const [x1, y1] = o[(i + 1) % o.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

/** A polygon with slightly rounded corners (tape ends stay torn but not razor sharp). */
function roundedPath(o, radius) {
  const path = new Path2D();
  const n = o.length;
  if (n < 3) return path;
  for (let i = 0; i < n; i++) {
    const [px, py] = o[(i + n - 1) % n];
    const [cx, cy] = o[i];
    const [nx, ny] = o[(i + 1) % n];
    const inLen = Math.hypot(cx - px, cy - py) || 1;
    const outLen = Math.hypot(nx - cx, ny - cy) || 1;
    const rIn = Math.min(radius, inLen / 2);
    const rOut = Math.min(radius, outLen / 2);
    const ax = cx - ((cx - px) / inLen) * rIn;
    const ay = cy - ((cy - py) / inLen) * rIn;
    if (i === 0) path.moveTo(ax, ay); else path.lineTo(ax, ay);
    path.quadraticCurveTo(cx, cy, cx + ((nx - cx) / outLen) * rOut, cy + ((ny - cy) / outLen) * rOut);
  }
  path.closePath();
  return path;
}

export function pathOf(s, samples, last = true) {
  const o = outline(s, samples, last);
  if (!o || o.length < 3) return null;
  return s.tool === 'tape' ? roundedPath(o, 2) : smoothPath(o);
}

/** Outlines of finished strokes, by their `pts` array (shared by moved / copied items, which keep it). */
const cache = new WeakMap();

function cachedPath(it) {
  if (!Array.isArray(it.pts)) return null;
  const key = `${it.tool}|${it.nib || ''}|${it.width}`;
  const hit = cache.get(it.pts);
  if (hit && hit.key === key && hit.tw === it.tw) return hit.path;
  const path = pathOf(it, strokeSamples(it));
  cache.set(it.pts, { key, tw: it.tw, path });
  return path;
}

/** Paint a stroke `s` (fields tool, nib, color, width) through `path`, in the current transform. */
function paint(ctx, s, path) {
  ctx.globalAlpha = INK_ALPHA[s.tool] ?? 1;
  ctx.fillStyle = inkColor(s.color);
  ctx.fill(path);
  if (s.tool === 'pen' && s.nib === 'italic') {
    // the nib's minor axis: a thin outline rounds the ribbon
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = nibMinor(s.width);
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

/** Draw a stroke item on the board (board units in the current transform; `px` = device px per unit). */
export function drawStroke(ctx, it, { px }) {
  if (Math.max(it.w, it.h) * px < 1.5) return;
  const path = cachedPath(it);
  if (!path) return;
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.scale(it.w / (it.vw || it.w), it.h / (it.vh || it.h));
  if (it.dash) dashed(ctx, it); else paint(ctx, it, path);
  if (it.end === 'arrow') arrowHead(ctx, it);
  ctx.restore();
}

/** The arrowhead at a stroke's end, pointing the way the last stretch of it goes (not its last jitter). */
function arrowHead(ctx, it) {
  const p = it.pts || [];
  const n = Math.floor(p.length / 3);
  if (n < 2) return;
  const len = arrowLength(it);
  const tx = p[(n - 1) * 3];
  const ty = p[(n - 1) * 3 + 1];
  let k = n - 2;
  while (k > 0 && Math.hypot(tx - p[k * 3], ty - p[k * 3 + 1]) < len * 0.7) k--;
  const d = Math.hypot(tx - p[k * 3], ty - p[k * 3 + 1]);
  if (!d) return;
  const ux = (tx - p[k * 3]) / d;
  const uy = (ty - p[k * 3 + 1]) / d;
  const x = tx + ux * it.width * 0.5; // over the line's round end
  const y = ty + uy * it.width * 0.5;
  ctx.globalAlpha = INK_ALPHA[it.tool] ?? 1;
  ctx.fillStyle = inkColor(it.color);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * len - uy * len * 0.55, y - uy * len + ux * len * 0.55);
  ctx.lineTo(x - ux * len + uy * len * 0.55, y - uy * len - ux * len * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** A dashed stroke: its centre line with round dashes, the stroke's width (pressure does not show). */
function dashed(ctx, it) {
  const p = it.pts || [];
  if (p.length < 6) return;
  const line = new Path2D();
  line.moveTo(p[0], p[1]);
  for (let i = 3; i + 2 < p.length; i += 3) line.lineTo(p[i], p[i + 1]);
  ctx.globalAlpha = INK_ALPHA[it.tool] ?? 1;
  ctx.strokeStyle = inkColor(it.color);
  ctx.lineWidth = it.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([it.width * 1.6, it.width * 1.9]);
  ctx.stroke(line);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** Draw a stroke being drawn: samples in board units, not finished yet. */
export function drawLive(ctx, s, samples) {
  const path = pathOf(s, samples, false);
  if (path) paint(ctx, s, path);
}

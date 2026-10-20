// Shapes and connectors on the canvas: fixed colours, outlines, where a
// shape's text goes, connector lines with heads and labels.

import { connectorPath, midpoint } from '../core/connectors.js';

/** Fills of shapes (light enough for dark text, except black). */
export const FILL = {
  white: '#f5f5f4', grey: '#c9cbd1', black: '#2a2a2e', red: '#ff9d9d', orange: '#ffc38f',
  yellow: '#ffe08a', green: '#a9e5b8', blue: '#a6d2ff', violet: '#cbb8ff', pink: '#ffb3d5',
};
/** Outlines of shapes and connector lines. */
export const LINE_COLOR = {
  white: '#f5f5f4', grey: '#9a9ca3', black: '#1f1d1a', red: '#e5484d', orange: '#f76b15',
  yellow: '#e2b203', green: '#30a46c', blue: '#3e8ef7', violet: '#8e4ec6', pink: '#e93d82',
};
/** A fill / outline colour on screen: a palette name or its own #rrggbb. */
export const fillColor = (c) => FILL[c] || (/^#[0-9a-f]{6}$/i.test(c || '') ? c : FILL.blue);
export const lineColor = (c) => LINE_COLOR[c] || (/^#[0-9a-f]{6}$/i.test(c || '') ? c : LINE_COLOR.grey);
/** Dark enough for light text: black, no fill, or a dark custom colour. */
export function darkFill(it) {
  if (it.fill === 'black' || it.fill === 'none') return true;
  const m = /^#([0-9a-f]{6})$/i.exec(it.fill || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) < 140;
}

/** Trace a shape's outline (call fill / stroke after). */
export function tracePath(ctx, kind, x, y, w, h) {
  ctx.beginPath();
  switch (kind) {
    case 'rounded': ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.18); break;
    case 'ellipse': ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'diamond': poly(ctx, [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]); break;
    case 'triangle': poly(ctx, [[x + w / 2, y], [x + w, y + h], [x, y + h]]); break;
    case 'parallelogram': { const s = w * 0.18; poly(ctx, [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]]); break; }
    case 'hexagon': { const i = w * 0.22; poly(ctx, [[x + i, y], [x + w - i, y], [x + w, y + h / 2], [x + w - i, y + h], [x + i, y + h], [x, y + h / 2]]); break; }
    case 'star': {
      const pts = [];
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 0.45 : 1;
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        pts.push([x + w / 2 + Math.cos(a) * (w / 2) * r, y + h / 2 + Math.sin(a) * (h / 2) * r + h * 0.04]);
      }
      poly(ctx, pts);
      break;
    }
    default: ctx.rect(x, y, w, h);
  }
}

function poly(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Where text goes inside a shape (relative to its top-left): the part of the box the outline does not cut. */
export function shapeFrame(it) {
  const { w, h } = it;
  const pad = Math.max(6, Math.min(24, Math.min(w, h) * 0.08));
  const box = (l, t, r, b) => ({ x: l, y: t, w: Math.max(8, w - l - r), h: Math.max(8, h - t - b) });
  switch (it.kind) {
    case 'ellipse': return box(w * 0.15 + pad / 2, h * 0.15 + pad / 2, w * 0.15 + pad / 2, h * 0.15 + pad / 2);
    case 'diamond': return box(w * 0.25, h * 0.25, w * 0.25, h * 0.25);
    case 'triangle': return box(w * 0.25, h * 0.42, w * 0.25, pad);
    case 'parallelogram': return box(w * 0.18 + pad, pad, w * 0.18 + pad, pad);
    case 'hexagon': return box(w * 0.2 + pad / 2, pad, w * 0.2 + pad / 2, pad);
    case 'star': return box(w * 0.3, h * 0.36, w * 0.3, h * 0.26);
    default: return box(pad, pad, pad, pad);
  }
}

/** The shape height that gives its text `textH` of room (shapes grow downwards to show all their text). */
export function shapeHeightFor(it, textH) {
  let h = it.h;
  for (let k = 0; k < 4; k++) {
    const f = shapeFrame({ ...it, h });
    if (f.h >= textH - 0.5) break;
    h = (h * textH) / Math.max(1, f.h) + 1;
  }
  return Math.ceil(h);
}

export function drawShapeBody(ctx, it, { px }) {
  const dpr = devicePixelRatio || 1;
  tracePath(ctx, it.kind, it.x, it.y, it.w, it.h);
  if (it.fill && it.fill !== 'none') { ctx.fillStyle = fillColor(it.fill); ctx.fill(); }
  const stroke = it.stroke || (it.fill === 'none' || it.dash || it.strokeWidth ? 'grey' : null);
  if (stroke) {
    // its own width (board units), or one that grows with the shape; never under 1.5 device px
    ctx.lineWidth = Math.max((1.5 * dpr) / px, it.strokeWidth || Math.max((2 * dpr) / px, Math.min(it.w, it.h) * 0.012));
    if (it.dash) dashOutline(ctx, it.kind, it.w, it.h, ctx.lineWidth);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = lineColor(stroke);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineCap = 'butt';
  }
}

/** The outline's length (polygons exactly; the ellipse by Ramanujan; the rounded rect with its arcs). */
function perimeter(kind, w, h) {
  if (kind === 'ellipse') {
    const [a, b] = [w / 2, h / 2];
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  if (kind === 'rounded') { const r = Math.min(w, h) * 0.18; return 2 * (w + h) - r * (8 - 2 * Math.PI); }
  const pts = {
    diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    triangle: [[0.5, 0], [1, 1], [0, 1]],
    parallelogram: [[0.18, 0], [1, 0], [0.82, 1], [0, 1]],
    hexagon: [[0.22, 0], [0.78, 0], [1, 0.5], [0.78, 1], [0.22, 1], [0, 0.5]],
    star: Array.from({ length: 10 }, (_, k) => { const r = k % 2 ? 0.45 : 1; const a = -Math.PI / 2 + (k * Math.PI) / 5; return [0.5 + Math.cos(a) * 0.5 * r, 0.5 + Math.sin(a) * 0.5 * r]; }),
  }[kind];
  if (!pts) return 2 * (w + h);
  let len = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; len += Math.hypot((q[0] - p[0]) * w, (q[1] - p[1]) * h); });
  return len;
}

/**
 * Dashes for a shape's outline: round ends, a whole number of them around it
 * (no stub where the outline closes), a dash centred on the start (a corner).
 */
function dashOutline(ctx, kind, w, h, lw) {
  // round caps add half a width at each end: dash 1.6 + 1 = 2.6 widths seen, gap 2.6 - 1 = 1.6
  const len = perimeter(kind, w, h);
  const n = Math.max(2, Math.round(len / (lw * 4.2)));
  const step = len / n;
  const dash = Math.max(0.01, step * (1.6 / 4.2));
  ctx.setLineDash([dash, step - dash]);
  ctx.lineDashOffset = dash / 2;
  ctx.lineCap = 'round';
}

// ---- connectors -------------------------------------------------------------------------------

/** Line width of a connector in board units, never thinner than 1.5 device px. */
export const connectorWidth = (c, px) => Math.max((1.5 * (devicePixelRatio || 1)) / px, c.width || 2);

/**
 * Draw a connector. `lookup(id)` → the item at an end. Returns its path (for
 * the label / hit testing). `labelFont` is the UI font family.
 */
export function drawConnector(ctx, c, lookup, { px, theme, family, path: given = null }) {
  const path = given || connectorPath(c, lookup);
  const lw = connectorWidth(c, px);
  const color = lineColor(c.color);
  const head = Math.max(lw * 3.2, 9 * (devicePixelRatio || 1) / px);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (c.dash) ctx.setLineDash([lw * 3, lw * 2.2]);
  // the line stops short of an arrow's tip so it does not poke through (cut along the path: arcs have short steps)
  let pts = path.pts.map((p) => ({ ...p }));
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const cut = (list, len) => {
    const p = list.slice();
    let left = len;
    while (p.length > 2) {
      const d = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
      if (d > left) break;
      left -= d;
      p.shift();
    }
    const d = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) || 1;
    const k = Math.min(left, d * 0.95) / d;
    p[0] = { x: p[0].x + (p[1].x - p[0].x) * k, y: p[0].y + (p[1].y - p[0].y) * k };
    return p;
  };
  const len = Math.min(head * 0.8, total * 0.4);
  if (pts.length >= 2 && (c.end || 'arrow') === 'arrow') pts = cut(pts.reverse(), len).reverse();
  if (pts.length >= 2 && c.start === 'arrow') pts = cut(pts, len);
  ctx.beginPath();
  if (path.curve) {
    const [a, c1, c2, b] = path.curve;
    const s = pts[0];
    const e = pts[pts.length - 1];
    ctx.moveTo(s.x, s.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
    void a; void b;
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const tipDir = (at, from) => {
    const p = path.pts[at];
    const q = path.pts[from];
    const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
    return { p, ux: (p.x - q.x) / d, uy: (p.y - q.y) / d };
  };
  const drawHead = (kind, t) => {
    if (kind === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(t.p.x, t.p.y);
      ctx.lineTo(t.p.x - t.ux * head - t.uy * head * 0.55, t.p.y - t.uy * head + t.ux * head * 0.55);
      ctx.lineTo(t.p.x - t.ux * head + t.uy * head * 0.55, t.p.y - t.uy * head - t.ux * head * 0.55);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'dot') {
      ctx.beginPath();
      ctx.arc(t.p.x, t.p.y, head * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  if (path.pts.length >= 2) {
    drawHead(c.end || 'arrow', tipDir(path.pts.length - 1, path.pts.length - 2));
    drawHead(c.start, tipDir(0, 1));
  }
  if (c.label) {
    const m = midpoint(path.pts);
    const size = 14 * Math.max(1, lw / 2);
    ctx.font = `500 ${size}px ${family}`;
    const tw = ctx.measureText(c.label).width;
    const padX = size * 0.5;
    const hgt = size * 1.5;
    ctx.fillStyle = theme.canvas;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.roundRect(m.x - tw / 2 - padX, m.y - hgt / 2, tw + padX * 2, hgt, Math.min(hgt / 2, theme.rPill > 0 ? hgt / 2 : 3));
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.label, m.x, m.y + size * 0.04);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
  return path;
}

// A PureRef board on IluCanvas's own widgets: its images become image items,
// its groups our group frames (nested as in PureRef), its text notes our notes
// (text straight on the board, or a sticky when the note has a background),
// its drawings our shapes (rectangles, ellipses), lines and ink strokes
// (dashed, or with an arrow at the end, as drawn in PureRef).
// Shared by the app (viewing a .pur) and the CLI (from-pur).

import { unionBounds, itemBounds } from './model.js';
import { strokeFrame } from './ink.js';

const hexRgb = (c) => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
};

const GROUP_RGB = { violet: [139, 92, 246], blue: [59, 130, 246], orange: [249, 115, 22], green: [34, 197, 94], pink: [236, 72, 153], yellow: [234, 179, 8], red: [239, 68, 68], amber: [245, 158, 11], grey: [128, 128, 128] };
const NOTE_RGB = { yellow: [255, 224, 138], orange: [255, 195, 143], pink: [255, 179, 213], green: [169, 229, 184], blue: [166, 210, 255], violet: [203, 184, 255], grey: [201, 203, 209], paper: [250, 250, 247] };

/** The nearest named colour; greys (little saturation) go to `grey` when there is one. */
function nearest(table, c, fallback) {
  if (!c) return fallback;
  const sat = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  if (sat < 24 && table.grey) return c.r > 235 && table.paper ? 'paper' : 'grey';
  let best = fallback;
  let bd = Infinity;
  for (const [name, [r, g, b]] of Object.entries(table)) {
    const d = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

/** Plain text as our Markdown: every character means itself. */
export function escapeMarkdown(text) {
  return String(text).split('\n').map((line) => line
    .replace(/[\\*_~=[\]<`]/g, (ch) => `\\${ch}`)
    .replace(/^(\s*)([#>+-])/, '$1\\$2')
    .replace(/^(\s*\d+)\./, '$1\\.')).join('\n');
}

const FONT = 18; // our note text, size m

// ---- drawings ----------------------------------------------------------------------------------

const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

/** A path's elements as runs of points (curves sampled), local coordinates. */
function pathRuns(els) {
  const runs = [];
  let run = null;
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.type === 0) { run = [{ x: e.x, y: e.y }]; runs.push(run); continue; }
    if (!run) { run = [{ x: e.x, y: e.y }]; runs.push(run); continue; }
    if (e.type === 1) {
      // straight runs in steps: the pen's smoothing would round off a corner between two far points
      const p0 = run[run.length - 1];
      for (let k = 1; k <= 8; k++) run.push({ x: p0.x + ((e.x - p0.x) * k) / 8, y: p0.y + ((e.y - p0.y) * k) / 8 });
      continue;
    }
    if (e.type === 2 && els[i + 1]?.type === 3 && els[i + 2]?.type === 3) {
      const p0 = run[run.length - 1];
      const [c1, c2, p3] = [e, els[i + 1], els[i + 2]];
      for (let k = 1; k <= 8; k++) {
        const t = k / 8;
        const u = 1 - t;
        run.push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y });
      }
      i += 2;
    }
  }
  return runs;
}

/** What a PureRef pen stroke is: a rectangle, an ellipse, a straight line or freehand. */
function strokeKind(els) {
  const types = els.map((e) => e.type).join('');
  if (types === '01111') {
    const [a, , , , e] = els;
    const axis = els.slice(1).every((p, i) => Math.abs(p.x - els[i].x) < 1e-6 || Math.abs(p.y - els[i].y) < 1e-6);
    if (axis && Math.abs(a.x - e.x) < 1e-6 && Math.abs(a.y - e.y) < 1e-6) return 'rect';
  }
  if (types === '0233233233233') return 'ellipse';
  if (types === '01') return 'line';
  return 'freehand';
}

/** Our items for one PureRef drawing (its strokes; its transform places them). */
function drawingItems(dr) {
  const m = dr.matrix;
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const rot = ((Math.atan2(m[1], m[0]) * 180) / Math.PI + 360) % 360;
  const out = [];
  for (const st of dr.strokes) {
    if (!st.elements.length) continue;
    const color = st.color || '#ffffff';
    const width = Math.max(0.5, st.width * scale);
    const kind = strokeKind(st.elements);
    if (kind === 'rect' || kind === 'ellipse') {
      const xs = st.elements.map((e) => e.x);
      const ys = st.elements.map((e) => e.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const c = apply(m, (x0 + x1) / 2, (y0 + y1) / 2);
      const w = Math.max(1, (x1 - x0) * sx);
      const h = Math.max(1, (y1 - y0) * sy);
      const shape = { type: 'shape', kind, x: c.x - w / 2, y: c.y - h / 2, w, h, fill: 'none', stroke: color, strokeWidth: Math.round(width * 100) / 100, text: '' };
      if (st.dashed) shape.dash = true;
      if (Math.round(rot * 100) % 36000) shape.rot = Math.round(rot * 100) / 100;
      out.push(shape);
      continue;
    }
    if (kind === 'line') {
      const a = apply(m, st.elements[0].x, st.elements[0].y);
      const b = apply(m, st.elements[1].x, st.elements[1].y);
      out.push({ type: 'connector', from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, end: st.arrow ? 'arrow' : 'none', color, width: Math.round(width * 100) / 100, ...(st.dashed ? { dash: true } : {}), x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(1, Math.abs(b.x - a.x)), h: Math.max(1, Math.abs(b.y - a.y)) });
      continue;
    }
    const runs = pathRuns(st.elements);
    runs.forEach((run, i) => {
      const samples = run.map((p) => ({ ...apply(m, p.x, p.y), p: 0.5 }));
      const end = st.arrow && i === runs.length - 1 ? 'arrow' : undefined; // the arrow tips the path's end
      const f = strokeFrame({ tool: 'pen', width, end }, samples);
      if (f) out.push({ type: 'stroke', tool: 'pen', color, width: Math.round(width * 100) / 100, ...(st.dashed ? { dash: true } : {}), ...(end ? { end } : {}), ...f });
    });
  }
  return out;
}

/**
 * Items for a parsed PureRef board. assetOf(imageIndex) → asset id;
 * id(kind, n) → an item id ('image' | 'note' | 'group', a running number).
 * Returns { items } in stacking order (groups first, outer before inner).
 */
export function purItems(pur, assetOf, id) {
  const groupIds = new Map(); // PureRef group id → ours
  let n = 0;
  for (const g of pur.groups || []) groupIds.set(g.id, id('group', ++n));

  const placed = [];
  n = 0;
  for (const p of pur.items) {
    const it = { id: id('image', ++n), type: 'image', asset: assetOf(p.image), x: p.x, y: p.y, w: p.w, h: p.h };
    if (p.rotation) it.rot = p.rotation;
    if (p.flipX) it.flipX = true;
    if (p.flipY) it.flipY = true;
    if (p.crop) it.crop = p.crop;
    if (p.opacity !== undefined && p.opacity < 1) it.opacity = p.opacity;
    if (p.locked) it.locked = true;
    if (p.name) it.note = p.name;
    if (p.group !== null && p.group !== undefined && groupIds.has(p.group)) it.parent = groupIds.get(p.group);
    placed.push({ z: p.z ?? 0, it });
  }
  n = 0;
  for (const tx of pur.texts || []) {
    const text = String(tx.text || '').replace(/\r\n?/g, '\n');
    if (!text.trim()) continue;
    const bg = hexRgb(tx.background);
    const color = bg && bg.a >= 64 ? nearest(NOTE_RGB, bg, 'yellow') : 'none';
    // the note's font size (its HTML says it) relative to ours, times the item's scale
    const px = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(tx.html || '')?.[1]) || FONT;
    const scale = (tx.scale > 0 ? tx.scale : 1) * (px / FONT);
    const lines = text.split('\n');
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const pad = color === 'none' ? 4 : 16;
    const w = tx.w > 0 ? tx.w : Math.max(60, longest * FONT * 0.56 * scale + pad * 2);
    const h = tx.h > 0 ? tx.h : Math.max(30, lines.length * FONT * 1.45 * scale + pad * 2);
    const note = { id: id('note', ++n), type: 'note', x: tx.x, y: tx.y, w, h, color, text: escapeMarkdown(text) };
    if (!(tx.w > 0) && Math.abs(scale - 1) > 0.01) note.scale = Math.round(scale * 1000) / 1000;
    if (tx.rotation) note.rot = tx.rotation;
    if (tx.group !== null && tx.group !== undefined && groupIds.has(tx.group)) note.parent = groupIds.get(tx.group);
    placed.push({ z: tx.z ?? 0, it: note });
  }
  n = 0;
  for (const dr of pur.drawings || []) {
    const parent = dr.group !== null && dr.group !== undefined && groupIds.has(dr.group) ? groupIds.get(dr.group) : null;
    for (const it of drawingItems(dr)) {
      it.id = id(it.type, ++n);
      if (parent) it.parent = parent;
      placed.push({ z: dr.z ?? 0, it });
    }
  }
  placed.sort((a, b) => a.z - b.z);
  const items = placed.map((x) => x.it);

  // group frames hug what is in them (inner groups first)
  const byPur = new Map((pur.groups || []).map((g) => [g.id, g]));
  const depth = (g) => { let d = 0; const seen = new Set(); for (let p = g; p && p.group !== null && p.group !== undefined && !seen.has(p.id); p = byPur.get(p.group)) { seen.add(p.id); d++; } return d; };
  const groups = [];
  for (const g of [...(pur.groups || [])].sort((a, b) => depth(b) - depth(a))) {
    const gid = groupIds.get(g.id);
    const kids = [...items, ...groups].filter((x) => x.parent === gid);
    const b = unionBounds(kids.map(itemBounds));
    if (!b) continue; // an empty group: nothing to frame
    const pad = Math.max(16, Math.round(Math.max(b.w, b.h) * 0.03));
    const grp = { id: gid, type: 'group', name: g.name || 'Group', color: nearest(GROUP_RGB, hexRgb(g.background), 'grey'), x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    if (g.group !== null && g.group !== undefined && groupIds.has(g.group)) grp.parent = groupIds.get(g.group);
    groups.push(grp);
  }
  // a frame whose group was empty: its members (none) and children point nowhere
  const made = new Set(groups.map((g) => g.id));
  for (const x of [...items, ...groups]) if (x.parent && !made.has(x.parent)) delete x.parent;
  return { items: [...groups.reverse(), ...items] };
}

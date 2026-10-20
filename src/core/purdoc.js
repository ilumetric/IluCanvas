// A PureRef board on IluCanvas's own widgets: its images become image items,
// its groups our group frames (nested as in PureRef), its text notes our notes
// (text straight on the board, or a sticky when the note has a background).
// Shared by the app (viewing a .pur) and the CLI (from-pur). Drawings are not
// read yet: their format is unknown (docs/PUREREF.md).

import { unionBounds, itemBounds } from './model.js';

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
    const scale = tx.scale > 0 ? tx.scale : 1;
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

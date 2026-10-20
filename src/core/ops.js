// Batch operations on a canvas — the one vocabulary agents use, both in the
// CLI (`ilucanvas apply`) and in the open app (`window.ilucanvas.apply`).
//
//   [{ "op": "newgroup", "name": "Lighting", "as": "$light" },
//    { "op": "add", "paths": ["refs/a.jpg"], "group": "$light" },
//    { "op": "set", "id": "i3k9x2a", "note": "rim light" },
//    { "op": "arrange", "id": "$light" }]
//
// "as" names an id created in the batch; later ops refer to it as "$name".
// Adding images depends on the environment (files in Node, URLs / blobs in the
// browser), so the caller passes `addImages(op) → [{ asset, w, h, name }]`
// after putting the assets into doc.assets.

import { ROUTES, HEADS, SIDES } from './connectors.js';
import { INK_TOOLS, NIBS, INK_DEFAULTS, strokeFrame, reframe } from './ink.js';
import { parseVideoUrl, parseTime, cleanMarks, RATE_MIN, RATE_MAX } from './video.js';
import { TABLE_COL, TABLE_ROW, TABLE_MAX_CELLS, estimateHeight, insertRow, insertCol, removeRows, removeCols, setCell, rowCount, colCount } from './table.js';
import {
  NOTE_COLORS, NOTE_SIZES, NOTE_ALIGNS, NOTE_RATIOS, RATIO_K, GROUP_COLORS, SHAPE_KINDS, PAINT, isHexColor, cleanEnd, refreshConnectors, byId, itemBounds, unionBounds, contentBounds, childrenOf, groupsOf, moveItems, patchItems,
  removeItems, groupItems, ungroup, fitGroup, growGroup, arrangeItems, arrangeRows, addItems, newId, fitSize, restack, reparent, cleanTable,
} from './model.js';

export class OpError extends Error {}

/** "a b c" — or the first ten and a count, so a log line stays readable. */
const idList = (ids) => (ids.length > 12 ? `${ids.slice(0, 10).join(' ')} … (+${ids.length - 10})` : ids.join(' '));

const need = (cond, msg) => { if (!cond) throw new OpError(msg); };

export function idsExist(doc, ids) {
  const m = byId(doc);
  const bad = ids.filter((id) => !m.has(id));
  if (bad.length) throw new OpError(`unknown id: ${bad.join(', ')}`);
}

const EDITABLE = {
  x: 'num', y: 'num', w: 'pos', h: 'pos', rot: 'num', name: 'str', color: 'color', note: 'str',
  flipX: 'bool', flipY: 'bool', locked: 'bool', parent: 'ref', opacity: 'num', crop: 'crop',
  text: 'text', fit: 'bool', size: 'enum', align: 'enum', ratio: 'enum', scale: 'pos',
  kind: 'enum', fill: 'paint', stroke: 'paint',
  from: 'end', to: 'end', route: 'enum', start: 'enum', end: 'enum', width: 'pos', dash: 'bool', label: 'str',
  tool: 'enum', nib: 'enum',
  title: 'str', rate: 'rate', loop: 'loop', marks: 'marks', strokeWidth: 'pos',
  cells: 'cells', cols: 'sizes', rows: 'sizes', clickCopy: 'onoff',
};
/** Fields that mean something else on a video (start: a time, not a connector head). */
const VIDEO_FIELDS = { start: 'time' };
const ENUMS = { size: NOTE_SIZES, align: NOTE_ALIGNS, ratio: NOTE_RATIOS, kind: SHAPE_KINDS, route: ROUTES, start: HEADS, end: HEADS, tool: INK_TOOLS, nib: NIBS };
export const EDITABLE_KEYS = Object.keys(EDITABLE);

/** A checked patch from loose input (strings from the command line, JSON from agents); `item` is the target. */
export function cleanPatch(doc, input, item = null) {
  const patch = {};
  for (const [k, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const t = (item?.type === 'video' && VIDEO_FIELDS[k]) || EDITABLE[k];
    need(t, `unknown field "${k}" (editable: ${EDITABLE_KEYS.join(', ')})`);
    if (t === 'text') { patch[k] = String(raw ?? '').replace(/\r\n?/g, '\n'); continue; }
    need(t !== 'end' || (raw !== null && raw !== ''), `${k} cannot be removed: give an id or { x, y }`);
    if (raw === null || raw === '') { patch[k] = undefined; continue; }
    if (t === 'num' || t === 'pos') {
      const n = Number(raw);
      need(Number.isFinite(n) && (t === 'num' || n > 0), `${k} must be a ${t === 'pos' ? 'positive ' : ''}number`);
      patch[k] = n;
    } else if (t === 'bool') patch[k] = raw === true || raw === 'true' || raw === 1 || raw === '1' ? true : undefined;
    else if (t === 'onoff') patch[k] = raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === 'off' ? false : undefined; // on by default: only "off" is stored
    else if (t === 'cells') {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      need(Array.isArray(v) && v.length && v.every(Array.isArray), 'cells must be rows of cells: [["a", "b"], ["c", "d"]] (a cell: text, or { text, fill, align })');
      patch[k] = v;
    } else if (t === 'sizes') {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      need(Array.isArray(v) && v.length && v.every((x) => Number(x) > 0), `${k} must be a list of positive numbers (${k === 'cols' ? 'column widths' : 'row heights'})`);
      patch[k] = v.map(Number);
    }
    else if (t === 'paint') {
      need(raw === 'none' || PAINT.includes(raw) || isHexColor(raw), `${k} must be one of ${PAINT.join(', ')}, none, or #rrggbb`);
      patch[k] = raw === 'none' && k === 'stroke' ? undefined : isHexColor(raw) ? raw.toLowerCase() : raw;
    } else if (t === 'end') {
      const e = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw;
      const end = cleanEnd(e);
      if (end.id !== undefined) {
        const target = byId(doc).get(end.id);
        need(target, `${k}: unknown item "${end.id}"`);
        need(target.type !== 'connector', `${k}: ${end.id} is a connector`);
      }
      patch[k] = end;
    } else if (t === 'color') {
      need(item?.type !== 'shape' && item?.type !== 'table', `${item?.type}s have fill${item?.type === 'shape' ? ' and stroke' : ''}, not color`);
      if ((item?.type === 'stroke' || item?.type === 'connector') && isHexColor(raw)) { patch[k] = raw.toLowerCase(); continue; }
      const list = item?.type === 'note' ? NOTE_COLORS : item?.type === 'connector' || item?.type === 'stroke' ? PAINT : GROUP_COLORS;
      need(list.includes(raw), `color must be one of ${list.join(', ')}${item?.type === 'stroke' || item?.type === 'connector' ? ', or #rrggbb' : ''}`);
      patch[k] = raw;
    } else if (t === 'enum') {
      need(ENUMS[k].includes(raw), `${k} must be one of ${ENUMS[k].join(', ')}`);
      patch[k] = k === 'nib' && raw === 'round' ? undefined : raw;
    }
    else if (t === 'ref') {
      const g = byId(doc).get(raw);
      need(g && g.type === 'group', `parent "${raw}" is not a group`);
      patch[k] = raw;
    } else if (t === 'time') {
      const v = parseTime(raw);
      need(v !== null, `${k} must be a time: seconds, 1:23 or 1m23s`);
      patch[k] = v || undefined;
    } else if (t === 'rate') {
      const v = Number(raw);
      need(v >= RATE_MIN && v <= RATE_MAX, `rate must be ${RATE_MIN}…${RATE_MAX}`);
      patch[k] = v === 1 ? undefined : v;
    } else if (t === 'loop') {
      const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const a = parseTime(l?.a);
      const b = parseTime(l?.b);
      need(a !== null && b !== null && b > a, 'loop must be { a, b } with b after a (seconds or 1:23)');
      patch[k] = { a, b };
    } else if (t === 'marks') {
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      need(Array.isArray(list), 'marks must be a list of { t, label, end? }');
      const m = cleanMarks(list);
      patch[k] = m.length ? m : undefined;
    } else if (t === 'crop') {
      const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
      need(c && c.w > 0 && c.h > 0, 'crop must be { x, y, w, h } in image pixels');
      patch[k] = { x: Number(c.x) || 0, y: Number(c.y) || 0, w: Number(c.w), h: Number(c.h) };
    } else patch[k] = String(raw);
  }
  return patch;
}

/**
 * Place new images ([{ asset, w, h }]): inside a group (below its images), at
 * a point (top-left), or right of everything. Returns the new items.
 */
export function placeImages(doc, list, { group = null, at = null, max = 1200, by = 'human' } = {}) {
  if (!list.length) return [];
  const sizes = list.map((x) => fitSize(x.w, x.h, Number(max) || 1200));
  const rects = sizes.map((s, i) => ({ id: i, ...s }));
  let x0;
  let y0;
  let width;
  const g = group ? byId(doc).get(group) : null;
  if (g) {
    const kids = unionBounds(childrenOf(doc, g.id).map(itemBounds));
    const pad = Math.max(16, Math.round(Math.max(g.w, g.h) * 0.03));
    x0 = g.x + pad;
    y0 = kids ? kids.y + kids.h + pad : g.y + pad;
    width = Math.max(g.w - pad * 2, 200);
  } else if (at) [x0, y0] = at;
  else {
    const b = contentBounds(doc);
    x0 = b ? b.x + b.w + 120 : 0;
    y0 = b ? b.y : 0;
  }
  const layout = arrangeRows(rects, { x0, y0, width, rowHeight: Math.min(...sizes.map((s) => s.h)) });
  const items = list.map((x, i) => {
    const r = layout.get(i);
    const it = { id: newId('image'), type: 'image', asset: x.asset, x: r.x, y: r.y, w: r.w, h: r.h };
    if (g) it.parent = g.id;
    return it;
  });
  addItems(doc, items, by);
  if (g) fitGroup(doc, g.id, { by });
  return items;
}

/** Text size of notes in board units, per `size`. */
export const NOTE_FONT = { s: 14, m: 18, l: 28, xl: 44 };

/**
 * Rough height of a note's text without a font engine (CLI, agents): the app
 * measures properly and grows documents that are too short.
 */
export function estimateNoteHeight(text, w, { size = 'm', color = 'yellow', scale = 1 } = {}) {
  const f = (NOTE_FONT[size] || 18) * (scale || 1);
  const pad = color === 'none' ? 4 : Math.max(10, Math.min(40, w * 0.075));
  const perLine = Math.max(1, Math.floor((w - pad * 2) / (f * 0.55)));
  let lines = 0;
  for (const raw of String(text).split('\n')) {
    const heading = raw.match(/^(#{1,3}) /);
    const k = heading ? [0, 1.75, 1.4, 1.18][heading[1].length] : 1;
    lines += Math.max(1, Math.ceil(raw.length / (perLine / k))) * k;
  }
  return Math.ceil(lines * f * 1.35 + pad * 2);
}

/**
 * A new note. Defaults: a 240×240 sticky; `color: 'paper'` makes a document
 * (A4, text does not shrink), `color: 'none'` plain text. Placed at x/y, at
 * the bottom of `group`, or right of everything.
 */
export function newNote(doc, { text = '', color = 'yellow', fit, size, scale, align, ratio, x, y, w, h, group = null, by = 'human' } = {}) {
  const doc_ = color === 'paper';
  const plain = color === 'none';
  const n = { id: newId('note'), type: 'note', x: 0, y: 0, w: Number(w) || (doc_ ? 600 : plain ? 400 : 240), h: 0, color, text };
  if (fit ?? (!doc_ && !plain)) n.fit = true;
  if (size && size !== 'm') n.size = size;
  if (scale && scale !== 1) n.scale = scale;
  if (align && align !== 'left') n.align = align;
  if (ratio && ratio !== 'free') n.ratio = ratio; else if (doc_ && !w && !h) n.ratio = 'a4';
  n.h = Number(h) || Math.round(n.fit ? n.w : Math.max(n.ratio ? n.w * RATIO_K[n.ratio] : 0, estimateNoteHeight(text, n.w, { size, color, scale })));
  const g = group ? byId(doc).get(group) : null;
  if (x !== undefined) { n.x = Number(x); n.y = Number(y ?? 0); }
  else if (g) {
    const kids = unionBounds(childrenOf(doc, g.id).map(itemBounds));
    const pad = Math.max(16, Math.round(Math.max(g.w, g.h) * 0.03));
    n.x = g.x + pad;
    n.y = kids ? kids.y + kids.h + pad : g.y + pad;
  } else {
    const b = contentBounds(doc);
    if (b) { n.x = b.x + b.w + 120; n.y = b.y; }
  }
  if (g) n.parent = g.id;
  addItems(doc, [n], by);
  if (g) fitGroup(doc, g.id, { by });
  return n;
}

/** A new shape (default: a 200×120 blue rectangle right of everything). */
export function newShape(doc, { kind = 'rect', text = '', fill = 'blue', stroke, strokeWidth, dash, size, scale, align, x, y, w, h, group = null, by = 'human' } = {}) {
  const s = { id: newId('shape'), type: 'shape', kind, x: 0, y: 0, w: Number(w) || 200, h: Number(h) || (kind === 'ellipse' || kind === 'diamond' || kind === 'star' || kind === 'hexagon' ? Number(w) || 200 : 120), fill, text };
  if (stroke) s.stroke = stroke;
  if (strokeWidth > 0) s.strokeWidth = Number(strokeWidth);
  if (dash) s.dash = true;
  if (size && size !== 'm') s.size = size;
  if (scale && scale !== 1) s.scale = scale;
  if (align && align !== 'center') s.align = align;
  placeNew(doc, s, x, y, group);
  addItems(doc, [s], by);
  if (s.parent) fitGroup(doc, s.parent, { by });
  return s;
}

/**
 * A new table: `cells` (rows of texts) or `rows` × `cols` empty cells
 * (default 3 × 3); `rows` / `cols` may also be lists of heights / widths.
 * Placed at x/y, at the bottom of `group`, or right of everything.
 */
export function newTable(doc, { cells, rows, cols, width, height, fill = 'white', size, scale, align, clickCopy, x, y, group = null, by = 'human' } = {}) {
  const k = scale > 0 ? scale : 1;
  const R = Array.isArray(rows) ? rows.length : Number(rows) > 0 ? Math.floor(rows) : Array.isArray(cells) && cells.length ? cells.length : 3;
  const C = Array.isArray(cols) ? cols.length : Number(cols) > 0 ? Math.floor(cols) : Array.isArray(cells) && cells.length ? Math.max(...cells.map((r) => (Array.isArray(r) ? r.length : 1))) : 3;
  need(R * C <= TABLE_MAX_CELLS, `a table takes at most ${TABLE_MAX_CELLS} cells`);
  const t = cleanTable({
    id: newId('table'), type: 'table', x: 0, y: 0, w: 1, h: 1, fill, size, scale, align, clickCopy,
    cols: Array.isArray(cols) ? cols : Array(C).fill(Number(width) > 0 ? Number(width) : TABLE_COL * k),
    rows: Array.isArray(rows) ? rows : Array(R).fill(Number(height) > 0 ? Number(height) : TABLE_ROW * k),
    cells: cells || [],
  });
  t.h = estimateHeight(t);
  placeNew(doc, t, x, y, group);
  addItems(doc, [t], by);
  if (t.parent) growGroup(doc, t.parent, t, { by });
  return t;
}

/** A table changed by an op: consistent again, its height estimated (the app measures it properly). */
function putTable(doc, t, by) {
  const n = cleanTable(t);
  n.h = estimateHeight(n);
  doc.items = doc.items.map((it) => (it.id === n.id ? n : it));
  doc.updated_by = by;
  if (n.parent) growGroup(doc, n.parent, n, { by });
  return n;
}

/** The table an op names, and a row / column index in it (0-based; negative counts from the end). */
function tableOf(doc, id) {
  idsExist(doc, [id]);
  const t = byId(doc).get(id);
  need(t.type === 'table', `${id} is not a table`);
  return t;
}
const indexIn = (v, n, name, { end = false } = {}) => {
  if (v === undefined || v === null || v === '') { need(end, `${name} is needed`); return n; }
  let i = Number(v);
  need(Number.isInteger(i), `${name} must be a whole number (0 is the first)`);
  if (i < 0) i += n + (end ? 1 : 0);
  need(i >= 0 && i <= (end ? n : n - 1), `${name} ${v} is outside the table (0…${end ? n : n - 1})`);
  return i;
};

/** A new connector between two ends ({ id, side? } or { x, y }). */
export function newConnector(doc, { from, to, route = 'dubins', start, end = 'arrow', color = 'grey', width, dash, label, by = 'human' } = {}) {
  const c = { id: newId('connector'), type: 'connector', from, to, end, color, x: 0, y: 0, w: 1, h: 1 };
  if (route && route !== 'straight') c.route = route;
  if (start && start !== 'none') c.start = start;
  if (width && width !== 2) c.width = width;
  if (dash) c.dash = true;
  if (label) c.label = label;
  addItems(doc, [c], by);
  refreshConnectors(doc);
  return byId(doc).get(c.id);
}

/**
 * A new ink stroke through `samples` ([{ x, y, p? , t? }] in board units):
 * its frame hugs the ink, the points are stored relative to it (ink.js).
 */
/**
 * A new video card (16:9, 640 wide by default) for a YouTube link. `meta`
 * (optional): { asset, title, w, h } — the poster as an image asset, the title.
 */
export function newVideo(doc, { url, title, start, rate, loop, marks, x, y, w, h, group = null, by = 'human', meta = null } = {}) {
  const v = parseVideoUrl(url);
  need(v, 'video needs a YouTube link (youtube.com/watch?v=…, youtu.be/…, shorts/…)');
  const W = Number(w) || 640;
  const it = { id: newId('video'), type: 'video', provider: v.provider, videoId: v.videoId, url: v.url, x: 0, y: 0, w: W, h: Number(h) || Math.round((W * 9) / 16) };
  if (title || meta?.title) it.title = String(title || meta.title);
  if (meta?.asset) it.asset = meta.asset;
  const st = start !== undefined ? start : v.start;
  if (st) it.start = st;
  if (rate && rate !== 1) it.rate = rate;
  if (loop) it.loop = loop;
  if (marks?.length) it.marks = marks;
  placeNew(doc, it, x, y, group);
  addItems(doc, [it], by);
  if (it.parent) growGroup(doc, it.parent, it, { by });
  return it;
}

export function newStroke(doc, { tool = 'pen', nib, color, width, dash, end, samples, group = null, by = 'human' } = {}) {
  const def = INK_DEFAULTS[tool] || INK_DEFAULTS.pen;
  const w = Number(width) || def.width;
  need(!end || end === 'arrow' || end === 'none', 'a stroke\'s end is "arrow" or "none"');
  const arrow = end === 'arrow' && tool !== 'tape';
  const f = strokeFrame({ tool, width: w, end: arrow ? 'arrow' : undefined }, samples);
  need(f, 'a stroke needs at least one point');
  const k = { id: newId('stroke'), type: 'stroke', tool, color: color || def.color, width: w, ...f };
  if (tool === 'pen' && nib === 'italic') k.nib = 'italic';
  if (dash && tool !== 'tape') k.dash = true;
  if (arrow) k.end = 'arrow';
  if (group) k.parent = group;
  addItems(doc, [k], by);
  if (group) growGroup(doc, group, k, { by });
  return k;
}

/** Points an agent gives ([[x, y], [x, y, pressure], { x, y, p }]) → samples. */
function samplesOf(points) {
  need(Array.isArray(points) && points.length, 'stroke needs "points": [[x, y], [x, y, pressure], …] in board units');
  need(points.length <= 50000, 'a stroke takes at most 50000 points');
  return points.map((q) => {
    const s = Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]), p: q[2] } : { x: Number(q?.x), y: Number(q?.y), p: q?.p ?? q?.pressure };
    need(Number.isFinite(s.x) && Number.isFinite(s.y), 'stroke points must be [x, y] numbers');
    s.p = Number.isFinite(Number(s.p)) && s.p !== undefined && s.p !== null ? Math.min(1, Math.max(0, Number(s.p))) : 0.5;
    return s;
  });
}

/** x / y given, the bottom of `group`, or right of everything. */
function placeNew(doc, it, x, y, group) {
  const g = group ? byId(doc).get(group) : null;
  if (x !== undefined) { it.x = Number(x); it.y = Number(y ?? 0); }
  else if (g) {
    const kids = unionBounds(childrenOf(doc, g.id).map(itemBounds));
    const pad = Math.max(16, Math.round(Math.max(g.w, g.h) * 0.03));
    it.x = g.x + pad;
    it.y = kids ? kids.y + kids.h + pad : g.y + pad;
  } else {
    const b = contentBounds(doc);
    if (b) { it.x = b.x + b.w + 120; it.y = b.y; }
  }
  if (g) it.parent = g.id;
}

/** A new empty group frame: at x/y, or right of everything. */
export function newGroup(doc, { name = 'Group', color, x, y, w = 1600, h = 1000, by = 'human' } = {}) {
  const g = { id: newId('group'), type: 'group', name: String(name), color: GROUP_COLORS.includes(color) ? color : GROUP_COLORS[groupsOf(doc).length % GROUP_COLORS.length], x: x ?? 0, y: y ?? 0, w: Number(w) || 1600, h: Number(h) || 1000 };
  if (x === undefined) { const b = contentBounds(doc); if (b) { g.x = b.x + b.w + 160; g.y = b.y; } }
  doc.items = [g, ...doc.items];
  doc.updated_by = by;
  return g;
}

/**
 * Apply ops to `doc` in order. Returns { created: [ids], log: [text] }.
 * Throws OpError (with the op number) on the first bad op; the caller decides
 * whether to keep the partial result (the CLI writes nothing then).
 */
export async function applyOps(doc, ops, { by = 'agent', addImages, videoMeta } = {}) {
  need(Array.isArray(ops), 'ops must be an array');
  const created = [];
  const log = [];
  const named = new Map();
  const ref = (id) => (typeof id === 'string' && id.startsWith('$') ? named.get(id) ?? id : id);
  const refs = (ids) => [].concat(ids ?? []).map(ref);
  for (const [i, o] of ops.entries()) {
    try {
      need(o && typeof o.op === 'string', 'each op needs "op"');
      switch (o.op) {
        case 'add': {
          need(addImages, 'adding images is not available here');
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const list = await addImages(o);
          const items = placeImages(doc, list, { group, at: o.x !== undefined ? [Number(o.x), Number(o.y ?? 0)] : null, max: o.max, by });
          if (o.as) named.set(o.as, items[0]?.id);
          created.push(...items.map((it) => it.id));
          log.push(`added ${items.length} image(s): ${idList(items.map((it) => it.id))}`);
          break;
        }
        case 'note': {
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const { op, as, group: _g, ...fields } = o;
          const n = newNote(doc, { ...cleanPatch(doc, fields, { type: 'note' }), group, by });
          if (as) named.set(as, n.id);
          created.push(n.id);
          log.push(`note ${n.id}`);
          break;
        }
        case 'shape': {
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const { op, as, group: _g, ...fields } = o;
          const s = newShape(doc, { ...cleanPatch(doc, fields, { type: 'shape' }), group, by });
          if (as) named.set(as, s.id);
          created.push(s.id);
          log.push(`shape ${s.id} ${s.kind}`);
          break;
        }
        case 'connect': {
          const end = (v, side) => {
            const r = typeof v === 'string' ? ref(v) : v;
            if (typeof r === 'string') {
              idsExist(doc, [r]);
              need(byId(doc).get(r).type !== 'connector', `connect: ${r} is a connector`);
              need(!side || SIDES.includes(side), `connect: side must be one of ${SIDES.join(' ')}`);
              return side ? { id: r, side } : { id: r };
            }
            need(r && Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y)), 'connect: from / to must be an id or { x, y }');
            return { x: Number(r.x), y: Number(r.y) };
          };
          const { op, as, from, to, fromSide, toSide, ...fields } = o;
          need(from !== undefined && to !== undefined, 'connect needs from and to');
          const c = newConnector(doc, { ...cleanPatch(doc, fields, { type: 'connector' }), from: end(from, fromSide), to: end(to, toSide), by });
          if (as) named.set(as, c.id);
          created.push(c.id);
          log.push(`connector ${c.id}`);
          break;
        }
        case 'video': {
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const { op, as, group: _g, url, ...fields } = o;
          const parsed = parseVideoUrl(url);
          need(parsed, 'video needs a YouTube link (youtube.com/watch?v=…, youtu.be/…, shorts/…)');
          // the poster and the title come from the environment (the browser or the CLI fetch them)
          let meta = null;
          if (videoMeta) { try { meta = await videoMeta(parsed); } catch { meta = null; } }
          const v = newVideo(doc, { ...cleanPatch(doc, fields, { type: 'video' }), url, group, by, meta });
          if (as) named.set(as, v.id);
          created.push(v.id);
          log.push(`video ${v.id} ${v.videoId}${v.asset ? '' : ' (no poster)'}`);
          break;
        }
        case 'stroke': {
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const { op, as, group: _g, points, ...fields } = o;
          const k = newStroke(doc, { ...cleanPatch(doc, fields, { type: 'stroke' }), samples: samplesOf(points), group, by });
          if (as) named.set(as, k.id);
          created.push(k.id);
          log.push(`stroke ${k.id} ${k.tool}`);
          break;
        }
        case 'table': {
          const group = o.group ? ref(o.group) : null;
          if (group) { idsExist(doc, [group]); need(byId(doc).get(group).type === 'group', `${group} is not a group`); }
          const { op, as, group: _g, cells, rows, cols, width, height, x, y, ...fields } = o;
          if (cells !== undefined) cleanPatch(doc, { cells });
          const t = newTable(doc, { ...cleanPatch(doc, fields, { type: 'table' }), cells, rows, cols, width, height, x, y, group, by });
          if (as) named.set(as, t.id);
          created.push(t.id);
          log.push(`table ${t.id} ${rowCount(t)}×${colCount(t)}`);
          break;
        }
        case 'cell': {
          const t = tableOf(doc, ref(o.id));
          const r = indexIn(o.row, rowCount(t), 'row');
          const c = indexIn(o.col, colCount(t), 'col');
          const p = {};
          if (o.text !== undefined) p.text = String(o.text ?? '').replace(/\r\n?/g, '\n');
          if (o.fill !== undefined) { if (o.fill !== null && o.fill !== '') cleanPatch(doc, { fill: o.fill }); p.fill = o.fill || null; }
          if (o.align !== undefined) { if (o.align !== null && o.align !== '') cleanPatch(doc, { align: o.align }); p.align = o.align || null; }
          need(Object.keys(p).length, 'cell needs text, fill or align');
          putTable(doc, setCell(t, r, c, p), by);
          log.push(`cell ${t.id} [${r},${c}]`);
          break;
        }
        case 'row': case 'col': {
          const t = tableOf(doc, ref(o.id));
          const isRow = o.op === 'row';
          const n = isRow ? rowCount(t) : colCount(t);
          if (o.remove) {
            need(n > 1, `a table keeps at least one ${isRow ? 'row' : 'column'}`);
            const a = indexIn(o.at, n, 'at');
            const b = o.to !== undefined ? indexIn(o.to, n, 'to') : a;
            need(Math.abs(b - a) + 1 < n, `a table keeps at least one ${isRow ? 'row' : 'column'}`);
            putTable(doc, isRow ? removeRows(t, a, b) : removeCols(t, a, b), by);
            log.push(`removed ${isRow ? 'row' : 'column'} ${a}${b !== a ? `…${b}` : ''} of ${t.id}`);
            break;
          }
          const at = indexIn(o.at, n, 'at', { end: true });
          need((rowCount(t) + (isRow ? 1 : 0)) * (colCount(t) + (isRow ? 0 : 1)) <= TABLE_MAX_CELLS, `a table takes at most ${TABLE_MAX_CELLS} cells`);
          const cells = o.cells === undefined ? [] : o.cells;
          need(Array.isArray(cells), 'cells must be a list of the new cells (text, or { text, fill, align })');
          const size = Number(isRow ? o.height : o.width);
          putTable(doc, isRow ? insertRow(t, at, { cells, height: size > 0 ? size : undefined }) : insertCol(t, at, { cells, width: size > 0 ? size : undefined }), by);
          log.push(`${isRow ? 'row' : 'column'} ${at} in ${t.id}`);
          break;
        }
        case 'newgroup': {
          const g = newGroup(doc, { ...o, by });
          if (o.as) named.set(o.as, g.id);
          created.push(g.id);
          log.push(`group ${g.id} "${g.name}"`);
          break;
        }
        case 'group': {
          const ids = refs(o.ids);
          need(ids.length, 'group needs ids');
          idsExist(doc, ids);
          if (o.color) need(GROUP_COLORS.includes(o.color), `color must be one of ${GROUP_COLORS.join(', ')}`);
          const g = groupItems(doc, ids, { name: o.name || 'Group', color: o.color, by });
          if (o.as) named.set(o.as, g.id);
          created.push(g.id);
          log.push(`group ${g.id} "${g.name}" (${ids.length} items)`);
          break;
        }
        case 'set': {
          const id = ref(o.id);
          const { op, id: _id, ...fields } = o;
          if (id === 'canvas') {
            need(typeof fields.title === 'string', 'set canvas: only title');
            doc.title = fields.title;
            log.push('set canvas title');
            break;
          }
          idsExist(doc, [id]);
          const item = byId(doc).get(id);
          const patch = cleanPatch(doc, fields, item);
          // a stroke's new width / tool: measure its frame again (width in board units)
          if (item.type === 'stroke' && (patch.width !== undefined || patch.tool !== undefined)) {
            const { width, tool, ...rest } = patch;
            const n = reframe(item, { ...(width !== undefined ? { width } : {}), ...(tool !== undefined ? { tool } : {}) });
            doc.items = doc.items.map((it) => (it.id === id ? n : it));
            patchItems(doc, { [id]: rest }, by);
            if (n.parent) growGroup(doc, n.parent, n, { by });
          } else if (item.type === 'table') putTable(doc, { ...item, ...patch }, by);
          else patchItems(doc, { [id]: patch }, by);
          log.push(`set ${id}`);
          break;
        }
        case 'move': {
          const ids = refs(o.ids ?? o.id);
          need(ids.length, 'move needs ids');
          idsExist(doc, ids);
          if (o.dx !== undefined || o.dy !== undefined) moveItems(doc, ids, Number(o.dx) || 0, Number(o.dy) || 0, by);
          else {
            const m = byId(doc);
            const b = unionBounds(ids.map((id) => itemBounds(m.get(id))));
            moveItems(doc, ids, (o.x ?? b.x) - b.x, (o.y ?? b.y) - b.y, by);
          }
          if (o.reparent !== false) reparent(doc, ids, by);
          log.push(`moved ${idList(ids)}`);
          break;
        }
        case 'rm': case 'remove': case 'delete': {
          const ids = refs(o.ids ?? o.id);
          need(ids.length, 'rm needs ids');
          idsExist(doc, ids);
          const gone = removeItems(doc, ids, { keepChildren: !!o.keepChildren, by });
          log.push(`removed ${idList([...gone])}`);
          break;
        }
        case 'ungroup': {
          const id = ref(o.id);
          idsExist(doc, [id]);
          ungroup(doc, id, by);
          log.push(`ungrouped ${id}`);
          break;
        }
        case 'arrange': {
          let ids = refs(o.ids ?? o.id);
          need(ids.length, 'arrange needs a group id or item ids');
          idsExist(doc, ids);
          const gid = ids.length === 1 && byId(doc).get(ids[0]).type === 'group' ? ids[0] : null;
          if (gid) ids = childrenOf(doc, gid).map((it) => it.id);
          arrangeItems(doc, ids, { by, width: o.width ? Number(o.width) : undefined, gap: o.gap !== undefined ? Number(o.gap) : undefined });
          if (gid) fitGroup(doc, gid, { by });
          log.push(`arranged ${ids.length} item(s)`);
          break;
        }
        case 'fit': {
          const id = ref(o.id);
          idsExist(doc, [id]);
          fitGroup(doc, id, { by });
          log.push(`fitted ${id}`);
          break;
        }
        case 'front': case 'back': {
          const ids = refs(o.ids ?? o.id);
          idsExist(doc, ids);
          restack(doc, ids, o.op, by);
          log.push(`${o.op}: ${idList(ids)}`);
          break;
        }
        default: throw new OpError(`unknown op "${o.op}" (add, note, shape, connect, stroke, video, table, cell, row, col, newgroup, group, set, move, rm, ungroup, arrange, fit, front, back)`);
      }
    } catch (e) {
      const err = new OpError(`op #${i} (${o?.op}): ${e.message}`);
      err.index = i;
      throw err;
    }
  }
  refreshConnectors(doc);
  return { created, log };
}

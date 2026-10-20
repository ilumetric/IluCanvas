// The canvas document (canvas.json inside a .ilucanvas file): normalize,
// validate, serialize and the editing operations shared by the app and the CLI.
// No DOM, no Node APIs.
//
// Items are immutable: every change replaces the item object (so an undo step
// can keep the old `items` array as it is). `items` order is the stacking
// order; groups are always drawn below images, outer groups below the groups
// nested in them. An item (or a group) belongs to the group named by `parent`.

export const FORMAT = 'ilucanvas';
export const FORMAT_VERSION = 1;
export const GROUP_COLORS = ['violet', 'blue', 'orange', 'green', 'pink', 'yellow', 'red', 'amber', 'grey'];
export const ITEM_TYPES = ['image', 'group', 'note'];
/** Note papers: stickies, `paper` for documents, `none` for text straight on the board. */
export const NOTE_COLORS = ['yellow', 'orange', 'pink', 'green', 'blue', 'violet', 'grey', 'paper', 'none'];
export const NOTE_SIZES = ['s', 'm', 'l', 'xl'];
export const NOTE_RATIOS = ['free', 'square', 'a4', 'wide'];
export const NOTE_ALIGNS = ['left', 'center', 'right'];
/** Height / width of each ratio (free: any). */
export const RATIO_K = { square: 1, a4: Math.SQRT2, wide: 9 / 16 };
export const MAX_COORD = 1e9;

const ITEM_KEYS = {
  image: ['id', 'type', 'asset', 'x', 'y', 'w', 'h', 'rot', 'flipX', 'flipY', 'crop', 'parent', 'locked', 'opacity', 'note'],
  group: ['id', 'type', 'name', 'color', 'x', 'y', 'w', 'h', 'parent', 'locked', 'note'],
  note: ['id', 'type', 'x', 'y', 'w', 'h', 'rot', 'color', 'fit', 'size', 'scale', 'align', 'ratio', 'parent', 'locked', 'text'],
};
const ASSET_KEYS = ['file', 'type', 'w', 'h', 'bytes', 'sha256', 'thumb', 'color', 'name', 'source', 'added'];
const DOC_KEYS = ['format', 'version', 'id', 'title', 'created', 'updated', 'updated_by', 'generator', 'assets', 'items'];

// ---- ids --------------------------------------------------------------------------------------

const rand = (n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
  return s;
};
/** "i" / "g" + 7 chars: short enough to type, random enough not to clash with the CLI. */
export const newId = (type = 'image') => `${type === 'group' ? 'g' : type.charAt(0)}${rand(7)}`;
export const newCanvasId = () => `c${rand(11)}`;
/** Asset ids are content addresses: the first 16 hex digits of the file's SHA-256. */
export const assetIdFromSha = (sha256) => sha256.slice(0, 16);
export const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ---- create / normalize ---------------------------------------------------------------------------

export function emptyCanvas({ title = 'Canvas', by = 'human' } = {}) {
  const t = now();
  return { format: FORMAT, version: FORMAT_VERSION, id: newCanvasId(), title, created: t, updated: t, updated_by: by, assets: {}, items: [] };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-MAX_COORD, Math.min(MAX_COORD, v)) : d);
const pos = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(MAX_COORD, v) : d);
const str = (v) => (typeof v === 'string' ? v : null);

/** A clean document from parsed JSON (or a JSON string). Unknown fields are kept. */
export function normalize(raw) {
  const src = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('canvas.json is not an object');
  const doc = { ...src };
  doc.format = src.format || FORMAT;
  doc.version = Number.isInteger(src.version) ? src.version : FORMAT_VERSION;
  doc.id = str(src.id) || newCanvasId();
  doc.title = str(src.title) ?? 'Canvas';
  doc.assets = {};
  for (const [id, a] of Object.entries(src.assets && typeof src.assets === 'object' ? src.assets : {})) {
    if (!a || typeof a !== 'object') continue;
    doc.assets[id] = { ...a, w: pos(a.w, 0) || 0, h: pos(a.h, 0) || 0 };
  }
  const seen = new Set();
  const items = [];
  for (const it of Array.isArray(src.items) ? src.items : []) {
    if (!it || typeof it !== 'object') continue;
    const n = { ...it };
    if (typeof n.id !== 'string' || !n.id || seen.has(n.id)) n.id = newId(n.type || 'item');
    seen.add(n.id);
    n.x = num(n.x);
    n.y = num(n.y);
    n.w = pos(n.w, 100);
    n.h = pos(n.h, 100);
    if (n.rot !== undefined) n.rot = ((num(n.rot) % 360) + 360) % 360;
    if (!n.rot) delete n.rot;
    for (const k of ['flipX', 'flipY', 'locked']) if (n[k] !== true) delete n[k];
    if (n.type === 'image' && n.crop) {
      const c = n.crop;
      if (typeof c !== 'object' || !(c.w > 0) || !(c.h > 0)) delete n.crop;
      else n.crop = { x: num(c.x), y: num(c.y), w: pos(c.w), h: pos(c.h) };
    }
    if (n.type === 'note') {
      n.text = typeof n.text === 'string' ? n.text : '';
      if (!NOTE_COLORS.includes(n.color)) n.color = 'yellow';
      if (n.fit !== true) delete n.fit;
      if (!NOTE_SIZES.includes(n.size) || n.size === 'm') delete n.size;
      if (!(n.scale > 0) || n.scale === 1) delete n.scale;
      if (!NOTE_RATIOS.includes(n.ratio) || n.ratio === 'free') delete n.ratio;
      if (!NOTE_ALIGNS.includes(n.align) || n.align === 'left') delete n.align;
    }
    if (n.type === 'group') {
      n.name = str(n.name) ?? 'Group';
      if (!GROUP_COLORS.includes(n.color)) n.color = 'grey';
    }
    if (n.opacity !== undefined && !(n.opacity >= 0 && n.opacity < 1)) delete n.opacity;
    items.push(n);
  }
  const groups = new Set(items.filter((i) => i.type === 'group').map((i) => i.id));
  for (const it of items) if (it.parent !== undefined && (!groups.has(it.parent) || it.parent === it.id)) delete it.parent;
  // a group inside itself (a cycle of parents) would never be drawn: break it
  const parentOf = new Map(items.map((i) => [i.id, i.parent]));
  for (const it of items) {
    if (it.type !== 'group' || !it.parent) continue;
    const seen = new Set([it.id]);
    for (let p = it.parent; p; p = parentOf.get(p)) {
      if (seen.has(p)) { delete it.parent; parentOf.set(it.id, undefined); break; }
      seen.add(p);
    }
  }
  doc.items = items;
  return doc;
}

// ---- validate --------------------------------------------------------------------------------------

/** { ok, errors: [{ id?, path, msg }], warnings } — errors make the file unusable by other tools. */
export function validate(doc, { files = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, msg, id) => errors.push({ path, msg, id });
  const warn = (path, msg, id) => warnings.push({ path, msg, id });
  if (doc.format !== FORMAT) err('format', `must be "${FORMAT}"`);
  if (doc.version > FORMAT_VERSION) warn('version', `written by a newer IluCanvas (format ${doc.version}); unknown fields are kept`);
  for (const [id, a] of Object.entries(doc.assets || {})) {
    const p = `assets.${id}`;
    if (typeof a.file !== 'string' || !a.file) err(`${p}.file`, 'missing', id);
    else if (files && !files.has(a.file)) err(`${p}.file`, `"${a.file}" is not in the file`, id);
    if (!(a.w > 0 && a.h > 0)) warn(`${p}.w`, 'size unknown', id);
    if (a.thumb && files && !files.has(a.thumb)) warn(`${p}.thumb`, `"${a.thumb}" is missing (will be regenerated)`, id);
  }
  const ids = new Set();
  const groups = new Set();
  for (const it of doc.items || []) if (it.type === 'group') groups.add(it.id);
  const used = new Set();
  (doc.items || []).forEach((it, i) => {
    const p = `items[${i}]`;
    if (ids.has(it.id)) err(`${p}.id`, `duplicate id "${it.id}"`, it.id);
    ids.add(it.id);
    if (!ITEM_TYPES.includes(it.type)) warn(`${p}.type`, `unknown type "${it.type}" (kept, not editable here)`, it.id);
    if (it.type === 'note' && typeof it.text !== 'string') err(`${p}.text`, 'must be a string (Markdown)', it.id);
    if (it.type === 'image') {
      if (!doc.assets?.[it.asset]) err(`${p}.asset`, `unknown asset "${it.asset}"`, it.id);
      used.add(it.asset);
    }
    if (it.parent !== undefined && !groups.has(it.parent)) err(`${p}.parent`, `unknown group "${it.parent}"`, it.id);
    if (it.type === 'group' && it.parent && depthOf(doc, it.id) < 0) err(`${p}.parent`, 'groups inside each other in a circle', it.id);
    for (const k of ['x', 'y', 'w', 'h']) if (typeof it[k] !== 'number' || !Number.isFinite(it[k])) err(`${p}.${k}`, 'must be a number', it.id);
    if (!(it.w > 0) || !(it.h > 0)) err(`${p}.w`, 'w and h must be > 0', it.id);
  });
  for (const id of Object.keys(doc.assets || {})) if (!used.has(id)) warn(`assets.${id}`, 'not used by any item', id);
  return { ok: errors.length === 0, errors, warnings };
}

// ---- serialize ---------------------------------------------------------------------------------------

function ordered(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out) && obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return out;
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
function roundItem(it) {
  const o = { ...it };
  for (const k of ['x', 'y', 'w', 'h', 'rot']) if (typeof o[k] === 'number') o[k] = round(o[k]);
  if (o.crop) o.crop = { x: round(o.crop.x), y: round(o.crop.y), w: round(o.crop.w), h: round(o.crop.h) };
  return o;
}

/** canvas.json text: header fields one per line, one line per asset and per item. */
export function serialize(doc) {
  const head = ordered({ ...doc, assets: undefined, items: undefined }, DOC_KEYS);
  const lines = ['{'];
  for (const [k, v] of Object.entries(head)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const assets = Object.entries(doc.assets || {});
  lines.push(`  "assets": {${assets.length ? '' : '},'}`);
  assets.forEach(([id, a], i) => lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(ordered(a, ASSET_KEYS))}${i < assets.length - 1 ? ',' : ''}`));
  if (assets.length) lines.push('  },');
  const items = doc.items || [];
  lines.push(`  "items": [${items.length ? '' : ']'}`);
  items.forEach((it, i) => lines.push(`    ${JSON.stringify(ordered(roundItem(it), ITEM_KEYS[it.type] || ['id', 'type']))}${i < items.length - 1 ? ',' : ''}`));
  if (items.length) lines.push('  ]');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

// ---- geometry -------------------------------------------------------------------------------------------

/** Axis-aligned bounds of an item (rotation included). */
export function itemBounds(it) {
  if (!it.rot) return { x: it.x, y: it.y, w: it.w, h: it.h };
  const a = (it.rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const w = it.w * c + it.h * s;
  const h = it.w * s + it.h * c;
  return { x: it.x + it.w / 2 - w / 2, y: it.y + it.h / 2 - h / 2, w, h };
}

export function unionBounds(list) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const b of list) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const contentBounds = (doc) => unionBounds((doc.items || []).map(itemBounds));
export const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const contains = (b, p) => p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
export const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- lookups ----------------------------------------------------------------------------------------------

const indexCache = new WeakMap();
/** Map id → item, cached per `items` array. */
export function byId(doc) {
  let m = indexCache.get(doc.items);
  if (!m) { m = new Map(doc.items.map((it) => [it.id, it])); indexCache.set(doc.items, m); }
  return m;
}
export const childrenOf = (doc, gid) => doc.items.filter((it) => it.parent === gid);
export const groupsOf = (doc) => doc.items.filter((it) => it.type === 'group');

/** How deep a group is nested: 0 for a top-level one; -1 for a cycle. */
export function depthOf(doc, id) {
  const m = byId(doc);
  let d = 0;
  const seen = new Set([id]);
  for (let p = m.get(id)?.parent; p; p = m.get(p)?.parent) {
    if (seen.has(p)) return -1;
    seen.add(p);
    d++;
  }
  return d;
}

/** Groups in drawing order: outer ones first, then by their place in the list. */
export function groupsByDepth(doc) {
  const gs = doc.items.filter((it) => it.type === 'group');
  const depth = new Map(gs.map((g) => [g.id, depthOf(doc, g.id)]));
  const index = new Map(gs.map((g, i) => [g.id, i]));
  return gs.sort((a, b) => depth.get(a.id) - depth.get(b.id) || index.get(a.id) - index.get(b.id));
}

/** The ids plus everything inside any groups among them (nested groups too). */
export function withChildren(doc, ids) {
  const set = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const it of doc.items) if (it.parent && set.has(it.parent) && !set.has(it.id)) { set.add(it.id); grew = true; }
  }
  return set;
}

/** Keep only the outermost of `ids`: drop those inside another one of them. */
export function outermost(doc, ids) {
  const set = new Set(ids);
  const m = byId(doc);
  return [...set].filter((id) => {
    const seen = new Set();
    for (let p = m.get(id)?.parent; p && !seen.has(p); p = m.get(p)?.parent) {
      if (set.has(p)) return false;
      seen.add(p);
    }
    return true;
  });
}

/** Is `id` inside group `gid` (at any depth)? */
export function isInside(doc, id, gid) {
  const m = byId(doc);
  const seen = new Set();
  for (let p = m.get(id)?.parent; p && !seen.has(p); p = m.get(p)?.parent) {
    if (p === gid) return true;
    seen.add(p);
  }
  return false;
}

export function usedAssets(doc) {
  const s = new Set();
  for (const it of doc.items) if (it.type === 'image' && it.asset) s.add(it.asset);
  return s;
}

/** Drop assets no item uses (except `keep` ids). Returns the dropped ids; doc.assets is replaced, not mutated. */
export function pruneAssets(doc, keep = new Set()) {
  const used = usedAssets(doc);
  const gone = Object.keys(doc.assets).filter((id) => !used.has(id) && !keep.has(id));
  if (gone.length) {
    const next = { ...doc.assets };
    for (const id of gone) delete next[id];
    doc.assets = next;
  }
  return gone;
}

// ---- edits (return a new `items` array; callers assign it) -----------------------------------------------------

const touch = (doc, by) => { doc.updated = now(); doc.updated_by = by; };

/** Replace items by id with patched copies. `patches`: Map|object id → patch (undefined fields are removed). */
export function patchItems(doc, patches, by = 'human') {
  const map = patches instanceof Map ? patches : new Map(Object.entries(patches));
  if (!map.size) return doc.items;
  doc.items = doc.items.map((it) => {
    const p = map.get(it.id);
    if (!p) return it;
    const n = { ...it, ...p };
    for (const [k, v] of Object.entries(p)) if (v === undefined || v === null || v === false) delete n[k];
    return n;
  });
  touch(doc, by);
  return doc.items;
}

/** Move items (and the children of moved groups) by dx, dy. */
export function moveItems(doc, ids, dx, dy, by = 'human') {
  const set = withChildren(doc, ids);
  const patches = new Map();
  for (const it of doc.items) if (set.has(it.id) && !it.locked) patches.set(it.id, { x: it.x + dx, y: it.y + dy });
  return patchItems(doc, patches, by);
}

export function addItems(doc, items, by = 'human') {
  doc.items = [...doc.items, ...items];
  touch(doc, by);
  return items;
}

/**
 * Remove items; removing a group removes what is inside it unless
 * `keepChildren` — then its items move up to the group's own parent.
 */
export function removeItems(doc, ids, { keepChildren = false, by = 'human' } = {}) {
  const set = keepChildren ? new Set(ids) : withChildren(doc, ids);
  const m = byId(doc);
  const upTo = (p) => { while (p && set.has(p)) p = m.get(p)?.parent; return p; };
  doc.items = doc.items.filter((it) => !set.has(it.id)).map((it) => {
    if (!it.parent || !set.has(it.parent)) return it;
    const p = upTo(it.parent);
    return p ? { ...it, parent: p } : dropKey(it, 'parent');
  });
  touch(doc, by);
  return set;
}

const dropKey = (it, k) => { const n = { ...it }; delete n[k]; return n; };

/** Put `ids` on top (end of the list) or at the bottom. */
export function restack(doc, ids, where = 'front', by = 'human') {
  const set = new Set(ids);
  const moving = doc.items.filter((it) => set.has(it.id));
  const rest = doc.items.filter((it) => !set.has(it.id));
  doc.items = where === 'front' ? [...rest, ...moving] : [...moving, ...rest];
  touch(doc, by);
  return doc.items;
}

/** Wrap items in a new group frame (padding around their bounds). Returns the group. */
export function groupItems(doc, ids, { name = 'Group', color, padding, by = 'human' } = {}) {
  const map = byId(doc);
  // members must not contain each other: keep the outermost
  const members = outermost(doc, ids).map((id) => map.get(id)).filter(Boolean);
  const b = unionBounds(members.map(itemBounds)) || { x: 0, y: 0, w: 400, h: 300 };
  const pad = padding ?? Math.max(16, Math.round(Math.max(b.w, b.h) * 0.04));
  const used = new Set(groupsOf(doc).map((g) => g.color));
  const g = {
    id: newId('group'), type: 'group', name,
    color: color || GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[groupsOf(doc).length % GROUP_COLORS.length],
    x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2,
  };
  // made inside a group (all members in the same one): the new group nests there
  const parents = new Set(members.map((it) => it.parent));
  if (parents.size === 1 && [...parents][0]) g.parent = [...parents][0];
  const set = new Set(members.map((it) => it.id));
  doc.items = [g, ...doc.items.map((it) => (set.has(it.id) ? { ...it, parent: g.id } : it))];
  touch(doc, by);
  return g;
}

/** Remove a group frame, keeping its items (they move up to its parent). */
export function ungroup(doc, gid, by = 'human') {
  return removeItems(doc, [gid], { keepChildren: true, by });
}

/** The innermost group under a point (not one of `exclude`, nor inside them). */
export function groupAtPoint(doc, p, exclude = new Set(), gs = groupsByDepth(doc)) {
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i];
    if (exclude.has(g.id) || [...exclude].some((x) => isInside(doc, g.id, x))) continue;
    if (contains(g, p)) return g;
  }
  return null;
}

/**
 * After a drop: each moved item (or group) joins the innermost group under its
 * centre (or leaves its group), and that group grows to contain it.
 */
export function reparent(doc, ids, by = 'human') {
  const moved = new Set(ids);
  const patches = new Map();
  const grow = new Map();
  const gs = groupsByDepth(doc);
  for (const it of doc.items) {
    if (!moved.has(it.id)) continue;
    if (it.parent && moved.has(it.parent)) continue; // travelled with its group
    const c = center(itemBounds(it));
    let target = groupAtPoint(doc, c, new Set([it.id]), gs);
    if (target && it.type === 'group' && target.w * target.h <= it.w * it.h) target = null; // a group never goes into a smaller one
    if ((target?.id ?? undefined) !== it.parent) patches.set(it.id, { parent: target ? target.id : undefined });
    if (target) {
      const b = itemBounds(it);
      const cur = grow.get(target.id) || { x: target.x, y: target.y, w: target.w, h: target.h };
      const pad = 16;
      const u = unionBounds([cur, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }]);
      if (u.w > cur.w + 0.01 || u.h > cur.h + 0.01) grow.set(target.id, u);
    }
  }
  for (const [gid, b] of grow) patches.set(gid, { ...(patches.get(gid) || {}), ...b });
  if (patches.size) patchItems(doc, patches, by);
  return patches;
}

/** Fit a group's frame around its items. */
export function fitGroup(doc, gid, { padding, by = 'human' } = {}) {
  const kids = childrenOf(doc, gid);
  const b = unionBounds(kids.map(itemBounds));
  if (!b) return null;
  const pad = padding ?? Math.max(16, Math.round(Math.max(b.w, b.h) * 0.04));
  const r = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  patchItems(doc, { [gid]: r }, by);
  return r;
}

// ---- layout ----------------------------------------------------------------------------------------------

/**
 * Justified rows (like a photo grid): every row has the same width, images
 * keep their aspect. `rects`: [{ id, w, h }] → Map id → { x, y, w, h } from (x0, y0).
 * `width` defaults to what makes the block roughly as wide as `aspect` × tall.
 */
export function arrangeRows(rects, { x0 = 0, y0 = 0, gap, width, aspect = 1.6, rowHeight } = {}) {
  const out = new Map();
  if (!rects.length) return out;
  const hs = rects.map((r) => r.h).sort((a, b) => a - b);
  const rh = rowHeight || hs[Math.floor(hs.length / 2)] || 100;
  const items = rects.map((r) => ({ id: r.id, ar: r.w / r.h || 1 }));
  const totalW = items.reduce((n, it) => n + it.ar * rh, 0);
  const g = gap ?? Math.round(rh * 0.06);
  const W = width || Math.max(rh * Math.max(...items.map((i) => i.ar)), Math.sqrt(totalW * rh * aspect));
  let y = y0;
  let row = [];
  let rowAr = 0;
  const flush = (last) => {
    if (!row.length) return;
    const avail = W - g * (row.length - 1);
    let h = avail / rowAr;
    if (last && h > rh * 1.15) h = rh; // a short last row keeps the usual height
    let x = x0;
    for (const it of row) {
      const w = it.ar * h;
      out.set(it.id, { x, y, w, h });
      x += w + g;
    }
    y += h + g;
    row = [];
    rowAr = 0;
  };
  for (const it of items) {
    row.push(it);
    rowAr += it.ar;
    if (rowAr * rh + g * (row.length - 1) >= W) flush(false);
  }
  flush(true);
  return out;
}

/** Arrange items in place (their current top-left stays put); groups are refitted. */
export function arrangeItems(doc, ids, { by = 'human', ...opts } = {}) {
  const map = byId(doc);
  const list = ids.map((id) => map.get(id)).filter((it) => it && it.type === 'image' && !it.locked);
  if (!list.length) return new Map();
  const b = unionBounds(list.map(itemBounds));
  const layout = arrangeRows(list.map((it) => ({ id: it.id, w: it.w, h: it.h })), { x0: b.x, y0: b.y, ...opts });
  const patches = new Map();
  for (const [id, r] of layout) patches.set(id, { ...r, rot: undefined });
  patchItems(doc, patches, by);
  return layout;
}

/** Positions for `sizes` ([{ w, h }]) dropped at a point: one row or a grid, centred on (cx, cy). */
export function dropLayout(sizes, cx, cy, { gap = 24 } = {}) {
  const rects = sizes.map((s, i) => ({ id: i, w: s.w, h: s.h }));
  const layout = arrangeRows(rects, { gap, rowHeight: Math.min(...sizes.map((s) => s.h)) });
  const b = unionBounds([...layout.values()]);
  return sizes.map((_, i) => {
    const r = layout.get(i);
    return { x: cx - b.w / 2 + r.x, y: cy - b.h / 2 + r.y, w: r.w, h: r.h };
  });
}

/** Display size for a new image: natural size, longest side capped. */
export function fitSize(w, h, max = 1200) {
  if (!(w > 0 && h > 0)) return { w: max, h: max * 0.75 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

// ---- assets ----------------------------------------------------------------------------------------------

/** A file name for images/ that is safe on every OS and unique among `taken`. */
export function assetPath(name, ext, taken) {
  let base = String(name || 'image').replace(/\.[^.]{1,5}$/, '');
  base = base.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || 'image';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
  let path = `images/${base}.${ext}`;
  for (let i = 2; taken.has(path.toLowerCase()); i++) path = `images/${base} (${i}).${ext}`;
  taken.add(path.toLowerCase());
  return path;
}

export const takenPaths = (doc) => new Set(Object.values(doc.assets).map((a) => String(a.file).toLowerCase()));

// ---- merge ----------------------------------------------------------------------------------------------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge by item / asset id: changes from `theirs` (the file on disk)
 * and `ours` (the open canvas) since `base`. Where both changed the same item,
 * ours wins and the id is reported. Order follows theirs, with our new items on top.
 */
export function merge3(base, ours, theirs) {
  const conflicts = [];
  const bMap = new Map(base.items.map((i) => [i.id, i]));
  const oMap = new Map(ours.items.map((i) => [i.id, i]));
  const tMap = new Map(theirs.items.map((i) => [i.id, i]));
  const out = [];
  const placed = new Set();
  for (const t of theirs.items) {
    const b = bMap.get(t.id);
    const o = oMap.get(t.id);
    if (!b) { out.push(o && !same(o, t) ? (conflicts.push(t.id), o) : t); placed.add(t.id); continue; }
    if (!o) { if (!same(b, t)) { conflicts.push(t.id); out.push(t); placed.add(t.id); } continue; } // we deleted it; keep theirs if they edited
    const oChanged = !same(o, b);
    const tChanged = !same(t, b);
    if (oChanged && tChanged && !same(o, t)) conflicts.push(t.id);
    out.push(oChanged ? o : t);
    placed.add(t.id);
  }
  for (const o of ours.items) {
    if (placed.has(o.id)) continue;
    if (bMap.has(o.id) && !tMap.has(o.id)) { if (!same(o, bMap.get(o.id))) { conflicts.push(o.id); out.push(o); } continue; } // they deleted it
    if (!bMap.has(o.id)) out.push(o); // ours, new
  }
  const assets = { ...theirs.assets };
  for (const [id, a] of Object.entries(ours.assets)) if (!assets[id]) assets[id] = a;
  const groups = new Set(out.filter((i) => i.type === 'group').map((i) => i.id));
  const items = out.map((it) => (it.parent && !groups.has(it.parent) ? dropKey(it, 'parent') : it));
  const title = ours.title !== base.title ? ours.title : theirs.title;
  return { doc: { ...theirs, title, assets, items }, conflicts };
}

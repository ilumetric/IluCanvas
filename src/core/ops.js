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

import {
  GROUP_COLORS, byId, itemBounds, unionBounds, contentBounds, childrenOf, groupsOf, moveItems, patchItems,
  removeItems, groupItems, ungroup, fitGroup, arrangeItems, arrangeRows, addItems, newId, fitSize, restack, reparent,
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
};
export const EDITABLE_KEYS = Object.keys(EDITABLE);

/** A checked patch from loose input (strings from the command line, JSON from agents). */
export function cleanPatch(doc, input) {
  const patch = {};
  for (const [k, raw] of Object.entries(input)) {
    const t = EDITABLE[k];
    need(t, `unknown field "${k}" (editable: ${EDITABLE_KEYS.join(', ')})`);
    if (raw === null || raw === '') { patch[k] = undefined; continue; }
    if (t === 'num' || t === 'pos') {
      const n = Number(raw);
      need(Number.isFinite(n) && (t === 'num' || n > 0), `${k} must be a ${t === 'pos' ? 'positive ' : ''}number`);
      patch[k] = n;
    } else if (t === 'bool') patch[k] = raw === true || raw === 'true' || raw === 1 || raw === '1' ? true : undefined;
    else if (t === 'color') { need(GROUP_COLORS.includes(raw), `color must be one of ${GROUP_COLORS.join(', ')}`); patch[k] = raw; }
    else if (t === 'ref') {
      const g = byId(doc).get(raw);
      need(g && g.type === 'group', `parent "${raw}" is not a group`);
      patch[k] = raw;
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
export async function applyOps(doc, ops, { by = 'agent', addImages } = {}) {
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
          patchItems(doc, { [id]: cleanPatch(doc, fields) }, by);
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
        default: throw new OpError(`unknown op "${o.op}" (add, newgroup, group, set, move, rm, ungroup, arrange, fit, front, back)`);
      }
    } catch (e) {
      const err = new OpError(`op #${i} (${o?.op}): ${e.message}`);
      err.index = i;
      throw err;
    }
  }
  return { created, log };
}

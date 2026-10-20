import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCanvas, normalize, validate, serialize, groupItems, ungroup, removeItems, reparent, withChildren, moveItems,
  arrangeRows, merge3, assetPath, depthOf, groupsByDepth, itemBounds, pruneAssets,
} from '../src/core/model.js';

function sample() {
  const d = emptyCanvas({ title: 'T' });
  d.assets.a = { file: 'images/a.jpg', type: 'image/jpeg', w: 400, h: 300 };
  d.items = [
    { id: 'i1', type: 'image', asset: 'a', x: 0, y: 0, w: 400, h: 300 },
    { id: 'i2', type: 'image', asset: 'a', x: 500, y: 0, w: 400, h: 300 },
    { id: 'i3', type: 'image', asset: 'a', x: 2000, y: 0, w: 400, h: 300 },
  ];
  return d;
}

test('normalize keeps unknown fields, fixes bad values and parents', () => {
  const d = normalize({ format: 'ilucanvas', version: 1, assets: {}, items: [
    { id: 'x', type: 'image', asset: 'a', x: 'oops', y: 5, w: -3, h: 10, custom: 1, parent: 'nope' },
    { id: 'x', type: 'future-thing', x: 1, y: 2, w: 3, h: 4 },
  ], extra: { keep: true } });
  assert.equal(d.items[0].x, 0);
  assert.equal(d.items[0].w, 100);
  assert.equal(d.items[0].custom, 1);
  assert.equal(d.items[0].parent, undefined);
  assert.notEqual(d.items[1].id, 'x', 'duplicate id replaced');
  assert.deepEqual(d.extra, { keep: true });
  assert.ok(validate(d).warnings.some((w) => /unknown type/.test(w.msg)));
});

test('serialize: one line per item, round trip', () => {
  const d = sample();
  const text = serialize(d);
  assert.equal(text.split('\n').filter((l) => l.includes('"type":"image"')).length, 3);
  assert.deepEqual(normalize(text).items, d.items);
});

test('groups nest: create inside a group, move together, ungroup to the parent', () => {
  const d = sample();
  const outer = groupItems(d, ['i1', 'i2', 'i3'], { name: 'Outer' });
  const inner = groupItems(d, ['i1', 'i2'], { name: 'Inner' });
  assert.equal(inner.parent, outer.id, 'made inside Outer, so it nests there');
  assert.equal(depthOf(d, inner.id), 1);
  assert.deepEqual(groupsByDepth(d).map((g) => g.name), ['Outer', 'Inner']);
  assert.deepEqual([...withChildren(d, [outer.id])].sort(), [inner.id, outer.id, 'i1', 'i2', 'i3'].sort());
  moveItems(d, [outer.id], 10, 20);
  assert.equal(d.items.find((i) => i.id === 'i1').x, 10);
  ungroup(d, inner.id);
  assert.equal(d.items.find((i) => i.id === 'i1').parent, outer.id, 'children move up to the outer group');
  removeItems(d, [outer.id]);
  assert.equal(d.items.length, 0, 'removing a group removes what is inside');
});

test('reparent: dropped into the innermost group, which grows; cycles are refused', () => {
  const d = sample();
  const g = groupItems(d, ['i1'], { name: 'G' });
  d.items = d.items.map((it) => (it.id === 'i2' ? { ...it, x: g.x + 10, y: g.y + 10 } : it));
  reparent(d, ['i2']);
  const i2 = d.items.find((i) => i.id === 'i2');
  assert.equal(i2.parent, g.id);
  const g2 = d.items.find((i) => i.id === g.id);
  assert.ok(g2.x + g2.w >= i2.x + i2.w, 'group grew to contain it');
  // a cycle in a file is broken on load
  const cyc = normalize({ format: 'ilucanvas', assets: {}, items: [
    { id: 'a', type: 'group', x: 0, y: 0, w: 10, h: 10, parent: 'b' },
    { id: 'b', type: 'group', x: 0, y: 0, w: 10, h: 10, parent: 'a' },
  ] });
  assert.ok(cyc.items.some((i) => !i.parent));
  assert.ok(validate(cyc).ok);
});

test('arrangeRows: rows of equal width, aspect kept', () => {
  const rects = [{ id: 1, w: 400, h: 300 }, { id: 2, w: 300, h: 400 }, { id: 3, w: 800, h: 200 }, { id: 4, w: 100, h: 100 }];
  const out = arrangeRows(rects, { width: 1000, gap: 0 });
  for (const r of rects) {
    const o = out.get(r.id);
    assert.ok(Math.abs(o.w / o.h - r.w / r.h) < 1e-9, 'aspect kept');
  }
  assert.ok([...out.values()].every((o) => o.x >= 0 && o.x + o.w <= 1000.001));
});

test('merge3: both sides edit different items; same item → ours wins and is reported', () => {
  const base = sample();
  const ours = normalize(serialize(base));
  const theirs = normalize(serialize(base));
  ours.items = ours.items.map((i) => (i.id === 'i1' ? { ...i, x: 111 } : i.id === 'i3' ? { ...i, y: 5 } : i));
  theirs.items = theirs.items.map((i) => (i.id === 'i2' ? { ...i, x: 222 } : i.id === 'i3' ? { ...i, y: 9 } : i));
  theirs.items.push({ id: 'i9', type: 'image', asset: 'a', x: 0, y: 900, w: 10, h: 10 });
  const { doc, conflicts } = merge3(base, ours, theirs);
  const get = (id) => doc.items.find((i) => i.id === id);
  assert.equal(get('i1').x, 111);
  assert.equal(get('i2').x, 222);
  assert.equal(get('i3').y, 5);
  assert.ok(get('i9'));
  assert.deepEqual(conflicts, ['i3']);
});

test('assetPath: safe, unique names for images/', () => {
  const taken = new Set();
  assert.equal(assetPath('кот: рыжий?.JPG', 'jpg', taken), 'images/кот_ рыжий_.jpg');
  assert.equal(assetPath('кот: рыжий?.png', 'jpg', taken), 'images/кот_ рыжий_ (2).jpg');
  assert.equal(assetPath('CON', 'png', taken), 'images/_CON.png');
  assert.equal(assetPath('', 'png', taken), 'images/image.png');
});

test('assetPath: a long name is cut between characters, never inside an emoji', () => {
  const p = assetPath(`${'a'.repeat(79)}\u{1F600}tail.png`, 'png', new Set());
  assert.equal(p, `images/${'a'.repeat(79)}\u{1F600}.png`);
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(p)), p, 'the same name in UTF-8 (the ZIP)');
  assert.equal(assetPath('half \ud83d here', 'png', new Set()), 'images/half _ here.png');
});

test('validate: asset paths must stay inside the file', () => {
  const d = sample();
  for (const [file, thumb] of [['images/../../x.png'], ['/etc/x.png'], ['images\\..\\x.png'], ['images/a.jpg', 'thumbs/../../t.webp']]) {
    d.assets.a = { file, thumb, type: 'image/png', w: 1, h: 1 };
    assert.ok(validate(d).errors.some((e) => /plain path inside the file/.test(e.msg)), `${file} ${thumb}`);
  }
  d.assets.a = { file: 'images/a b..c.jpg', thumb: 'thumbs/a.webp', w: 1, h: 1 };
  assert.ok(validate(d).ok);
});

test('newer versions: unknown null fields, assets of unknown item types, odd types are kept', () => {
  const d = normalize({ format: 'ilucanvas', future: null, assets: { a: { file: 'images/a.jpg', w: 1, h: 1, source: null }, z: { file: 'images/z.bin', w: 1, h: 1 } }, items: [
    { id: 'i1', type: 'image', asset: 'a', x: 0, y: 0, w: 1, h: 1, later: null },
    { id: 'w1', type: 'widget', asset: 'z', x: 0, y: 0, w: 1, h: 1 },
    { type: 5, x: 0, y: 0, w: 1, h: 1 },
  ] });
  const text = serialize(d);
  assert.match(text, /"future": null/);
  assert.match(text, /"later":null/);
  assert.doesNotMatch(text, /"source"/, 'a known field that is null is left out');
  assert.deepEqual(pruneAssets(d), [], 'the widget keeps its file');
  assert.ok(!validate(d).warnings.some((w) => /not used/.test(w.msg)));
  assert.equal(d.items.length, 3);
});

test('groups: connectors stay out, ungroup leaves other items alone, circles break at the circle', () => {
  const d = sample();
  d.items.push({ id: 'c', type: 'connector', from: { id: 'i1' }, to: { id: 'i2' }, x: 0, y: 0, w: 1, h: 1 });
  const g = groupItems(d, ['i1', 'c']);
  assert.equal(d.items.find((i) => i.id === 'c').parent, undefined);
  assert.equal(g.w, 400 + 2 * 16, 'the frame is around the image only');
  ungroup(d, 'i2');
  assert.ok(d.items.some((i) => i.id === 'i2'), 'not a group: not removed');
  const n = normalize({ format: 'ilucanvas', items: [
    { id: 'g0', type: 'group', parent: 'g1', x: 0, y: 0, w: 1, h: 1 },
    { id: 'g1', type: 'group', parent: 'g2', x: 0, y: 0, w: 1, h: 1 },
    { id: 'g2', type: 'group', parent: 'g1', x: 0, y: 0, w: 1, h: 1 },
  ] });
  assert.equal(n.items[0].parent, 'g1', 'g0 is only inside the circle: it stays where it was');
  assert.ok(validate(n).ok);
});

test('merge3: our restacking survives their edits (unless they restacked too)', () => {
  const mk = (items) => normalize({ format: 'ilucanvas', id: 'c1', title: 'T', items });
  const [A, B, C] = ['a', 'b', 'c'].map((id) => ({ id, type: 'note', text: id, x: 0, y: 0, w: 10, h: 10 }));
  const D = { id: 'd', type: 'note', text: 'd', x: 0, y: 0, w: 10, h: 10 };
  let r = merge3(mk([A, B, C]), mk([B, C, A]), mk([A, B, { ...C, text: 'c2' }, D]));
  assert.deepEqual(r.doc.items.map((i) => `${i.id}${i.text}`), ['bb', 'cc2', 'aa', 'dd']);
  r = merge3(mk([A, B, C]), mk([B, C, A]), mk([C, A, B]));
  assert.deepEqual(r.doc.items.map((i) => i.id), ['c', 'a', 'b'], 'both restacked: theirs');
});

test('itemBounds includes rotation', () => {
  const b = itemBounds({ x: 0, y: 0, w: 100, h: 50, rot: 90 });
  assert.ok(Math.abs(b.w - 50) < 1e-9 && Math.abs(b.h - 100) < 1e-9);
});

test('notes: defaults, colours, round trip, ops', async () => {
  const { applyOps } = await import('../src/core/ops.js');
  const d = emptyCanvas();
  const r = await applyOps(d, [
    { op: 'note', text: 'Sticky', as: '$s' },
    { op: 'note', text: '# Doc\nline', color: 'paper', x: 0, y: 0 },
    { op: 'note', text: 'label', color: 'none', size: 'xl', scale: 2 },
    { op: 'set', id: '$s', color: 'pink', align: 'center' },
  ]);
  const [s, doc, label] = r.created.map((id) => d.items.find((i) => i.id === id));
  assert.equal(s.fit, true);
  assert.equal(s.color, 'pink');
  assert.equal(s.align, 'center');
  assert.equal(doc.ratio, 'a4');
  assert.ok(Math.abs(doc.h - doc.w * Math.SQRT2) < 1);
  assert.equal(label.fit, undefined);
  assert.equal(label.scale, 2);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: s.id, color: 'paper2' }]), /color must be one of/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: s.id, size: 'huge' }]), /size must be one of/);
  // a group cannot take a note colour
  const g = groupItems(d, [s.id], { name: 'G' });
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: g.id, color: 'paper' }]), /color must be one of/);
  assert.ok(validate(d).ok);
  assert.deepEqual(normalize(serialize(d)).items, d.items);
  // defaults are not written
  const n = normalize({ format: 'ilucanvas', assets: {}, items: [{ id: 'n', type: 'note', x: 0, y: 0, w: 1, h: 1, size: 'm', align: 'left', ratio: 'free', scale: 1, fit: false }] }).items[0];
  assert.deepEqual(Object.keys(n).sort(), ['color', 'h', 'id', 'text', 'type', 'w', 'x', 'y']);
});

test('shapes and connectors: ops, defaults, ends follow items, delete detaches, copy remaps', async () => {
  const { applyOps } = await import('../src/core/ops.js');
  const { copyItems, refreshConnectors } = await import('../src/core/model.js');
  const d = emptyCanvas();
  const r = await applyOps(d, [
    { op: 'shape', kind: 'rounded', text: 'Start', x: 0, y: 0, as: '$a' },
    { op: 'shape', kind: 'diamond', text: 'Ok?', fill: 'yellow', x: 400, y: 0, as: '$b' },
    { op: 'connect', from: '$a', to: '$b', label: 'yes', route: 'elbow', as: '$c' },
    { op: 'connect', from: '$b', fromSide: 'bottom', to: { x: 450, y: 600 }, end: 'dot', dash: true },
  ]);
  const get = (id) => d.items.find((i) => i.id === id);
  const [a, b, c, c2] = r.created.map(get);
  assert.equal(a.w, 200); assert.equal(a.h, 120);
  assert.equal(b.h, 200, 'round kinds start square');
  assert.equal(a.fill, 'blue');
  assert.deepEqual(c.from, { id: a.id });
  assert.equal(c.route, 'elbow');
  assert.equal(c.end, 'arrow');
  assert.deepEqual(c2.from, { id: b.id, side: 'bottom' });
  assert.equal(c2.dash, true);
  // bounds of a connector span its path: from a's right side to b's left side
  assert.ok(c.x >= 199 && c.x + c.w <= 401, `bounds ${c.x} ${c.w}`);
  // moving an item drags the attached ends along
  moveItems(d, [b.id], 0, 300);
  assert.ok(get(c.id).y + get(c.id).h > 300, 'connector bounds follow the moved shape');
  // moving a connector moves only its free ends
  const freeBefore = get(c2.id).to;
  moveItems(d, [c2.id], 10, 10);
  assert.deepEqual(get(c2.id).to, { x: freeBefore.x + 10, y: freeBefore.y + 10 });
  assert.deepEqual(get(c2.id).from, { id: b.id, side: 'bottom' });
  // bad input is refused
  await assert.rejects(() => applyOps(d, [{ op: 'connect', from: a.id, to: c.id }]), /is a connector/);
  await assert.rejects(() => applyOps(d, [{ op: 'connect', from: a.id, to: b.id, fromSide: 'middle' }]), /side must be one of/);
  await assert.rejects(() => applyOps(d, [{ op: 'shape', kind: 'blob' }]), /kind must be one of/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: a.id, color: 'red' }]), /fill and stroke/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: c.id, to: null }]), /cannot be removed/);
  await applyOps(d, [{ op: 'set', id: a.id, fill: 'none', stroke: 'red', text: 'Begin' }, { op: 'set', id: c.id, color: 'blue', start: 'dot' }]);
  assert.equal(get(a.id).fill, 'none');
  assert.equal(get(c.id).color, 'blue');
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
  assert.deepEqual(normalize(serialize(d)).items, d.items, 'round trip');
  // copies: ends on copied items point at the copies, others at the originals
  const map = new Map([[a.id, 'a2'], [c.id, 'c2']]);
  const [, cc] = copyItems([get(a.id), get(c.id)], map, 0, 1000, { lookup: (id) => get(id) });
  assert.deepEqual(cc.from, { id: 'a2' });
  assert.deepEqual(cc.to, { id: b.id });
  const [, lone] = copyItems([get(a.id), get(c.id)], map, 0, 0, { lookup: () => null });
  assert.equal(lone.to.id, undefined, 'pasted elsewhere: an end on a missing item becomes a point');
  // deleting a shape turns the ends on it into points where they were
  const end = get(c.id).to;
  removeItems(d, [b.id]);
  refreshConnectors(d);
  assert.equal(get(c.id).to.id, undefined);
  assert.ok(Number.isFinite(get(c.id).to.x));
  assert.equal(get(c2.id).from.id, undefined);
  assert.ok(end.id === b.id);
  assert.ok(validate(d).ok);
  // validate catches ends on unknown items and on the connector itself
  const bad = structuredClone(d);
  bad.items.find((i) => i.id === c.id).to = { id: 'nope' };
  bad.items.find((i) => i.id === c2.id).from = { id: c2.id };
  const errs = validate(bad).errors.map((e) => e.msg).join(' | ');
  assert.match(errs, /unknown item "nope"/);
  assert.match(errs, /cannot end on itself/);
  // normalize: an end on a missing item becomes a point; defaults are not written
  const n = normalize({ format: 'ilucanvas', assets: {}, items: [
    { id: 's', type: 'shape', kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'blue', text: '', align: 'center', size: 'm' },
    { id: 'k', type: 'connector', from: { id: 's', side: 'nowhere' }, to: { id: 'gone' }, route: 'straight', start: 'none', end: 'arrow', color: 'grey', width: 2, parent: 's', x: 0, y: 0, w: 5, h: 5 },
  ] }).items;
  assert.deepEqual(Object.keys(n[0]).sort(), ['fill', 'h', 'id', 'kind', 'text', 'type', 'w', 'x', 'y']);
  assert.deepEqual(n[1].from, { id: 's' });
  assert.deepEqual(n[1].to, { x: 5, y: 5 });
  assert.equal(n[1].route, undefined);
  assert.equal(n[1].parent, undefined);
});

test('shapes: outline width and dash', async () => {
  const { applyOps } = await import('../src/core/ops.js');
  const d = emptyCanvas();
  const r = await applyOps(d, [{ op: 'shape', kind: 'rect', fill: 'none', strokeWidth: 6, dash: true, as: '$s' }, { op: 'set', id: '$s', strokeWidth: 3 }]);
  const s = d.items.find((i) => i.id === r.created[0]);
  assert.equal(s.strokeWidth, 3);
  assert.equal(s.dash, true);
  await applyOps(d, [{ op: 'set', id: s.id, dash: false, strokeWidth: null }]);
  const s2 = d.items.find((i) => i.id === s.id);
  assert.equal(s2.dash, undefined);
  assert.equal(s2.strokeWidth, undefined);
  const n = normalize({ format: 'ilucanvas', assets: {}, items: [{ id: 'a', type: 'shape', kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'none', text: '', strokeWidth: -2, dash: 'yes' }] }).items[0];
  assert.equal(n.strokeWidth, undefined);
  assert.equal(n.dash, undefined);
});

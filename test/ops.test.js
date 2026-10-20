import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, validate, serialize } from '../src/core/model.js';
import { applyOps } from '../src/core/ops.js';
import { listText } from '../src/core/describe.js';

/** Groups g1 ⊃ g2 ⊃ n1; n2 and an image outside; a connector n1 → n2. */
const board = () => normalize({ format: 'ilucanvas', assets: { a: { file: 'images/a.jpg', w: 400, h: 300 } }, items: [
  { id: 'g1', type: 'group', name: 'A', color: 'blue', x: 0, y: 0, w: 1000, h: 1000 },
  { id: 'g2', type: 'group', name: 'B', color: 'red', x: 10, y: 10, w: 500, h: 500, parent: 'g1' },
  { id: 'n1', type: 'note', text: 'x', x: 20, y: 20, w: 100, h: 100, parent: 'g2' },
  { id: 'n2', type: 'note', text: 'y', x: 2000, y: 20, w: 100, h: 100 },
  { id: 'i1', type: 'image', asset: 'a', x: 3000, y: 0, w: 400, h: 300 },
  { id: 'c1', type: 'connector', from: { id: 'n1' }, to: { id: 'n2' }, x: 0, y: 0, w: 1, h: 1 },
] });
const get = (d, id) => d.items.find((i) => i.id === id);
/** addImages for tests: one 400 × 300 picture (asset "a"). */
const oneImage = async () => [{ asset: 'a', w: 400, h: 300 }];

test('ops refuse what would break the board: circles of groups, parents of connectors, non-numbers', async () => {
  const d = board();
  const bad = async (ops, re) => {
    const before = serialize(d);
    await assert.rejects(applyOps(d, ops, { addImages: oneImage }), re, JSON.stringify(ops));
    assert.equal(serialize(d), before, 'nothing changed');
  };
  await bad([{ op: 'set', id: 'g1', parent: 'g2' }], /inside g1: groups cannot be inside each other in a circle/);
  await bad([{ op: 'set', id: 'g1', parent: 'g1' }], /the item itself/);
  await bad([{ op: 'set', id: 'c1', parent: 'g1' }], /connectors have no parent/);
  await bad([{ op: 'group', ids: ['c1', 'n2'] }], /c1: connectors are not grouped/);
  await bad([{ op: 'ungroup', id: 'n2' }], /n2 is not a group/);
  await bad([{ op: 'move', id: 'n2', x: 'abc' }], /x must be a number/);
  await bad([{ op: 'move', id: 'n2', dx: '' }], /dx must be a number/);
  await bad([{ op: 'arrange', ids: ['i1'], width: -100 }], /width must be a positive number/);
  await bad([{ op: 'arrange', ids: ['i1'], gap: 'abc' }], /gap must be a number/);
  await bad([{ op: 'newgroup', x: 'left' }], /x must be a number/);
  await bad([{ op: 'newgroup', color: 'teal' }], /color must be one of/);
  await bad([{ op: 'add', paths: ['a.jpg'], max: -5 }], /max must be a positive number/);
  await bad([{ op: 'set', id: 'i1', opacity: 5 }], /opacity must be 0…1/);
  await bad([{ op: 'set', id: 'n2', name: 'x' }], /only groups have a name/);
  await bad([{ op: 'table', cells: [['a']], width: 'wide' }], /width must be a positive number/);
  assert.ok(listText(d, { group: 'g1' }).includes('n1'));
  // what is fine still works: strings that are numbers, a group's name, nesting the other way round
  const r = await applyOps(d, [{ op: 'newgroup', name: 'S', x: '100', y: '50' }, { op: 'set', id: 'g1', name: 'Outer' }, { op: 'set', id: 'n2', parent: 'g2' }]);
  assert.deepEqual([get(d, r.created[0]).x, get(d, r.created[0]).y], [100, 50]);
  assert.equal(get(d, 'n2').parent, 'g2');
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
});

test('"$name" ids work inside set fields: parent, connector ends', async () => {
  const d = board();
  const r = await applyOps(d, [
    { op: 'newgroup', name: 'G', x: 5000, y: 0, as: '$g' },
    { op: 'shape', x: 0, y: 900, as: '$s' },
    { op: 'shape', x: 400, y: 900, as: '$t' },
    { op: 'set', id: 'n2', parent: '$g' },
    { op: 'set', id: 'c1', from: { id: '$s', side: 'top' }, to: '$t' },
  ]);
  const [g, s, t] = r.created;
  assert.equal(get(d, 'n2').parent, g);
  assert.deepEqual(get(d, 'c1').from, { id: s, side: 'top' });
  assert.deepEqual(get(d, 'c1').to, { id: t });
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
});

test('set leaves default values out (as the format expects); rot and opacity stay in range', async () => {
  const d = board();
  const r = await applyOps(d, [
    { op: 'shape', kind: 'rect', align: 'left', as: '$s' },
    { op: 'stroke', points: [[0, 0], [50, 50]], end: 'arrow', as: '$k' },
    { op: 'set', id: 'n2', size: 'l', align: 'center', ratio: 'square', scale: 2 },
    { op: 'set', id: 'n2', size: 'm', align: 'left', ratio: 'free', scale: 1, rot: 450 },
    { op: 'set', id: '$s', align: 'center', size: 'm' },
    { op: 'set', id: 'c1', route: 'elbow', start: 'dot', width: 4 },
    { op: 'set', id: 'c1', route: 'straight', start: 'none', width: 2 },
    { op: 'set', id: 'i1', opacity: 0.5, rot: 360 },
    { op: 'set', id: '$k', end: 'none' },
  ]);
  const [s, k] = r.created.map((id) => get(d, id));
  const n2 = get(d, 'n2');
  for (const key of ['size', 'align', 'ratio', 'scale']) assert.equal(n2[key], undefined, `note ${key}`);
  assert.equal(n2.rot, 90);
  assert.equal(s.align, undefined);
  for (const key of ['route', 'start', 'width']) assert.equal(get(d, 'c1')[key], undefined, `connector ${key}`);
  assert.equal(get(d, 'i1').opacity, 0.5);
  assert.equal(get(d, 'i1').rot, undefined);
  assert.equal(k.end, undefined);
  await applyOps(d, [{ op: 'set', id: 'i1', opacity: 1 }]);
  assert.equal(get(d, 'i1').opacity, undefined, 'fully opaque is the default');
  await assert.rejects(applyOps(d, [{ op: 'set', id: k.id, end: 'dot' }]), /"arrow" or "none"/);
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
  assert.deepEqual(normalize(serialize(d)).items, d.items, 'round trip');
});

test('tables: set cells and the table op never cut the cells', async () => {
  const d = board();
  const r = await applyOps(d, [
    { op: 'table', rows: 2, cols: 2, width: 120, as: '$t' },
    { op: 'set', id: '$t', cells: [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']] },
    { op: 'table', rows: [40, 40], cells: [['a'], ['b'], ['c']], as: '$u' },
    { op: 'table', cells: '[["x","y"]]', as: '$v' },
  ]);
  const [t, u, v] = r.created.map((id) => get(d, id));
  assert.deepEqual(t.cells, [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']]);
  assert.deepEqual(t.cols, [120, 120, 200], 'new columns at the default width');
  assert.equal(t.rows.length, 3);
  assert.equal(t.w, 440);
  assert.deepEqual(u.cells, [['a'], ['b'], ['c']]);
  assert.deepEqual(u.rows, [40, 40, 56]);
  assert.deepEqual(v.cells, [['x', 'y']], 'cells as JSON text');
  await applyOps(d, [{ op: 'set', id: t.id, cells: [['only']] }]);
  assert.deepEqual([get(d, t.id).cells, get(d, t.id).cols, get(d, t.id).rows.length], [[['only']], [120], 1]);
  await assert.rejects(applyOps(d, [{ op: 'set', id: t.id, cells: Array.from({ length: 101 }, () => Array(100).fill('')) }]), /at most 10000 cells/);
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
});

test('new things: shorts stand up, fit: false is kept, a picture is never made bigger than it is', async () => {
  const d = board();
  const r = await applyOps(d, [
    { op: 'video', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
    { op: 'video', url: 'https://youtu.be/dQw4w9WgXcQ', w: 320 },
    { op: 'note', text: 'hi', fit: false },
    { op: 'note', text: 'sticky' },
    { op: 'add', paths: ['a.jpg'], x: 0, y: 5000 },
    { op: 'add', paths: ['a.jpg'], max: 200, x: 0, y: 6000 },
    { op: 'add', paths: ['a.jpg'], group: 'g1' },
  ], { addImages: oneImage });
  const [short, wide, plain, sticky, img, small, inGroup] = r.created.map((id) => get(d, id));
  assert.deepEqual([short.w, short.h], [360, 640]);
  assert.deepEqual([wide.w, wide.h], [320, 180]);
  assert.equal(plain.fit, undefined);
  assert.equal(sticky.fit, true);
  assert.deepEqual([img.w, img.h], [400, 300]);
  assert.deepEqual([small.w, small.h], [200, 150]);
  assert.ok(inGroup.w <= 400 && inGroup.h <= 300, `${inGroup.w}×${inGroup.h}`);
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
});

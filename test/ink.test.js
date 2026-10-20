import test from 'node:test';
import assert from 'node:assert/strict';
import { strokeFrame, strokeSamples, strokeHits, strokeInRect, reframe, strokeScale, inkScale, inkReach } from '../src/core/ink.js';
import { emptyCanvas, normalize, serialize, validate, moveItems, newId } from '../src/core/model.js';
import { applyOps } from '../src/core/ops.js';
import { listText } from '../src/core/describe.js';

const line = (n = 11) => Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, p: 0.5 }));

test('strokeFrame: the box hugs the ink, points are stored relative to it', () => {
  const f = strokeFrame({ tool: 'pen', width: 4 }, [{ x: 100, y: 50, p: 0.2 }, { x: 200, y: 80, p: 1, t: 30 }]);
  const pad = inkReach({ tool: 'pen', width: 4 }) + 1;
  assert.ok(Math.abs(f.x - (100 - pad)) < 0.01 && Math.abs(f.y - (50 - pad)) < 0.01);
  assert.equal(f.vw, f.w);
  assert.deepEqual(f.pts.slice(2, 3), [0.2]);
  assert.deepEqual(f.tw, [0, 30]);
  const back = strokeSamples({ ...f });
  assert.ok(Math.abs(back[1].x + f.x - 200) < 0.02 && back[1].t === 30);
  assert.equal(strokeFrame({}, []), null);
});

test('hit tests follow the ink, not the box, and survive resizing', () => {
  const k = { type: 'stroke', tool: 'pen', width: 4, ...strokeFrame({ tool: 'pen', width: 4 }, line()) };
  assert.ok(strokeHits(k, { x: 50, y: 1 }, 2));
  assert.ok(!strokeHits(k, { x: 50, y: 30 }, 2));
  assert.ok(strokeInRect(k, { x: 40, y: -5, w: 5, h: 10 }), 'a rectangle across the line, between samples');
  assert.ok(!strokeInRect(k, { x: 40, y: 20, w: 5, h: 10 }));
  // twice as big: the ink is where the scaled line is
  const big = { ...k, x: k.x * 2, y: k.y * 2, w: k.w * 2, h: k.h * 2 };
  assert.equal(strokeScale(big), 2);
  assert.ok(strokeHits(big, { x: 150, y: 1 }, 2));
  // two samples far apart: the segment between them still counts
  const sparse = { type: 'stroke', tool: 'pen', width: 4, ...strokeFrame({ tool: 'pen', width: 4 }, [{ x: 0, y: 0 }, { x: 1000, y: 0 }]) };
  assert.ok(strokeInRect(sparse, { x: 490, y: -10, w: 20, h: 20 }));
});

test('reframe bakes a resize and fits a new width', () => {
  const k = { id: 'k1', type: 'stroke', tool: 'pen', width: 4, color: 'white', ...strokeFrame({ tool: 'pen', width: 4 }, line()) };
  const resized = { ...k, w: k.w * 2, h: k.h * 2 };
  const n = reframe(resized, { width: 20 });
  assert.equal(n.width, 20);
  assert.equal(n.vw, n.w);
  assert.ok(n.h > resized.h, 'a wider pen needs a taller box');
  assert.ok(strokeHits(n, { x: k.x + (k.w / 2) * 2, y: 1 + k.y + (k.h / 2) * 2 }, 1));
  assert.equal(reframe(k).width, 4, 'unscaled: same width');
});

test('inkScale: presets are on-screen sizes, in steps of 2', () => {
  assert.equal(inkScale(1), 1);
  assert.equal(inkScale(0.25), 4);
  assert.equal(inkScale(0.3), 4);
  assert.equal(inkScale(4), 0.25);
});

test('stroke op, set, normalize, validate, list', async () => {
  const d = emptyCanvas();
  const g = await applyOps(d, [{ op: 'newgroup', name: 'G', x: 0, y: 0, w: 100, h: 100, as: '$g' }]);
  const r = await applyOps(d, [
    { op: 'stroke', points: [[10, 10], [60, 40, 0.9], [90, 20]], color: 'red', width: 5, group: g.created[0], as: '$k' },
    { op: 'stroke', tool: 'highlighter', points: [{ x: 0, y: 300 }, { x: 400, y: 300 }] },
    { op: 'stroke', tool: 'tape', nib: 'italic', points: [[0, 500], [200, 500]] },
  ]);
  const [k, hl, tape] = r.created.map((id) => d.items.find((i) => i.id === id));
  assert.match(k.id, /^k/);
  assert.equal(k.parent, g.created[0]);
  assert.equal(hl.width, 18, 'default highlighter width');
  assert.equal(hl.color, 'yellow');
  assert.equal(tape.nib, undefined, 'only a pen has an italic nib');
  const grp = d.items.find((i) => i.id === g.created[0]);
  assert.ok(grp.x <= k.x && grp.x + grp.w >= k.x + k.w, 'the group grew around the stroke');
  await assert.rejects(() => applyOps(d, [{ op: 'stroke', points: [] }]), /needs "points"/);
  await assert.rejects(() => applyOps(d, [{ op: 'stroke', points: [['a', 1]] }]), /must be \[x, y\]/);
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: k.id, color: 'paper' }]), /color must be one of/);
  // a new width measures the frame again
  await applyOps(d, [{ op: 'set', id: k.id, width: 30, nib: 'italic' }]);
  const k2 = d.items.find((i) => i.id === k.id);
  assert.equal(k2.width, 30);
  assert.equal(k2.nib, 'italic');
  assert.ok(k2.w > k.w);
  const grown = d.items.find((i) => i.id === g.created[0]);
  assert.ok(grown.x <= k2.x && grown.x + grown.w >= k2.x + k2.w, 'its group grew with it');
  assert.match(listText(d), /stroke {2}pen italic {2}red {2}width=30 {2}3 points/);
  await applyOps(d, [{ op: 'set', id: k.id, nib: 'round' }]);
  assert.equal(d.items.find((i) => i.id === k.id).nib, undefined);
  // moving keeps the points
  moveItems(d, [hl.id], 50, 0);
  assert.equal(d.items.find((i) => i.id === hl.id).pts, hl.pts);
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
  assert.deepEqual(normalize(serialize(d)).items, normalize(JSON.parse(serialize(d))).items);
  assert.match(listText(d), /3 strokes/);
  // normalize repairs what it can
  const n = normalize({ format: 'ilucanvas', assets: {}, items: [
    { id: 'a', type: 'stroke', tool: 'brush', color: 'paper', x: 0, y: 0, w: 10, h: 10, pts: [1, 2, 0.5, 3], tw: [1] },
    { id: 'b', type: 'stroke', tool: 'tape', nib: 'italic', x: 0, y: 0, w: 10, h: 10, pts: [1, 2, 0.5], vw: -1 },
  ] }).items;
  assert.equal(n[0].tool, 'pen');
  assert.equal(n[0].color, 'white');
  assert.deepEqual(n[0].pts, [], 'not x, y, pressure triples');
  assert.equal(n[0].tw, undefined);
  assert.equal(n[1].nib, undefined);
  assert.equal(n[1].vw, 10);
  // validate catches broken points
  const bad = { ...emptyCanvas(), items: [{ id: newId('stroke'), type: 'stroke', tool: 'pen', x: 0, y: 0, w: 1, h: 1, pts: [1, 2] }] };
  assert.match(validate(bad).errors.map((e) => e.msg).join(), /x, y, pressure/);
});

test('ink takes a custom #rrggbb colour too', async () => {
  const d = emptyCanvas();
  const r = await applyOps(d, [{ op: 'stroke', points: [[0, 0], [50, 50]], color: '#FF8800' }]);
  const k = d.items.find((i) => i.id === r.created[0]);
  assert.equal(k.color, '#ff8800');
  await applyOps(d, [{ op: 'set', id: k.id, color: '#0a84ff' }]);
  assert.equal(d.items[0].color, '#0a84ff');
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: k.id, color: '#12345' }]), /or #rrggbb/);
  // only ink: a connector keeps to the palette
  await applyOps(d, [{ op: 'connect', from: k.id, to: { x: 300, y: 0 }, as: '$c' }]);
  const c = d.items.find((i) => i.type === 'connector');
  assert.equal(c.route, 'dubins', 'new connectors are Dubins paths');
  await assert.rejects(() => applyOps(d, [{ op: 'set', id: c.id, color: '#ff0000' }]), /color must be one of/);
  assert.equal(normalize({ format: 'ilucanvas', assets: {}, items: [{ id: 'k', type: 'stroke', x: 0, y: 0, w: 1, h: 1, color: '#ABCDEF', pts: [] }] }).items[0].color, '#abcdef');
  assert.ok(validate(d).ok);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesReader } from '../src/core/zip.js';
import { crc32 } from '../src/core/crc32.js';
import { openCanvas, planSave } from '../src/core/canvasfile.js';
import { emptyCanvas } from '../src/core/model.js';

async function concat(chunks, prefix = new Uint8Array(0), src = null) {
  const parts = [prefix];
  for (const c of chunks) parts.push(c instanceof Uint8Array ? c : c.range ? await src.read(...c.range) : new Uint8Array(await c.arrayBuffer()));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('an append save cut off mid-write opens at the last complete save, not the first', async () => {
  // in place (Safari's OPFS): [v0][dir][v1][dir][v2][dir] then a save that never finished
  const doc = emptyCanvas({ title: 'v0' });
  let file = await concat((await planSave({ doc })).chunks);
  for (const title of ['v1', 'v2']) {
    const c = await openCanvas(bytesReader(file));
    c.doc.title = title;
    const plan = await planSave({ base: { index: c.index, reader: bytesReader(file) }, doc: c.doc, mode: 'append' });
    file = await concat(plan.chunks, file.subarray(0, plan.at), bytesReader(file));
  }
  assert.equal((await openCanvas(bytesReader(file))).doc.title, 'v2');

  // a big new image, written half: more than the 64 KB the end-of-directory search looks at
  const c = await openCanvas(bytesReader(file));
  const img = new Uint8Array(300000).map((_, i) => (i * 13) & 255);
  c.doc.title = 'v3';
  c.doc.assets.a = { file: 'images/a.png', type: 'image/png', w: 10, h: 10 };
  c.doc.items = [{ id: 'i1', type: 'image', asset: 'a', x: 0, y: 0, w: 10, h: 10 }];
  const plan = await planSave({ base: { index: c.index, reader: bytesReader(file) }, doc: c.doc, add: new Map([['images/a.png', { data: img, crc: crc32(img) }]]), mode: 'append' });
  const full = await concat(plan.chunks, file.subarray(0, plan.at), bytesReader(file));
  const cut = full.subarray(0, file.length + 200000);

  const r = await openCanvas(bytesReader(cut));
  assert.equal(r.doc.title, 'v2', 'the saves after the first directory are found');
  assert.ok(r.index.recovered);
  assert.ok(r.warnings.some((w) => /cut off/.test(w)));
});

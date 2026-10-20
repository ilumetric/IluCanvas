import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesReader, readZip, readEntry, ZipWriter, scanLocalHeaders } from '../src/core/zip.js';
import { crc32 } from '../src/core/crc32.js';
import { openCanvas, planSave, deadBytes } from '../src/core/canvasfile.js';
import { emptyCanvas } from '../src/core/model.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function concat(chunks, prefix = new Uint8Array(0), src = null) {
  const parts = [prefix];
  for (const c of chunks) parts.push(c instanceof Uint8Array ? c : c.range ? await src.read(...c.range) : new Uint8Array(await c.arrayBuffer()));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test('crc32 matches known values', () => {
  assert.equal(crc32(enc.encode('')), 0);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  const big = new Uint8Array(100003).map((_, i) => (i * 7) & 255);
  assert.equal(crc32(big.subarray(50000), crc32(big.subarray(0, 50000))), crc32(big));
});

test('write and read back: store, deflate, utf-8 names', async () => {
  const w = new ZipWriter(0);
  await w.add('canvas.json', enc.encode('{"a":1}'.repeat(100)), { deflate: true });
  const img = new Uint8Array(5000).map((_, i) => i & 255);
  w.addStored('images/кот рыжий.jpg', img, { crc: crc32(img) });
  const { chunks } = w.finish();
  const zip = await concat(chunks);
  const r = bytesReader(zip);
  const idx = await readZip(r);
  assert.deepEqual(idx.entries.map((e) => e.name), ['canvas.json', 'images/кот рыжий.jpg']);
  assert.equal(idx.byName.get('canvas.json').method, 8);
  assert.equal(dec.decode(await readEntry(r, idx.byName.get('canvas.json'))), '{"a":1}'.repeat(100));
  assert.deepEqual(await readEntry(r, idx.byName.get('images/кот рыжий.jpg')), img);
});

test('canvas saves: tail mode rewrites only the tail, append keeps everything', async () => {
  const doc = emptyCanvas({ title: 'T' });
  const img = new Uint8Array(20000).fill(7);
  doc.assets.a = { file: 'images/a.png', type: 'image/png', w: 10, h: 10 };
  doc.items.push({ id: 'i1', type: 'image', asset: 'a', x: 0, y: 0, w: 10, h: 10 });
  let plan = await planSave({ doc, add: new Map([['images/a.png', { data: img, crc: crc32(img) }]]) });
  let file = await concat(plan.chunks);
  let c = await openCanvas(bytesReader(file));
  assert.equal(c.doc.title, 'T');
  const imgOffset = c.index.byName.get('images/a.png').offset;

  // edit the scene: only canvas.json is rewritten, the image stays in place
  c.doc.title = 'T2';
  plan = await planSave({ base: { index: c.index, reader: bytesReader(file) }, doc: c.doc, mode: 'tail' });
  assert.ok(plan.at > imgOffset + img.length, 'tail starts after the image');
  file = await concat(plan.chunks, file.subarray(0, plan.at));
  c = await openCanvas(bytesReader(file));
  assert.equal(c.doc.title, 'T2');
  assert.equal(c.index.byName.get('images/a.png').offset, imgOffset);
  assert.ok(deadBytes(c.index, file.length) < 100, `no dead space after a tail save (${deadBytes(c.index, file.length)})`);

  // append mode: old records stay, the new directory wins
  c.doc.title = 'T3';
  plan = await planSave({ base: { index: c.index, reader: bytesReader(file) }, doc: c.doc, mode: 'append' });
  assert.equal(plan.at, file.length);
  const appended = await concat(plan.chunks, file);
  c = await openCanvas(bytesReader(appended));
  assert.equal(c.doc.title, 'T3');
  assert.ok(deadBytes(c.index, appended.length) > 0);

  // a crash in the middle of an append: the directory is gone, recovery finds the last complete scene
  const cut = appended.subarray(0, appended.length - 30);
  const rec = await scanLocalHeaders(bytesReader(cut));
  assert.ok(rec.byName.has('images/a.png'));
  c = await openCanvas(bytesReader(cut));
  assert.ok(['T2', 'T3'].includes(c.doc.title));

  // removing the image's item drops the image file on the next save
  c = await openCanvas(bytesReader(appended));
  c.doc.items = [];
  delete c.doc.assets.a;
  plan = await planSave({ base: { index: c.index, reader: bytesReader(appended) }, doc: c.doc, mode: 'full' });
  const compact = await concat(plan.chunks);
  c = await openCanvas(bytesReader(compact));
  assert.ok(!c.index.byName.has('images/a.png'));
  assert.ok(compact.length < 2000);
  assert.equal(c.index.entries[0].name, 'mimetype');
});

test('full save over a reader without blobs (the CLI): kept images copied as ranges, a valid directory', async () => {
  const doc = emptyCanvas({ title: 'T' });
  const img = new Uint8Array(20000).fill(9);
  doc.assets.a = { file: 'images/a.png', type: 'image/png', w: 10, h: 10 };
  doc.items.push({ id: 'i1', type: 'image', asset: 'a', x: 0, y: 0, w: 10, h: 10 });
  const first = await concat((await planSave({ doc, add: new Map([['images/a.png', { data: img, crc: crc32(img) }]]) })).chunks);
  const src = bytesReader(first);
  const c = await openCanvas(src);
  c.doc.title = 'T2';
  const plan = await planSave({ base: { index: c.index, reader: src }, doc: c.doc, mode: 'full' });
  assert.ok(plan.chunks.some((ch) => ch.range), 'the image is a range of the old file');
  const file = await concat(plan.chunks, undefined, src);
  assert.equal(plan.size, file.length);
  const idx = await readZip(bytesReader(file), { recover: false });
  assert.deepEqual(idx.warnings, []);
  assert.deepEqual(await readEntry(bytesReader(file), idx.byName.get('images/a.png')), img);
  assert.equal((await openCanvas(bytesReader(file))).doc.title, 'T2');
});

test('zip64 directory for many entries', async () => {
  const w = new ZipWriter(0);
  const one = enc.encode('x');
  for (let i = 0; i < 70000; i++) w.addStored(`f/${i}`, one, { crc: crc32(one) });
  const zip = await concat(w.finish().chunks);
  const idx = await readZip(bytesReader(zip), { recover: false });
  assert.equal(idx.entries.length, 70000);
  assert.equal(dec.decode(await readEntry(bytesReader(zip), idx.byName.get('f/69999'))), 'x');
});

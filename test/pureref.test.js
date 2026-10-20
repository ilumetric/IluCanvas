import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePureRef } from '../src/core/pureref.js';

// ---- a small PureRef 2 file, built in memory ----------------------------------------------------
// The Qt header, then an SQLite database (4 KB pages as PureRef writes, one leaf page per table, payloads that do
// not fit on overflow chains) whose first H bytes (H = the header's length) are moved to the end
// of the file, as PureRef writes it. Real samples are not in the repo.

const PAGE = 4096;
const MAX_LOCAL = PAGE - 35;
const MIN_LOCAL = Math.floor(((PAGE - 12) * 32) / 255) - 23;

const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };
const i64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v)); return [...b]; };
const qstring = (s) => [...u32(s.length * 2), ...[...s].flatMap((c) => u16(c.charCodeAt(0)))];
const cstring = (s) => [...u32(s.length + 1), ...[...s].map((c) => c.charCodeAt(0)), 0];

/** SQLite varint (values under 2^56). */
function varint(n) {
  const out = [n % 128];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n % 128) | 0x80);
  return out;
}

/** A record: null, integer, real, Uint8Array (blob) or string (text). */
function record(values) {
  const types = [];
  const body = [];
  for (const v of values) {
    if (v === null) types.push(0);
    else if (typeof v === 'number' && Number.isInteger(v)) { types.push(6); body.push(...i64(v)); }
    else if (typeof v === 'number') { types.push(7); body.push(...f64(v)); }
    else if (v instanceof Uint8Array) { types.push(12 + v.length * 2); body.push(...v); }
    else { const b = new TextEncoder().encode(v); types.push(13 + b.length * 2); body.push(...b); }
  }
  const head = types.flatMap(varint);
  return Uint8Array.from([...varint(head.length + 1), ...head, ...body]);
}

/**
 * tables: [{ name, sql, rows: [[rowid, ...values]], pointers?(cellOffsets) → offsets }].
 * `pointers` lets a test write a crafted cell pointer array.
 */
function database(tables) {
  const pages = [];
  const alloc = () => pages.push(new Uint8Array(PAGE));
  alloc(); // page 1: the schema
  const roots = tables.map(() => alloc());
  const fill = (n, rows, pointers) => {
    const pg = pages[n - 1];
    const ho = n === 1 ? 100 : 0;
    let end = PAGE;
    const offs = [];
    for (const [rowid, ...values] of rows) {
      const p = record(values);
      let local = p.length;
      if (p.length > MAX_LOCAL) {
        const k = MIN_LOCAL + ((p.length - MIN_LOCAL) % (PAGE - 4));
        local = k <= MAX_LOCAL ? k : MIN_LOCAL;
      }
      const cell = [...varint(p.length), ...varint(rowid), ...p.subarray(0, local)];
      if (local < p.length) {
        let first = 0;
        let prev = 0;
        for (let at = local; at < p.length; at += PAGE - 4) {
          const o = alloc();
          if (prev) pages[prev - 1].set(u32(o), 0); else first = o;
          pages[o - 1].set(p.subarray(at, at + PAGE - 4), 4);
          prev = o;
        }
        cell.push(...u32(first));
      }
      end -= cell.length;
      pg.set(cell, end);
      offs.push(end);
    }
    const ptrs = pointers ? pointers(offs) : offs;
    if (ho + 8 + ptrs.length * 2 > end) throw new Error('test page overfull');
    pg[ho] = 0x0d;
    pg.set(u16(ptrs.length), ho + 3);
    pg.set(u16(end), ho + 5);
    ptrs.forEach((o, i) => pg.set(u16(o), ho + 8 + i * 2));
  };
  tables.forEach((t, i) => fill(roots[i], t.rows, t.pointers));
  fill(1, tables.map((t, i) => [i + 1, 'table', t.name, t.name, roots[i], t.sql]));
  const h = pages[0];
  h.set([...'SQLite format 3'].map((c) => c.charCodeAt(0)), 0);
  h.set(u16(PAGE), 16);
  h.set([1, 1, 0, 64, 32, 32], 18);
  h.set(u32(1), 24); // change counter = version-valid-for: the page count is good
  h.set(u32(pages.length), 28);
  h.set(u32(1), 56); // UTF-8
  h.set(u32(1), 92);
  const db = new Uint8Array(pages.length * PAGE);
  pages.forEach((p, i) => db.set(p, i * PAGE));
  return db;
}

function purFile(tables) {
  const db = database(tables);
  const head = [...qstring('2.1'), 0, 0, 0, 0, ...u32(0), ...u32(db.length), ...qstring('2.1.3'), ...qstring('0'.repeat(32)), ...u32(0xffffffff)];
  const H = head.length;
  const file = new Uint8Array(db.length + H);
  file.set(head, 0);
  file.set(db.subarray(H), H);
  file.set(db.subarray(0, H), db.length);
  return file;
}

const transform = (m11, m12, m21, m22, dx, dy) => Uint8Array.from([...u32(80), 0, ...[m11, m12, 0, m21, m22, 0, dx, dy, 1].flatMap(f64)]);
const ITEMS = 'CREATE TABLE items (parent INTEGER, id INTEGER PRIMARY KEY, transform BLOB, z REAL)';

// ---- tests --------------------------------------------------------------------------------------

test('overflow chains: read whole, and one chain shared by many cells is read once', () => {
  const blob = Uint8Array.from({ length: 9000 }, (_, i) => (i * 7 + 3) & 255);
  const images = { name: 'images', sql: 'CREATE TABLE images (id INTEGER PRIMARY KEY, data BLOB, width INTEGER, height INTEGER)', rows: [[1, null, blob, 10, 10]] };
  const ok = parsePureRef(purFile([images]));
  assert.equal(ok.images.length, 1);
  assert.deepEqual(ok.images[0].data, blob);
  // a crafted page: 40 cell pointers to the one cell would each copy the whole payload
  const bad = parsePureRef(purFile([{ ...images, pointers: (offs) => Array(40).fill(offs[0]) }]));
  assert.equal(bad.images.length, 1, 'the first cell is read, the rest skipped');
  assert.deepEqual(bad.images[0].data, blob);
  assert.equal(bad.warnings.filter((w) => /overflow page \d+ is used twice/.test(w)).length, 39);
});

test('notes: Qt rich text to plain text, fixed-size notes keep their scale', () => {
  // the shape of the HTML PureRef 2.1.3 stores (Qt's toHtml: each block on its own line)
  const P = '<p style=" margin-top:0px; margin-bottom:0px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;">';
  const EMPTY = '<p style="-qt-paragraph-type:empty; margin-top:0px; margin-bottom:0px; margin-left:0px; margin-right:0px; -qt-block-indent:0; text-indent:0px;"><br /></p>';
  const qt = (blocks) => `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0//EN" "http://www.w3.org/TR/REC-html40/strict.dtd">\n<html><head><meta name="qrichtext" content="1" /><meta charset="utf-8" /><style type="text/css">\np, li { white-space: pre-wrap; }\nli.unchecked::marker { content: "\\2610"; }\nli.checked::marker { content: "\\2612"; }\n</style></head><body style=" font-family:'Open Sans'; font-size:22px; font-weight:400; font-style:normal;">\n${blocks.join('\n')}</body></html>`;
  const size = (w, h) => Uint8Array.from([...u32(22), 0, ...f64(w), ...f64(h)]);
  const pur = parsePureRef(purFile([
    { name: 'items', sql: ITEMS, rows: [[1, -1, null, transform(1, 0, 0, 1, 0, 0), 1], [2, -1, null, transform(4, 0, 0, 4, 10, 20), 2], [3, -1, null, transform(1, 0, 0, 1, 0, 0), 3]] },
    {
      name: 'items_notes',
      sql: 'CREATE TABLE items_notes (id INTEGER PRIMARY KEY, fixed_size TEXT, text TEXT)',
      rows: [
        [1, null, null, qt([`${P}line one</p>`, `${P}line two</p>`, EMPTY, `${P}a &amp; b<br />soft break</p>`])],
        [2, null, size(200, 40), qt([`${P}fixed</p>`])],
        [3, null, null, qt([`${P}привет это записка</p>`])],
      ],
    },
  ]));
  const [a, b, c] = pur.texts;
  assert.equal(a.text, 'line one\nline two\n\na & b\nsoft break');
  assert.equal(c.text, 'привет это записка');
  assert.deepEqual([b.text, b.x, b.y, b.w, b.h, b.scale], ['fixed', 10, 20, 800, 160, 4]);
  assert.equal(a.w, null);
  assert.equal(a.scale, 1);
});

test('drawings: pen colours in any QColor spec', () => {
  const stroke = (spec, a, v1, v2, v3, v4) => [100, spec, ...u16(a), ...u16(v1), ...u16(v2), ...u16(v3), ...u16(v4), ...f64(3),
    ...u32(2), ...u32(0), ...f64(0), ...f64(0), ...u32(1), ...f64(10), ...f64(0), ...u32(0), ...u32(0), ...f64(0), ...f64(0), ...u32(0)];
  const strokes = Uint8Array.from([...u32(1024), 0, ...cstring('QList<GraphicsDrawItem::Stroke>'), ...u32(4),
    ...stroke(1, 0x8080, 0xffff, 0, 0, 0), // RGB red at half alpha
    ...stroke(2, 0xffff, 12000, 0xffff, 0xffff, 0), // HSV: hue 120° → green
    ...stroke(4, 0xffff, 24000, 0xffff, 0x8000, 0), // HSL: hue 240°, lightness ½ → blue
    ...stroke(3, 0xffff, 0, 0xffff, 0xffff, 0), // CMYK: magenta + yellow → red
  ]);
  const pur = parsePureRef(purFile([
    { name: 'items', sql: ITEMS, rows: [[1, -1, null, transform(1, 0, 0, 1, 0, 0), 1]] },
    { name: 'items_drawings', sql: 'CREATE TABLE items_drawings (id INTEGER PRIMARY KEY, strokes BLOB)', rows: [[1, null, strokes]] },
  ]));
  const s = pur.drawings[0].strokes;
  assert.deepEqual(s.map((x) => x.color), ['#ff0000', '#00ff00', '#0000ff', '#ff0000']);
  assert.ok(Math.abs(s[0].alpha - 0.5) < 0.01);
  assert.equal(s[1].alpha, 1);
  assert.deepEqual(s[0].elements.map((e) => [e.type, e.x, e.y]), [[0, 0, 0], [1, 10, 0]]);
});

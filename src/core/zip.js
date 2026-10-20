// A small ZIP reader / writer, for .ilucanvas files. No dependencies; runs in
// browsers and in Node 20+.
//
// Reading is random access: only the end of the file and the central directory
// are read up front, entries are read (or sliced, for stored ones) on demand —
// opening a multi-gigabyte canvas costs the same as opening a small one.
//
// Writing produces a list of chunks (Uint8Array | Blob) for the caller to write
// at some offset; existing entries can be kept where they are (append saves) or
// copied as raw records (compaction). Supports UTF-8 names, store and deflate,
// ZIP64 (archives and entries over 4 GB, over 65535 entries).
//
// Reader: { size: number, read(offset, length) → Promise<Uint8Array> }

import { crc32 } from './crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const U32 = 0xffffffff;
const U16 = 0xffff;
const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;

export const STORE = 0;
export const DEFLATE = 8;

const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8', { fatal: false });

export class ZipError extends Error {}

// ---- readers -----------------------------------------------------------------------------

/** A reader over a Blob / File (browser, Node). */
export function blobReader(blob) {
  return {
    size: blob.size,
    blob,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

/** A reader over bytes in memory. */
export function bytesReader(u8) {
  return {
    size: u8.length,
    async read(offset, length) { return u8.subarray(offset, offset + length); },
  };
}

const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 0x100000000;
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

function dosToMs(time, date) {
  if (!date) return 0;
  const d = new Date(1980 + (date >>> 9), ((date >>> 5) & 15) - 1, date & 31, time >>> 11, (time >>> 5) & 63, (time & 31) * 2);
  return d.getTime();
}

function msToDos(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Values from a ZIP64 extra field (id 1) for the fields that were 0xFFFFFFFF. */
function zip64Extra(extra, want) {
  const dv = view(extra);
  for (let p = 0; p + 4 <= extra.length;) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if (id === 1) {
      const out = {};
      let q = p + 4;
      for (const k of want) {
        if (q + 8 > p + 4 + len) break;
        out[k] = u64(dv, q);
        q += 8;
      }
      return out;
    }
    p += 4 + len;
  }
  return {};
}

/**
 * Read the central directory. Returns
 *   { entries: Entry[], byName: Map<name, Entry>, cdOffset, cdSize, eocdEnd, recovered, warnings }
 * Entry: { name, method, flags, crc, csize, usize, offset, mtime, extraLen, dataStart? }
 * With `recover` (default), a file without a readable directory is rebuilt by
 * walking the local headers (the last copy of a repeated name wins).
 */
export async function readZip(reader, { recover = true } = {}) {
  try {
    return await readDirectory(reader);
  } catch (e) {
    if (!recover) throw e;
    const r = await scanLocalHeaders(reader);
    if (!r.entries.length) throw e;
    r.warnings.unshift(`central directory unreadable (${e.message}); rebuilt from ${r.entries.length} local entries`);
    return r;
  }
}

async function readDirectory(reader) {
  const size = reader.size;
  if (size < 22) throw new ZipError('not a zip file (too small)');
  const tailLen = Math.min(size, 0xffff + 22 + 20);
  const tail = await reader.read(size - tailLen, tailLen);
  const tv = view(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) <= tail.length) { at = i; break; }
  }
  if (at < 0) throw new ZipError('not a zip file (no end of central directory)');
  let count = tv.getUint16(at + 10, true);
  let cdSize = tv.getUint32(at + 12, true);
  let cdOffset = tv.getUint32(at + 16, true);
  const eocdPos = size - tailLen + at;
  const eocdEnd = eocdPos + 22 + tv.getUint16(at + 20, true);
  if (count === U16 || cdSize === U32 || cdOffset === U32) {
    if (at < 20 || tv.getUint32(at - 20, true) !== SIG_LOC64) throw new ZipError('zip64 locator missing');
    const off64 = u64(tv, at - 20 + 8);
    const rec = await reader.read(off64, 56);
    const rv = view(rec);
    if (rec.length < 56 || rv.getUint32(0, true) !== SIG_EOCD64) throw new ZipError('zip64 end record missing');
    count = u64(rv, 32);
    cdSize = u64(rv, 40);
    cdOffset = u64(rv, 48);
  }
  if (cdOffset + cdSize > eocdPos) throw new ZipError('central directory out of range');
  const cd = await reader.read(cdOffset, cdSize);
  const dv = view(cd);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError(`bad central directory entry #${i}`);
    const flags = dv.getUint16(p + 8, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const e = {
      name: utf8d.decode(cd.subarray(p + 46, p + 46 + nameLen)),
      method: dv.getUint16(p + 10, true),
      flags,
      mtime: dosToMs(dv.getUint16(p + 12, true), dv.getUint16(p + 14, true)),
      crc: dv.getUint32(p + 16, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      offset: dv.getUint32(p + 42, true),
      extraLen,
    };
    const want = [];
    if (e.usize === U32) want.push('usize');
    if (e.csize === U32) want.push('csize');
    if (e.offset === U32) want.push('offset');
    if (want.length) Object.assign(e, zip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), want));
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return finishIndex(entries, { cdOffset, cdSize, eocdEnd, recovered: false, warnings: [] });
}

function finishIndex(entries, rest) {
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e); // a repeated name: the later one wins
  return { entries: [...byName.values()], byName, ...rest };
}

/** Rebuild an index by walking local headers from the start of the file. */
export async function scanLocalHeaders(reader) {
  const warnings = [];
  const entries = [];
  let pos = 0;
  while (pos + 30 <= reader.size) {
    const h = await reader.read(pos, 30);
    const hv = view(h);
    // append saves leave old directories between the records: step over them to the later saves
    const sig = hv.getUint32(0, true);
    if (sig === SIG_CENTRAL) {
      const c = await reader.read(pos, 46);
      if (c.length < 46) break;
      const cv = view(c);
      pos += 46 + cv.getUint16(28, true) + cv.getUint16(30, true) + cv.getUint16(32, true);
      continue;
    }
    if (sig === SIG_EOCD) { pos += 22 + hv.getUint16(20, true); continue; }
    if (sig === SIG_LOC64) { pos += 20; continue; }
    if (sig === SIG_EOCD64) { pos += 12 + u64(hv, 4); continue; }
    if (sig !== SIG_LOCAL) break;
    const flags = hv.getUint16(6, true);
    const nameLen = hv.getUint16(26, true);
    const extraLen = hv.getUint16(28, true);
    const ne = await reader.read(pos + 30, nameLen + extraLen);
    const e = {
      name: utf8d.decode(ne.subarray(0, nameLen)),
      method: hv.getUint16(8, true),
      flags,
      mtime: dosToMs(hv.getUint16(10, true), hv.getUint16(12, true)),
      crc: hv.getUint32(14, true),
      csize: hv.getUint32(18, true),
      usize: hv.getUint32(22, true),
      offset: pos,
      extraLen,
      dataStart: pos + 30 + nameLen + extraLen,
    };
    if (e.csize === U32 || e.usize === U32) Object.assign(e, zip64Extra(ne.subarray(nameLen), ['usize', 'csize']));
    if (flags & FLAG_DESCRIPTOR) { warnings.push(`stopped at "${e.name}": sizes are in a data descriptor`); break; }
    if (e.dataStart + e.csize > reader.size) { warnings.push(`"${e.name}" is cut off (incomplete write?) and was skipped`); break; }
    entries.push(e);
    pos = e.dataStart + e.csize;
  }
  return finishIndex(entries, { cdOffset: pos, cdSize: 0, eocdEnd: reader.size, recovered: true, warnings });
}

/** Where the entry's data starts (reads its local header once). */
export async function dataStart(reader, e) {
  if (e.dataStart != null) return e.dataStart;
  const h = await reader.read(e.offset, 30);
  if (h.length < 30 || view(h).getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`bad local header for "${e.name}"`);
  const hv = view(h);
  e.dataStart = e.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  return e.dataStart;
}

/** The end of the entry's record (header + data) in the file. */
export async function recordEnd(reader, e) {
  return (await dataStart(reader, e)) + e.csize;
}

/** The entry's uncompressed bytes. */
export async function readEntry(reader, e) {
  const start = await dataStart(reader, e);
  const raw = await reader.read(start, e.csize);
  if (e.method === STORE) return raw;
  if (e.method === DEFLATE) return inflateRaw(raw);
  throw new ZipError(`"${e.name}": unsupported compression method ${e.method}`);
}

/** A Blob for a stored entry, without reading it (reader must be a blobReader). */
export async function entryBlob(reader, e, type = '') {
  if (!reader.blob) throw new ZipError('entryBlob needs a blob reader');
  const start = await dataStart(reader, e);
  if (e.method === STORE) return reader.blob.slice(start, start + e.csize, type);
  return new Blob([await readEntry(reader, e)], { type });
}

// ---- compression -----------------------------------------------------------------------------

async function pipe(u8, stream) {
  const out = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const deflateRaw = (u8) => pipe(u8, new CompressionStream('deflate-raw'));
export const inflateRaw = (u8) => pipe(u8, new DecompressionStream('deflate-raw'));

// ---- writing ------------------------------------------------------------------------------------

function put64(dv, o, v) {
  dv.setUint32(o, v % 0x100000000, true);
  dv.setUint32(o + 4, Math.floor(v / 0x100000000), true);
}

/** The local header for an entry { name, method, crc, csize, usize, mtime }. */
export function localHeader(e) {
  const name = utf8.encode(e.name);
  const big = e.csize >= U32 || e.usize >= U32;
  const extraLen = big ? 20 : 0;
  const h = new Uint8Array(30 + name.length + extraLen);
  const dv = view(h);
  const { time, date } = msToDos(e.mtime);
  dv.setUint32(0, SIG_LOCAL, true);
  dv.setUint16(4, big ? 45 : 20, true);
  dv.setUint16(6, FLAG_UTF8, true);
  dv.setUint16(8, e.method, true);
  dv.setUint16(10, time, true);
  dv.setUint16(12, date, true);
  dv.setUint32(14, e.crc >>> 0, true);
  dv.setUint32(18, big ? U32 : e.csize, true);
  dv.setUint32(22, big ? U32 : e.usize, true);
  dv.setUint16(26, name.length, true);
  dv.setUint16(28, extraLen, true);
  h.set(name, 30);
  if (big) {
    dv.setUint16(30 + name.length, 1, true);
    dv.setUint16(32 + name.length, 16, true);
    put64(dv, 34 + name.length, e.usize);
    put64(dv, 42 + name.length, e.csize);
  }
  return h;
}

function centralHeader(e) {
  const name = utf8.encode(e.name);
  const z = [];
  if (e.usize >= U32) z.push(e.usize);
  if (e.csize >= U32) z.push(e.csize);
  if (e.offset >= U32) z.push(e.offset);
  const extraLen = z.length ? 4 + 8 * z.length : 0;
  const h = new Uint8Array(46 + name.length + extraLen);
  const dv = view(h);
  const { time, date } = e.mtime ? msToDos(e.mtime) : { time: 0, date: 0 };
  dv.setUint32(0, SIG_CENTRAL, true);
  dv.setUint16(4, 45, true); // made by: 4.5, MS-DOS attributes
  dv.setUint16(6, z.length ? 45 : 20, true);
  dv.setUint16(8, (e.flags ?? FLAG_UTF8) & ~FLAG_DESCRIPTOR | FLAG_UTF8, true);
  dv.setUint16(10, e.method, true);
  dv.setUint16(12, time, true);
  dv.setUint16(14, date, true);
  dv.setUint32(16, e.crc >>> 0, true);
  dv.setUint32(20, e.csize >= U32 ? U32 : e.csize, true);
  dv.setUint32(24, e.usize >= U32 ? U32 : e.usize, true);
  dv.setUint16(28, name.length, true);
  dv.setUint16(30, extraLen, true);
  dv.setUint32(42, e.offset >= U32 ? U32 : e.offset, true);
  h.set(name, 46);
  if (z.length) {
    dv.setUint16(46 + name.length, 1, true);
    dv.setUint16(48 + name.length, 8 * z.length, true);
    z.forEach((v, i) => put64(dv, 50 + name.length + 8 * i, v));
  }
  return h;
}

function endRecords(count, cdOffset, cdSize) {
  const big = count >= U16 || cdOffset >= U32 || cdSize >= U32;
  const out = new Uint8Array((big ? 56 + 20 : 0) + 22);
  const dv = view(out);
  let p = 0;
  if (big) {
    const eocd64 = cdOffset + cdSize;
    dv.setUint32(0, SIG_EOCD64, true);
    put64(dv, 4, 44);
    dv.setUint16(12, 45, true);
    dv.setUint16(14, 45, true);
    put64(dv, 24, count);
    put64(dv, 32, count);
    put64(dv, 40, cdSize);
    put64(dv, 48, cdOffset);
    dv.setUint32(56, SIG_LOC64, true);
    put64(dv, 64, eocd64);
    dv.setUint32(72, 1, true);
    p = 76;
  }
  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 8, Math.min(count, U16), true);
  dv.setUint16(p + 10, Math.min(count, U16), true);
  dv.setUint32(p + 12, Math.min(cdSize, U32), true);
  dv.setUint32(p + 16, Math.min(cdOffset, U32), true);
  return out;
}

const sizeOf = (c) => (c instanceof Uint8Array ? c.length : c.size);

/**
 * Collects records starting at file offset `start`. `kept` entries stay where
 * they are (they must all lie before `start`) and go into the new directory.
 *
 *   const w = new ZipWriter(start, kept);
 *   await w.add('canvas.json', bytes, { deflate: true });
 *   w.addStored('images/a.jpg', blob, { crc, size });
 *   w.copy(oldEntry, rawRecordBlob);       // compaction
 *   const { chunks, entries, size } = w.finish();   // write chunks at `start`
 */
export class ZipWriter {
  constructor(start = 0, kept = []) {
    this.start = start;
    this.offset = start;
    this.chunks = [];
    this.entries = kept.map((e) => ({ ...e }));
    this.names = new Set(this.entries.map((e) => e.name));
  }

  #push(chunk) {
    this.chunks.push(chunk);
    this.offset += sizeOf(chunk);
  }

  #record(e, data) {
    if (this.names.has(e.name)) this.entries = this.entries.filter((x) => x.name !== e.name);
    this.names.add(e.name);
    const header = localHeader(e);
    const entry = { ...e, offset: this.offset, dataStart: this.offset + header.length, flags: FLAG_UTF8 };
    this.#push(header);
    if (sizeOf(data)) this.#push(data);
    this.entries.push(entry);
    return entry;
  }

  /** Add bytes; deflated when `deflate` and it actually helps. */
  async add(name, bytes, { deflate = false, mtime = Date.now() } = {}) {
    const crc = crc32(bytes);
    let data = bytes;
    let method = STORE;
    if (deflate && bytes.length > 64) {
      const z = await deflateRaw(bytes);
      if (z.length < bytes.length) { data = z; method = DEFLATE; }
    }
    return this.#record({ name, method, crc, csize: data.length, usize: bytes.length, mtime }, data);
  }

  /** Add already-known stored data (Uint8Array or Blob) with its CRC. */
  addStored(name, data, { crc, mtime = Date.now() }) {
    const size = sizeOf(data);
    return this.#record({ name, method: STORE, crc, csize: size, usize: size, mtime }, data);
  }

  /** Copy an existing entry as its raw record (local header + data), e.g. when compacting. */
  copy(e, rawRecord) {
    if (this.names.has(e.name)) this.entries = this.entries.filter((x) => x.name !== e.name);
    this.names.add(e.name);
    const headerLen = e.dataStart - e.offset;
    const entry = { ...e, offset: this.offset, dataStart: this.offset + headerLen };
    this.#push(rawRecord);
    this.entries.push(entry);
    return entry;
  }

  finish() {
    const cdOffset = this.offset;
    const parts = this.entries.map(centralHeader);
    const cd = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let p = 0;
    for (const part of parts) { cd.set(part, p); p += part.length; }
    this.#push(cd);
    this.#push(endRecords(this.entries.length, cdOffset, cd.length));
    const byName = new Map(this.entries.map((e) => [e.name, e]));
    return {
      chunks: this.chunks,
      start: this.start,
      size: this.offset, // the new file size
      index: { entries: this.entries, byName, cdOffset, cdSize: cd.length, eocdEnd: this.offset, recovered: false, warnings: [] },
    };
  }
}

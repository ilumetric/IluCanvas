// The .ilucanvas container: a ZIP archive (rename it to .zip to look inside).
//
//   mimetype            "application/x-ilucanvas+zip" (first, stored — lets tools sniff the type)
//   canvas.json         the scene (model.js); written last on every save
//   preview.webp        a small cover picture of the board, for file lists
//   images/<name>.<ext> the original image files, byte for byte, under their own names
//   thumbs/<asset>.webp previews (≤ 512 px) so a board opens without decoding originals
//
// Saving never rewrites what did not change. A save is a "plan": a file offset
// and the chunks to write there (Uint8Array | Blob | { range: [offset, length] }
// of the current file). Three modes:
//   tail   — overwrite from where canvas.json / preview.webp start (they are
//            always the last records). For writers that replace the file
//            atomically: the browser's File System Access swap file, temp+rename.
//   append — write after the current end, overwrite nothing: safe in place.
//            The old canvas.json becomes dead space.
//   full   — write the whole file from 0 (new files, compaction).

import { readZip, readEntry, recordEnd, dataStart, ZipWriter, STORE } from './zip.js';
import { normalize, serialize, FORMAT } from './model.js';

export const MIMETYPE = 'application/x-ilucanvas+zip';
export const EXT = '.ilucanvas';
export const SCENE = 'canvas.json';
export const PREVIEW = 'preview.webp';
const TAIL = new Set([SCENE, PREVIEW]);
const MANAGED = /^(images|thumbs)\//;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Open a canvas: { index, doc, warnings, deadBytes }.
 * `index` is the ZIP directory (zip.js); keep it for planSave().
 */
export async function openCanvas(reader) {
  const index = await readZip(reader);
  const scene = index.byName.get(SCENE);
  if (!scene) throw new Error(index.byName.size ? 'not an IluCanvas file: canvas.json is missing' : 'empty archive');
  const doc = normalize(dec.decode(await readEntry(reader, scene)));
  if (doc.format !== FORMAT) throw new Error(`not an IluCanvas file (format "${doc.format}")`);
  return { index, doc, warnings: [...index.warnings], deadBytes: deadBytes(index, reader.size) };
}

/** Bytes of the file not used by any record of the directory (estimate). */
export function deadBytes(index, size) {
  let live = 0;
  for (const e of index.entries) live += 30 + enc.encode(e.name).length + (e.extraLen || 0) + e.csize;
  return Math.max(0, size - live - (index.cdSize || 0) - 22);
}

/** Files the document refers to: images and thumbnails of its assets. */
export function referencedFiles(doc) {
  const s = new Set();
  for (const a of Object.values(doc.assets)) {
    if (a.file) s.add(a.file);
    if (a.thumb) s.add(a.thumb);
  }
  return s;
}

/**
 * Plan a save.
 *   base     { index, reader } of the file as it is now, or null for a new file
 *   doc      the document to write as canvas.json
 *   add      Map name → { data: Uint8Array | Blob, crc } — new stored files (images, thumbs)
 *   preview  Uint8Array | Blob | null — a new cover (null keeps the old one)
 *   mode     'tail' | 'append' | 'full'
 *   keep     names that must stay even if the doc does not refer to them (e.g. undo history)
 * Entries under images/ and thumbs/ that nobody refers to are dropped; other
 * unknown entries (from newer versions) are kept.
 * Returns { at, chunks, size, index, mode }.
 */
export async function planSave({ base = null, doc, add = new Map(), preview = null, mode = 'tail', keep = new Set() }) {
  const reader = base?.reader;
  const index = base?.index;
  if (!index) mode = 'full';
  const refs = referencedFiles(doc);
  const wanted = (name) => name !== SCENE && name !== PREVIEW && !add.has(name)
    && (!MANAGED.test(name) || refs.has(name) || keep.has(name));
  const old = index ? [...index.entries].sort((a, b) => a.offset - b.offset) : [];
  let oldPreview = null;
  if (!preview && index?.byName.has(PREVIEW)) oldPreview = await readEntry(reader, index.byName.get(PREVIEW));

  let w;
  if (mode === 'full') {
    w = new ZipWriter(0);
    await w.add('mimetype', enc.encode(MIMETYPE), { deflate: false });
    for (const e of old) {
      if (e.name === 'mimetype' || !wanted(e.name)) continue;
      const start = await dataStart(reader, e);
      w.copy(e, rangeOf(reader, e.offset, start + e.csize - e.offset));
    }
  } else {
    // everything before `at` stays where it is
    let at;
    if (mode === 'append') at = reader.size;
    else {
      // the trailing run of records that are rewritten or dropped can be overwritten
      let i = old.length;
      while (i > 0 && (TAIL.has(old[i - 1].name) || !wanted(old[i - 1].name)) && old[i - 1].name !== 'mimetype') i--;
      at = i > 0 ? await recordEnd(reader, old[i - 1]) : 0;
    }
    const kept = old.filter((e) => wanted(e.name) && e.offset < at);
    if (at === 0) await (w = new ZipWriter(0)).add('mimetype', enc.encode(MIMETYPE));
    else w = new ZipWriter(at, kept);
  }

  for (const [name, f] of add) w.addStored(name, f.data, { crc: f.crc });
  const cover = preview || oldPreview;
  if (cover) {
    if (cover instanceof Uint8Array) await w.add(PREVIEW, cover);
    else await w.add(PREVIEW, new Uint8Array(await cover.arrayBuffer()));
  }
  await w.add(SCENE, enc.encode(serialize(doc)), { deflate: true });
  const out = w.finish();
  return { at: out.start, chunks: out.chunks, size: out.size, index: out.index, mode };
}

/** A chunk that copies `length` bytes of the current file from `offset`. */
function rangeOf(reader, offset, length) {
  return reader.blob ? reader.blob.slice(offset, offset + length) : { range: [offset, length] };
}

/** Choose a save mode: compaction when much of the file is dead space. */
export function chooseMode({ index, size, atomic }) {
  if (!index) return 'full';
  const dead = deadBytes(index, size);
  if (dead > 16 * 1024 * 1024 && dead > size * 0.35) return 'full';
  if (index.recovered) return 'full';
  return atomic ? 'tail' : 'append';
}

/** A new, empty canvas file's chunks (for a doc with no assets). */
export async function newCanvasFile(doc) {
  const plan = await planSave({ doc, mode: 'full' });
  return plan.chunks;
}

/** The parsed preview / scene of a canvas without loading it (sidebar covers). */
export async function readPreview(reader) {
  const index = await readZip(reader, { recover: false });
  const e = index.byName.get(PREVIEW);
  return e ? readEntry(reader, e) : null;
}

export async function readTitle(reader) {
  const index = await readZip(reader, { recover: false });
  const e = index.byName.get(SCENE);
  if (!e) return null;
  try { return JSON.parse(dec.decode(await readEntry(reader, e))).title || null; } catch { return null; }
}

export { STORE };

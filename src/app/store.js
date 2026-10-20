// The open canvas: its document, where its bytes are, and saving.
//
// Image bytes are never loaded as a whole: images in the file are Blob slices
// of the File (read from disk on demand), new images are the dropped File
// objects themselves (or pasted bytes) until the next save writes them in.

import { blobReader, entryBlob, readEntry } from '../core/zip.js';
import { openCanvas, planSave, chooseMode, deadBytes, referencedFiles, MIMETYPE } from '../core/canvasfile.js';
import { emptyCanvas, normalize, serialize, merge3, assetPath, takenPaths, now } from '../core/model.js';
import { imageInfo, IMAGE_TYPES } from '../core/imageinfo.js';
import { parsePureRef } from '../core/pureref.js';
import { purItems } from '../core/purdoc.js';
import { work } from './images.js';

/** Previews are WebP; where the browser cannot write WebP (Safari) JPEG or PNG — named by what they are. */
const THUMB_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const thumbPath = (id, type) => `thumbs/${id}.${THUMB_EXT[type] || 'webp'}`;
const thumbType = (path) => ({ jpg: 'image/jpeg', png: 'image/png' })[String(path).split('.').pop()] || 'image/webp';

export class Store {
  constructor() {
    this.source = null; // disk.js source
    this.kind = null; // 'canvas' | 'pur' | 'new'
    this.file = null; // Blob / File snapshot of the source
    this.reader = null;
    this.index = null; // ZIP directory
    this.doc = null;
    this.base = null; // serialize(doc) as last read / written (for merges)
    this.mtime = null;
    this.pending = new Map(); // asset id → { blob, crc? } images not in the file yet
    this.thumbs = new Map(); // asset id → { blob, crc } previews not in the file yet
    this.purBlobs = new Map(); // asset id → Blob (PureRef images)
    this.readOnly = false;
    this.warnings = [];
  }

  get writable() { return !!this.source?.writable && this.kind === 'canvas' && !this.readOnly; }

  // ---- open ----------------------------------------------------------------------------------

  static async open(source, { readOnly = false } = {}) {
    const s = new Store();
    s.source = source;
    s.readOnly = readOnly || !source.writable;
    const file = await source.getFile();
    if (/\.pur$/i.test(source.name) || (await looksLikePur(file))) await s.#loadPur(file);
    else await s.#loadCanvas(file);
    return s;
  }

  static blank(title) {
    const s = new Store();
    s.kind = 'new';
    s.doc = emptyCanvas({ title });
    s.base = serialize(s.doc);
    return s;
  }

  async #loadCanvas(file) {
    const reader = blobReader(file);
    const c = await openCanvas(reader);
    this.kind = 'canvas';
    this.file = file;
    this.reader = reader;
    this.index = c.index;
    this.doc = c.doc;
    this.base = serialize(c.doc);
    this.mtime = file.lastModified ?? null;
    this.warnings = c.warnings;
  }

  async #loadPur(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const pur = parsePureRef(u8);
    const doc = emptyCanvas({ title: (this.source?.name || 'PureRef').replace(/\.pur$/i, '') });
    const taken = new Set();
    pur.images.forEach((im, i) => {
      const id = `p${i + 1}`;
      const info = imageInfo(im.data.subarray(0, Math.min(im.data.length, 1 << 20)));
      const ext = info?.ext || IMAGE_TYPES[im.mime] || 'bin';
      const item = pur.items.find((it) => it.image === i && it.name);
      const name = item?.name || (im.path ? String(im.path).split(/[\/]/).pop() : null) || `pureref-${i + 1}`;
      doc.assets[id] = { file: assetPath(name, ext, taken), type: info?.type || im.mime, w: im.width || info?.w || 0, h: im.height || info?.h || 0, bytes: im.data.length, name };
      // contiguous in the file: a slice of the File (the bytes stay on disk); else the
      // parser assembled them (SQLite overflow pages) and they are copied into a Blob
      const blob = im.data.buffer === u8.buffer ? file.slice(im.data.byteOffset, im.data.byteOffset + im.data.length, doc.assets[id].type) : new Blob([im.data], { type: doc.assets[id].type });
      this.purBlobs.set(id, blob);
    });
    // on our own widgets: images, group frames, notes (stable ids: the file is read again on every open)
    doc.items = purItems(pur, (i) => `p${i + 1}`, (kind, n) => `p${({ stroke: 'k', shape: 'f' })[kind] || kind[0]}${n}`).items;
    this.kind = 'pur';
    this.readOnly = true;
    this.file = file;
    this.doc = normalize(doc);
    this.base = serialize(this.doc);
    this.mtime = file.lastModified ?? null;
    this.warnings = pur.warnings || [];
    this.pur = { version: pur.version, texts: pur.texts?.length || 0 };
  }

  // ---- bytes for the renderer ------------------------------------------------------------------

  /** A Blob of an asset's preview ('thumb') or original. */
  async blob(id, kind) {
    const a = this.doc?.assets[id];
    if (!a) return null;
    if (kind === 'thumb') {
      const t = this.thumbs.get(id);
      if (t) return t.blob;
      const e = a.thumb && this.index?.byName.get(a.thumb);
      return e ? entryBlob(this.reader, e, thumbType(a.thumb)) : null;
    }
    const p = this.pending.get(id);
    if (p) return p.blob;
    if (this.purBlobs.has(id)) return this.purBlobs.get(id);
    const e = this.index?.byName.get(a.file);
    return e ? entryBlob(this.reader, e, a.type) : null;
  }

  /** Is the asset's original in the file already (or about to be)? */
  hasOriginal(id) {
    const a = this.doc.assets[id];
    return !!(a && (this.pending.has(id) || this.purBlobs.has(id) || this.index?.byName.has(a.file)));
  }

  // ---- adding images ----------------------------------------------------------------------------

  /**
   * Import image blobs (File objects or pasted bytes): hash, preview, colour.
   * Returns [{ id, asset, w, h, name }] in order; already known images reuse their asset.
   * Mutates nothing: the caller adds `assets` to the doc in one undoable step.
   */
  async importImages(blobs, { onProgress } = {}) {
    const out = [];
    const assets = {};
    const taken = takenPaths(this.doc);
    let done = 0;
    const results = await Promise.all(blobs.map(async (b) => {
      try { return await work('import', b); } catch (e) { return { error: e.message }; } finally { onProgress?.(++done, blobs.length); }
    }));
    results.forEach((r, i) => {
      const b = blobs[i];
      if (r.error) { out.push({ error: r.error, name: b.name || 'image' }); return; }
      const id = r.sha256.slice(0, 16);
      const known = this.doc.assets[id] || assets[id];
      if (!known) {
        const name = b.name || `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${r.ext}`;
        assets[id] = { file: assetPath(name, r.ext, taken), type: r.type, w: r.w, h: r.h, bytes: r.bytes, sha256: r.sha256, thumb: thumbPath(id, r.thumbType), color: r.color, name, source: b.source || null, added: now() };
        this.pending.set(id, { blob: b, crc: r.crc });
        this.thumbs.set(id, { blob: r.thumb, crc: r.thumbCrc });
      }
      const a = this.doc.assets[id] || assets[id];
      out.push({ id, asset: a, w: a.w, h: a.h, name: a.name });
    });
    return { list: out, assets };
  }

  /** Assets without a preview or colour (added by the CLI, PureRef): make them, one at a time. */
  async fillMissingPreviews({ limit = 8, onChange } = {}) {
    if (!this.doc) return 0;
    const todo = Object.entries(this.doc.assets).filter(([id, a]) => (!a.thumb || !a.color || !(a.w > 0)) && !this.thumbs.has(id) && !this.failedPreview?.has(id)).slice(0, limit);
    let n = 0;
    for (const [id] of todo) {
      const blob = await this.blob(id, 'original');
      if (!blob || this.doc.assets[id] === undefined) continue;
      try {
        const r = await work('thumb', blob);
        this.thumbs.set(id, { blob: r.thumb, crc: r.thumbCrc });
        const a = this.doc.assets[id];
        if (!a) continue;
        this.doc.assets = { ...this.doc.assets, [id]: { ...a, thumb: thumbPath(id, r.thumbType), color: r.color, w: a.w || r.w, h: a.h || r.h } };
        n++;
      } catch {
        (this.failedPreview ||= new Set()).add(id);
      }
    }
    if (n) onChange?.(n);
    return n;
  }

  // ---- saving -----------------------------------------------------------------------------------------

  /** The files a save will add: new originals and previews the doc refers to. */
  async #additions() {
    const add = new Map();
    const refs = referencedFiles(this.doc);
    for (const [id, a] of Object.entries(this.doc.assets)) {
      if (!refs.has(a.file)) continue;
      const inFile = this.index?.byName.has(a.file);
      if (!inFile) {
        let p = this.pending.get(id);
        if (!p && this.purBlobs.has(id)) p = { blob: this.purBlobs.get(id) };
        if (!p) continue; // missing everywhere: validate() will report it
        if (p.crc === undefined) {
          const r = await work('import', p.blob);
          p = { blob: p.blob, crc: r.crc };
          this.pending.set(id, p);
          if (!a.thumb && !this.thumbs.has(id)) this.thumbs.set(id, { blob: r.thumb, crc: r.thumbCrc });
        }
        add.set(a.file, { data: p.blob, crc: p.crc });
      }
      const t = this.thumbs.get(id);
      if (t && a.thumb && (!this.index?.byName.has(a.thumb) || !inFile)) add.set(a.thumb, { data: t.blob, crc: t.crc });
      else if (t && !a.thumb) {
        const path = thumbPath(id, t.blob.type);
        this.doc.assets = { ...this.doc.assets, [id]: { ...a, thumb: path } };
        add.set(path, { data: t.blob, crc: t.crc });
      }
    }
    // previews generated for assets whose thumb entry is missing from the file
    for (const [id, t] of this.thumbs) {
      const a = this.doc.assets[id];
      if (a?.thumb && !add.has(a.thumb) && !this.index?.byName.has(a.thumb)) add.set(a.thumb, { data: t.blob, crc: t.crc });
    }
    return add;
  }

  /**
   * Write the document to `target` (default: the current source).
   * keep: files to keep although unreferenced (assets the undo history may bring back).
   */
  async save({ target = null, keep = new Set(), preview = null, mode = null } = {}) {
    const dest = target || this.source;
    if (!dest?.writable) throw new Error('read only');
    const switching = target && target !== this.source;
    const add = await this.#additions();
    const base = !switching && this.kind === 'canvas' && this.index ? { index: this.index, reader: this.reader } : null;
    if (switching && this.kind === 'canvas' && this.index) {
      // a new file: copy everything from the old one
      for (const id of Object.keys(this.doc.assets)) {
        const a = this.doc.assets[id];
        for (const name of [a.file, a.thumb]) {
          const e = name && !add.has(name) && this.index.byName.get(name);
          if (e) add.set(name, { data: await entryBlob(this.reader, e), crc: e.crc });
        }
      }
    }
    mode ||= base ? chooseMode({ index: this.index, size: this.file.size, atomic: dest.atomic }) : 'full';
    const plan = await planSave({ base, doc: this.doc, add, preview, mode, keep });
    const res = await dest.write(plan, this.file);
    // the file as it is now
    let file;
    if (dest.kind === 'fsa' || dest.kind === 'local') file = await dest.getFile(); // a fresh File: the old one may not read after a write
    else {
      const parts = plan.chunks.map((c) => (c.range ? this.file.slice(c.range[0], c.range[0] + c.range[1]) : c));
      file = new Blob(plan.mode === 'full' ? parts : [this.file.slice(0, plan.at), ...parts]);
    }
    this.source = dest;
    this.kind = 'canvas';
    this.readOnly = false;
    this.file = file;
    this.reader = blobReader(file);
    this.index = plan.index;
    this.mtime = res?.mtime ?? file.lastModified ?? Date.now();
    this.base = serialize(this.doc);
    // written: these now come from the file
    for (const [id, a] of Object.entries(this.doc.assets)) {
      if (this.index.byName.has(a.file)) { this.pending.delete(id); this.purBlobs.delete(id); }
      if (a.thumb && this.index.byName.has(a.thumb)) this.thumbs.delete(id);
    }
    return { mode: plan.mode, size: plan.size, dead: deadBytes(this.index, plan.size) };
  }

  // ---- outside changes ---------------------------------------------------------------------------

  /** Has the file changed on disk since we read / wrote it? */
  async changedOnDisk() {
    if (!this.source || this.source.kind === 'memory' || this.source.kind === 'cache') return false;
    const st = await this.source.stat();
    if (!st) return false;
    return this.mtime != null && Math.abs(st.mtime - this.mtime) > 1;
  }

  /**
   * Read the file again. With local edits (`dirty`), merge them in by item id.
   * Returns { conflicts, changedAssets }.
   */
  async reload({ dirty = false } = {}) {
    const file = await this.source.getFile();
    const reader = blobReader(file);
    const c = await openCanvas(reader);
    let doc = c.doc;
    let conflicts = [];
    if (dirty && this.base) {
      const r = merge3(normalize(this.base), this.doc, c.doc);
      doc = normalize(r.doc);
      conflicts = r.conflicts;
    }
    const changedAssets = Object.keys(doc.assets).filter((id) => this.doc.assets[id] && this.doc.assets[id].sha256 !== doc.assets[id].sha256);
    this.file = file;
    this.reader = reader;
    this.index = c.index;
    this.mtime = file.lastModified ?? null;
    this.base = serialize(c.doc);
    this.doc = doc;
    return { conflicts, changedAssets };
  }

  /** The original bytes of an asset as a File-like Blob with its name (export, copy). */
  async originalFile(id) {
    const a = this.doc.assets[id];
    const b = await this.blob(id, 'original');
    return b && new File([b], a.file.replace(/^images\//, ''), { type: a.type });
  }

  /** The whole canvas as one Blob (download / "save a copy" without the API). */
  async packBlob(preview = null) {
    const add = await this.#additions();
    if (this.index) {
      for (const a of Object.values(this.doc.assets)) {
        for (const name of [a.file, a.thumb]) {
          const e = name && !add.has(name) && this.index.byName.get(name);
          if (e) add.set(name, { data: await entryBlob(this.reader, e), crc: e.crc });
        }
      }
    }
    const plan = await planSave({ doc: this.doc, add, preview, mode: 'full' });
    return new Blob(plan.chunks, { type: MIMETYPE });
  }
}

async function looksLikePur(blob) {
  const u = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return !(u[0] === 0x50 && u[1] === 0x4b); // not "PK": not a zip
}

export { readEntry };

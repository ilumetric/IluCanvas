// Where canvases come from and go to. A "source" is
//   { kind, name, path, writable, atomic, getFile() → File|Blob, stat() → { mtime, size } | null,
//     write(plan, base, expect?) → { mtime, size }, handle? }
// expect: { size, mtime } of the file the plan was made from. When the file on
// disk is not that one any more (an agent wrote it meanwhile), nothing is written
// and the error has `changed` set: the caller reads it again and saves again.
// kinds:
//   fsa    — a file handle (File System Access API, Chrome / Edge). Writes go to
//            the browser's swap file and replace the file atomically on close.
//   server — tools/serve.mjs on localhost (development, embedded browsers).
//   cache  — a downloaded copy in the browser's private storage (shared links); read only.
//   memory — a canvas not saved yet, or a PureRef file opened without the API; read only.
//   local  — a canvas kept in this browser's private storage (OPFS): Safari, Firefox.
// Remembered folders and recent files (their handles) live in IndexedDB, and so
// does the folder for boards downloaded from links (settings: linksDir).

import { opfsSupported, opfsAtomic, opfsDir, opfsWrite, opfsRemove, opfsList, changedSince, changedError } from './opfs.js';
import { readZip, blobReader } from '../core/zip.js';
import { readTitle } from '../core/canvasfile.js';

/** File System Access (Chrome, Edge). ?nofsa tries the app as Safari / Firefox see it. */
export const fsaSupported = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showDirectoryPicker' in window && !/[?&]nofsa\b/.test(location.search);
export const CANVAS_RE = /\.ilucanvas$/i;
export const PUR_RE = /\.pur$/i;
export const isBoardFile = (name) => CANVAS_RE.test(name) || PUR_RE.test(name);

export async function ensurePermission(handle, mode = 'readwrite') {
  try {
    if ((await handle.queryPermission?.({ mode })) === 'granted') return true;
    return (await handle.requestPermission?.({ mode })) === 'granted';
  } catch { return false; }
}
export async function hasPermission(handle, mode = 'readwrite') {
  try { return (await handle.queryPermission?.({ mode })) === 'granted'; } catch { return false; }
}

/** Write a save plan through a FileSystemWritableFileStream. */
async function writePlan(writable, plan, base) {
  if (plan.mode !== 'full') await writable.truncate(plan.at);
  let pos = plan.at;
  for (const c of plan.chunks) {
    const data = c.range ? base.slice(c.range[0], c.range[0] + c.range[1]) : c;
    await writable.write({ type: 'write', position: pos, data });
    pos += data.size ?? data.length;
  }
  await writable.truncate(pos);
}

export function fsaSource(handle, path = handle.name) {
  return {
    kind: 'fsa', name: handle.name, path, handle, writable: true, atomic: true,
    async getFile() { return handle.getFile(); },
    async stat() { try { const f = await handle.getFile(); return { mtime: f.lastModified, size: f.size }; } catch { return null; } },
    async write(plan, base, expect = null) {
      if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('permission');
      const w = await handle.createWritable({ keepExistingData: plan.mode !== 'full' });
      try {
        // the swap file is a copy of the file as it is now: it must be the one the plan was made from
        if (expect && changedSince(await handle.getFile(), expect)) throw changedError();
        await writePlan(w, plan, base);
      } catch (e) { await w.abort?.().catch(() => {}); throw e; }
      await w.close();
      const f = await handle.getFile();
      return { mtime: f.lastModified, size: f.size };
    },
  };
}

export function memorySource(name, blob = null) {
  return {
    kind: 'memory', name, path: null, writable: false,
    async getFile() { return blob; },
    async stat() { return null; },
    async write() { throw new Error('no file'); },
  };
}

// ---- boards kept in this browser (OPFS) ---------------------------------------------------------
// Where the File System Access API is missing (Safari, Firefox) boards live in
// the browser's private storage, boards/<key>~<n>.ilucanvas, and are downloaded
// as files. Saves go in place (append mode) unless the browser writes through a
// swap file. A rewrite from the start (compaction) goes to <key>~<n+1> and the
// old file is removed once the new one is complete: a crash in between leaves
// both, and the newest complete one wins.

const BOARDS = ['boards'];
const LOCAL_RE = /^([a-z0-9]+)~(\d+)\.ilucanvas$/;

/** Boards in this browser: [{ key, gen, name, handle, title, mtime, size }], newest first. */
export async function localBoards() {
  if (!opfsSupported()) return [];
  const byKey = new Map();
  for (const f of await opfsList(...BOARDS)) {
    const m = f.name.match(LOCAL_RE);
    if (!m) continue;
    if (!byKey.has(m[1])) byKey.set(m[1], []);
    byKey.get(m[1]).push({ key: m[1], gen: Number(m[2]), name: f.name, handle: f.handle });
  }
  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => b.gen - a.gen);
    let pick = null;
    for (const e of list) {
      try {
        const file = await e.handle.getFile();
        const index = await readZip(blobReader(file), { recover: false });
        pick = { ...e, file, index };
        break;
      } catch { /* incomplete: an older one */ }
    }
    if (pick) {
      for (const e of list) if (e.gen !== pick.gen) await opfsRemove(BOARDS, e.name).catch(() => {});
    } else {
      // none reads cleanly (cut off mid-save): the newest; opening it rebuilds its directory
      try { pick = { ...list[0], file: await list[0].handle.getFile() }; } catch { continue; }
    }
    let title = null;
    try { title = await readTitle(blobReader(pick.file)); } catch { /* none */ }
    out.push({ key: pick.key, gen: pick.gen, name: pick.name, handle: pick.handle, title: title || 'Canvas', mtime: pick.file.lastModified, size: pick.file.size });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** A board kept in this browser as a source the store reads and saves. */
export function localSource(entry) {
  const src = {
    kind: 'local', name: `${entry.title || 'Canvas'}.ilucanvas`, path: null, writable: true, atomic: opfsAtomic(), key: entry.key, entry,
    async getFile() { return (await (await opfsDir(...BOARDS)).getFileHandle(entry.name)).getFile(); },
    async stat() { try { const f = await src.getFile(); return { mtime: f.lastModified, size: f.size }; } catch { return null; } },
    async write(plan, base, expect = null) {
      const chunks = plan.chunks.map((c) => (c.range ? base.slice(c.range[0], c.range[0] + c.range[1]) : c));
      let f;
      if (expect && plan.mode === 'full' && !src.atomic) {
        const now = await src.stat();
        if (now && changedSince(now, expect)) throw changedError();
      }
      if (plan.mode === 'full' && !src.atomic && (await src.stat())?.size) {
        // in place, a rewrite from 0 would overwrite what it copies: a new file, then the old one goes
        const next = `${entry.key}~${entry.gen + 1}.ilucanvas`;
        f = await opfsWrite(BOARDS, next, 0, chunks, { keep: false });
        const old = entry.name;
        entry.gen += 1;
        entry.name = next;
        await opfsRemove(BOARDS, old);
      } else f = await opfsWrite(BOARDS, entry.name, plan.at, chunks, { keep: plan.mode !== 'full', expect });
      return { mtime: f.lastModified, size: f.size };
    },
  };
  return src;
}

/** A new, empty board in this browser (the store's first save writes it). */
export function newLocalEntry(title) {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  return { key, gen: 0, name: `${key}~0.ilucanvas`, title };
}

/** Copy a .ilucanvas file into this browser: its entry (with the board's title). */
export async function importLocal(file) {
  const entry = newLocalEntry(file.name.replace(/\.ilucanvas$/i, ''));
  const f = await opfsWrite(BOARDS, entry.name, 0, [file], { keep: false });
  try { entry.title = (await readTitle(blobReader(f))) || entry.title; } catch { /* keep the file name */ }
  return entry;
}

export async function removeLocal(entry) {
  await opfsRemove(BOARDS, entry.name);
}

export async function localUsage() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0, persisted: await navigator.storage.persisted?.() }; } catch { return null; }
}

// ---- pickers ------------------------------------------------------------------------------

const TYPES = [
  { description: 'IluCanvas', accept: { 'application/x-ilucanvas+zip': ['.ilucanvas'] } },
  { description: 'PureRef', accept: { 'application/octet-stream': ['.pur'] } },
];

export async function pickFiles() {
  const handles = await window.showOpenFilePicker({ id: 'ilucanvas', multiple: true, types: [{ description: 'IluCanvas / PureRef', accept: { 'application/octet-stream': ['.ilucanvas', '.pur'] } }], excludeAcceptAllOption: false });
  return handles;
}

export async function pickSaveFile(suggestedName = 'Canvas.ilucanvas') {
  return window.showSaveFilePicker({ id: 'ilucanvas', suggestedName, types: [TYPES[0]] });
}

export async function pickFolder() {
  return window.showDirectoryPicker({ id: 'ilucanvas-lib', mode: 'readwrite' });
}

/** The folder boards from links are downloaded into (Settings). */
export async function pickLinksFolder() {
  return window.showDirectoryPicker({ id: 'ilucanvas-links', mode: 'readwrite' });
}

/** Open files without the API (Firefox, Safari): read only. */
export function pickFileFallback(accept = '.ilucanvas,.pur') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) reject(new DOMException('cancelled', 'AbortError')); else resolve(f);
    };
    input.click();
  });
}

/** Image files from a picker (adding refs). */
export function pickImages() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*';
    input.onchange = () => resolve([...(input.files || [])]);
    input.click();
  });
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'Library', 'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', '__pycache__', 'Temp', 'Logs']);

/** Canvas and PureRef files in a folder (a few levels deep): [{ path, name, handle }]. */
export async function scanFolder(dir, { depth = 4, max = 2000 } = {}) {
  const out = [];
  let seen = 0;
  async function visit(d, path, level) {
    for await (const [name, h] of d.entries()) {
      if (++seen > 20000 || out.length >= max) return;
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (level < depth && !SKIP_DIRS.has(name)) await visit(h, [...path, name], level + 1); } else if (isBoardFile(name)) out.push({ path: [...path, name].join('/'), name, handle: h });
    }
  }
  await visit(dir, [], 0);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Image files in a dropped / picked folder handle, recursively. */
export async function imagesInFolder(dir, isImage, max = 5000) {
  const out = [];
  async function visit(d) {
    for await (const [name, h] of d.entries()) {
      if (out.length >= max || name.startsWith('.')) continue;
      if (h.kind === 'directory') await visit(h);
      else if (isImage(name)) out.push(await h.getFile());
    }
  }
  await visit(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Offer a blob for download. */
export function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- local server (tools/serve.mjs) -------------------------------------------------------------

const API = '__ilucanvas/';
let serverInfo;

export async function detectServer() {
  if (serverInfo !== undefined) return serverInfo;
  serverInfo = null;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return null;
  try {
    const r = await fetch(`${API}info`, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j.app === 'ilucanvas') serverInfo = j; }
  } catch { /* plain static server */ }
  return serverInfo;
}

export async function serverList() {
  const r = await fetch(`${API}list`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).files;
}

export function serverSource(path) {
  const q = `path=${encodeURIComponent(path)}`;
  return {
    kind: 'server', name: path.split('/').pop(), path, writable: true, atomic: true,
    async getFile() {
      const r = await fetch(`${API}file?${q}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'not found' : `HTTP ${r.status}`);
      // with the file's time: without it a reload could not tell an outside change any more
      const m = Number(r.headers.get('X-Mtime'));
      return new File([await r.blob()], path.split('/').pop(), Number.isFinite(m) && m > 0 ? { lastModified: m } : {});
    },
    async stat() {
      const r = await fetch(`${API}stat?${q}`, { cache: 'no-store' });
      return r.ok ? r.json() : null;
    },
    async write(plan, base, expect = null) {
      const parts = plan.chunks.map((c) => (c.range ? base.slice(c.range[0], c.range[0] + c.range[1]) : c));
      const check = expect ? `&size=${expect.size}${expect.mtime != null ? `&mtime=${expect.mtime}` : ''}` : '';
      const r = await fetch(`${API}write?${q}&at=${plan.mode === 'full' ? 0 : plan.at}${check}`, { method: 'POST', body: new Blob(parts), headers: { 'X-IluCanvas': '1' } });
      if (r.status === 409) throw changedError();
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
  };
}

// ---- IndexedDB: folders, recent files, shared links -----------------------------------------------

const DB = 'ilucanvas';
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      // v1: recent, folders, links, views; v2: settings (handles that do not fit localStorage)
      for (const [name, keyPath] of [['recent', 'key'], ['folders', 'key'], ['links', 'key'], ['views', 'id'], ['settings', 'key']]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => {
      // let a newer version in another tab upgrade the database
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

export async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const res = fn(t.objectStore(store));
    t.oncomplete = () => resolve(res?.result ?? res);
    t.onerror = () => reject(t.error);
  });
}
export const idbAll = async (store) => { try { return (await idb(store, 'readonly', (s) => s.getAll())) || []; } catch { return []; } };
export const idbPut = async (store, v) => { try { await idb(store, 'readwrite', (s) => s.put(v)); } catch { /* storage off */ } };
export const idbDel = async (store, k) => { try { await idb(store, 'readwrite', (s) => s.delete(k)); } catch { /* storage off */ } };
export const idbGet = async (store, k) => { try { return await idb(store, 'readonly', (s) => s.get(k)); } catch { return null; } };

const MAX_RECENT = 16;

/** Remember an opened file handle; returns its key. */
export async function rememberFile(handle, path, title) {
  const list = await idbAll('recent');
  let key = null;
  for (const r of list) if (r.handle && (await r.handle.isSameEntry?.(handle).catch(() => false))) key = r.key;
  key ||= `f:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  await idbPut('recent', { key, handle, path, title, at: Date.now() });
  const extra = (await idbAll('recent')).sort((a, b) => b.at - a.at).slice(MAX_RECENT);
  for (const e of extra) await idbDel('recent', e.key);
  return key;
}

export async function rememberFolder(handle) {
  const list = await idbAll('folders');
  for (const r of list) if (await r.handle.isSameEntry?.(handle).catch(() => false)) { await idbPut('folders', { ...r, at: Date.now() }); return r.key; }
  const key = `d:${Date.now()}`;
  await idbPut('folders', { key, handle, name: handle.name, at: Date.now() });
  return key;
}

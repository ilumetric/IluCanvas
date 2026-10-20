// The browser's private storage (OPFS): boards kept in this browser where the
// File System Access API is missing (Safari, Firefox) and downloaded copies of
// shared links. Writes go through a FileSystemWritableFileStream where there is
// one (a swap file, replaced on close: atomic). Safari has only sync access
// handles, which live in workers: opfsworker.js writes there, in place.

export const opfsSupported = () => typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

/** Writes go through a swap file (createWritable)? Else in place, from a worker. ?opfs=sync tries Safari's way. */
export const opfsAtomic = () => typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype
  && !(typeof location !== 'undefined' && /[?&]opfs=sync\b/.test(location.search));

export async function opfsDir(...path) {
  let d = await navigator.storage.getDirectory();
  for (const p of path) d = await d.getDirectoryHandle(p, { create: true });
  return d;
}

let worker = null;
let seq = 0;
const waiting = new Map();

function viaWorker(msg) {
  if (!worker) {
    worker = new Worker(new URL('./opfsworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) p?.resolve(data); else p?.reject(new Error(data.error));
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg });
  });
}

/**
 * Write `chunks` (Uint8Array | Blob) into file `name` in folder `path` from
 * offset `at` and end the file there. keep: false starts from an empty file.
 * Returns the file as it is now.
 */
export async function opfsWrite(path, name, at, chunks, { keep = true } = {}) {
  const dir = await opfsDir(...path);
  const fh = await dir.getFileHandle(name, { create: true });
  if (opfsAtomic()) {
    const w = await fh.createWritable({ keepExistingData: keep });
    try {
      let pos = at;
      for (const c of chunks) {
        await w.write({ type: 'write', position: pos, data: c });
        pos += c.size ?? c.length;
      }
      await w.truncate(pos);
    } catch (e) {
      await w.abort?.().catch(() => {});
      throw e;
    }
    await w.close();
  } else await viaWorker({ path, name, at, chunks, keep, truncate: true });
  return fh.getFile();
}

/** Stream a response body into a file (a shared link's download). Returns the file. */
export async function opfsStream(path, name, stream, { signal } = {}) {
  const dir = await opfsDir(...path);
  const fh = await dir.getFileHandle(name, { create: true });
  if (opfsAtomic()) {
    await stream.pipeTo(await fh.createWritable(), { signal });
    return fh.getFile();
  }
  // in pieces of ~16 MB: the worker writes each as it fills
  const reader = stream.getReader();
  let at = 0;
  let parts = [];
  let size = 0;
  const flush = async (last) => {
    await viaWorker({ path, name, at, chunks: parts, keep: at > 0, truncate: last });
    at += size;
    parts = [];
    size = 0;
  };
  for (;;) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); throw new DOMException('aborted', 'AbortError'); }
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size >= 16 * 1024 * 1024) await flush(false);
  }
  await flush(true);
  return fh.getFile();
}

export async function opfsRemove(path, name) {
  try { await (await opfsDir(...path)).removeEntry(name); } catch { /* gone */ }
}

/** [{ name, handle }] of the files in a folder. */
export async function opfsList(...path) {
  const out = [];
  const dir = await opfsDir(...path);
  for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push({ name, handle: h });
  return out;
}

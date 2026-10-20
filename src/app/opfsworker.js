// Writes into the browser's private storage (OPFS) through a sync access
// handle — the only way Safari writes there. In place: what is not written
// stays. { id, path, name, at, chunks: (Uint8Array | Blob)[], keep, truncate }

const PIECE = 8 * 1024 * 1024;

/** Older Safari's handles return promises: await works for both. */
async function put(h, u8, at) {
  let done = 0;
  while (done < u8.length) {
    const n = await h.write(done ? u8.subarray(done) : u8, { at: at + done });
    if (!(n > 0)) throw new Error('could not write');
    done += n;
  }
}

self.onmessage = async ({ data }) => {
  const { id, path, name, at, chunks, keep, truncate } = data;
  let h = null;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const p of path) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    h = await fh.createSyncAccessHandle();
    if (!keep) await h.truncate(0);
    let pos = at;
    for (const c of chunks) {
      if (c instanceof Blob) {
        for (let o = 0; o < c.size; o += PIECE) {
          const u8 = new Uint8Array(await c.slice(o, o + PIECE).arrayBuffer());
          await put(h, u8, pos);
          pos += u8.length;
        }
      } else {
        await put(h, c, pos);
        pos += c.length;
      }
    }
    if (truncate) await h.truncate(pos);
    await h.flush();
    const size = await h.getSize();
    await h.close();
    h = null;
    self.postMessage({ id, ok: true, size });
  } catch (e) {
    try { await h?.close(); } catch { /* closed */ }
    self.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
};

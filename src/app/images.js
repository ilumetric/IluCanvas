// Decoded images for the renderer, by level of detail, within a memory budget.
//
// Levels (longest side, px): 0 → 128, 1 → 512, 2 → 2048, 3 → 8192 (originals
// up to 8K; 4K on iOS). Levels 0–1 come from the stored ≤ 512 px preview, so a board full
// of 40-megapixel photos opens by decoding a few KB per image; originals are
// decoded only for images that are big on screen. Bitmaps not drawn for a
// while are closed, oldest first, when the budget is exceeded.
//
// The renderer, every frame: get(asset, level) → the best bitmap available now
// (or null), want(asset, level, priority) → schedule what it would like; then
// flush() starts the most urgent decodes.
//
// iPad / iPhone (Safari): a tab gets far less memory, so the budget is small and
// originals stop at 4096 px.

/** iOS and iPadOS (which says it is a Mac, but has a touch screen). */
export const IOS = typeof navigator !== 'undefined' && (/iP(ad|hone|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export const LEVELS = [128, 512, 2048, IOS ? 4096 : 8192];

/** The level for an image `px` device pixels across on screen whose natural longest side is `natural`. */
export function levelFor(px, natural) {
  let l = 0;
  while (l < LEVELS.length - 1 && LEVELS[l] < px * 0.9) l++;
  return Math.min(l, maxLevel(natural));
}
export function maxLevel(natural) {
  let l = 0;
  while (l < LEVELS.length - 1 && LEVELS[l] < natural) l++;
  return l;
}

// ---- worker pool -------------------------------------------------------------------------

let pool = null;
let seq = 0;
const waiting = new Map();

function workers() {
  if (pool) return pool;
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  pool = Array.from({ length: n }, () => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.busy = 0;
    w.onmessage = ({ data }) => {
      const p = waiting.get(data.id);
      if (!p) return;
      waiting.delete(data.id);
      p.w.busy--;
      if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
    };
    return w;
  });
  return pool;
}

/** Run an op in the least busy worker: 'import' (hash + preview) or 'thumb'. */
export function work(op, blob) {
  const w = workers().reduce((a, b) => (b.busy < a.busy ? b : a));
  const id = ++seq;
  w.busy++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, w });
    w.postMessage({ id, op, blob });
  });
}

/**
 * A smaller copy of a bitmap. createImageBitmap's resize options where they work;
 * where they are ignored (the result is still big) a canvas does it.
 */
async function scaled(bitmap, w, h, quality) {
  try {
    const b = await createImageBitmap(bitmap, { resizeWidth: w, resizeHeight: h, resizeQuality: quality });
    if (b.width <= w * 1.25 && b.height <= h * 1.25) return b;
    b.close();
  } catch { /* no resize options */ }
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = quality;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return createImageBitmap(c);
}

// ---- the cache -------------------------------------------------------------------------------

export class ImageCache {
  /**
   * resolve(assetId, 'thumb' | 'original') → Promise<Blob | null>
   * natural(assetId) → longest side in px (0 if unknown)
   */
  constructor({ resolve, natural, onLoad, budget }) {
    this.resolve = resolve;
    this.natural = natural;
    this.onLoad = onLoad;
    // Safari and Firefox do not tell the memory: assume little
    const mem = navigator.deviceMemory ? navigator.deviceMemory * 1024 ** 3 : 0;
    this.budget = budget || (IOS ? 400 * 1024 ** 2 : mem ? Math.min(2.5 * 1024 ** 3, mem * 0.3) : 1024 ** 3);
    this.map = new Map(); // `${asset}:${level}` → { bitmap, bytes, used }
    this.failed = new Map(); // asset → level that failed (originals of broken files)
    this.wants = new Map(); // key → { asset, level, prio }
    this.inflight = new Map(); // key → token
    this.bytes = 0;
    this.frame = 0;
    this.maxInflight = 4;
    this.generation = 0;
  }

  /** Forget everything (another canvas was opened). */
  clear() {
    for (const e of this.map.values()) e.bitmap.close();
    this.map.clear();
    this.failed.clear();
    this.wants.clear();
    this.inflight.clear();
    this.bytes = 0;
    this.generation++;
  }

  /** Drop the bitmaps of one asset (its file changed). */
  forget(asset) {
    for (const [k, e] of this.map) if (k.startsWith(`${asset}:`)) { e.bitmap.close(); this.bytes -= e.bytes; this.map.delete(k); }
    this.failed.delete(asset);
  }

  beginFrame() { this.frame++; this.wants.clear(); }

  /** Best bitmap available for (asset, level): the exact level, else the nearest other. */
  get(asset, level) {
    let e = this.map.get(`${asset}:${level}`);
    if (!e) for (let l = level - 1; l >= 0 && !e; l--) e = this.map.get(`${asset}:${l}`);
    if (!e) for (let l = level + 1; l < LEVELS.length && !e; l++) e = this.map.get(`${asset}:${l}`);
    if (e) e.used = this.frame;
    return e ? e.bitmap : null;
  }

  has(asset, level) { return this.map.has(`${asset}:${level}`); }
  isBroken(asset) { return this.failed.get(asset) === 0; }

  want(asset, level, prio) {
    const key = `${asset}:${level}`;
    const e = this.map.get(key);
    if (e) { e.used = this.frame; return; }
    const f = this.failed.get(asset);
    if (f !== undefined && level >= f) level = f - 1;
    if (level < 0) return;
    const k2 = `${asset}:${level}`;
    if (this.map.has(k2)) return;
    const w = this.wants.get(k2);
    if (!w || w.prio > prio) this.wants.set(k2, { asset, level, prio });
  }

  /** Start the most urgent decodes; then trim the cache. */
  flush() {
    if (this.inflight.size < this.maxInflight && this.wants.size) {
      const list = [...this.wants.entries()].filter(([k]) => !this.inflight.has(k)).sort((a, b) => a[1].prio - b[1].prio);
      for (const [key, w] of list) {
        if (this.inflight.size >= this.maxInflight) break;
        this.#load(key, w);
      }
    }
    if (this.bytes > this.budget) this.#evict();
  }

  async #load(key, { asset, level }) {
    const gen = this.generation;
    this.inflight.set(key, gen);
    try {
      const natural = this.natural(asset);
      const target = LEVELS[level];
      let blob = null;
      let fromThumb = false;
      if (level <= 1) { blob = await this.resolve(asset, 'thumb'); fromThumb = !!blob; }
      if (!blob) blob = await this.resolve(asset, 'original');
      if (!blob) throw new Error('missing');
      let bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const side = Math.max(bitmap.width, bitmap.height);
      if (side > target * 1.05 && !(fromThumb && level === 1)) {
        const k = target / side;
        const small = await scaled(bitmap, Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)), level <= 1 ? 'high' : 'medium');
        if (small !== bitmap) bitmap.close();
        bitmap = small;
      }
      if (gen !== this.generation) { bitmap.close(); return; }
      const bytes = bitmap.width * bitmap.height * 4;
      this.map.set(key, { bitmap, bytes, used: this.frame, natural });
      this.bytes += bytes;
    } catch (e) {
      // an original that cannot be decoded: stay on the preview; nothing at all: broken
      if (gen === this.generation) this.failed.set(asset, level >= 2 ? Math.min(this.failed.get(asset) ?? 99, 2) : 0);
    } finally {
      if (this.inflight.get(key) === gen) this.inflight.delete(key);
      if (gen === this.generation) this.onLoad?.();
    }
  }

  #evict() {
    const old = [...this.map.entries()].filter(([, e]) => e.used < this.frame - 1).sort((a, b) => a[1].used - b[1].used || b[1].bytes - a[1].bytes);
    for (const [k, e] of old) {
      if (this.bytes <= this.budget * 0.85) break;
      e.bitmap.close();
      this.bytes -= e.bytes;
      this.map.delete(k);
    }
  }

  stats() { return { bitmaps: this.map.size, mb: Math.round(this.bytes / 1048576), budgetMb: Math.round(this.budget / 1048576), queued: this.wants.size, inflight: this.inflight.size }; }
}

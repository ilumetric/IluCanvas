// Image worker: everything heavy about a new image happens here, off the UI
// thread — hashing (SHA-256 for the content address, CRC-32 for the ZIP),
// decoding, the ≤ 512 px WebP preview and the average colour (shown while the
// image itself is still loading, and when it is a few pixels on screen).
//
// { id, op: 'import', blob }  → { sha256, crc, type, ext, w, h, bytes, thumb, thumbCrc, color }
// { id, op: 'thumb', blob }   → { w, h, thumb, thumbCrc, color }

import { crc32 } from '../core/crc32.js';
import { imageInfo } from '../core/imageinfo.js';

const THUMB = 512;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function preview(blob) {
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const w = full.width;
  const h = full.height;
  const k = Math.min(1, THUMB / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * k));
  const th = Math.max(1, Math.round(h * k));
  let small = full;
  if (k < 1) {
    try { small = await createImageBitmap(full, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' }); } catch { small = full; }
  }
  const c = new OffscreenCanvas(tw, th);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, tw, th); // sizes given: right even where the resize options are ignored
  // average colour of the visible pixels
  const tiny = new OffscreenCanvas(8, 8);
  const tctx = tiny.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(small, 0, 0, 8, 8);
  const px = tctx.getImageData(0, 0, 8, 8).data;
  let r = 0; let g = 0; let b = 0; let n = 0;
  let alpha = false;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    if (px[i + 3] < 250) alpha = true;
    r += px[i] * a; g += px[i + 1] * a; b += px[i + 2] * a; n += a;
  }
  const thumb = await encode(c, alpha);
  const to = (v) => Math.round(n ? v / n : 128).toString(16).padStart(2, '0');
  if (small !== full) small.close();
  full.close();
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
  return { w, h, thumb: new Blob([thumbBytes], { type: thumb.type }), thumbCrc: crc32(thumbBytes), thumbType: thumb.type, color: `#${to(r)}${to(g)}${to(b)}` };
}

/**
 * The preview's file: WebP; where the browser cannot write WebP (Safari hands
 * back PNG instead) JPEG, or PNG when the image has transparency.
 */
async function encode(c, alpha) {
  const webp = await c.convertToBlob({ type: 'image/webp', quality: 0.82 });
  if (webp.type === 'image/webp') return webp;
  if (alpha) return webp.type === 'image/png' ? webp : c.convertToBlob({ type: 'image/png' });
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

self.onmessage = async ({ data }) => {
  const { id, op, blob } = data;
  try {
    if (op === 'import') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = imageInfo(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
      if (!info) throw new Error('unsupported');
      const [digest, p] = await Promise.all([crypto.subtle.digest('SHA-256', bytes), preview(blob)]);
      self.postMessage({ id, ok: true, result: { sha256: hex(digest), crc: crc32(bytes), type: info.type, ext: info.ext, bytes: bytes.length, ...p } });
    } else if (op === 'thumb') {
      self.postMessage({ id, ok: true, result: await preview(blob) });
    } else throw new Error(`unknown op ${op}`);
  } catch (e) {
    self.postMessage({ id, ok: false, error: e?.message || String(e) });
  }
};

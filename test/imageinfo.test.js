import test from 'node:test';
import assert from 'node:assert/strict';
import { imageInfo } from '../src/core/imageinfo.js';

const bytes = (...parts) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p])));
const le16 = (v) => [v & 255, v >> 8];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const be16 = (v) => [v >> 8, v & 255];
const be32 = (v) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];

const png = bytes([0x89], 'PNG\r\n', [0x1a, 0x0a], be32(13), 'IHDR', be32(640), be32(480), [8, 6, 0, 0, 0]);
const bmp = bytes('BM', le32(0), le32(0), le32(54), le32(40), le32(640), le32(-480), le16(1), le16(24));
const os2 = bmp.slice(); // OS/2 1.x core header: 12 bytes, 16-bit sides
os2.set([...le32(12), ...le16(640), ...le16(480), ...le16(1), ...le16(24)], 14);
const vp8x = bytes('RIFF', le32(0), 'WEBP', 'VP8X', le32(10), [0, 0, 0, 0], [0x7f, 0x02, 0], [0xdf, 0x01, 0]); // 640 × 480
/** A JPEG: APP1 Exif (big-endian TIFF, one IFD entry: orientation `o`), then SOF0 h × w. */
function jpeg(o, { h = 50, w = 100, ifd = 8 } = {}) {
  const tiff = ['MM', be16(42), be32(ifd), be16(1), be16(0x0112), be16(3), be32(1), be16(o), [0, 0]];
  const exif = bytes('Exif', [0, 0], ...tiff);
  return bytes([0xff, 0xd8], [0xff, 0xe1], be16(exif.length + 2), exif, [0xff, 0xc0], be16(17), [8], be16(h), be16(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);
}

test('image sizes from headers', () => {
  assert.deepEqual(imageInfo(png), { type: 'image/png', ext: 'png', w: 640, h: 480, orientation: 1 });
  assert.deepEqual([imageInfo(bmp).w, imageInfo(bmp).h], [640, 480], 'a top-down BMP (negative height)');
  assert.deepEqual([imageInfo(os2).w, imageInfo(os2).h], [640, 480], 'an OS/2 BMP');
  assert.deepEqual([imageInfo(vp8x).w, imageInfo(vp8x).h], [640, 480]);
  assert.deepEqual(imageInfo(jpeg(6)), { type: 'image/jpeg', ext: 'jpg', w: 50, h: 100, orientation: 6 }, 'turned 90°: sides swapped');
  assert.deepEqual([imageInfo(jpeg(1)).w, imageInfo(jpeg(1)).h], [100, 50]);
});

test('EXIF orientation: only 1–8, only from inside its APP1 segment', () => {
  assert.equal(imageInfo(jpeg(300)).orientation, 1);
  assert.equal(imageInfo(jpeg(0)).orientation, 1);
  // an IFD offset pointing past the segment, at bytes that look like an orientation entry
  const j = jpeg(6, { ifd: 40 });
  const bait = bytes(be16(1), be16(0x0112), be16(3), be32(1), be16(6), [0, 0]);
  const tail = j.length - 2;
  const k = new Uint8Array(j.length + 64);
  k.set(j.subarray(0, tail));
  k.set(bait, 12 + 40); // the TIFF block starts at 12 (after FFD8, FFE1, length, "Exif\0\0")
  assert.ok(12 + 40 >= 4 + ((j[4] << 8) | j[5]), 'the bait is past the end of the APP1 segment');
  assert.equal(imageInfo(k).orientation, 1);
});

test('truncated headers: size unknown (0), never NaN or made up', () => {
  for (const full of [png, bmp, os2, vp8x, jpeg(6)]) {
    for (let n = 12; n < full.length; n++) {
      const info = imageInfo(full.subarray(0, n));
      if (!info) continue;
      assert.ok(Number.isFinite(info.w) && Number.isFinite(info.h), `${info.type} cut at ${n}: ${info.w}×${info.h}`);
      const real = imageInfo(full);
      assert.ok((info.w === 0 && info.h === 0) || (info.w === real.w && info.h === real.h), `${info.type} cut at ${n}: ${info.w}×${info.h}`);
    }
  }
});

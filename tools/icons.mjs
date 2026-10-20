// PNG icons from the logo's geometry (icon.svg): the iPad / iPhone home screen
// icon and the install icons. No dependencies: rounded rectangles, 4×4
// supersampling, a PNG written with zlib. Run: node tools/icons.mjs

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = [0xff, 0xd2, 0x3f];
const INK = [0x1c, 0x19, 0x17];
// icon.svg, 64 × 64: the four tiles (x, y, w, h, corner radius)
const TILES = [[12, 12, 17, 21, 2], [35, 12, 17, 13, 2], [35, 31, 17, 21, 2], [12, 39, 17, 13, 2]];

function inRound(x, y, [rx, ry, w, h, r]) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** RGB pixels of the icon at `size`; `bleed`: the background fills the square (iOS rounds it itself). */
function render(size, { corner = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ink = 0;
      let cover = 0;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const u = ((x + (i + 0.5) / S) / size) * 64;
          const v = ((y + (j + 0.5) / S) / size) * 64;
          if (corner && !inRound(u, v, [0, 0, 64, 64, corner])) continue;
          cover++;
          if (TILES.some((t) => inRound(u, v, t))) ink++;
        }
      }
      const k = cover ? ink / cover : 0;
      const o = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - k) + INK[c] * k);
      px[o + 3] = Math.round((cover / (S * S)) * 255);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = [
  ['apple-touch-icon.png', 180, {}], // full square: iOS rounds the corners
  ['icon-192.png', 192, {}], // install icons, "maskable": the tiles sit in the safe zone
  ['icon-512.png', 512, {}],
];
for (const [name, size, o] of out) {
  writeFileSync(join(ROOT, name), png(size, render(size, o)));
  console.log(`wrote ${name} (${size}×${size})`);
}

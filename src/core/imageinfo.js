// Image type and size from the first bytes of a file, without decoding it.
// Used by the CLI (no image decoder in Node) and as a quick check in the app.
// Width / height are as displayed: a JPEG with an EXIF rotation of 90° reports
// its sides swapped.

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };

export const typeFromName = (name) => EXT_TYPES[String(name).split('.').pop().toLowerCase()] || null;
export const isImageName = (name) => !!typeFromName(name);

const be16 = (u, o) => (u[o] << 8) | u[o + 1];
const be32 = (u, o) => ((u[o] << 24) >>> 0) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3];
const le16 = (u, o) => u[o] | (u[o + 1] << 8);
const le32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16)) + u[o + 3] * 0x1000000;
const ascii = (u, o, n) => String.fromCharCode(...u.subarray(o, o + n));

/** The image type from magic bytes, or null. */
export function sniffType(u) {
  if (u.length < 12) return null;
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  if (u[0] === 0x89 && ascii(u, 1, 3) === 'PNG') return 'image/png';
  if (ascii(u, 0, 4) === 'RIFF' && ascii(u, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(u, 0, 4) === 'GIF8') return 'image/gif';
  if (u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp';
  if (ascii(u, 4, 4) === 'ftyp' && /^(avif|avis)/.test(ascii(u, 8, 4))) return 'image/avif';
  return null;
}

/**
 * { type, ext, w, h, orientation } from the file's first bytes (64 KB is plenty
 * for everything but JPEGs with huge EXIF blocks — pass more, or the whole file).
 * Returns null when the type is unknown; w/h are 0 when the size was not found.
 */
export function imageInfo(u) {
  const type = sniffType(u);
  if (!type) return null;
  let w = 0;
  let h = 0;
  let orientation = 1;
  const n = u.length;
  try {
    if (type === 'image/png') { if (n >= 24) { w = be32(u, 16); h = be32(u, 20); } }
    else if (type === 'image/gif') { w = le16(u, 6); h = le16(u, 8); }
    else if (type === 'image/bmp') ({ w, h } = bmpSize(u));
    else if (type === 'image/webp') ({ w, h } = webpSize(u));
    else if (type === 'image/jpeg') ({ w, h, orientation } = jpegSize(u));
    else if (type === 'image/avif') ({ w, h } = avifSize(u));
  } catch { /* truncated header: size unknown */ }
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) { w = 0; h = 0; } // never NaN or half a size
  if (orientation >= 5 && orientation <= 8) [w, h] = [h, w];
  return { type, ext: IMAGE_TYPES[type], w, h, orientation };
}

function bmpSize(u) {
  if (u.length < 26) return { w: 0, h: 0 };
  // OS/2 1.x core header (12 bytes): 16-bit sides; the later ones 32-bit (negative height: top-down)
  if (le32(u, 14) === 12) return { w: le16(u, 18), h: le16(u, 20) };
  return { w: Math.abs(le32(u, 18) | 0), h: Math.abs(le32(u, 22) | 0) };
}

function webpSize(u) {
  const chunk = ascii(u, 12, 4);
  if (chunk === 'VP8 ' && u.length >= 30) return { w: le16(u, 26) & 0x3fff, h: le16(u, 28) & 0x3fff };
  if (chunk === 'VP8L' && u.length >= 25) {
    const b = le32(u, 21);
    return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && u.length >= 30) return { w: 1 + (u[24] | (u[25] << 8) | (u[26] << 16)), h: 1 + (u[27] | (u[28] << 8) | (u[29] << 16)) };
  return { w: 0, h: 0 };
}

function jpegSize(u) {
  let o = 2;
  let orientation = 1;
  while (o + 9 < u.length) {
    if (u[o] !== 0xff) { o++; continue; }
    const m = u[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    const len = be16(u, o + 2);
    if (m === 0xe1 && orientation === 1 && ascii(u, o + 4, 4) === 'Exif') orientation = exifOrientation(u, o + 10, Math.min(u.length, o + 2 + len)) || 1;
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: be16(u, o + 5), w: be16(u, o + 7), orientation };
    }
    if (m === 0xda) break; // image data: no size before it
    o += 2 + len;
  }
  return { w: 0, h: 0, orientation };
}

/** The orientation tag of the TIFF block at t, read only inside its APP1 segment (end); 0 when absent or not 1–8. */
function exifOrientation(u, t, end) {
  if (t + 8 > end || u[t] !== u[t + 1] || (u[t] !== 0x49 && u[t] !== 0x4d)) return 0;
  const le = u[t] === 0x49;
  const r16 = (o) => (le ? le16(u, o) : be16(u, o));
  const r32 = (o) => (le ? le32(u, o) : be32(u, o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > end) return 0;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}

function avifSize(u) {
  for (let i = 4; i + 16 < u.length; i++) {
    if (u[i] === 0x69 && ascii(u, i, 4) === 'ispe') return { w: be32(u, i + 8), h: be32(u, i + 12) };
  }
  return { w: 0, h: 0 };
}

// PureRef (.pur) reader. Read-only and dependency-free.
//
// Runs anywhere that has Uint8Array, DataView and TextDecoder (browsers, Node 20+).
// No DOM and no Node APIs.
//
// Two on-disk formats are handled:
//   * PureRef 2.x (verified against a 2.1.3 file): a Qt QDataStream header followed by a
//     SQLite 3 database. The first H bytes of the database are moved to the end of
//     the file so the header can sit at offset 0. A small read-only SQLite B-tree
//     reader below pulls rows out of that database.
//   * PureRef 1.x (layout taken from FyorDev/PureRef-format and not verified against a
//     real 1.x file): one flat QDataStream with image bytes, items and a reference table.
//
// The byte layout and the list of unknown fields are in docs/PUREREF.md.

const UTF8 = new TextDecoder('utf-8');

function fail(msg, offset) {
  const at = offset === undefined || offset === null ? '' : ` (at byte ${offset})`;
  throw new Error(`PureRef: ${msg}${at}`);
}

// ---------------------------------------------------------------------------------------
// Big-endian byte reader with bounds checks. `base` is the absolute file offset of
// u8[0], or null when the bytes are not contiguous in the file (an SQLite cell value
// assembled from overflow pages). In that case errors name `label` and the offset
// inside the value.
// ---------------------------------------------------------------------------------------
class ByteReader {
  constructor(u8, { pos = 0, end = u8.length, base = 0, label = '' } = {}) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.pos = pos;
    this.end = Math.min(end, u8.length);
    this.base = base;
    this.label = label;
  }
  err(msg, off = this.pos) {
    if (this.base === null) fail(`${msg} in ${this.label || 'value'} at +${off}`);
    fail(this.label ? `${msg} in ${this.label}` : msg, this.base + off);
  }
  left() { return this.end - this.pos; }
  need(n) {
    if (!(n >= 0) || this.pos + n > this.end) this.err(`unexpected end of data (need ${n} bytes, have ${Math.max(0, this.end - this.pos)})`);
  }
  u8v() { this.need(1); return this.u8[this.pos++]; }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos); this.pos += 2; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos); this.pos += 4; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos); this.pos += 4; return v; }
  peekU32(at = this.pos) { return at + 4 <= this.end ? this.dv.getUint32(at) : null; }
  u64() {
    this.need(8);
    const hi = this.dv.getUint32(this.pos), lo = this.dv.getUint32(this.pos + 4);
    if (hi > 0x1fffff) this.err('64-bit value too large');
    this.pos += 8;
    return hi * 4294967296 + lo;
  }
  i64() {
    this.need(8);
    const hi = this.dv.getInt32(this.pos), lo = this.dv.getUint32(this.pos + 4);
    this.pos += 8;
    return hi * 4294967296 + lo; // may lose precision for huge values (only used for unknown fields)
  }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos); this.pos += 8; return v; }
  bytes(n) { this.need(n); const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n) { this.need(n); this.pos += n; }
  // QString: u32 byte length (0xFFFFFFFF = null) + UTF-16BE code units.
  qstring() {
    const at = this.pos;
    const n = this.u32();
    if (n === 0xffffffff) return null;
    if (n & 1) this.err(`odd QString byte length ${n}`, at);
    if (n > this.left()) this.err(`QString length ${n} runs past the end`, at);
    const s = utf16be(this.u8, this.pos, n);
    this.pos += n;
    return s;
  }
  // QByteArray: u32 length (0xFFFFFFFF = null) + bytes.
  qbytes() {
    const at = this.pos;
    const n = this.u32();
    if (n === 0xffffffff) return null;
    if (n > this.left()) this.err(`QByteArray length ${n} runs past the end`, at);
    return this.bytes(n);
  }
  // `const char *` as written by QDataStream: u32 length including the NUL, then bytes.
  cstring() {
    const at = this.pos;
    const n = this.u32();
    if (n === 0) return '';
    if (n > this.left() || n > 4096) this.err(`bad C string length ${n}`, at);
    const b = this.bytes(n);
    let s = '';
    for (let i = 0; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  }
}

function utf16be(u8, off, n) {
  let s = '';
  const CH = 8192;
  for (let i = 0; i < n; i += CH * 2) {
    const m = Math.min(CH * 2, n - i);
    const codes = new Array(m >> 1);
    for (let j = 0; j < m; j += 2) codes[j >> 1] = (u8[off + i + j] << 8) | u8[off + i + j + 1];
    s += String.fromCharCode.apply(null, codes);
  }
  return s;
}
function utf16le(u8, off, n) {
  let s = '';
  for (let j = 0; j + 1 < n; j += 2) s += String.fromCharCode(u8[off + j] | (u8[off + j + 1] << 8));
  return s;
}

// ---------------------------------------------------------------------------------------
// Affine helpers. Matrices are Qt QTransform values reduced to [m11, m12, m21, m22, dx, dy]:
//   x' = m11*x + m21*y + dx,   y' = m12*x + m22*y + dy
// compose(p, q) means "apply p, then q" (Qt's p * q).
// ---------------------------------------------------------------------------------------
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

function compose(p, q) {
  return [
    q[0] * p[0] + q[2] * p[1],
    q[1] * p[0] + q[3] * p[1],
    q[0] * p[2] + q[2] * p[3],
    q[1] * p[2] + q[3] * p[3],
    q[0] * p[4] + q[2] * p[5] + q[4],
    q[1] * p[4] + q[3] * p[5] + q[5],
  ];
}
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

// Reads a QTransform (9 doubles: m11 m12 m13 m21 m22 m23 m31 m32 m33) and reduces it to an
// affine. Perspective terms are dropped with a warning; a uniform m33 is divided out.
function readQTransform(r, warn) {
  const v = [];
  for (let i = 0; i < 9; i++) v.push(r.f64());
  if (!v.every(Number.isFinite)) r.err('non-finite QTransform value', r.pos - 72);
  let [m11, m12, m13, m21, m22, m23, m31, m32, m33] = v;
  if (Math.abs(m13) > 1e-12 || Math.abs(m23) > 1e-12) warn && warn('perspective QTransform terms ignored');
  if (m33 !== 1 && Math.abs(m33) > 1e-12) { m11 /= m33; m12 /= m33; m21 /= m33; m22 /= m33; m31 /= m33; m32 /= m33; }
  return [m11, m12, m21, m22, m31, m32];
}

// QPainterPath: i32 count, count x (i32 elementType, f64 x, f64 y), i32 cStart, i32 fillRule.
// Element types: 0 MoveTo, 1 LineTo, 2 CurveTo, 3 CurveToData.
function readQPainterPath(r) {
  const at = r.pos;
  const n = r.i32();
  if (n < 0 || n * 20 > r.left()) r.err(`bad QPainterPath element count ${n}`, at);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const type = r.i32();
    const x = r.f64(), y = r.f64();
    pts.push({ type, x, y });
  }
  const cStart = r.i32();
  const fillRule = r.i32();
  return { elements: pts, cStart, fillRule };
}

// QColor (Qt 5/6 stream): i8 spec, u16 alpha, u16 v1, u16 v2, u16 v3, u16 v4.
function readQColor(r) {
  const spec = r.i8();
  const a = r.u16(), v1 = r.u16(), v2 = r.u16(), v3 = r.u16(), v4 = r.u16();
  return qcolorToCss(spec, a, v1, v2, v3, v4);
}
function qcolorToCss(spec, a, v1, v2, v3, v4) {
  let rgb;
  if (spec === 1) rgb = [v1 / 65535, v2 / 65535, v3 / 65535];
  else if (spec === 2) rgb = hsvToRgb(v1 === 65535 ? 0 : v1 / 100, v2 / 65535, v3 / 65535);
  else if (spec === 4) rgb = hslToRgb(v1 === 65535 ? 0 : v1 / 100, v2 / 65535, v3 / 65535);
  else if (spec === 3) { const k = v4 / 65535; rgb = [(1 - v1 / 65535) * (1 - k), (1 - v2 / 65535) * (1 - k), (1 - v3 / 65535) * (1 - k)]; }
  else if (spec === 5) { rgb = [half(v1), half(v2), half(v3)].map((x) => Math.min(1, Math.max(0, x))); a = Math.round(Math.min(1, Math.max(0, half(a))) * 65535); }
  else return null; // 0 = invalid colour
  return cssColor(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, a / 65535);
}
function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}
function hsvToRgb(h, s, v) {
  const c = v * s, hp = (h % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = v - c;
  const t = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return t.map((u) => u + m);
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (h % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const t = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return t.map((u) => u + m);
}
function cssColor(r, g, b, a) {
  const h = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  return a >= 0.9995 ? hex : `${hex}${h(a * 255)}`;
}

// QVariant as written by QDataStream (Qt 5 type numbering, which PureRef 2.1 uses):
//   u32 typeId, u8 isNull, [if typeId == 1024 (User): u32 len + type name + NUL], payload.
const QT = { Bool: 1, Int: 2, UInt: 3, LongLong: 4, ULongLong: 5, Double: 6, QString: 10, QByteArray: 12, QRect: 19, QRectF: 20, QSize: 21, QSizeF: 22, QPoint: 25, QPointF: 26, Float: 38, QColor: 67, QTransform: 80, QPolygonF: 86, User: 1024 };

function readQVariant(r, warn) {
  const typeId = r.u32();
  const isNull = r.u8v();
  let typeName = null;
  if (typeId === QT.User) typeName = r.cstring();
  let value;
  switch (typeId) {
    case QT.Bool: value = r.u8v() !== 0; break;
    case QT.Int: value = r.i32(); break;
    case QT.UInt: value = r.u32(); break;
    case QT.LongLong: value = r.i64(); break;
    case QT.ULongLong: value = r.u64(); break;
    case QT.Double: case QT.Float: value = r.f64(); break;
    case QT.QString: value = r.qstring(); break;
    case QT.QByteArray: value = r.qbytes(); break;
    case QT.QRect: { const x1 = r.i32(), y1 = r.i32(), x2 = r.i32(), y2 = r.i32(); value = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }; break; }
    case QT.QRectF: value = { x: r.f64(), y: r.f64(), w: r.f64(), h: r.f64() }; break;
    case QT.QSize: value = { w: r.i32(), h: r.i32() }; break;
    case QT.QSizeF: value = { w: r.f64(), h: r.f64() }; break;
    case QT.QPoint: value = { x: r.i32(), y: r.i32() }; break;
    case QT.QPointF: value = { x: r.f64(), y: r.f64() }; break;
    case QT.QColor: value = readQColor(r); break;
    case QT.QTransform: value = readQTransform(r, warn); break;
    case QT.QPolygonF: { const n = r.u32(); if (n * 16 > r.left()) r.err('bad QPolygonF size'); value = []; for (let i = 0; i < n; i++) value.push([r.f64(), r.f64()]); break; }
    case QT.User:
      if (typeName === 'QPainterPath') value = readQPainterPath(r);
      else if (typeName === 'BigRational') value = readBigRational(r);
      else value = undefined; // unknown user type: payload left unread
      break;
    default: value = undefined;
  }
  return { typeId, typeName, isNull: isNull !== 0, value };
}

// BigRational (a PureRef type used for `items.sort_order`). Decoded from the sample as
//   BigInteger numerator, BigInteger denominator
//   BigInteger = i32 sign (-1/0/1), u64 blockCount, blockCount x u32 (least significant first)
// Only the sample's small values have been seen, so this is a best guess. It returns null
// when the bytes do not fit.
function readBigRational(r) {
  const start = r.pos;
  try {
    const num = readBigInteger(r), den = readBigInteger(r);
    if (!den) return null;
    return num / den;
  } catch {
    r.pos = start;
    return null;
  }
}
function readBigInteger(r) {
  const sign = r.i32();
  const n = r.u64();
  if (sign < -1 || sign > 1 || n > 64 || n * 4 > r.left()) throw new Error('bad BigInteger');
  let v = 0;
  const blocks = [];
  for (let i = 0; i < n; i++) blocks.push(r.u32());
  for (let i = blocks.length - 1; i >= 0; i--) v = v * 4294967296 + blocks[i];
  return sign * v;
}

// ---------------------------------------------------------------------------------------
// Image header sniffing.
// ---------------------------------------------------------------------------------------
function sniffImage(d) {
  const n = d.length;
  const be16 = (o) => (d[o] << 8) | d[o + 1];
  const be32 = (o) => ((d[o] << 24) >>> 0) + ((d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]);
  const le16 = (o) => d[o] | (d[o + 1] << 8);
  const le24 = (o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
  const le32s = (o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
  if (n >= 24 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 && d[4] === 0x0d && d[5] === 0x0a && d[6] === 0x1a && d[7] === 0x0a) {
    return { mime: 'image/png', width: be32(16), height: be32(20), orientation: 1 };
  }
  if (n >= 4 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) {
    let p = 2, orientation = 1;
    while (p + 4 <= n) {
      if (d[p] !== 0xff) break;
      while (p < n && d[p] === 0xff) p++;
      const m = d[p++];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
      if (m === 0xd9 || m === 0xda || p + 2 > n) break;
      const len = be16(p);
      if (len < 2) break;
      if (m === 0xe1 && orientation === 1) orientation = exifOrientation(d, p + 2, Math.min(n, p + len)) || 1;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && p + 7 <= n) {
        return { mime: 'image/jpeg', width: be16(p + 5), height: be16(p + 3), orientation };
      }
      p += len;
    }
    return { mime: 'image/jpeg', width: 0, height: 0, orientation };
  }
  if (n >= 10 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) {
    return { mime: 'image/gif', width: le16(6), height: le16(8), orientation: 1 };
  }
  if (n >= 26 && d[0] === 0x42 && d[1] === 0x4d) {
    const hs = le32s(14);
    if (hs === 12) return { mime: 'image/bmp', width: le16(18), height: le16(20), orientation: 1 };
    return { mime: 'image/bmp', width: Math.abs(le32s(18)), height: Math.abs(le32s(22)), orientation: 1 };
  }
  if (n >= 30 && d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) {
    const fourcc = String.fromCharCode(d[12], d[13], d[14], d[15]);
    if (fourcc === 'VP8 ') return { mime: 'image/webp', width: le16(26) & 0x3fff, height: le16(28) & 0x3fff, orientation: 1 };
    if (fourcc === 'VP8L') {
      const b0 = d[21], b1 = d[22], b2 = d[23], b3 = d[24];
      return { mime: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), orientation: 1 };
    }
    if (fourcc === 'VP8X') return { mime: 'image/webp', width: 1 + le24(24), height: 1 + le24(27), orientation: 1 };
    return { mime: 'image/webp', width: 0, height: 0, orientation: 1 };
  }
  return { mime: 'application/octet-stream', width: 0, height: 0, orientation: 1 };
}

// EXIF orientation from a JPEG APP1 segment body [s, e).
function exifOrientation(d, s, e) {
  if (e - s < 14 || d[s] !== 0x45 || d[s + 1] !== 0x78 || d[s + 2] !== 0x69 || d[s + 3] !== 0x66) return 0;
  const t = s + 6;
  const le = d[t] === 0x49;
  const g16 = (o) => (le ? d[o] | (d[o + 1] << 8) : (d[o] << 8) | d[o + 1]);
  const g32 = (o) => (le ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0);
  const ifd = t + g32(t + 4);
  if (ifd + 2 > e) return 0;
  const count = g16(ifd);
  for (let i = 0; i < count; i++) {
    const en = ifd + 2 + i * 12;
    if (en + 12 > e) return 0;
    if (g16(en) === 0x0112) { const v = g16(en + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------
// Placement: the visible rectangle `rect` (image pixels) mapped through the affine `A`
// (image pixels -> scene), reduced to an axis-aligned box rotated about its centre plus
// optional flips. The editor draws translate(x+w/2, y+h/2) * rotate(rotation) *
// scale(flipX?-1:1, flipY?-1:1) on a box of w x h centred on the origin.
// ---------------------------------------------------------------------------------------
function normDeg(d) {
  let r = d % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  if (Math.abs(r) < 1e-9) r = 0;
  return r;
}
function place(A, rect) {
  const [a, b, c, d] = A;
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
  const det = a * d - b * c;
  let rot, flipX = false, flipY = false;
  if (det >= 0) {
    rot = Math.atan2(b, a);
  } else {
    // Exactly one mirror. Report whichever (flipX or flipY) needs the smaller rotation.
    const rx = normDeg((Math.atan2(-b, -a) * 180) / Math.PI);
    const ry = normDeg((Math.atan2(b, a) * 180) / Math.PI);
    if (Math.abs(ry) + 1e-9 < Math.abs(rx)) { flipY = true; rot = (ry * Math.PI) / 180; } else { flipX = true; rot = (rx * Math.PI) / 180; }
  }
  const skew = sx > 0 && sy > 0 ? Math.abs(a * c + b * d) / (sx * sy) : 0;
  const [cx, cy] = apply(A, rect.x + rect.w / 2, rect.y + rect.h / 2);
  const w = sx * rect.w, h = sy * rect.h;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: normDeg((rot * 180) / Math.PI), flipX, flipY, skewed: skew > 1e-6 };
}

// The crop rectangle in image pixels: the item-space clip path mapped back through the
// inverse image transform. Returns { crop, polygon } where `crop` is null when the path
// covers the whole image, and `polygon` is set only when the clip is not a pixel-aligned
// rectangle.
function cropFromPath(path, imageMatrix, iw, ih) {
  if (!path || !path.elements.length) return { crop: null, polygon: null };
  const inv = invert(imageMatrix);
  if (!inv) return { crop: null, polygon: null };
  const pts = [];
  for (const e of path.elements) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const [x, y] = apply(inv, e.x, e.y);
    pts.push([x, y]);
  }
  if (pts.length && pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) pts.pop();
  }
  if (pts.length < 3) return { crop: null, polygon: null };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const eps = 1e-6 * Math.max(1, iw, ih);
  const isRect = pts.length === 4 && pts.every(([x, y]) => (Math.abs(x - x0) < eps || Math.abs(x - x1) < eps) && (Math.abs(y - y0) < eps || Math.abs(y - y1) < eps));
  const hasCurves = path.elements.some((e) => e.type === 2 || e.type === 3);
  // Clamp to the image.
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = iw > 0 ? Math.min(iw, x1) : x1, cy1 = ih > 0 ? Math.min(ih, y1) : y1;
  const full = isRect && !hasCurves && iw > 0 && ih > 0 && cx0 <= 0.5 && cy0 <= 0.5 && cx1 >= iw - 0.5 && cy1 >= ih - 0.5;
  return {
    crop: full ? null : { x: cx0, y: cy0, w: Math.max(0, cx1 - cx0), h: Math.max(0, cy1 - cy0) },
    polygon: isRect && !hasCurves ? null : pts,
  };
}

// ---------------------------------------------------------------------------------------
// Minimal read-only SQLite 3 reader: table B-trees, overflow pages and the record format.
// `read(off, len)` returns database bytes [off, off+len). `fileOffset(off)` maps a database
// offset to a file offset for error messages.
// ---------------------------------------------------------------------------------------
class SqliteReader {
  constructor(read, size, fileOffset, warnings) {
    this.read = read;
    this.size = size;
    this.fileOffset = fileOffset;
    this.warnings = warnings;
    if (size < 512) fail('SQLite database too small', fileOffset(0));
    const h = read(0, 100);
    const magic = 'SQLite format 3\u0000';
    for (let i = 0; i < 16; i++) if (h[i] !== magic.charCodeAt(i)) fail('missing SQLite header', fileOffset(0));
    let ps = (h[16] << 8) | h[17];
    if (ps === 1) ps = 65536;
    if (ps < 512 || ps > 65536 || (ps & (ps - 1)) !== 0) fail(`bad SQLite page size ${ps}`, fileOffset(16));
    this.pageSize = ps;
    this.usable = ps - h[20];
    if (this.usable < 480) fail('bad SQLite reserved-space value', fileOffset(20));
    if (h[18] === 2 || h[19] === 2) warnings.push('SQLite database is in WAL mode; changes still in a -wal file are not visible');
    if (h[19] > 2) fail(`unsupported SQLite read version ${h[19]}`, fileOffset(19));
    const be32 = (o) => ((h[o] << 24) >>> 0) + ((h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]);
    let pages = Math.floor(size / ps);
    const hdrPages = be32(28);
    if (hdrPages > 0 && hdrPages <= pages && be32(24) === be32(92)) pages = hdrPages;
    this.pageCount = pages;
    const enc = be32(56);
    this.encoding = enc === 2 ? 'utf16le' : enc === 3 ? 'utf16be' : 'utf8';
    this.cache = new Map();
    // Local payload limits for table leaf cells (SQLite file format, section 1.6).
    this.maxLocal = this.usable - 35;
    this.minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
  }
  page(n) {
    if (!Number.isInteger(n) || n < 1 || n > this.pageCount) fail(`SQLite page number ${n} out of range (1..${this.pageCount})`);
    let p = this.cache.get(n);
    if (!p) {
      p = this.read((n - 1) * this.pageSize, this.pageSize);
      this.cache.set(n, p);
    }
    return p;
  }
  pageErr(n, off, msg) { fail(`SQLite page ${n}: ${msg}`, this.fileOffset((n - 1) * this.pageSize + off)); }
  // Walks a table B-tree in rowid order and calls fn(rowid, payloadBytes) for each row.
  // Without onError any problem throws. With onError(message), a bad cell or a bad
  // non-root page is reported and skipped, and the walk continues.
  scanTable(root, fn, onError) {
    const stack = [[root, 0, 0]]; // [page, referring page, offset of the pointer in it]
    const seen = new Set();
    while (stack.length) {
      const [n, from, fromOff] = stack.pop();
      try {
        this.scanPage(n, from, fromOff, seen, stack, fn, onError);
      } catch (e) {
        if (!onError || n === root) throw e;
        onError(`B-tree page ${n} skipped: ${e.message}`);
      }
    }
  }
  scanPage(n, from, fromOff, seen, stack, fn, onError) {
    if (!Number.isInteger(n) || n < 1 || n > this.pageCount) {
      if (from) this.pageErr(from, fromOff, `child page number ${n} out of range (1..${this.pageCount})`);
      fail(`SQLite page number ${n} out of range (1..${this.pageCount})`);
    }
    if (seen.has(n)) this.pageErr(n, 0, 'B-tree cycle');
    seen.add(n);
    const pg = this.page(n);
    const ho = n === 1 ? 100 : 0;
    const type = pg[ho];
    const be16 = (o) => (pg[o] << 8) | pg[o + 1];
    const be32 = (o) => ((pg[o] << 24) >>> 0) + ((pg[o + 1] << 16) | (pg[o + 2] << 8) | pg[o + 3]);
    const nCells = be16(ho + 3);
    if (type === 0x05) {
      const ptrs = ho + 12;
      if (ptrs + nCells * 2 > this.usable) this.pageErr(n, ho + 3, `cell count ${nCells} too large`);
      stack.push([be32(ho + 8), n, ho + 8]);
      for (let i = nCells - 1; i >= 0; i--) {
        const co = be16(ptrs + i * 2);
        if (co < ptrs || co + 4 > this.usable) this.pageErr(n, ptrs + i * 2, `bad cell offset ${co}`);
        stack.push([be32(co), n, co]);
      }
    } else if (type === 0x0d) {
      const ptrs = ho + 8;
      if (ptrs + nCells * 2 > this.usable) this.pageErr(n, ho + 3, `cell count ${nCells} too large`);
      for (let i = 0; i < nCells; i++) {
        let rowid = null;
        try {
          const co = be16(ptrs + i * 2);
          if (co < ptrs || co >= this.usable) this.pageErr(n, ptrs + i * 2, `bad cell offset ${co}`);
          const [size, o1] = this.varint(pg, co, n);
          const [rid, o2] = this.varint(pg, o1, n);
          rowid = rid;
          const payload = this.payload(pg, n, o2, size);
          fn(rowid, payload);
        } catch (e) {
          if (!onError) throw e;
          onError(`row ${rowid ?? '?'} (page ${n} cell ${i}) skipped: ${e.message}`);
        }
      }
    } else {
      this.pageErr(n, ho, `unexpected page type 0x${type.toString(16)} in a table B-tree`);
    }
  }
  varint(pg, o, n) {
    let v = 0;
    for (let i = 0; i < 9; i++) {
      if (o + i >= pg.length) this.pageErr(n, o, 'varint runs past the page');
      const b = pg[o + i];
      if (i === 8) return [v * 256 + b, o + 9];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [v, o + i + 1];
    }
    return [v, o + 9];
  }
  payload(pg, n, o, size) {
    const U = this.usable;
    if (size > this.pageCount * U) this.pageErr(n, o, `payload size ${size} larger than the database`);
    let local = size;
    if (size > this.maxLocal) {
      const k = this.minLocal + ((size - this.minLocal) % (U - 4));
      local = k <= this.maxLocal ? k : this.minLocal;
    }
    if (o + local > U) this.pageErr(n, o, 'cell payload runs past the page');
    if (local === size) return pg.subarray(o, o + size);
    if (o + local + 4 > U) this.pageErr(n, o, 'overflow pointer runs past the page');
    const out = new Uint8Array(size);
    out.set(pg.subarray(o, o + local), 0);
    let filled = local;
    let next = ((pg[o + local] << 24) >>> 0) + ((pg[o + local + 1] << 16) | (pg[o + local + 2] << 8) | pg[o + local + 3]);
    let hops = 0;
    while (filled < size) {
      if (next === 0) this.pageErr(n, o, `overflow chain ends early (${filled}/${size} bytes)`);
      if (next > this.pageCount) this.pageErr(n, o, `overflow page number ${next} out of range`);
      if (++hops > this.pageCount) fail('SQLite overflow chain loops');
      const op = this.page(next);
      const take = Math.min(U - 4, size - filled);
      out.set(op.subarray(4, 4 + take), filled);
      filled += take;
      next = ((op[0] << 24) >>> 0) + ((op[1] << 16) | (op[2] << 8) | op[3]);
    }
    return out;
  }
  // Record format: varint header size, serial types, then values. Text values come back as
  // { text: Uint8Array } so the caller can choose how to decode them.
  record(p) {
    const vi = (o) => {
      let v = 0;
      for (let i = 0; i < 9; i++) {
        if (o + i >= p.length) fail('SQLite record header runs past the payload');
        const b = p[o + i];
        if (i === 8) return [v * 256 + b, o + 9];
        v = v * 128 + (b & 0x7f);
        if (!(b & 0x80)) return [v, o + i + 1];
      }
      return [v, o + 9];
    };
    const [hs, h0] = vi(0);
    if (hs < h0 || hs > p.length) fail(`bad SQLite record header size ${hs}`);
    const types = [];
    for (let q = h0; q < hs;) { const [t, q2] = vi(q); types.push(t); q = q2; }
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const out = [];
    let d = hs;
    const need = (k) => { if (d + k > p.length) fail('SQLite record value runs past the payload'); };
    for (const t of types) {
      switch (t) {
        case 0: out.push(null); break;
        case 1: need(1); out.push(dv.getInt8(d)); d += 1; break;
        case 2: need(2); out.push(dv.getInt16(d)); d += 2; break;
        case 3: need(3); out.push(((dv.getInt8(d) << 16) | (p[d + 1] << 8) | p[d + 2])); d += 3; break;
        case 4: need(4); out.push(dv.getInt32(d)); d += 4; break;
        case 5: need(6); out.push(dv.getInt16(d) * 4294967296 + dv.getUint32(d + 2)); d += 6; break;
        case 6: need(8); out.push(dv.getInt32(d) * 4294967296 + dv.getUint32(d + 4)); d += 8; break;
        case 7: need(8); out.push(dv.getFloat64(d)); d += 8; break;
        case 8: out.push(0); break;
        case 9: out.push(1); break;
        case 10: case 11: fail(`reserved SQLite serial type ${t}`); break;
        default: {
          const len = Math.floor((t - 12) / 2);
          need(len);
          const bytes = p.subarray(d, d + len);
          d += len;
          out.push(t % 2 === 0 ? bytes : { text: bytes });
        }
      }
    }
    return out;
  }
  textOf(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return String(v);
    const b = v instanceof Uint8Array ? v : v.text;
    if (this.encoding === 'utf16le') return utf16le(b, 0, b.length);
    if (this.encoding === 'utf16be') return utf16be(b, 0, b.length & ~1);
    return UTF8.decode(b);
  }
  // Reads the schema and returns Map(name -> { root, columns: [{ name, rowid }] }).
  schema(onError) {
    const tables = new Map();
    this.scanTable(1, (rowid, payload) => {
      const v = this.record(payload);
      const type = this.textOf(v[0]);
      const name = this.textOf(v[1]);
      const root = typeof v[3] === 'number' ? v[3] : 0;
      const sql = this.textOf(v[4]) || '';
      if (type === 'table' && name && root > 0) tables.set(name, { root, columns: parseColumns(sql) });
    }, onError);
    return tables;
  }
  // Returns the rows of a table as plain objects keyed by column name.
  rows(table, onError) {
    const out = [];
    const rowidCol = table.columns.findIndex((c) => c.rowid);
    this.scanTable(table.root, (rowid, payload) => {
      const v = this.record(payload);
      const o = { _rowid: rowid };
      table.columns.forEach((c, i) => { o[c.name] = i < v.length ? v[i] : null; });
      if (rowidCol >= 0 && (o[table.columns[rowidCol].name] === null)) o[table.columns[rowidCol].name] = rowid;
      out.push(o);
    }, onError);
    return out;
  }
}

function parseColumns(sql) {
  const i = sql.indexOf('('), j = sql.lastIndexOf(')');
  if (i < 0 || j <= i) return [];
  const body = sql.slice(i + 1, j);
  const parts = [];
  let depth = 0, q = null, cur = '';
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '[') { q = ']'; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const cols = [];
  for (const raw of parts) {
    const def = raw.trim();
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(def)) continue;
    let name, rest;
    const m = /^(?:"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|([^\s(]+))(.*)$/s.exec(def);
    if (!m) continue;
    name = (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] ?? m[3] ?? m[4]);
    rest = m[5] || '';
    cols.push({ name, rowid: /^\s+INTEGER\s+PRIMARY\s+KEY\b/i.test(rest) && !/\bDESC\b/i.test(rest) });
  }
  return cols;
}

// PureRef 2 stores Qt QDataStream bytes in TEXT columns as QString::fromLatin1(bytes),
// so each UTF-8 code point is one byte. This reverses that (BLOB values pass through).
function qtBytes(db, v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'number') return null;
  const s = db.textOf(v);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) return undefined; // not Latin-1 bytes
    out[i] = c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------------------
export function parsePureRef(input) {
  let u8;
  if (input instanceof Uint8Array) u8 = input;
  else if (input instanceof ArrayBuffer) u8 = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else fail('input must be a Uint8Array');
  if (u8.length < 16) fail('file too small to be a PureRef file', 0);

  const r = new ByteReader(u8);
  const n0 = r.peekU32(0);
  if (n0 === null || n0 === 0 || n0 > 64 || n0 & 1) fail('not a PureRef file (no version string)', 0);
  const version = r.qstring();
  const m = /^(\d+)\.(\d+)/.exec(version || '');
  if (!m) fail(`not a PureRef file (version string ${JSON.stringify(version)})`, 0);
  const major = Number(m[1]);
  if (major >= 2) return parseV2(u8, r, version);
  return parseV1(u8, r, version);
}

// ---------------------------------------------------------------------------------------
// PureRef 2.x
// ---------------------------------------------------------------------------------------
function parseV2(u8, r, version) {
  const warnings = [];
  const warnOnce = new Set();
  const warn = (msg) => { if (!warnOnce.has(msg)) { warnOnce.add(msg); warnings.push(msg); } };

  // Header (QDataStream, big-endian).
  const unknownA = r.u16(); // 0 in the sample (1.x stored the item count here)
  const unknownB = r.u16(); // 0 in the sample (1.x stored the image-item count here)
  const relocAt = r.pos;
  r.need(8);
  const relocHi = r.dv.getUint32(r.pos), relocLo = r.dv.getUint32(r.pos + 4);
  r.pos += 8;
  // File offset where the database's first bytes were moved (= database size).
  const dbHeadOffset = relocHi > 0x1fffff ? -1 : relocHi * 4294967296 + relocLo;
  const appVersion = r.qstring();
  const checksum = r.qstring(); // MD5 (hex) of every file byte after this string
  const thumbAt = r.pos;
  let thumbnail = null;
  try { thumbnail = r.qbytes(); } catch (e) { warn(`thumbnail unreadable: ${e.message}`); r.pos = thumbAt; }
  const headerEnd = r.pos;
  void unknownA; void unknownB;

  // Database mapping: file = header (H bytes) + db[H..size) + db[0..H), where the moved
  // block db[0..H) starts with "SQLite format 3\0" and H equals the header length.
  const isSqliteAt = (o) => o > 0 && o + 100 <= u8.length && u8[o] === 0x53 && u8[o + 1] === 0x51 && u8[o + 2] === 0x4c && u8[o + 3] === 0x69 && u8[o + 4] === 0x74 && u8[o + 5] === 0x65 && u8[o + 15] === 0;
  let dbStart = -1;
  if (isSqliteAt(dbHeadOffset)) dbStart = dbHeadOffset;
  else if (isSqliteAt(u8.length - headerEnd)) dbStart = u8.length - headerEnd;
  else for (let o = u8.length - 100; o >= headerEnd; o--) if (u8[o] === 0x53 && isSqliteAt(o)) { dbStart = o; break; }
  if (dbStart < 0) fail('no SQLite database found', relocAt);
  if (dbStart !== dbHeadOffset) warn(`SQLite header is not at the offset given in the file header (${dbHeadOffset}); using byte ${dbStart}`);
  const H = u8.length - dbStart;
  if (H !== headerEnd) warn(`header length ${headerEnd} differs from the moved block length ${H}`);
  if (H > dbStart) fail(`moved block (${H} bytes) is larger than the rest of the database`, relocAt);
  const dbSize = dbStart;
  const fileOffset = (o) => (o < H ? dbStart + o : o);
  const read = (off, len) => {
    if (off < 0 || off + len > dbSize) fail(`database read [${off}, ${off + len}) out of range`, fileOffset(Math.max(0, Math.min(off, dbSize - 1))));
    if (off >= H) return u8.subarray(off, off + len);
    if (off + len <= H) return u8.subarray(dbStart + off, dbStart + off + len);
    const out = new Uint8Array(len);
    out.set(u8.subarray(dbStart + off, dbStart + H), 0);
    out.set(u8.subarray(H, off + len), H - off);
    return out;
  };

  const db = new SqliteReader(read, dbSize, fileOffset, warnings);
  const schema = db.schema((msg) => warn(`schema: ${msg}`));
  const tableRows = (name, required) => {
    const t = schema.get(name);
    if (!t) { if (required) warn(`table "${name}" missing`); return []; }
    try { return db.rows(t, (msg) => warn(`table "${name}": ${msg}`)); } catch (e) {
      if (required) fail(`table "${name}" unreadable: ${e.message.replace(/^PureRef: /, '')}`);
      warn(`table "${name}" unreadable: ${e.message}`);
      return [];
    }
  };
  const num = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v) => (v === null || v === undefined ? null : db.textOf(v));
  const variant = (v, label) => {
    const b = qtBytes(db, v);
    if (b === undefined) { warn(`${label}: not Qt stream data`); return null; }
    if (!b || b.length === 0) return null;
    const rd = new ByteReader(b, { base: null, label });
    return readQVariant(rd, (m2) => warn(`${label}: ${m2}`));
  };
  const transformOf = (v, label) => {
    const q = variant(v, label);
    if (!q) return null;
    if (Array.isArray(q.value) && q.value.length === 6) return q.value;
    warn(`${label}: unexpected value type ${q.typeId}${q.typeName ? ' ' + q.typeName : ''}`);
    return null;
  };

  // metadata
  const meta = tableRows('metadata', false)[0] || {};
  const view = {
    sceneRect: null, transform: null,
    scrollX: num(meta.horizontal_scroll), scrollY: num(meta.vertical_scroll),
  };
  try {
    const sr = variant(meta.scene_rect, 'metadata.scene_rect');
    if (sr && sr.value && typeof sr.value === 'object' && 'w' in sr.value) view.sceneRect = sr.value;
    const vt = variant(meta.view_transform, 'metadata.view_transform');
    if (vt && Array.isArray(vt.value)) view.transform = vt.value;
  } catch (e) { warn(`view settings unreadable: ${e.message}`); }
  if (!thumbnail && meta.thumbnail instanceof Uint8Array && meta.thumbnail.length) thumbnail = meta.thumbnail;

  // images
  const images = [];
  const imageIndexById = new Map();
  const imageRows = tableRows('images', true).sort((a, b) => num(a.id, 0) - num(b.id, 0));
  for (const row of imageRows) {
    try {
      const id = num(row.id, row._rowid);
      let data = row.data instanceof Uint8Array ? row.data : row.data && row.data.text ? row.data.text : new Uint8Array(0);
      const info = sniffImage(data);
      let width = info.width, height = info.height;
      if (info.orientation >= 5) { const t = width; width = height; height = t; }
      const dbW = num(row.width), dbH = num(row.height);
      if ((!width || !height) && dbW && dbH) { width = dbW; height = dbH; }
      if (dbW && dbH && width && height && (dbW !== width || dbH !== height)) {
        warn(`image ${id}: header size ${width}x${height} differs from stored size ${dbW}x${dbH}; using stored size for layout`);
      }
      const source = str(row.source), origin = str(row.origin);
      if (!data.length) warn(`image ${id}: no embedded data (linked image${source ? ': ' + source : ''})`);
      imageIndexById.set(id, images.length);
      images.push({
        key: str(row.checksum) || `image-${id}`,
        data,
        mime: info.mime,
        width,
        height,
        // extras
        id,
        format: str(row.format),
        path: source || origin || null,
        orientation: info.orientation,
        layoutWidth: dbW || width,
        layoutHeight: dbH || height,
      });
    } catch (e) {
      warn(`image row ${row._rowid} skipped: ${e.message}`);
    }
  }

  // items (common attributes)
  const itemRows = tableRows('items', true);
  const itemsById = new Map();
  for (const row of itemRows) {
    const id = num(row.id, row._rowid);
    let transform = null;
    try { transform = transformOf(row.transform, `items.transform (item ${id})`); } catch (e) { warn(`item ${id}: ${e.message}`); }
    let order = null;
    try { const so = variant(row.sort_order, `items.sort_order (item ${id})`); if (so && typeof so.value === 'number') order = so.value; } catch { /* sort_order is informational only */ }
    itemsById.set(id, {
      id,
      parent: num(row.parent, -1),
      name: str(row.name),
      transform,
      z: num(row.z, 0),
      opacity: num(row.opacity, 1),
      locked: !!num(row.locked, 0),
      order,
      kind: null,
    });
  }

  const groupRows = tableRows('items_groups', false);
  for (const g of groupRows) { const it = itemsById.get(num(g.id, g._rowid)); if (it) it.kind = 'group'; }

  // Scene transform = local transform composed with all ancestors (Qt parent/child rules).
  const sceneCache = new Map();
  const sceneMatrix = (id) => {
    if (sceneCache.has(id)) return sceneCache.get(id);
    const chain = [];
    let cur = itemsById.get(id);
    const seen = new Set();
    while (cur) {
      if (seen.has(cur.id)) { warn(`parent cycle at item ${cur.id}`); break; }
      seen.add(cur.id);
      chain.push(cur);
      if (cur.parent === -1 || cur.parent === null) break;
      const p = itemsById.get(cur.parent);
      if (!p) { warn(`item ${cur.id}: parent ${cur.parent} not found, treated as top level`); break; }
      cur = p;
    }
    let mtx = IDENTITY.slice();
    for (const it of chain) mtx = compose(mtx, it.transform || IDENTITY);
    sceneCache.set(id, mtx);
    return mtx;
  };
  const groupOf = (it) => {
    let p = itemsById.get(it.parent);
    const seen = new Set();
    while (p && !seen.has(p.id)) {
      if (p.kind === 'group') return p.id;
      seen.add(p.id);
      p = itemsById.get(p.parent);
    }
    return null;
  };

  // image items
  const items = [];
  for (const row of tableRows('items_images', true)) {
    const id = num(row.id, row._rowid);
    try {
      const it = itemsById.get(id);
      if (!it) { warn(`image item ${id}: no row in "items", skipped`); continue; }
      it.kind = 'image';
      const imgId = num(row.image);
      const index = imageIndexById.get(imgId);
      if (index === undefined) { warn(`image item ${id}: image ${imgId} not found, skipped`); continue; }
      const img = images[index];
      const iw = img.layoutWidth, ih = img.layoutHeight;
      let imageMatrix = transformOf(row.image_transform, `items_images.image_transform (item ${id})`);
      if (!imageMatrix) { imageMatrix = [1, 0, 0, 1, -iw / 2, -ih / 2]; warn(`image item ${id}: no image_transform, assuming image centred on the item`); }
      let bounds = null;
      const bv = variant(row.image_bounds, `items_images.image_bounds (item ${id})`);
      if (bv && bv.value && bv.value.elements) bounds = bv.value;
      const { crop: layoutCrop, polygon: layoutPolygon } = cropFromPath(bounds, imageMatrix, iw, ih);
      if (layoutPolygon) warn(`image item ${id}: non-rectangular crop, using its bounding box`);
      if (!it.transform) warn(`image item ${id}: missing transform, using identity`);
      const matrix = sceneMatrix(id);
      const pixelMatrix = compose(imageMatrix, matrix);
      const visible = layoutCrop || { x: 0, y: 0, w: iw, h: ih };
      const pl = place(pixelMatrix, visible);
      // PureRef lays the image out at the size stored in the images table. If the stored
      // bitmap is larger or smaller (an import "Downscale" rule keeps the original), express
      // the crop in the bitmap's own pixels.
      const kx = img.width > 0 && iw > 0 ? img.width / iw : 1, ky = img.height > 0 && ih > 0 ? img.height / ih : 1;
      const crop = layoutCrop && { x: layoutCrop.x * kx, y: layoutCrop.y * ky, w: layoutCrop.w * kx, h: layoutCrop.h * ky };
      const polygon = layoutPolygon && layoutPolygon.map(([px, py]) => [px * kx, py * ky]);
      if (pl.skewed) warn(`image item ${id}: transform has skew; placement is approximate`);
      items.push({
        type: 'image',
        image: index,
        name: it.name,
        path: img.path,
        matrix,
        crop,
        x: pl.x, y: pl.y, w: pl.w, h: pl.h,
        rotation: pl.rotation,
        flipX: pl.flipX, flipY: pl.flipY,
        z: it.z,
        group: groupOf(it),
        // extras
        id,
        parent: it.parent === -1 ? null : it.parent,
        opacity: it.opacity,
        locked: it.locked,
        order: it.order,
        imageMatrix,
        pixelMatrix,
        cropPolygon: polygon,
        flags: num(row.flags),
      });
    } catch (e) {
      warn(`image item ${id} skipped: ${e.message}`);
    }
  }

  // text notes
  const texts = [];
  for (const row of tableRows('items_notes', false)) {
    const id = num(row.id, row._rowid);
    try {
      const it = itemsById.get(id);
      if (!it) { warn(`note ${id}: no row in "items", skipped`); continue; }
      it.kind = 'text';
      const raw = str(row.text) || '';
      const html = /^\s*<(!DOCTYPE|html|body|p|div|span)\b/i.test(raw) ? raw : null;
      const matrix = sceneMatrix(id);
      let size = null;
      try {
        const fs = variant(row.fixed_size, `items_notes.fixed_size (note ${id})`);
        if (fs && fs.value && typeof fs.value === 'object' && 'w' in fs.value && fs.value.w > 0 && fs.value.h > 0) size = fs.value;
      } catch { /* optional */ }
      const t = {
        text: html ? htmlToText(html) : raw,
        html,
        matrix,
        color: colorField(db, row.text_color),
        background: colorField(db, row.background_color),
        z: it.z,
        // extras
        id,
        name: it.name,
        parent: it.parent === -1 ? null : it.parent,
        group: groupOf(it),
        opacity: it.opacity,
        style: num(row.style),
      };
      if (size) {
        const pl = place(matrix, { x: 0, y: 0, w: size.w, h: size.h });
        Object.assign(t, { x: pl.x, y: pl.y, w: pl.w, h: pl.h, rotation: pl.rotation, flipX: pl.flipX, flipY: pl.flipY });
      } else {
        // Size unknown (auto-sized note): x, y is the note's local origin (its top-left
        // corner) in scene units; rotation/flip/scale apply about that point.
        const pl = place(matrix, { x: 0, y: 0, w: 1, h: 1 });
        Object.assign(t, { x: matrix[4], y: matrix[5], w: null, h: null, rotation: pl.rotation, scale: pl.w, flipX: pl.flipX, flipY: pl.flipY });
      }
      texts.push(t);
    } catch (e) {
      warn(`note ${id} skipped: ${e.message}`);
    }
  }

  // groups (extra)
  const groups = [];
  for (const g of groupRows) {
    const id = num(g.id, g._rowid);
    const it = itemsById.get(id);
    if (!it) { warn(`group ${id}: no row in "items", skipped`); continue; }
    groups.push({ id, name: it.name, parent: it.parent === -1 ? null : it.parent, group: groupOf(it), matrix: sceneMatrix(id), z: it.z, background: colorField(db, g.background_color), lockMode: num(g.lock_mode) });
  }

  // drawings: pen strokes in the item's own frame (its transform places them)
  const drawings = [];
  for (const row of tableRows('items_drawings', false)) {
    const id = num(row.id, row._rowid);
    const it = itemsById.get(id);
    if (!it) { warn(`drawing ${id}: no row in "items", skipped`); continue; }
    it.kind = 'drawing';
    try {
      const b = qtBytes(db, row.strokes);
      if (b === undefined) throw new Error('not Qt stream data');
      if (!b || !b.length) continue;
      const strokes = readStrokes(new ByteReader(b, { base: null, label: `items_drawings.strokes (item ${id})` }));
      drawings.push({ id, matrix: sceneMatrix(id), z: it.z, group: groupOf(it), parent: it.parent === -1 ? null : it.parent, opacity: it.opacity, strokes });
    } catch (e) {
      warn(`drawing ${id} skipped: ${e.message}`);
    }
  }
  const untyped = [...itemsById.values()].filter((it) => !it.kind).length;
  if (untyped) warn(`${untyped} item(s) of unknown type skipped`);

  items.sort((a, b) => a.z - b.z || a.id - b.id);
  texts.sort((a, b) => a.z - b.z || a.id - b.id);

  return {
    version,
    appVersion: appVersion || str(meta.application_version) || null,
    images,
    items,
    texts,
    warnings,
    // extras
    groups,
    drawings,
    view,
    thumbnail: thumbnail && thumbnail.length ? thumbnail : null,
    checksum: checksum || null,
  };
}

/**
 * PureRef 2 drawings (verified on a 2.1.3 sample with freehand lines, a line,
 * rectangles and ellipses): a QVariant of the user type
 * "QList<GraphicsDrawItem::Stroke>": u32 count, then per stroke
 *   u8 (100 in the sample), QColor, f64 pen width, QPainterPath
 *   (i32 n, n × { i32 type, f64 x, f64 y }, i32 start, i32 fill rule),
 *   QPointF where the drag started, i32 line style: 0 solid, 1 dashed, 2 an
 *   arrow at the end of an open line (closed shapes draw solid); read from the
 *   samples' thumbnails.
 * Element types: 0 move, 1 line, 2 curve (control 1), 3 curve data (control 2, end).
 */
function readStrokes(rd) {
  const typeId = rd.u32();
  rd.u8v(); // is-null flag
  const name = typeId >= 1024 ? rd.cstring() : null;
  if (name && !/Stroke/.test(name)) rd.err(`unexpected type "${name}"`);
  const n = rd.u32();
  if (n > 100000) rd.err(`${n} strokes`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const head = rd.u8v();
    const spec = rd.i8();
    const a = rd.u16() >> 8, r = rd.u16() >> 8, g = rd.u16() >> 8, b = rd.u16() >> 8;
    rd.u16(); // padding
    const hex = (v) => v.toString(16).padStart(2, '0');
    const color = spec === 1 ? `#${hex(r)}${hex(g)}${hex(b)}` : null; // RGB; other colour specs are rare in a pen
    const width = rd.f64();
    const count = rd.i32();
    if (count < 0 || count > 1000000) rd.err(`a path of ${count} elements`);
    const elements = [];
    for (let k = 0; k < count; k++) elements.push({ type: rd.i32(), x: rd.f64(), y: rd.f64() });
    rd.i32(); // the path's start index
    rd.i32(); // its fill rule
    const start = [rd.f64(), rd.f64()];
    const style = rd.i32();
    if (!(width >= 0 && width < 1e6) || elements.some((e) => e.type < 0 || e.type > 3 || !Number.isFinite(e.x) || !Number.isFinite(e.y))) rd.err('stroke data does not look right');
    out.push({ color, alpha: a / 255, width, elements, start, style, dashed: style === 1, arrow: style === 2, head });
  }
  return out;
}

function colorField(db, v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) {
    const s = db.textOf(v).trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{8}$/i.test(s)) { const a = s.slice(1, 3), rgb = s.slice(3); return a.toLowerCase() === 'ff' ? `#${rgb}`.toLowerCase() : `#${rgb}${a}`.toLowerCase(); }
  }
  try {
    const b = qtBytes(db, v);
    if (!b || b.length < 5) return null;
    const q = readQVariant(new ByteReader(b, { base: null, label: 'colour' }));
    return typeof q.value === 'string' ? q.value : null;
  } catch {
    return null;
  }
}

function htmlToText(html) {
  let s = html.replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
  return s.replace(/\n+$/, '').replace(/^\n+/, '');
}

// ---------------------------------------------------------------------------------------
// PureRef 1.x (best effort; layout from FyorDev/PureRef-format, not verified on a real file)
// ---------------------------------------------------------------------------------------
function parseV1(u8, r, version) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  warn('PureRef 1.x layout is implemented from public reverse-engineering notes and is not verified against a real 1.x file');

  r.u16(); // number of top-level items (unused: items are read until the reference table)
  r.u16(); // number of image items (unused)
  const refsAt = r.pos;
  const refsOffset = r.u64();
  const appVersion = r.qstring();
  const checksum = r.qstring();
  r.u32(); // next free item id
  const sceneRect = { x: r.f64(), y: r.f64(), w: r.f64(), h: r.f64() }; // meaning unverified
  const viewTransform = readQTransform(r);
  const scrollX = r.i32(), scrollY = r.i32();
  const headerEnd = r.pos;
  if (refsOffset < headerEnd || refsOffset > u8.length) fail(`reference table offset ${refsOffset} out of range`, refsAt);

  // Reference table: QString folder, then (u32 itemId, u64 start, u64 end) to the end of file.
  const rr = new ByteReader(u8, { pos: refsOffset });
  rr.qstring(); // folder the scene was saved from
  const refs = new Map();
  let maxEnd = headerEnd;
  while (rr.left() >= 20) {
    const at = rr.pos;
    const id = rr.u32(), s = rr.u64(), e = rr.u64();
    if (s < headerEnd || e < s || e > refsOffset) { warn(`reference for item ${id} out of range (at byte ${at}), ignored`); continue; }
    refs.set(id, [s, e]);
    maxEnd = Math.max(maxEnd, e);
  }
  if (rr.left()) warn(`${rr.left()} trailing bytes after the reference table`);

  // Items start after the image data. Skip any unreferenced 4-byte duplicate slots.
  const typeAt = (p) => {
    if (p + 12 > refsOffset) return null;
    const len = (u8[p + 8] << 24 | u8[p + 9] << 16 | u8[p + 10] << 8 | u8[p + 11]) >>> 0;
    if (len !== 32 && len !== 34) return null;
    if (p + 12 + len > refsOffset) return null;
    const s = utf16be(u8, p + 12, len);
    return s === 'GraphicsImageItem' || s === 'GraphicsTextItem' ? s : null;
  };
  let p = maxEnd;
  let guard = 0;
  while (p < refsOffset && !typeAt(p) && guard++ < 1 << 20) p += 4;
  if (p >= refsOffset && refs.size) warn('no items found before the reference table');

  const nodes = [];
  const readItem = (pos, parent, depth) => {
    if (depth > 64) fail('items nested too deeply', pos);
    const ir = new ByteReader(u8, { pos, end: refsOffset });
    const end = ir.u64();
    if (end <= pos + 12 || end > refsOffset) fail(`bad item end offset ${end}`, pos);
    ir.end = end;
    const type = ir.qstring();
    const node = { type, parent, pos };
    let children = 0;
    if (type === 'GraphicsImageItem') {
      let brute = false;
      if (ir.peekU32() === 0) { brute = true; ir.skip(4); }
      node.source = ir.qstring();
      node.name = brute ? null : ir.qstring();
      node.unknown1 = ir.f64(); // always 1.0 in known files (maybe opacity)
      node.transform = readQTransform(ir, warn);
      node.id = ir.u32();
      node.z = ir.f64();
      node.imageMatrix = readQTransform(ir, warn);
      node.bounds = readQPainterPath(ir);
      if (ir.left() >= 17) { ir.u32(); ir.u8v(); ir.i64(); children = ir.u32(); } // unknown, unknown, unknown, child count
    } else if (type === 'GraphicsTextItem') {
      node.text = ir.qstring() || '';
      node.transform = readQTransform(ir, warn);
      node.id = ir.u32();
      node.z = ir.f64();
      node.color = readQColor(ir);
      node.background = readQColor(ir);
      children = ir.left() >= 4 ? ir.u32() : 0;
    } else {
      warn(`unknown item type ${JSON.stringify(type)} at byte ${pos}, skipped`);
    }
    nodes.push(node);
    let q = end;
    for (let i = 0; i < children; i++) {
      if (!typeAt(q)) { warn(`item ${node.id}: child ${i} not found at byte ${q}`); break; }
      q = readItem(q, node, depth + 1);
    }
    return q;
  };
  while (p < refsOffset && typeAt(p)) {
    try {
      p = readItem(p, null, 0);
    } catch (e) {
      warn(`item at byte ${p} skipped: ${e.message}`);
      const end = new ByteReader(u8, { pos: p }).u64();
      if (!(end > p && end <= refsOffset)) break;
      p = end;
    }
  }

  const sceneOf = (node) => {
    let m = node.transform || IDENTITY;
    for (let q = node.parent; q; q = q.parent) m = compose(m, q.transform || IDENTITY);
    return m;
  };

  // Images: one per distinct referenced byte range. 4-byte ranges hold the id of the item
  // whose image is reused (0xFFFFFFFF marks an image that is not embedded).
  const images = [];
  const imageByStart = new Map();
  const resolve = (id) => {
    for (let hop = 0; hop < 16; hop++) {
      const ref = refs.get(id);
      if (!ref) return null;
      if (ref[1] - ref[0] !== 4) return ref;
      const next = ((u8[ref[0]] << 24) >>> 0) + ((u8[ref[0] + 1] << 16) | (u8[ref[0] + 2] << 8) | u8[ref[0] + 3]);
      if (next === 0xffffffff || next === id) return null;
      id = next;
    }
    return null;
  };

  const items = [], texts = [];
  for (const node of nodes) {
    try {
      if (node.type === 'GraphicsImageItem') {
        const ref = resolve(node.id);
        if (!ref) { warn(`image item ${node.id}: no embedded image data, skipped`); continue; }
        let index = imageByStart.get(ref[0]);
        if (index === undefined) {
          const data = u8.subarray(ref[0], ref[1]);
          const info = sniffImage(data);
          let w = info.width, h = info.height;
          if (info.orientation >= 5) [w, h] = [h, w];
          index = images.length;
          imageByStart.set(ref[0], index);
          images.push({ key: String(index), data, mime: info.mime, width: w, height: h, path: node.source || null, orientation: info.orientation, layoutWidth: w, layoutHeight: h });
        }
        const img = images[index];
        const { crop, polygon } = cropFromPath(node.bounds, node.imageMatrix, img.width, img.height);
        const matrix = sceneOf(node);
        const pixelMatrix = compose(node.imageMatrix, matrix);
        const pl = place(pixelMatrix, crop || { x: 0, y: 0, w: img.width, h: img.height });
        if (polygon) warn(`image item ${node.id}: non-rectangular crop, using its bounding box`);
        items.push({
          type: 'image', image: index, name: node.name || null, path: node.source || null,
          matrix, crop, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rotation: pl.rotation, flipX: pl.flipX, flipY: pl.flipY,
          z: node.z, group: null,
          id: node.id, parent: node.parent ? node.parent.id : null, imageMatrix: node.imageMatrix, pixelMatrix, cropPolygon: polygon,
        });
      } else if (node.type === 'GraphicsTextItem') {
        const matrix = sceneOf(node);
        texts.push({
          text: node.text, html: null, matrix, color: node.color, background: node.background, z: node.z,
          x: matrix[4], y: matrix[5], w: null, h: null,
          rotation: normDeg((Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI), scale: Math.hypot(matrix[0], matrix[1]), flipX: false, flipY: false,
          id: node.id, parent: node.parent ? node.parent.id : null, group: null,
        });
      }
    } catch (e) {
      warn(`item ${node.id} skipped: ${e.message}`);
    }
  }
  items.sort((a, b) => a.z - b.z || a.id - b.id);
  texts.sort((a, b) => a.z - b.z || a.id - b.id);

  const av = appVersion ? appVersion.replace(/\u0000/g, '') : '';
  return {
    version,
    appVersion: av || null,
    images,
    items,
    texts,
    warnings,
    groups: [],
    drawings: [],
    view: { sceneRect, transform: viewTransform, scrollX, scrollY },
    thumbnail: null,
    checksum: checksum || null,
  };
}

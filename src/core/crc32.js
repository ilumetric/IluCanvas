// CRC-32 (IEEE 802.3, as used by ZIP), slicing-by-8. Incremental:
//   let c = crc32(chunk1); c = crc32(chunk2, c);

const T = (() => {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let s = 1; s < 8; s++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[s * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

/** CRC-32 of `u8`, continuing from `prev` (the value returned for the bytes before). */
export function crc32(u8, prev = 0) {
  let c = ~prev >>> 0;
  let i = 0;
  const n = u8.length;
  const end8 = n - (n % 8);
  while (i < end8) {
    const a = (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) ^ c;
    const b = u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24);
    c = T[1792 + (a & 0xff)] ^ T[1536 + ((a >>> 8) & 0xff)] ^ T[1280 + ((a >>> 16) & 0xff)] ^ T[1024 + (a >>> 24)]
      ^ T[768 + (b & 0xff)] ^ T[512 + ((b >>> 8) & 0xff)] ^ T[256 + ((b >>> 16) & 0xff)] ^ T[b >>> 24];
    i += 8;
  }
  while (i < n) c = T[(c ^ u8[i++]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Quick check for src/core/pureref.js against a real PureRef file.
//
//   node test/pureref.sample.mjs [sample.pur] [outDir]
//
// Parses the sample (read-only), prints a summary, checks the extracted images (signature,
// header size, MD5 against the checksum PureRef stored) and writes the images, layout.json
// and layout.html (the derived placement drawn with CSS transforms) to outDir.
// Exits with code 1 if any check fails.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePureRef } from '../src/core/pureref.js';

const samplePath = process.argv[2] || 'examples/NewScene.pur';
const outDir = process.argv[3] || join(tmpdir(), 'ilucanvas-pur-out');

const file = new Uint8Array(readFileSync(samplePath)); // read only, never written
const t0 = performance.now();
const pur = parsePureRef(file);
const ms = performance.now() - t0;

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const md5 = (u8) => createHash('md5').update(u8).digest('hex');
const f = (n) => (typeof n === 'number' ? Number(n.toFixed(2)) : n);

console.log(`file      ${samplePath} (${file.length} bytes), parsed in ${ms.toFixed(1)} ms`);
console.log(`version   ${pur.version}   app ${pur.appVersion}`);
console.log(`counts    images ${pur.images.length}, image items ${pur.items.length}, texts ${pur.texts.length}, groups ${pur.groups?.length ?? 0}, warnings ${pur.warnings.length}`);
for (const w of pur.warnings) console.log(`  warning: ${w}`);
if (pur.view) console.log(`view      sceneRect ${JSON.stringify(pur.view.sceneRect)} zoom ${f(pur.view.transform?.[0])} scroll ${pur.view.scrollX},${pur.view.scrollY}`);

// File checksum (2.x: MD5 of every byte after the checksum string).
if (pur.checksum && pur.version.startsWith('2')) {
  let p = 0;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  p += 4 + dv.getUint32(p);   // version
  p += 12;                     // u16, u16, u64
  p += 4 + dv.getUint32(p);   // app version
  p += 4 + dv.getUint32(p);   // checksum string
  check(md5(file.subarray(p)) === pur.checksum, `header MD5 of bytes ${p}.. matches ${pur.checksum}`);
}

console.log('\nimages');
mkdirSync(outDir, { recursive: true });
const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const files = [];
pur.images.forEach((img, i) => {
  const name = `${String(i).padStart(2, '0')}_${img.key}.${ext[img.mime] || 'bin'}`;
  files.push(name);
  console.log(` [${i}] ${img.mime} ${img.width}x${img.height} ${img.data.length} bytes ${img.path ?? ''}`);
  const d = img.data;
  if (img.mime === 'image/jpeg') {
    check(d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff, 'JPEG starts with FFD8FF');
    check(d[d.length - 2] === 0xff && d[d.length - 1] === 0xd9, 'JPEG ends with FFD9');
  } else if (img.mime === 'image/png') {
    check([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, k) => d[k] === b), 'PNG signature');
    const tail = String.fromCharCode(...d.subarray(d.length - 8, d.length - 4));
    check(tail === 'IEND', 'PNG ends with IEND chunk');
  }
  check(img.width > 0 && img.height > 0, `header size ${img.width}x${img.height}`);
  if (img.layoutWidth) check(img.layoutWidth === img.width && img.layoutHeight === img.height, `header size matches size stored by PureRef (${img.layoutWidth}x${img.layoutHeight})`);
  if (/^[0-9a-f]{32}$/.test(img.key)) check(md5(d) === img.key, 'MD5 of extracted bytes matches stored checksum');
  writeFileSync(join(outDir, name), d);
});
if (pur.thumbnail) writeFileSync(join(outDir, 'thumbnail.jpg'), pur.thumbnail);

console.log('\nimage items (scene units; x,y = top-left before rotation about the centre)');
for (const it of pur.items) {
  console.log(` z=${it.z} id=${it.id} image=${it.image} "${it.name}"`);
  console.log(`    x=${f(it.x)} y=${f(it.y)} w=${f(it.w)} h=${f(it.h)} rot=${f(it.rotation)} flipX=${it.flipX} flipY=${it.flipY} group=${it.group}`);
  console.log(`    matrix=[${it.matrix.map(f).join(', ')}] crop=${JSON.stringify(it.crop)}`);
  check(it.image >= 0 && it.image < pur.images.length, 'image index in range');
}
for (const t of pur.texts) {
  console.log(` text z=${t.z} "${t.text.slice(0, 60)}" x=${f(t.x)} y=${f(t.y)} w=${f(t.w)} h=${f(t.h)} rot=${f(t.rotation)} color=${t.color} bg=${t.background}`);
}

// layout.json: everything except the image bytes.
const layout = JSON.parse(JSON.stringify({ ...pur, thumbnail: pur.thumbnail ? 'thumbnail.jpg' : null }, (k, v) => (v instanceof Uint8Array ? undefined : v)));
layout.images.forEach((img, i) => { img.file = files[i]; });
writeFileSync(join(outDir, 'layout.json'), JSON.stringify(layout, null, 2));

// layout.html: draws each item from the derived x/y/w/h/rotation/flip only.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const corners = (x, y, w, h, rot) => {
  const cx = x + w / 2, cy = y + h / 2, a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
};
for (const it of pur.items) for (const [x, y] of corners(it.x, it.y, it.w, it.h, it.rotation)) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
for (const t of pur.texts) { minX = Math.min(minX, t.x); minY = Math.min(minY, t.y); maxX = Math.max(maxX, t.x + (t.w || 200)); maxY = Math.max(maxY, t.y + (t.h || 50)); }
if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
const W = 1200, scale = W / Math.max(1, maxX - minX), H = Math.ceil((maxY - minY) * scale);
const els = [];
for (const it of pur.items) {
  const img = pur.images[it.image];
  const crop = it.crop || { x: 0, y: 0, w: img.width, h: img.height };
  const sx = it.w / crop.w, sy = it.h / crop.h;
  els.push(`<div class="item" title="${it.name ?? ''}" style="left:${(it.x - minX) * scale}px;top:${(it.y - minY) * scale}px;width:${it.w * scale}px;height:${it.h * scale}px;z-index:${Math.round(it.z * 1000)};transform:rotate(${it.rotation}deg) scale(${it.flipX ? -1 : 1},${it.flipY ? -1 : 1})"><img src="${files[it.image]}" style="width:${img.width * sx * scale}px;height:${img.height * sy * scale}px;left:${-crop.x * sx * scale}px;top:${-crop.y * sy * scale}px"></div>`);
}
for (const t of pur.texts) {
  // Fixed-size notes rotate about their centre (like images); auto-sized ones about x, y.
  const tf = `rotate(${t.rotation}deg) scale(${(t.flipX ? -1 : 1) * (t.scale || 1)},${(t.flipY ? -1 : 1) * (t.scale || 1)})`;
  els.push(`<div class="text" style="left:${(t.x - minX) * scale}px;top:${(t.y - minY) * scale}px;${t.w ? `width:${t.w * scale}px;height:${t.h * scale}px;transform-origin:50% 50%;` : ''}color:${t.color || '#fff'};background:${t.background || 'transparent'};z-index:${Math.round(t.z * 1000)};transform:${tf}">${t.text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`);
}
writeFileSync(join(outDir, 'layout.html'), `<!doctype html><meta charset="utf-8"><title>PureRef layout</title>
<style>body{margin:0;background:#202020}#c{position:relative;width:${W}px;height:${H}px;margin:20px;outline:1px dashed #555}
.item{position:absolute;overflow:hidden;transform-origin:50% 50%;outline:1px solid #0f0}.item img{position:absolute;max-width:none}
.text{position:absolute;transform-origin:0 0;font:12px sans-serif;white-space:pre}</style>
<div id="c">${els.join('\n')}</div>`);

console.log(`\nwrote ${files.length} image(s), layout.json and layout.html to ${outDir}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

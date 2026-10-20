#!/usr/bin/env node
// IluCanvas CLI — create, read and edit .ilucanvas files without a browser.
// Source of the single-file bundle `ilucanvas.mjs` (npm run bundle).
//
//   node tools/ilucanvas.mjs --help

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { APP_VERSION } from '../src/core/version.js';
import {
  FORMAT_VERSION, GROUP_COLORS, emptyCanvas, validate, serialize,
  groupsOf, addItems, newId, assetIdFromSha, assetPath, takenPaths, now, withChildren, pruneAssets,
} from '../src/core/model.js';
import { applyOps, idsExist, OpError, EDITABLE_KEYS } from '../src/core/ops.js';
import { openCanvas, planSave, chooseMode, deadBytes, EXT } from '../src/core/canvasfile.js';
import { readEntry } from '../src/core/zip.js';
import { crc32 } from '../src/core/crc32.js';
import { imageInfo, isImageName } from '../src/core/imageinfo.js';
import { parsePureRef } from '../src/core/pureref.js';
import { listText } from '../src/core/describe.js';

const HELP = `IluCanvas ${APP_VERSION} — infinite reference board in one .ilucanvas file (format v${FORMAT_VERSION})
A .ilucanvas file is a ZIP: canvas.json (the scene) + images/ (originals) + thumbs/.

Usage: node ilucanvas.mjs <command> <file.ilucanvas> [args] [options]

Read
  ls <file> [--group ID] [--json]       groups and images, one line each (ids, names, positions)
  info <file>                           title, counts, size, dead space, warnings
  json <file>                           print canvas.json
  validate <file>                       exit 1 when the file has errors
  extract <file> [--out DIR] [ids…]     write the original images (all, or of these items / groups)

Write (re-read → change → write; the open app picks the change up within seconds)
  new <file> [--title T]                create an empty canvas (refuses to overwrite)
  add <file> <image|folder|url>…        add images; folders are read recursively
        [--group ID | --new-group NAME] [--at X,Y] [--max 1200] [--name N]
        default place: right of everything (or at the bottom of --group)
  set <file> <id|canvas> key=value…     ${EDITABLE_KEYS.join(' ')}; canvas: title
  move <file> <id>… (--by DX,DY | --to X,Y)
  shape <file> <kind> ["text"] [--fill C] [--stroke C] [--at X,Y] [--w W] [--h H] [--group ID]
                                        kinds: rect rounded ellipse diamond triangle parallelogram hexagon star
  connect <file> <from> <to> [--label L] [--route dubins|curve|straight|elbow] [--start/--end none|arrow|dot]
                                        from / to: an item id or X,Y;  [--color C] [--dash] [--width W]
  stroke <file> "X,Y X,Y …" [--tool pen|highlighter|tape] [--color C] [--width W] [--nib italic] [--group ID]
                                        freehand ink through the points (X,Y,PRESSURE also works)
  note <file> "text" [--color C] [--at X,Y] [--group ID] [--w W] [--size s|m|l|xl]
                                        a note; Markdown text ("\\n" = new line); colours: yellow orange
                                        pink green blue violet grey (stickies), paper (document), none (text)
  rm <file> <id>… [--keep-children]     a group goes with its images unless --keep-children
  group <file> <id>… [--name N] [--color ${GROUP_COLORS.join('|')}]
  ungroup <file> <group-id>
  arrange <file> <group-id | id…> [--width W] [--gap G]   justified rows, aspect kept
  front <file> <id>… | back <file> <id>…
  apply <file> <ops.json | ->           many changes in one write (see docs/AGENT.md)
  compact <file>                        rewrite the file without dead space
  from-pur <in.pur> [out.ilucanvas]     convert a PureRef file (images and their layout)

Options
  --by agent|human   recorded in updated_by (default agent)
  --json             machine-readable output (ls, info, add, apply)
  --version, --help
Docs: https://ilumetric.github.io/IluCanvas/docs/AGENT.md
`;

class UsageError extends Error {}

const BOOL = new Set(['json', 'help', 'version', 'keep_children', 'force', 'dash', 'h', 'v']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || /^-[a-z]$/.test(a)) {
      let key = a.replace(/^--?/, '');
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = key.replace(/-/g, '_');
      if (val === undefined) {
        if (BOOL.has(key)) val = true;
        else if (i + 1 < argv.length) val = argv[++i];
        else throw new UsageError(`option --${key} needs a value`);
      }
      opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

const pair = (s, what) => {
  const m = String(s).match(/^\s*(-?[\d.]+)\s*[,;x ]\s*(-?[\d.]+)\s*$/);
  if (!m) throw new UsageError(`${what} must be "X,Y"`);
  return [Number(m[1]), Number(m[2])];
};

// ---- files ----------------------------------------------------------------------------------

function nodeReader(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    fd,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(len);
      let done = 0;
      while (done < len) {
        const n = fs.readSync(fd, buf, done, len - done, offset + done);
        if (!n) break;
        done += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, done);
    },
    close() { try { fs.closeSync(fd); } catch { /* closed */ } },
  };
}

async function load(file) {
  if (!fs.existsSync(file)) throw new UsageError(`no such file: ${file}`);
  const reader = nodeReader(file);
  try {
    const c = await openCanvas(reader);
    return { ...c, reader, file };
  } catch (e) {
    reader.close();
    throw new Error(`${file}: ${e.message}`);
  }
}

async function writeChunk(fd, chunk, pos, src) {
  if (chunk instanceof Uint8Array) {
    let done = 0;
    while (done < chunk.length) done += fs.writeSync(fd, chunk, done, chunk.length - done, pos + done);
    return pos + chunk.length;
  }
  if (chunk.range) {
    const [off, len] = chunk.range;
    const STEP = 8 * 1024 * 1024;
    for (let o = 0; o < len; o += STEP) pos = await writeChunk(fd, await src.read(off + o, Math.min(STEP, len - o)), pos, src);
    return pos;
  }
  return writeChunk(fd, new Uint8Array(await chunk.arrayBuffer()), pos, src); // Blob
}

/**
 * Write `doc` (+ new files) back. Small files and compaction: a new file
 * renamed over the old one. Big files: appended in place (nothing existing is
 * overwritten, so a crash cannot damage what was there).
 */
async function save(c, doc, { add = new Map(), mode } = {}) {
  const size = c.reader?.size ?? 0;
  const atomicAll = !c.index || size < 256 * 1024 * 1024;
  mode ||= c.index ? (atomicAll ? 'full' : chooseMode({ index: c.index, size, atomic: false })) : 'full';
  const plan = await planSave({ base: c.index ? { index: c.index, reader: c.reader } : null, doc, add, mode });
  if (plan.mode === 'full') {
    const tmp = `${c.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      let pos = 0;
      for (const ch of plan.chunks) pos = await writeChunk(fd, ch, pos, c.reader);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    c.reader?.close();
    renameRetry(tmp, c.file);
  } else {
    c.reader.close();
    const fd = fs.openSync(c.file, 'r+');
    const src = nodeReader(c.file);
    try {
      let pos = plan.at;
      for (const ch of plan.chunks) pos = await writeChunk(fd, ch, pos, src);
      fs.ftruncateSync(fd, pos);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); src.close(); }
  }
  return plan;
}

function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(from); } catch { /* ignore */ }
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // the browser may be reading it
    }
  }
}

// ---- images ----------------------------------------------------------------------------------

function listImages(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (isImageName(e.name)) out.push(abs);
    }
  };
  walk(p);
  return out;
}

async function fetchImage(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'image');
  const cd = r.headers.get('content-disposition')?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  if (cd) name = decodeURIComponent(cd[1]);
  return { bytes, name, source: url };
}

/** Turn files / urls into asset records + bytes. Duplicates (same content) are reused. */
async function gatherImages(doc, inputs) {
  const taken = takenPaths(doc);
  const out = [];
  const add = new Map();
  for (const input of inputs) {
    const sources = /^https?:\/\//i.test(input) ? [await fetchImage(input)] : listImages(path.resolve(input)).map((f) => ({ file: f }));
    for (const s of sources) {
      const bytes = s.bytes || new Uint8Array(fs.readFileSync(s.file));
      const name = s.name || path.basename(s.file);
      const info = imageInfo(bytes);
      if (!info) { process.stderr.write(`skipped (not a supported image): ${s.file || s.source}\n`); continue; }
      const sha = createHash('sha256').update(bytes).digest('hex');
      const id = assetIdFromSha(sha);
      if (!doc.assets[id] && !add.has(id)) {
        const file = assetPath(name, info.ext, taken);
        doc.assets[id] = { file, type: info.type, w: info.w, h: info.h, bytes: bytes.length, sha256: sha, name, source: s.source || null, added: now() };
        add.set(file, { data: bytes, crc: crc32(bytes) });
      }
      out.push({ asset: id, w: doc.assets[id].w, h: doc.assets[id].h, name });
    }
  }
  return { list: out, add };
}

/** A file name for a PureRef image: its item's name, its source file, or a number. */
function purImageName(pur, n) {
  const im = pur.images[n];
  const item = pur.items.find((it) => it.image === n && it.name);
  const src = im.path ? String(im.path).split(/[\/]/).pop() : null;
  return item?.name || src || im.name || `pureref-${n + 1}`;
}

// ---- output --------------------------------------------------------------------------------------

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function need(cond, msg) { if (!cond) throw new UsageError(msg); }

/** key=value pairs from the command line → an object for cleanPatch(). */
function parsePairs(pairs) {
  const out = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    need(eq > 0, `expected key=value, got "${p}"`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/** addImages for core/ops.js: files, folders and URLs from disk / the web. */
function nodeAdder(doc, add) {
  return async (o) => {
    const inputs = [].concat(o.path || o.paths || o.url || o.urls || []);
    need(inputs.length, 'add needs "paths" or "urls"');
    const g = await gatherImages(doc, inputs);
    for (const [k, v] of g.add) add.set(k, v);
    need(g.list.length, 'no supported images found (jpg, png, webp, gif, bmp, avif)');
    return g.list;
  };
}

// ---- commands ------------------------------------------------------------------------------------

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos.shift();
  const by = opt.by === 'human' ? 'human' : 'agent';
  if (opt.version || opt.v) { console.log(APP_VERSION); return 0; }
  if (!cmd || opt.help || opt.h || cmd === 'help') { console.log(HELP); return cmd || opt.help || opt.h ? 0 : 2; }
  const file = pos.shift();
  need(file, `${cmd}: missing file`);
  const out = (text, json) => console.log(opt.json && json !== undefined ? JSON.stringify(json, null, 2) : text);

  if (cmd === 'new') {
    need(!fs.existsSync(file) || opt.force, `${file} exists (use --force to overwrite)`);
    need(file.toLowerCase().endsWith(EXT), `the file name should end with ${EXT}`);
    const doc = emptyCanvas({ title: opt.title || path.basename(file, EXT), by });
    await save({ file, index: null, reader: null }, doc);
    out(`created ${file} (${doc.id})`, { file, id: doc.id });
    return 0;
  }

  if (cmd === 'from-pur') {
    const target = pos.shift() || file.replace(/\.pur$/i, '') + EXT;
    need(!fs.existsSync(target) || opt.force, `${target} exists (use --force to overwrite)`);
    const u8 = new Uint8Array(fs.readFileSync(file));
    const pur = parsePureRef(u8);
    const doc = emptyCanvas({ title: path.basename(file).replace(/\.pur$/i, ''), by });
    const taken = new Set();
    const add = new Map();
    const assetOf = [];
    for (const [n, im] of pur.images.entries()) {
      const sha = createHash('sha256').update(im.data).digest('hex');
      const id = assetIdFromSha(sha);
      const info = imageInfo(im.data) || { ext: 'bin', type: im.mime, w: im.width, h: im.height };
      if (!doc.assets[id]) {
        const fileName = assetPath(purImageName(pur, n), info.ext, taken);
        doc.assets[id] = { file: fileName, type: info.type, w: im.width || info.w, h: im.height || info.h, bytes: im.data.length, sha256: sha, name: purImageName(pur, n), added: now() };
        add.set(fileName, { data: im.data, crc: crc32(im.data) });
      }
      assetOf.push(id);
    }
    const items = [...pur.items].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((p) => {
      const it = { id: newId('image'), type: 'image', asset: assetOf[p.image], x: p.x, y: p.y, w: p.w, h: p.h };
      if (p.rotation) it.rot = p.rotation;
      if (p.flipX) it.flipX = true;
      if (p.flipY) it.flipY = true;
      if (p.crop) it.crop = p.crop;
      if (p.name) it.note = p.name;
      return it;
    });
    addItems(doc, items, by);
    await save({ file: target, index: null, reader: null }, doc, { add });
    out(`converted ${file} → ${target}: ${items.length} images${pur.warnings?.length ? `\nwarnings:\n  ${pur.warnings.join('\n  ')}` : ''}`, { file: target, items: items.length, warnings: pur.warnings });
    return 0;
  }

  const c = await load(file);
  try {
    const { doc } = c;
    switch (cmd) {
      case 'ls': {
        if (opt.group) { idsExist(doc, [opt.group]); need(doc.items.find((i) => i.id === opt.group).type === 'group', `${opt.group} is not a group`); }
        const items = opt.group ? doc.items.filter((it) => it.id === opt.group || withChildren(doc, [opt.group]).has(it.id)) : doc.items;
        out(listText(doc, { group: opt.group || null }), { title: doc.title, id: doc.id, assets: doc.assets, items });
        return 0;
      }
      case 'json': process.stdout.write(serialize(doc)); return 0;
      case 'info': {
        const v = validate(doc, { files: c.index.byName });
        const dead = deadBytes(c.index, c.reader.size);
        const info = { title: doc.title, id: doc.id, images: doc.items.filter((i) => i.type === 'image').length, groups: groupsOf(doc).length, assets: Object.keys(doc.assets).length, bytes: c.reader.size, deadBytes: dead, updated: doc.updated, updated_by: doc.updated_by, errors: v.errors, warnings: [...c.warnings, ...v.warnings.map((w) => `${w.path}: ${w.msg}`)] };
        out([
          `"${doc.title}" (${doc.id}) — ${info.images} images, ${info.groups} groups, ${info.assets} files`,
          `size ${mb(info.bytes)}, dead space ${mb(dead)}${dead > info.bytes * 0.2 ? ' (run: compact)' : ''}`,
          `updated ${doc.updated} by ${doc.updated_by}`,
          ...v.errors.map((e) => `error: ${e.path}: ${e.msg}`),
          ...info.warnings.map((w) => `warning: ${w}`),
        ].join('\n'), info);
        return 0;
      }
      case 'validate': {
        const v = validate(doc, { files: c.index.byName });
        for (const e of v.errors) console.log(`error: ${e.path}: ${e.msg}`);
        for (const w of v.warnings) console.log(`warning: ${w.path}: ${w.msg}`);
        for (const w of c.warnings) console.log(`warning: ${w}`);
        console.log(v.ok ? 'ok' : `${v.errors.length} error(s)`);
        return v.ok ? 0 : 1;
      }
      case 'extract': {
        const dir = path.resolve(opt.out || path.basename(file, EXT));
        let ids = pos.length ? pos : null;
        if (ids) { idsExist(doc, ids); ids = [...new Set(doc.items.filter((it) => ids.includes(it.id) || ids.includes(it.parent)).map((it) => it.asset).filter(Boolean))]; }
        const assets = ids || Object.keys(doc.assets);
        const written = [];
        for (const id of assets) {
          const a = doc.assets[id];
          const e = a && c.index.byName.get(a.file);
          if (!e) { process.stderr.write(`missing in file: ${a?.file || id}\n`); continue; }
          const dest = path.join(dir, a.file.replace(/^images\//, ''));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, await readEntry(c.reader, e));
          written.push(dest);
        }
        out(`wrote ${written.length} file(s) to ${dir}`, { dir, files: written });
        return 0;
      }
    }

    // writing commands: each is a list of ops (core/ops.js), like `apply`
    const add = new Map();
    let ops;
    switch (cmd) {
      case 'add': {
        need(pos.length, 'add: nothing to add (image files, folders or urls)');
        ops = [];
        let group = opt.group || null;
        if (opt.new_group) {
          const at = opt.at ? pair(opt.at, '--at') : [];
          ops.push({ op: 'newgroup', name: String(opt.new_group), x: at[0], y: at[1], as: '$new' });
          group = '$new';
        }
        const at = opt.at && !opt.new_group ? pair(opt.at, '--at') : null;
        ops.push({ op: 'add', paths: pos, group, x: at?.[0], y: at?.[1], max: opt.max });
        break;
      }
      case 'set': {
        const id = pos.shift();
        need(id && pos.length, 'set: usage: set <file> <id|canvas> key=value…');
        const fields = parsePairs(pos);
        if (id === 'canvas') { need(Object.keys(fields).join() === 'title', 'set canvas: only title=… can be set'); }
        ops = [{ op: 'set', id, ...fields }];
        break;
      }
      case 'move': {
        need(pos.length, 'move: which ids?');
        need(opt.by || opt.to, 'move: --by DX,DY or --to X,Y');
        if (opt.to) { const [x, y] = pair(opt.to, '--to'); ops = [{ op: 'move', ids: pos, x, y }]; }
        else { const [dx, dy] = pair(opt.by, '--by'); ops = [{ op: 'move', ids: pos, dx, dy }]; }
        break;
      }
      case 'rm': need(pos.length, 'rm: which ids?'); ops = [{ op: 'rm', ids: pos, keepChildren: !!opt.keep_children }]; break;
      case 'group': need(pos.length, 'group: which ids?'); ops = [{ op: 'group', ids: pos, name: opt.name, color: opt.color }]; break;
      case 'ungroup': need(pos[0], 'ungroup: which group?'); ops = [{ op: 'ungroup', id: pos[0] }]; break;
      case 'arrange': need(pos.length, 'arrange: a group id or item ids'); ops = [{ op: 'arrange', ids: pos, width: opt.width, gap: opt.gap }]; break;
      case 'front': case 'back': need(pos.length, `${cmd}: which ids?`); ops = [{ op: cmd, ids: pos }]; break;
      case 'shape': {
        need(pos.length >= 1 && pos.length <= 2, 'shape: usage: shape <file> <kind> ["text"] [--fill C] [--at X,Y] [--w W] [--h H] [--group ID]');
        const at = opt.at ? pair(opt.at, '--at') : null;
        ops = [{ op: 'shape', kind: pos[0], text: (pos[1] || '').replace(/\\n/g, '\n'), fill: opt.fill, stroke: opt.stroke, x: at?.[0], y: at?.[1], w: opt.w ? Number(opt.w) : undefined, h: opt.h ? Number(opt.h) : undefined, size: opt.size, group: opt.group }];
        break;
      }
      case 'connect': {
        need(pos.length === 2, 'connect: usage: connect <file> <from-id | X,Y> <to-id | X,Y> [--label L] [--route dubins|curve|straight|elbow] [--start H] [--end H] [--color C] [--dash]');
        const end = (v) => (/^-?[\d.]+\s*,\s*-?[\d.]+$/.test(v) ? (([x, y]) => ({ x, y }))(pair(v, 'point')) : v);
        ops = [{ op: 'connect', from: end(pos[0]), to: end(pos[1]), label: opt.label, route: opt.route, start: opt.start, end: opt.end, color: opt.color, dash: opt.dash ? true : undefined, width: opt.width ? Number(opt.width) : undefined }];
        break;
      }
      case 'stroke': {
        need(pos.length >= 1, 'stroke: usage: stroke <file> "X,Y X,Y …" [--tool pen|highlighter|tape] [--color C] [--width W]');
        const points = pos.join(' ').trim().split(/\s+/).map((s) => {
          const v = s.split(',').map(Number);
          need(v.length >= 2 && v.length <= 3 && v.every(Number.isFinite), `stroke: "${s}" is not X,Y or X,Y,PRESSURE`);
          return v;
        });
        ops = [{ op: 'stroke', points, tool: opt.tool, color: opt.color, width: opt.width ? Number(opt.width) : undefined, nib: opt.nib, group: opt.group }];
        break;
      }
      case 'note': {
        need(pos.length === 1, 'note: usage: note <file> "text" [--color C] [--at X,Y] [--group ID]');
        const at = opt.at ? pair(opt.at, '--at') : null;
        // a literal "\n" in a shell argument is a new line
        ops = [{ op: 'note', text: pos[0].replace(/\\n/g, '\n'), color: opt.color || 'yellow', x: at?.[0], y: at?.[1], group: opt.group, w: opt.w ? Number(opt.w) : undefined, size: opt.size }];
        break;
      }
      case 'apply': {
        const src = pos.shift();
        need(src, 'apply: ops.json or - (stdin)');
        const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new UsageError(`apply: not valid JSON: ${e.message}`); }
        ops = Array.isArray(parsed) ? parsed : parsed?.ops;
        need(Array.isArray(ops), 'apply: expected a JSON array of ops (or { "ops": [...] })');
        break;
      }
      case 'compact': {
        const before = c.reader.size;
        await save(c, doc, { mode: 'full' });
        const after = fs.statSync(file).size;
        out(`compacted ${mb(before)} → ${mb(after)}`, { before, after });
        return 0;
      }
      default: throw new UsageError(`unknown command "${cmd}" (see --help)`);
    }
    let r;
    try { r = await applyOps(doc, ops, { by, addImages: nodeAdder(doc, add) }); } catch (e) {
      throw e instanceof OpError ? new UsageError(`${e.message} — nothing was written`) : e;
    }
    const result = { text: r.log.join('\n') || 'nothing to do', json: { created: r.created, log: r.log } };
    pruneAssets(doc); // images no item uses any more leave the file
    const v = validate(doc);
    if (!v.ok) throw new Error(`refusing to write an invalid canvas:\n  ${v.errors.map((e) => `${e.path}: ${e.msg}`).join('\n  ')}`);
    doc.updated = now();
    doc.updated_by = by;
    await save(c, doc, { add });
    out(result.text, result.json);
    return 0;
  } finally {
    c.reader.close();
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`ilucanvas: ${e.message}\n`);
  process.exitCode = e instanceof UsageError || e instanceof OpError ? 2 : 1;
});

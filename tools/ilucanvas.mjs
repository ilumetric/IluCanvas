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
import { purItems } from '../src/core/purdoc.js';
import { listText } from '../src/core/describe.js';
import { posterUrls, oembedUrl } from '../src/core/video.js';
import { parseDelimited } from '../src/core/table.js';

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
        default place: right of everything (or at the bottom of --group);
        --name: the file name for a single image (a URL's own name is often poor)
  set <file> <id|canvas> key=value…     ${EDITABLE_KEYS.join(' ')}; canvas: title
  move <file> <id>… (--by DX,DY | --to X,Y)
                                        --by X,Y moves by an offset (--by agent|human may come too)
  shape <file> <kind> ["text"] [--fill C] [--stroke C] [--stroke-width W] [--dash]
        [--at X,Y] [--w W] [--h H] [--group ID]
                                        kinds: rect rounded ellipse diamond triangle parallelogram hexagon star
  connect <file> <from> <to> [--label L] [--route dubins|curve|straight|elbow] [--start/--end none|arrow|dot]
                                        from / to: an item id or X,Y;  [--color C] [--dash] [--width W]
  stroke <file> "X,Y X,Y …" [--tool pen|highlighter|tape] [--color C] [--width W] [--nib italic]
        [--dash] [--arrow] [--group ID]
                                        freehand ink through the points (X,Y,PRESSURE also works)
  video <file> <youtube-url> [--title T] [--at X,Y] [--w W] [--start T] [--group ID] [--no-poster]
                                        a YouTube video card; its poster is stored in the file
  note <file> "text" [--color C] [--at X,Y] [--group ID] [--w W] [--size s|m|l|xl]
                                        a note; Markdown text ("\\n" = new line); colours: yellow orange
                                        pink green blue violet grey (stickies), paper (document), none (text)
  table <file> ["CSV / TSV text"] [--csv FILE | -] [--rows N] [--cols N] [--at X,Y] [--width W]
        [--size s|m|l|xl] [--fill C] [--group ID] [--no-copy]
                                        a table: cells from CSV / TSV (text or a file), or N × M empty
                                        (default 3 × 3); --no-copy: a click on a cell does not copy it
  cell <file> <table-id> <row> <col> ["text"] [--fill C|none] [--align left|center|right]
                                        one cell (0 is the first, -1 the last); rows and columns:
                                        apply ops row / col (insert, remove)
  rm <file> <id>… [--keep-children]     a group goes with its images unless --keep-children
  group <file> <id>… [--name N] [--color ${GROUP_COLORS.join('|')}]
  ungroup <file> <group-id>
  arrange <file> <group-id | id…> [--width W] [--gap G]   justified rows, aspect kept
  front <file> <id>… | back <file> <id>…
  apply <file> <ops.json | ->           many changes in one write (see docs/AGENT.md)
  compact <file>                        rewrite the file without dead space
  from-pur <in.pur> [out.ilucanvas]     convert a PureRef file: images, groups, text notes, drawings

Options
  --by agent|human   recorded in updated_by (default agent)
  --json             machine-readable output (ls, info, add, apply)
  --version (-v), --help (-h)
Exit codes: 0 done; 1 an error (a bad file, the file changed meanwhile); 2 a bad command,
  option, field or id — nothing was written
Docs: https://ilumetric.github.io/IluCanvas/docs/AGENT.md
`;

class UsageError extends Error {}

const BOOL = new Set(['json', 'help', 'version', 'keep_children', 'force', 'dash', 'arrow', 'no_poster', 'no_copy']);
/** -h and -v alone; --h / --w are sizes (shape --h 200). */
const SHORT = { '-h': 'help', '-v': 'version' };

const PAIR = /^\s*(-?[\d.]+)\s*[,;x ]\s*(-?[\d.]+)\s*$/;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (SHORT[a]) opt[SHORT[a]] = true;
    else if (a.startsWith('--') || /^-[a-z]$/.test(a)) {
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
      // --by is the author (agent | human), and for move an offset X,Y: both can be given
      if (key === 'by' && PAIR.test(String(val))) key = 'offset';
      opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

const pair = (s, what) => {
  const m = String(s).match(PAIR);
  if (!m) throw new UsageError(`${what} must be "X,Y"`);
  return [Number(m[1]), Number(m[2])];
};

// ---- files ----------------------------------------------------------------------------------

function nodeReader(file) {
  const fd = fs.openSync(file, 'r');
  const { size, mtimeMs } = fs.fstatSync(fd);
  return {
    size,
    mtimeMs,
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

/** Refuse to write over a file someone else (the app) saved since we read it: their change would be lost. */
function checkUnchanged(c) {
  if (!c.reader) return;
  let st;
  try { st = fs.statSync(c.file); } catch { st = null; }
  if (!st || st.size !== c.reader.size || st.mtimeMs !== c.reader.mtimeMs) {
    throw new Error(`${c.file} changed while this command ran (saved by the app?) — nothing was written; run it again`);
  }
}

/**
 * Write `doc` (+ new files) back. Small files and compaction: a new file
 * renamed over the old one. Big files: appended in place (nothing existing is
 * overwritten, so a crash cannot damage what was there). Nothing is written
 * when the file changed since it was read.
 */
async function save(c, doc, { add = new Map(), mode } = {}) {
  const size = c.reader?.size ?? 0;
  const atomicAll = !c.index || size < 256 * 1024 * 1024;
  mode ||= c.index ? (atomicAll ? 'full' : chooseMode({ index: c.index, size, atomic: false })) : 'full';
  const plan = await planSave({ base: c.index ? { index: c.index, reader: c.reader } : null, doc, add, mode });
  if (plan.mode === 'full') {
    const tmp = `${c.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        let pos = 0;
        for (const ch of plan.chunks) pos = await writeChunk(fd, ch, pos, c.reader);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      checkUnchanged(c);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* not made */ }
      throw e;
    }
    c.reader?.close();
    renameRetry(tmp, c.file);
  } else {
    checkUnchanged(c);
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

/**
 * Turn files / urls (or fetched { bytes, name, source }) into asset records + bytes. Duplicates (same content) are reused.
 * `name`: the file name of a single image (`add --name`).
 */
async function gatherImages(doc, inputs, { name: rename = null } = {}) {
  const taken = takenPaths(doc);
  const out = [];
  const add = new Map();
  const sources = [];
  for (const input of inputs) sources.push(...(typeof input === 'object' ? [input] : /^https?:\/\//i.test(input) ? [await fetchImage(input)] : listImages(path.resolve(input)).map((f) => ({ file: f }))));
  need(!rename || sources.length <= 1, `--name is for a single image (${sources.length} found)`);
  for (const s of sources) {
    const bytes = s.bytes || new Uint8Array(fs.readFileSync(s.file));
    const name = rename ? String(rename) : s.name || path.basename(s.file);
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
    const g = await gatherImages(doc, inputs, { name: o.name });
    for (const [k, v] of g.add) add.set(k, v);
    need(g.list.length, 'no supported images found (jpg, png, webp, gif, bmp, avif)');
    return g.list;
  };
}

/** videoMeta for core/ops.js: the title (oEmbed) and the poster, stored as an image asset. */
function nodeVideoMeta(doc, add) {
  return async (v) => {
    const meta = {};
    try {
      const r = await fetch(oembedUrl(v.url));
      if (r.ok) meta.title = (await r.json()).title;
    } catch { /* offline: no title */ }
    for (const u of posterUrls(v.videoId)) {
      try {
        const src = await fetchImage(u);
        const g = await gatherImages(doc, [{ ...src, name: `youtube-${v.videoId}.jpg` }]);
        if (!g.list.length) continue;
        for (const [k, x] of g.add) add.set(k, x);
        meta.asset = g.list[0].asset;
        break;
      } catch { /* the next size */ }
    }
    return meta;
  };
}

// ---- commands ------------------------------------------------------------------------------------

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos.shift();
  const by = opt.by === 'human' ? 'human' : 'agent';
  if (opt.version) { console.log(APP_VERSION); return 0; }
  if (!cmd || opt.help || cmd === 'help') { console.log(HELP); return cmd || opt.help ? 0 : 2; }
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
    // on our own widgets: images, group frames, notes
    const { items } = purItems(pur, (i) => assetOf[i], (kind) => newId(kind));
    addItems(doc, items, by);
    await save({ file: target, index: null, reader: null }, doc, { add });
    const count = (type) => items.filter((it) => it.type === type).length;
    out(`converted ${file} → ${target}: ${count('image')} images, ${count('group')} groups, ${count('note')} notes, ${count('shape') + count('stroke') + count('connector')} drawn${pur.warnings?.length ? `\nwarnings:\n  ${pur.warnings.join('\n  ')}` : ''}`, { file: target, items: items.length, warnings: pur.warnings });
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
        if (ids) {
          idsExist(doc, ids);
          const set = withChildren(doc, ids); // groups: what is inside them, nested groups too
          ids = [...new Set(doc.items.filter((it) => set.has(it.id) && typeof it.asset === 'string').map((it) => it.asset))];
        }
        const assets = ids || Object.keys(doc.assets);
        const written = [];
        for (const id of assets) {
          const a = doc.assets[id];
          const e = a && c.index.byName.get(a.file);
          if (!e) { process.stderr.write(`missing in file: ${a?.file || id}\n`); continue; }
          const dest = path.resolve(dir, a.file.replace(/^images\//, ''));
          const rel = path.relative(dir, dest);
          if (!rel || rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) { process.stderr.write(`skipped (its name leads outside ${dir}): ${a.file}\n`); continue; }
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
        ops.push({ op: 'add', paths: pos, group, x: at?.[0], y: at?.[1], max: opt.max, name: opt.name });
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
        need(opt.offset || opt.to, 'move: --by DX,DY or --to X,Y');
        if (opt.to) { const [x, y] = pair(opt.to, '--to'); ops = [{ op: 'move', ids: pos, x, y }]; }
        else { const [dx, dy] = pair(opt.offset, '--by'); ops = [{ op: 'move', ids: pos, dx, dy }]; }
        break;
      }
      case 'rm': need(pos.length, 'rm: which ids?'); ops = [{ op: 'rm', ids: pos, keepChildren: !!opt.keep_children }]; break;
      case 'group': need(pos.length, 'group: which ids?'); ops = [{ op: 'group', ids: pos, name: opt.name, color: opt.color }]; break;
      case 'ungroup': need(pos[0], 'ungroup: which group?'); ops = [{ op: 'ungroup', id: pos[0] }]; break;
      case 'arrange': need(pos.length, 'arrange: a group id or item ids'); ops = [{ op: 'arrange', ids: pos, width: opt.width, gap: opt.gap }]; break;
      case 'front': case 'back': need(pos.length, `${cmd}: which ids?`); ops = [{ op: cmd, ids: pos }]; break;
      case 'shape': {
        need(pos.length >= 1 && pos.length <= 2, 'shape: usage: shape <file> <kind> ["text"] [--fill C] [--stroke C] [--stroke-width W] [--dash] [--at X,Y] [--w W] [--h H] [--group ID]');
        const at = opt.at ? pair(opt.at, '--at') : null;
        ops = [{ op: 'shape', kind: pos[0], text: (pos[1] || '').replace(/\\n/g, '\n'), fill: opt.fill, stroke: opt.stroke, strokeWidth: opt.stroke_width ? Number(opt.stroke_width) : undefined, dash: opt.dash ? true : undefined, x: at?.[0], y: at?.[1], w: opt.w ? Number(opt.w) : undefined, h: opt.h ? Number(opt.h) : undefined, size: opt.size, group: opt.group }];
        break;
      }
      case 'connect': {
        need(pos.length === 2, 'connect: usage: connect <file> <from-id | X,Y> <to-id | X,Y> [--label L] [--route dubins|curve|straight|elbow] [--start H] [--end H] [--color C] [--dash]');
        const end = (v) => (/^-?[\d.]+\s*,\s*-?[\d.]+$/.test(v) ? (([x, y]) => ({ x, y }))(pair(v, 'point')) : v);
        ops = [{ op: 'connect', from: end(pos[0]), to: end(pos[1]), label: opt.label, route: opt.route, start: opt.start, end: opt.end, color: opt.color, dash: opt.dash ? true : undefined, width: opt.width ? Number(opt.width) : undefined }];
        break;
      }
      case 'video': {
        need(pos.length === 1, 'video: usage: video <file> <youtube-url> [--title T] [--at X,Y] [--w W] [--start T] [--group ID] [--no-poster]');
        const at = opt.at ? pair(opt.at, '--at') : null;
        ops = [{ op: 'video', url: pos[0], title: opt.title, start: opt.start, x: at?.[0], y: at?.[1], w: opt.w ? Number(opt.w) : undefined, group: opt.group }];
        break;
      }
      case 'stroke': {
        need(pos.length >= 1, 'stroke: usage: stroke <file> "X,Y X,Y …" [--tool pen|highlighter|tape] [--color C] [--width W] [--dash] [--arrow]');
        const points = pos.join(' ').trim().split(/\s+/).map((s) => {
          const v = s.split(',').map(Number);
          need(v.length >= 2 && v.length <= 3 && v.every(Number.isFinite), `stroke: "${s}" is not X,Y or X,Y,PRESSURE`);
          return v;
        });
        ops = [{ op: 'stroke', points, tool: opt.tool, color: opt.color, width: opt.width ? Number(opt.width) : undefined, nib: opt.nib, dash: opt.dash ? true : undefined, end: opt.arrow ? 'arrow' : undefined, group: opt.group }];
        break;
      }
      case 'table': {
        need(pos.length <= 1, 'table: usage: table <file> ["CSV / TSV text"] [--csv FILE | -] [--rows N] [--cols N] [--at X,Y]');
        const at = opt.at ? pair(opt.at, '--at') : null;
        const src = opt.csv !== undefined ? (opt.csv === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(String(opt.csv), 'utf8')) : pos[0] !== undefined ? pos[0].replace(/\\n/g, '\n').replace(/\\t/g, '\t') : null;
        const cells = src !== null ? parseDelimited(src) : undefined;
        if (cells) need(cells.length, 'table: the CSV / TSV has no rows');
        ops = [{ op: 'table', cells, rows: opt.rows ? Number(opt.rows) : undefined, cols: opt.cols ? Number(opt.cols) : undefined, width: opt.width ? Number(opt.width) : undefined, size: opt.size, fill: opt.fill, clickCopy: opt.no_copy ? false : undefined, x: at?.[0], y: at?.[1], group: opt.group }];
        break;
      }
      case 'cell': {
        need(pos.length >= 3 && pos.length <= 4, 'cell: usage: cell <file> <table-id> <row> <col> ["text"] [--fill C] [--align A]');
        const [id, row, col, text] = pos;
        ops = [{ op: 'cell', id, row: Number(row), col: Number(col), text: text !== undefined ? text.replace(/\\n/g, '\n') : undefined, fill: opt.fill === 'none' ? null : opt.fill, align: opt.align }];
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
    try { r = await applyOps(doc, ops, { by, addImages: nodeAdder(doc, add), videoMeta: opt.no_poster ? null : nodeVideoMeta(doc, add) }); } catch (e) {
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

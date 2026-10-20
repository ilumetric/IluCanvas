import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readdirSync, readFileSync, utimesSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/core/crc32.js';
import { bytesReader, readZip, ZipWriter } from '../src/core/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIS = [['source', join(ROOT, 'tools/ilucanvas.mjs')], ['bundle', join(ROOT, 'ilucanvas.mjs')]];

/** The file's own ZIP directory reads (not rebuilt from the records): what other ZIP tools see. */
async function strictZip(f) {
  const idx = await readZip(bytesReader(new Uint8Array(readFileSync(f))), { recover: false });
  assert.deepEqual(idx.warnings, []);
  return idx;
}

/** A tiny valid PNG (w×h, one colour). */
function png(w, h, rgb = [200, 80, 40]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [label, cli] of CLIS) {
  test(`CLI (${label}): new, add, group, set, apply, ls, extract, validate`, async (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    const runJson = (...args) => JSON.parse(run(...args, '--json'));
    try {
      writeFileSync(join(dir, 'a.png'), png(40, 30));
      writeFileSync(join(dir, 'b.png'), png(30, 60, [10, 120, 200]));
      writeFileSync(join(dir, 'not-image.txt'), 'hello');
      const f = join(dir, 'board.ilucanvas');
      run('new', f, '--title', 'Рефы');
      const added = runJson('add', f, join(dir, 'a.png'), join(dir, 'b.png'), '--new-group', 'Свет');
      assert.equal(added.created.length, 3, 'a group and two images');
      const ls = runJson('ls', f);
      assert.equal(ls.title, 'Рефы');
      const imgs = ls.items.filter((i) => i.type === 'image');
      assert.equal(imgs.length, 2);
      assert.ok(imgs.every((i) => i.parent), 'images are in the new group');
      // the same picture again is stored once
      run('add', f, join(dir, 'a.png'));
      assert.equal(Object.keys(runJson('ls', f).assets).length, 2);
      run('set', f, imgs[0].id, 'note=главный', 'rot=90');
      await strictZip(f); // a write that keeps the images leaves a valid directory
      const ops = [
        { op: 'newgroup', name: 'Позы', as: '$p' },
        { op: 'move', ids: [imgs[1].id], x: 5000, y: 0 },
        { op: 'arrange', id: '$p' },
      ];
      writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
      const r = runJson('apply', f, join(dir, 'ops.json'));
      assert.ok(r.log.length === 3);
      // a bad op writes nothing
      const before = statSync(f).mtimeMs;
      const bad = spawnSync(process.execPath, [cli, 'apply', f, '-'], { input: JSON.stringify([{ op: 'set', id: 'nope', x: 1 }]), encoding: 'utf8' });
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /unknown id/);
      assert.equal(statSync(f).mtimeMs, before);
      const text = run('ls', f);
      assert.match(text, /note="главный"/);
      assert.match(text, /rot=90/);
      run('extract', f, '--out', join(dir, 'out'));
      assert.deepEqual(readdirSync(join(dir, 'out')).sort(), ['a.png', 'b.png']);
      assert.match(run('validate', f), /ok/);
      assert.match(run('info', f), /3 images/);
      // removing the only item that shows b.png drops the file from the board
      const bItem = runJson('ls', f).items.find((i) => i.type === 'image' && i.w / i.h < 1);
      run('rm', f, bItem.id);
      assert.equal(Object.keys(runJson('ls', f).assets).length, 1);
      run('compact', f);
      assert.match(run('validate', f), /ok/);
      assert.equal((await strictZip(f)).entries.filter((e) => e.name.startsWith('images/')).length, 1);
      // unknown command / option → exit 2
      assert.equal(spawnSync(process.execPath, [cli, 'frobnicate', f]).status, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`CLI (${label}): note, shape, connect, rm detaches`, (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    const runJson = (...args) => JSON.parse(run(...args, '--json'));
    try {
      const f = join(dir, 'flow.ilucanvas');
      run('new', f);
      run('note', f, '# План\\n- [ ] эскиз', '--color', 'paper');
      const [a] = runJson('shape', f, 'rounded', 'Старт', '--fill', 'green', '--at', '0,0').created;
      const [b] = runJson('shape', f, 'diamond', 'Ок?', '--fill', 'yellow', '--at', '400,0').created;
      const [c] = runJson('connect', f, a, b, '--label', 'да', '--route', 'elbow').created;
      runJson('connect', f, b, '900,300', '--end', 'dot', '--dash');
      run('stroke', f, '-20,300 100,340,0.9 220,300', '--color', 'red', '--width', '6');
      const text = run('ls', f);
      assert.match(text, /1 notes · 2 shapes · 2 connectors · 1 strokes/);
      assert.match(text, /stroke {2}pen {2}red {2}width=6 {2}3 points/);
      assert.equal(spawnSync(process.execPath, [cli, 'stroke', f, '1,2,3,4']).status, 2);
      assert.match(text, new RegExp(`${c}  connector  ${a} → ${b}  "да"  elbow end=arrow  grey`));
      assert.match(text, /shape {2}diamond {2}"Ок\?" {2}fill=yellow/);
      const bad = spawnSync(process.execPath, [cli, 'shape', f, 'blob'], { encoding: 'utf8' });
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /kind must be one of/);
      run('rm', f, b);
      const after = runJson('ls', f).items.filter((i) => i.type === 'connector');
      assert.equal(after.length, 2, 'connectors stay');
      assert.ok(after.every((x) => x.from.id !== b && x.to.id !== b), 'ends on the removed shape became points');
      assert.match(run('validate', f), /ok/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const [label, cli] of CLIS) {
  test(`CLI (${label}): --h is a size, -h help; move --by X,Y with --by human; add --name; extract a nested group`, async (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    const runJson = (...args) => JSON.parse(run(...args, '--json'));
    const item = (f, id) => runJson('ls', f).items.find((i) => i.id === id);
    try {
      const f = join(dir, 'b.ilucanvas');
      run('new', f);
      const [s] = runJson('shape', f, 'rect', '--w', '300', '--h', '200', '--at', '0,0').created;
      assert.deepEqual([item(f, s).w, item(f, s).h], [300, 200]);
      assert.match(run('-h'), /^Usage:/m);
      run('move', f, s, '--by', '10,5', '--by', 'human');
      assert.deepEqual([item(f, s).x, item(f, s).y], [10, 5]);
      assert.equal(JSON.parse(run('json', f)).updated_by, 'human');
      // a picture under a name of our choosing, in a group inside a group
      writeFileSync(join(dir, 'a.png'), png(40, 30));
      writeFileSync(join(dir, 'b.png'), png(30, 60, [10, 120, 200]));
      const [outer] = runJson('add', f, join(dir, 'a.png'), '--name', 'Rim light', '--new-group', 'Outer').created;
      writeFileSync(join(dir, 'ops.json'), JSON.stringify([
        { op: 'newgroup', name: 'Inner', x: 9000, y: 0, as: '$in' },
        { op: 'add', paths: [join(dir, 'b.png')], group: '$in' },
        { op: 'set', id: '$in', parent: outer },
      ]));
      run('apply', f, join(dir, 'ops.json'));
      assert.ok(Object.values(runJson('ls', f).assets).some((a) => a.file === 'images/Rim light.png'));
      assert.equal(spawnSync(process.execPath, [cli, 'add', f, join(dir, 'a.png'), join(dir, 'b.png'), '--name', 'x']).status, 2);
      run('extract', f, outer, '--out', join(dir, 'out'));
      assert.deepEqual(readdirSync(join(dir, 'out')).sort(), ['Rim light.png', 'b.png']);
      await strictZip(f);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`CLI (${label}): extract never writes outside its folder`, async (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    try {
      // a hostile file: an asset named images/../../escaped.txt
      const enc = (s) => new TextEncoder().encode(s);
      const w = new ZipWriter(0);
      await w.add('mimetype', enc('application/x-ilucanvas+zip'));
      const data = enc('pwned');
      w.addStored('images/../../escaped.txt', data, { crc: crc32(data) });
      const doc = { format: 'ilucanvas', version: 1, id: 'cevil', title: 'evil', assets: { a1: { file: 'images/../../escaped.txt', type: 'image/png', w: 1, h: 1 } }, items: [{ id: 'i1', type: 'image', asset: 'a1', x: 0, y: 0, w: 10, h: 10 }] };
      await w.add('canvas.json', enc(JSON.stringify(doc)));
      const f = join(dir, 'evil.ilucanvas');
      writeFileSync(f, Buffer.concat(w.finish().chunks));
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      const r = spawnSync(process.execPath, [cli, 'extract', f, '--out', join(dir, 'a', 'b', 'out')], { encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /skipped/);
      assert.ok(!existsSync(join(dir, 'a', 'escaped.txt')), 'nothing written outside --out');
      const v = spawnSync(process.execPath, [cli, 'validate', f], { encoding: 'utf8' });
      assert.equal(v.status, 1);
      assert.match(v.stdout, /plain path inside the file/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`CLI (${label}): a file saved by someone else meanwhile is not overwritten`, async (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    const f = join(dir, 'b.ilucanvas');
    execFileSync(process.execPath, [cli, 'new', f]);
    const before = readFileSync(f);
    // the CLI reads the file, then downloads the image: the "app" saves the file in between
    const server = createServer((req, res) => {
      utimesSync(f, new Date(), new Date(Date.now() + 60000));
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png(10, 10));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const r = await new Promise((ok) => {
        const p = spawn(process.execPath, [cli, 'add', f, `http://127.0.0.1:${server.address().port}/x.png`]);
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('close', (code) => ok({ code, stderr }));
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /changed while this command ran/);
      assert.deepEqual(readFileSync(f), before, 'nothing written');
      assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('CLI: from-pur converts the sample PureRef file (when present)', (t) => {
  const pur = join(ROOT, 'examples/NewScene.pur');
  if (!existsSync(pur)) { t.skip('no examples/NewScene.pur'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-pur-'));
  try {
    const out = join(dir, 'x.ilucanvas');
    execFileSync(process.execPath, [join(ROOT, 'tools/ilucanvas.mjs'), 'from-pur', pur, out]);
    const ls = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'tools/ilucanvas.mjs'), 'ls', out, '--json'], { encoding: 'utf8' }));
    assert.equal(ls.items.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [label, cli] of CLIS) {
  test(`CLI (${label}): video (no network: --no-poster)`, (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-cli-'));
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    try {
      const f = join(dir, 'v.ilucanvas');
      run('new', f);
      run('video', f, 'https://youtu.be/dQw4w9WgXcQ?t=43', '--title', 'Rick', '--no-poster', '--at', '0,0');
      assert.match(run('ls', f), /video {2}youtube dQw4w9WgXcQ {2}"Rick" {2}start=0:43 no poster/);
      assert.equal(spawnSync(process.execPath, [cli, 'video', f, 'https://example.com', '--no-poster']).status, 2);
      assert.match(run('validate', f), /ok/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

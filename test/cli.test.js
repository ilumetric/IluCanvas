import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/core/crc32.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIS = [['source', join(ROOT, 'tools/ilucanvas.mjs')], ['bundle', join(ROOT, 'ilucanvas.mjs')]];

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
  test(`CLI (${label}): new, add, group, set, apply, ls, extract, validate`, (t) => {
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
      const text = run('ls', f);
      assert.match(text, /1 notes · 2 shapes · 2 connectors/);
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

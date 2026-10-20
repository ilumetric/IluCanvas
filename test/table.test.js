import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyCanvas, normalize, validate, serialize, cleanTable } from '../src/core/model.js';
import { applyOps } from '../src/core/ops.js';
import { listText } from '../src/core/describe.js';
import {
  cellOf, insertRow, insertCol, removeRows, removeCols, setCell, mapCells, resizeCol, cellsText, cellsHtml,
  parseDelimited, hasMark, setMark, isList, setList, estimateHeight,
} from '../src/core/table.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const grid = (cells) => cleanTable({ id: 't1', type: 'table', x: 0, y: 0, w: 1, h: 1, cells });

test('tables: normalize pads cells, cleans colours, keeps the box consistent', () => {
  const d = normalize({ items: [{ id: 't1', type: 'table', rot: 30, fill: 'nope', clickCopy: true, cells: [['a', 'b', 'c'], [{ text: 'd', fill: 'yellow', align: 'bad' }]] }] });
  const t = d.items[0];
  assert.deepEqual(t.cells, [['a', 'b', 'c'], [{ text: 'd', fill: 'yellow' }, '', '']]);
  assert.deepEqual([t.cols.length, t.rows.length, t.w, t.fill, t.rot, t.clickCopy], [3, 2, 600, 'white', undefined, undefined]);
  assert.ok(t.h >= 112);
  assert.ok(validate(d).ok);
  const off = normalize({ items: [{ id: 't2', type: 'table', clickCopy: false, cells: [['x']] }] }).items[0];
  assert.equal(off.clickCopy, false, 'copy on click: only "off" is stored');
  // fields in their order, cells last (they are the long part)
  const line = serialize(d).split('\n').find((l) => l.includes('"t1"'));
  assert.ok(line.indexOf('"cols"') < line.indexOf('"cells"') && line.indexOf('"fill"') < line.indexOf('"cols"'));
  // a hand-written table whose cells do not match its sizes is an error
  const bad = validate({ format: 'ilucanvas', items: [{ id: 'x', type: 'table', x: 0, y: 0, w: 10, h: 10, cols: [10], rows: [10, 10], cells: [['a']] }], assets: {} });
  assert.ok(!bad.ok && bad.errors[0].path.endsWith('.cells'));
});

test('tables: rows and columns in and out, cells, sizes', () => {
  let t = grid([['a', 'b'], ['c', 'd']]);
  t = insertRow(t, 1, { cells: ['x', 'y'] });
  assert.deepEqual(t.cells, [['a', 'b'], ['x', 'y'], ['c', 'd']]);
  t = insertCol(t, 0, { cells: ['#', '1', '2'], width: 60 });
  assert.deepEqual(t.cols, [60, 200, 200]);
  assert.equal(t.w, 460);
  assert.deepEqual(t.cells.map((r) => r[0]), ['#', '1', '2']);
  t = removeRows(t, 0, 1);
  assert.deepEqual(t.cells, [['2', 'c', 'd']]);
  assert.equal(removeRows(t, 0), t, 'the last row stays');
  t = removeCols(t, 1);
  assert.deepEqual(t.cells, [['2', 'd']]);
  t = setCell(t, 0, 1, { text: 'new', fill: 'pink', align: 'center' });
  assert.deepEqual(cellOf(t, 0, 1), { text: 'new', fill: 'pink', align: 'center' });
  t = setCell(t, 0, 1, { fill: null, align: null });
  assert.equal(t.cells[0][1], 'new', 'a plain cell is a plain string');
  t = mapCells(t, { r0: 0, c0: 0, r1: 0, c1: 1 }, (c) => ({ ...c, text: c.text.toUpperCase() }));
  assert.deepEqual(t.cells, [['2', 'NEW']]);
  assert.equal(resizeCol(t, 0, 2).cols[0], 24, 'a column is never narrower than the least');
});

test('tables: copying cells as TSV and HTML, reading CSV / TSV', () => {
  const t = grid([['Name', '**Bold** text'], ['multi\nline', 'tab\there']]);
  assert.equal(cellsText(t, { r0: 0, c0: 1, r1: 0, c1: 1 }), 'Bold text', 'one cell: its plain text, no Markdown');
  assert.equal(cellsText(t), 'Name\tBold text\n"multi\nline"\t"tab\there"', 'a range: tabs and lines; odd cells quoted');
  assert.match(cellsHtml(t, { r0: 1, c0: 0, r1: 1, c1: 0 }), /<td>multi<br>line<\/td>/);
  assert.deepEqual(parseDelimited('a,b\n"c, d","e ""q"""\n'), [['a', 'b'], ['c, d', 'e "q"']]);
  assert.deepEqual(parseDelimited('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseDelimited('a;b;c\n1;2;3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseDelimited('"multi\nline",x'), [['multi\nline', 'x']]);
});

test('tables: bold / strike / bullets over whole cells', () => {
  assert.equal(setMark('a\n- b\n\n# c', '**', true), '**a**\n- **b**\n\n# **c**');
  assert.ok(hasMark('**a**\n- **b**', '**'));
  assert.equal(setMark('**a**\n- **b**', '**', false), 'a\n- b');
  assert.equal(setMark('~~x~~', '~~', true), '~~x~~', 'already marked: unchanged');
  assert.equal(setList('a\n1. b', true), '- a\n- b');
  assert.ok(isList('- a\n- b'));
  assert.ok(!isList('- [ ] task'), 'a checklist is not bullets');
  assert.equal(setList('- a\n  - b', false), 'a\n  b');
});

test('tables: ops for agents — table, cell, row, col, set', async () => {
  const d = emptyCanvas();
  const r = await applyOps(d, [
    { op: 'table', cells: [['Name', 'Link'], ['a', 'https://x']], as: '$t', x: 0, y: 0 },
    { op: 'cell', id: '$t', row: 1, col: 0, text: '**a**', fill: 'yellow' },
    { op: 'cell', id: '$t', row: -1, col: -1, align: 'center' },
    { op: 'row', id: '$t', cells: ['x', 'y'] },
    { op: 'col', id: '$t', at: 0, width: 80, cells: ['#', '1', '2'] },
    { op: 'row', id: '$t', at: 1, remove: true },
    { op: 'set', id: '$t', clickCopy: false, size: 's', fill: 'blue' },
    { op: 'table', rows: 2, cols: 4, as: '$e' },
  ]);
  assert.equal(r.created.length, 2);
  const [t, e] = d.items;
  assert.deepEqual(t.cols, [80, 200, 200]);
  assert.deepEqual(t.cells, [['#', 'Name', 'Link'], ['2', 'x', 'y']]);
  assert.equal(t.clickCopy, false);
  assert.equal(t.fill, 'blue');
  assert.equal(t.w, 480);
  assert.deepEqual([e.rows.length, e.cols.length], [2, 4]);
  assert.ok(e.x > t.x + t.w, 'placed right of everything');
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));
  // long text: the height is estimated (the app measures it properly)
  const before = t.h;
  await applyOps(d, [{ op: 'cell', id: t.id, row: 0, col: 1, text: 'a long line of text that wraps in a column two hundred units wide, and more' }]);
  assert.ok(d.items[0].h > before && d.items[0].h === estimateHeight(d.items[0]));
  // mistakes are explained
  await assert.rejects(applyOps(d, [{ op: 'cell', id: t.id, row: 9, col: 0, text: 'x' }]), /row 9 is outside the table/);
  await assert.rejects(applyOps(d, [{ op: 'set', id: t.id, color: 'red' }]), /tables have fill/);
  await assert.rejects(applyOps(d, [{ op: 'col', id: e.id, at: 0, to: 3, remove: true }]), /at least one column/);
  await assert.rejects(applyOps(d, [{ op: 'cell', id: e.id, row: 0, col: 0, fill: 'nope' }]), /fill must be/);
  // ls shows the rows under the table
  const text = listText(d);
  assert.match(text, /table {2}2×3 {2}fill=blue {2}no-click-copy/);
  assert.match(text, /\n {4}\| # \| a long line/);
});

for (const [label, cli] of [['source', join(ROOT, 'tools/ilucanvas.mjs')], ['bundle', join(ROOT, 'ilucanvas.mjs')]]) {
  test(`CLI (${label}): table from CSV, cell`, (t) => {
    if (!existsSync(cli)) { t.skip(`${cli} not built`); return; }
    const dir = mkdtempSync(join(tmpdir(), 'ilucanvas-table-'));
    const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
    try {
      const f = join(dir, 'b.ilucanvas');
      run('new', f);
      writeFileSync(join(dir, 'data.csv'), 'Name,Notes\n"Smith, J","two\nlines"\n');
      run('table', f, '--csv', join(dir, 'data.csv'), '--no-copy', '--fill', 'yellow');
      run('table', f, 'a\\tb\\nc\\td', '--at', '0,900');
      const ls = JSON.parse(run('ls', f, '--json'));
      const [a, b] = ls.items.filter((i) => i.type === 'table');
      assert.deepEqual(a.cells, [['Name', 'Notes'], ['Smith, J', 'two\nlines']]);
      assert.deepEqual([a.clickCopy, a.fill], [false, 'yellow']);
      assert.deepEqual(b.cells, [['a', 'b'], ['c', 'd']]);
      run('cell', f, a.id, '-1', '0', 'Doe', '--fill', 'green', '--align', 'center');
      const a2 = JSON.parse(run('ls', f, '--json')).items.find((i) => i.id === a.id);
      assert.deepEqual(a2.cells[1][0], { text: 'Doe', fill: 'green', align: 'center' });
      assert.match(run('ls', f), /\| Doe \| two \/ lines \|/);
      run('validate', f);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

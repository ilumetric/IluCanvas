import test from 'node:test';
import assert from 'node:assert/strict';
import { purItems, escapeMarkdown } from '../src/core/purdoc.js';
import { parseMarkdown, plainText } from '../src/core/markdown.js';
import { normalize, validate, emptyCanvas, groupsByDepth } from '../src/core/model.js';

test('PureRef on our widgets: groups (nested), notes, stacking', () => {
  const pur = {
    images: [{}, {}],
    items: [
      { image: 0, x: 0, y: 0, w: 400, h: 300, z: 1, group: 11 },
      { image: 1, x: 2000, y: 0, w: 200, h: 200, z: 5, group: null, rotation: 90, flipX: true, opacity: 0.5, name: 'pose' },
    ],
    texts: [
      { text: '# not a heading *really*', x: 0, y: 400, w: null, h: null, scale: 2, background: null, group: 10, z: 2, rotation: 0 },
      { text: 'Sticky', x: 1000, y: 0, w: 200, h: 200, background: '#ffe08a', group: null, z: 4 },
      { text: '   ', x: 0, y: 0, background: null, z: 0 },
    ],
    groups: [
      { id: 10, name: 'Refs', group: null, background: '#3b82f6' },
      { id: 11, name: 'Inner', group: 10, background: null },
      { id: 12, name: 'Empty', group: null, background: '#ef4444' },
    ],
  };
  const { items } = purItems(pur, (i) => `a${i}`, (kind, n) => `${kind}${n}`);
  const by = new Map(items.map((it) => [it.id, it]));
  const groups = items.filter((it) => it.type === 'group');
  assert.deepEqual(groups.map((g) => g.name), ['Refs', 'Inner'], 'outer first; the empty group is gone');
  const outer = groups[0];
  const inner = groups[1];
  assert.equal(outer.color, 'blue');
  assert.equal(inner.color, 'grey');
  assert.equal(inner.parent, outer.id);
  const img = items.find((it) => it.asset === 'a0');
  assert.equal(img.parent, inner.id);
  assert.ok(inner.x < img.x && inner.x + inner.w > img.x + img.w, 'the frame hugs the image');
  assert.ok(outer.x <= inner.x && outer.y + outer.h >= 400, 'the outer frame holds the inner one and the note');
  const notes = items.filter((it) => it.type === 'note');
  assert.equal(notes.length, 2, 'blank text is skipped');
  assert.equal(notes[0].color, 'none');
  assert.equal(notes[0].scale, 2);
  assert.equal(notes[0].parent, outer.id);
  assert.equal(plainText(notes[0].text), '# not a heading *really*', 'shown as typed');
  assert.equal(parseMarkdown(notes[0].text)[0].type, 'p');
  assert.equal(notes[1].color, 'yellow');
  assert.equal(notes[1].w, 200);
  const other = items.find((it) => it.asset === 'a1');
  assert.equal(other.rot, 90);
  assert.equal(other.flipX, true);
  assert.equal(other.opacity, 0.5);
  // stacking: groups, then by PureRef's z
  assert.deepEqual(items.filter((it) => it.type !== 'group').map((it) => it.id), [img.id, notes[0].id, notes[1].id, other.id]);
  // a valid board
  const d = { ...emptyCanvas(), assets: { a0: { file: 'images/a.jpg', w: 1, h: 1 }, a1: { file: 'images/b.jpg', w: 1, h: 1 } }, items };
  assert.ok(validate(normalize(d)).ok);
  assert.deepEqual(groupsByDepth(normalize(d)).map((g) => g.name), ['Refs', 'Inner']);
  assert.equal(by.get(inner.id).name, 'Inner');
});

test('escapeMarkdown keeps every character literal', () => {
  const s = '- list?\n> quote\n1. one\n**bold** _it_ ==hl== [a](b) <u>x</u> ~~s~~ \ back';
  assert.equal(plainText(escapeMarkdown(s)), s);
  assert.ok(parseMarkdown(escapeMarkdown(s)).every((b) => b.type === 'p'));
});

test('PureRef drawings: rectangles and ellipses → shapes, a line → a connector, the rest → ink', () => {
  const ell = [[0, -10, 0], [2, -10, 5.5], [3, -5.5, 10], [3, 0, 10], [2, 5.5, 10], [3, 10, 5.5], [3, 10, 0], [2, 10, -5.5], [3, 5.5, -10], [3, 0, -10], [2, -5.5, -10], [3, -10, -5.5], [3, -10, 0]];
  const el = (list) => list.map(([type, x, y]) => ({ type, x, y }));
  const pur = {
    images: [], items: [], texts: [], groups: [],
    drawings: [{
      id: 6, z: 3, group: null, matrix: [2, 0, 0, 2, 100, 50],
      strokes: [
        { color: '#2e84aa', alpha: 0.78, width: 5, elements: el([[0, 0, 0], [1, 40, 0], [1, 40, 20], [1, 0, 20], [1, 0, 0]]) },
        { color: '#2e84aa', alpha: 0.78, width: 5, elements: el(ell) },
        { color: '#ff0000', alpha: 1, width: 3, dashed: true, elements: el([[0, 0, 0], [1, 30, 40]]) },
        { color: '#00ff00', alpha: 1, width: 4, elements: el([[0, 0, 0], [2, 5, 0], [3, 10, 5], [3, 10, 10]]) },
      ],
    }],
  };
  const { items } = purItems(pur, () => null, (kind, n) => `${kind}${n}`);
  const [rect, ellipse, line, ink] = items;
  assert.deepEqual([rect.type, rect.kind, rect.fill, rect.stroke, rect.strokeWidth], ['shape', 'rect', 'none', '#2e84aa', 10]);
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [100, 50, 80, 40], 'placed by the drawing transform');
  assert.deepEqual([ellipse.kind, ellipse.x, ellipse.y, ellipse.w, ellipse.h], ['ellipse', 80, 30, 40, 40]);
  assert.deepEqual([line.type, line.from, line.to, line.end, line.color, line.width], ['connector', { x: 100, y: 50 }, { x: 160, y: 130 }, 'none', '#ff0000', 6]);
  assert.equal(line.dash, true, 'a dashed PureRef line stays dashed');
  assert.equal(rect.dash, undefined);
  assert.equal(ink.type, 'stroke');
  assert.equal(ink.color, '#00ff00');
  assert.equal(ink.width, 8);
  assert.ok(ink.pts.length / 3 >= 9, 'the curve is sampled');
  const d = normalize({ ...emptyCanvas(), items });
  assert.ok(validate(d).ok, JSON.stringify(validate(d).errors));

  // arrow style: open lines get an arrowhead at the end, closed shapes stay plain
  const arrows = { ...pur, drawings: [{ ...pur.drawings[0], strokes: pur.drawings[0].strokes.map((s) => ({ ...s, dashed: false, arrow: true })) }] };
  const [r2, , l2, k2] = purItems(arrows, () => null, (kind, n) => `${kind}${n}`).items;
  assert.equal(l2.end, 'arrow');
  assert.equal(k2.end, 'arrow');
  assert.equal(r2.end, undefined);
  assert.equal(r2.dash, undefined);
  const d2 = normalize({ ...emptyCanvas(), items: [k2] });
  assert.equal(d2.items[0].end, 'arrow', 'a stroke keeps its arrow');
  assert.ok(validate(d2).ok, JSON.stringify(validate(d2).errors));
});

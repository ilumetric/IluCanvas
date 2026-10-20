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

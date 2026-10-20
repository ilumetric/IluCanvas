import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, toMarkdown, parseInline, plainText } from '../src/core/markdown.js';

const spans = (md) => parseInline(md);

test('inline marks, nesting and literals', () => {
  assert.deepEqual(spans('a **b *c*** d'), [{ text: 'a ' }, { text: 'b ', b: true }, { text: 'c', b: true, i: true }, { text: ' d' }]);
  assert.deepEqual(spans('2 * 3'), [{ text: '2 * 3' }], 'a lone star stays a star');
  assert.deepEqual(spans('snake_case_name'), [{ text: 'snake_case_name' }]);
  assert.deepEqual(spans('_it_ and \\*no\\*'), [{ text: 'it', i: true }, { text: ' and *no*' }]);
  assert.deepEqual(spans('~~x~~ <u>y</u> ==z=='), [{ text: 'x', s: true }, { text: ' ' }, { text: 'y', u: true }, { text: ' ' }, { text: 'z', hl: 'yellow' }]);
  assert.deepEqual(spans('[red]{.red} [both]{.blue .hl-green} [no]{.nope}'), [{ text: 'red', color: 'red' }, { text: ' ' }, { text: 'both', color: 'blue', hl: 'green' }, { text: ' no' }]);
  assert.deepEqual(spans('see [site](https://x.io/a_b) now'), [{ text: 'see ' }, { text: 'site', link: 'https://x.io/a_b' }, { text: ' now' }]);
  assert.deepEqual(spans('a [ b'), [{ text: 'a [ b' }]);
});

test('blocks: headings, lists, tasks, quotes, numbering', () => {
  const b = parseMarkdown('# Title\n- one\n  - two\n- [x] done\n- [ ] todo\n3. c\n4. d\n> said\n\nplain');
  assert.deepEqual(b.map((x) => [x.type, x.level, x.n ?? x.checked ?? null]), [
    ['h1', 0, null], ['ul', 0, null], ['ul', 1, null], ['task', 0, true], ['task', 0, false], ['ol', 0, 3], ['ol', 0, 4], ['quote', 0, null], ['p', 0, null], ['p', 0, null],
  ]);
  assert.equal(plainText('# T\n**b** [x]{.red}'), 'T\nb x');
});

test('round trip: markdown → blocks → markdown → blocks', () => {
  const samples = [
    '# Head **bold**\nText with *it* and ~~gone~~ and <u>under</u>.',
    'Mixed **b *bi* b** end',
    '- [ ] buy [paint](https://shop.example/p?q=1)\n  - nested ==mark==\n1. one\n2. two',
    '> quoted [warm]{.orange .hl-yellow} light',
    'literal \\*stars\\* and \\[brackets\\] and a_b',
    '\\# not a heading\n\\- not a list\n\\1. not numbered',
    '[[red link]{.red}](https://x.io)',
    'a <u>b</u> and the text <u> alone',
  ];
  for (const md of samples) {
    const b1 = parseMarkdown(md);
    const md2 = toMarkdown(b1);
    assert.deepEqual(parseMarkdown(md2), b1, `round trip of:\n${md}\n→\n${md2}`);
  }
});

test('writing blocks made by an editor', () => {
  const md = toMarkdown([
    { type: 'p', level: 0, spans: [{ text: 'a ' }, { text: 'b', b: true }, { text: 'c', b: true, i: true }, { text: ' 2*3=6', hl: 'yellow' }] },
    { type: 'p', level: 0, spans: [{ text: '# hash' }] },
    { type: 'task', level: 1, checked: true, spans: [{ text: 'ok', color: 'green' }] },
    { type: 'p', level: 0, spans: [{ text: 'x == y and ~~ and _under_score' }] },
  ]);
  const back = parseMarkdown(md);
  assert.deepEqual(back[0].spans, [{ text: 'a ' }, { text: 'b', b: true }, { text: 'c', b: true, i: true }, { text: ' 2*3=6', hl: 'yellow' }]);
  assert.deepEqual(back[1].spans, [{ text: '# hash' }]);
  assert.equal(back[2].type, 'task');
  assert.deepEqual(back[2].spans, [{ text: 'ok', color: 'green' }]);
  assert.deepEqual(back[3].spans, [{ text: 'x == y and ~~ and _under_score' }]);
});

test('toggleTask ticks one checklist line', async () => {
  const { toggleTask } = await import('../src/core/markdown.js');
  assert.equal(toggleTask('a\n- [ ] b\n  - [x] c', 1), 'a\n- [x] b\n  - [x] c');
  assert.equal(toggleTask('a\n- [ ] b\n  - [x] c', 2), 'a\n- [ ] b\n  - [ ] c');
  assert.equal(toggleTask('a\n- b', 1), 'a\n- b');
});

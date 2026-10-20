import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, toMarkdown, parseInline, plainText, merge } from '../src/core/markdown.js';

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

const p = (spans) => [{ type: 'p', level: 0, spans }];

test('marks written back: the longer run opens first, overlapping runs read back', () => {
  const warm = [{ text: 'Warm', b: true, i: true }, { text: ' key light', i: true }];
  assert.equal(toMarkdown(p(warm)), '***Warm** key light*');
  assert.deepEqual(parseInline('***Warm** key light*'), warm);
  const overlap = [{ text: 'a', b: true }, { text: 'b', b: true, i: true }, { text: 'c', i: true }];
  assert.deepEqual(parseMarkdown(toMarkdown(p(overlap)))[0].spans, overlap);
  // every mix of bold / italic / strike / underline / highlight over a few spans
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sorted = (spans) => spans.map((s) => Object.fromEntries(Object.entries(s).sort()));
  for (let n = 0; n < 3000; n++) {
    const spans = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
      const s = { text: ['a', 'b c', ' x ', 'Warm'][Math.floor(rnd() * 4)] };
      for (const k of ['b', 'i', 's', 'u', 'hl']) if (rnd() < 0.4) s[k] = k === 'hl' ? 'yellow' : true;
      return s;
    });
    const md = toMarkdown(p(spans));
    assert.deepEqual(sorted(parseMarkdown(md)[0].spans), sorted(merge(spans)), `${JSON.stringify(spans)} → ${md}`);
  }
});

test('links with brackets or spaces stay links; literal stars, tildes and indents stay text', () => {
  const md = toMarkdown(p([{ text: 'Mercury', link: 'https://en.wikipedia.org/wiki/Mercury_(planet)' }, { text: ' and ' }, { text: 'site', link: 'https://x.io/a b' }]));
  assert.equal(md, '[Mercury](https://en.wikipedia.org/wiki/Mercury_%28planet%29) and [site](https://x.io/a%20b)');
  assert.deepEqual(parseInline(md), [{ text: 'Mercury', link: 'https://en.wikipedia.org/wiki/Mercury_%28planet%29' }, { text: ' and ' }, { text: 'site', link: 'https://x.io/a%20b' }]);
  for (const spans of [
    [{ text: '*aa' }, { text: 'b', i: true }],
    [{ text: 'a~' }, { text: 'b', s: true }, { text: '~' }],
    [{ text: 'x=' }, { text: 'y', hl: 'yellow' }],
    [{ text: '  - not a list' }],
    [{ text: ' 1. not numbered' }],
    [{ text: '   ' }, { text: ' x', i: true }],
  ]) assert.deepEqual(parseMarkdown(toMarkdown(p(spans)))[0], p(merge(spans))[0], JSON.stringify(spans));
});

test('toggleTask ticks one checklist line', async () => {
  const { toggleTask } = await import('../src/core/markdown.js');
  assert.equal(toggleTask('a\n- [ ] b\n  - [x] c', 1), 'a\n- [x] b\n  - [x] c');
  assert.equal(toggleTask('a\n- [ ] b\n  - [x] c', 2), 'a\n- [ ] b\n  - [ ] c');
  assert.equal(toggleTask('a\n- b', 1), 'a\n- b');
});

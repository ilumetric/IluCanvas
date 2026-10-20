// The text of notes and shapes: a small Markdown subset, parsed into blocks
// for layout and written back from them. No DOM; the CLI uses it too.
//
// Every line is one block (a paragraph, a heading, a list item…): pressing
// Enter in a note makes a new line, exactly as in the file.
//
//   # ## ###            headings
//   - item  * item      bullet list (2 spaces of indent per level)
//   1. item             numbered list
//   - [ ] / - [x] task  checklist
//   > text              quote
//   **bold** *italic* _italic_ ~~strike~~ <u>underline</u>
//   ==highlight==       (yellow)
//   [text]{.red}        text colour;  [text]{.hl-green}  highlight colour (both: {.red .hl-green})
//   [text](https://…)   link
//   \*                  a literal character
//
// Block: { type: 'p'|'h1'|'h2'|'h3'|'quote'|'ul'|'ol'|'task', level, checked?, n?, spans }
// Span:  { text, b?, i?, u?, s?, hl?, color?, link? }   (hl / color: a MARK_COLORS name)

export const MARK_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink', 'grey'];
const FLAGS = ['b', 'i', 's', 'u'];

// ---- parse --------------------------------------------------------------------------------

/** Markdown text → blocks (never empty: an empty text is one empty paragraph). */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = lines.map(parseLine);
  // numbered lists count on from their first number, per level
  const counters = [];
  for (const b of blocks) {
    if (b.type !== 'ol') { if (b.type !== 'ul' && b.type !== 'task') counters.length = 0; continue; }
    counters.length = b.level + 1;
    counters[b.level] = counters[b.level] === undefined ? b.n : counters[b.level] + 1;
    b.n = counters[b.level];
  }
  return blocks;
}

function parseLine(line) {
  let m = line.match(/^(#{1,3}) (.*)$/);
  if (m) return { type: `h${m[1].length}`, level: 0, spans: parseInline(m[2]) };
  m = line.match(/^> ?(.*)$/);
  if (m) return { type: 'quote', level: 0, spans: parseInline(m[1]) };
  m = line.match(/^( *)[-*+] \[( |x|X)\] (.*)$/) || line.match(/^( *)[-*+] \[( |x|X)\]$/);
  if (m) return { type: 'task', level: indent(m[1]), checked: m[2] !== ' ', spans: parseInline(m[3] ?? '') };
  m = line.match(/^( *)[-*+] (.*)$/);
  if (m) return { type: 'ul', level: indent(m[1]), spans: parseInline(m[2]) };
  m = line.match(/^( *)(\d{1,6})[.)] (.*)$/);
  if (m) return { type: 'ol', level: indent(m[1]), n: Number(m[2]), spans: parseInline(m[3]) };
  return { type: 'p', level: 0, spans: parseInline(line.replace(/^\\(?=[#>\-*+]|\d+[.)] )/, '')) };
}

const indent = (s) => Math.min(4, Math.floor(s.length / 2));

/** Inline Markdown → spans. Delimiters only count when they have a partner. */
export function parseInline(src, base = {}) {
  const out = [];
  const marks = { ...base };
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out.push(clean({ text: buf, ...marks }));
    buf = '';
  };
  const toggle = (k, v = true) => { flush(); if (marks[k]) delete marks[k]; else marks[k] = v; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === '\\' && i + 1 < src.length && /[\\*_~=[\]()<>{}#.+-]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (rest.startsWith('**') && (marks.b || src.indexOf('**', i + 2) > i + 2)) { toggle('b'); i += 2; continue; }
    if (rest.startsWith('~~') && (marks.s || src.indexOf('~~', i + 2) > i + 2)) { toggle('s'); i += 2; continue; }
    if (rest.startsWith('==') && (marks.hl === 'yellow' || (!marks.hl && src.indexOf('==', i + 2) > i + 2))) { toggle('hl', 'yellow'); i += 2; continue; }
    if (rest.startsWith('<u>') && src.indexOf('</u>', i + 3) > i + 3) { flush(); marks.u = true; i += 3; continue; }
    if (rest.startsWith('</u>') && marks.u) { flush(); delete marks.u; i += 4; continue; }
    if (c === '*' && src[i + 1] !== '*' && (marks.i || hasCloser(src, i, '*'))) { toggle('i'); i += 1; continue; }
    if (c === '_' && (marks.i ? !/\w/.test(src[i + 1] || '') : !/\w/.test(src[i - 1] || '') && hasCloser(src, i, '_'))) { toggle('i'); i += 1; continue; }
    if (c === '[') {
      const close = matchBracket(src, i);
      if (close > 0) {
        const inner = src.slice(i + 1, close);
        const after = src.slice(close + 1);
        let m = after.match(/^\(([^()\s]+)\)/);
        if (m) {
          flush();
          out.push(...parseInline(inner, { ...marks, link: m[1] }));
          i = close + 1 + m[0].length;
          continue;
        }
        m = after.match(/^\{((?:\s*\.[\w-]+)+)\s*\}/);
        if (m) {
          const extra = {};
          for (const cls of m[1].trim().split(/\s+/)) {
            const name = cls.slice(1);
            if (name.startsWith('hl-') && MARK_COLORS.includes(name.slice(3))) extra.hl = name.slice(3);
            else if (MARK_COLORS.includes(name)) extra.color = name;
          }
          flush();
          out.push(...parseInline(inner, { ...marks, ...extra }));
          i = close + 1 + m[0].length;
          continue;
        }
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return merge(out);
}

function hasCloser(src, i, ch) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === ch && (ch !== '*' || src[j + 1] !== '*') && j > i + 1) return ch !== '_' || !/\w/.test(src[j + 1] || '');
  }
  return false;
}

function matchBracket(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) return j;
  }
  return -1;
}

function clean(span) {
  const s = { text: span.text };
  for (const k of [...FLAGS, 'hl', 'color', 'link']) if (span[k]) s[k] = span[k];
  return s;
}

const sameMarks = (a, b) => FLAGS.every((k) => !!a[k] === !!b[k]) && a.hl === b.hl && a.color === b.color && a.link === b.link;

/** Join neighbours with the same marks; drop empty spans. */
export function merge(spans) {
  const out = [];
  for (const s of spans) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// ---- write ---------------------------------------------------------------------------------

const escapeText = (t) => t.replace(/([\\*[\]~=<_])/g, (m, c, off, all) => {
  if (c === '~' || c === '=') return all[off + 1] === c || all[off - 1] === c ? `\\${c}` : c;
  if (c === '<') return /^<\/?u>/.test(all.slice(off, off + 4)) ? `\\${c}` : c;
  if (c === '_') return /\w/.test(all[off - 1] || '') && /\w/.test(all[off + 1] || '') ? c : `\\${c}`;
  return `\\${c}`;
});

/** Spans → inline Markdown. Marks open and close around runs like a stack, so nesting stays valid. */
export function inlineToMarkdown(spans) {
  let out = '';
  // runs of spans that share link / colour / non-yellow highlight become one [..]{} or [..]() group
  const key = (s) => `${s.link || ''}|${s.color || ''}|${s.hl && s.hl !== 'yellow' ? s.hl : ''}`;
  for (let i = 0; i < spans.length;) {
    let j = i;
    while (j < spans.length && key(spans[j]) === key(spans[i])) j++;
    const group = spans.slice(i, j);
    const inner = marksToMarkdown(group);
    const g = group[0];
    const classes = [g.color ? `.${g.color}` : '', g.hl && g.hl !== 'yellow' ? `.hl-${g.hl}` : ''].filter(Boolean);
    if (g.link) out += `[${classes.length ? `[${inner}]{${classes.join(' ')}}` : inner}](${g.link})`;
    else if (classes.length) out += `[${inner}]{${classes.join(' ')}}`;
    else out += inner;
    i = j;
  }
  return out;
}

const OPEN = { b: '**', i: '*', s: '~~', u: '<u>', hl: '==' };
const CLOSE = { b: '**', i: '*', s: '~~', u: '</u>', hl: '==' };
const ORDER = ['hl', 'u', 's', 'b', 'i'];

function marksToMarkdown(spans) {
  let out = '';
  const stack = [];
  const has = (s, k) => (k === 'hl' ? s.hl === 'yellow' : !!s[k]);
  for (const s of spans) {
    // close down to the first mark this span does not have
    let keep = 0;
    while (keep < stack.length && has(s, stack[keep])) keep++;
    for (let k = stack.length - 1; k >= keep; k--) out += CLOSE[stack[k]];
    stack.length = keep;
    for (const k of ORDER) if (has(s, k) && !stack.includes(k)) { out += OPEN[k]; stack.push(k); }
    out += escapeText(s.text);
  }
  for (let k = stack.length - 1; k >= 0; k--) out += CLOSE[stack[k]];
  return out;
}

/** Blocks → Markdown text. */
export function toMarkdown(blocks) {
  return blocks.map((b) => {
    const text = inlineToMarkdown(b.spans || []);
    const pad = '  '.repeat(b.level || 0);
    switch (b.type) {
      case 'h1': return `# ${text}`;
      case 'h2': return `## ${text}`;
      case 'h3': return `### ${text}`;
      case 'quote': return `> ${text}`;
      case 'ul': return `${pad}- ${text}`;
      case 'ol': return `${pad}${b.n || 1}. ${text}`;
      case 'task': return `${pad}- [${b.checked ? 'x' : ' '}] ${text}`;
      default: return /^([#>]|[-*+] |\d+[.)] )/.test(text) ? `\\${text}` : text;
    }
  }).join('\n');
}

/** Tick or untick the checklist item on line `index`; returns the new text (unchanged if not a task). */
export function toggleTask(text, index) {
  const lines = String(text).split('\n');
  const m = lines[index]?.match(/^( *[-*+] \[)( |x|X)(\].*)$/);
  if (!m) return text;
  lines[index] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`;
  return lines.join('\n');
}

/** The words only (search, `ls`, previews). */
export function plainText(text) {
  return parseMarkdown(text).map((b) => b.spans.map((s) => s.text).join('')).join('\n');
}

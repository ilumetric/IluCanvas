// Editing a note's text: a contentEditable layer laid exactly over the note
// (same font, sizes, line height, indents as text.js draws), scaled with the
// board. HTML ↔ blocks ↔ Markdown, so the file only ever holds Markdown.
//
// Formatting comes from the browser's editing commands (bold, lists, colours…);
// reading the result back looks at tags and inline styles, so whatever markup a
// command produces maps onto our small set of marks.

import { parseMarkdown, toMarkdown, merge, MARK_COLORS } from '../core/markdown.js';
import { layoutNote, notePad, noteFont, textFrame, alignOf, NOTE_BG, MARK_ON_LIGHT, MARK_ON_DARK, HIGHLIGHT, INK_TEXT, HEAD, INDENT, LINE, isLight } from './text.js';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- blocks → HTML ------------------------------------------------------------------------------

function spansToHtml(spans, light) {
  const colors = light ? MARK_ON_LIGHT : MARK_ON_DARK;
  return spans.map((s) => {
    let h = esc(s.text);
    if (s.s) h = `<s>${h}</s>`;
    if (s.u) h = `<u>${h}</u>`;
    if (s.i) h = `<i>${h}</i>`;
    if (s.b) h = `<b>${h}</b>`;
    // colours as plain styled spans: the browser's colour commands (and Clear) change the style
    if (s.hl) h = `<span style="background-color:${HIGHLIGHT[s.hl]}">${h}</span>`;
    if (s.color) h = `<span style="color:${colors[s.color]}">${h}</span>`;
    if (s.link) h = `<a href="${esc(s.link)}">${h}</a>`;
    return h;
  }).join('') || '<br>';
}

export function blocksToHtml(blocks, light) {
  let html = '';
  const lists = []; // open list tags, by level
  const closeLists = (to) => { while (lists.length > to) html += `</li></${lists.pop()}>`; };
  let inQuote = false;
  for (const b of blocks) {
    const list = b.type === 'ul' || b.type === 'ol' || b.type === 'task';
    if (b.type !== 'quote' && inQuote) { html += '</blockquote>'; inQuote = false; }
    if (!list) closeLists(0);
    const inner = spansToHtml(b.spans, light);
    if (list) {
      const tag = b.type === 'ol' ? 'ol' : 'ul';
      const cls = b.type === 'task' ? ' class="tasks"' : '';
      const want = `${tag}${cls}`;
      const level = Math.min(b.level, lists.length);
      if (lists.length > level + 1) closeLists(level + 1);
      if (lists.length === level + 1 && lists[level] !== want) closeLists(level);
      if (lists.length === level + 1) html += '</li>';
      while (lists.length < level + 1) {
        // a numbered list keeps its first number ("5. five" stays 5)
        const start = b.type === 'ol' && lists.length === level && Number.isInteger(b.n) && b.n !== 1 ? ` start="${b.n}"` : '';
        html += `<${want}${start}>`;
        lists.push(want);
      }
      html += `<li${b.type === 'task' ? ` data-checked="${b.checked ? 'true' : 'false'}"` : ''}>${inner}`;
      continue;
    }
    if (b.type === 'quote') { if (!inQuote) { html += '<blockquote>'; inQuote = true; } html += `<div>${inner}</div>`; continue; }
    if (HEAD[b.type]) html += `<${b.type}>${inner}</${b.type}>`;
    else html += `<div>${inner}</div>`;
  }
  closeLists(0);
  if (inQuote) html += '</blockquote>';
  return html.replace(/<(ul|ol)( class="tasks")?>/g, '<$1$2>');
}

// ---- HTML → blocks ------------------------------------------------------------------------------

const parseRgb = (c) => {
  const m = String(c).match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  const h = String(c).match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i);
  return h ? { r: parseInt(h[1], 16), g: parseInt(h[2], 16), b: parseInt(h[3], 16), a: 1 } : null;
};
/** The name of the closest colour in `pairs` ([name | null, colour]); null = "no colour". */
function nearest(color, pairs) {
  const c = parseRgb(color);
  if (!c || c.a === 0) return null;
  let best = null;
  let bd = Infinity;
  for (const [name, v] of pairs) {
    const t = parseRgb(v);
    const d = (t.r - c.r) ** 2 + (t.g - c.g) ** 2 + (t.b - c.b) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
// text colours on light and dark paper, and the plain ink colours meaning "no colour"
const TEXT_PAIRS = [
  ...MARK_COLORS.map((n) => [n, MARK_ON_LIGHT[n]]), ...MARK_COLORS.map((n) => [n, MARK_ON_DARK[n]]),
  ...[INK_TEXT, '#000000', '#ffffff', '#f4f4f6', '#e9e9eb', '#fbeef5'].map((c) => [null, c]),
];
const HL_PAIRS = MARK_COLORS.map((n) => [n, HIGHLIGHT[n]]);

function marksOf(el, m) {
  const tag = el.tagName;
  const st = el.style || {};
  const n = { ...m };
  if (tag === 'B' || tag === 'STRONG' || Number(st.fontWeight) >= 600 || st.fontWeight === 'bold') n.b = true;
  if (st.fontWeight === 'normal' || Number(st.fontWeight) === 400) delete n.b;
  if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') n.i = true;
  const deco = `${st.textDecoration || ''} ${st.textDecorationLine || ''}`;
  if (tag === 'U' || /underline/.test(deco)) n.u = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(deco)) n.s = true;
  if (tag === 'A' && el.getAttribute('href')) n.link = el.getAttribute('href');
  // colours: the inline style first (recolouring, removing a colour and Clear change it);
  // data-* and <mark> only from older markup
  if (st.backgroundColor) { const h = nearest(st.backgroundColor, HL_PAIRS); if (h) n.hl = h; else delete n.hl; }
  else if (el.dataset?.hl && MARK_COLORS.includes(el.dataset.hl)) n.hl = el.dataset.hl;
  else if (tag === 'MARK') n.hl = 'yellow';
  const c = st.color || (tag === 'FONT' && el.getAttribute('color'));
  if (c) { const name = nearest(c, TEXT_PAIRS); if (name) n.color = name; else delete n.color; }
  else if (el.dataset?.color && MARK_COLORS.includes(el.dataset.color)) n.color = el.dataset.color;
  return n;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE']);

/** Inline content of a node → lines of spans (BR splits lines, and so does a "\n": Shift+Enter in pre-wrap text). Nested blocks are skipped. */
function inlineLines(node, marks, out = [[]]) {
  for (const ch of node.childNodes) {
    if (ch.nodeType === 3) {
      ch.nodeValue.replace(/\u00a0/g, ' ').split('\n').forEach((text, k) => {
        if (k) out.push([]);
        out[out.length - 1].push({ text, ...marks });
      });
      continue;
    }
    if (ch.nodeType !== 1) continue;
    if (ch.tagName === 'BR') { out.push([]); continue; }
    if (BLOCK_TAGS.has(ch.tagName)) continue;
    inlineLines(ch, marksOf(ch, marks), out);
  }
  return out;
}

const hasBlockChild = (el) => [...el.children].some((c) => BLOCK_TAGS.has(c.tagName));

export function htmlToBlocks(root) {
  const blocks = [];
  const pushLines = (lines, make) => {
    // a trailing BR at the end of a block is the browser's placeholder, not a line
    if (lines.length > 1 && !lines[lines.length - 1].some((s) => s.text)) lines.pop();
    for (const spans of lines) blocks.push({ ...make(), spans: merge(spans.map(clean)) });
  };
  const walk = (el, ctx) => {
    let loose = [];
    const flushLoose = () => {
      if (!loose.length) return;
      const tmp = document.createElement('div');
      for (const n of loose) tmp.append(n.cloneNode(true));
      pushLines(inlineLines(tmp, {}), () => ({ type: ctx.quote ? 'quote' : 'p', level: 0 }));
      loose = [];
    };
    for (const ch of [...el.childNodes]) {
      // text, inline elements and BRs between blocks are one run of lines (a list turned off
      // leaves "<span>a</span><br><span>b</span>": two lines, not three)
      if (ch.nodeType === 3 || (ch.nodeType === 1 && !BLOCK_TAGS.has(ch.tagName))) { if (ch.nodeType === 1 || ch.nodeValue.trim() || loose.length) loose.push(ch); continue; }
      flushLoose();
      if (ch.nodeType !== 1) continue;
      const tag = ch.tagName;
      if (tag === 'BLOCKQUOTE') { walk(ch, { ...ctx, quote: true }); continue; }
      if (tag === 'UL' || tag === 'OL') {
        const level = ctx.level ?? 0;
        const tasks = ch.classList.contains('tasks');
        const start = tag === 'OL' && Number.isInteger(ch.start) ? ch.start : 1; // a numbered list may start at any number
        for (const li of ch.children) {
          if (li.tagName !== 'LI') { if (li.tagName === 'UL' || li.tagName === 'OL') walk({ childNodes: [li] }, { ...ctx, level: level + 1 }); continue; }
          const task = tasks || li.hasAttribute('data-checked');
          const lines = inlineLines(li, {});
          pushLines(lines.length ? lines : [[]], () => (task ? { type: 'task', level, checked: li.dataset.checked === 'true' } : tag === 'OL' ? { type: 'ol', level, n: start } : { type: 'ul', level }));
          for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') walk({ childNodes: [sub] }, { ...ctx, level: level + 1 });
        }
        continue;
      }
      if (/^H[1-6]$/.test(tag)) { pushLines(inlineLines(ch, {}), () => ({ type: `h${Math.min(3, Number(tag[1]))}`, level: 0 })); continue; }
      if (hasBlockChild(ch)) { walk(ch, ctx); continue; }
      pushLines(inlineLines(ch, {}), () => ({ type: ctx.quote ? 'quote' : 'p', level: 0 }));
    }
    flushLoose();
  };
  walk(root, {});
  // numbered lists count on from their first number (as parseMarkdown does)
  const counters = [];
  for (const b of blocks) {
    if (b.type !== 'ol') { if (b.type !== 'ul' && b.type !== 'task') counters.length = 0; continue; }
    counters.length = b.level + 1;
    counters[b.level] = counters[b.level] === undefined ? b.n : counters[b.level] + 1;
    b.n = counters[b.level];
  }
  return blocks.length ? blocks : [{ type: 'p', level: 0, spans: [] }];
}

function clean(s) {
  const o = { text: s.text };
  for (const k of ['b', 'i', 'u', 's', 'hl', 'color', 'link']) if (s[k]) o[k] = s[k];
  return o;
}

const LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * A link that may be set or opened: http, https or mailto (a bare address
 * such as "example.com" gets https://). Null for anything else (javascript:,
 * data:, file:…) — files come from other people.
 */
export function safeLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // "localhost:8080" is a host and a port, not a scheme
  const url = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(url);
    if (!LINK_SCHEMES.includes(u.protocol)) return null;
    return /\s/.test(url) ? u.href : url;
  } catch { return null; }
}

// ---- the editor ---------------------------------------------------------------------------------------

export class NoteEditor {
  /**
   * board: Board; layer: the element the editor lives in;
   * onClose(id, text | null): null when nothing changed; onChange(): formatting state may have changed;
   * onTab(back): Tab in a table cell (the next cell)
   */
  constructor({ board, layer, onClose, onChange, onTab }) {
    this.board = board;
    this.onTab = onTab;
    this.layer = layer;
    this.onClose = onClose;
    this.onChange = onChange;
    this.el = null;
    this.item = null;
    document.addEventListener('selectionchange', () => { if (this.el && this.el.contains(document.getSelection()?.anchorNode)) this.onChange?.(); });
  }

  get id() { return this.item?.id ?? null; }

  open(item, { select = 'end' } = {}) {
    if (this.el) this.close();
    this.item = item;
    const el = document.createElement('div');
    el.className = 'note-editor';
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.innerHTML = blocksToHtml(parseMarkdown(item.text), isLight(item));
    this.original = toMarkdown(htmlToBlocks(el));
    this.el = el;
    this.layer.append(el);
    this.#style();
    this.reposition();
    el.addEventListener('input', (e) => this.#input(e));
    el.addEventListener('keydown', (e) => this.#key(e));
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = e.clipboardData.getData('text/plain');
      if (t) document.execCommand('insertText', false, t);
    });
    el.addEventListener('click', (e) => {
      const li = e.target.closest?.('li');
      if (li && li.closest('ul.tasks, li[data-checked]') && e.clientX < li.getBoundingClientRect().left) {
        li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
        this.#refit();
      }
      const a = e.target.closest?.('a');
      const url = a && (e.ctrlKey || e.metaKey) && safeLink(a.getAttribute('href'));
      if (url) window.open(url, '_blank', 'noopener');
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => { if (!e.ctrlKey) e.stopPropagation(); }, { passive: true });
    el.focus();
    const r = document.createRange();
    if (select === 'all') r.selectNodeContents(el);
    else { r.selectNodeContents(el); r.collapse(false); }
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    this.board.editingId = item.id;
    this.board.invalidate();
    this.onChange?.();
  }

  /** The note changed outside (style, size, colour): restyle without losing the text. */
  update(item) {
    if (!this.el || item.id !== this.item.id) return;
    this.item = item;
    this.#style();
    this.reposition();
  }

  markdown() { return this.el ? toMarkdown(htmlToBlocks(this.el)) : null; }

  close({ commit = true } = {}) {
    if (!this.el) return;
    const md = this.markdown();
    const id = this.item.id;
    this.el.remove();
    this.el = null;
    this.item = null;
    this.board.editingId = null;
    this.board.invalidate();
    this.onClose?.(id, commit && md !== this.original ? md : null);
  }

  #family() { return this.board.theme.font; }

  #style() {
    const it = this.item;
    const el = this.el;
    const light = isLight(it);
    const f = textFrame(it);
    const shape = it.type === 'shape';
    el.style.setProperty('--family', this.#family());
    el.style.setProperty('--ink', light ? INK_TEXT : this.board.theme.text);
    el.style.setProperty('--pad', `${notePad(it)}px`);
    el.style.setProperty('--line', LINE);
    el.style.setProperty('--indent', `${INDENT}em`);
    el.style.paddingLeft = `${f.x}px`;
    el.style.paddingRight = `${Math.max(0, it.w - f.x - f.w)}px`;
    el.style.paddingBottom = `${Math.max(0, it.h - f.y - f.h)}px`;
    el.style.background = shape ? 'transparent' : NOTE_BG[it.color] || 'transparent';
    el.style.textAlign = alignOf(it);
    el.style.overflow = shape ? 'visible' : '';
    el.dataset.light = light ? '1' : '0';
    el.style.width = `${it.w}px`;
    if (it.fit || shape) { el.style.height = `${it.h}px`; el.style.minHeight = ''; } else { el.style.height = ''; el.style.minHeight = `${it.h}px`; }
    this.#refit();
  }

  /** Font size (fit notes shrink as you type) and vertical position (stickies, shapes), from the canvas layout. */
  #refit() {
    const it = this.item;
    if (!this.el) return;
    const L = layoutNote({ ...it, text: this.markdown() }, this.#family());
    this.el.style.setProperty('--F', `${it.fit && it.type === 'note' ? L.F : noteFont(it)}px`);
    this.el.style.paddingTop = `${L.offsetY}px`;
  }

  reposition() {
    if (!this.el) return;
    const { x, y, z } = this.board.view;
    const it = this.item;
    const turn = it.rot ? ` translate(${it.w / 2}px, ${it.h / 2}px) rotate(${it.rot}deg) translate(${-it.w / 2}px, ${-it.h / 2}px)` : '';
    this.el.style.transform = `translate(${it.x * z + x}px, ${it.y * z + y}px) scale(${z})${turn}`;
  }

  #input(e) {
    // Markdown shortcuts at the start of a line: "# ", "- ", "1. ", "[ ] ", "> "
    // (after the event: the browser refuses editing commands nested inside another one)
    if (e.inputType === 'insertText' && e.data === ' ') setTimeout(() => { if (this.el) { this.#shortcut(); this.#refit(); } });
    if (e.inputType === 'insertParagraph') this.#untickNew();
    this.#refit();
    this.onChange?.();
  }

  /** Enter in a ticked task: the browser copies the tick into the new, empty item — a new task starts unticked. */
  #untickNew() {
    const n = document.getSelection()?.anchorNode;
    const li = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('li');
    if (!li || !this.el.contains(li)) return;
    // its own text (not that of the items nested in it)
    const empty = (x) => x?.tagName === 'LI' && ![...x.childNodes].some((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)) && c.textContent.trim());
    // Enter at the end: the caret is in the new item; at the start: the new item is the one above
    for (const x of [li, li.previousElementSibling]) if (empty(x) && x.dataset.checked === 'true') x.dataset.checked = 'false';
  }

  #shortcut() {
    const sel = document.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return;
    const node = sel.anchorNode;
    const block = (node.nodeType === 1 ? node : node.parentElement)?.closest('div, h1, h2, h3, li, p');
    if (!block || !this.el.contains(block)) return;
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(sel.anchorNode, sel.anchorOffset);
    const typed = pre.toString().replace(/ /g, ' ');
    const m = typed.match(/^(#{1,3}|[-*+]|1[.)]|\[ ?\]|\[x\]|>) $/);
    if (!m) return;
    sel.removeAllRanges();
    sel.addRange(pre);
    document.execCommand('delete');
    const k = m[1];
    if (k.startsWith('#')) this.command('block', `h${k.length}`);
    else if (k === '>') this.command('block', 'quote');
    else if (k.startsWith('1')) this.command('list', 'ol');
    else if (k.startsWith('[')) this.command('list', 'task', k === '[x]');
    else this.command('list', 'ul');
  }

  #key(e) {
    // typing through an IME (Japanese, Chinese…): its Escape, Enter and Tab are its own
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.close(); return; }
    if (e.key === 'Tab' && this.item?.type === 'cell' && this.onTab) { e.preventDefault(); e.stopPropagation(); this.onTab(e.shiftKey); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (document.getSelection().anchorNode?.parentElement?.closest('li')) document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && e.shiftKey && k === 'x') { e.preventDefault(); this.command('strike'); }
    if (mod && e.shiftKey && k === 'h') { e.preventDefault(); this.command('highlight', 'yellow'); }
    // Ctrl+S / Ctrl+O are the app's (save, open), not the browser's dialogs
    if (mod && !e.altKey && (k === 's' || k === 'o')) return;
    e.stopPropagation();
  }

  /** Formatting: bold italic underline strike · block (p h1 h2 h3 quote) · list (ul ol task) · color · highlight · link · clear */
  command(name, value, extra) {
    if (!this.el) return;
    this.el.focus();
    document.execCommand('styleWithCSS', false, name === 'color' || name === 'highlight');
    const light = isLight(this.item);
    switch (name) {
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'underline': document.execCommand('underline'); break;
      case 'strike': document.execCommand('strikeThrough'); break;
      case 'block': {
        if (this.#currentList()) document.execCommand(this.#currentList().tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
        const cur = this.state().block;
        const target = value === 'quote' ? 'BLOCKQUOTE' : value === 'p' || cur === value ? 'DIV' : value.toUpperCase();
        if (cur === 'quote' && value === 'quote') document.execCommand('outdent');
        document.execCommand('formatBlock', false, target);
        break;
      }
      case 'list': {
        const list = this.#currentList();
        const isTasks = list?.classList.contains('tasks');
        if (value === 'task') {
          if (list && isTasks) { document.execCommand('insertUnorderedList'); break; }
          if (!list || list.tagName === 'OL') document.execCommand('insertUnorderedList');
          const ul = this.#currentList();
          if (ul) { ul.classList.add('tasks'); for (const li of ul.children) if (li.tagName === 'LI' && !li.dataset.checked) li.dataset.checked = extra ? 'true' : 'false'; }
        } else if (value === 'ul' && isTasks) {
          list.classList.remove('tasks');
          for (const li of list.children) delete li.dataset.checked;
        } else document.execCommand(value === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
        break;
      }
      case 'color': document.execCommand('foreColor', false, value ? (light ? MARK_ON_LIGHT : MARK_ON_DARK)[value] : (light ? INK_TEXT : this.board.theme.text)); break;
      case 'highlight': document.execCommand('hiliteColor', false, value ? HIGHLIGHT[value] : 'transparent'); break;
      case 'link': {
        if (value) document.execCommand('createLink', false, value); else document.execCommand('unlink');
        break;
      }
      case 'clear': document.execCommand('removeFormat'); document.execCommand('unlink'); break;
      default:
    }
    this.#refit();
    this.onChange?.();
  }

  #currentList() {
    const n = document.getSelection()?.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const list = el?.closest?.('ul, ol');
    return list && this.el.contains(list) ? list : null;
  }

  /** What the caret is in: { bold, italic, underline, strike, block, list } for the format bar. */
  state() {
    if (!this.el) return {};
    const n = document.getSelection()?.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const inside = el && this.el.contains(el);
    const h = inside ? el.closest('h1, h2, h3, blockquote') : null;
    const list = inside ? this.#currentList() : null;
    const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
    return {
      bold: q('bold'), italic: q('italic'), underline: q('underline'), strike: q('strikeThrough'),
      block: h ? (h.tagName === 'BLOCKQUOTE' ? 'quote' : h.tagName.toLowerCase()) : 'p',
      list: list ? (list.classList.contains('tasks') ? 'task' : list.tagName === 'OL' ? 'ol' : 'ul') : null,
      link: !!el?.closest?.('a'),
    };
  }
}

// Text on the canvas — notes and shapes: layout of their Markdown text
// (blocks → lines → runs, word wrap measured with the real font) and drawing.
// Layouts are cached per item object — items are immutable, so a changed note
// is a new object.
//
// The editor (editor.js) uses the same numbers (font, sizes, line height,
// indents, padding), so text does not jump when you start or stop editing.

import { parseMarkdown } from '../core/markdown.js';
import { NOTE_FONT } from '../core/ops.js';
import { shapeFrame, shapeHeightFor, darkFill } from './shapes.js';

// ---- fixed colours (do not follow the style) ---------------------------------------------------

export const NOTE_BG = {
  yellow: '#ffe58f', orange: '#ffc59a', pink: '#ffb8d6', green: '#b8ebc8',
  blue: '#acd5ff', violet: '#d5c6ff', grey: '#e2e2e6', paper: '#fbfaf7', none: null,
};
/** Text colours on light paper, and on the dark board (plain text notes). */
export const MARK_ON_LIGHT = { red: '#d9363e', orange: '#e8590c', yellow: '#b8860b', green: '#2b8a3e', blue: '#1c6fd1', violet: '#6741d9', pink: '#c2255c', grey: '#6c6f78' };
export const MARK_ON_DARK = { red: '#ff8787', orange: '#ffa94d', yellow: '#ffd43b', green: '#69db7c', blue: '#74c0fc', violet: '#b197fc', pink: '#f783ac', grey: '#adb5bd' };
export const HIGHLIGHT = {
  red: 'rgba(255,135,135,0.5)', orange: 'rgba(255,169,77,0.5)', yellow: 'rgba(255,221,87,0.65)', green: 'rgba(105,219,124,0.45)',
  blue: 'rgba(116,192,252,0.5)', violet: 'rgba(177,151,252,0.5)', pink: 'rgba(247,131,172,0.5)', grey: 'rgba(173,181,189,0.5)',
};
export const INK_TEXT = '#1f1d1a';
const LINK_LIGHT = '#1c6fd1';
const LINK_DARK = '#74c0fc';

// ---- metrics shared with the editor ---------------------------------------------------------------

export const LINE = 1.35;
export const HEAD = { h1: 1.75, h2: 1.4, h3: 1.18 };
export const INDENT = 1.5; // em per list level
export const QUOTE = 1; // em of quote indent
/** Inner padding of a note, board units. */
export const notePad = (it) => (it.color === 'none' ? 4 : Math.max(10, Math.min(40, Math.min(it.w, it.h || it.w) * 0.075)));
/** Is the text drawn on a light background (dark ink)? */
export const isLight = (it) => (it.type === 'shape' ? !darkFill(it) : it.color !== 'none');
/** Base font size of a document / text note / shape, board units. */
export const noteFont = (it) => NOTE_FONT[it.size || 'm'] * (it.scale || 1);
/** Where the text goes, relative to the item's top-left. */
export function textFrame(it) {
  if (it.type === 'shape') return shapeFrame(it);
  const p = notePad(it);
  return { x: p, y: p, w: Math.max(10, it.w - p * 2), h: Math.max(10, it.h - p * 2) };
}
/** Default alignment: centred in shapes, left in notes. */
export const alignOf = (it) => it.align || (it.type === 'shape' ? 'center' : 'left');

let measureCtx = null;
const widths = new Map();
let version = 0;
const cache = new WeakMap();

/** Forget measurements (fonts loaded, style changed). */
export function resetTextCache() { widths.clear(); version++; }

const fontOf = (st, size, family) => `${st.i ? 'italic ' : ''}${st.b || st.head ? 700 : 400} ${size}px ${family}`;

function measure(text, st, family) {
  const key = `${st.i ? 1 : 0}${st.b || st.head ? 1 : 0}|${family}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    measureCtx ||= document.createElement('canvas').getContext('2d');
    measureCtx.font = fontOf(st, 100, family);
    w = measureCtx.measureText(text).width / 100;
    if (widths.size > 60000) widths.clear();
    widths.set(key, w);
  }
  return w; // per 1px of font size
}

/**
 * Lay out a note. Returns { F, lines, marks, checks, height, offsetY } in board
 * units relative to the note's top-left; `F` is the base font size used (fit
 * notes shrink / grow it to fill the card).
 */
export function layoutNote(it, family) {
  const c = cache.get(it);
  if (c && c.v === version && c.family === family) return c.layout;
  const blocks = parseMarkdown(it.text);
  const frame = textFrame(it);
  const pad = frame.x;
  const innerW = frame.w;
  const align = alignOf(it);
  let layout;
  if (it.fit && it.type === 'note') {
    const innerH = frame.h;
    const max = Math.max(8, Math.min(it.w, it.h) * 0.2);
    let lo = 4;
    let hi = max;
    let best = flow(blocks, lo, innerW, family, align);
    if (best.height <= innerH) {
      const top = flow(blocks, hi, innerW, family, align);
      if (top.height <= innerH) best = top;
      else {
        for (let k = 0; k < 9; k++) {
          const mid = (lo + hi) / 2;
          const l = flow(blocks, mid, innerW, family, align);
          if (l.height <= innerH) { lo = mid; best = l; } else hi = mid;
        }
      }
    }
    layout = best;
    layout.offsetY = frame.y + Math.max(0, (innerH - layout.height) / 2); // stickies: centred vertically
  } else {
    layout = flow(blocks, noteFont(it), innerW, family, align);
    // shapes: centred vertically; documents: from the top
    layout.offsetY = frame.y + (it.type === 'shape' ? Math.max(0, (frame.h - layout.height) / 2) : 0);
  }
  layout.pad = pad;
  layout.total = it.type === 'shape' ? shapeHeightFor(it, layout.height) : layout.height + frame.y * 2;
  cache.set(it, { v: version, family, layout });
  return layout;
}

/** The height a document / text note needs for its text (board units). */
export const neededHeight = (it, family) => layoutNote(it, family).total;

function flow(blocks, F, maxW, family, align = 'left') {
  const lines = [];
  const marks = []; // bullets, numbers, checkboxes, quote bars
  const checks = [];
  let y = 0;
  blocks.forEach((b, bi) => {
    const k = HEAD[b.type] || 1;
    const size = F * k;
    const lh = size * LINE;
    if (HEAD[b.type] && bi > 0) y += size * 0.45;
    const list = b.type === 'ul' || b.type === 'ol' || b.type === 'task';
    const indent = list ? (b.level + 1) * INDENT * F : b.type === 'quote' ? QUOTE * F : 0;
    const width = Math.max(F, maxW - indent);
    const head = !!HEAD[b.type];
    const blockLines = wrap(b.spans, size, width, family, head);
    const top = y;
    for (const ln of blockLines) {
      const shift = !list && align !== 'left' ? (width - ln.w) * (align === 'center' ? 0.5 : 1) : 0;
      lines.push({ x: indent + shift, y, h: lh, size, base: y + lh * 0.5 + size * 0.36, runs: ln.runs, w: ln.w, block: bi, dim: b.type === 'task' && b.checked, head });
      y += lh;
    }
    if (list) {
      const cx = indent - INDENT * F * 0.55;
      const cy = top + lh * 0.5;
      if (b.type === 'task') {
        const s = F * 0.82;
        const box = { x: cx - s / 2, y: cy - s / 2, s, checked: !!b.checked, block: bi };
        marks.push({ kind: 'check', ...box });
        checks.push(box);
      } else if (b.type === 'ol') marks.push({ kind: 'num', x: indent - F * 0.35, y: top + lh * 0.5 + F * 0.36, text: `${b.n}.`, size: F });
      else marks.push({ kind: 'dot', x: cx, y: cy, r: F * (b.level % 2 ? 0.14 : 0.17), hollow: b.level % 2 === 1 });
    }
    if (b.type === 'quote') marks.push({ kind: 'bar', x: F * 0.1, y: top + lh * 0.12, w: F * 0.16, h: y - top - lh * 0.24 });
    if (head) y += size * 0.15;
  });
  return { F, lines, marks, checks, height: Math.max(y, F * LINE) };
}

/** Break spans into lines of at most `maxW`; words never split unless longer than a line. */
function wrap(spans, size, maxW, family, head) {
  // pieces: words and spaces, a word may cross spans ("he**llo**")
  const items = [];
  for (const s of spans) {
    const st = { b: s.b, i: s.i, u: s.u, s: s.s, hl: s.hl, color: s.color, link: s.link, head };
    for (const t of s.text.split(/(\s+)/)) {
      if (!t) continue;
      const space = /^\s+$/.test(t);
      const piece = { text: space ? t.replace(/\t/g, '    ') : t, st, w: measure(space ? ' '.repeat(t.length) : t, st, family) * size };
      const last = items[items.length - 1];
      if (!space && last && !last.space) { last.parts.push(piece); last.w += piece.w; } else items.push({ space, parts: [piece], w: piece.w });
    }
  }
  const lines = [];
  let cur = { runs: [], w: 0 };
  const push = () => { lines.push(cur); cur = { runs: [], w: 0 }; };
  const add = (piece) => { cur.runs.push({ ...piece, x: cur.w }); cur.w += piece.w; };
  for (const it of items) {
    if (it.space) { if (cur.runs.length) for (const p of it.parts) add(p); continue; }
    if (cur.w + it.w > maxW && cur.runs.length) {
      // drop trailing spaces, start a new line
      while (cur.runs.length && /^\s+$/.test(cur.runs[cur.runs.length - 1].text)) cur.w -= cur.runs.pop().w;
      push();
    }
    if (it.w > maxW) {
      // a word longer than the line: break it by characters
      for (const p of it.parts) {
        for (const ch of [...p.text]) {
          const w = measure(ch, p.st, family) * size;
          if (cur.w + w > maxW && cur.runs.length) push();
          const last = cur.runs[cur.runs.length - 1];
          if (last && last.st === p.st && last.x + last.w === cur.w) { last.text += ch; last.w += w; cur.w += w; } else add({ text: ch, st: p.st, w });
        }
      }
      continue;
    }
    for (const p of it.parts) add(p);
  }
  while (cur.runs.length && /^\s+$/.test(cur.runs[cur.runs.length - 1].text)) cur.w -= cur.runs.pop().w;
  lines.push(cur);
  return lines;
}

// ---- drawing --------------------------------------------------------------------------------------

/**
 * Draw a note in board coordinates (ctx already transformed). `px` = device
 * pixels per board unit; `textless` skips the text (it is being edited).
 */
export function drawNote(ctx, it, { px, theme, family, textless = false }) {
  const bg = it.type === 'shape' ? null : NOTE_BG[it.color];
  if (it.type === 'shape') { drawText(ctx, it, { px, theme, family, textless }); return; }
  const r = Math.min(it.w, it.h) * (theme.rOuter > 0 ? 0.05 : 0.012);
  if (bg) {
    // a soft drop shadow, then the paper
    const off = Math.min(it.h * 0.03, 3 / px * (devicePixelRatio || 1));
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    roundRect(ctx, it.x, it.y + off, it.w, it.h, r);
    ctx.fill();
    ctx.fillStyle = bg;
    ctx.beginPath();
    roundRect(ctx, it.x, it.y, it.w, it.h, r);
    ctx.fill();
    if (it.color === 'paper') {
      ctx.lineWidth = 1 / px * (devicePixelRatio || 1);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.stroke();
    }
  }
  if (!bg && !textless && !it.text.trim()) {
    // empty text without paper would be invisible: a dashed frame so it can be found
    ctx.save();
    const u = (devicePixelRatio || 1) / px;
    ctx.setLineDash([5 * u, 4 * u]);
    ctx.lineWidth = 1.2 * u;
    ctx.strokeStyle = theme.faint;
    ctx.strokeRect(it.x, it.y, it.w, it.h);
    ctx.restore();
  }
  drawText(ctx, it, { px, theme, family, textless, bg });
}

/** The text of a note or shape. */
export function drawText(ctx, it, { px, theme, family, textless = false, bg = null }) {
  if (textless || !it.text) return;
  const L = layoutNote(it, family);
  const light = isLight(it);
  const ink = light ? INK_TEXT : theme.text;
  const ox = it.x + L.pad;
  const oy = it.y + L.offsetY;
  const overflow = L.total > it.h + 0.5;
  if (overflow) { ctx.save(); ctx.beginPath(); ctx.rect(it.x, it.y, it.w, it.h); ctx.clip(); }
  if (L.F * px < 3.5) {
    // too small to read: grey bars where the lines are
    ctx.fillStyle = light ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.22)';
    for (const ln of L.lines) if (ln.w > 0) ctx.fillRect(ox + ln.x, oy + ln.y + ln.h * 0.3, ln.w, ln.h * 0.4);
    if (overflow) ctx.restore();
    return;
  }
  const colors = light ? MARK_ON_LIGHT : MARK_ON_DARK;
  const minLine = 1 / px * (devicePixelRatio || 1);
  ctx.textBaseline = 'alphabetic';
  // markers: bullets, numbers, checkboxes, quote bars
  for (const mk of L.marks) {
    if (mk.kind === 'dot') {
      ctx.beginPath();
      ctx.arc(ox + mk.x, oy + mk.y, mk.r, 0, Math.PI * 2);
      if (mk.hollow) { ctx.lineWidth = Math.max(minLine, mk.r * 0.45); ctx.strokeStyle = ink; ctx.stroke(); } else { ctx.fillStyle = ink; ctx.fill(); }
    } else if (mk.kind === 'num') {
      ctx.font = fontOf({}, mk.size, family);
      ctx.fillStyle = ink;
      ctx.textAlign = 'right';
      ctx.fillText(mk.text, ox + mk.x, oy + mk.y);
      ctx.textAlign = 'start';
    } else if (mk.kind === 'check') {
      const rr = mk.s * 0.22;
      ctx.beginPath();
      roundRect(ctx, ox + mk.x, oy + mk.y, mk.s, mk.s, rr);
      ctx.lineWidth = Math.max(minLine, mk.s * 0.1);
      if (mk.checked) {
        ctx.fillStyle = light ? '#2b8a3e' : '#69db7c';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ox + mk.x + mk.s * 0.24, oy + mk.y + mk.s * 0.52);
        ctx.lineTo(ox + mk.x + mk.s * 0.43, oy + mk.y + mk.s * 0.7);
        ctx.lineTo(ox + mk.x + mk.s * 0.77, oy + mk.y + mk.s * 0.3);
        ctx.strokeStyle = light ? '#fff' : '#10131a';
        ctx.lineWidth = Math.max(minLine, mk.s * 0.13);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      } else {
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (mk.kind === 'bar') {
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.3;
      ctx.fillRect(ox + mk.x, oy + mk.y, mk.w, mk.h);
      ctx.globalAlpha = 1;
    }
  }
  let font = '';
  for (const ln of L.lines) {
    if (ln.dim) ctx.globalAlpha = 0.5;
    // highlights under the text
    for (const run of ln.runs) {
      if (!run.st.hl) continue;
      ctx.fillStyle = HIGHLIGHT[run.st.hl] || HIGHLIGHT.yellow;
      ctx.fillRect(ox + ln.x + run.x, oy + ln.y + ln.h * 0.1, run.w, ln.h * 0.82);
    }
    for (const run of ln.runs) {
      const f = fontOf(run.st, ln.size, family);
      if (f !== font) { ctx.font = f; font = f; }
      const color = run.st.link ? (light ? LINK_LIGHT : LINK_DARK) : run.st.color ? colors[run.st.color] : ink;
      ctx.fillStyle = color;
      const x = ox + ln.x + run.x;
      const base = oy + ln.base;
      ctx.fillText(run.text, x, base);
      const t = Math.max(minLine, ln.size * 0.06);
      if (run.st.u || run.st.link) ctx.fillRect(x, base + ln.size * 0.12, run.w, t);
      if (run.st.s) ctx.fillRect(x, base - ln.size * 0.3, run.w, t);
    }
    if (ln.dim) ctx.globalAlpha = 1;
  }
  if (overflow) {
    ctx.restore();
    if (it.type === 'shape') return;
    // a fade at the cut edge says "there is more"
    const g = ctx.createLinearGradient(0, it.y + it.h - L.F * 2, 0, it.y + it.h);
    const base = bg || theme.canvas;
    g.addColorStop(0, `${base}00`);
    g.addColorStop(1, base);
    ctx.fillStyle = g;
    ctx.fillRect(it.x, it.y + it.h - L.F * 2, it.w, L.F * 2);
  }
}

/** The checklist box under a board point, or null: { block } (line index in the text). */
export function checkAt(it, p, family) {
  if (!it.text || !it.text.includes('[')) return null;
  const L = layoutNote(it, family);
  const ox = it.x + L.pad;
  const oy = it.y + L.offsetY;
  const slack = L.F * 0.25;
  for (const c of L.checks) {
    if (p.x >= ox + c.x - slack && p.x <= ox + c.x + c.s + slack && p.y >= oy + c.y - slack && p.y <= oy + c.y + c.s + slack) return c;
  }
  return null;
}

/** The link under a board point, or null. */
export function linkAt(it, p, family) {
  if (!it.text || !it.text.includes('](')) return null;
  const L = layoutNote(it, family);
  const ox = it.x + L.pad;
  const oy = it.y + L.offsetY;
  for (const ln of L.lines) {
    if (p.y < oy + ln.y || p.y > oy + ln.y + ln.h) continue;
    for (const run of ln.runs) if (run.st.link && p.x >= ox + ln.x + run.x && p.x <= ox + ln.x + run.x + run.w) return run.st.link;
  }
  return null;
}

function roundRect(ctx, x, y, w, h, r) {
  if (r > 0.01) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

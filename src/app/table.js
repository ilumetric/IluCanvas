// Tables on the canvas: layout (column x, row heights grown to fit their
// text), drawing, and finding the cell under a point. A cell is laid out and
// edited like a small note: a `type: "cell"` stand-in item in board
// coordinates (text.js and editor.js know it), so its Markdown, wrapping and
// the editor are the notes' own.

import { cellOf, rowCount, colCount } from '../core/table.js';
import { intersects } from '../core/model.js';
import { layoutNote, drawText, textVersion } from './text.js';
import { fillColor, darkFill } from './shapes.js';

const cache = new WeakMap(); // table item → { family, v, L }

/**
 * The table's layout in board units: { xs, ys (edges, from 0), hs (row
 * heights), w, h, cells: [[stand-in items]] }. `draft` ({ r, c, text }): a
 * cell being typed — its row grows as you type.
 */
export function tableLayout(t, family, draft = null) {
  if (!draft) {
    const c = cache.get(t);
    if (c && c.family === family && c.v === textVersion()) return c.L;
  }
  const R = rowCount(t);
  const C = colCount(t);
  const xs = [0];
  for (let c = 0; c < C; c++) xs.push(xs[c] + t.cols[c]);
  const texts = [];
  const hs = [];
  for (let r = 0; r < R; r++) {
    const line = [];
    let h = t.rows[r];
    for (let c = 0; c < C; c++) {
      const cell = cellOf(t, r, c);
      const text = draft && draft.r === r && draft.c === c ? draft.text : cell.text;
      line.push({ ...cell, text });
      if (text) h = Math.max(h, layoutNote(stand(t, cell, text, 0, 0, t.cols[c], t.rows[r], r, c), family).total);
    }
    texts.push(line);
    hs.push(h);
  }
  const ys = [0];
  for (let r = 0; r < R; r++) ys.push(ys[r] + hs[r]);
  const cells = texts.map((line, r) => line.map((cell, c) => stand(t, cell, cell.text, t.x + xs[c], t.y + ys[r], t.cols[c], hs[r], r, c)));
  const L = { xs, ys, hs, w: xs[C], h: ys[R], cells };
  if (!draft) cache.set(t, { family, v: textVersion(), L });
  return L;
}

/** A cell as a small note: what text.js lays out and the editor edits. */
function stand(t, cell, text, x, y, w, h, r, c) {
  const it = { id: t.id, type: 'cell', x, y, w, h, text, fill: cell.fill || t.fill, r, c };
  if (t.size) it.size = t.size;
  if (t.scale) it.scale = t.scale;
  const align = cell.align || t.align;
  if (align) it.align = align;
  return it;
}

/** The height the table's rows need (its text measured). */
export const tableHeight = (t, family) => tableLayout(t, family).h;

/** The cell under board point `p`: { r, c } or null. */
export function cellAt(t, p, family) {
  const L = tableLayout(t, family);
  const x = p.x - t.x;
  const y = p.y - t.y;
  if (x < 0 || y < 0 || x > L.w || y > L.h) return null;
  let c = 0;
  while (c < L.xs.length - 2 && x >= L.xs[c + 1]) c++;
  let r = 0;
  while (r < L.ys.length - 2 && y >= L.ys[r + 1]) r++;
  return { r, c };
}

/** A cell range's box in board units. */
export function rangeBox(t, L, { r0, c0, r1 = r0, c1 = c0 }) {
  const [ra, rb] = [Math.min(r0, r1), Math.max(r0, r1)];
  const [ca, cb] = [Math.min(c0, c1), Math.max(c0, c1)];
  return { x: t.x + L.xs[ca], y: t.y + L.ys[ra], w: L.xs[cb + 1] - L.xs[ca], h: L.ys[rb + 1] - L.ys[ra] };
}

/**
 * Draw a table (board units, ctx already transformed). `editing` ({ r, c }):
 * the cell in the editor — its text is the editor's; `draft` its text so far.
 */
export function drawTable(ctx, t, { px, theme, family, editing = null, draft = null, vis = null }) {
  const L = tableLayout(t, family, draft);
  const u = (devicePixelRatio || 1) / px; // one screen px in board units
  const radius = theme.rOuter > 0 ? Math.min(10 * (t.scale || 1), L.w / 6, L.h / 6) : 0;
  const light = !darkFill({ fill: t.fill });
  const outline = () => { ctx.beginPath(); if (radius > 0.01) ctx.roundRect(t.x, t.y, L.w, L.h, radius); else ctx.rect(t.x, t.y, L.w, L.h); };
  ctx.save();
  if (t.fill !== 'none') {
    // a soft shadow under the paper, like notes
    const off = Math.min(L.h * 0.02, 3 * u);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    if (radius > 0.01) ctx.roundRect(t.x, t.y + off, L.w, L.h, radius); else ctx.rect(t.x, t.y + off, L.w, L.h);
    ctx.fill();
  }
  outline();
  ctx.clip();
  // cell backgrounds: the table's fill, or a cell's own
  const R = L.hs.length;
  const C = L.xs.length - 1;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const fill = L.cells[r][c].fill;
      if (fill === 'none') continue;
      ctx.fillStyle = fillColor(fill);
      ctx.fillRect(t.x + L.xs[c], t.y + L.ys[r], L.xs[c + 1] - L.xs[c] + u * 0.5, L.hs[r] + u * 0.5);
    }
  }
  // the grid
  ctx.lineWidth = u;
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.17)' : 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  for (let c = 1; c < C; c++) { ctx.moveTo(t.x + L.xs[c], t.y); ctx.lineTo(t.x + L.xs[c], t.y + L.h); }
  for (let r = 1; r < R; r++) { ctx.moveTo(t.x, t.y + L.ys[r]); ctx.lineTo(t.x + L.w, t.y + L.ys[r]); }
  ctx.stroke();
  // text (cells off screen skipped)
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const cell = L.cells[r][c];
      if (!cell.text || (editing && editing.r === r && editing.c === c)) continue;
      if (vis && !intersects(cell, vis)) continue;
      drawText(ctx, cell, { px, theme, family });
    }
  }
  ctx.restore();
  outline();
  ctx.lineWidth = u * 1.2;
  ctx.strokeStyle = light ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.28)';
  ctx.stroke();
  return L;
}

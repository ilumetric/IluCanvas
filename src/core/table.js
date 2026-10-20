// Tables (`type: "table"`): a grid of cells with Markdown text, FigJam style.
// Everything here is plain data — the app (src/app/table.js) lays the text out
// with the real font, draws and edits; the CLI and agents use the same
// operations on the file.
//
//   { "type": "table", "x": 0, "y": 0, "w": 400, "h": 112,
//     "cols": [200, 200],            column widths, board units
//     "rows": [56, 56],              row heights — the least; a row grows to show its text
//     "cells": [["Name", "Link"],    rows × columns; a cell is Markdown text,
//               [{ "text": "a", "fill": "yellow", "align": "center" }, ""]] }   or { text, fill?, align? }
//
// `w` is the sum of `cols`; `h` the rows as drawn (the app measures the text,
// tools without fonts estimate it).

import { plainText } from './markdown.js';

export const TABLE_COL = 200;
export const TABLE_ROW = 56;
export const TABLE_MIN = 24; // the narrowest column / lowest row, board units (times the table's scale)
export const TABLE_MAX_CELLS = 10000;
const NOTE_FONT = { s: 14, m: 18, l: 28, xl: 44 };

/** A cell's parts: { text, fill?, align? }. */
export function cellOf(t, r, c) {
  const v = t.cells?.[r]?.[c];
  if (v && typeof v === 'object') return { ...v, text: typeof v.text === 'string' ? v.text : '' };
  return { text: typeof v === 'string' ? v : '' };
}

/** A cell as stored: a plain string unless it has a fill or an alignment of its own. */
export function packCell({ text = '', fill, align, ...rest }) {
  const o = { text: String(text ?? ''), ...rest };
  if (fill) o.fill = fill;
  if (align) o.align = align;
  return Object.keys(o).length === 1 ? o.text : o;
}

export const rowCount = (t) => t.rows?.length || 0;
export const colCount = (t) => t.cols?.length || 0;

/** Base text size of a table, board units. */
export const tableFont = (t) => (NOTE_FONT[t.size || 'm'] || 18) * (t.scale || 1);
/** Inner padding of a cell: [left / right, top / bottom]. */
export const cellPad = (t) => { const F = tableFont(t); return [Math.max(4, F * 0.6), Math.max(3, F * 0.45)]; };

/** A rows × cols grid from loose input (strings, numbers, objects), padded to a rectangle. */
export function cleanCells(input, rows, cols) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = Array.isArray(src[r]) ? src[r] : [];
    const line = [];
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v && typeof v === 'object') line.push(packCell({ ...v, text: typeof v.text === 'string' ? v.text : v.text == null ? '' : String(v.text) }));
      else line.push(v === undefined || v === null ? '' : String(v));
    }
    out.push(line);
  }
  return out;
}

/** Sizes from loose input: positive numbers, `n` of them (missing ones `fallback`). */
export function cleanSizes(input, n, fallback, min = 1) {
  const src = Array.isArray(input) ? input : [];
  return Array.from({ length: n }, (_, i) => {
    const v = Number(src[i]);
    return Number.isFinite(v) && v > 0 ? Math.max(min, Math.round(v * 100) / 100) : fallback;
  });
}

/** The table's box from its sizes: w = Σ cols; h at least Σ rows (taller when text made rows grow). */
export function tableBox(t) {
  const w = (t.cols || []).reduce((a, b) => a + b, 0);
  const minH = (t.rows || []).reduce((a, b) => a + b, 0);
  return { w, h: Math.max(minH, Number(t.h) > 0 ? t.h : 0) };
}

/**
 * Row heights estimated without a font engine (CLI, agents): about 0.55 em per
 * character. The app measures properly and corrects `h`.
 */
export function estimateRows(t) {
  const F = tableFont(t);
  const [px, py] = cellPad(t);
  return (t.rows || []).map((min, r) => {
    let need = 0;
    (t.cols || []).forEach((w, c) => {
      const text = cellOf(t, r, c).text;
      if (!text) return;
      const perLine = Math.max(1, Math.floor((w - px * 2) / (F * 0.55)));
      let lines = 0;
      for (const raw of text.split('\n')) lines += Math.max(1, Math.ceil(raw.length / perLine));
      need = Math.max(need, lines * F * 1.35 + py * 2);
    });
    return Math.max(min, Math.ceil(need));
  });
}

/** `h` from the estimate (tools without fonts). */
export const estimateHeight = (t) => estimateRows(t).reduce((a, b) => a + b, 0);

// ---- editing (each returns a new table item) ------------------------------------------------------

const clampIndex = (i, n) => Math.max(0, Math.min(n, Number.isInteger(i) ? i : n));

/** A new row at `at` (default: the end); its cells from `cells` (texts) or empty. */
export function insertRow(t, at, { cells = [], height } = {}) {
  const n = rowCount(t);
  const i = clampIndex(at ?? n, n);
  const line = cleanCells([cells], 1, colCount(t))[0];
  const rows = [...t.rows];
  rows.splice(i, 0, height > 0 ? height : t.rows[Math.min(i, n - 1)] ?? TABLE_ROW * (t.scale || 1));
  const grid = t.cells.map((row) => row.slice());
  grid.splice(i, 0, line);
  return { ...t, rows, cells: grid, h: (t.h || 0) + rows[i] };
}

/** A new column at `at` (default: the end), as wide as its neighbour unless `width` says. */
export function insertCol(t, at, { cells = [], width } = {}) {
  const n = colCount(t);
  const i = clampIndex(at ?? n, n);
  const cols = [...t.cols];
  cols.splice(i, 0, width > 0 ? width : t.cols[Math.min(i, n - 1)] ?? TABLE_COL * (t.scale || 1));
  const grid = t.cells.map((row, r) => { const line = row.slice(); line.splice(i, 0, cells[r] === undefined || cells[r] === null ? '' : typeof cells[r] === 'object' ? packCell(cells[r]) : String(cells[r])); return line; });
  return { ...t, cols, cells: grid, w: cols.reduce((a, b) => a + b, 0) };
}

/** Without rows `from`…`to` (inclusive). A table keeps at least one row. */
export function removeRows(t, from, to = from) {
  const n = rowCount(t);
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(n - 1, Math.max(from, to));
  if (b - a + 1 >= n) return t;
  const gone = t.rows.slice(a, b + 1).reduce((s, v) => s + v, 0);
  return { ...t, rows: t.rows.filter((_, i) => i < a || i > b), cells: t.cells.filter((_, i) => i < a || i > b), h: Math.max(1, (t.h || 0) - gone) };
}

/** Without columns `from`…`to` (inclusive). A table keeps at least one column. */
export function removeCols(t, from, to = from) {
  const n = colCount(t);
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(n - 1, Math.max(from, to));
  if (b - a + 1 >= n) return t;
  const cols = t.cols.filter((_, i) => i < a || i > b);
  return { ...t, cols, cells: t.cells.map((row) => row.filter((_, i) => i < a || i > b)), w: cols.reduce((s, v) => s + v, 0) };
}

/** Cells r0…r1 × c0…c1 changed by `fn(cell) → cell` ({ text, fill?, align? }). */
export function mapCells(t, { r0, c0, r1 = r0, c1 = c0 }, fn) {
  const [ra, rb] = [Math.min(r0, r1), Math.max(r0, r1)];
  const [ca, cb] = [Math.min(c0, c1), Math.max(c0, c1)];
  return {
    ...t,
    cells: t.cells.map((row, r) => (r < ra || r > rb ? row : row.map((v, c) => (c < ca || c > cb ? v : packCell(fn(cellOf(t, r, c), r, c)))))),
  };
}

/** One cell's text / fill / align (null removes fill and align). */
export function setCell(t, r, c, patch) {
  return mapCells(t, { r0: r, c0: c }, (cell) => {
    const n = { ...cell };
    for (const k of ['text', 'fill', 'align']) {
      if (!(k in patch)) continue;
      if (patch[k] === null || patch[k] === undefined || (k !== 'text' && patch[k] === '')) delete n[k]; else n[k] = k === 'text' ? String(patch[k]) : patch[k];
    }
    return n;
  });
}

/** Column `i` `w` wide (other columns keep theirs: the table gets wider). */
export function resizeCol(t, i, w) {
  const cols = t.cols.map((v, k) => (k === i ? Math.max(TABLE_MIN * (t.scale || 1), w) : v));
  return { ...t, cols, w: cols.reduce((a, b) => a + b, 0) };
}

/** Row `i` at least `h` high. */
export function resizeRow(t, i, h) {
  const rows = t.rows.map((v, k) => (k === i ? Math.max(TABLE_MIN * (t.scale || 1), h) : v));
  return { ...t, rows };
}

// ---- text in and out ----------------------------------------------------------------------------------

/** Cells r0…r1 × c0…c1 as plain text: tab between cells, a new line between rows (spreadsheets paste it). */
export function cellsText(t, { r0 = 0, c0 = 0, r1 = rowCount(t) - 1, c1 = colCount(t) - 1 } = {}) {
  const lines = [];
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    const row = [];
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
      const text = plainText(cellOf(t, r, c).text);
      // a cell with tabs, new lines or quotes is quoted (the TSV spreadsheets read)
      row.push(/[\t\n"]/.test(text) && (r1 !== r0 || c1 !== c0) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The same cells as an HTML table (rich paste into documents and spreadsheets). */
export function cellsHtml(t, { r0 = 0, c0 = 0, r1 = rowCount(t) - 1, c1 = colCount(t) - 1 } = {}) {
  const rows = [];
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    const tds = [];
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) tds.push(`<td>${esc(plainText(cellOf(t, r, c).text)).replace(/\n/g, '<br>')}</td>`);
    rows.push(`<tr>${tds.join('')}</tr>`);
  }
  return `<table>${rows.join('')}</table>`;
}

/**
 * Rows of cells from CSV or TSV text (the separator is guessed from the first
 * line; "quoted" cells may hold separators, quotes and new lines).
 */
export function parseDelimited(text) {
  const src = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!src) return [];
  const first = src.split('\n')[0];
  const sep = first.includes('\t') ? '\t' : (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// ---- Markdown marks over whole cells (the table bar: bold, strike, list) ------------------------------------

const PREFIX = /^(\s*(?:#{1,3} |> |[-*+] \[[ xX]\] |[-*+] |\d+[.)] )?)(.*)$/;

/** Is every non-empty line of `text` wrapped in `mark` (`**`, `~~`)? */
export function hasMark(text, mark) {
  const lines = String(text).split('\n').filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => { const body = PREFIX.exec(l)[2]; return body.startsWith(mark) && body.endsWith(mark) && body.length >= mark.length * 2; });
}

/** Wrap (or unwrap, when `on` is false) every non-empty line's text in `mark`. */
export function setMark(text, mark, on) {
  return String(text).split('\n').map((l) => {
    if (!l.trim()) return l;
    const [, pre, body] = PREFIX.exec(l);
    const wrapped = body.startsWith(mark) && body.endsWith(mark) && body.length >= mark.length * 2;
    if (on && !wrapped) return `${pre}${mark}${body}${mark}`;
    if (!on && wrapped) return `${pre}${body.slice(mark.length, body.length - mark.length)}`;
    return l;
  }).join('\n');
}

/** Is every non-empty line a bullet? */
export const isList = (text) => { const l = String(text).split('\n').filter((x) => x.trim()); return l.length > 0 && l.every((x) => /^\s*[-*+] (?!\[)/.test(x)); };

/** Bullets on (every non-empty line) or off. */
export function setList(text, on) {
  return String(text).split('\n').map((l) => {
    if (!l.trim()) return l;
    if (on) return /^\s*[-*+] /.test(l) ? l : `- ${l.replace(/^\s*(?:\d+[.)] )/, '')}`;
    return l.replace(/^(\s*)[-*+] (?!\[)/, '$1');
  }).join('\n');
}

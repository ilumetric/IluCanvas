// Notes, shapes, connectors and tables in the app: making them (tools, double
// click, dragging out of the tool bar), editing their text (a table's cells
// too), connector labels, and the bar that floats over the selection — their
// settings, or the formatting buttons while you type.

import { newId, addItems, patchItems, reparent, byId, itemBounds, unionBounds, refreshConnectors, NOTE_COLORS, RATIO_K, SHAPE_KINDS, PAINT, isHexColor } from '../core/model.js';
import { connectorPath, midpoint, ROUTES } from '../core/connectors.js';
import { toggleTask, MARK_COLORS } from '../core/markdown.js';
import { NoteEditor } from './editor.js';
import { neededHeight, NOTE_BG, MARK_ON_LIGHT, HIGHLIGHT } from './text.js';
import { tableLayout } from './table.js';
import { TABLE_COL, TABLE_ROW, cellOf, mapCells, insertRow, insertCol, removeRows, removeCols, cellsText, cellsHtml, hasMark, setMark, isList, setList } from '../core/table.js';
import { cleanTable } from '../core/model.js';
import { FILL, LINE_COLOR, fillColor, lineColor } from './shapes.js';
import { INK_COLOR, inkColor } from './ink.js';
import { openColorPicker } from './colorpicker.js';
import { INK_TOOLS, INK_WIDTHS, inkScale, reframe, strokeScale } from '../core/ink.js';
import { h, icon, openMenu, promptDialog, toast } from './ui.js';
import { t } from './i18n.js';

const KIND_ICON = { rect: 'shRect', rounded: 'shRounded', ellipse: 'shEllipse', diamond: 'shDiamond', triangle: 'shTriangle', parallelogram: 'shParallelogram', hexagon: 'shHexagon', star: 'shStar', line: 'routeStraight', arrow: 'connector' };
/** Shape-tool kinds that draw a free line (a connector between two points). */
const LINE_KINDS = new Set(['line', 'arrow']);
const ROUTE_ICON = { straight: 'routeStraight', elbow: 'routeElbow', curve: 'routeCurve', dubins: 'routeDubins' };
const HEAD_ICON = { none: 'headNone', arrow: 'headArrow', dot: 'headDot' };
const SQUARE_KINDS = new Set(['ellipse', 'diamond', 'triangle', 'star']);
export { KIND_ICON, ROUTE_ICON, LINE_KINDS };

const STICKIES = NOTE_COLORS.filter((c) => c !== 'paper' && c !== 'none');
/** A new sticky's side on screen, px. */
const STICKY_PX = 200;
const niceScale = (z) => 2 ** Math.round(Math.log2(Math.min(64, Math.max(1 / 16, 1 / z))));

export class NotesUI {
  /**
   * app: { board, doc(), edit(label, fn), readOnly(), pref, setTool(id) }
   * layer: element for the editor; bar: the floating selection bar element
   */
  constructor(app, { layer, bar }) {
    this.app = app;
    this.board = app.board;
    this.bar = bar;
    this.editor = new NoteEditor({
      board: this.board,
      layer,
      onClose: (id, md) => this.#closed(id, md),
      onChange: () => this.#changed(),
      onTab: (back) => this.#nextCell(back),
    });
    this.cellEdit = null; // the table cell in the editor: { id, r, c }
  }

  /** The editor's text changed (or its caret moved): a cell's row grows as you type; the format bar follows. */
  #changed() {
    const ce = this.cellEdit;
    if (ce && this.editor.el) {
      const md = this.editor.markdown();
      if (this.board.tableDraft?.text !== md) { this.board.tableDraft = { ...ce, text: md }; this.board.invalidate(); }
    }
    this.render();
  }

  get family() { return this.board.theme.font; }
  get editing() { return this.editor.id; }

  // ---- making notes ------------------------------------------------------------------------------

  /** A shape of the current kind: a click makes one of the usual size on screen, a drag one of that size. */
  createShape(where, { drawn = false, from = null, to = null } = {}) {
    const z = this.board.view.z;
    const pick = this.app.pref.get('shapeKind', 'rect');
    if (LINE_KINDS.has(pick)) return this.#line(pick, from || where, to);
    const kind = SHAPE_KINDS.includes(pick) ? pick : 'rect';
    const [sw, sh] = SQUARE_KINDS.has(kind) ? [140, 140] : [180, 110];
    const r = drawn ? where : { x: where.x - sw / z / 2, y: where.y - sh / z / 2, w: sw / z, h: sh / z };
    const fill = PAINT.includes(this.app.pref.get('shapeFill', 'blue')) || this.app.pref.get('shapeFill') === 'none' ? this.app.pref.get('shapeFill', 'blue') : 'blue';
    const s = { id: newId('shape'), type: 'shape', kind, x: r.x, y: r.y, w: r.w, h: r.h, fill, text: '' };
    const scale = niceScale(z);
    if (scale !== 1) s.scale = scale;
    this.app.edit('shape', (d) => { addItems(d, [s]); reparent(d, [s.id]); });
    this.board.select([s.id]);
    this.app.setTool('select');
    return s.id;
  }

  /** A free line (an arrow: with a head) from a drag; a click makes one of a usual length on screen. */
  #line(kind, a, b) {
    const z = this.board.view.z;
    const end = b && Math.hypot(b.x - a.x, b.y - a.y) * z > 8 ? b : { x: a.x + 160 / z, y: a.y };
    const c = { id: newId('connector'), type: 'connector', from: { x: a.x, y: a.y }, to: { x: end.x, y: end.y }, end: kind === 'arrow' ? 'arrow' : 'none', color: this.app.pref.get('lineColor', 'grey'), x: 0, y: 0, w: 1, h: 1 };
    const scale = niceScale(z);
    if (scale !== 1) c.width = 2 * scale;
    this.app.edit('line', (d) => { addItems(d, [c]); refreshConnectors(d); });
    this.board.select([c.id]);
    this.app.setTool('select');
    return c.id;
  }

  /** A connector between two ends ({ id, side? } | { x, y }), with the last used look. */
  connect(from, to) {
    const pick = this.app.pref.get('connRoute', 'dubins');
    const route = ROUTES.includes(pick) ? pick : 'dubins';
    const c = { id: newId('connector'), type: 'connector', from, to, end: 'arrow', color: this.app.pref.get('lineColor', 'grey'), x: 0, y: 0, w: 1, h: 1 };
    if (route !== 'straight') c.route = route;
    this.app.edit('connect', (d) => { addItems(d, [c]); refreshConnectors(d); });
    this.board.select([c.id]);
    this.app.setTool('select');
    return c.id;
  }

  /** A connector's label, typed in place. */
  editLabel(id) {
    const d = this.app.doc();
    const c = byId(d).get(id);
    if (!c || c.type !== 'connector' || this.app.readOnly()) return;
    const m = byId(d);
    const mid = midpoint(connectorPath(c, (x) => m.get(x)).pts);
    const s = this.board.toScreen(mid.x, mid.y);
    const st = this.board.stage.getBoundingClientRect();
    const ui = this.board.ui;
    const input = h('input.rename-input', { type: 'text', value: c.label || '', placeholder: t('conn.label'), spellcheck: false, style: { left: `${(st.left + s.x) / ui - 90}px`, top: `${(st.top + s.y) / ui - 15}px`, width: '180px', textAlign: 'center' } });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      if (ok && v !== (c.label || '')) this.app.edit('label', (dd) => patchItems(dd, { [id]: { label: v || undefined } }));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
    document.body.append(input);
    input.focus();
    input.select();
  }

  /** The sticky colour last chosen. */
  get stickyColor() {
    const c = this.app.pref.get('noteColor', 'yellow');
    return STICKIES.includes(c) ? c : 'yellow';
  }

  /** The Note tool: a click makes a sticky of the usual size on screen, a drag a note of that size. */
  create(where, { drawn = false } = {}) {
    const z = this.board.view.z;
    const s = Math.round(STICKY_PX / z);
    const r = drawn ? where : { x: where.x - s / 2, y: where.y - s / 2, w: s, h: s };
    return this.#add({ id: newId('note'), type: 'note', x: r.x, y: r.y, w: r.w, h: r.h, color: this.stickyColor, fit: true, text: '' });
  }

  /**
   * Dragging the Note button from the tool bar: a sticky follows the pointer
   * and lands where it is dropped on the board. A press without a drag is
   * left to the button (it picks the tool).
   */
  dragFromToolbar(e) {
    if (e.button !== 0 || this.app.readOnly()) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const color = this.stickyColor;
    let ghost = null;
    const overBoard = (x, y) => !!document.elementFromPoint(x, y)?.closest('#stage');
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        ghost = h('div.note-ghost', { style: { background: NOTE_BG[color], width: `${STICKY_PX}px`, height: `${STICKY_PX}px` } });
        document.body.append(ghost);
        document.body.classList.add('dragging-note');
      }
      ghost.style.transform = `translate(${ev.clientX - STICKY_PX / 2}px, ${ev.clientY - STICKY_PX / 2}px) rotate(-2deg)`;
      ghost.classList.toggle('off', !overBoard(ev.clientX, ev.clientY));
    };
    const end = (ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (!ghost) return; // a plain click: the button handles it
      ghost.remove();
      document.body.classList.remove('dragging-note');
      // the click that follows a drag must not also pick the tool
      // (the click comes right after this pointerup, if at all — never swallow a later one)
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
      if (ev.type === 'pointercancel' || !overBoard(ev.clientX, ev.clientY)) return;
      const r = this.board.stage.getBoundingClientRect();
      this.create(this.board.toWorld(ev.clientX - r.left, ev.clientY - r.top));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  /** Double click on empty board: text straight on the board, readable at the current zoom. */
  createText(p) {
    const z = this.board.view.z;
    const scale = niceScale(z);
    const n = { id: newId('note'), type: 'note', x: p.x, y: p.y - 14 * scale, w: Math.round(320 / z), h: Math.round(40 * scale), color: 'none', text: '' };
    if (scale !== 1) n.scale = scale;
    return this.#add(n);
  }

  #add(n) {
    this.app.edit('note', (d) => { addItems(d, [n]); reparent(d, [n.id]); });
    this.board.select([n.id]);
    this.app.setTool('select');
    this.open(n.id);
    return n.id;
  }

  open(id, opts) {
    const it = byId(this.app.doc()).get(id);
    if (!it || (it.type !== 'note' && it.type !== 'shape') || this.app.readOnly()) return;
    this.editor.open(it, opts);
    this.render();
  }

  close() { this.editor.close(); }

  /** Editing finished. Empty notes stay — the person deletes what they do not need. */
  #closed(id, md) {
    const ce = this.cellEdit;
    if (ce) {
      // a table cell: its text goes into the table (one undo step), its row fits it
      this.cellEdit = null;
      this.board.editingCell = null;
      this.board.tableDraft = null;
      const d = this.app.doc();
      const tb = d && byId(d).get(ce.id);
      if (tb && md !== null) this.#editTable('text', ce.id, (x) => mapCells(x, { r0: ce.r, c0: ce.c }, (cell) => ({ ...cell, text: md })));
      else this.board.invalidate();
      this.render();
      return;
    }
    const d = this.app.doc();
    const it = d && byId(d).get(id);
    if (it && md !== null) {
      this.app.edit('text', (dd) => {
        patchItems(dd, { [id]: { text: md } });
        this.fitHeights(dd, [id]);
      });
    }
    this.render();
  }

  /** Documents and text grow to show all their text (stickies shrink their text instead); a table's box is its rows as drawn. */
  fitHeights(d, ids) {
    const m = byId(d);
    const patches = {};
    for (const id of ids) {
      const it = m.get(id);
      if (it?.type === 'table') {
        const L = tableLayout(it, this.family);
        if (Math.abs(L.h - it.h) > 0.5 || Math.abs(L.w - it.w) > 0.5) patches[id] = { w: L.w, h: Math.ceil(L.h * 100) / 100 };
        continue;
      }
      if (!it || (it.type !== 'note' && it.type !== 'shape') || it.fit) continue;
      const need = neededHeight(it, this.family);
      if (need > it.h + 0.5) patches[id] = { h: Math.ceil(need) };
    }
    if (Object.keys(patches).length) patchItems(d, patches);
    return Object.keys(patches);
  }

  toggleTask(id, block) {
    const it = byId(this.app.doc()).get(id);
    if (!it) return;
    this.app.edit('check', (d) => patchItems(d, { [id]: { text: toggleTask(it.text, block) } }));
  }

  /** Keep the editor in step with the note (undo, outside changes, settings). */
  sync() {
    const id = this.editor.id;
    if (!id) return;
    const it = byId(this.app.doc()).get(id);
    if (this.cellEdit) {
      const ce = this.cellEdit;
      if (!it || it.type !== 'table' || ce.r >= it.rows.length || ce.c >= it.cols.length) this.editor.close({ commit: false });
      else this.editor.update(tableLayout(it, this.family, this.board.tableDraft).cells[ce.r][ce.c]);
      return;
    }
    if (!it) this.editor.close({ commit: false });
    else this.editor.update(it);
  }

  // ---- note settings --------------------------------------------------------------------------------

  #notes() { return this.board.selectedItems().filter((it) => it.type === 'note'); }
  #ofType(type) { return this.board.selectedItems().filter((it) => it.type === type); }

  #set(label, fn, type = 'note') {
    const items = this.#ofType(type);
    if (!items.length) return;
    this.app.edit(label, (d) => {
      patchItems(d, Object.fromEntries(items.map((n) => [n.id, fn(n)])));
      this.fitHeights(d, items.map((n) => n.id));
      refreshConnectors(d);
    });
    this.sync();
    this.render();
  }

  setColor(color) {
    if (STICKIES.includes(color)) this.app.pref.set('noteColor', color);
    this.#set('color', (n) => ({ color, ...(color === 'none' || color === 'paper' ? { fit: undefined } : {}) }));
  }

  /** sticky (coloured, text fits) · doc (paper, A4) · text (no paper) */
  setKind(kind) {
    const sticky = STICKIES.includes(this.app.pref.get('noteColor', 'yellow')) ? this.app.pref.get('noteColor', 'yellow') : 'yellow';
    this.#set('kind', (n) => {
      if (kind === 'sticky') return { color: STICKIES.includes(n.color) ? n.color : sticky, fit: true, h: n.fit ? n.h : Math.max(n.h, n.w * 0.6) };
      if (kind === 'doc') return { color: 'paper', fit: undefined, ratio: n.ratio || 'a4', h: Math.max(n.h, n.w * RATIO_K[n.ratio || 'a4']) };
      return { color: 'none', fit: undefined, ratio: undefined };
    });
  }

  // ---- the floating bar --------------------------------------------------------------------------------

  /** Rebuild the bar for the selection / editor state, then place it. */
  render() {
    const bar = this.bar;
    const ro = this.app.readOnly();
    const all = this.board.selectedItems();
    const only = (type) => all.length && all.every((it) => it.type === type);
    if (this.editor.id) this.#formatBar();
    else if (!ro && only('note')) this.#noteBar(all);
    else if (!ro && only('shape')) this.#shapeBar(all);
    else if (!ro && only('connector')) this.#connectorBar(all);
    else if (!ro && only('stroke')) this.#strokeBar(all);
    else if (!ro && all.length === 1 && all[0].type === 'table') this.#tableBar(all[0]);
    else { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    this.place();
  }

  place() {
    const bar = this.bar;
    if (bar.hidden) return;
    const d = this.app.doc();
    const ids = this.editor.id ? [this.editor.id] : [...this.board.selection];
    const items = d ? ids.map((id) => byId(d).get(id)).filter(Boolean) : [];
    if (!items.length || (this.board.drag?.moved && !this.editor.id)) { bar.style.visibility = 'hidden'; return; }
    bar.style.visibility = '';
    const b = unionBounds(items.map(itemBounds));
    const a = this.board.toScreen(b.x, b.y);
    const z = this.board.view.z;
    const ui = this.board.ui;
    const r = bar.getBoundingClientRect();
    const st = this.board.stage.getBoundingClientRect();
    // a selected table has pills above it and + bars around it: the bar keeps clear of them
    const clear = !this.editor.id && items.length === 1 && items[0].type === 'table' ? 30 : 0;
    let x = st.left + a.x + (b.w * z) / 2 - r.width / 2;
    let y = st.top + a.y - r.height - 14 - clear;
    if (y < 64 * ui) y = st.top + a.y + b.h * z + 14 + clear;
    if (y + r.height > innerHeight - 8) y = Math.max(64 * ui, st.top + a.y + 14);
    x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
    bar.style.left = `${x / ui}px`;
    bar.style.top = `${y / ui}px`;
  }

  #btn(ic, title, onclick, on = false, text = null) {
    const b = h(`button.icon-btn${on ? '.on' : ''}${text ? '.sb-text' : ''}`, { type: 'button', title, 'aria-label': title, 'aria-pressed': on ? 'true' : undefined }, ic ? icon(ic, 17) : null, text);
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the text selection in the editor
    b.addEventListener('click', onclick);
    return b;
  }

  #noteBar(notes) {
    const one = notes[0];
    const same = (k) => notes.every((n) => (n[k] ?? null) === (one[k] ?? null));
    const kind = (n) => (n.color === 'none' ? 'text' : n.color === 'paper' ? 'doc' : 'sticky');
    const k = notes.every((n) => kind(n) === kind(one)) ? kind(one) : null;
    const swatch = h('span.sb-swatch', { style: { background: NOTE_BG[one.color] || 'transparent' }, class: one.color === 'none' ? 'none' : '' });
    const colorBtn = this.#btn(null, t('note.color'), () => openMenu(colorBtn, [
      ...NOTE_COLORS.map((c) => ({ label: t(`noteColor.${c}`), swatch: NOTE_BG[c] || 'transparent', checked: same('color') && one.color === c, onClick: () => this.setColor(c) })),
    ]));
    colorBtn.append(swatch);
    const parts = [
      colorBtn,
      h('span.sb-sep'),
      this.#btn('sticky', t('note.sticky'), () => this.setKind('sticky'), k === 'sticky'),
      this.#btn('doc', t('note.doc'), () => this.setKind('doc'), k === 'doc'),
      this.#btn('type', t('note.text'), () => this.setKind('text'), k === 'text'),
    ];
    if (notes.every((n) => !n.fit)) {
      parts.push(h('span.sb-sep'));
      for (const s of ['s', 'm', 'l', 'xl']) parts.push(this.#btn(null, t('note.size'), () => this.#set('size', () => ({ size: s === 'm' ? undefined : s })), (one.size || 'm') === s && same('size'), s.toUpperCase()));
    }
    const al = one.align || 'left';
    parts.push(h('span.sb-sep'),
      this.#btn('alignLeft', t('fmt.left'), () => this.#set('align', () => ({ align: undefined })), al === 'left'),
      this.#btn('alignCenter', t('fmt.center'), () => this.#set('align', () => ({ align: 'center' })), al === 'center'),
      this.#btn('alignRight', t('fmt.right'), () => this.#set('align', () => ({ align: 'right' })), al === 'right'));
    if (notes.length === 1) parts.push(h('span.sb-sep'), this.#btn('pencil', `${t('note.edit')} (Enter)`, () => this.open(one.id)));
    this.bar.replaceChildren(...parts);
  }

  #paintMenu(anchor, current, onPick, { none = false, lines = false, custom = null } = {}) {
    const table = lines ? LINE_COLOR : FILL;
    openMenu(anchor, [
      ...(none ? [{ label: t('paint.none'), icon: 'x', checked: current === 'none' || !current, onClick: () => onPick('none') }] : []),
      ...PAINT.map((c) => ({ label: t(`paint.${c}`), swatch: table[c], checked: current === c, onClick: () => onPick(c) })),
      custom ? { label: t('color.custom'), icon: 'pipette', checked: isHexColor(current), onClick: custom } : null,
    ].filter(Boolean));
  }

  /**
   * A custom colour for one field of the selected items of a type: shown live
   * while dragging, one undo step per colour chosen.
   */
  #customColor(anchor, type, field, shown, key) {
    const ids = new Set(this.#ofType(type).map((k) => k.id));
    const d0 = this.app.doc();
    if (!ids.size || !d0) return;
    let before = d0.items;
    const first = d0.items.find((it) => ids.has(it.id));
    openColorPicker(anchor, shown(first[field]), (hex, done) => {
      const d = this.app.doc();
      if (!d) return;
      if (!done) {
        d.items = d.items.map((it) => (ids.has(it.id) ? { ...it, [field]: hex } : it));
        this.board.invalidate();
        return;
      }
      d.items = before;
      this.#set(field, () => ({ [field]: hex }), type);
      before = d.items;
    }, { key, place: 'below' });
  }

  #shapeBar(shapes) {
    const one = shapes[0];
    const same = (k) => shapes.every((s) => (s[k] ?? null) === (one[k] ?? null));
    const kindBtn = this.#btn(KIND_ICON[one.kind] || 'shRect', t('shape.kind'), () => openMenu(kindBtn, SHAPE_KINDS.map((k) => ({
      label: t(`shape.${k}`), icon: KIND_ICON[k], checked: same('kind') && one.kind === k,
      onClick: () => { this.app.pref.set('shapeKind', k); this.#set('kind', () => ({ kind: k }), 'shape'); },
    }))));
    const fillBtn = this.#btn(null, t('shape.fill'), () => this.#paintMenu(fillBtn, one.fill, (c) => { this.app.pref.set('shapeFill', c); this.#set('fill', () => ({ fill: c }), 'shape'); }, { none: true, custom: () => this.#customColor(fillBtn, 'shape', 'fill', fillColor, 'shape-fill') }));
    fillBtn.dataset.cp = 'shape-fill';
    fillBtn.append(h('span.sb-swatch', { class: one.fill === 'none' ? 'none' : '', style: { background: one.fill === 'none' ? 'transparent' : fillColor(one.fill) } }));
    const strokeBtn = this.#btn(null, t('shape.stroke'), () => this.#paintMenu(strokeBtn, one.stroke || 'none', (c) => this.#set('stroke', () => ({ stroke: c === 'none' ? undefined : c }), 'shape'), { none: true, lines: true, custom: () => this.#customColor(strokeBtn, 'shape', 'stroke', lineColor, 'shape-stroke') }));
    strokeBtn.dataset.cp = 'shape-stroke';
    strokeBtn.append(h('span.sb-swatch.ring', { class: one.stroke ? '' : 'none', style: { borderColor: one.stroke ? lineColor(one.stroke) : 'transparent' } }));
    const al = one.align || 'center';
    const lw = this.#btn('lineWidth', t('shape.strokeWidth'), () => openMenu(lw, [
      { label: t('shape.widthAuto'), checked: !one.strokeWidth, onClick: () => this.#set('strokeWidth', () => ({ strokeWidth: undefined }), 'shape') },
      ...[[1, 'thin'], [2, 'medium'], [4, 'thick'], [8, 'bold'], [16, 'heavy']].map(([w, n]) => ({
        label: t(`conn.${n}`), checked: one.strokeWidth === w, onClick: () => this.#set('strokeWidth', (s) => ({ strokeWidth: w * (s.scale || 1) }), 'shape'),
      })),
    ]));
    const dash = this.#btn('dash', t('conn.dash'), () => this.#set('dash', () => ({ dash: !one.dash || undefined }), 'shape'), !!one.dash);
    const parts = [kindBtn, h('span.sb-sep'), fillBtn, strokeBtn, lw, dash, h('span.sb-sep')];
    for (const s of ['s', 'm', 'l', 'xl']) parts.push(this.#btn(null, t('note.size'), () => this.#set('size', () => ({ size: s === 'm' ? undefined : s }), 'shape'), (one.size || 'm') === s && same('size'), s.toUpperCase()));
    parts.push(h('span.sb-sep'),
      this.#btn('alignLeft', t('fmt.left'), () => this.#set('align', () => ({ align: 'left' }), 'shape'), al === 'left'),
      this.#btn('alignCenter', t('fmt.center'), () => this.#set('align', () => ({ align: undefined }), 'shape'), al === 'center'),
      this.#btn('alignRight', t('fmt.right'), () => this.#set('align', () => ({ align: 'right' }), 'shape'), al === 'right'));
    if (shapes.length === 1) parts.push(h('span.sb-sep'), this.#btn('pencil', `${t('note.edit')} (Enter)`, () => this.open(one.id)));
    this.bar.replaceChildren(...parts);
  }

  #connectorBar(cs) {
    const one = cs[0];
    const route = one.route || 'straight';
    const set = (label, fn) => this.#set(label, fn, 'connector');
    const headBtn = (which) => {
      const cur = which === 'start' ? one.start || 'none' : one.end || 'arrow';
      const b = this.#btn(HEAD_ICON[cur], t(`conn.${which}`), () => openMenu(b, ['none', 'arrow', 'dot'].map((hd) => ({
        label: t(`head.${hd}`), icon: HEAD_ICON[hd], checked: cur === hd,
        onClick: () => set('head', () => ({ [which]: which === 'start' && hd === 'none' ? undefined : hd })),
      }))));
      if (which === 'start') b.classList.add('flip-x');
      return b;
    };
    const colorBtn = this.#btn(null, t('conn.color'), () => this.#paintMenu(colorBtn, one.color, (c) => { this.app.pref.set('lineColor', c); set('color', () => ({ color: c })); }, { lines: true, custom: () => this.#customColor(colorBtn, 'connector', 'color', lineColor, 'conn-color') }));
    colorBtn.dataset.cp = 'conn-color';
    colorBtn.append(h('span.sb-swatch', { style: { background: lineColor(one.color) } }));
    const widthBtn = this.#btn('lineWidth', t('conn.width'), () => openMenu(widthBtn, [[1, 'thin'], [2, 'medium'], [4, 'thick'], [8, 'bold']].map(([w, n]) => ({
      label: t(`conn.${n}`), checked: (one.width || 2) === w, onClick: () => set('width', () => ({ width: w === 2 ? undefined : w })),
    }))));
    const parts = [
      ...ROUTES.map((r) => this.#btn(ROUTE_ICON[r], t(`route.${r}`), () => { this.app.pref.set('connRoute', r); set('route', () => ({ route: r === 'straight' ? undefined : r })); }, route === r)),
      h('span.sb-sep'), headBtn('start'), headBtn('end'),
      h('span.sb-sep'), colorBtn, widthBtn,
      this.#btn('dash', t('conn.dash'), () => set('dash', (c) => ({ dash: !one.dash || undefined })), !!one.dash),
    ];
    if (cs.length === 1) parts.push(h('span.sb-sep'), this.#btn('text', t('conn.label'), () => this.editLabel(one.id), !!one.label));
    this.bar.replaceChildren(...parts);
  }

  /** A custom colour for the selected strokes: shown live while dragging, one undo step per colour chosen. */
  #customInk(anchor) {
    this.#customColor(anchor, 'stroke', 'color', inkColor, 'stroke-color');
  }

  /** Selected strokes: tool, colour, width (a new width or tool measures the stroke's frame again). */
  #strokeBar(ks) {
    const one = ks[0];
    const z = this.board.view.z;
    const restroke = (label, changes) => this.#set(label, (k) => { const n = reframe(k, changes(k)); return { ...n, tw: n.tw, nib: n.nib }; }, 'stroke');
    const colorBtn = this.#btn(null, t('ink.color'), () => openMenu(colorBtn, [
      ...PAINT.map((c) => ({
        label: t(`paint.${c}`), swatch: INK_COLOR[c], checked: ks.every((k) => k.color === c), onClick: () => this.#set('color', () => ({ color: c }), 'stroke'),
      })),
      { label: t('color.custom'), icon: 'pipette', checked: ks.every((k) => isHexColor(k.color)), onClick: () => this.#customInk(colorBtn) },
    ]));
    colorBtn.dataset.cp = 'stroke-color';
    colorBtn.append(h('span.sb-swatch', { style: { background: inkColor(one.color) } }));
    const tool = ks.every((k) => k.tool === one.tool) ? one.tool : null;
    const parts = [
      ...INK_TOOLS.map((tl) => this.#btn(tl, t(`tool.${tl}`), () => restroke('tool', (k) => ({ tool: tl, nib: tl === 'pen' ? k.nib : undefined })), tool === tl)),
      h('span.sb-sep'), colorBtn,
      ks.every((k) => k.tool !== 'tape') ? this.#btn('dash', t('conn.dash'), () => this.#set('dash', () => ({ dash: !one.dash || undefined }), 'stroke'), !!one.dash) : null,
      ks.every((k) => k.tool !== 'tape') ? this.#btn('headArrow', t('ink.arrow'), () => restroke('end', () => ({ end: one.end === 'arrow' ? undefined : 'arrow' })), one.end === 'arrow') : null,
    ].filter(Boolean);
    if (tool) {
      // the presets as they look on screen at this zoom
      parts.push(h('span.sb-sep'));
      INK_WIDTHS[tool].forEach((w, i) => {
        const bw = w * inkScale(z);
        const on = ks.every((k) => Math.abs(k.width * strokeScale(k) - bw) < bw * 0.05);
        const b = this.#btn(null, `${t('ink.width')} ${w}`, () => restroke('width', () => ({ width: bw })), on);
        b.append(h('span.ink-dot', { style: { width: `${4 + i * 2.5}px`, height: `${4 + i * 2.5}px` } }));
        parts.push(b);
      });
    }
    this.bar.replaceChildren(...parts);
  }

  // ---- tables ------------------------------------------------------------------------------------------

  /** The Table tool: a 3 × 3 table of the usual size on screen, centred where clicked; its first cell is edited. */
  createTable(where) {
    const scale = niceScale(this.board.view.z);
    const tb = cleanTable({ id: newId('table'), type: 'table', x: 0, y: 0, w: 1, h: 1, cols: Array(3).fill(TABLE_COL * scale), rows: Array(3).fill(TABLE_ROW * scale), cells: [], ...(scale !== 1 ? { scale } : {}) });
    tb.x = where.x - tb.w / 2;
    tb.y = where.y - tb.h / 2;
    this.app.edit('table', (d) => { addItems(d, [tb]); reparent(d, [tb.id]); });
    this.board.select([tb.id]);
    this.app.setTool('select');
    this.openCell(tb.id, 0, 0);
    return tb.id;
  }

  /** Edit a table's cell (double click, Enter, typing over a selected cell). */
  openCell(id, r, c, opts = {}) {
    if (this.app.readOnly()) return;
    if (this.editor.el) this.editor.close(); // the cell (or note) being edited keeps its text first
    const d = this.app.doc();
    const tb = d && byId(d).get(id);
    if (!tb || tb.type !== 'table') return;
    r = Math.max(0, Math.min(tb.rows.length - 1, r));
    c = Math.max(0, Math.min(tb.cols.length - 1, c));
    this.cellEdit = { id, r, c };
    this.board.editingCell = { id, r, c };
    this.board.tableDraft = null;
    this.board.selectCells(id, r, c);
    this.editor.open(tableLayout(tb, this.family).cells[r][c], opts);
    this.render();
  }

  /** Tab while editing a cell: the next one (Shift: the one before); past the last cell a new row. */
  #nextCell(back) {
    const ce = this.cellEdit;
    const tb = ce && byId(this.app.doc()).get(ce.id);
    if (!tb) return;
    const C = tb.cols.length;
    const i = ce.r * C + ce.c + (back ? -1 : 1);
    if (i < 0) return;
    if (i >= tb.rows.length * C) {
      this.editor.close();
      this.#editTable('row', ce.id, (x) => insertRow(x));
      this.openCell(ce.id, tb.rows.length, 0);
      return;
    }
    this.openCell(ce.id, Math.floor(i / C), i % C);
  }

  /** Replace a table by `fn(table)` as one undo step; its box follows its rows. */
  #editTable(label, id, fn) {
    this.app.edit(label, (d) => {
      const cur = byId(d).get(id);
      if (!cur || cur.type !== 'table') return;
      const n = fn(cur);
      if (!n || n === cur) return;
      d.items = d.items.map((it) => (it.id === id ? n : it));
      this.fitHeights(d, [id]);
    });
    this.sync();
    this.render();
  }

  /** A click picked cells (a cell, a column, a row): copied, unless the table says not to. */
  cellsPicked(id) {
    this.render();
    const tb = byId(this.app.doc()).get(id);
    if (tb && tb.clickCopy !== false) this.copyCells(id);
  }

  /** Copy the selected cells: plain text (tabs between cells, lines between rows) and an HTML table. */
  async copyCells(id) {
    const tb = byId(this.app.doc()).get(id);
    const range = this.board.cellRange();
    if (!tb || !range || range.id !== id) return false;
    const text = cellsText(tb, range);
    if (!text.trim()) return false;
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([cellsHtml(tb, range)], { type: 'text/html' }) })]);
      } else await navigator.clipboard.writeText(text);
    } catch {
      try { await navigator.clipboard.writeText(text); } catch { return false; }
    }
    const one = range.r0 === range.r1 && range.c0 === range.c1;
    toast(one ? t('table.copied') : t('table.copiedN', { n: (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1) }), { timeout: 1400 });
    return true;
  }

  /** A + bar or an insert dot of the selected table was clicked. */
  tableAction(hit) {
    const tb = byId(this.app.doc()).get(hit.id);
    if (!tb || this.app.readOnly()) return;
    const col = hit.axis === 'col';
    const at = hit.kind === 'tableAdd' ? (col ? tb.cols.length : tb.rows.length) : hit.i;
    this.#editTable(col ? 'column' : 'row', tb.id, (x) => (col ? insertCol(x, at) : insertRow(x, at)));
    if (col) this.board.selectCells(tb.id, 0, at, tb.rows.length - 1, at);
    else this.board.selectCells(tb.id, at, 0, at, tb.cols.length - 1);
    this.render();
  }

  /** Keys while a table's cells are selected (and nothing is being typed). True: handled. */
  cellKey(e) {
    const range = this.board.cellRange();
    if (!range || this.editor.el) return false;
    const tb = byId(this.app.doc()).get(range.id);
    const ro = this.app.readOnly();
    const R = tb.rows.length;
    const C = tb.cols.length;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copyCells(tb.id); return true; }
    if (mod || e.altKey) return false;
    const go = (dr, dc) => {
      e.preventDefault();
      const fr = Math.max(0, Math.min(R - 1, (e.shiftKey ? range.fr : range.ar) + dr));
      const fc = Math.max(0, Math.min(C - 1, (e.shiftKey ? range.fc : range.ac) + dc));
      if (e.shiftKey) this.board.selectCells(tb.id, range.ar, range.ac, fr, fc); else this.board.selectCells(tb.id, fr, fc);
      this.render();
      return true;
    };
    switch (e.key) {
      case 'ArrowUp': return go(-1, 0);
      case 'ArrowDown': return go(1, 0);
      case 'ArrowLeft': return go(0, -1);
      case 'ArrowRight': return go(0, 1);
      case 'Tab': {
        e.preventDefault();
        const i = Math.max(0, Math.min(R * C - 1, range.ar * C + range.ac + (e.shiftKey ? -1 : 1)));
        this.board.selectCells(tb.id, Math.floor(i / C), i % C);
        this.render();
        return true;
      }
      case 'Enter': case 'F2':
        if (!ro) { e.preventDefault(); this.openCell(tb.id, range.ar, range.ac); }
        return true;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (!ro) this.#editTable('clear', tb.id, (x) => mapCells(x, range, (cell) => ({ ...cell, text: '' })));
        return true;
      case 'Escape': this.board.clearCells(); this.render(); return true;
      default:
        // typing over a selected cell starts editing it with that character (spreadsheets)
        if (!ro && e.key.length === 1) { this.openCell(tb.id, range.ar, range.ac, { select: 'all' }); return true; }
        return false;
    }
  }

  /** The selected table: fill, text size, bold / strike / bullets and alignment (of the selected cells, or all), copy on click, rows and columns. */
  #tableBar(tb) {
    const range = this.board.cellRange();
    const sel = range && range.id === tb.id ? range : null;
    const all = { r0: 0, c0: 0, r1: tb.rows.length - 1, c1: tb.cols.length - 1 };
    const scope = sel || all;
    const texts = [];
    for (let r = scope.r0; r <= scope.r1; r++) for (let c = scope.c0; c <= scope.c1; c++) { const s = cellOf(tb, r, c).text; if (s.trim()) texts.push(s); }
    const set = (label, fn) => this.#editTable(label, tb.id, fn);
    const own = sel ? cellOf(tb, sel.ar, sel.ac) : {};
    const fillNow = own.fill || tb.fill;
    const fill = (c) => set('fill', (x) => (sel ? mapCells(x, sel, (cell) => ({ ...cell, fill: c === x.fill ? undefined : c })) : { ...x, fill: c }));
    const fillBtn = this.#btn(null, t('table.fill'), () => this.#paintMenu(fillBtn, fillNow, fill, { none: true, custom: () => this.#tableCustomFill(fillBtn, tb.id, sel, fillNow) }));
    fillBtn.dataset.cp = 'table-fill';
    fillBtn.append(h('span.sb-swatch', { class: fillNow === 'none' ? 'none' : '', style: { background: fillNow === 'none' ? 'transparent' : fillColor(fillNow) } }));
    const marked = (mark) => texts.length > 0 && texts.every((s) => hasMark(s, mark));
    const bold = marked('**');
    const strike = marked('~~');
    const list = texts.length > 0 && texts.every(isList);
    const alNow = (sel ? own.align : null) || tb.align || 'left';
    const align = (a) => set('align', (x) => (sel ? mapCells(x, sel, (cell) => ({ ...cell, align: a === (x.align || 'left') ? undefined : a })) : { ...x, align: a === 'left' ? undefined : a }));
    const parts = [fillBtn, h('span.sb-sep')];
    for (const s of ['s', 'm', 'l', 'xl']) parts.push(this.#btn(null, t('note.size'), () => set('size', (x) => ({ ...x, size: s === 'm' ? undefined : s })), (tb.size || 'm') === s, s.toUpperCase()));
    parts.push(h('span.sb-sep'),
      this.#btn('bold', t('fmt.bold'), () => set('bold', (x) => mapCells(x, scope, (cell) => ({ ...cell, text: setMark(cell.text, '**', !bold) }))), bold),
      this.#btn('strike', t('fmt.strike'), () => set('strike', (x) => mapCells(x, scope, (cell) => ({ ...cell, text: setMark(cell.text, '~~', !strike) }))), strike),
      this.#btn('list', t('fmt.ul'), () => set('list', (x) => mapCells(x, scope, (cell) => ({ ...cell, text: setList(cell.text, !list) }))), list),
      h('span.sb-sep'),
      this.#btn('alignLeft', t('fmt.left'), () => align('left'), alNow === 'left'),
      this.#btn('alignCenter', t('fmt.center'), () => align('center'), alNow === 'center'),
      this.#btn('alignRight', t('fmt.right'), () => align('right'), alNow === 'right'),
      h('span.sb-sep'),
      this.#btn('copy', t('table.clickCopy'), () => set('clickCopy', (x) => ({ ...x, clickCopy: x.clickCopy === false ? undefined : false })), tb.clickCopy !== false));
    const r0 = sel ? sel.r0 : tb.rows.length - 1;
    const r1 = sel ? sel.r1 : r0;
    const c0 = sel ? sel.c0 : tb.cols.length - 1;
    const c1 = sel ? sel.c1 : c0;
    const menuBtn = this.#btn('table', t('table.menu'), () => openMenu(menuBtn, [
      { label: t('table.rowAbove'), icon: 'rowAbove', onClick: () => set('row', (x) => insertRow(x, r0)) },
      { label: t('table.rowBelow'), icon: 'rowBelow', onClick: () => set('row', (x) => insertRow(x, r1 + 1)) },
      { label: t('table.colLeft'), icon: 'colLeft', onClick: () => set('column', (x) => insertCol(x, c0)) },
      { label: t('table.colRight'), icon: 'colRight', onClick: () => set('column', (x) => insertCol(x, c1 + 1)) },
      tb.rows.length > r1 - r0 + 1 ? { label: r1 > r0 ? t('table.rowsRemove', { n: r1 - r0 + 1 }) : t('table.rowRemove'), icon: 'rowRemove', onClick: () => { this.board.clearCells(); set('remove', (x) => removeRows(x, r0, r1)); } } : null,
      tb.cols.length > c1 - c0 + 1 ? { label: c1 > c0 ? t('table.colsRemove', { n: c1 - c0 + 1 }) : t('table.colRemove'), icon: 'colRemove', onClick: () => { this.board.clearCells(); set('remove', (x) => removeCols(x, c0, c1)); } } : null,
      { label: t('table.clear'), icon: 'eraser', onClick: () => set('clear', (x) => mapCells(x, scope, (cell) => ({ ...cell, text: '' }))) },
    ].filter(Boolean)));
    parts.push(menuBtn, this.#btn('pencil', `${t('note.edit')} (Enter)`, () => this.openCell(tb.id, sel ? sel.ar : 0, sel ? sel.ac : 0)));
    this.bar.replaceChildren(...parts);
  }

  /** A custom fill for the selected cells (or the table): shown live while dragging, one undo step when chosen. */
  #tableCustomFill(anchor, id, sel, now) {
    const d0 = this.app.doc();
    let before = d0.items;
    const apply = (x, hex) => (sel ? mapCells(x, sel, (cell) => ({ ...cell, fill: hex })) : { ...x, fill: hex });
    openColorPicker(anchor, fillColor(now === 'none' ? 'white' : now), (hex, done) => {
      const d = this.app.doc();
      if (!d) return;
      if (!done) {
        d.items = before.map((it) => (it.id === id ? apply(it, hex) : it));
        this.board.invalidate();
        return;
      }
      d.items = before;
      this.#editTable('fill', id, (x) => apply(x, hex));
      before = d.items;
    }, { key: 'table-fill', place: 'below' });
  }

  #formatBar() {
    const ed = this.editor;
    const s = ed.state();
    const blockLabel = { p: t('fmt.p'), h1: t('fmt.h1'), h2: t('fmt.h2'), h3: t('fmt.h3'), quote: t('fmt.quote') }[s.block] || t('fmt.p');
    const blockBtn = this.#btn(null, t('fmt.style'), () => openMenu(blockBtn, [
      { label: t('fmt.p'), icon: 'text', checked: s.block === 'p', onClick: () => ed.command('block', 'p') },
      { label: t('fmt.h1'), icon: 'heading', hint: '#', checked: s.block === 'h1', onClick: () => ed.command('block', 'h1') },
      { label: t('fmt.h2'), icon: 'heading', hint: '##', checked: s.block === 'h2', onClick: () => ed.command('block', 'h2') },
      { label: t('fmt.h3'), icon: 'heading', hint: '###', checked: s.block === 'h3', onClick: () => ed.command('block', 'h3') },
      { label: t('fmt.quote'), icon: 'quote', hint: '>', checked: s.block === 'quote', onClick: () => ed.command('block', 'quote') },
    ]), false, blockLabel);
    blockBtn.append(icon('chevronDown', 14));
    const it = byId(this.app.doc()).get(ed.id);
    const textColors = it?.color === 'none' ? MARK_ON_LIGHT : MARK_ON_LIGHT;
    const colorBtn = this.#btn('palette', t('fmt.color'), () => openMenu(colorBtn, [
      { label: t('fmt.noColor'), icon: 'x', onClick: () => ed.command('color', null) },
      ...MARK_COLORS.map((c) => ({ label: t(`markColor.${c}`), swatch: textColors[c], onClick: () => ed.command('color', c) })),
    ]));
    const hlBtn = this.#btn('highlighter', `${t('fmt.highlight')} (Ctrl+Shift+H)`, () => openMenu(hlBtn, [
      { label: t('fmt.noHighlight'), icon: 'x', onClick: () => ed.command('highlight', null) },
      ...MARK_COLORS.map((c) => ({ label: t(`markColor.${c}`), swatch: HIGHLIGHT[c], onClick: () => ed.command('highlight', c) })),
    ]));
    const linkBtn = this.#btn('link', t('fmt.link'), async () => {
      if (s.link) { ed.command('link', null); return; }
      const sel = document.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = await promptDialog({ title: t('fmt.link'), label: t('fmt.linkUrl'), placeholder: 'https://' });
      if (!url) return;
      ed.el?.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      ed.command('link', /^[a-z]+:/i.test(url) ? url : `https://${url}`);
    }, s.link);
    this.bar.replaceChildren(
      blockBtn,
      h('span.sb-sep'),
      this.#btn('bold', `${t('fmt.bold')} (Ctrl+B)`, () => ed.command('bold'), s.bold),
      this.#btn('italic', `${t('fmt.italic')} (Ctrl+I)`, () => ed.command('italic'), s.italic),
      this.#btn('underline', `${t('fmt.underline')} (Ctrl+U)`, () => ed.command('underline'), s.underline),
      this.#btn('strike', `${t('fmt.strike')} (Ctrl+Shift+X)`, () => ed.command('strike'), s.strike),
      h('span.sb-sep'),
      this.#btn('list', `${t('fmt.ul')} (- )`, () => ed.command('list', 'ul'), s.list === 'ul'),
      this.#btn('listOrdered', `${t('fmt.ol')} (1. )`, () => ed.command('list', 'ol'), s.list === 'ol'),
      this.#btn('checklist', `${t('fmt.task')} ([ ] )`, () => ed.command('list', 'task'), s.list === 'task'),
      h('span.sb-sep'),
      colorBtn, hlBtn, linkBtn,
      h('span.sb-sep'),
      this.#btn('check', `${t('fmt.done')} (Esc)`, () => ed.close()),
    );
  }
}

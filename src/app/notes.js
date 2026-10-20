// Notes in the app: making them (the Note tool, double click), editing their
// text, and the bar that floats over the selection — note settings, or the
// formatting buttons while you type.

import { newId, addItems, patchItems, reparent, byId, itemBounds, unionBounds, NOTE_COLORS, RATIO_K } from '../core/model.js';
import { toggleTask, MARK_COLORS } from '../core/markdown.js';
import { NoteEditor } from './editor.js';
import { neededHeight, NOTE_BG, MARK_ON_LIGHT, HIGHLIGHT } from './text.js';
import { h, icon, openMenu, promptDialog } from './ui.js';
import { t } from './i18n.js';

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
      onChange: () => this.render(),
    });
  }

  get family() { return this.board.theme.font; }
  get editing() { return this.editor.id; }

  // ---- making notes ------------------------------------------------------------------------------

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
    if (!it || it.type !== 'note' || this.app.readOnly()) return;
    this.editor.open(it, opts);
    this.render();
  }

  close() { this.editor.close(); }

  /** Editing finished. Empty notes stay — the person deletes what they do not need. */
  #closed(id, md) {
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

  /** Documents and text grow to show all their text (stickies shrink their text instead). */
  fitHeights(d, ids) {
    const m = byId(d);
    const patches = {};
    for (const id of ids) {
      const it = m.get(id);
      if (!it || it.type !== 'note' || it.fit) continue;
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
    if (!it) this.editor.close({ commit: false });
    else this.editor.update(it);
  }

  // ---- note settings --------------------------------------------------------------------------------

  #notes() { return this.board.selectedItems().filter((it) => it.type === 'note'); }

  #set(label, fn) {
    const notes = this.#notes();
    if (!notes.length) return;
    this.app.edit(label, (d) => {
      patchItems(d, Object.fromEntries(notes.map((n) => [n.id, fn(n)])));
      this.fitHeights(d, notes.map((n) => n.id));
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
    const notes = this.#notes();
    const all = this.board.selectedItems();
    if (this.editor.id) this.#formatBar();
    else if (!ro && notes.length && notes.length === all.length) this.#noteBar(notes);
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
    let x = st.left + a.x + (b.w * z) / 2 - r.width / 2;
    let y = st.top + a.y - r.height - 14;
    if (y < 64 * ui) y = st.top + a.y + b.h * z + 14;
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

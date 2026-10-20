// IluCanvas web app: the open canvas and its history, the boards bar, the tool
// and top bars, saving (autosave), watching the file for outside changes
// (agents), adding images (drop, paste, pick), shared links, settings, and
// window.ilucanvas — the same operations for agents driving the browser.
//
// The canvas lives in its .ilucanvas file. The browser keeps only preferences,
// the last view of each canvas, remembered folder / file handles and
// downloaded copies of shared links.

import { APP_VERSION } from '../core/version.js';
import {
  GROUP_COLORS, serialize, byId, itemBounds, unionBounds, withChildren, removeItems, groupItems, ungroup, fitGroup,
  arrangeItems, restack, patchItems, addItems, newId, dropLayout, fitSize, reparent, childrenOf, groupsOf, validate, contentBounds,
  pruneAssets, refreshConnectors, copyItems, SHAPE_KINDS, PAINT, isHexColor, groupAround, hasAsset,
} from '../core/model.js';
import { applyOps, newStroke, newVideo } from '../core/ops.js';
import { parseVideoUrl, posterUrls, oembedUrl } from '../core/video.js';
import { INK_WIDTHS, INK_DEFAULTS, inkScale } from '../core/ink.js';
import { listText } from '../core/describe.js';
import { ROUTES } from '../core/connectors.js';
import { isImageName } from '../core/imageinfo.js';
import { deadBytes, readPreview } from '../core/canvasfile.js';
import { blobReader } from '../core/zip.js';
import { h, icon, iconBtn, openDialog, confirmDialog, promptDialog, openMenu, closeMenu, toast } from './ui.js';
import { t, getLang, setLang } from './i18n.js';
import { Board } from './board.js';
import { ImageCache } from './images.js';
import { Minimap } from './minimap.js';
import { Background, BACKGROUNDS, STYLE_BACKGROUND, tileUrl } from './background.js';
import { Store } from './store.js';
import { NotesUI, KIND_ICON, ROUTE_ICON } from './notes.js';
import { resetTextCache } from './text.js';
import { INK_COLOR, inkColor } from './ink.js';
import { openColorPicker, closeColorPicker } from './colorpicker.js';
import * as disk from './disk.js';
import * as remote from './remote.js';
import { opfsSupported } from './opfs.js';
import { VideoPlayer } from './videoplayer.js';
import { IOS } from './images.js';

const $ = (id) => document.getElementById(id);
const REPO_URL = 'https://github.com/ilumetric/IluCanvas';
const STYLES = ['fun', 'calm', 'oli'];
/** No File System Access (Safari, Firefox): boards live in the browser's storage and download as files. */
const inBrowser = () => !disk.fsaSupported() && opfsSupported();

// ---- preferences (this browser only, never canvas data) -------------------------------------

const pref = {
  get(k, d) { try { const v = localStorage.getItem(`ilucanvas.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ilucanvas.${k}`, JSON.stringify(v)); } catch { /* storage off */ } },
};

// ---- state ------------------------------------------------------------------------------------

const S = {
  store: null,
  board: null,
  images: null,
  minimap: null,
  bg: null,
  undo: [],
  redo: [],
  rev: 0,
  savedRev: 0,
  saving: null,
  saveAgain: false,
  saveTimer: 0,
  saveError: null,
  active: null, // { kind: 'file' | 'link' | 'new' | 'server' | 'local', key, path }
  local: [], // boards kept in this browser: { key, gen, name, handle, title, mtime, size, path }
  sideGroups: pref.get('sideGroups', []), // the user's groups in the boards bar: { id, name, open, items: [{ key, title, sub }] }
  link: null, // the link record of the open canvas
  folders: [], // { key, handle, name, granted, files: [{ path, name, handle }] }
  recent: [],
  links: [],
  linksDir: null, // the folder boards from links are downloaded into (Settings); null: the browser's storage
  covers: new Map(),
  sidebar: pref.get('sidebar', innerWidth > 860),
  showMap: pref.get('minimap', true),
  clip: null,
  mouse: null,
  server: null,
};

const doc = () => S.store?.doc || null;
const isDirty = () => !!S.store && S.rev !== S.savedRev;
const readOnly = () => !S.store || S.store.readOnly;
const isNarrow = () => innerWidth <= 860;

// ---- style -------------------------------------------------------------------------------------

function currentStyle() { const s = pref.get('style', 'calm'); return STYLES.includes(s) ? s : 'calm'; }
function currentBg() { const b = pref.get('bg', 'auto'); return BACKGROUNDS.includes(b) ? b : STYLE_BACKGROUND[currentStyle()]; }

function applyStyle() {
  const style = currentStyle();
  document.documentElement.dataset.style = style;
  const cs = getComputedStyle(document.documentElement);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cs.getPropertyValue('--canvas').trim());
  S.bg?.set(currentBg(), cs.getPropertyValue('--pattern-ink').trim());
  if (S.board) S.board.gridDense = currentBg() === 'grid' ? 16 : 13; // snap to the lines the background draws
  resetTextCache();
  S.board?.setTheme();
  drawBackground();
  S.minimap?.contentChanged();
}

const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
function currentUi() { const v = Number(pref.get('ui', 1)); return UI_SCALES.includes(v) ? v : 1; }

/** Interface scale: panels, menus, dialogs, group tags (CSS zoom on the UI layers). */
function applyUi() {
  const v = currentUi();
  document.documentElement.style.setProperty('--ui', v);
  if (S.board) { S.board.ui = v; S.board.invalidate(); }
  S.notes?.render();
}

function drawBackground() {
  if (!S.bg || !S.board) return;
  const { w, h: hh } = S.board.size;
  S.bg.draw(S.board.view, w, hh, devicePixelRatio || 1);
}

// ---- history -------------------------------------------------------------------------------------

const snapshot = () => ({ items: doc().items, assets: doc().assets, title: doc().title });

function commit(label, before) {
  S.undo.push({ label, ...before });
  if (S.undo.length > 300) S.undo.shift();
  S.redo = [];
  changed();
}

/** Run `fn(doc)` as one undoable step (nothing recorded when it changed nothing). */
function edit(label, fn) {
  const d = doc();
  if (!d || readOnly()) return undefined;
  const before = snapshot();
  const r = fn(d);
  if (d.items !== before.items || d.assets !== before.assets || d.title !== before.title) commit(label, before);
  return r;
}

/** Change the document without an undo step (what the app learns by itself: a video's duration). */
function silent(fn) {
  const d = doc();
  if (!d || readOnly()) return;
  fn(d);
  changed();
}

function changed({ save = true } = {}) {
  S.rev++;
  if (doc()) refreshConnectors(doc());
  S.board.pruneSelection();
  S.notes?.sync();
  S.notes?.render();
  S.board.invalidate();
  S.minimap.contentChanged();
  if (S.video?.open) S.video.place();
  renderTopbar();
  updateDocTitle();
  if (save) scheduleSave();
}

function restore(s) {
  const d = doc();
  d.items = s.items;
  d.assets = s.assets;
  d.title = s.title;
}

function undo() {
  if (!S.undo.length || readOnly()) return;
  S.redo.push({ label: S.undo[S.undo.length - 1].label, ...snapshot() });
  restore(S.undo.pop());
  changed();
}

function redo() {
  if (!S.redo.length || readOnly()) return;
  S.undo.push({ label: S.redo[S.redo.length - 1].label, ...snapshot() });
  restore(S.redo.pop());
  changed();
}

/**
 * Images that only the undo history uses leave canvas.json on save, but their
 * files stay in the file for this session, so undo can bring them back.
 */
function historyFiles() {
  const d = doc();
  const used = new Set(d.items.filter(hasAsset).map((it) => it.asset));
  pruneAssets(d, used);
  const keep = new Set();
  for (const s of [...S.undo, ...S.redo]) {
    for (const it of s.items) {
      const a = hasAsset(it) && !used.has(it.asset) && s.assets[it.asset];
      if (!a) continue;
      if (a.file) keep.add(a.file);
      if (a.thumb) keep.add(a.thumb);
    }
  }
  return keep;
}

// ---- rendering: chrome -------------------------------------------------------------------------------

function render() {
  closeMenu();
  document.body.classList.toggle('side-open', S.sidebar);
  $('scrim').hidden = !(S.sidebar && isNarrow());
  renderSidebar();
  renderTopbar();
  renderToolbar();
  renderMapBar();
  renderWelcome();
  updateDocTitle();
}

function updateDocTitle() {
  const d = doc();
  document.title = d ? `${isDirty() ? '• ' : ''}${d.title || t('untitled')} — IluCanvas` : 'IluCanvas';
}

const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) % 360; return x; };

function coverNode(entry) {
  const name = entry.title || entry.name || entry.path || '?';
  if (/\.pur$/i.test(entry.name || entry.path || '')) return h('span.cover.letter.pur', { 'aria-hidden': 'true' }, 'PUR');
  const url = entry.coverKey && S.covers.get(entry.coverKey);
  if (url) return h('span.cover', { style: { backgroundImage: `url("${url}")` }, 'aria-hidden': 'true' });
  return h('span.cover.letter', { style: { '--h': hue(name) }, 'aria-hidden': 'true' }, String(name).trim().charAt(0).toUpperCase() || '#');
}

function boardRow({ key, title, sub, active, onOpen, onRemove, removeTitle, update, entry, missing = false }) {
  const menu = key ? iconBtn('more', t('sideGroup.boardMenu'), (e) => { e.stopPropagation(); openMenu(e.currentTarget, boardGroupMenu(key, { title, sub })); }, 'tiny.row-more') : null;
  const row = h(`div.board-row${active ? '.active' : ''}${missing ? '.missing' : ''}`, { role: 'button', tabindex: 0, title: sub || title, draggable: key ? 'true' : undefined },
    coverNode(entry),
    h('span.grow', {}, h('span.board-name.ellipsis', {}, title), sub ? h('span.board-path', {}, sub) : null),
    update ? h('span.badge-dot', { title: t('link.updateAvailable') }) : null,
    menu,
    onRemove ? iconBtn('x', removeTitle || t('side.forget'), (e) => { e.stopPropagation(); onRemove(); }, 'tiny') : null);
  row.addEventListener('click', () => { if (!active) onOpen(); });
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !active) onOpen(); });
  if (key) {
    row.dataset.key = key;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(BOARD_DND, JSON.stringify({ key, title, sub }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, boardGroupMenu(key, { title, sub })); });
  }
  return row;
}

// ---- groups in the boards bar (this browser) ------------------------------------------------------------
// Boards from anywhere (folders, links, recent files, this browser) can be put
// into the user's own groups. Only the bar changes: the files stay where they are.

const BOARD_DND = 'application/x-ilucanvas-board';
const saveSideGroups = () => pref.set('sideGroups', S.sideGroups);
const groupOfBoard = (key) => S.sideGroups.find((g) => g.items.some((x) => x.key === key)) || null;

async function newSideGroup() {
  const name = await promptDialog({ title: t('sideGroup.new'), label: t('sideGroup.name'), value: t('sideGroup.default') });
  if (!name || !name.trim()) return null;
  const g = { id: `sg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name.trim(), open: true, items: [] };
  S.sideGroups = [...S.sideGroups, g];
  saveSideGroups();
  renderSidebar();
  return g;
}

/** Put a board into a group (out of any other one), before `before` (a key) or at the end. */
function moveToSideGroup(board, gid, before = null) {
  const items = S.sideGroups.flatMap((g) => g.items);
  const snap = { ...(items.find((x) => x.key === board.key) || {}), ...board };
  S.sideGroups = S.sideGroups.map((g) => {
    const rest = g.items.filter((x) => x.key !== board.key);
    if (g.id !== gid) return rest.length === g.items.length ? g : { ...g, items: rest };
    const at = before ? rest.findIndex((x) => x.key === before) : -1;
    const list = [...rest];
    list.splice(at < 0 ? list.length : at, 0, { key: snap.key, title: snap.title, sub: snap.sub || null });
    return { ...g, items: list, open: true };
  });
  saveSideGroups();
  renderSidebar();
}

function removeFromSideGroup(key) {
  S.sideGroups = S.sideGroups.map((g) => (g.items.some((x) => x.key === key) ? { ...g, items: g.items.filter((x) => x.key !== key) } : g));
  saveSideGroups();
  renderSidebar();
}

function boardGroupMenu(key, board) {
  const cur = groupOfBoard(key);
  return [
    { title: t('sideGroup.moveTo') },
    ...S.sideGroups.map((g) => ({ label: g.name, icon: 'folder', checked: cur?.id === g.id, onClick: () => moveToSideGroup({ key, ...board }, g.id) })),
    { label: t('sideGroup.newWith'), icon: 'folderPlus', onClick: async () => { const g = await newSideGroup(); if (g) moveToSideGroup({ key, ...board }, g.id); } },
    cur ? { sep: true } : null,
    cur ? { label: t('sideGroup.remove'), icon: 'x', onClick: () => removeFromSideGroup(key) } : null,
  ].filter(Boolean);
}

/** A section for one of the user's groups: its boards (from wherever they are now), drop target. */
function sideGroupSection(g, known, activeKey) {
  const open = g.open !== false;
  const toggle = () => { S.sideGroups = S.sideGroups.map((x) => (x.id === g.id ? { ...x, open: !open } : x)); saveSideGroups(); renderSidebar(); };
  const more = iconBtn('more', t('sideGroup.menu'), (e) => openMenu(e.currentTarget, [
    { label: t('sideGroup.rename'), icon: 'pencil', onClick: async () => {
      const v = await promptDialog({ title: t('sideGroup.rename'), value: g.name });
      if (v && v.trim()) { S.sideGroups = S.sideGroups.map((x) => (x.id === g.id ? { ...x, name: v.trim() } : x)); saveSideGroups(); renderSidebar(); }
    } },
    { label: t('sideGroup.delete'), icon: 'trash', danger: true, onClick: () => { S.sideGroups = S.sideGroups.filter((x) => x.id !== g.id); saveSideGroups(); renderSidebar(); } },
  ]), 'tiny');
  const sec = h('div.side-section.side-group', { dataset: { group: g.id } },
    h('div.side-label', {},
      h('button.side-group-head', { type: 'button', onclick: toggle, 'aria-expanded': String(open) }, icon(open ? 'chevronDown' : 'chevronRight', 15), h('span.ellipsis', {}, g.name), h('span.side-count', {}, String(g.items.length))),
      more));
  if (open) {
    if (!g.items.length) sec.append(h('div.side-hint', {}, t('sideGroup.empty')));
    for (const x of g.items) {
      const p = known.get(x.key);
      if (p) sec.append(boardRow({ ...p, key: x.key }));
      else sec.append(boardRow({ key: x.key, title: x.title || x.key, sub: t('sideGroup.missing'), entry: { name: x.title || '?' }, missing: true, onOpen: () => toast(t('sideGroup.missingText'), { kind: 'warn' }), onRemove: () => removeFromSideGroup(x.key), removeTitle: t('sideGroup.remove') }));
    }
  }
  // drop a board here (before the row it is dropped on)
  sec.addEventListener('dragover', (e) => { if (!e.dataTransfer.types.includes(BOARD_DND)) return; e.preventDefault(); e.stopPropagation(); sec.classList.add('drop'); });
  sec.addEventListener('dragleave', (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('drop'); });
  sec.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(BOARD_DND);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    sec.classList.remove('drop');
    const before = e.target.closest?.('.board-row')?.dataset.key || null;
    const board = JSON.parse(raw);
    if (before !== board.key) moveToSideGroup(board, g.id, before);
  });
  return sec;
}

function renderSidebar() {
  const side = $('sidebar');
  if (!S.sidebar) { side.replaceChildren(); return; }
  const item = (ic, label, onclick, { kbd, disabled } = {}) => h('button.side-item', { type: 'button', onclick, disabled },
    icon(ic), h('span.grow.ellipsis', {}, label), kbd ? h('kbd', {}, kbd) : null);
  const nav = h('nav.side-nav', {},
    item('filePlus', t('side.new'), newCanvas),
    S.server || inBrowser() ? null : item('folder', t('side.openFolder'), openFolder, { disabled: !disk.fsaSupported() }),
    item('file', t('side.openFile'), openFile, { kbd: 'Ctrl O' }),
    item('link', t('side.openLink'), openLinkDialog),
    item('folderPlus', t('sideGroup.new'), newSideGroup));

  const scroll = h('div.side-scroll');
  const activeKey = S.active?.key;
  // every board shown in the bar, by key; the ones in a group show there instead
  const grouped = new Set(S.sideGroups.flatMap((g) => g.items.map((x) => x.key)));
  const known = new Map();
  const place = (sec, key, props) => { known.set(key, props); if (!grouped.has(key)) sec.append(boardRow({ ...props, key })); };

  // library folders
  for (const f of S.folders) {
    const sec = h('div.side-section');
    sec.append(h('div.side-label', {}, icon('folder', 15), h('span.ellipsis', {}, f.name),
      f.granted ? iconBtn('refresh', t('side.rescan'), () => scanFolder(f, true), 'tiny') : null,
      iconBtn('x', t('side.closeFolder'), async () => { await disk.idbDel('folders', f.key); S.folders = S.folders.filter((x) => x !== f); renderSidebar(); }, 'tiny')));
    if (!f.granted) {
      sec.append(h('button.side-item', { type: 'button', onclick: () => grantFolder(f) }, icon('unlock'), h('span.grow', {}, t('side.grant'))));
    } else if (!f.files.length) sec.append(h('div.side-hint', {}, t('side.folderEmpty')));
    for (const file of f.files) {
      const key = `${f.key}:${file.path}`;
      const title = file.name.replace(/\.(ilucanvas|pur)$/i, '');
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      place(sec, key, { title, sub: dir || (/\.pur$/i.test(file.name) ? 'PureRef' : f.name), active: key === activeKey, entry: { ...file, coverKey: file.coverKey }, onOpen: () => openHandle(file.handle, { key, path: `${f.name}/${file.path}` }) });
    }
    scroll.append(sec);
  }

  // dev server files
  if (S.server && S.serverFiles?.length) {
    const sec = h('div.side-section', {}, h('div.side-label', {}, icon('terminal', 15), h('span', {}, S.server.folder)));
    for (const p of S.serverFiles) {
      place(sec, `server:${p}`, { title: p.split('/').pop().replace(/\.(ilucanvas|pur)$/i, ''), sub: p, active: activeKey === `server:${p}`, entry: { name: p }, onOpen: () => openSource(disk.serverSource(p), { active: { kind: 'server', key: `server:${p}`, path: p } }) });
    }
    scroll.append(sec);
  }

  // shared links
  if (S.links.length) {
    const sec = h('div.side-section', {}, h('div.side-label', {}, icon('cloud', 15), h('span', {}, t('side.links'))));
    for (const l of S.links) {
      place(sec, l.key, {
        title: l.title || l.name, sub: l.kind === 'gdrive' ? 'Google Drive' : new URL(l.url).hostname, active: activeKey === l.key, update: l.update, entry: { name: l.name, title: l.title, coverKey: l.coverKey },
        onOpen: () => openLink(l), onRemove: () => forgetLink(l), removeTitle: t('link.forget'),
      });
    }
    scroll.append(sec);
  }

  // boards kept in this browser (Safari, Firefox)
  if (inBrowser() || S.local.length) {
    const sec = h('div.side-section', {}, h('div.side-label', {}, icon('save', 15), h('span', {}, t('side.local'))));
    if (!S.local.length) sec.append(h('div.side-hint', {}, t('side.localEmpty')));
    for (const e of S.local) {
      place(sec, e.path, {
        title: e.title, sub: `${(e.size / 1048576).toFixed(1)} MB · ${new Date(e.mtime).toLocaleDateString()}`, active: activeKey === e.path, entry: e,
        onOpen: () => openLocal(e), onRemove: () => deleteLocal(e), removeTitle: t('local.delete'),
      });
    }
    scroll.append(sec);
  }

  // recent files
  const inFolders = new Set(S.folders.flatMap((f) => f.files.map((x) => `${f.name}/${x.path}`)));
  const recent = S.recent.filter((r) => !inFolders.has(r.path)).slice(0, 8);
  const rec = h('div.side-section', {}, h('div.side-label', {}, h('span', {}, t('side.recent'))));
  if (!recent.length && !S.folders.length && !S.links.length) rec.append(h('div.side-hint', {}, t('side.recentEmpty')));
  for (const r of recent) {
    place(rec, r.key, {
      title: r.title || r.path, sub: r.path, active: activeKey === r.key, entry: { name: r.path, title: r.title, coverKey: r.coverKey },
      onOpen: () => openHandle(r.handle, { key: r.key, path: r.path }), onRemove: async () => { await disk.idbDel('recent', r.key); await refreshRecent(); },
    });
  }
  if (recent.length || (!S.folders.length && !S.links.length && !inBrowser())) scroll.append(rec);

  // the user's groups on top; a board dropped outside them leaves its group
  scroll.prepend(...S.sideGroups.map((g) => sideGroupSection(g, known, activeKey)));
  scroll.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(BOARD_DND)) e.preventDefault(); });
  scroll.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData(BOARD_DND);
    if (!raw) return;
    e.preventDefault();
    const { key } = JSON.parse(raw);
    if (groupOfBoard(key)) removeFromSideGroup(key);
  });

  const foot = h('div.side-foot', {},
    item('settings', t('side.settings'), openSettings),
    h('a.side-item', { href: 'docs/AGENT.md', target: '_blank', rel: 'noopener' }, icon('terminal'), h('span.grow', {}, t('side.agents'))));

  side.replaceChildren(
    h('div.side-head', {},
      h('button.brand', { type: 'button', title: `IluCanvas ${APP_VERSION}`, onclick: () => S.board.fitAll() }, h('span.brand-logo', {}, icon('logo', 16)), h('span', {}, 'IluCanvas')),
      iconBtn('sidebar', t('side.collapse'), () => setSidebar(false))),
    nav, scroll, foot);
}

function stateChip() {
  const st = S.store;
  if (!st) return null;
  let cls = '';
  let text;
  if (S.saving) { cls = 'busy'; text = t('state.saving'); }
  else if (S.saveError) { cls = 'error'; text = t('state.error'); }
  else if (st.kind === 'pur') { cls = 'readonly'; text = t('state.pur'); }
  else if (S.link) { cls = S.link.update ? 'update' : 'readonly'; text = S.link.update ? t('link.updateAvailable') : t('state.link'); }
  else if (st.readOnly) { cls = 'readonly'; text = t('state.readonly'); }
  else if (!st.source) { cls = 'dirty'; text = t('state.noFile'); }
  else if (isDirty()) { cls = 'dirty'; text = t('state.unsaved'); }
  else text = t('state.saved');
  return h(`span.chip-state${cls ? `.${cls}` : ''}`, { title: S.saveError || st.source?.path || text }, h('span.dot'), h('span.state-text.ellipsis', {}, text));
}

function renderTopbar() {
  const bar = $('topbar');
  const left = h('div.island.left');
  if (!S.sidebar) left.append(iconBtn('sidebar', t('side.open'), () => setSidebar(true)));
  const d = doc();
  if (d) {
    const title = h('button.board-title', { type: 'button', title: t('top.menu') }, h('span.ellipsis', {}, d.title || t('untitled')), icon('chevronDown', 16));
    title.addEventListener('click', () => openMenu(title, canvasMenu()));
    left.append(title, stateChip());
  }
  const right = h('div.island.right');
  if (d) {
    if (!readOnly()) {
      right.append(
        h('button.icon-btn', { type: 'button', title: `${t('top.undo')} (Ctrl+Z)`, 'aria-label': t('top.undo'), disabled: !S.undo.length, onclick: undo }, icon('undo')),
        h('button.icon-btn', { type: 'button', title: `${t('top.redo')} (Ctrl+Shift+Z)`, 'aria-label': t('top.redo'), disabled: !S.redo.length, onclick: redo }, icon('redo')));
    }
    if (S.link) {
      right.append(h(`button.btn${S.link.update ? '.warn' : ''}`, { type: 'button', onclick: () => syncLink(S.link, true) }, icon('refresh', 16), t('link.sync')));
    } else if (S.store.writable) {
      if (S.store.source?.kind === 'local') right.append(h('button.icon-btn', { type: 'button', title: t('local.download'), 'aria-label': t('local.download'), onclick: downloadCopy }, icon('download')));
      right.append(h('button.btn.primary', { type: 'button', disabled: !isDirty() && !S.saveError, onclick: () => save(), title: 'Ctrl+S' }, icon('save', 16), t('top.save')));
    } else {
      const keep = !disk.fsaSupported() && inBrowser();
      right.append(h('button.btn.primary', { type: 'button', onclick: () => saveAs(), title: 'Ctrl+Shift+S' }, icon(disk.fsaSupported() || keep ? 'save' : 'download', 16), S.store.kind === 'pur' ? t('top.savePur') : disk.fsaSupported() ? t('top.saveAs') : keep ? t('top.keep') : t('top.download')));
    }
  }
  bar.replaceChildren(left, right);
  left.hidden = !left.childElementCount;
  right.hidden = !right.childElementCount;
}

function renderToolbar() {
  const tb = $('toolbar');
  tb.hidden = !doc();
  const tool = (id, ic, label, key) => h(`button.tool${S.board.tool === id ? '.on' : ''}`, { type: 'button', title: `${label} (${key})`, 'aria-label': label, 'aria-pressed': String(S.board.tool === id), onclick: () => setTool(id) }, icon(ic, 20));
  const action = (ic, label, key, onclick) => h('button.tool', { type: 'button', title: `${label} (${key})`, 'aria-label': label, onclick }, icon(ic, 20));
  const shapeIcon = KIND_ICON[pref.get('shapeKind', 'rect')] || 'shRect';
  tb.replaceChildren(
    tool('select', 'pointer', t('tool.select'), 'V'), tool('hand', 'hand', t('tool.hand'), 'H'),
    readOnly() ? null : h('span.tool-sep'),
    readOnly() ? null : noteTool(),
    readOnly() ? null : tool('shape', shapeIcon, t('tool.shape'), 'S'),
    readOnly() ? null : tool('connector', 'connector', t('tool.connector'), 'X'),
    readOnly() ? null : h('span.tool-sep'),
    readOnly() ? null : tool('pen', 'pen', t('tool.pen'), 'P'),
    readOnly() ? null : tool('highlighter', 'highlighter', t('tool.highlighter'), 'Shift+P'),
    readOnly() ? null : tool('tape', 'tape', t('tool.tape'), 'T'),
    readOnly() ? null : tool('eraser', 'eraser', t('tool.eraser'), 'E'),
    readOnly() ? null : h('span.tool-sep'),
    readOnly() ? null : action('image', t('tool.image'), 'I', pickAndAdd),
    readOnly() ? null : action('video', t('tool.video'), 'Y', askVideo),
  );
  renderToolOptions();
  function noteTool() {
    // a click picks the tool; dragging the button drops a sticky on the board
    const b = tool('note', 'sticky', `${t('tool.note')} — ${t('tool.noteDrag')}`, 'N');
    b.addEventListener('pointerdown', (e) => S.notes.dragFromToolbar(e));
    return b;
  }
}

function setTool(id) {
  if (id !== S.board.tool) closeColorPicker();
  S.board.setTool(id);
  renderToolbar();
}

/** Options of the current tool, in a panel beside the tool bar: shape kinds, connector routes. */
function renderToolOptions() {
  const box = $('toolopts');
  const tool = S.board.tool;
  const opt = (ic, label, on, onclick) => h(`button.tool.small${on ? '.on' : ''}`, { type: 'button', title: label, 'aria-label': label, onclick }, icon(ic, 18));
  let items = null;
  if (tool === 'shape') {
    const cur = pref.get('shapeKind', 'rect');
    items = SHAPE_KINDS.map((k) => opt(KIND_ICON[k], t(`shape.${k}`), cur === k, () => { pref.set('shapeKind', k); renderToolbar(); }));
  } else if (tool === 'connector') {
    const cur = pref.get('connRoute', 'dubins');
    items = ROUTES.map((r) => opt(ROUTE_ICON[r], t(`route.${r}`), cur === r, () => { pref.set('connRoute', r); renderToolOptions(); }));
  } else if (INK_WIDTHS[tool]) items = inkOptions(tool);
  if (!items || !doc()) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.classList.toggle('ink', !!INK_WIDTHS[tool]);
  box.replaceChildren(...items);
  // next to the tool's button, inside the window
  const btn = [...$('toolbar').querySelectorAll('.tool')].find((b) => b.classList.contains('on'));
  if (btn) {
    const ui = currentUi();
    const r = btn.getBoundingClientRect();
    const tr = $('toolbar').getBoundingClientRect();
    const bh = box.getBoundingClientRect().height;
    box.style.left = `${(tr.right + 8) / ui}px`;
    box.style.top = `${Math.max(8, Math.min(innerHeight - bh - 8, r.top + r.height / 2 - bh / 2)) / ui}px`;
  }
}

/** A drawing tool's settings (this browser): colour, width preset, nib. */
function brush(tool) {
  const def = INK_DEFAULTS[tool] || INK_DEFAULTS.pen;
  const p = pref.get(`ink.${tool}`, {}) || {};
  return {
    tool,
    color: PAINT.includes(p.color) || isHexColor(p.color) ? p.color : def.color,
    width: INK_WIDTHS[tool]?.includes(p.width) ? p.width : def.width,
    nib: tool === 'pen' && p.nib === 'italic' ? 'italic' : undefined,
  };
}

function setBrush(tool, patch) {
  pref.set(`ink.${tool}`, { ...brush(tool), ...patch });
  renderToolOptions();
}

/** Pen / highlighter / tape options: nib (pen), width presets, colours. */
function inkOptions(tool) {
  const b = brush(tool);
  const btn = (cls, label, on, onclick, ...kids) => h(`button.${cls}${on ? '.on' : ''}`, { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(on), onclick }, ...kids);
  const parts = [];
  if (tool === 'pen') {
    parts.push(
      btn('tool.small', t('ink.round'), !b.nib, () => setBrush(tool, { nib: undefined }), h('span.nib-round')),
      btn('tool.small', t('ink.italic'), b.nib === 'italic', () => setBrush(tool, { nib: 'italic' }), h('span.nib-italic')),
      h('span.opt-sep'));
  }
  // widths: lines of the preset's thickness, one per row
  INK_WIDTHS[tool].forEach((w, i) => parts.push(btn('tool.small.wide', `${t('ink.width')} ${w}`, b.width === w, () => setBrush(tool, { width: w }), h('span.ink-line', { style: { height: `${1.5 + i * 1.5}px` } }))));
  parts.push(h('span.opt-sep'));
  for (const c of PAINT) parts.push(btn('ink-swatch', t(`paint.${c}`), b.color === c, () => { closeColorPicker(); setBrush(tool, { color: c }); }, h('span', { style: { background: INK_COLOR[c] } })));
  // a custom colour: a rainbow ring, filled with the colour once one is picked
  const custom = isHexColor(b.color);
  const well = btn('ink-swatch.custom', t('color.custom'), custom, (e) => openColorPicker(e.currentTarget, custom ? b.color : inkColor(b.color), (hex) => setBrush(tool, { color: hex }), { key: `ink-${tool}`, beside: $('toolopts') }),
    h('span', { style: custom ? { background: b.color } : {} }));
  well.dataset.cp = `ink-${tool}`;
  parts.push(well);
  return parts;
}

/** The brush a stroke starts with: its width as drawn now (presets are sizes on screen at this zoom). */
function strokeBrush(tool) {
  const b = brush(tool);
  return { ...b, width: b.width * inkScale(S.board.view.z) };
}

/** A finished stroke from the board (its brush from strokeBrush, so it ends as wide as it was drawn): added (one undo step); drawn over a group, it joins it. */
function addStroke(b, samples) {
  const width = b.width;
  if (b.tool === 'tape') {
    // a tape needs some length to show its torn ends
    let len = 0;
    for (let i = 1; i < samples.length; i++) len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    if (len < width * 0.6) return;
  }
  edit('draw', (d) => {
    const k = newStroke(d, { tool: b.tool, nib: b.nib, color: b.color, width, samples });
    const g = groupAround(d, k);
    if (g) patchItems(d, { [k.id]: { parent: g.id } });
  });
}

function renderMapBar() {
  const box = $('minimap');
  box.hidden = !doc();
  box.classList.toggle('collapsed', !S.showMap);
  const bar = box.querySelector('.mm-bar');
  const zoom = h('button.zoom-label', { type: 'button', title: t('zoom.menu') }, `${Math.round(S.board.view.z * 100)}%`);
  zoom.addEventListener('click', () => openMenu(zoom, zoomMenu(), { up: true, align: 'right' }));
  S.zoomLabel = zoom;
  bar.replaceChildren(
    iconBtn('minus', `${t('zoom.out')} (−)`, () => S.board.zoomCenter(1 / 1.5), 'mm-zoom'),
    zoom,
    iconBtn('plus', `${t('zoom.in')} (+)`, () => S.board.zoomCenter(1.5), 'mm-zoom'),
    iconBtn('fit', `${t('zoom.fit')} (Shift+1)`, () => S.board.fitAll()),
    iconBtn('magnet', t('zoom.snap'), () => { S.board.snap = !S.board.snap; pref.set('snap', S.board.snap); renderMapBar(); }, S.board.snap ? 'on' : ''),
    iconBtn('gridSnap', t('zoom.snapGrid'), () => { S.board.snapGrid = !S.board.snapGrid; pref.set('snapGrid', S.board.snapGrid); renderMapBar(); }, S.board.snapGrid ? 'on' : ''),
    iconBtn('map', `${t('zoom.map')} (M)`, () => toggleMap(), S.showMap ? 'on' : ''));
  if (S.showMap) S.minimap.contentChanged();
}

function toggleMap() {
  S.showMap = !S.showMap;
  pref.set('minimap', S.showMap);
  renderMapBar();
}

function zoomMenu() {
  return [
    { label: t('zoom.fit'), icon: 'fit', hint: 'Shift+1', onClick: () => S.board.fitAll() },
    { label: t('zoom.selection'), icon: 'focus', hint: 'Shift+2', onClick: () => S.board.fitSelection(), disabled: !S.board.selection.size },
    { label: '100%', hint: 'Shift+0', onClick: () => zoomTo(1) },
    { label: '50%', onClick: () => zoomTo(0.5) },
    { label: '200%', onClick: () => zoomTo(2) },
  ];
}

function zoomTo(z) { const { w, h: hh } = S.board.size; S.board.zoomAt(w / 2, hh / 2, z / S.board.view.z, true); }

function renderWelcome() {
  const w = $('welcome');
  if (doc()) { w.hidden = true; w.replaceChildren(); return; }
  w.hidden = false;
  const tile = (ic, title, sub, onclick) => h('button.tile', { type: 'button', onclick }, h('span.tile-ico', {}, icon(ic, 22)), h('b', {}, title), h('span', {}, sub));
  w.replaceChildren(...[
    h('div.empty-logo', {}, icon('logo', 30)),
    h('h1', {}, 'IluCanvas'),
    h('p.empty-sub', {}, t('welcome.sub')),
    h('div.tiles', {},
      tile('filePlus', t('side.new'), inBrowser() ? t('welcome.newLocal') : t('welcome.new'), newCanvas),
      inBrowser() ? null : tile('folder', t('side.openFolder'), t('welcome.folder'), openFolder),
      tile('file', t('side.openFile'), t('welcome.file'), openFile),
      tile('link', t('side.openLink'), t('welcome.link'), openLinkDialog)),
    disk.fsaSupported() ? null : h(`p.note${inBrowser() ? '' : '.warn'}`, {}, icon(inBrowser() ? 'save' : 'alert', 15), h('span', {}, inBrowser() ? t('welcome.local') : t('welcome.noFsa'))),
    h('a.agent-line', { href: 'llms.txt', target: '_blank', rel: 'noopener' }, icon('terminal', 14), h('span', {}, t('welcome.agents')), h('code', {}, 'llms.txt'))].filter(Boolean));
}

function setSidebar(open) {
  S.sidebar = open;
  if (!isNarrow()) pref.set('sidebar', open);
  render();
  S.board.invalidate();
}

// ---- opening ------------------------------------------------------------------------------------------

/** Before leaving the open canvas: save it, or ask. false = stay. */
async function leaveCurrent() {
  if (S.notes?.editing) S.notes.close();
  if (!S.store || !isDirty()) return true;
  if (S.store.writable) { await save(); return !isDirty() || confirmDialog({ title: t('leave.title'), text: t('leave.failed'), ok: t('leave.discard'), danger: true }); }
  return new Promise((resolve) => {
    let r = false;
    openDialog({
      title: t('leave.title'),
      body: h('p.dlg-text', {}, t('leave.text')),
      actions: [
        { spacer: true },
        { label: t('leave.discard'), kind: 'ghost', onClick: () => { r = true; } },
        { label: t('top.saveAs'), kind: 'primary', autofocus: true, onClick: async () => { await saveAs(); r = !isDirty(); } },
      ],
      onClose: () => resolve(r),
    });
  });
}

async function openSource(source, { active = null, link = null, readOnly: ro = false, view = null } = {}) {
  if (!(await leaveCurrent())) return false;
  const busy = toast(t('open.loading', { name: source.name }), { timeout: 0 });
  let store;
  try {
    store = await Store.open(source, { readOnly: ro });
  } catch (e) {
    busy.close();
    toast(t('open.failed', { msg: e.message }), { kind: 'error', timeout: 8000 });
    return false;
  }
  busy.close();
  await setStore(store, { active, link, view });
  return true;
}

async function setStore(store, { active = null, link = null, view = null } = {}) {
  clearTimeout(S.saveTimer);
  S.video?.close();
  S.store = store;
  S.undo = [];
  S.redo = [];
  S.rev = S.savedRev = 0;
  S.saveError = null;
  S.active = active;
  S.link = link;
  S.images.clear();
  const saved = view || (await disk.idbGet('views', store.doc.id))?.view;
  S.board.setDoc(store.doc, { readOnly: store.readOnly, view: saved || null });
  S.minimap.contentChanged();
  if (store.warnings?.length) toast(t('open.warnings', { n: store.warnings.length, first: store.warnings[0] }), { kind: 'warn', timeout: 7000 });
  if (store.kind === 'pur') toast(t('open.pur'), { timeout: 6000, action: { label: t('top.savePur'), onClick: saveAs } });
  if (isNarrow()) S.sidebar = false;
  render();
  growNotes();
  backgroundPreviews();
  const v = validate(store.doc, { files: store.index?.byName });
  if (!v.ok && store.kind === 'canvas') toast(t('open.invalid', { n: v.errors.length, first: `${v.errors[0].path}: ${v.errors[0].msg}` }), { kind: 'warn', timeout: 9000 });
}

async function openHandle(handle, { key, path } = {}) {
  try {
    const canWrite = /\.ilucanvas$/i.test(handle.name) ? await disk.ensurePermission(handle, 'readwrite') : false;
    if (!canWrite && !(await disk.ensurePermission(handle, 'read'))) throw new Error('permission');
    const src = disk.fsaSource(handle, path || handle.name);
    src.writable = canWrite;
    const rkey = await disk.rememberFile(handle, path || handle.name, handle.name.replace(/\.(ilucanvas|pur)$/i, ''));
    const ok = await openSource(src, { active: { kind: 'file', key: key || rkey, path: path || handle.name } });
    if (ok) await refreshRecent();
  } catch (e) {
    toast(e.message === 'permission' ? t('open.permission') : t('open.failed', { msg: e.message }), { kind: 'error' });
  }
}

async function openFile() {
  if (!disk.fsaSupported()) {
    let f;
    // iOS greys out files whose type it does not know: no filter there
    try { f = await disk.pickFileFallback(IOS ? '' : undefined); } catch { return; }
    if (inBrowser() && !/\.pur$/i.test(f.name)) return importToBrowser(f);
    await openSource(disk.memorySource(f.name, f), { active: { kind: 'file', key: `mem:${f.name}` }, readOnly: true });
    return;
  }
  let handles;
  try { handles = await disk.pickFiles(); } catch { return; }
  if (handles[0]) await openHandle(handles[0]);
}

async function openFolder() {
  if (!disk.fsaSupported()) { toast(t('welcome.noFsa'), { kind: 'warn' }); return; }
  let dir;
  try { dir = await disk.pickFolder(); } catch { return; }
  const key = await disk.rememberFolder(dir);
  let f = S.folders.find((x) => x.key === key);
  if (!f) { f = { key, handle: dir, name: dir.name, granted: true, files: [] }; S.folders.unshift(f); }
  f.granted = true;
  if (!S.sidebar) S.sidebar = true;
  await scanFolder(f, true);
  render();
  if (!f.files.length) toast(t('folder.empty', { name: dir.name }), { timeout: 6000, action: { label: t('side.new'), onClick: newCanvas } });
}

async function grantFolder(f) {
  if (await disk.ensurePermission(f.handle, 'readwrite')) { f.granted = true; await scanFolder(f, true); }
}

async function scanFolder(f, force = false) {
  if (!f.granted) return;
  try {
    const files = await disk.scanFolder(f.handle);
    const sig = files.map((x) => x.path).join('\n');
    if (!force && sig === f.sig) return;
    f.sig = sig;
    f.files = files;
    renderSidebar();
    loadCovers(files);
  } catch { f.granted = false; renderSidebar(); }
}

/** Cover pictures (preview.webp inside each canvas) for the boards bar. */
async function loadCovers(files) {
  for (const file of files) {
    if (!/\.ilucanvas$/i.test(file.name)) continue;
    try {
      const f = await file.handle.getFile();
      const key = `${file.path}:${f.lastModified}:${f.size}`;
      file.coverKey = key;
      if (S.covers.has(key)) continue;
      const bytes = await readPreview(blobReader(f));
      if (bytes) S.covers.set(key, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' })));
    } catch { /* no preview */ }
  }
  renderSidebar();
}

async function refreshRecent() {
  S.recent = (await disk.idbAll('recent')).sort((a, b) => b.at - a.at);
  renderSidebar();
}

async function closeCanvas() {
  if (!(await leaveCurrent())) return;
  S.video?.close();
  S.store = null;
  S.active = null;
  S.link = null;
  S.undo = [];
  S.redo = [];
  S.images.clear();
  S.board.setDoc(null);
  render();
}

/** New canvas: inside the open library folder, or wherever the user picks; unsaved if they cancel. */
async function newCanvas() {
  if (!(await leaveCurrent())) return;
  const title = t('new.title');
  const store = Store.blank(title);
  const folder = S.folders.find((f) => f.granted);
  try {
    if (folder) {
      const taken = new Set(folder.files.filter((x) => !x.path.includes('/')).map((x) => x.name.toLowerCase()));
      let name = `${title}.ilucanvas`;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${title} ${i}.ilucanvas`;
      store.doc.title = name.replace(/\.ilucanvas$/, '');
      const handle = await folder.handle.getFileHandle(name, { create: true });
      const src = disk.fsaSource(handle, `${folder.name}/${name}`);
      await store.save({ target: src });
      await setStore(store, { active: { kind: 'file', key: `${folder.key}:${name}`, path: src.path } });
      await scanFolder(folder, true);
      return;
    }
    if (inBrowser()) {
      try { await navigator.storage.persist?.(); } catch { /* best effort */ }
      const src = disk.localSource(disk.newLocalEntry(title));
      await store.save({ target: src });
      await setStore(store, { active: { kind: 'local', key: `local:${src.key}` } });
      await refreshLocal();
      return;
    }
    if (disk.fsaSupported()) {
      let handle = null;
      try { handle = await disk.pickSaveFile(`${title}.ilucanvas`); } catch { /* cancelled: an unsaved canvas */ }
      if (handle) {
        store.doc.title = handle.name.replace(/\.ilucanvas$/i, '');
        const src = disk.fsaSource(handle);
        await store.save({ target: src });
        const key = await disk.rememberFile(handle, handle.name, store.doc.title);
        await setStore(store, { active: { kind: 'file', key, path: handle.name } });
        await refreshRecent();
        return;
      }
    }
  } catch (e) {
    toast(t('save.failed', { msg: e.message }), { kind: 'error' });
  }
  await setStore(store, { active: { kind: 'new', key: 'new' } });
}

// ---- saving ---------------------------------------------------------------------------------------------

function scheduleSave(delay) {
  clearTimeout(S.saveTimer);
  const st = S.store;
  if (!st?.writable || !pref.get('autosave', true) || !isDirty()) return;
  const size = st.file?.size || 0;
  const d = delay ?? Math.min(20000, 800 + (size / (64 * 1024 * 1024)) * 1000);
  S.saveTimer = setTimeout(() => save(), d);
}

async function save() {
  const st = S.store;
  if (!st) return;
  if (!st.writable) return saveAs();
  if (S.saving) { S.saveAgain = true; return S.saving; }
  clearTimeout(S.saveTimer);
  S.saving = (async () => {
    renderTopbar();
    try {
      if (await st.changedOnDisk()) await absorbOutside(true);
      const rev = S.rev;
      const r = await st.save({ keep: historyFiles(), preview: await makePreview() });
      if (S.store === st) {
        S.savedRev = rev;
        S.saveError = null;
        if (r.mode === 'full' && r.size > 32 * 1024 * 1024) toast(t('save.compacted'), { kind: 'ok' });
      }
    } catch (e) {
      S.saveError = e.message === 'permission' ? t('open.permission') : e.message;
      toast(t('save.failed', { msg: S.saveError }), { kind: 'error', timeout: 8000, action: { label: t('top.saveAs'), onClick: saveAs } });
    } finally {
      S.saving = null;
      renderTopbar();
      updateDocTitle();
      if (S.saveAgain || (S.store === st && isDirty() && !S.saveError)) { S.saveAgain = false; scheduleSave(); }
    }
  })();
  return S.saving;
}

async function saveAs() {
  const st = S.store;
  if (!st) return;
  if (!disk.fsaSupported()) return inBrowser() && st.source?.kind !== 'local' ? keepInBrowser() : downloadCopy();
  let handle;
  try { handle = await disk.pickSaveFile(`${safeName(st.doc.title)}.ilucanvas`); } catch { return; }
  const busy = toast(t('save.writing'), { timeout: 0 });
  try {
    const src = disk.fsaSource(handle);
    if (st.kind === 'pur' || !st.source?.writable) st.doc.title = handle.name.replace(/\.ilucanvas$/i, '');
    await st.save({ target: src, preview: await makePreview() });
    S.savedRev = S.rev;
    S.saveError = null;
    S.link = null;
    const key = await disk.rememberFile(handle, handle.name, st.doc.title);
    S.active = { kind: 'file', key, path: handle.name };
    S.board.readOnly = false;
    await refreshRecent();
    for (const f of S.folders) scanFolder(f);
    toast(t('save.savedAs', { name: handle.name }), { kind: 'ok' });
  } catch (e) {
    toast(t('save.failed', { msg: e.message }), { kind: 'error', timeout: 8000 });
  } finally { busy.close(); render(); }
}

// ---- boards kept in this browser (no File System Access: Safari, Firefox) ----------------------------

async function refreshLocal() {
  S.local = (await disk.localBoards().catch(() => [])).map((e) => ({ ...e, path: `local:${e.key}` }));
  renderSidebar();
  loadCovers(S.local);
}

function openLocal(e) {
  return openSource(disk.localSource(e), { active: { kind: 'local', key: e.path || `local:${e.key}` } });
}

/** A .ilucanvas file picked without the API: copied into the browser and opened there, editable. */
async function importToBrowser(file) {
  if (!(await leaveCurrent())) return;
  const busy = toast(t('local.importing', { name: file.name }), { timeout: 0 });
  try {
    try { await navigator.storage.persist?.(); } catch { /* best effort */ }
    const e = await disk.importLocal(file);
    await refreshLocal();
    busy.close();
    await openLocal(S.local.find((x) => x.key === e.key) || { ...e, path: `local:${e.key}` });
    toast(t('local.imported'), { kind: 'ok', timeout: 7000 });
  } catch (err) {
    toast(t('open.failed', { msg: err.message }), { kind: 'error', timeout: 8000 });
  } finally { busy.close(); }
}

/** What is open (PureRef, a link, a new board), kept in this browser and editable from now on. */
async function keepInBrowser() {
  const st = S.store;
  if (!st) return;
  const busy = toast(t('save.writing'), { timeout: 0 });
  try {
    try { await navigator.storage.persist?.(); } catch { /* best effort */ }
    const src = disk.localSource(disk.newLocalEntry(st.doc.title));
    await st.save({ target: src, preview: await makePreview() });
    S.savedRev = S.rev;
    S.saveError = null;
    S.link = null;
    S.active = { kind: 'local', key: `local:${src.key}` };
    S.board.readOnly = false;
    await refreshLocal();
    toast(t('local.kept'), { kind: 'ok', timeout: 6000 });
  } catch (e) {
    toast(t('save.failed', { msg: e.message }), { kind: 'error', timeout: 8000 });
  } finally { busy.close(); render(); }
}

async function deleteLocal(e) {
  if (!(await confirmDialog({ title: t('local.delete'), text: t('local.deleteText', { name: e.title }), ok: t('local.delete'), danger: true }))) return;
  if (S.active?.key === e.path) {
    S.savedRev = S.rev; // it goes anyway: nothing to save
    await closeCanvas();
  }
  await disk.removeLocal(e);
  await refreshLocal();
}

async function downloadCopy() {
  const st = S.store;
  if (!st) return;
  const busy = toast(t('save.packing'), { timeout: 0 });
  try { disk.download(`${safeName(st.doc.title)}.ilucanvas`, await st.packBlob(await makePreview())); } catch (e) { toast(t('save.failed', { msg: e.message }), { kind: 'error' }); } finally { busy.close(); }
}

const safeName = (s) => String(s || 'Canvas').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Canvas';

/**
 * A canvas to draw on and its file: OffscreenCanvas, or a page canvas where there
 * is none (older Safari). blob(type, quality) → Blob.
 */
function canvas2d(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return Object.assign(c, { blob: (type, quality) => c.convertToBlob({ type, quality }) });
  }
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  return Object.assign(c, { blob: (type, quality) => new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('canvas'))), type, quality)) });
}

/** A small cover of the board for file lists (preview.webp; none where the browser cannot write WebP — Safari). */
async function makePreview() {
  const d = doc();
  const b = d && contentBounds(d);
  if (!b) return null;
  const W = 480;
  const H = 300;
  const c = canvas2d(W, H);
  const ctx = c.getContext('2d');
  const th = S.board.theme;
  ctx.fillStyle = th.canvas;
  ctx.fillRect(0, 0, W, H);
  const k = Math.min((W - 24) / b.w, (H - 24) / b.h);
  ctx.translate((W - b.w * k) / 2 - b.x * k, (H - b.h * k) / 2 - b.y * k);
  ctx.scale(k, k);
  for (const it of d.items) {
    if (it.type === 'group') { ctx.fillStyle = th.colors[it.color] || th.colors.grey; ctx.globalAlpha = 0.16; ctx.fillRect(it.x, it.y, it.w, it.h); ctx.globalAlpha = 1; }
  }
  for (const it of d.items) {
    if (it.type !== 'image') continue;
    const bmp = S.images.get(it.asset, 1);
    const bb = itemBounds(it);
    if (bmp) ctx.drawImage(bmp, bb.x, bb.y, bb.w, bb.h);
    else { ctx.fillStyle = d.assets[it.asset]?.color || '#555'; ctx.fillRect(bb.x, bb.y, bb.w, bb.h); }
  }
  try {
    const blob = await c.blob('image/webp', 0.7);
    return blob.type === 'image/webp' ? blob : null; // the old cover stays
  } catch { return null; }
}

// ---- outside changes (agents, other apps) ------------------------------------------------------------------

async function poll() {
  const st = S.store;
  if (!st || S.saving || S.board.drag || document.hidden) return;
  try {
    if (await st.changedOnDisk()) await absorbOutside(isDirty());
  } catch { /* file gone or busy: try again later */ }
}

/** The file changed on disk: read it again (merging local edits when there are any). */
async function absorbOutside(dirty) {
  if (S.notes?.editing) { S.notes.close(); dirty = isDirty(); }
  const st = S.store;
  const before = snapshot();
  const known = new Set(before.items.map((i) => i.id));
  const { conflicts } = await st.reload({ dirty });
  if (S.store !== st) return;
  S.board.doc = st.doc;
  S.undo.push({ label: 'outside', ...before });
  S.redo = [];
  if (!dirty) S.savedRev = S.rev + 1;
  changed({ save: dirty });
  const fresh = st.doc.items.filter((i) => !known.has(i.id)).map((i) => i.id);
  if (fresh.length) S.board.flash?.(fresh);
  const by = st.doc.updated_by === 'agent' ? t('ext.agent') : t('ext.someone');
  toast(conflicts.length ? t('ext.merged', { by, n: conflicts.length }) : t('ext.reloaded', { by }), { kind: conflicts.length ? 'warn' : 'info', action: { label: t('top.undo'), onClick: undo } });
  backgroundPreviews();
}

/**
 * Documents and text notes whose text is taller than their box (written by an
 * agent, or measured with other fonts) grow — not an undo step, saved quietly.
 */
function growNotes() {
  const d = doc();
  if (!d || !S.notes) return;
  const ids = d.items.filter((it) => it.type === 'note' && !it.fit).map((it) => it.id);
  if (!ids.length) return;
  if (S.notes.fitHeights(d, ids).length) {
    S.board.invalidate();
    S.minimap.contentChanged();
    if (S.store.writable) { S.rev++; scheduleSave(); renderTopbar(); }
  }
}

/** Make previews / colours for images that have none (added by the CLI, PureRef). */
async function backgroundPreviews() {
  const st = S.store;
  if (!st || S.previewJob === st) return;
  S.previewJob = st;
  try {
    for (;;) {
      const n = await st.fillMissingPreviews({ limit: 6 });
      if (!n || S.store !== st) break;
      S.board.invalidate();
      S.minimap.contentChanged();
      if (st.writable) { S.rev++; scheduleSave(); renderTopbar(); }
    }
  } finally { if (S.previewJob === st) S.previewJob = null; }
}

// ---- adding images ----------------------------------------------------------------------------------

/** Add image files at a world point (default: the middle of the screen). */
async function addImages(blobs, { at = null, group = null, select = true } = {}) {
  blobs = blobs.filter(Boolean);
  if (!blobs.length) return [];
  if (!S.store) await setStore(Store.blank(t('new.title')), { active: { kind: 'new', key: 'new' } });
  if (readOnly()) { toast(t('add.readonly'), { kind: 'warn', action: { label: t('top.saveAs'), onClick: saveAs } }); return []; }
  const st = S.store;
  const busy = blobs.length > 2 ? toast(t('add.progress', { done: 0, n: blobs.length }), { timeout: 0 }) : null;
  let res;
  try {
    res = await st.importImages(blobs, { onProgress: (done, n) => busy?.set(t('add.progress', { done, n })) });
  } finally { busy?.close(); }
  if (S.store !== st) return [];
  const ok = res.list.filter((x) => !x.error);
  const bad = res.list.filter((x) => x.error);
  if (bad.length) toast(t('add.unsupported', { n: bad.length, names: bad.slice(0, 3).map((x) => x.name).join(', ') }), { kind: 'warn', timeout: 7000 });
  if (!ok.length) return [];
  const { w, h: hh } = S.board.size;
  const p = at || S.board.toWorld(w / 2, hh / 2);
  const max = Math.max(200, Math.min(1200, 700 / S.board.view.z));
  const rects = dropLayout(ok.map((x) => fitSize(x.w, x.h, max)), p.x, p.y, { gap: Math.round(max * 0.04) });
  const items = ok.map((x, i) => ({ id: newId('image'), type: 'image', asset: x.id, ...rects[i] }));
  edit('add', (d) => {
    d.assets = { ...d.assets, ...res.assets };
    addItems(d, items);
    if (group) patchItems(d, Object.fromEntries(items.map((it) => [it.id, { parent: group }])));
    else reparent(d, items.map((it) => it.id));
    const m = byId(d);
    for (const g of new Set(items.map((it) => m.get(it.id)?.parent).filter(Boolean))) fitIfOutside(d, g);
  });
  if (select) S.board.select(items.map((it) => it.id));
  return items.map((it) => it.id);
}

/** Grow a group only when items stick out of it. */
function fitIfOutside(d, gid) {
  const g = byId(d).get(gid);
  const kids = unionBounds(childrenOf(d, gid).map(itemBounds));
  if (!g || !kids) return;
  if (kids.x < g.x || kids.y < g.y || kids.x + kids.w > g.x + g.w || kids.y + kids.h > g.y + g.h) {
    const pad = 16 / S.board.view.z;
    const u = unionBounds([g, { x: kids.x - pad, y: kids.y - pad, w: kids.w + pad * 2, h: kids.h + pad * 2 }]);
    patchItems(d, { [gid]: u });
  }
}

async function pickAndAdd() {
  const files = await disk.pickImages();
  if (files.length) await addImages(files);
}

/** Fetch an image from the web (works only where the site allows it). */
async function fetchImage(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  let name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'image');
  if (!/\.\w{2,5}$/.test(name)) name += `.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
  const f = new File([blob], name, { type: blob.type });
  f.source = url;
  return f;
}

/** A YouTube link being dropped or pasted, if that is what it is. */
function videoLinkFrom(dt) {
  const lines = [...(dt.getData?.('text/uri-list') || '').split('\n'), dt.getData?.('text/plain') || ''].map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => parseVideoUrl(l)) || null;
}

// ---- video ------------------------------------------------------------------------------------------------

/** The title (oEmbed) and the poster of a video, imported as an image asset: { title, asset, assets }. */
async function fetchVideoMeta(v) {
  const meta = {};
  try {
    const r = await fetch(oembedUrl(v.url));
    if (r.ok) meta.title = (await r.json()).title;
  } catch { /* offline: no title */ }
  for (const u of posterUrls(v.videoId)) {
    try {
      const blob = await fetchImage(u);
      const res = await S.store.importImages([new File([blob], `youtube-${v.videoId}.jpg`, { type: blob.type || 'image/jpeg' })]);
      const x = res.list[0];
      if (!x || x.error) continue;
      meta.asset = x.id;
      meta.assets = res.assets;
      break;
    } catch { /* the next size */ }
  }
  return meta;
}

/** A video card for a YouTube link, centred on board point `at`. */
async function addVideo(url, at = null) {
  if (!doc() || readOnly()) return null;
  const v = parseVideoUrl(url);
  if (!v) { toast(t('video.badLink'), { kind: 'warn' }); return null; }
  const busy = toast(t('video.loading'), { timeout: 0 });
  let meta = {};
  try { meta = await fetchVideoMeta(v); } finally { busy.close(); }
  const p = at || S.board.toWorld(S.board.size.w / 2, S.board.size.h / 2);
  const w = (v.short ? 360 : 640) * inkScale(S.board.view.z);
  const hh = v.short ? w * (16 / 9) : (w * 9) / 16;
  const it = edit('video', (d) => {
    if (meta.assets) d.assets = { ...d.assets, ...meta.assets };
    return newVideo(d, { url, meta, x: p.x - w / 2, y: p.y - hh / 2, w, h: hh });
  });
  if (it) S.board.select([it.id]);
  if (!meta.asset) toast(t('video.noPoster'), { kind: 'warn', timeout: 6000 });
  return it;
}

async function askVideo() {
  if (!doc() || readOnly()) return;
  const url = await promptDialog({ title: t('video.add'), label: t('video.link'), placeholder: 'https://youtu.be/…' });
  if (url && url.trim()) await addVideo(url.trim());
}

function imageUrlFrom(dt) {
  const html = dt.getData?.('text/html');
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && /^https?:/i.test(m[1])) return m[1];
  const uri = (dt.getData?.('text/uri-list') || '').split('\n').find((l) => /^https?:/i.test(l.trim()));
  if (uri) return uri.trim();
  const txt = (dt.getData?.('text/plain') || '').trim();
  return /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif|bmp)(\?\S*)?$/i.test(txt) ? txt : null;
}

/** Drop on the board: canvases open, folders and images are added, web images fetched. */
function dropData(dt, world) {
  // everything must be read from the DataTransfer before the first await
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const handles = items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
  const files = [...(dt.files || [])];
  const video = files.length ? null : videoLinkFrom(dt);
  const url = files.length || video ? null : imageUrlFrom(dt);
  (async () => {
    if (video) return addVideo(video, world);
    const hs = (await Promise.all(handles)).filter(Boolean);
    const board = hs.find((x) => x.kind === 'file' && disk.isBoardFile(x.name));
    if (board) return openHandle(board);
    const boardFile = files.find((f) => disk.isBoardFile(f.name));
    if (boardFile && !hs.length) {
      if (inBrowser() && !/\.pur$/i.test(boardFile.name)) return importToBrowser(boardFile);
      return openSource(disk.memorySource(boardFile.name, boardFile), { active: { kind: 'file', key: `mem:${boardFile.name}` }, readOnly: true });
    }
    const blobs = [];
    for (const x of hs) if (x.kind === 'directory') blobs.push(...(await disk.imagesInFolder(x, isImageName)));
    const dirNames = new Set(hs.filter((x) => x.kind === 'directory').map((x) => x.name));
    blobs.push(...files.filter((f) => !dirNames.has(f.name) && (f.type.startsWith('image/') || isImageName(f.name))));
    if (blobs.length) return addImages(blobs, { at: world });
    if (url) {
      try { return await addImages([await fetchImage(url)], { at: world }); } catch { toast(t('add.webBlocked'), { kind: 'warn', timeout: 8000 }); }
    }
    return null;
  })();
}

// ---- selection actions --------------------------------------------------------------------------------------

const sel = () => S.board.selectedItems();
const selIds = () => [...S.board.selection];
const selImages = () => sel().filter((it) => it.type === 'image');

function deleteSelection() {
  const ids = selIds();
  if (!ids.length) return;
  edit('delete', (d) => removeItems(d, ids));
  S.board.select([]);
}

function duplicateSelection() {
  const d = doc();
  const ids = selIds();
  if (!ids.length || readOnly()) return;
  const off = 24 / S.board.view.z;
  const all = withChildren(d, ids);
  const map = new Map();
  for (const it of d.items) if (all.has(it.id)) map.set(it.id, newId(it.type));
  const m = byId(d);
  const copies = copyItems(d.items.filter((it) => all.has(it.id)), map, off, off, { lookup: (id) => m.get(id) });
  edit('duplicate', (dd) => {
    dd.items = [...copies.filter((c) => c.type === 'group'), ...dd.items, ...copies.filter((c) => c.type !== 'group')];
  });
  S.board.select(ids.map((id) => map.get(id)));
}

function groupSelection() {
  const ids = sel().filter((it) => it.type !== 'group').map((it) => it.id);
  if (!ids.length) return;
  const n = groupsOf(doc()).length + 1;
  const g = edit('group', (d) => groupItems(d, ids, { name: t('group.name', { n }) }));
  if (g) { S.board.select([g.id]); setTimeout(() => renameGroup(g.id), 50); }
}

function ungroupSelection() {
  const groups = sel().filter((it) => it.type === 'group');
  if (!groups.length) return;
  const kids = groups.flatMap((g) => childrenOf(doc(), g.id).map((c) => c.id));
  edit('ungroup', (d) => { for (const g of groups) ungroup(d, g.id); });
  S.board.select(kids);
}

function arrangeSelection() {
  const s = sel();
  if (s.length === 1 && s[0].type === 'group') {
    const gid = s[0].id;
    edit('arrange', (d) => { arrangeItems(d, childrenOf(d, gid).map((c) => c.id)); fitGroup(d, gid); });
  } else {
    const ids = s.filter((it) => it.type === 'image').map((it) => it.id);
    if (ids.length < 2) return;
    edit('arrange', (d) => { arrangeItems(d, ids); for (const g of new Set(s.map((it) => it.parent).filter(Boolean))) fitIfOutside(d, g); });
  }
}

/** Items that turn: pictures, notes, shapes, ink (video players and frames do not). */
const TURNS = new Set(['image', 'note', 'shape', 'stroke']);
const selTurnable = () => sel().filter((it) => TURNS.has(it.type));

function patchSelection(label, fn, its = selImages()) {
  if (!its.length) return;
  edit(label, (d) => patchItems(d, Object.fromEntries(its.map((it) => [it.id, fn(it)]))));
}

const flip = (axis) => patchSelection('flip', (it) => ({ [axis]: !it[axis] }));
const rotate = (deg) => patchSelection('rotate', (it) => ({ rot: ((((it.rot || 0) + deg) % 360) + 360) % 360 || undefined }), selTurnable());

function naturalSize() {
  patchSelection('size', (it) => {
    const a = doc().assets[it.asset];
    const w = it.crop ? it.crop.w : a?.w;
    const hh = it.crop ? it.crop.h : a?.h;
    if (!(w > 0 && hh > 0)) return {};
    return { x: it.x + it.w / 2 - w / 2, y: it.y + it.h / 2 - hh / 2, w, h: hh };
  });
}

function sameHeight() {
  const its = selImages();
  if (its.length < 2) return;
  const target = its.reduce((n, it) => n + it.h, 0) / its.length;
  patchSelection('size', (it) => ({ w: (it.w * target) / it.h, h: target }));
}

function resetTransform() { patchSelection('reset', (it) => (it.type === 'image' ? { rot: undefined, flipX: undefined, flipY: undefined, opacity: undefined } : { rot: undefined }), selTurnable()); }

function toggleLock() {
  const its = sel();
  if (!its.length) return;
  const lock = !its.every((it) => it.locked);
  edit(lock ? 'lock' : 'unlock', (d) => patchItems(d, Object.fromEntries(its.map((it) => [it.id, { locked: lock || undefined }]))));
}

function restackSelection(where) {
  const ids = selIds();
  if (ids.length) edit('order', (d) => restack(d, ids, where));
}

function selectAll() {
  const d = doc();
  if (!d) return;
  S.board.select(d.items.filter((it) => !it.parent || !d.items.some((g) => g.id === it.parent)).map((it) => it.id));
}

function nudge(dx, dy) {
  const ids = selIds();
  if (!ids.length || readOnly()) return;
  const k = 1 / S.board.view.z;
  const before = snapshot();
  const d = doc();
  const all = withChildren(d, ids);
  d.items = d.items.map((it) => (all.has(it.id) && !it.locked ? { ...it, x: it.x + dx * k, y: it.y + dy * k } : it));
  // consecutive nudges are one undo step
  const last = S.undo[S.undo.length - 1];
  if (last?.label === 'nudge' && performance.now() - (S.lastNudge || 0) < 1000) changed();
  else commit('nudge', before);
  S.lastNudge = performance.now();
}

function renameGroup(id) {
  const g = byId(doc()).get(id);
  if (!g || readOnly()) return;
  const r = S.board.labelRects.find((x) => x.id === id);
  if (!r) {
    promptDialog({ title: t('group.rename'), value: g.name }).then((v) => { if (v !== null) edit('rename', (d) => patchItems(d, { [id]: { name: v.trim() || g.name } })); });
    return;
  }
  const st = $('stage').getBoundingClientRect();
  const u = currentUi();
  const input = h('input.rename-input', { type: 'text', value: g.name, spellcheck: false, style: { left: `${(st.left + r.x) / u}px`, top: `${(st.top + r.y - 1) / u}px`, width: `${Math.max(160, r.w / u + 40)}px` } });
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    if (ok && v && v !== g.name) edit('rename', (d) => patchItems(d, { [id]: { name: v } }));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  document.body.append(input);
  input.focus();
  input.select();
}

function setGroupColor(color) {
  const gs = sel().filter((it) => it.type === 'group');
  if (gs.length) edit('color', (d) => patchItems(d, Object.fromEntries(gs.map((g) => [g.id, { color }]))));
}

async function exportImages(items = selImages()) {
  const st = S.store;
  const ids = [...new Set(items.filter((it) => it.type === 'image').map((it) => it.asset))];
  if (!ids.length) return;
  if (ids.length === 1 || !disk.fsaSupported()) {
    for (const id of ids) { const f = await st.originalFile(id); if (f) disk.download(f.name, f); }
    return;
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'ilucanvas-export', mode: 'readwrite' }); } catch { return; }
  let n = 0;
  for (const id of ids) {
    const f = await st.originalFile(id);
    if (!f) continue;
    const fh = await dir.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f);
    await w.close();
    n++;
  }
  toast(t('export.done', { n, dir: dir.name }), { kind: 'ok' });
}

async function openOriginal(it) {
  const f = await S.store.originalFile(it.asset);
  if (f) window.open(URL.createObjectURL(f), '_blank', 'noopener');
}

// ---- clipboard ----------------------------------------------------------------------------------------------

async function copySelection({ cut = false } = {}) {
  const d = doc();
  const ids = selIds();
  if (!d || !ids.length) return;
  const all = withChildren(d, ids);
  const items = d.items.filter((it) => all.has(it.id));
  const assets = {};
  const blobs = new Map();
  for (const it of items) {
    if (!hasAsset(it) || assets[it.asset]) continue;
    assets[it.asset] = d.assets[it.asset];
    blobs.set(it.asset, await S.store.blob(it.asset, 'original'));
  }
  const nonce = `ilucanvas-clip:${Math.random().toString(36).slice(2)}`;
  S.clip = { items, assets, blobs, nonce, from: d.id };
  try {
    const imgs = items.filter((it) => it.type === 'image');
    if (imgs.length === 1 && 'ClipboardItem' in window) {
      // a single image also goes to the system clipboard (paste it into Photoshop etc.)
      const blob = blobs.get(imgs[0].asset);
      const png = blob.type === 'image/png' ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'text/plain': new Blob([nonce], { type: 'text/plain' }) })]);
    } else await navigator.clipboard.writeText(nonce);
  } catch { /* clipboard denied: the internal clipboard still works */ }
  if (cut) deleteSelection();
}

async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = canvas2d(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c.blob('image/png');
}

async function pasteClip(at) {
  const c = S.clip;
  const d = doc();
  if (!c || !d || readOnly()) return;
  // images from another canvas come in as new files
  const missing = Object.keys(c.assets).filter((id) => !d.assets[id]);
  let extraAssets = {};
  if (missing.length) {
    const blobs = [];
    for (const id of missing) {
      const b = c.blobs.get(id);
      if (!b) continue;
      try { await b.slice(0, 1).arrayBuffer(); blobs.push(new File([b], c.assets[id].name || 'image', { type: b.type })); } catch { /* source file changed since the copy */ }
    }
    const res = await S.store.importImages(blobs);
    extraAssets = res.assets;
  }
  const b = unionBounds(c.items.map(itemBounds));
  const p = at || S.mouse || S.board.toWorld(S.board.size.w / 2, S.board.size.h / 2);
  const dx = p.x - (b.x + b.w / 2);
  const dy = p.y - (b.y + b.h / 2);
  const map = new Map(c.items.map((it) => [it.id, newId(it.type)]));
  const here = c.from === d.id ? byId(d) : null;
  const copies = copyItems(c.items.filter((it) => it.type !== 'image' || d.assets[it.asset] || extraAssets[it.asset]), map, dx, dy, { lookup: here ? (id) => here.get(id) : null })
    .map((n) => (n.parent && !here ? (({ parent, ...rest }) => rest)(n) : n))
    .map((n) => (n.type === 'video' && n.asset && !d.assets[n.asset] && !extraAssets[n.asset] ? (({ asset, ...rest }) => rest)(n) : n)); // a poster that did not come along
  edit('paste', (dd) => {
    dd.assets = { ...dd.assets, ...extraAssets };
    dd.items = [...copies.filter((x) => x.type === 'group'), ...dd.items, ...copies.filter((x) => x.type !== 'group')];
    reparent(dd, copies.filter((x) => !x.parent).map((x) => x.id));
  });
  S.board.select(copies.filter((x) => !x.parent || !map.has(c.items.find((o) => map.get(o.id) === x.id)?.parent)).map((x) => x.id));
}

document.addEventListener('paste', async (e) => {
  if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  const text = dt.getData('text/plain');
  if (S.clip && text === S.clip.nonce) return pasteClip();
  if (!readOnly() && parseVideoUrl(text.trim())) return addVideo(text.trim(), S.mouse);
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
    return addImages(named, { at: S.mouse });
  }
  const url = imageUrlFrom(dt);
  if (url) { try { return await addImages([await fetchImage(url)], { at: S.mouse }); } catch { toast(t('add.webBlocked'), { kind: 'warn', timeout: 8000 }); return null; } }
  if (S.clip) return pasteClip();
  return null;
});

// ---- menus ---------------------------------------------------------------------------------------------

function canvasMenu() {
  const st = S.store;
  const dead = st?.index ? deadBytes(st.index, st.file.size) : 0;
  return [
    { label: t('menu.rename'), icon: 'pencil', disabled: readOnly(), onClick: async () => { const v = await promptDialog({ title: t('menu.rename'), value: doc().title }); if (v !== null && v.trim()) edit('title', (d) => { d.title = v.trim(); }); } },
    { label: t('menu.addImages'), icon: 'images', disabled: readOnly(), onClick: pickAndAdd },
    { sep: true },
    inBrowser() ? (st?.source?.kind === 'local' ? null : { label: t('top.keep'), icon: 'save', onClick: keepInBrowser }) : { label: t('top.saveAs'), icon: 'save', hint: 'Ctrl+Shift+S', onClick: saveAs, disabled: !disk.fsaSupported() },
    { label: t('menu.download'), icon: 'download', onClick: downloadCopy },
    { label: t('menu.exportAll'), icon: 'upload', onClick: () => exportImages(doc().items) },
    st?.writable && dead > 1024 * 1024 ? { label: t('menu.compact', { mb: (dead / 1048576).toFixed(1) }), icon: 'zip', onClick: compact } : null,
    st?.source && st.kind === 'canvas' && !S.link ? { label: t('menu.reload'), icon: 'refresh', onClick: () => reloadFromDisk() } : null,
    { label: t('menu.info'), icon: 'book', onClick: showInfo },
    { sep: true },
    { label: t('menu.close'), icon: 'x', onClick: closeCanvas },
  ];
}

async function compact() {
  const busy = toast(t('save.compacting'), { timeout: 0 });
  try {
    await S.store.save({ keep: historyFiles(), mode: 'full', preview: await makePreview() });
    S.savedRev = S.rev;
    toast(t('save.compacted'), { kind: 'ok' });
  } catch (e) { toast(t('save.failed', { msg: e.message }), { kind: 'error' }); } finally { busy.close(); renderTopbar(); }
}

async function reloadFromDisk() {
  if (isDirty() && !(await confirmDialog({ title: t('menu.reload'), text: t('reload.confirm'), ok: t('menu.reload'), danger: true }))) return;
  await openSource(S.store.source, { active: S.active, view: { ...S.board.view } });
}

function showInfo() {
  const st = S.store;
  const d = doc();
  const imgs = d.items.filter((i) => i.type === 'image').length;
  const bytes = st.file?.size || 0;
  const dead = st.index ? deadBytes(st.index, bytes) : 0;
  const v = validate(d, { files: st.index?.byName });
  const row = (k, val) => [h('dt', {}, k), h('dd', {}, val)];
  openDialog({
    title: d.title || t('untitled'),
    body: h('div.form', {},
      h('dl.kv', {},
        ...row(t('info.file'), st.source?.path || st.source?.name || t('state.noFile')),
        ...row(t('info.format'), st.kind === 'pur' ? `PureRef ${st.pur?.version || ''}` : 'IluCanvas (ZIP)'),
        ...row(t('info.images'), `${imgs} · ${Object.keys(d.assets).length} ${t('info.files')}`),
        ...row(t('info.groups'), String(groupsOf(d).length)),
        ...row(t('info.size'), `${(bytes / 1048576).toFixed(1)} MB${dead ? ` (${t('info.dead', { mb: (dead / 1048576).toFixed(1) })})` : ''}`),
        ...row(t('info.updated'), `${d.updated || '—'} · ${d.updated_by || '—'}`),
        ...row('id', d.id),
        ...row(t('info.check'), v.ok ? t('info.ok') : `${v.errors.length} ${t('info.errors')}: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.msg}`).join('; ')}`)),
      h('p.field-note', {}, t('info.zipNote'))),
    actions: [{ spacer: true }, { label: t('dlg.ok'), kind: 'primary' }],
  });
}

function contextMenu(pt, hit, world) {
  const d = doc();
  if (!d) return;
  const s = sel();
  const ro = readOnly();
  const imgs = s.filter((it) => it.type === 'image');
  const groups = s.filter((it) => it.type === 'group');
  if (!s.length) {
    openMenu(pt, [
      { label: t('ctx.paste'), icon: 'copy', hint: 'Ctrl+V', disabled: ro || !S.clip, onClick: () => pasteClip(world) },
      { label: t('menu.addImages'), icon: 'images', disabled: ro, onClick: pickAndAdd },
      { label: t('video.add'), icon: 'video', hint: 'Y', disabled: ro, onClick: askVideo },
      { sep: true },
      { label: t('zoom.fit'), icon: 'fit', hint: 'Shift+1', onClick: () => S.board.fitAll() },
      { label: t('ctx.selectAll'), hint: 'Ctrl+A', onClick: selectAll },
    ]);
    return;
  }
  const notes = s.filter((it) => it.type === 'note');
  const colorItems = groups.length ? GROUP_COLORS.map((c) => ({ label: t(`color.${c}`), swatch: S.board.theme.colors[c], checked: groups.every((g) => g.color === c), onClick: () => setGroupColor(c) })) : [];
  openMenu(pt, [
    imgs.length === 1 ? { label: t('ctx.zoomTo'), icon: 'focus', hint: 'Shift+2', onClick: () => S.board.fitSelection() } : { label: t('zoom.selection'), icon: 'focus', hint: 'Shift+2', onClick: () => S.board.fitSelection() },
    imgs.length === 1 ? { label: t('ctx.openOriginal'), icon: 'eye', onClick: () => openOriginal(imgs[0]) } : null,
    s.length === 1 && s[0].type === 'video' ? { label: t('video.play'), icon: 'play', onClick: () => S.video.play(s[0].id) } : null,
    s.length === 1 && s[0].type === 'video' ? { label: t('video.openYoutube'), icon: 'external', onClick: () => window.open(s[0].url + (s[0].start ? `&t=${Math.floor(s[0].start)}s` : ''), '_blank', 'noopener') } : null,
    !ro && notes.length === 1 && s.length === 1 ? { label: t('note.edit'), icon: 'pencil', hint: 'Enter', onClick: () => S.notes.open(notes[0].id) } : null,
    !ro && s.length === 1 && s[0].type === 'shape' ? { label: t('note.edit'), icon: 'pencil', hint: 'Enter', onClick: () => S.notes.open(s[0].id) } : null,
    !ro && s.length === 1 && s[0].type === 'connector' ? { label: t('conn.label'), icon: 'text', hint: 'Enter', onClick: () => S.notes.editLabel(s[0].id) } : null,
    !ro && notes.length && notes.length === s.length ? { label: t('note.sticky'), icon: 'sticky', onClick: () => S.notes.setKind('sticky') } : null,
    !ro && notes.length && notes.length === s.length ? { label: t('note.doc'), icon: 'doc', onClick: () => S.notes.setKind('doc') } : null,
    !ro && notes.length && notes.length === s.length ? { label: t('note.text'), icon: 'type', onClick: () => S.notes.setKind('text') } : null,
    { sep: true },
    groups.length === 1 && !ro ? { label: t('group.rename'), icon: 'pencil', hint: 'F2', onClick: () => renameGroup(groups[0].id) } : null,
    !ro && s.some((it) => it.type !== 'group') ? { label: t('ctx.group'), icon: 'frame', hint: 'Ctrl+G', onClick: groupSelection } : null,
    !ro && groups.length ? { label: t('ctx.ungroup'), icon: 'ungroup', hint: 'Ctrl+Shift+G', onClick: ungroupSelection } : null,
    !ro && (imgs.length > 1 || (groups.length === 1 && s.length === 1)) ? { label: t('ctx.arrange'), icon: 'arrange', hint: 'Shift+A', onClick: arrangeSelection } : null,
    !ro && groups.length === 1 && s.length === 1 ? { label: t('ctx.fitGroup'), icon: 'fit', onClick: () => edit('fit', (dd) => fitGroup(dd, groups[0].id)) } : null,
    ...(ro || !colorItems.length ? [] : [{ sep: true }, { title: t('ctx.color') }, ...colorItems]),
    { sep: true },
    !ro && imgs.length ? { label: t('ctx.flipH'), icon: 'flipH', hint: 'Shift+H', onClick: () => flip('flipX') } : null,
    !ro && imgs.length ? { label: t('ctx.flipV'), icon: 'flipV', hint: 'Shift+V', onClick: () => flip('flipY') } : null,
    !ro && s.some((it) => TURNS.has(it.type)) ? { label: t('ctx.rotateRight'), icon: 'rotate', hint: 'Shift+R', onClick: () => rotate(90) } : null,
    !ro && s.some((it) => TURNS.has(it.type)) ? { label: t('ctx.rotateLeft'), icon: 'rotateLeft', onClick: () => rotate(-90) } : null,
    !ro && s.some((it) => TURNS.has(it.type) && (it.rot || it.flipX || it.flipY)) ? { label: t('ctx.reset'), onClick: resetTransform } : null,
    !ro && imgs.length ? { label: t('ctx.natural'), onClick: naturalSize } : null,
    !ro && imgs.length > 1 ? { label: t('ctx.sameHeight'), onClick: sameHeight } : null,
    { sep: true },
    !ro ? { label: t('ctx.front'), icon: 'front', hint: ']', onClick: () => restackSelection('front') } : null,
    !ro ? { label: t('ctx.back'), icon: 'back', hint: '[', onClick: () => restackSelection('back') } : null,
    !ro ? { label: s.every((it) => it.locked) ? t('ctx.unlock') : t('ctx.lock'), icon: s.every((it) => it.locked) ? 'unlock' : 'lock', onClick: toggleLock } : null,
    { sep: true },
    { label: t('ctx.copy'), icon: 'copy', hint: 'Ctrl+C', onClick: () => copySelection() },
    !ro ? { label: t('ctx.duplicate'), hint: 'Ctrl+D', onClick: duplicateSelection } : null,
    imgs.length || groups.length ? { label: imgs.length === 1 && !groups.length ? t('ctx.saveImage') : t('ctx.exportImages'), icon: 'download', onClick: () => exportImages(s.flatMap((it) => (it.type === 'group' ? childrenOf(d, it.id) : [it]))) } : null,
    { sep: true },
    !ro ? { label: t('ctx.delete'), icon: 'trash', hint: 'Del', danger: true, onClick: deleteSelection } : null,
  ]);
}

function onDblClick(hit, e) {
  if (!doc()) return;
  if (hit.kind === 'label') return renameGroup(hit.id);
  const it = hit.id && byId(doc()).get(hit.id);
  if ((it?.type === 'note' || it?.type === 'shape') && !readOnly()) return S.notes.open(it.id);
  if (it?.type === 'connector' && !readOnly()) return S.notes.editLabel(it.id);
  if (it?.type === 'video') return S.video.play(it.id);
  if (hit.kind === 'item' || hit.kind === 'group') {
    if (it) S.board.fitBounds(itemBounds(it), true, { maxZ: 16, pad: 0.03 });
    return null;
  }
  if (hit.kind === 'none' && !readOnly() && S.board.tool === 'select') {
    const r = $('stage').getBoundingClientRect();
    S.notes.createText(S.board.toWorld(e.clientX - r.left, e.clientY - r.top));
  }
  return null;
}

// ---- links ------------------------------------------------------------------------------------------------

// the site's key (config.js): restricted to this site and to reading public Drive files
const apiKey = () => window.ILUCANVAS_CONFIG?.googleApiKey || '';

function linkErrorText(e) {
  const s = t(`linkErr.${e.code || 'http'}`, { msg: e.message });
  return s.startsWith('linkErr.') ? t('linkErr.http', { msg: e.message }) : s;
}

async function openLinkDialog() {
  const input = h('input.input', { type: 'url', placeholder: 'https://drive.google.com/file/d/…/view?usp=sharing', spellcheck: false });
  const note = h('div.field-note');
  const upd = () => {
    const l = remote.parseLink(input.value);
    note.textContent = !input.value ? t('link.hint') : !l ? t('link.bad') : l.kind === 'gdrive' && !apiKey() ? t('link.needKey') : l.kind === 'gdrive' ? t('link.drive') : t('link.url');
  };
  input.addEventListener('input', upd);
  upd();
  const go = async () => {
    const l = remote.parseLink(input.value);
    if (!l) { toast(t('link.bad'), { kind: 'error' }); return false; }
    if (l.kind === 'gdrive' && !apiKey()) { toast(t('linkErr.nokey'), { kind: 'error', timeout: 9000 }); return false; }
    dlg.close();
    const key = remote.linkKey(l);
    const known = S.links.find((x) => x.key === key);
    if (known) return openLink(known);
    await addLink(l, input.value.trim());
    return true;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const dlg = openDialog({
    title: t('side.openLink'),
    body: h('div.form', {}, h('label.field', {}, h('span.field-label', {}, t('link.label')), input, note), h('p.field-note', {}, t('link.about'))),
    actions: [{ spacer: true }, { label: t('dlg.cancel'), kind: 'ghost' }, { label: t('link.open'), kind: 'primary', onClick: async () => { await go(); return false; } }],
  });
  setTimeout(() => input.focus());
}

// A link's downloaded copy lives in the browser's storage (rec.opfsName) or in the
// folder picked in Settings (rec.dir + rec.fileName; a sync overwrites that file).
const linkPlace = (rec) => (rec.dir ? { dir: rec.dir, fileName: rec.fileName } : { opfsName: rec.opfsName });
const placeFields = (p) => ({ opfsName: p.opfsName || null, dir: p.dir || null, fileName: p.fileName || null });

/** The folder for downloads if one is set and may be written (asks the user: call it first thing after a click). */
async function linksTarget() {
  const dir = S.linksDir;
  if (!dir) return null;
  if (await disk.ensurePermission(dir, 'readwrite')) return dir;
  toast(t('linksDir.fallback', { name: dir.name }), { kind: 'warn', timeout: 9000 });
  return null;
}

async function downloadInto(l, record, dir) {
  const to = dir ? { dir, fileName: (await remote.sameFolder(record, dir)) ? record.fileName : null } : null;
  const prog = toast(t('link.downloading', { p: 0 }), { timeout: 0 });
  try {
    const r = await remote.downloadLink(l, apiKey(), { key: record?.key, to, onProgress: (got, total) => prog.set(total ? t('link.downloading', { p: Math.round((got / total) * 100) }) : t('link.downloadingMb', { mb: (got / 1048576).toFixed(1) })) });
    return r;
  } finally { prog.close(); }
}

async function addLink(l, url) {
  const dir = await linksTarget();
  let r;
  try { r = await downloadInto(l, null, dir); } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 10000 }); return; }
  const name = r.meta?.name || 'canvas.ilucanvas';
  const rec = { key: remote.linkKey(l), url, ...l, name, title: name.replace(/\.(ilucanvas|pur)$/i, ''), ...placeFields(r.place), version: r.meta?.version || null, modified: r.meta?.modified || null, size: r.meta?.size || 0, at: Date.now(), checkedAt: Date.now(), update: false };
  await disk.idbPut('links', rec);
  S.links = [rec, ...S.links.filter((x) => x.key !== rec.key)];
  await openLink(rec);
}

function linkSource(rec) {
  return {
    kind: 'cache', name: rec.name, path: rec.dir ? `${rec.dir.name}/${rec.fileName}` : rec.url, writable: false,
    getFile: () => remote.openStored(linkPlace(rec)),
    stat: async () => null,
    write: async () => { throw new Error('read only'); },
  };
}

async function openLink(rec, { view = null } = {}) {
  if (rec.dir && !(await disk.ensurePermission(rec.dir, 'readwrite'))) {
    // a folder needs the user's OK once per session, and that needs a click
    toast(t('linksDir.noAccess', { name: rec.dir.name }), { kind: 'warn', timeout: 12000, action: { label: t('linksDir.allow'), onClick: () => openLink(rec, { view }) } });
    return;
  }
  try { await remote.openStored(linkPlace(rec)); } catch {
    // the downloaded copy is gone (browser storage cleared, file deleted): download again
    try {
      const r = await downloadInto(rec, rec, await linksTarget());
      Object.assign(rec, { ...placeFields(r.place), version: r.meta?.version || rec.version, update: false });
      await disk.idbPut('links', rec);
    } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 10000 }); return; }
  }
  const ok = await openSource(linkSource(rec), { active: { kind: 'link', key: rec.key }, link: rec, readOnly: true, view });
  if (ok && S.store) {
    rec.title = S.store.doc.title || rec.title;
    disk.idbPut('links', rec);
    renderSidebar();
    checkLink(rec);
  }
}

async function forgetLink(rec) {
  const text = rec.dir ? t('link.forgetTextFolder', { name: rec.title, file: `${rec.dir.name}/${rec.fileName}` }) : t('link.forgetText', { name: rec.title });
  if (!(await confirmDialog({ title: t('link.forget'), text, ok: t('link.forget'), danger: true }))) return;
  await remote.removeStored(linkPlace(rec));
  await disk.idbDel('links', rec.key);
  S.links = S.links.filter((x) => x !== rec);
  if (S.active?.key === rec.key) { S.store = null; S.link = null; S.board.setDoc(null); render(); }
  renderSidebar();
}

async function checkLink(rec) {
  try {
    const meta = await remote.remoteMeta(rec, apiKey());
    rec.checkedAt = Date.now();
    if (meta?.version && rec.version && meta.version !== rec.version) rec.update = true;
    await disk.idbPut('links', rec);
  } catch { /* offline: try later */ }
  renderSidebar();
  if (S.link === rec) renderTopbar();
}

async function checkLinks() {
  for (const l of S.links) await checkLink(l);
}

async function syncLink(rec, manual = false) {
  const dir = await linksTarget();
  let meta = null;
  try { meta = await remote.remoteMeta(rec, apiKey()); } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 9000 }); return; }
  if (meta?.version && meta.version === rec.version && manual) {
    rec.update = false;
    toast(t('link.upToDate'), { kind: 'ok' });
    renderTopbar();
    renderSidebar();
    return;
  }
  let r;
  try { r = await downloadInto(rec, rec, dir); } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 10000 }); return; }
  const old = linkPlace(rec);
  Object.assign(rec, { ...placeFields(r.place), version: r.meta?.version || meta?.version || null, modified: r.meta?.modified || null, size: r.meta?.size || 0, update: false, at: Date.now() });
  await disk.idbPut('links', rec);
  if (S.active?.key === rec.key) await openLink(rec, { view: { ...S.board.view } });
  if (old.opfsName !== rec.opfsName) await remote.removeStored(old); // a copy in a folder is never deleted
  toast(t('link.synced'), { kind: 'ok' });
}

// ---- settings ---------------------------------------------------------------------------------------------

function openSettings() {
  const field = (label, control, note) => h('div.field', {}, h('span.field-label', {}, label), control, note ? h('span.field-note', {}, note) : null);
  const seg = (items, current, onPick) => {
    const box = h('div.seg');
    for (const [v, label] of items) {
      const b = h(`button.seg-btn${v === current ? '.on' : ''}`, { type: 'button' }, label);
      b.addEventListener('click', () => { box.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(v); });
      box.append(b);
    }
    return box;
  };
  const style = currentStyle();
  const picks = h('div.style-picks', { role: 'radiogroup' });
  for (const s of STYLES) {
    const b = h(`button.style-pick${s === style ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(s === style), dataset: { style: s } },
      h('span.style-swatch', { 'aria-hidden': 'true', style: { backgroundImage: tileUrl(STYLE_BACKGROUND[s], 'var(--pattern-ink)') } },
        h('span.sp-tag'), h('span.sp-frame'),
        h('span.sp-img', { style: { left: '18px', top: '22px', width: '34px', height: '24px', background: 'var(--sticky-2)' } }),
        h('span.sp-img', { style: { left: '56px', top: '22px', width: '22px', height: '36px', background: 'var(--sticky-1)' } }),
        h('span.sp-img', { style: { left: '96px', top: '30px', width: '40px', height: '30px', background: 'var(--sticky-3)' } })),
      h('span.style-name', {}, s.charAt(0).toUpperCase() + s.slice(1)),
      h('span.style-desc', {}, t(`style.${s}`)));
    b.addEventListener('click', () => {
      picks.querySelectorAll('.style-pick').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      pref.set('style', s);
      pref.set('bg', 'auto'); // a style brings its own background
      applyStyle();
      paintBgPicks();
    });
    picks.append(b);
  }
  // fix the swatch inks (CSS variables do not work inside data URLs)
  requestAnimationFrame(() => picks.querySelectorAll('.style-pick').forEach((b) => {
    const ink = getComputedStyle(b).getPropertyValue('--pattern-ink').trim();
    b.querySelector('.style-swatch').style.backgroundImage = tileUrl(STYLE_BACKGROUND[b.dataset.style], ink, 14);
  }));

  const bgs = h('div.bg-picks', { role: 'radiogroup' });
  const paintBgPicks = () => {
    const cur = currentBg();
    // a lighter ink than on the board: the swatches are small
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--text-faint').trim();
    bgs.replaceChildren(...BACKGROUNDS.map((k) => {
      const b = h(`button.bg-pick${k === cur ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(k === cur), title: t(`bg.${k}`) },
        h('span.bg-swatch', { style: { backgroundImage: k === 'plain' ? 'none' : tileUrl(k, ink, 14), backgroundSize: k === 'doodle' || k === 'garden' ? '120px' : '14px' } }),
        h('span.bg-name', {}, t(`bg.${k}`)));
      b.addEventListener('click', () => { pref.set('bg', k); applyStyle(); paintBgPicks(); });
      return b;
    }));
  };
  paintBgPicks();

  const autosave = h('label.check', {}, h('input', { type: 'checkbox', checked: pref.get('autosave', true), onchange: (e) => { pref.set('autosave', e.target.checked); if (e.target.checked) scheduleSave(); } }), t('settings.autosaveText'));

  const linksDir = h('div.links-dir');
  const paintLinksDir = () => {
    const pick = async () => {
      let dir;
      try { dir = await disk.pickLinksFolder(); } catch { return; } // cancelled
      S.linksDir = dir;
      await disk.idbPut('settings', { key: 'linksDir', handle: dir });
      paintLinksDir();
    };
    const reset = async () => { S.linksDir = null; await disk.idbDel('settings', 'linksDir'); paintLinksDir(); };
    linksDir.replaceChildren(...[
      h('span.links-dir-name', { title: S.linksDir?.name || '' }, icon(S.linksDir ? 'folder' : 'download', 16), h('span', {}, S.linksDir ? S.linksDir.name : t('linksDir.browser'))),
      disk.fsaSupported() ? h('button.btn.small', { type: 'button', onclick: pick }, S.linksDir ? t('linksDir.change') : t('linksDir.pick')) : null,
      S.linksDir ? h('button.btn.small.ghost', { type: 'button', onclick: reset }, t('linksDir.reset')) : null,
    ].filter(Boolean));
  };
  paintLinksDir();

  const body = h('div.form', {},
    field(t('settings.style'), picks),
    field(t('settings.background'), bgs, t('settings.bgNote')),
    field(t('settings.ui'), seg(UI_SCALES.map((v) => [v, `${Math.round(v * 100)}%`]), currentUi(), (v) => { pref.set('ui', v); applyUi(); })),
    field(t('settings.wheel'), seg([['zoom', t('settings.wheelZoom')], ['pan', t('settings.wheelPan')]], pref.get('wheel', 'zoom'), (v) => { pref.set('wheel', v); S.board.wheelMode = v; }), t('settings.wheelNote')),
    field(t('settings.autosave'), autosave),
    field(t('settings.linksDir'), linksDir, disk.fsaSupported() ? t('settings.linksDirNote') : t('settings.linksDirNoApi')),
    field(t('settings.language'), seg([['ru', 'Русский'], ['en', 'English']], getLang(), (v) => { pref.set('lang', v); setLang(v); dlg.close(); render(); openSettings(); })),
    h('div.about', {},
      h('span', {}, `IluCanvas ${APP_VERSION}`),
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, icon('github', 14), 'GitHub'),
      h('a', { href: 'docs/AGENT.md', target: '_blank', rel: 'noopener' }, icon('terminal', 14), 'AGENT.md'),
      h('a', { href: 'docs/FORMAT.md', target: '_blank', rel: 'noopener' }, icon('book', 14), 'FORMAT.md'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); showShortcuts(); } }, icon('more', 14), t('settings.keys'))));
  const dlg = openDialog({ title: t('settings.title'), body, wide: true, actions: [{ spacer: true }, { label: t('dlg.ok'), kind: 'primary' }] });
}

function showShortcuts() {
  const rows = [
    ['V / H', t('tool.select') + ' / ' + t('tool.hand')], [t('keys.space'), t('keys.pan')], [t('keys.wheel'), t('keys.zoom')],
    ['Shift+1 / Shift+2 / Shift+0', `${t('zoom.fit')} / ${t('zoom.selection')} / 100%`], ['Ctrl+G / Ctrl+Shift+G', `${t('ctx.group')} / ${t('ctx.ungroup')}`],
    ['Shift+A', t('ctx.arrange')], ['Shift+H / Shift+V', `${t('ctx.flipH')} / ${t('ctx.flipV')}`], ['Shift+R', t('ctx.rotateRight')],
    ['] / [', `${t('ctx.front')} / ${t('ctx.back')}`], ['Ctrl+C / Ctrl+V / Ctrl+D', `${t('ctx.copy')} / ${t('ctx.paste')} / ${t('ctx.duplicate')}`],
    ['Alt + ' + t('keys.drag'), t('keys.dupDrag')], ['Shift + ' + t('keys.drag'), t('keys.axis')], ['Del', t('ctx.delete')], ['Ctrl+Z / Ctrl+Shift+Z', `${t('top.undo')} / ${t('top.redo')}`],
    ['Ctrl+S', t('top.save')], ['Ctrl+B / M', `${t('side.collapse')} / ${t('zoom.map')}`], ['F2', t('group.rename')], [t('keys.dbl'), t('ctx.zoomTo')],
  ];
  openDialog({ title: t('settings.keys'), wide: true, body: h('dl.kv', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)])), actions: [{ spacer: true }, { label: t('dlg.ok'), kind: 'primary' }] });
}

// ---- keyboard -----------------------------------------------------------------------------------------

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const inDialog = !!document.querySelector('dialog[open]');
  if (mod && k === 's') { e.preventDefault(); if (!inDialog) { if (e.shiftKey) saveAs(); else save(); } return; }
  if (mod && k === 'o') { e.preventDefault(); if (!inDialog) openFile(); return; }
  if (inDialog || isTyping(e.target)) return;
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); S.board.zoomCenter(1.5); return; }
  if (mod && k === '-') { e.preventDefault(); S.board.zoomCenter(1 / 1.5); return; }
  if (mod && k === 'b') { e.preventDefault(); setSidebar(!S.sidebar); return; }
  if (!doc()) return;
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (mod && k === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return; }
  if (mod && k === 'c') { e.preventDefault(); copySelection(); return; }
  if (mod && k === 'x') { e.preventDefault(); if (!readOnly()) copySelection({ cut: true }); return; }
  if (mod || e.altKey) return;
  if (e.shiftKey) {
    if (e.code === 'Digit1') { e.preventDefault(); S.board.fitAll(); return; }
    if (e.code === 'Digit2') { e.preventDefault(); S.board.fitSelection(); return; }
    if (e.code === 'Digit0') { e.preventDefault(); zoomTo(1); return; }
    if (k === 'h') { e.preventDefault(); flip('flipX'); return; }
    if (k === 'v') { e.preventDefault(); flip('flipY'); return; }
    if (k === 'r') { e.preventDefault(); rotate(90); return; }
    if (k === 'a') { e.preventDefault(); arrangeSelection(); return; }
    if (k === 'p' && !readOnly()) { e.preventDefault(); setTool('highlighter'); return; }
  }
  switch (e.key) {
    case 'Delete': case 'Backspace': e.preventDefault(); if (!readOnly()) deleteSelection(); return;
    case 'Escape': if (S.board.tool !== 'select') setTool('select'); else S.board.select([]); closeMenu(); return;
    case 'Enter': {
      const s = sel();
      if (s.length === 1 && !readOnly()) {
        if (s[0].type === 'note' || s[0].type === 'shape') { e.preventDefault(); S.notes.open(s[0].id); }
        else if (s[0].type === 'connector') { e.preventDefault(); S.notes.editLabel(s[0].id); }
      }
      return;
    }
    case 'ArrowLeft': e.preventDefault(); nudge(e.shiftKey ? -10 : -1, 0); return;
    case 'ArrowRight': e.preventDefault(); nudge(e.shiftKey ? 10 : 1, 0); return;
    case 'ArrowUp': e.preventDefault(); nudge(0, e.shiftKey ? -10 : -1); return;
    case 'ArrowDown': e.preventDefault(); nudge(0, e.shiftKey ? 10 : 1); return;
    case ']': restackSelection('front'); return;
    case '[': restackSelection('back'); return;
    case '+': case '=': S.board.zoomCenter(1.5); return;
    case '-': case '_': S.board.zoomCenter(1 / 1.5); return;
    case 'F2': { const g = sel().find((it) => it.type === 'group'); if (g) { e.preventDefault(); renameGroup(g.id); } return; }
    default:
  }
  // typing on a selected empty note or shape starts its text
  {
    const s = sel();
    if (e.key.length === 1 && !readOnly() && s.length === 1 && (s[0].type === 'note' || s[0].type === 'shape') && !s[0].text) {
      e.preventDefault();
      S.notes.open(s[0].id);
      document.execCommand('insertText', false, e.key);
      return;
    }
  }
  if (e.shiftKey) return;
  if (k === 'v') setTool('select');
  else if (k === 'h') setTool('hand');
  else if (k === 'n' && !readOnly()) setTool('note');
  else if (k === 's' && !readOnly()) setTool('shape');
  else if (k === 'x' && !readOnly()) setTool('connector');
  else if (k === 'p' && !readOnly()) setTool('pen');
  else if (k === 't' && !readOnly()) setTool('tape');
  else if (k === 'e' && !readOnly()) setTool('eraser');
  else if (k === 'i' && !readOnly()) pickAndAdd();
  else if (k === 'y' && !readOnly()) askVideo();
  else if (k === 'm') toggleMap();
});

addEventListener('beforeunload', (e) => {
  if (isDirty() && (S.saving || !S.store?.writable || !pref.get('autosave', true))) { e.preventDefault(); e.returnValue = t('unload'); }
  else if (isDirty()) { save(); e.preventDefault(); e.returnValue = t('unload'); }
});

// ---- agent API (window.ilucanvas) ------------------------------------------------------------------------------

/** Agents that drive this page in a browser call these from the console. */
function agentApi() {
  const need = () => { if (!doc()) throw new Error('no canvas is open: ilucanvas.newCanvas(title) or open one in the boards bar'); };
  const urlAdder = async (o) => {
    const urls = [].concat(o.url || o.urls || []);
    if (!urls.length) throw new Error('in the browser, add takes "urls" (paths are for the CLI)');
    const blobs = [];
    for (const u of urls) blobs.push(await fetchImage(u));
    const res = await S.store.importImages(blobs);
    doc().assets = { ...doc().assets, ...res.assets };
    return res.list.filter((x) => !x.error).map((x) => ({ asset: x.id, w: x.w, h: x.h, name: x.name }));
  };
  return {
    version: APP_VERSION,
    help() {
      return [
        `IluCanvas ${APP_VERSION} — window.ilucanvas (docs: ${new URL('docs/AGENT.md', location.href)})`,
        'state()                        what is open: title, file, counts, selection, view',
        'list()                         groups and images as text (ids, names, positions)',
        'json()                         canvas.json of the open canvas',
        'apply(ops)                     batch ops, same as `ilucanvas apply` (add takes urls here) → { created, log }',
        'select(ids) / selection()      the selection',
        'zoomTo(ids | "all")            move the view',
        'addUrls(urls, { x, y, group }) fetch images (needs CORS) and add them',
        'save() / undo() / redo()',
        'newCanvas(title)               a new canvas (asks where to save it)',
      ].join('\n');
    },
    state() {
      const d = doc();
      return d ? {
        open: true, title: d.title, id: d.id, file: S.store.source?.path || null, kind: S.store.kind, readOnly: readOnly(), dirty: isDirty(),
        images: d.items.filter((i) => i.type === 'image').length, groups: groupsOf(d).length, selection: selIds(), view: { ...S.board.view },
      } : { open: false, folders: S.folders.map((f) => f.name), links: S.links.map((l) => l.title) };
    },
    list() { need(); return listText(doc()); },
    json() { need(); return serialize(doc()); },
    async apply(ops) {
      need();
      if (readOnly()) throw new Error('this canvas is read only');
      const before = snapshot();
      let r;
      const videoMeta = async (v) => { const m = await fetchVideoMeta(v); if (m.assets) doc().assets = { ...doc().assets, ...m.assets }; return m; };
      try { r = await applyOps(doc(), ops, { by: 'agent', addImages: urlAdder, videoMeta }); } catch (e) { restore(before); throw e; }
      S.notes.fitHeights(doc(), r.created);
      commit('agent', before);
      return r;
    },
    async addUrls(urls, { x, y, group } = {}) { return this.apply([{ op: 'add', urls: [].concat(urls), x, y, group }]); },
    select(ids) { need(); S.board.select([].concat(ids)); return selIds(); },
    selection() { return selIds(); },
    zoomTo(ids = 'all') {
      need();
      // at once, not animated: an agent reads the view right after
      if (ids === 'all') S.board.fitAll(false);
      else { const m = byId(doc()); const b = unionBounds([].concat(ids).map((id) => m.get(id)).filter(Boolean).map(itemBounds)); if (b) S.board.fitBounds(b, false, { maxZ: 8 }); }
      return { ...S.board.view };
    },
    /** Renderer numbers: decoded images, memory, last frame time. */
    perf({ draw = false } = {}) {
      const frame = draw ? S.board.drawNow() : { ...S.board.stats };
      if (draw && S.showMap) S.minimap.draw();
      return { images: S.images.stats(), frame, minimap: { ...S.minimap.stats }, failed: [...S.images.failed.entries()] };
    },
    save: () => save(),
    undo: () => undo(),
    redo: () => redo(),
    newCanvas: () => newCanvas(),
  };
}

// ---- demo board ------------------------------------------------------------------------------------------

/** ?demo or ?demo=N: a board of generated pictures (for trying things out, and for load tests). */
async function demo(n) {
  const store = Store.blank(t('demo.title'));
  await setStore(store, { active: { kind: 'new', key: 'demo' } });
  const files = [];
  const big = n <= 60;
  for (let i = 0; i < n; i++) {
    const ar = [1.5, 0.75, 1, 1.78, 0.66, 1.33][i % 6];
    const W = big ? 1200 : 360;
    const c = canvas2d(Math.round(W * Math.min(1, ar)), Math.round((W / ar) * Math.min(1, ar)));
    const ctx = c.getContext('2d');
    const hh = (i * 47) % 360;
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, `hsl(${hh} 55% 62%)`);
    g.addColorStop(1, `hsl(${(hh + 60) % 360} 50% 28%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    for (let s = 0; s < 6; s++) {
      ctx.fillStyle = `hsla(${(hh + s * 40) % 360} 70% ${40 + s * 8}% / 0.55)`;
      ctx.beginPath();
      ctx.arc(((s * 97 + i * 13) % c.width), ((s * 61 + i * 29) % c.height), (c.width / 6) * (1 + (s % 3) / 2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `700 ${Math.round(c.width / 8)}px sans-serif`;
    ctx.fillText(`#${i + 1}`, c.width * 0.06, c.height * 0.94);
    files.push(new File([await c.blob('image/jpeg', 0.85)], `demo-${String(i + 1).padStart(4, '0')}.jpg`, { type: 'image/jpeg' }));
  }
  const per = Math.ceil(n / 3);
  let x = 0;
  for (let gi = 0; gi < 3; gi++) {
    const part = files.slice(gi * per, (gi + 1) * per);
    if (!part.length) continue;
    const ids = await addImages(part, { at: { x: x + 1e6, y: 0 }, select: false }); // away from the other groups, moved in below
    edit('arrange', (d) => {
      const m = byId(d);
      const b = unionBounds(ids.map((id) => itemBounds(m.get(id))));
      arrangeItems(d, ids, { aspect: 0.9 });
      const b2 = unionBounds(ids.map((id) => itemBounds(byId(d).get(id))));
      patchItems(d, Object.fromEntries(ids.map((id) => { const it = byId(d).get(id); return [id, { x: it.x + x - b2.x, y: it.y - b2.y }]; })));
      const g = groupItems(d, ids, { name: t(`demo.group${gi + 1}`) });
      x = g.x + g.w + Math.max(200, b.h * 0.1);
    });
  }
  S.board.fitAll(false);
}

// ---- start ---------------------------------------------------------------------------------------------

async function start() {
  setLang(pref.get('lang', null) || (/^ru\b/i.test(navigator.language || '') ? 'ru' : 'en'));
  document.documentElement.dataset.style = currentStyle();
  const stage = $('stage');
  S.images = new ImageCache({
    resolve: (id, kind) => S.store?.blob(id, kind) ?? null,
    natural: (id) => { const a = doc()?.assets[id]; return a ? Math.max(a.w || 0, a.h || 0) : 0; },
    onLoad: () => S.board.invalidate(), // the minimap shows silhouettes: images loading do not change it
  });
  S.board = new Board({
    stage, scene: $('scene'), overlay: $('overlay'), images: S.images,
    cb: {
      commit: (label, items, assets) => {
        if (label === 'resize') S.notes.fitHeights(doc(), [...S.board.selection]);
        commit(label, { items, assets: assets || doc().assets, title: doc().title });
      },
      selection: () => S.notes?.render(),
      create: (tool, where, o) => (tool === 'shape' ? S.notes.createShape(where, o) : S.notes.create(where, o)),
      connect: (from, to) => S.notes.connect(from, to),
      playVideo: (id) => S.video.play(id),
      brush: strokeBrush,
      stroke: addStroke,
      toggleTask: (id, block) => S.notes.toggleTask(id, block),
      pointerDown: () => { if (S.notes.editing) S.notes.close(); },
      view: () => {
        drawBackground();
        S.notes?.editor.reposition();
        S.minimap.invalidate();
        if (S.zoomLabel) S.zoomLabel.textContent = `${Math.round(S.board.view.z * 100)}%`;
        clearTimeout(S.viewTimer);
        S.viewTimer = setTimeout(() => { const d = doc(); if (d) disk.idbPut('views', { id: d.id, view: { ...S.board.view } }); }, 600);
      },
      contextMenu,
      dblclick: onDblClick,
      dropFiles: dropData,
      insets: () => { const u = currentUi(); return { left: ((S.sidebar && !isNarrow() ? 292 : 0) + 64) * u, right: 0, top: 64 * u, bottom: 0 }; },
      drawn: () => { S.notes?.place(); if (S.video?.open) S.video.place(); },
    },
  });
  S.board.wheelMode = pref.get('wheel', 'zoom');
  S.board.snap = pref.get('snap', true);
  S.board.snapGrid = pref.get('snapGrid', true);
  S.notes = new NotesUI({
    board: S.board, doc, edit, readOnly, pref, setTool,
  }, { layer: $('editlayer'), bar: $('selbar') });
  S.video = new VideoPlayer({ board: S.board, doc, edit, silent, readOnly, toast }, $('videolayer'));
  applyUi();
  S.bg = new Background($('bg'));
  S.bg.onReady = drawBackground;
  S.minimap = new Minimap($('minimap').querySelector('canvas'), S.board);
  new ResizeObserver(() => drawBackground()).observe(stage);
  stage.addEventListener('pointermove', (e) => { const r = stage.getBoundingClientRect(); S.mouse = S.board.toWorld(e.clientX - r.left, e.clientY - r.top); });
  $('scrim').addEventListener('click', () => setSidebar(false));
  if (isNarrow()) S.sidebar = false;
  applyStyle();
  // text is measured with the real fonts: measure again once they are in
  const fontsIn = () => { resetTextCache(); S.board.setTheme(); growNotes(); };
  document.fonts?.ready.then(fontsIn);
  document.fonts?.addEventListener?.('loadingdone', fontsIn);
  render();
  window.ilucanvas = agentApi();

  // remembered folders, files, links
  S.recent = (await disk.idbAll('recent')).sort((a, b) => b.at - a.at);
  S.links = (await disk.idbAll('links')).sort((a, b) => b.at - a.at);
  S.linksDir = disk.fsaSupported() ? (await disk.idbGet('settings', 'linksDir'))?.handle || null : null;
  S.folders = (await disk.idbAll('folders')).sort((a, b) => b.at - a.at).map((f) => ({ ...f, granted: false, files: [] }));
  for (const f of S.folders) { f.granted = await disk.hasPermission(f.handle); if (f.granted) await scanFolder(f, true); }
  if (opfsSupported()) await refreshLocal();
  S.server = await disk.detectServer();
  if (S.server) { try { S.serverFiles = await disk.serverList(); } catch { S.serverFiles = []; } }
  render();

  // files opened with the installed app (double click on .ilucanvas / .pur)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer((params) => { if (params.files?.[0]) openHandle(params.files[0]); });
  }
  const params = new URLSearchParams(location.search);
  if (S.server && params.get('file')) {
    const p = params.get('file');
    await openSource(disk.serverSource(p), { active: { kind: 'server', key: `server:${p}`, path: p } });
  } else if (params.has('demo')) await demo(Math.max(1, Math.min(20000, Number(params.get('demo')) || 24)));
  else if (params.get('link')) {
    const l = remote.parseLink(params.get('link'));
    if (l) { const known = S.links.find((x) => x.key === remote.linkKey(l)); if (known) await openLink(known); else await addLink(l, params.get('link')); }
  }

  setInterval(poll, 2000);
  setInterval(() => { for (const f of S.folders) scanFolder(f); }, 15000);
  setInterval(checkLinks, 5 * 60 * 1000);
  setTimeout(checkLinks, 4000);
  document.addEventListener('visibilitychange', () => {
    // hidden: save now — iPad / iPhone may close a tab in the background
    if (document.hidden) { if (S.store?.writable && isDirty() && pref.get('autosave', true)) save(); return; }
    poll();
    for (const f of S.folders) scanFolder(f);
  });
  addEventListener('resize', () => { const n = isNarrow(); if (n !== S.wasNarrow) { S.wasNarrow = n; S.sidebar = n ? false : pref.get('sidebar', true); render(); } });
  S.wasNarrow = isNarrow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();

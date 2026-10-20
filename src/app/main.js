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
  pruneAssets,
} from '../core/model.js';
import { applyOps } from '../core/ops.js';
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
import * as disk from './disk.js';
import * as remote from './remote.js';

const $ = (id) => document.getElementById(id);
const REPO_URL = 'https://github.com/ilumetric/IluCanvas';
const STYLES = ['fun', 'calm', 'oli'];

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
  active: null, // { kind: 'file' | 'link' | 'new' | 'server', key, path }
  link: null, // the link record of the open canvas
  folders: [], // { key, handle, name, granted, files: [{ path, name, handle }] }
  recent: [],
  links: [],
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
  S.board?.setTheme();
  drawBackground();
  S.minimap?.contentChanged();
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

function changed({ save = true } = {}) {
  S.rev++;
  S.board.pruneSelection();
  S.board.invalidate();
  S.minimap.contentChanged();
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
  const used = new Set(d.items.filter((it) => it.type === 'image').map((it) => it.asset));
  pruneAssets(d, used);
  const keep = new Set();
  for (const s of [...S.undo, ...S.redo]) {
    for (const it of s.items) {
      const a = it.type === 'image' && !used.has(it.asset) && s.assets[it.asset];
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

function boardRow({ title, sub, active, onOpen, onRemove, removeTitle, update, entry }) {
  const row = h(`div.board-row${active ? '.active' : ''}`, { role: 'button', tabindex: 0, title: sub || title },
    coverNode(entry),
    h('span.grow', {}, h('span.board-name.ellipsis', {}, title), sub ? h('span.board-path', {}, sub) : null),
    update ? h('span.badge-dot', { title: t('link.updateAvailable') }) : null,
    onRemove ? iconBtn('x', removeTitle || t('side.forget'), (e) => { e.stopPropagation(); onRemove(); }, 'tiny') : null);
  row.addEventListener('click', () => { if (!active) onOpen(); });
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !active) onOpen(); });
  return row;
}

function renderSidebar() {
  const side = $('sidebar');
  if (!S.sidebar) { side.replaceChildren(); return; }
  const item = (ic, label, onclick, { kbd, disabled } = {}) => h('button.side-item', { type: 'button', onclick, disabled },
    icon(ic), h('span.grow.ellipsis', {}, label), kbd ? h('kbd', {}, kbd) : null);
  const nav = h('nav.side-nav', {},
    item('filePlus', t('side.new'), newCanvas),
    S.server ? null : item('folder', t('side.openFolder'), openFolder, { disabled: !disk.fsaSupported() }),
    item('file', t('side.openFile'), openFile, { kbd: 'Ctrl O' }),
    item('link', t('side.openLink'), openLinkDialog));

  const scroll = h('div.side-scroll');
  const activeKey = S.active?.key;

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
      sec.append(boardRow({ title, sub: dir || (/\.pur$/i.test(file.name) ? 'PureRef' : null), active: key === activeKey, entry: { ...file, coverKey: file.coverKey }, onOpen: () => openHandle(file.handle, { key, path: `${f.name}/${file.path}` }) }));
    }
    scroll.append(sec);
  }

  // dev server files
  if (S.server && S.serverFiles?.length) {
    const sec = h('div.side-section', {}, h('div.side-label', {}, icon('terminal', 15), h('span', {}, S.server.folder)));
    for (const p of S.serverFiles) {
      sec.append(boardRow({ title: p.split('/').pop().replace(/\.(ilucanvas|pur)$/i, ''), sub: p, active: activeKey === `server:${p}`, entry: { name: p }, onOpen: () => openSource(disk.serverSource(p), { active: { kind: 'server', key: `server:${p}`, path: p } }) }));
    }
    scroll.append(sec);
  }

  // shared links
  if (S.links.length) {
    const sec = h('div.side-section', {}, h('div.side-label', {}, icon('cloud', 15), h('span', {}, t('side.links'))));
    for (const l of S.links) {
      sec.append(boardRow({
        title: l.title || l.name, sub: l.kind === 'gdrive' ? 'Google Drive' : new URL(l.url).hostname, active: activeKey === l.key, update: l.update, entry: { name: l.name, title: l.title, coverKey: l.coverKey },
        onOpen: () => openLink(l), onRemove: () => forgetLink(l), removeTitle: t('link.forget'),
      }));
    }
    scroll.append(sec);
  }

  // recent files
  const inFolders = new Set(S.folders.flatMap((f) => f.files.map((x) => `${f.name}/${x.path}`)));
  const recent = S.recent.filter((r) => !inFolders.has(r.path)).slice(0, 8);
  const rec = h('div.side-section', {}, h('div.side-label', {}, h('span', {}, t('side.recent'))));
  if (!recent.length && !S.folders.length && !S.links.length) rec.append(h('div.side-hint', {}, t('side.recentEmpty')));
  for (const r of recent) {
    rec.append(boardRow({
      title: r.title || r.path, sub: r.path, active: activeKey === r.key, entry: { name: r.path, title: r.title, coverKey: r.coverKey },
      onOpen: () => openHandle(r.handle, { key: r.key, path: r.path }), onRemove: async () => { await disk.idbDel('recent', r.key); await refreshRecent(); },
    }));
  }
  if (recent.length || (!S.folders.length && !S.links.length)) scroll.append(rec);

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
      right.append(h('button.btn.primary', { type: 'button', disabled: !isDirty() && !S.saveError, onclick: () => save(), title: 'Ctrl+S' }, icon('save', 16), t('top.save')));
    } else {
      right.append(h('button.btn.primary', { type: 'button', onclick: () => saveAs(), title: 'Ctrl+Shift+S' }, icon(disk.fsaSupported() ? 'save' : 'download', 16), S.store.kind === 'pur' ? t('top.savePur') : disk.fsaSupported() ? t('top.saveAs') : t('top.download')));
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
  tb.replaceChildren(tool('select', 'pointer', t('tool.select'), 'V'), tool('hand', 'hand', t('tool.hand'), 'H'));
}

function setTool(id) {
  S.board.setTool(id);
  renderToolbar();
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
    iconBtn('minus', `${t('zoom.out')} (−)`, () => S.board.zoomCenter(1 / 1.5)),
    zoom,
    iconBtn('plus', `${t('zoom.in')} (+)`, () => S.board.zoomCenter(1.5)),
    iconBtn('fit', `${t('zoom.fit')} (Shift+1)`, () => S.board.fitAll()),
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
      tile('filePlus', t('side.new'), t('welcome.new'), newCanvas),
      tile('folder', t('side.openFolder'), t('welcome.folder'), openFolder),
      tile('file', t('side.openFile'), t('welcome.file'), openFile),
      tile('link', t('side.openLink'), t('welcome.link'), openLinkDialog)),
    disk.fsaSupported() ? null : h('p.note.warn', {}, icon('alert', 15), h('span', {}, t('welcome.noFsa'))),
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
    try {
      const f = await disk.pickFileFallback();
      await openSource(disk.memorySource(f.name, f), { active: { kind: 'file', key: `mem:${f.name}` }, readOnly: true });
    } catch { /* cancelled */ }
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
  if (!disk.fsaSupported()) return downloadCopy();
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

async function downloadCopy() {
  const st = S.store;
  if (!st) return;
  const busy = toast(t('save.packing'), { timeout: 0 });
  try { disk.download(`${safeName(st.doc.title)}.ilucanvas`, await st.packBlob(await makePreview())); } catch (e) { toast(t('save.failed', { msg: e.message }), { kind: 'error' }); } finally { busy.close(); }
}

const safeName = (s) => String(s || 'Canvas').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Canvas';

/** A small cover of the board for file lists (preview.webp). */
async function makePreview() {
  const d = doc();
  const b = d && contentBounds(d);
  if (!b || typeof OffscreenCanvas === 'undefined') return null;
  const W = 480;
  const H = 300;
  const c = new OffscreenCanvas(W, H);
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
  try { return await c.convertToBlob({ type: 'image/webp', quality: 0.7 }); } catch { return null; }
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
  const url = files.length ? null : imageUrlFrom(dt);
  (async () => {
    const hs = (await Promise.all(handles)).filter(Boolean);
    const board = hs.find((x) => x.kind === 'file' && disk.isBoardFile(x.name));
    if (board) return openHandle(board);
    const boardFile = files.find((f) => disk.isBoardFile(f.name));
    if (boardFile && !hs.length) return openSource(disk.memorySource(boardFile.name, boardFile), { active: { kind: 'file', key: `mem:${boardFile.name}` }, readOnly: true });
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
  const copies = d.items.filter((it) => all.has(it.id)).map((it) => {
    const c = { ...it, id: map.get(it.id), x: it.x + off, y: it.y + off };
    if (it.parent && map.has(it.parent)) c.parent = map.get(it.parent);
    return c;
  });
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

function patchSelection(label, fn) {
  const its = selImages();
  if (!its.length) return;
  edit(label, (d) => patchItems(d, Object.fromEntries(its.map((it) => [it.id, fn(it)]))));
}

const flip = (axis) => patchSelection('flip', (it) => ({ [axis]: !it[axis] }));
const rotate = (deg) => patchSelection('rotate', (it) => ({ rot: ((((it.rot || 0) + deg) % 360) + 360) % 360 || undefined }));

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

function resetTransform() { patchSelection('reset', () => ({ rot: undefined, flipX: undefined, flipY: undefined, opacity: undefined })); }

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
  const input = h('input.rename-input', { type: 'text', value: g.name, spellcheck: false, style: { left: `${st.left + r.x}px`, top: `${st.top + r.y - 1}px`, width: `${Math.max(160, r.w + 40)}px` } });
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
    if (it.type !== 'image' || assets[it.asset]) continue;
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
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c.convertToBlob({ type: 'image/png' });
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
  const copies = c.items.filter((it) => it.type !== 'image' || d.assets[it.asset] || extraAssets[it.asset]).map((it) => {
    const n = { ...it, id: map.get(it.id), x: it.x + dx, y: it.y + dy };
    if (it.parent) { if (map.has(it.parent)) n.parent = map.get(it.parent); else delete n.parent; }
    return n;
  });
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
    { label: t('top.saveAs'), icon: 'save', hint: 'Ctrl+Shift+S', onClick: saveAs, disabled: !disk.fsaSupported() },
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
      { sep: true },
      { label: t('zoom.fit'), icon: 'fit', hint: 'Shift+1', onClick: () => S.board.fitAll() },
      { label: t('ctx.selectAll'), hint: 'Ctrl+A', onClick: selectAll },
    ]);
    return;
  }
  const colorItems = groups.length ? GROUP_COLORS.map((c) => ({ label: t(`color.${c}`), swatch: S.board.theme.colors[c], checked: groups.every((g) => g.color === c), onClick: () => setGroupColor(c) })) : [];
  openMenu(pt, [
    imgs.length === 1 ? { label: t('ctx.zoomTo'), icon: 'focus', hint: 'Shift+2', onClick: () => S.board.fitSelection() } : { label: t('zoom.selection'), icon: 'focus', hint: 'Shift+2', onClick: () => S.board.fitSelection() },
    imgs.length === 1 ? { label: t('ctx.openOriginal'), icon: 'eye', onClick: () => openOriginal(imgs[0]) } : null,
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
    !ro && imgs.length ? { label: t('ctx.rotateRight'), icon: 'rotate', hint: 'Shift+R', onClick: () => rotate(90) } : null,
    !ro && imgs.length ? { label: t('ctx.rotateLeft'), icon: 'rotateLeft', onClick: () => rotate(-90) } : null,
    !ro && imgs.some((it) => it.rot || it.flipX || it.flipY) ? { label: t('ctx.reset'), onClick: resetTransform } : null,
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

function onDblClick(hit) {
  if (!doc()) return;
  if (hit.kind === 'label') return renameGroup(hit.id);
  if (hit.kind === 'item' || hit.kind === 'group') {
    const it = byId(doc()).get(hit.id);
    if (it) S.board.fitBounds(itemBounds(it), true, { maxZ: 16, pad: 0.03 });
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

async function downloadInto(l, record) {
  const prog = toast(t('link.downloading', { p: 0 }), { timeout: 0 });
  try {
    const r = await remote.downloadLink(l, apiKey(), { key: record?.key, onProgress: (got, total) => prog.set(total ? t('link.downloading', { p: Math.round((got / total) * 100) }) : t('link.downloadingMb', { mb: (got / 1048576).toFixed(1) })) });
    return r;
  } finally { prog.close(); }
}

async function addLink(l, url) {
  let r;
  try { r = await downloadInto(l); } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 10000 }); return; }
  const name = r.meta?.name || 'canvas.ilucanvas';
  const rec = { key: remote.linkKey(l), url, ...l, name, title: name.replace(/\.(ilucanvas|pur)$/i, ''), opfsName: r.opfsName, version: r.meta?.version || null, modified: r.meta?.modified || null, size: r.meta?.size || 0, at: Date.now(), checkedAt: Date.now(), update: false };
  await disk.idbPut('links', rec);
  S.links = [rec, ...S.links.filter((x) => x.key !== rec.key)];
  await openLink(rec);
}

function linkSource(rec) {
  return {
    kind: 'cache', name: rec.name, path: rec.url, writable: false,
    getFile: () => remote.openCached(rec.opfsName),
    stat: async () => null,
    write: async () => { throw new Error('read only'); },
  };
}

async function openLink(rec, { view = null } = {}) {
  try { await remote.openCached(rec.opfsName); } catch {
    // the downloaded copy is gone (browser storage cleared): download again
    try {
      const r = await downloadInto(rec, rec);
      Object.assign(rec, { opfsName: r.opfsName, version: r.meta?.version || rec.version, update: false });
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
  if (!(await confirmDialog({ title: t('link.forget'), text: t('link.forgetText', { name: rec.title }), ok: t('link.forget'), danger: true }))) return;
  await remote.removeCached(rec.opfsName);
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
  try { r = await downloadInto(rec, rec); } catch (e) { toast(linkErrorText(e), { kind: 'error', timeout: 10000 }); return; }
  const old = rec.opfsName;
  Object.assign(rec, { opfsName: r.opfsName, version: r.meta?.version || meta?.version || null, modified: r.meta?.modified || null, size: r.meta?.size || 0, update: false, at: Date.now() });
  await disk.idbPut('links', rec);
  if (S.active?.key === rec.key) await openLink(rec, { view: { ...S.board.view } });
  await remote.removeCached(old);
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

  const body = h('div.form', {},
    field(t('settings.style'), picks),
    field(t('settings.background'), bgs, t('settings.bgNote')),
    field(t('settings.wheel'), seg([['zoom', t('settings.wheelZoom')], ['pan', t('settings.wheelPan')]], pref.get('wheel', 'zoom'), (v) => { pref.set('wheel', v); S.board.wheelMode = v; }), t('settings.wheelNote')),
    field(t('settings.autosave'), autosave),
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
  }
  switch (e.key) {
    case 'Delete': case 'Backspace': e.preventDefault(); if (!readOnly()) deleteSelection(); return;
    case 'Escape': S.board.select([]); closeMenu(); return;
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
  if (e.shiftKey) return;
  if (k === 'v') setTool('select');
  else if (k === 'h') setTool('hand');
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
    list() {
      need();
      const d = doc();
      const line = (it, ind) => (it.type === 'group'
        ? `${ind}${it.id}  group  "${it.name}"  ${it.color}  x=${Math.round(it.x)} y=${Math.round(it.y)} w=${Math.round(it.w)} h=${Math.round(it.h)}`
        : `${ind}${it.id}  ${it.type}  "${d.assets[it.asset]?.name || it.asset}"  x=${Math.round(it.x)} y=${Math.round(it.y)} w=${Math.round(it.w)} h=${Math.round(it.h)}${it.note ? `  note="${it.note}"` : ''}`);
      const out = [];
      const walk = (parent, ind) => {
        for (const it of d.items) if (it.type === 'group' && (it.parent || null) === parent) { out.push(line(it, ind)); walk(it.id, `${ind}  `); }
        for (const it of d.items) if (it.type !== 'group' && (it.parent || null) === parent) out.push(line(it, ind));
      };
      walk(null, '');
      return out.join('\n');
    },
    json() { need(); return serialize(doc()); },
    async apply(ops) {
      need();
      if (readOnly()) throw new Error('this canvas is read only');
      const before = snapshot();
      let r;
      try { r = await applyOps(doc(), ops, { by: 'agent', addImages: urlAdder }); } catch (e) { restore(before); throw e; }
      commit('agent', before);
      return r;
    },
    async addUrls(urls, { x, y, group } = {}) { return this.apply([{ op: 'add', urls: [].concat(urls), x, y, group }]); },
    select(ids) { need(); S.board.select([].concat(ids)); return selIds(); },
    selection() { return selIds(); },
    zoomTo(ids = 'all') {
      need();
      if (ids === 'all') S.board.fitAll();
      else { const m = byId(doc()); const b = unionBounds([].concat(ids).map((id) => m.get(id)).filter(Boolean).map(itemBounds)); if (b) S.board.fitBounds(b, true, { maxZ: 8 }); }
      return { ...S.board.view };
    },
    /** Renderer numbers: decoded images, memory, last frame time. */
    perf({ draw = false } = {}) { const frame = draw ? S.board.drawNow() : { ...S.board.stats }; return { images: S.images.stats(), frame, failed: [...S.images.failed.entries()] }; },
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
    const c = new OffscreenCanvas(Math.round(W * Math.min(1, ar)), Math.round((W / ar) * Math.min(1, ar)));
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
    files.push(new File([await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })], `demo-${String(i + 1).padStart(4, '0')}.jpg`, { type: 'image/jpeg' }));
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
    onLoad: () => { S.board.invalidate(); if (S.showMap) S.minimap.invalidate(); },
  });
  S.board = new Board({
    stage, scene: $('scene'), overlay: $('overlay'), images: S.images,
    cb: {
      commit: (label, items, assets) => commit(label, { items, assets: assets || doc().assets, title: doc().title }),
      selection: () => {},
      view: () => {
        drawBackground();
        S.minimap.invalidate();
        if (S.zoomLabel) S.zoomLabel.textContent = `${Math.round(S.board.view.z * 100)}%`;
        clearTimeout(S.viewTimer);
        S.viewTimer = setTimeout(() => { const d = doc(); if (d) disk.idbPut('views', { id: d.id, view: { ...S.board.view } }); }, 600);
      },
      contextMenu,
      dblclick: onDblClick,
      dropFiles: dropData,
      insets: () => ({ left: (S.sidebar && !isNarrow() ? 292 : 0) + 64, right: 0, top: 64, bottom: 0 }),
      drawn: () => {},
    },
  });
  S.board.wheelMode = pref.get('wheel', 'zoom');
  S.bg = new Background($('bg'));
  S.bg.onReady = drawBackground;
  S.minimap = new Minimap($('minimap').querySelector('canvas'), S.board);
  new ResizeObserver(() => drawBackground()).observe(stage);
  stage.addEventListener('pointermove', (e) => { const r = stage.getBoundingClientRect(); S.mouse = S.board.toWorld(e.clientX - r.left, e.clientY - r.top); });
  $('scrim').addEventListener('click', () => setSidebar(false));
  if (isNarrow()) S.sidebar = false;
  applyStyle();
  document.fonts?.ready.then(() => S.board.setTheme());
  render();
  window.ilucanvas = agentApi();

  // remembered folders, files, links
  S.recent = (await disk.idbAll('recent')).sort((a, b) => b.at - a.at);
  S.links = (await disk.idbAll('links')).sort((a, b) => b.at - a.at);
  S.folders = (await disk.idbAll('folders')).sort((a, b) => b.at - a.at).map((f) => ({ ...f, granted: false, files: [] }));
  for (const f of S.folders) { f.granted = await disk.hasPermission(f.handle); if (f.granted) await scanFolder(f, true); }
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); for (const f of S.folders) scanFolder(f); } });
  addEventListener('resize', () => { const n = isNarrow(); if (n !== S.wasNarrow) { S.wasNarrow = n; S.sidebar = n ? false : pref.get('sidebar', true); render(); } });
  S.wasNarrow = isNarrow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();

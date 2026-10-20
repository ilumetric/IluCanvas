// The board: view (pan / zoom), drawing, hit testing and pointer input.
// Three layers: background pattern, scene (groups and images), overlay
// (selection, handles, marquee, hover) — the overlay redraws alone on hover.
//
// The scene is drawn only when something changed, into one canvas: only
// visible items are touched, each image at the level of detail its size on
// screen needs (images.js), tiny ones as a dot of their average colour.
// Edits replace item objects in doc.items (model.js); a finished gesture is
// reported with the items as they were before, for undo.

import { itemBounds, unionBounds, intersects, withChildren, reparent, byId, newId, groupsByDepth, groupAtPoint, outermost, GROUP_COLORS } from '../core/model.js';
import { LEVELS, levelFor } from './images.js';

const MIN_Z = 0.002;
const MAX_Z = 64;
const HANDLE = 8;
const DRAG_START = 4;

const hexRgb = (hex) => {
  const m = String(hex).trim().match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 128];
};
const mix = (a, b, t) => { const x = hexRgb(a); const y = hexRgb(b); return `rgb(${x.map((v, i) => Math.round(v * t + y[i] * (1 - t))).join(',')})`; };
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;

export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  const colors = {};
  for (const c of GROUP_COLORS) colors[c] = v(`--${c}`) || '#999999';
  const px = (n) => { const s = v(n); return s.endsWith('px') ? parseFloat(s) : (Number(s) || 0); };
  return {
    canvas: v('--canvas'), section: v('--section'), panel: v('--panel'), text: v('--text'), muted: v('--text-muted'), faint: v('--text-faint'),
    ink: v('--ink'), select: v('--select'), brand: v('--brand'), patternInk: v('--pattern-ink'), red: v('--red'),
    font: v('--font'), hand: v('--hand'), handWeight: v('--hand-w') || '600',
    rPill: Math.min(px('--r-pill'), 999), rOuter: px('--r-outer'), wiggle: Number(v('--wiggle')) || 0,
    colors,
  };
}

export class Board {
  constructor({ stage, scene, overlay, images, cb }) {
    this.stage = stage;
    this.scene = scene;
    this.overlay = overlay;
    this.sctx = scene.getContext('2d', { alpha: true });
    this.octx = overlay.getContext('2d');
    this.images = images;
    this.cb = cb; // { commit(label, before), selection(), view(), contextMenu(pt, hit), dblclick(hit), dropFiles(dt, world), drawn() }
    this.doc = null;
    this.readOnly = false;
    this.view = { x: 0, y: 0, z: 1 };
    this.tool = 'select';
    this.selection = new Set();
    this.hover = null;
    this.drag = null;
    this.space = false;
    this.theme = readTheme();
    this.labelRects = [];
    this.pointers = new Map();
    this.need = { scene: true, overlay: true };
    this.raf = 0;
    this.anim = null;
    this.wheelMode = 'zoom';
    this.stats = { drawn: 0, ms: 0 };
    this.#bind();
    new ResizeObserver(() => this.invalidate()).observe(stage);
  }

  // ---- state -------------------------------------------------------------------------------

  setDoc(doc, { readOnly = false, view = null } = {}) {
    this.doc = doc;
    this.readOnly = readOnly;
    this.selection.clear();
    this.hover = null;
    this.drag = null;
    if (view) this.view = { ...view };
    else this.fitAll(false);
    this.invalidate();
    this.cb.selection?.();
  }

  setTheme() { this.theme = readTheme(); this.invalidate(); }

  setTool(tool) {
    this.tool = tool;
    this.stage.classList.toggle('tool-hand', tool === 'hand');
    this.invalidateOverlay();
  }

  select(ids, { add = false } = {}) {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.invalidateOverlay();
    this.cb.selection?.();
  }

  selectedItems() {
    if (!this.doc) return [];
    const m = byId(this.doc);
    return [...this.selection].map((id) => m.get(id)).filter(Boolean);
  }

  /** Drop selected ids that no longer exist (after undo, reload). */
  pruneSelection() {
    if (!this.doc) return;
    const m = byId(this.doc);
    let changed = false;
    for (const id of [...this.selection]) if (!m.has(id)) { this.selection.delete(id); changed = true; }
    if (changed) this.cb.selection?.();
  }

  /** Briefly outline items (new from outside: an agent, a reload). */
  flash(ids) {
    this.flashIds = new Set(ids);
    this.invalidateOverlay();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flashIds = null; this.invalidateOverlay(); }, 1800);
  }

  get size() { return { w: this.stage.clientWidth, h: this.stage.clientHeight }; }
  toWorld(sx, sy) { return { x: (sx - this.view.x) / this.view.z, y: (sy - this.view.y) / this.view.z }; }
  toScreen(wx, wy) { return { x: wx * this.view.z + this.view.x, y: wy * this.view.z + this.view.y }; }
  visibleWorld(margin = 0) {
    const { w, h } = this.size;
    const a = this.toWorld(-margin, -margin);
    return { x: a.x, y: a.y, w: (w + margin * 2) / this.view.z, h: (h + margin * 2) / this.view.z };
  }

  // ---- view ----------------------------------------------------------------------------------

  setView(v, animate = false) {
    v = { x: v.x, y: v.y, z: Math.max(MIN_Z, Math.min(MAX_Z, v.z)) };
    if (!animate) { this.anim = null; this.view = v; this.#viewChanged(); return; }
    const from = { ...this.view };
    const t0 = performance.now();
    const dur = 320;
    this.anim = { step: (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      // interpolate zoom in log space, position so the transition looks straight
      const z = Math.exp(Math.log(from.z) + (Math.log(v.z) - Math.log(from.z)) * e);
      const { w, h } = this.size;
      const c0 = { x: (w / 2 - from.x) / from.z, y: (h / 2 - from.y) / from.z };
      const c1 = { x: (w / 2 - v.x) / v.z, y: (h / 2 - v.y) / v.z };
      const cx = c0.x + (c1.x - c0.x) * e;
      const cy = c0.y + (c1.y - c0.y) * e;
      this.view = { x: w / 2 - cx * z, y: h / 2 - cy * z, z };
      this.#viewChanged();
      return k < 1;
    } };
    this.invalidate();
  }

  #viewChanged() {
    this.need.scene = this.need.overlay = true;
    this.#schedule();
    this.cb.view?.();
  }

  zoomAt(sx, sy, factor, animate = false) {
    const z = Math.max(MIN_Z, Math.min(MAX_Z, this.view.z * factor));
    const k = z / this.view.z;
    this.setView({ x: sx - (sx - this.view.x) * k, y: sy - (sy - this.view.y) * k, z }, animate);
  }

  zoomCenter(factor) { const { w, h } = this.size; this.zoomAt(w / 2, h / 2, factor, true); }

  /** Fit a world rectangle into the free part of the screen. */
  fitBounds(b, animate = true, { maxZ = 4, pad = 0.08 } = {}) {
    const { w, h } = this.size;
    if (!b || !w || !h) { this.setView({ x: w / 2, y: h / 2, z: 1 }, animate); return; }
    const inset = this.cb.insets?.() || { left: 0, right: 0, top: 0, bottom: 0 };
    const aw = Math.max(100, w - inset.left - inset.right);
    const ah = Math.max(100, h - inset.top - inset.bottom);
    const z = Math.min(maxZ, (aw * (1 - pad * 2)) / Math.max(b.w, 1), (ah * (1 - pad * 2)) / Math.max(b.h, 1));
    const cx = inset.left + aw / 2;
    const cy = inset.top + ah / 2;
    this.setView({ x: cx - (b.x + b.w / 2) * z, y: cy - (b.y + b.h / 2) * z, z }, animate);
  }

  fitAll(animate = true) {
    const b = this.doc ? unionBounds(this.doc.items.map(itemBounds)) : null;
    if (b) this.fitBounds(b, animate, { maxZ: 1 });
    else { const { w, h } = this.size; this.setView({ x: w / 2, y: h / 2, z: 1 }, animate); }
  }

  fitSelection(animate = true) {
    const items = this.selectedItems();
    if (!items.length) return this.fitAll(animate);
    this.fitBounds(unionBounds(items.map(itemBounds)), animate, { maxZ: 8, pad: 0.04 });
  }

  // ---- drawing ----------------------------------------------------------------------------------

  /** Draw a frame right now (measurements; the page may be hidden, without animation frames). */
  drawNow() {
    this.#fit(this.scene);
    this.#fit(this.overlay);
    this.#drawScene();
    this.#drawOverlay();
    return { ...this.stats };
  }

  invalidate() { this.need.scene = this.need.overlay = true; this.#schedule(); }
  invalidateOverlay() { this.need.overlay = true; this.#schedule(); }

  #schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      if (this.anim && !this.anim.step(t)) this.anim = null;
      if (this.anim) this.#schedule();
      const sizeChanged = this.#fit(this.scene) | this.#fit(this.overlay);
      if (this.need.scene || sizeChanged) this.#drawScene();
      if (this.need.overlay || sizeChanged) this.#drawOverlay();
      this.need.scene = this.need.overlay = false;
      this.cb.drawn?.();
    });
  }

  #fit(c) {
    const dpr = devicePixelRatio || 1;
    const { w, h } = this.size;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (c.width === W && c.height === H) return false;
    c.width = W;
    c.height = H;
    return true;
  }

  #drawScene() {
    const t0 = performance.now();
    const ctx = this.sctx;
    const dpr = devicePixelRatio || 1;
    const { x: vx, y: vy, z } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.scene.width, this.scene.height);
    this.images.beginFrame();
    this.labelRects = [];
    if (!this.doc) { this.images.flush(); return; }
    const vis = this.visibleWorld(2);
    const theme = this.theme;
    const k = z * dpr;
    ctx.setTransform(k, 0, 0, k, vx * dpr, vy * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    const { w: sw, h: sh } = this.size;
    const cxs = sw / 2;
    const cys = sh / 2;
    let drawn = 0;
    // images per group, nested groups included
    const counts = new Map();
    const m = byId(this.doc);
    for (const it of this.doc.items) {
      if (it.type === 'group') continue;
      const seen = new Set();
      for (let p = it.parent; p && !seen.has(p); p = m.get(p)?.parent) { seen.add(p); counts.set(p, (counts.get(p) || 0) + 1); }
    }

    // groups below everything, outer ones first
    const labels = [];
    for (const g of groupsByDepth(this.doc)) {
      if (!intersects(g, vis)) continue;
      const col = theme.colors[g.color] || theme.colors.grey;
      const r = Math.min(theme.rOuter / z, g.w / 2, g.h / 2);
      ctx.beginPath();
      if (r > 0.5) ctx.roundRect(g.x, g.y, g.w, g.h, r); else ctx.rect(g.x, g.y, g.w, g.h);
      ctx.fillStyle = mix(col, theme.section, 0.07);
      ctx.globalAlpha = 0.94;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = rgba(col, 0.28);
      ctx.stroke();
      labels.push(g);
    }

    // images
    for (const it of this.doc.items) {
      if (it.type === 'group') continue;
      const b = it.rot ? itemBounds(it) : it;
      if (!intersects(b, vis)) continue;
      drawn++;
      if (it.type !== 'image') { this.#drawUnknown(ctx, it, z); continue; }
      const a = this.doc.assets[it.asset];
      const px = Math.max(it.w, it.h) * k;
      const color = a?.color || '#55555c';
      if (px < 5) {
        ctx.fillStyle = color;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        continue;
      }
      const natural = a ? Math.max(a.w || 0, a.h || 0) : 0;
      const level = levelFor(px, natural || LEVELS[3]);
      const bmp = this.images.get(it.asset, level);
      // nearest to the centre of the screen first; anything not shown at all before refinements
      const s = this.toScreen(b.x + b.w / 2, b.y + b.h / 2);
      const d = Math.abs(s.x - cxs) + Math.abs(s.y - cys);
      if (!this.images.has(it.asset, level)) this.images.want(it.asset, level, (bmp ? 1e6 : 0) + d + level * 1000);
      if (it.opacity !== undefined) ctx.globalAlpha = it.opacity;
      const rotated = it.rot || it.flipX || it.flipY;
      if (rotated) {
        ctx.save();
        ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
        if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);
        if (it.flipX || it.flipY) ctx.scale(it.flipX ? -1 : 1, it.flipY ? -1 : 1);
        ctx.translate(-it.w / 2, -it.h / 2);
      }
      const x = rotated ? 0 : it.x;
      const y = rotated ? 0 : it.y;
      if (bmp) {
        if (it.crop && a?.w) {
          const sx = bmp.width / a.w;
          const sy = bmp.height / a.h;
          ctx.drawImage(bmp, it.crop.x * sx, it.crop.y * sy, it.crop.w * sx, it.crop.h * sy, x, y, it.w, it.h);
        } else ctx.drawImage(bmp, x, y, it.w, it.h);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(x, y, it.w, it.h);
        if (this.images.isBroken(it.asset) || !a) this.#drawBroken(ctx, x, y, it.w, it.h, z);
      }
      if (rotated) ctx.restore();
      if (it.opacity !== undefined) ctx.globalAlpha = 1;
    }

    // group name tags, in screen space, always readable
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const g of labels) this.#drawLabel(ctx, g, counts.get(g.id) || 0);
    this.images.flush();
    this.stats = { drawn, ms: performance.now() - t0 };
  }

  #drawUnknown(ctx, it, z) {
    ctx.save();
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = this.theme.faint;
    ctx.strokeRect(it.x, it.y, it.w, it.h);
    ctx.restore();
  }

  #drawBroken(ctx, x, y, w, h, z) {
    ctx.save();
    ctx.strokeStyle = rgba(this.theme.red, 0.8);
    ctx.lineWidth = 2 / z;
    const s = Math.min(w, h) * 0.15;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
    ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
    ctx.stroke();
    ctx.restore();
  }

  #drawLabel(ctx, g, n) {
    const p = this.toScreen(g.x, g.y);
    const wScreen = g.w * this.view.z;
    if (wScreen < 48) return;
    const th = this.theme;
    const col = th.colors[g.color] || th.colors.grey;
    const H = 26;
    ctx.font = `600 13px ${th.font}`;
    const name = g.name || '';
    const count = String(n);
    ctx.font = '600 11px ' + th.font;
    const cw = Math.max(20, ctx.measureText(count).width + 12);
    ctx.font = `600 13px ${th.font}`;
    const maxName = Math.max(30, wScreen - cw - 26);
    let label = name;
    if (ctx.measureText(label).width > maxName) {
      while (label.length > 1 && ctx.measureText(`${label}…`).width > maxName) label = label.slice(0, -1);
      label += '…';
    }
    const tw = ctx.measureText(label).width;
    const W = 11 + tw + 7 + cw + 4;
    const x = p.x;
    const y = p.y - H - 6;
    const r = Math.min(th.rPill, H / 2);
    ctx.beginPath();
    if (r > 0) ctx.roundRect(x, y, W, H, r); else ctx.rect(x, y, W, H);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, y + H - 2, W, 2);
    ctx.fillStyle = th.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 11, y + H / 2 + 0.5);
    // the count, a darker chip
    const cx = x + 11 + tw + 7;
    ctx.beginPath();
    const cr = Math.min(th.rPill, 9.5);
    if (cr > 0) ctx.roundRect(cx, y + 3.5, cw, 19, cr); else ctx.rect(cx, y + 3.5, cw, 19);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fill();
    ctx.fillStyle = th.ink;
    ctx.font = `600 11px ${th.font}`;
    ctx.textAlign = 'center';
    ctx.fillText(count, cx + cw / 2, y + H / 2 + 0.5);
    ctx.textAlign = 'start';
    this.labelRects.push({ id: g.id, x, y, w: W, h: H });
  }

  #drawOverlay() {
    const ctx = this.octx;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.doc) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = this.theme;
    const m = byId(this.doc);
    const outline = (it, width, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.strokeStyle = th.select;
      const c = this.toScreen(it.x + it.w / 2, it.y + it.h / 2);
      ctx.translate(c.x, c.y);
      if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);
      const w = it.w * this.view.z;
      const h = it.h * this.view.z;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    };
    // drop target while dragging
    if (this.drag?.type === 'move' && this.drag.target) {
      const g = m.get(this.drag.target);
      if (g) outline(g, 3, 0.9);
    }
    if (this.flashIds) {
      ctx.save();
      const sel0 = th.select;
      th.select = th.brand;
      for (const id of this.flashIds) { const it = m.get(id); if (it) outline(it, 3); }
      th.select = sel0;
      ctx.restore();
    }
    if (this.hover && !this.selection.has(this.hover) && !this.drag) {
      const it = m.get(this.hover);
      if (it) outline(it, 1.5, 0.75);
    }
    const sel = this.selectedItems();
    if (sel.length && sel.length <= 400) for (const it of sel) outline(it, 1.5);
    const box = this.#selectionBox(sel);
    if (box && !(this.drag?.type === 'move' && this.drag.moved)) {
      if (sel.length > 1 || sel[0]?.type === 'group') {
        ctx.lineWidth = 1;
        ctx.strokeStyle = th.select;
        ctx.strokeRect(Math.round(box.x) + 0.5, Math.round(box.y) + 0.5, Math.round(box.w), Math.round(box.h));
      }
      if (!this.readOnly) for (const hd of this.#handles(box, sel)) {
        ctx.beginPath();
        if (th.rPill > 0) ctx.arc(hd.x, hd.y, HANDLE / 2 + 0.5, 0, Math.PI * 2);
        else ctx.rect(hd.x - HANDLE / 2, hd.y - HANDLE / 2, HANDLE, HANDLE);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = th.select;
        ctx.stroke();
      }
    }
    if (this.drag?.type === 'marquee' && this.drag.moved) {
      const r = this.drag.rect;
      const a = this.toScreen(r.x, r.y);
      ctx.fillStyle = rgba(th.select, 0.08);
      ctx.strokeStyle = th.select;
      ctx.lineWidth = 1;
      ctx.fillRect(a.x, a.y, r.w * this.view.z, r.h * this.view.z);
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(r.w * this.view.z), Math.round(r.h * this.view.z));
    }
  }

  /** The selection's bounds on screen (null when nothing is selected). */
  #selectionBox(sel = this.selectedItems()) {
    if (!sel.length) return null;
    const b = unionBounds(sel.map(itemBounds));
    const a = this.toScreen(b.x, b.y);
    return { x: a.x, y: a.y, w: b.w * this.view.z, h: b.h * this.view.z, world: b };
  }

  #handles(box, sel) {
    const hs = [
      { id: 'nw', x: box.x, y: box.y }, { id: 'ne', x: box.x + box.w, y: box.y },
      { id: 'sw', x: box.x, y: box.y + box.h }, { id: 'se', x: box.x + box.w, y: box.y + box.h },
    ];
    if (sel.length === 1 && sel[0].type === 'group') {
      hs.push({ id: 'n', x: box.x + box.w / 2, y: box.y }, { id: 's', x: box.x + box.w / 2, y: box.y + box.h },
        { id: 'w', x: box.x, y: box.y + box.h / 2 }, { id: 'e', x: box.x + box.w, y: box.y + box.h / 2 });
    }
    return hs;
  }

  // ---- hit testing ----------------------------------------------------------------------------------

  /** What is under a screen point: { kind: 'handle' | 'label' | 'item' | 'group' | 'none', id?, handle? } */
  hitTest(sx, sy, { handles = true } = {}) {
    if (!this.doc) return { kind: 'none' };
    if (handles && !this.readOnly) {
      const sel = this.selectedItems();
      const box = this.#selectionBox(sel);
      if (box) for (const hd of this.#handles(box, sel)) if (Math.abs(sx - hd.x) <= HANDLE && Math.abs(sy - hd.y) <= HANDLE) return { kind: 'handle', handle: hd.id };
    }
    for (let i = this.labelRects.length - 1; i >= 0; i--) {
      const r = this.labelRects[i];
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return { kind: 'label', id: r.id };
    }
    const p = this.toWorld(sx, sy);
    const items = this.doc.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.type === 'group') continue;
      if (inItem(it, p)) return { kind: 'item', id: it.id };
    }
    const g = groupAtPoint(this.doc, p);
    return g ? { kind: 'group', id: g.id } : { kind: 'none' };
  }

  groupAt(p, exclude = new Set()) { return groupAtPoint(this.doc, p, exclude); }

  // ---- input ------------------------------------------------------------------------------------------

  #bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this.#down(e));
    st.addEventListener('pointermove', (e) => this.#move(e));
    st.addEventListener('pointerup', (e) => this.#up(e));
    st.addEventListener('pointercancel', (e) => this.#up(e, true));
    st.addEventListener('lostpointercapture', (e) => { if (this.drag && this.drag.pointer === e.pointerId) this.#up(e, true); });
    st.addEventListener('pointerleave', () => { if (this.hover && !this.drag) { this.hover = null; this.invalidateOverlay(); } });
    st.addEventListener('wheel', (e) => this.#wheel(e), { passive: false });
    st.addEventListener('dblclick', (e) => {
      const r = st.getBoundingClientRect();
      this.cb.dblclick?.(this.hitTest(e.clientX - r.left, e.clientY - r.top, { handles: false }), e);
    });
    st.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.drag?.type === 'pan' && this.drag.moved) return;
      const r = st.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top, { handles: false });
      const id = hit.id;
      if (id && !this.selection.has(id)) this.select([id]);
      if (!id && hit.kind === 'none') this.select([]);
      this.cb.contextMenu?.({ x: e.clientX, y: e.clientY }, hit, this.toWorld(e.clientX - r.left, e.clientY - r.top));
    });
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTyping(e.target)) { this.space = true; this.stage.classList.add('panning-ready'); if (e.target === document.body) e.preventDefault(); }
    });
    addEventListener('keyup', (e) => { if (e.code === 'Space') { this.space = false; this.stage.classList.remove('panning-ready'); } });
    addEventListener('blur', () => { this.space = false; this.stage.classList.remove('panning-ready'); });
    // drag and drop of files / images from other pages
    st.addEventListener('dragover', (e) => {
      if (!this.cb.dropFiles || this.readOnly && !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      st.classList.add('drop-over');
    });
    st.addEventListener('dragleave', (e) => { if (e.target === st || !st.contains(e.relatedTarget)) st.classList.remove('drop-over'); });
    st.addEventListener('drop', (e) => {
      e.preventDefault();
      st.classList.remove('drop-over');
      const r = st.getBoundingClientRect();
      this.cb.dropFiles?.(e.dataTransfer, this.toWorld(e.clientX - r.left, e.clientY - r.top));
    });
  }

  #local(e) { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  #down(e) {
    this.anim = null;
    if (document.activeElement && isTyping(document.activeElement)) document.activeElement.blur();
    this.pointers.set(e.pointerId, this.#local(e));
    if (this.pointers.size === 2) { this.#startPinch(); return; }
    if (this.pointers.size > 2) return;
    const p = this.#local(e);
    const pan = e.button === 1 || (e.button === 0 && (this.tool === 'hand' || this.space)) || (e.pointerType === 'touch' && this.tool === 'hand');
    if (e.button === 2) return;
    this.stage.setPointerCapture(e.pointerId);
    if (pan) {
      e.preventDefault();
      this.drag = { type: 'pan', pointer: e.pointerId, sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y, moved: false };
      this.stage.classList.add('panning');
      return;
    }
    if (e.button !== 0 || !this.doc) return;
    const hit = this.hitTest(p.x, p.y);
    const w = this.toWorld(p.x, p.y);
    const base = { pointer: e.pointerId, sx: p.x, sy: p.y, wx: w.x, wy: w.y, moved: false, shift: e.shiftKey, alt: e.altKey, hit };
    if (hit.kind === 'handle') {
      if (this.readOnly) return;
      this.drag = { ...base, type: 'resize', handle: hit.handle, ...this.#resizeStart(hit.handle) };
      return;
    }
    if (hit.kind === 'item' || hit.kind === 'label' || (hit.kind === 'group' && this.selection.has(hit.id))) {
      const id = hit.id;
      if (e.shiftKey) {
        if (this.selection.has(id)) { this.selection.delete(id); this.invalidateOverlay(); this.cb.selection?.(); this.drag = { ...base, type: 'noop' }; return; }
        this.select([id], { add: true });
      } else if (!this.selection.has(id)) this.select([id]);
      this.drag = { ...base, type: this.readOnly ? 'noop' : 'move' };
      return;
    }
    // empty space or an unselected group's body: a marquee (a click selects the group / clears)
    this.drag = { ...base, type: 'marquee', rect: { x: w.x, y: w.y, w: 0, h: 0 }, startSel: e.shiftKey ? new Set(this.selection) : new Set() };
  }

  #move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.#local(e));
    if (this.pinch) { this.#pinchMove(); return; }
    const p = this.#local(e);
    const d = this.drag;
    if (!d || d.pointer !== e.pointerId) {
      if (e.pointerType === 'mouse' && !e.buttons) this.#hover(p);
      return;
    }
    if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < DRAG_START) return;
    const first = !d.moved;
    d.moved = true;
    if (d.type === 'pan') {
      this.setView({ x: d.vx + p.x - d.sx, y: d.vy + p.y - d.sy, z: this.view.z });
      return;
    }
    const w = this.toWorld(p.x, p.y);
    if (d.type === 'move') {
      if (first) this.#moveStart(d);
      this.#moveTo(d, w.x - d.wx, w.y - d.wy, e.shiftKey);
    } else if (d.type === 'resize') {
      if (first) d.before = this.doc.items;
      this.#resizeTo(d, w);
    } else if (d.type === 'marquee') {
      d.rect = { x: Math.min(d.wx, w.x), y: Math.min(d.wy, w.y), w: Math.abs(w.x - d.wx), h: Math.abs(w.y - d.wy) };
      this.#marqueeSelect(d);
      this.invalidateOverlay();
    }
  }

  #up(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
    const d = this.drag;
    if (!d || d.pointer !== e.pointerId) return;
    this.drag = null;
    this.stage.classList.remove('panning');
    try { this.stage.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (d.type === 'move' && d.moved) {
      if (cancelled) { this.doc.items = d.before; this.invalidate(); return; }
      reparent(this.doc, [...d.ids]);
      this.cb.commit?.(d.dup ? 'duplicate' : 'move', d.before, d.beforeAssets);
      this.invalidate();
      return;
    }
    if (d.type === 'resize' && d.moved) {
      if (cancelled) { this.doc.items = d.before; this.invalidate(); return; }
      this.cb.commit?.('resize', d.before);
      this.invalidate();
      return;
    }
    if (d.type === 'marquee' && !d.moved) {
      // a click: on a group's body selects it, on empty space clears
      if (d.hit.kind === 'group') this.select([d.hit.id], { add: d.shift });
      else if (!d.shift) this.select([]);
    }
    if (d.type === 'move' && !d.moved && !d.shift && d.hit.kind === 'item' && this.selection.size > 1) this.select([d.hit.id]);
    this.invalidateOverlay();
  }

  #hover(p) {
    if (this.tool === 'hand' || this.space) return;
    const hit = this.hitTest(p.x, p.y);
    const id = hit.kind === 'item' || hit.kind === 'label' ? hit.id : null;
    const cursor = hit.kind === 'handle' ? ({ nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' })[hit.handle] : '';
    if (this.stage.dataset.cursor !== cursor) this.stage.dataset.cursor = cursor;
    if (id !== this.hover) { this.hover = id; this.invalidateOverlay(); }
  }

  #moveStart(d) {
    d.before = this.doc.items;
    d.beforeAssets = this.doc.assets;
    if (d.alt) {
      // Alt-drag: move copies, leave the originals
      const sel = this.selectedItems();
      const all = withChildren(this.doc, sel.map((s) => s.id));
      const idMap = new Map();
      for (const it of this.doc.items) if (all.has(it.id)) idMap.set(it.id, newId(it.type));
      const copies = this.doc.items.filter((it) => all.has(it.id)).map((it) => {
        const c = { ...it, id: idMap.get(it.id) };
        if (it.parent) { if (idMap.has(it.parent)) c.parent = idMap.get(it.parent); }
        return c;
      });
      const groups = copies.filter((c) => c.type === 'group');
      const rest = copies.filter((c) => c.type !== 'group');
      this.doc.items = [...groups, ...this.doc.items, ...rest];
      this.selection = new Set(sel.map((s) => idMap.get(s.id)));
      d.dup = true;
      this.cb.selection?.();
    }
    d.ids = withChildren(this.doc, [...this.selection]);
    d.start = new Map();
    for (const it of this.doc.items) if (d.ids.has(it.id) && !it.locked) d.start.set(it.id, { x: it.x, y: it.y });
  }

  #moveTo(d, dx, dy, axis) {
    if (axis) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    this.doc.items = this.doc.items.map((it) => {
      const s = d.start.get(it.id);
      return s ? { ...it, x: s.x + dx, y: s.y + dy } : it;
    });
    // drop target: the group under the pointer that is not moving
    const p = { x: d.wx + dx, y: d.wy + dy };
    const g = this.groupAt(p, d.ids);
    d.target = g && [...d.ids].some((id) => byId(this.doc).get(id)?.type !== 'group') ? g.id : null;
    this.invalidate();
  }

  #resizeStart(handle) {
    const sel = this.selectedItems();
    const b = unionBounds(sel.map(itemBounds));
    const frameOnly = sel.length === 1 && sel[0].type === 'group';
    const ids = frameOnly ? new Set([sel[0].id]) : withChildren(this.doc, sel.map((s) => s.id));
    const start = new Map();
    for (const it of this.doc.items) if (ids.has(it.id)) start.set(it.id, { x: it.x, y: it.y, w: it.w, h: it.h });
    const ax = handle.includes('w') ? b.x + b.w : handle.includes('e') ? b.x : null;
    const ay = handle.includes('n') ? b.y + b.h : handle.includes('s') ? b.y : null;
    return { box: b, frameOnly, start, ax, ay };
  }

  #resizeTo(d, w) {
    const { box: b, start } = d;
    const minWorld = 8 / this.view.z;
    let patch;
    if (d.frameOnly) {
      let { x, y } = b;
      let x2 = b.x + b.w;
      let y2 = b.y + b.h;
      if (d.handle.includes('w')) x = Math.min(w.x, x2 - minWorld * 5);
      if (d.handle.includes('e')) x2 = Math.max(w.x, x + minWorld * 5);
      if (d.handle.includes('n')) y = Math.min(w.y, y2 - minWorld * 5);
      if (d.handle.includes('s')) y2 = Math.max(w.y, y + minWorld * 5);
      const id = [...start.keys()][0];
      patch = new Map([[id, { x, y, w: x2 - x, h: y2 - y }]]);
    } else {
      // uniform scale from the opposite corner (images keep their aspect)
      const ax = d.ax ?? b.x;
      const ay = d.ay ?? b.y;
      const sx = Math.abs(w.x - ax) / b.w;
      const sy = Math.abs(w.y - ay) / b.h;
      let s = Math.max(sx, sy);
      const minSide = Math.min(...[...start.values()].map((r) => Math.min(r.w, r.h)));
      s = Math.max(s, minWorld / Math.max(minSide, 1e-6));
      patch = new Map();
      for (const [id, r] of start) patch.set(id, { x: ax + (r.x - ax) * s, y: ay + (r.y - ay) * s, w: r.w * s, h: r.h * s });
    }
    this.doc.items = d.before.map((it) => (patch.has(it.id) ? { ...it, ...patch.get(it.id) } : it));
    this.invalidate();
  }

  #marqueeSelect(d) {
    const r = d.rect;
    const sel = new Set(d.startSel);
    for (const it of this.doc.items) {
      const b = itemBounds(it);
      if (it.type === 'group') { if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) sel.add(it.id); } else if (intersects(b, r)) sel.add(it.id);
    }
    // a group and what is inside it: keep the group
    const keep = new Set(outermost(this.doc, [...sel]));
    for (const id of [...sel]) if (!keep.has(id) && !d.startSel.has(id)) sel.delete(id);
    const changed = sel.size !== this.selection.size || [...sel].some((id) => !this.selection.has(id));
    if (changed) { this.selection = sel; this.cb.selection?.(); }
  }

  #startPinch() {
    if (this.drag?.type === 'move' && this.drag.moved) this.doc.items = this.drag.before;
    this.drag = null;
    const [a, b] = [...this.pointers.values()];
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...this.view } };
  }

  #pinchMove() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const p = this.pinch;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = Math.max(MIN_Z, Math.min(MAX_Z, p.view.z * (dist / Math.max(p.d, 1))));
    const wx = (p.c.x - p.view.x) / p.view.z;
    const wy = (p.c.y - p.view.y) / p.view.z;
    this.setView({ x: c.x - wx * z, y: c.y - wy * z, z });
  }

  #wheel(e) {
    e.preventDefault();
    this.anim = null;
    const p = this.#local(e);
    const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * lines;
    const dy = e.deltaY * lines;
    const mouseWheel = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy));
    // zoom: Ctrl / pinch always; the plain wheel when the setting says so (Shift pans sideways)
    if (e.ctrlKey || e.metaKey || (this.wheelMode === 'zoom' && !e.shiftKey)) {
      const k = mouseWheel ? 0.0016 : 0.01;
      const f = Math.max(0.5, Math.min(2, Math.exp(-dy * k)));
      this.zoomAt(p.x, p.y, f);
    } else {
      const sx = e.shiftKey && !dx ? dy : dx;
      const sy = e.shiftKey && !dx ? 0 : dy;
      this.setView({ x: this.view.x - sx, y: this.view.y - sy, z: this.view.z });
    }
  }
}

function inItem(it, p) {
  if (!it.rot) return p.x >= it.x && p.y >= it.y && p.x <= it.x + it.w && p.y <= it.y + it.h;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const a = (-it.rot * Math.PI) / 180;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const x = dx * Math.cos(a) - dy * Math.sin(a);
  const y = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(x) <= it.w / 2 && Math.abs(y) <= it.h / 2;
}

const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

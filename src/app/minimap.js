// The minimap: the whole board in a small panel, the visible part as a frame.
// Click or drag to move there. Items are drawn as their average colour, or as
// their preview when it is already decoded (nothing is decoded for the map).

import { itemBounds, unionBounds, byId } from '../core/model.js';
import { connectorPath } from '../core/connectors.js';
import { INK_ALPHA, strokeScale } from '../core/ink.js';
import { INK_COLOR } from './ink.js';
import { NOTE_BG } from './text.js';
import { FILL } from './shapes.js';

/** A stroke's samples in board units, thinned out (the map is small). */
function strokeLine(it) {
  const pts = it.pts || [];
  const sx = it.w / (it.vw || it.w);
  const sy = it.h / (it.vh || it.h);
  const step = Math.max(1, Math.floor(pts.length / 3 / 40)) * 3;
  const out = [];
  for (let i = 0; i + 2 < pts.length; i += step) out.push({ x: it.x + pts[i] * sx, y: it.y + pts[i + 1] * sy });
  if (pts.length >= 3) out.push({ x: it.x + pts[pts.length - 3] * sx, y: it.y + pts[pts.length - 2] * sy });
  return out;
}

export class Minimap {
  constructor(canvas, board) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.board = board;
    this.raf = 0;
    this.contentDirty = true;
    this.cache = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.frozen = this.L || this.#layout(); // the map holds still while dragging in it
      this.#go(e);
      const move = (ev) => this.#go(ev);
      const up = () => { this.frozen = null; this.invalidate(); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.board.zoomCenter(Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  }

  /** The board's content changed: rebuild the picture. */
  contentChanged() { this.contentDirty = true; this.invalidate(); }

  invalidate() {
    if (this.raf || this.canvas.offsetParent === null) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  #layout() {
    const doc = this.board.doc;
    const content = doc ? unionBounds(doc.items.map(itemBounds)) : null;
    const vis = this.board.visibleWorld();
    const b = content ? unionBounds([content, vis]) : vis;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const pad = 6;
    const k = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
    return { k, ox: pad + (W - pad * 2 - b.w * k) / 2 - b.x * k, oy: pad + (H - pad * 2 - b.h * k) / 2 - b.y * k, content };
  }

  draw() {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); this.contentDirty = true; }
    const ctx = this.ctx;
    const L = this.frozen || this.#layout();
    this.L = L;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const doc = this.board.doc;
    if (!doc) return;
    const th = this.board.theme;
    ctx.save();
    ctx.translate(L.ox, L.oy);
    ctx.scale(L.k, L.k);
    for (const it of doc.items) {
      if (it.type !== 'group') continue;
      ctx.fillStyle = th.colors[it.color] || th.colors.grey;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(it.x, it.y, it.w, it.h);
    }
    ctx.globalAlpha = 1;
    const few = doc.items.length < 600;
    const m = byId(doc);
    const minW = 1.5 / L.k;
    for (const it of doc.items) {
      if (it.type === 'group') continue;
      if (it.type === 'stroke' || it.type === 'connector') {
        // lines: a stroke's centre line in its ink, a connector's path
        const pts = it.type === 'connector' ? connectorPath(it, (id) => m.get(id)).pts : strokeLine(it);
        if (pts.length < 2) continue;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.strokeStyle = it.type === 'stroke' ? INK_COLOR[it.color] || th.faint : th.faint;
        ctx.globalAlpha = it.type === 'stroke' ? INK_ALPHA[it.tool] ?? 1 : 0.8;
        ctx.lineWidth = Math.max(minW, it.type === 'stroke' ? it.width * strokeScale(it) : 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      if (it.type === 'note' || it.type === 'shape') {
        const c = it.type === 'note' ? NOTE_BG[it.color] : FILL[it.fill];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(it.x, it.y, Math.max(it.w, minW), Math.max(it.h, minW));
        continue;
      }
      const b = itemBounds(it);
      const bmp = few && it.type === 'image' ? this.board.images.get(it.asset, 0) : null;
      if (bmp && b.w * L.k > 4) ctx.drawImage(bmp, b.x, b.y, b.w, b.h);
      else {
        ctx.fillStyle = doc.assets[it.asset]?.color || th.faint;
        ctx.fillRect(b.x, b.y, Math.max(b.w, 1.5 / L.k), Math.max(b.h, 1.5 / L.k));
      }
    }
    ctx.restore();
    // the visible part
    const v = this.board.visibleWorld();
    const x = L.ox + v.x * L.k;
    const y = L.oy + v.y * L.k;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(x, y, v.w * L.k, v.h * L.k);
    ctx.fill('evenodd');
    ctx.strokeStyle = th.select;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, v.w * L.k, v.h * L.k);
    this.contentDirty = false;
  }

  #go(e) {
    const L = this.frozen || this.L || this.#layout();
    const r = this.canvas.getBoundingClientRect();
    const wx = (e.clientX - r.left - L.ox) / L.k;
    const wy = (e.clientY - r.top - L.oy) / L.k;
    const { w, h } = this.board.size;
    const z = this.board.view.z;
    this.board.setView({ x: w / 2 - wx * z, y: h / 2 - wy * z, z });
  }
}

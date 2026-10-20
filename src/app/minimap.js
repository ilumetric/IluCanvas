// The minimap: the whole board in a small panel, the visible part as a frame.
// Click or drag to move there. The board is drawn as silhouettes into a cache,
// again only when it changes (or the map's scale does); panning only copies it.

import { itemBounds, unionBounds, byId } from '../core/model.js';
import { connectorPath } from '../core/connectors.js';

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
  contentChanged() { this.contentDirty = true; this.bounds = undefined; this.invalidate(); }

  invalidate() {
    if (this.raf || this.canvas.offsetParent === null) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  #layout() {
    const doc = this.board.doc;
    // the content's bounds are kept until it changes (10 000 items: no union per frame)
    if (doc && this.bounds === undefined) this.bounds = unionBounds(doc.items.map(itemBounds));
    const content = doc ? this.bounds : null;
    const vis = this.board.visibleWorld();
    const b = content ? unionBounds([content, vis]) : vis;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const pad = 6;
    const k = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
    return { k, ox: pad + (W - pad * 2 - b.w * k) / 2 - b.x * k, oy: pad + (H - pad * 2 - b.h * k) / 2 - b.y * k, content };
  }

  draw() {
    const t0 = performance.now();
    this.#draw();
    this.stats = { ms: Math.round((performance.now() - t0) * 100) / 100, cached: !this.redrew };
  }

  #draw() {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    this.redrew = false;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = this.ctx;
    const L = this.frozen || this.#layout();
    this.L = L;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.board.doc) return;
    // the content: silhouettes, drawn again only when the board or the map's scale changes
    const key = `${L.k}|${L.ox}|${L.oy}|${c.width}|${c.height}`;
    if (this.contentDirty || key !== this.cacheKey || !this.cache) {
      this.#paint(L, c.width, c.height, dpr);
      this.cacheKey = key;
      this.contentDirty = false;
      this.redrew = true;
    }
    ctx.drawImage(this.cache, 0, 0);
    // the visible part
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const th = this.board.theme;
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
  }

  /** Silhouettes of the board into the cache: group frames tinted, everything else one tone, lines as lines. */
  #paint(L, cw, ch, dpr) {
    if (!this.cache || this.cache.width !== cw || this.cache.height !== ch) {
      this.cache = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    }
    const ctx = this.cache.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const doc = this.board.doc;
    const th = this.board.theme;
    ctx.setTransform(dpr * L.k, 0, 0, dpr * L.k, dpr * L.ox, dpr * L.oy);
    for (const it of doc.items) {
      if (it.type !== 'group') continue;
      ctx.fillStyle = th.colors[it.color] || th.colors.grey;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(it.x, it.y, it.w, it.h);
    }
    const min = 1.5 / L.k;
    const m = byId(doc);
    const boxes = new Path2D();
    const lines = new Path2D();
    for (const it of doc.items) {
      if (it.type === 'group') continue;
      if (it.type === 'stroke' || it.type === 'connector') {
        const pts = it.type === 'connector' ? connectorPath(it, (id) => m.get(id)).pts : strokeLine(it);
        pts.forEach((q, i) => (i ? lines.lineTo(q.x, q.y) : lines.moveTo(q.x, q.y)));
        continue;
      }
      if (it.type === 'note' && it.color === 'none') continue; // text on the board: nothing to see this small
      const b = it.rot ? itemBounds(it) : it;
      boxes.rect(b.x, b.y, Math.max(b.w, min), Math.max(b.h, min));
    }
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = th.muted;
    ctx.fill(boxes);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = th.muted;
    ctx.lineWidth = min;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(lines);
    ctx.globalAlpha = 1;
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

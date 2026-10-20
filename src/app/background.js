// The canvas background: a pattern that moves and scales with the board.
// Lattice patterns (dots, grid, crosses) keep their marks the same size on
// screen and halve / double their density as you zoom, fading between levels
// (FigJam-style). Picture patterns (doodles, garden) are SVG tiles that scale
// with the board and cross-fade between two sizes.

export const BACKGROUNDS = ['dots', 'grid', 'cross', 'doodle', 'garden', 'plain'];
export const STYLE_BACKGROUND = { fun: 'doodle', calm: 'cross', oli: 'garden' };

const HEART = 'M0 6C-4 2.5-8 0-8-3.5C-8-6.5-5.5-8-3.5-8C-2-8-.8-7.2 0-6C.8-7.2 2-8 3.5-8C5.5-8 8-6.5 8-3.5C8 0 4 2.5 0 6Z';
const STAR = 'M0-8L2.4-2.5 8.2-2.5 3.5 1.2 5.2 7 0 3.6-5.2 7-3.5 1.2-8.2-2.5-2.4-2.5Z';
const SPARK = 'M0-8C1-2 2-1 8 0C2 1 1 2 0 8C-1 2-2 1-8 0C-2-1-1-2 0-8Z';
const flower = (s) => [0, 72, 144, 216, 288].map((r) => `<ellipse cx='0' cy='-5.5' rx='3' ry='4.5' transform='rotate(${r})'/>`).join('') + "<circle r='2'/>";
const g = (x, y, r, s, inner) => `<g transform='translate(${x} ${y}) rotate(${r}) scale(${s})'>${inner}</g>`;

/** SVG tiles of the picture patterns (from IluBoard's Fun and Oli styles), in `ink`. */
const TILES = {
  doodle: (ink) => {
    let dots = '';
    for (let y = 0; y <= 240; y += 24) for (let x = 0; x <= 240; x += 24) dots += `<circle cx='${x}' cy='${y}' r='1.1'/>`;
    return `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'><g fill='${ink}'>${dots}</g><g fill='none' stroke='${ink}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${
      g(26, 40, -10, 1, "<path d='M0 0q6-8 12 0t12 0 12 0'/>")}${g(182, 32, 0, 1, "<circle r='7'/>")}${g(112, 100, 15, 1, "<path d='M0-8L8 6H-8Z'/>")
    }${g(40, 152, 10, 1, "<path d='M-6 0h12M0-6v12'/>")}${g(196, 150, -12, 1, `<path d='${STAR}'/>`)}${g(122, 206, 22, 1, "<rect x='-5' y='-5' width='10' height='10'/>")
    }${g(60, 92, 8, 1, "<path d='M0 0c10-10 20-10 30 0m-7-5 7 5-8 3'/>")}${g(166, 216, 20, 1, "<path d='M0 0q5-7 10 0t10 0'/>")}</g></svg>`;
  },
  garden: (ink) => `<svg xmlns='http://www.w3.org/2000/svg' width='230' height='230' viewBox='0 0 230 230'><g fill='none' stroke='${ink}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>${
    g(32, 36, -15, 1, `<path d='${HEART}'/>`)}${g(122, 42, 10, 1, flower())}${g(196, 92, 0, 1, `<path d='${SPARK}'/>`)}${g(82, 122, 20, 0.7, `<path d='${HEART}'/>`)
  }${g(176, 184, -20, 0.9, flower())}${g(40, 192, 15, 0.7, `<path d='${SPARK}'/>`)}${g(118, 178, 8, 0.6, `<path d='${STAR}'/>`)}${g(26, 110, -10, 1, "<path d='M2-7a7 7 0 1 0 0 14a8 8 0 0 1 0-14Z'/>")
  }</g><g fill='${ink}'><circle cx='152' cy='128' r='1.6'/><circle cx='96' cy='212' r='1.6'/><circle cx='214' cy='18' r='1.6'/><circle cx='70' cy='16' r='1.2'/></g></svg>`,
};
const TILE_SIZE = { doodle: 240, garden: 230 };

/** An SVG tile as a data URL (style previews use it as a CSS background). */
export function tileUrl(kind, ink, size = 24) {
  if (TILES[kind]) return `url("data:image/svg+xml,${encodeURIComponent(TILES[kind](ink))}")`;
  const s = size;
  const q = (x, y) => `<circle cx='${x}' cy='${y}' r='1.3'/>`;
  const svg = {
    dots: `<g fill='${ink}'>${q(0, 0)}${q(s, 0)}${q(0, s)}${q(s, s)}</g>`,
    grid: `<path d='M0 0H${s}M0 ${s}H${s}M0 0V${s}M${s} 0V${s}' stroke='${ink}' stroke-width='1'/>`,
    cross: `<path d='${[[0, 0], [s, 0], [0, s], [s, s]].map(([x, y]) => `M${x - 3} ${y}h6M${x} ${y - 3}v6`).join('')}' stroke='${ink}' stroke-width='1' stroke-linecap='round'/>`,
    plain: '',
  }[kind] ?? '';
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}' viewBox='0 0 ${s} ${s}'>${svg}</svg>`)}")`;
}

const smooth = (t) => t * t * (3 - 2 * t);

export class Background {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.kind = 'dots';
    this.ink = '#2c2c33';
    this.patterns = {}; // kind → { bitmap, size }
  }

  set(kind, ink) {
    if (kind === this.kind && ink === this.ink) return;
    this.kind = BACKGROUNDS.includes(kind) ? kind : 'dots';
    this.ink = ink;
    this.patterns = {};
    if (TILES[this.kind]) this.#loadTile(this.kind, ink);
  }

  #loadTile(kind, ink) {
    const img = new Image();
    const size = TILE_SIZE[kind];
    img.onload = () => {
      // rasterize at 2× so the tile stays crisp up to twice its size
      const c = document.createElement('canvas');
      c.width = c.height = size * 2;
      c.getContext('2d').drawImage(img, 0, 0, size * 2, size * 2);
      if (this.kind === kind && this.ink === ink) {
        this.patterns[kind] = { pattern: this.ctx.createPattern(c, 'repeat'), size };
        this.onReady?.();
      }
    };
    img.src = `data:image/svg+xml,${encodeURIComponent(TILES[kind](ink))}`;
  }

  /** view: { x, y, z } (screen = world * z + (x, y)), sizes in CSS pixels. */
  draw(view, w, h, dpr) {
    const { canvas, ctx } = this;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (this.kind === 'plain') return;
    if (TILES[this.kind]) return this.#drawTile(view, W, H, dpr);
    this.#drawLattice(view, W, H, dpr);
  }

  /** Two levels of a lattice: every other line / point (coarse) at full ink, the rest fading in. */
  #drawLattice(view, W, H, dpr) {
    const { ctx } = this;
    const T = (this.kind === 'grid' ? 16 : 13) * dpr; // the densest spacing ever shown, device px
    let s = 24 * view.z * dpr; // world spacing 24
    let k = 0;
    while (s < T && k < 60) { s *= 2; k++; }
    while (s >= 2 * T && k > -60) { s /= 2; k--; }
    const f = smooth(Math.min(1, (s - T) / T));
    const ox = view.x * dpr;
    const oy = view.y * dpr;
    const i0 = Math.floor(-ox / s) - 1;
    const j0 = Math.floor(-oy / s) - 1;
    const i1 = Math.ceil((W - ox) / s) + 1;
    const j1 = Math.ceil((H - oy) / s) + 1;
    const even = (n) => (n & 1) === 0;
    ctx.fillStyle = ctx.strokeStyle = this.ink;
    for (const coarse of [true, false]) {
      const alpha = coarse ? 1 : f;
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      if (this.kind === 'grid') {
        ctx.lineWidth = Math.max(1, dpr * 0.9);
        for (let i = i0; i <= i1; i++) if (even(i) === coarse) { const x = Math.round(ox + i * s) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let j = j0; j <= j1; j++) if (even(j) === coarse) { const y = Math.round(oy + j * s) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      } else if (this.kind === 'dots') {
        const r = 1.25 * dpr;
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if ((even(i) && even(j)) !== coarse) continue;
            const x = ox + i * s;
            const y = oy + j * s;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
        }
        ctx.fill();
      } else {
        const a = 3.5 * dpr;
        ctx.lineWidth = Math.max(1, dpr);
        ctx.lineCap = 'round';
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if ((even(i) && even(j)) !== coarse) continue;
            const x = Math.round(ox + i * s) + 0.5;
            const y = Math.round(oy + j * s) + 0.5;
            ctx.moveTo(x - a, y); ctx.lineTo(x + a, y);
            ctx.moveTo(x, y - a); ctx.lineTo(x, y + a);
          }
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A picture tile at two sizes, cross-fading. */
  #drawTile(view, W, H, dpr) {
    const p = this.patterns[this.kind];
    if (!p) return;
    const { ctx } = this;
    const T = p.size * dpr; // natural tile size in device px
    let s = p.size * view.z * dpr * 0.5; // the board's own tile is half the picture
    while (s < T / 2) s *= 2;
    while (s >= T) s /= 2;
    const f = smooth((s - T / 2) / (T / 2));
    const ox = view.x * dpr;
    const oy = view.y * dpr;
    for (const [size, alpha] of [[s, f], [s * 2, 1 - f]]) {
      if (alpha < 0.02) continue;
      const k = size / (p.size * 2); // the bitmap is 2× the tile
      p.pattern.setTransform(new DOMMatrix([k, 0, 0, k, ox, oy]));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.pattern;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }
}

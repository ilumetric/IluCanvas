// Connectors: lines and arrows between items (or free points). Pure geometry,
// shared by the app (drawing, hit testing) and the CLI (bounds, detaching).
//
// An end is { id, side? } — attached to an item, at the middle of one of its
// sides (`top right bottom left`; without `side`, the side facing the other
// end) — or { x, y }, a free point. Attached ends follow their items.
//
//   route  straight | elbow | curve | dubins
//   start / end  none | arrow | dot      (heads)

export const ROUTES = ['straight', 'elbow', 'curve', 'dubins'];
export const HEADS = ['none', 'arrow', 'dot'];
export const SIDES = ['top', 'right', 'bottom', 'left'];
const DIR = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

const boxOf = (it) => ({ x: it.x, y: it.y, w: it.w, h: it.h });
const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The middle of one side of a box. */
export function sidePoint(b, side) {
  switch (side) {
    case 'top': return { x: b.x + b.w / 2, y: b.y };
    case 'bottom': return { x: b.x + b.w / 2, y: b.y + b.h };
    case 'left': return { x: b.x, y: b.y + b.h / 2 };
    default: return { x: b.x + b.w, y: b.y + b.h / 2 };
  }
}

/** The side of box `b` that faces point `p`. */
export function facingSide(b, p) {
  const c = centre(b);
  const dx = (p.x - c.x) / Math.max(b.w, 1);
  const dy = (p.y - c.y) / Math.max(b.h, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** The side of box `b` nearest to point `p` (dragging an end onto an item). */
export function nearestSide(b, p) {
  let best = 'right';
  let bd = Infinity;
  for (const s of SIDES) {
    const q = sidePoint(b, s);
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/**
 * Where a connector runs now: { a, b, dirA, dirB, pts, curve } in board units.
 * `lookup(id)` → item (or undefined: the end is treated as a free point at its last place).
 * `pts` is the polyline (straight / elbow); `curve` the cubic Bézier [a, c1, c2, b] for curves.
 */
export function connectorPath(c, lookup) {
  const fa = c.from?.id ? lookup(c.from.id) : null;
  const fb = c.to?.id ? lookup(c.to.id) : null;
  const ba = fa && boxOf(fa);
  const bb = fb && boxOf(fb);
  const freeA = { x: c.from?.x ?? c.x ?? 0, y: c.from?.y ?? c.y ?? 0 };
  const freeB = { x: c.to?.x ?? (c.x ?? 0) + (c.w ?? 0), y: c.to?.y ?? (c.y ?? 0) + (c.h ?? 0) };
  const ca = ba ? centre(ba) : freeA;
  const cb = bb ? centre(bb) : freeB;
  const sideA = ba ? (c.from.side && DIR[c.from.side] ? c.from.side : facingSide(ba, cb)) : null;
  const sideB = bb ? (c.to.side && DIR[c.to.side] ? c.to.side : facingSide(bb, sideA ? sidePoint(ba, sideA) : ca)) : null;
  const a = ba ? sidePoint(ba, sideA) : freeA;
  const b = bb ? sidePoint(bb, sideB) : freeB;
  const toward = (p, q) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: Math.sign(dx) || 1, y: 0 };
    return { x: 0, y: Math.sign(dy) || 1 };
  };
  const dirA = sideA ? DIR[sideA] : toward(a, b);
  const dirB = sideB ? DIR[sideB] : toward(b, a);
  const route = ROUTES.includes(c.route) ? c.route : 'straight';
  if (route === 'curve') {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(30, d * 0.4);
    const c1 = { x: a.x + dirA.x * k, y: a.y + dirA.y * k };
    const c2 = { x: b.x + dirB.x * k, y: b.y + dirB.y * k };
    return { a, b, dirA, dirB, curve: [a, c1, c2, b], pts: flattenCubic(a, c1, c2, b, 24) };
  }
  if (route === 'elbow') return { a, b, dirA, dirB, pts: elbow(a, b, dirA, dirB, ba, bb) };
  if (route === 'dubins') {
    // leaves `a` along its side's normal, arrives at `b` moving into its side
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const rho = Math.max(8, Math.min(64, d / 5));
    return { a, b, dirA, dirB, pts: dubins(a, Math.atan2(dirA.y, dirA.x), b, Math.atan2(-dirB.y, -dirB.x), rho) };
  }
  return { a, b, dirA, dirB, pts: [a, b] };
}

// ---- Dubins path -------------------------------------------------------------------------------
// The shortest way between two points with headings for something that can
// only turn with radius ≥ rho: two arcs and a line, or three arcs (L = turn
// toward larger angles, R = smaller, S = straight). After A. Walker's dubins.c.

const TAU = Math.PI * 2;
const mod2pi = (x) => x - TAU * Math.floor(x / TAU);

/** [t, p, q] segment lengths (in units of rho) of each kind of path, or null when it does not exist. */
const DUBINS = {
  LSL: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 < 0) return null;
    const t1 = Math.atan2(cb - ca, d + sa - sb);
    return [mod2pi(t1 - alpha), Math.sqrt(p2), mod2pi(beta - t1)];
  },
  RSR: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 < 0) return null;
    const t1 = Math.atan2(ca - cb, d - sa + sb);
    return [mod2pi(alpha - t1), Math.sqrt(p2), mod2pi(t1 - beta)];
  },
  LSR: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const t0 = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
    return [mod2pi(t0 - alpha), p, mod2pi(t0 - beta)];
  },
  RSL: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const t0 = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
    return [mod2pi(alpha - t0), p, mod2pi(beta - t0)];
  },
  RLR: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const c = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(c) > 1) return null;
    const p = mod2pi(TAU - Math.acos(c));
    const t = mod2pi(alpha - Math.atan2(ca - cb, d - sa + sb) + p / 2);
    return [t, p, mod2pi(alpha - beta - t + p)];
  },
  LRL: ({ d, sa, sb, ca, cb, cab, alpha, beta }) => {
    const c = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
    if (Math.abs(c) > 1) return null;
    const p = mod2pi(TAU - Math.acos(c));
    const t = mod2pi(-alpha - Math.atan2(ca - cb, d + sa - sb) + p / 2);
    return [t, p, mod2pi(beta - alpha - t + p)];
  },
};

/** A Dubins path from a (heading h0) to b (heading h1) as a polyline; arcs every ~8°. */
export function dubins(a, h0, b, h1, rho) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const D = Math.hypot(dx, dy);
  if (D < 1e-6 || !(rho > 0)) return [a, b];
  const th = mod2pi(Math.atan2(dy, dx));
  const alpha = mod2pi(h0 - th);
  const beta = mod2pi(h1 - th);
  const v = { d: D / rho, alpha, beta, sa: Math.sin(alpha), sb: Math.sin(beta), ca: Math.cos(alpha), cb: Math.cos(beta), cab: Math.cos(alpha - beta) };
  let best = null;
  for (const [kind, f] of Object.entries(DUBINS)) {
    const seg = f(v);
    if (!seg) continue;
    const len = seg[0] + seg[1] + seg[2];
    if (!best || len < best.len) best = { kind, seg, len };
  }
  if (!best) return [a, b];
  // walk the three segments
  const pts = [{ x: a.x, y: a.y }];
  let x = a.x;
  let y = a.y;
  let h = h0;
  for (let i = 0; i < 3; i++) {
    const turn = best.kind[i];
    const t = best.seg[i];
    if (turn === 'S') {
      x += Math.cos(h) * t * rho;
      y += Math.sin(h) * t * rho;
      pts.push({ x, y });
      continue;
    }
    const sgn = turn === 'L' ? 1 : -1;
    const steps = Math.max(1, Math.ceil(t / 0.14));
    const x0 = x;
    const y0 = y;
    const h0s = h;
    for (let k = 1; k <= steps; k++) {
      const u = (t * k) / steps;
      const hh = h0s + sgn * u;
      x = x0 + sgn * rho * (Math.sin(hh) - Math.sin(h0s));
      y = y0 - sgn * rho * (Math.cos(hh) - Math.cos(h0s));
      pts.push({ x, y });
    }
    h = h0s + sgn * t;
  }
  pts[pts.length - 1] = { x: b.x, y: b.y }; // exact end (rounding)
  return pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) > 1e-3 || Math.abs(p.y - pts[i - 1].y) > 1e-3);
}

const STUB = 24;

/**
 * An orthogonal route that leaves `a` along `da` and enters `b` against `db`.
 * `ba` / `bb` are the boxes of the items at the ends (null for free points):
 * lines that have to turn back go around them, not through them.
 */
function elbow(a, b, da, db, ba, bb) {
  const boxA = ba || { x: a.x, y: a.y, w: 0, h: 0 };
  const boxB = bb || { x: b.x, y: b.y, w: 0, h: 0 };
  const pa = { x: a.x + da.x * STUB, y: a.y + da.y * STUB };
  const pb = { x: b.x + db.x * STUB, y: b.y + db.y * STUB };
  const ha = da.x !== 0;
  const hb = db.x !== 0;
  // the usual shapes first: a Z through the middle, a U past both, one corner
  const cands = [];
  if (ha && hb) {
    const mx = da.x === db.x ? (da.x > 0 ? Math.max(pa.x, pb.x) : Math.min(pa.x, pb.x)) : (a.x + b.x) / 2;
    cands.push([{ x: mx, y: a.y }, { x: mx, y: b.y }]);
  } else if (!ha && !hb) {
    const my = da.y === db.y ? (da.y > 0 ? Math.max(pa.y, pb.y) : Math.min(pa.y, pb.y)) : (a.y + b.y) / 2;
    cands.push([{ x: a.x, y: my }, { x: b.x, y: my }]);
  } else cands.push([ha ? { x: b.x, y: a.y } : { x: a.x, y: b.y }]);
  // then: step out of each side, and meet across the gap between the boxes (or past them)
  const my = gap(boxA.y, boxA.h, boxB.y, boxB.h, (a.y + b.y) / 2);
  const mx = gap(boxA.x, boxA.w, boxB.x, boxB.w, (a.x + b.x) / 2);
  cands.push(
    [pa, { x: pa.x, y: pb.y }, pb],
    [pa, { x: pb.x, y: pa.y }, pb],
    [pa, { x: pa.x, y: my }, { x: pb.x, y: my }, pb],
    [pa, { x: mx, y: pa.y }, { x: mx, y: pb.y }, pb],
  );
  let best = null;
  let bestCost = Infinity;
  for (const mid of cands) {
    const pts = tidy([a, ...mid, b]);
    if (!orthogonal(pts)) continue;
    let cost = 0;
    for (let i = 1; i < pts.length; i++) {
      cost += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
      if (ba && through(pts[i - 1], pts[i], ba)) cost += 1e7;
      if (bb && through(pts[i - 1], pts[i], bb)) cost += 1e7;
    }
    // leaving a side backwards (into its own item) or arriving from inside
    if (!along(pts[0], pts[1], da) || !along(pts[pts.length - 1], pts[pts.length - 2], db)) cost += 1e6;
    cost += (pts.length - 2) * STUB * 2;
    if (cost < bestCost) { bestCost = cost; best = pts; }
  }
  return best || [a, b];
}

/** Does the axis-aligned step p→q run through the inside of box b (touching its edges is fine)? */
function through(p, q, b) {
  const e = 0.5;
  if (Math.abs(p.y - q.y) < 0.01) {
    if (!(p.y > b.y + e && p.y < b.y + b.h - e)) return false;
    return Math.max(p.x, q.x) > b.x + e && Math.min(p.x, q.x) < b.x + b.w - e;
  }
  if (!(p.x > b.x + e && p.x < b.x + b.w - e)) return false;
  return Math.max(p.y, q.y) > b.y + e && Math.min(p.y, q.y) < b.y + b.h - e;
}

/** Does the first step p→q go out along direction d? */
function along(p, q, d) {
  return (q.x - p.x) * d.x + (q.y - p.y) * d.y > 0.01;
}

function orthogonal(pts) {
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].x - pts[i - 1].x) > 0.01 && Math.abs(pts[i].y - pts[i - 1].y) > 0.01) return false;
  return true;
}

/** A line between two spans (start, size) on one axis, or past both when they overlap. */
function gap(s1, n1, s2, n2, fallback) {
  if (s1 + n1 + STUB <= s2) return (s1 + n1 + s2) / 2;
  if (s2 + n2 + STUB <= s1) return (s2 + n2 + s1) / 2;
  if (n1 === 0 && n2 === 0) return fallback;
  return Math.max(s1 + n1, s2 + n2) + STUB;
}

/** Drop zero-length steps and points in the middle of a straight run. */
function tidy(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01) continue;
    const r = out[out.length - 2];
    if (q && r && ((Math.abs(r.x - q.x) < 0.01 && Math.abs(q.x - p.x) < 0.01) || (Math.abs(r.y - q.y) < 0.01 && Math.abs(q.y - p.y) < 0.01))) out.pop();
    out.push(p);
  }
  return out;
}

export function flattenCubic(p0, p1, p2, p3, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/** Distance from point `p` to a polyline. */
export function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
}

/** The point halfway along a polyline (labels) and the direction there. */
export function midpoint(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (half <= seg && seg > 0) {
      const t = half / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    }
    half -= seg;
  }
  return pts[0] || { x: 0, y: 0 };
}

/** Bounds of a path (x, y, w, h; never zero-sized). */
export function pathBounds(pts) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

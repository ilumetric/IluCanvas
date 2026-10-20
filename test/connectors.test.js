import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorPath, facingSide, nearestSide, distToPolyline, midpoint, pathBounds } from '../src/core/connectors.js';

const boxes = {
  a: { id: 'a', x: 0, y: 0, w: 200, h: 100 },
  b: { id: 'b', x: 400, y: 200, w: 200, h: 100 },
  back: { id: 'back', x: -400, y: 0, w: 200, h: 100 },
};
const lookup = (id) => boxes[id];

/** Every step is horizontal or vertical. */
function orthogonal(pts) {
  for (let i = 1; i < pts.length; i++) {
    const dx = Math.abs(pts[i].x - pts[i - 1].x);
    const dy = Math.abs(pts[i].y - pts[i - 1].y);
    if (dx > 0.01 && dy > 0.01) return false;
  }
  return true;
}

/** Does a step of the route pass through the inside of box b? */
function crosses(pts, b) {
  for (let i = 1; i < pts.length; i++) {
    for (let t = 0.05; t < 1; t += 0.05) {
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
      const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      if (x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1) return true;
    }
  }
  return false;
}

test('sides: facing the other end, nearest to a point', () => {
  assert.equal(facingSide(boxes.a, { x: 1000, y: 50 }), 'right');
  assert.equal(facingSide(boxes.a, { x: 100, y: -500 }), 'top');
  assert.equal(nearestSide(boxes.a, { x: 100, y: 95 }), 'bottom');
});

test('straight and curved connectors end on the facing sides', () => {
  const p = connectorPath({ from: { id: 'a' }, to: { id: 'b' } }, lookup);
  assert.deepEqual(p.a, { x: 200, y: 50 });
  assert.deepEqual(p.b, { x: 500, y: 200 }, 'b is further below than to the right (relative to its size): its top');
  assert.equal(p.pts.length, 2);
  const c = connectorPath({ from: { id: 'a' }, to: { id: 'b' }, route: 'curve' }, lookup);
  assert.equal(c.curve.length, 4);
  assert.deepEqual(c.pts[0], c.a);
  assert.deepEqual(c.pts[c.pts.length - 1], c.b);
});

test('elbow routes are orthogonal and go around the boxes when they turn back', () => {
  const sides = ['top', 'right', 'bottom', 'left'];
  for (const s1 of sides) {
    for (const s2 of sides) {
      for (const to of ['b', 'back']) {
        const p = connectorPath({ from: { id: 'a', side: s1 }, to: { id: to, side: s2 }, route: 'elbow' }, lookup);
        const label = `${s1} → ${to}.${s2}`;
        assert.ok(orthogonal(p.pts), `${label}: orthogonal`);
        assert.deepEqual(p.pts[0], p.a, label);
        assert.deepEqual(p.pts[p.pts.length - 1], p.b, label);
        assert.ok(!crosses(p.pts, boxes.a), `${label}: does not cross a ${JSON.stringify(p.pts)}`);
        assert.ok(!crosses(p.pts, boxes[to]), `${label}: does not cross ${to} ${JSON.stringify(p.pts)}`);
      }
    }
  }
  // a back-edge from a's right side into the left side of a box behind it
  const back = connectorPath({ from: { id: 'a', side: 'right' }, to: { id: 'back', side: 'left' }, route: 'elbow' }, lookup);
  assert.ok(back.pts.length >= 5);
  // free ends: a plain L
  const free = connectorPath({ from: { x: 0, y: 0 }, to: { x: 300, y: 200 }, route: 'elbow' }, () => null);
  assert.ok(orthogonal(free.pts));
});

test('elbow routes go round the low side too when the boxes overlap on an axis', () => {
  // up out of a, into the left side of a box up and to the left that shares a's top band
  const side = { id: 'side', x: -400, y: -100, w: 100, h: 100 };
  const look = (id) => (id === 'side' ? side : boxes[id]);
  const p = connectorPath({ from: { id: 'a', side: 'top' }, to: { id: 'side', side: 'left' }, route: 'elbow' }, look);
  assert.ok(orthogonal(p.pts));
  assert.ok(!crosses(p.pts, side), JSON.stringify(p.pts));
  assert.ok(!crosses(p.pts, boxes.a), JSON.stringify(p.pts));
  assert.ok(Math.min(...p.pts.map((q) => q.y)) < side.y, 'passes above both');
  // and the route does not change from one call to the next
  assert.deepEqual(connectorPath({ from: { id: 'a', side: 'top' }, to: { id: 'side', side: 'left' }, route: 'elbow' }, look).pts, p.pts);
});

test('elbow routes whose ends meet do not break', () => {
  const cases = [
    ['side by side, edge to edge', { A: { id: 'A', x: 0, y: 0, w: 100, h: 100 }, B: { id: 'B', x: 100, y: 0, w: 100, h: 100 } }, { from: { id: 'A' }, to: { id: 'B' } }],
    ['stacked, edge to edge', { A: { id: 'A', x: 0, y: 0, w: 100, h: 100 }, B: { id: 'B', x: 0, y: 100, w: 100, h: 100 } }, { from: { id: 'A' }, to: { id: 'B' } }],
    ['right side to left side, touching', { A: { id: 'A', x: 0, y: 0, w: 100, h: 60 }, B: { id: 'B', x: 100, y: 0, w: 50, h: 60 } }, { from: { id: 'A', side: 'right' }, to: { id: 'B', side: 'left' } }],
    ['a self-connector on an item turned 90°', { R: { id: 'R', x: 0, y: 0, w: 100, h: 50, rot: 90 } }, { from: { id: 'R' }, to: { id: 'R' } }],
    ['two free ends at one point', {}, { from: { x: 5, y: 5 }, to: { x: 5, y: 5 } }],
  ];
  for (const [label, items, c] of cases) {
    const p = connectorPath({ ...c, route: 'elbow' }, (id) => items[id]);
    assert.ok(p.pts.length >= 2, label);
    assert.ok(p.pts.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)), label);
    assert.ok(orthogonal(p.pts), label);
    assert.deepEqual(p.pts[0], p.a, label);
    assert.deepEqual(p.pts[p.pts.length - 1], p.b, label);
  }
});

test('geometry helpers', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.equal(distToPolyline({ x: 50, y: 10 }, pts), 10);
  assert.deepEqual(midpoint(pts), { x: 100, y: 0 });
  assert.deepEqual(pathBounds([{ x: 5, y: 5 }, { x: 5, y: 9 }]), { x: 5, y: 5, w: 1, h: 4 });
});

test('dubins: arcs and a line from one heading to the other, ending exactly on the target', async () => {
  const { dubins } = await import('../src/core/connectors.js');
  for (let i = 0; i < 300; i++) {
    const a = { x: Math.random() * 800 - 400, y: Math.random() * 800 - 400 };
    const b = { x: Math.random() * 800 - 400, y: Math.random() * 800 - 400 };
    const h0 = Math.random() * 7;
    const h1 = Math.random() * 7;
    const rho = 8 + Math.random() * 56;
    const pts = dubins(a, h0, b, h1, rho);
    assert.deepEqual(pts[0], a);
    assert.deepEqual(pts[pts.length - 1], b);
    // the walk itself arrives at b: the last step is one arc step, not a jump
    const l = pts[pts.length - 1];
    const m = pts[pts.length - 2];
    assert.ok(Math.hypot(l.x - m.x, l.y - m.y) <= rho * 0.15 + 1e-6 || pts.length <= 3, `last step ${Math.hypot(l.x - m.x, l.y - m.y)} rho ${rho}`);
  }
  const p = connectorPath({ from: { id: 'a', side: 'right' }, to: { id: 'b', side: 'top' }, route: 'dubins' }, lookup);
  assert.deepEqual(p.a, { x: 200, y: 50 });
  assert.deepEqual(p.b, { x: 500, y: 200 });
  assert.ok(p.pts.length > 5, 'arcs are sampled');
  // leaves to the right, arrives moving down into the top side
  assert.ok(p.pts[1].x > p.pts[0].x && Math.abs(p.pts[1].y - p.pts[0].y) < 2);
  const n = p.pts.length;
  assert.ok(p.pts[n - 1].y > p.pts[n - 2].y && Math.abs(p.pts[n - 1].x - p.pts[n - 2].x) < 2);
});

export default function (APB, t) {
  const { test, assert } = t;
  const snap = APB.require('snapping');

  const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ` expected ${b}, got ${a}`);

  test('snapMove: left edge snaps to sibling edge with a guide spanning both rects', () => {
    const other = { x: 100, y: 300, w: 80, h: 40 };
    const r = snap.snapMove({ rect: { x: 103, y: 0, w: 50, h: 50 }, others: [other], threshold: 6 });
    assert.equal(r.dx, -3);
    assert.equal(r.dy, 0);
    assert.equal(r.snapped.x, 'edge');
    const g = r.guides.find((x) => x.axis === 'x' && x.pos === 100);
    assert.ok(g, 'guide at x=100');
    assert.equal(g.kind, 'edge');
    assert.equal(g.from, 0);
    assert.equal(g.to, 340);
    assert.deepEqual(r.spacing, []);
  });

  test('snapMove: centers, closest candidate wins, threshold respected', () => {
    const others = [{ x: 0, y: 0, w: 200, h: 20 }]; // center x = 100
    const a = snap.snapMove({ rect: { x: 52, y: 100, w: 100, h: 20 }, others, threshold: 5 }); // center 102
    assert.equal(a.dx, -2);
    assert.equal(a.snapped.x, 'center');
    assert.ok(a.guides.some((g) => g.axis === 'x' && g.pos === 100 && g.kind === 'center'));

    const b = snap.snapMove({ rect: { x: 103, y: 500, w: 10, h: 10 }, others: [{ x: 100, y: 0, w: 4, h: 4 }], threshold: 6 });
    // candidates 100, 102, 104 → anchor 103 is 1 away from 104 and 102; left edge 103 vs 104 → +1 or 102 → -1
    assert.equal(Math.abs(b.dx), 1);

    const c = snap.snapMove({ rect: { x: 120, y: 120, w: 10, h: 10 }, others: [{ x: 100, y: 0, w: 4, h: 4 }], threshold: 6 });
    assert.equal(c.dx, 0);
    assert.equal(c.dy, 0);
    assert.deepEqual(c.guides, []);
    assert.deepEqual(c.snapped, { x: null, y: null });

    const off = snap.snapMove({ rect: { x: 103, y: 0, w: 50, h: 50 }, others: [{ x: 100, y: 0, w: 5, h: 5 }], threshold: 0 });
    assert.equal(off.dx, 0);
  });

  test('snapMove: parent edges/center use kind "parent"; the closest anchor wins', () => {
    const parent = { x: 0, y: 0, w: 1000, h: 600 };
    const r = snap.snapMove({ rect: { x: 447, y: 296, w: 100, h: 10 }, others: [], parent, threshold: 6 });
    assert.equal(r.dx, 3);   // center 497 → 500
    assert.equal(r.dy, -1);  // middle 301 → 300 beats top 296 → 300
    assert.equal(r.snapped.x, 'parent');
    const gx = r.guides.find((g) => g.axis === 'x');
    assert.equal(gx.pos, 500);
    assert.equal(gx.kind, 'parent');
    assert.equal(gx.from, 0);
    assert.equal(gx.to, 600);
  });

  test('snapMove: grid snapping (objects disabled)', () => {
    const r = snap.snapMove({
      rect: { x: 23, y: 58, w: 30, h: 30 }, others: [{ x: 25, y: 0, w: 10, h: 10 }],
      grid: true, gridSize: 10, threshold: 6, objects: false
    });
    assert.equal(r.dx, -3); // 23 → 20 (right edge 53 → 50 also -3)
    assert.equal(r.dy, 2);  // 58 → 60
    assert.equal(r.snapped.x, 'grid');
    assert.ok(r.guides.some((g) => g.kind === 'grid' && g.axis === 'x' && g.pos === 20));
    assert.ok(!r.guides.some((g) => g.kind === 'edge'));

    const origin = snap.snapMove({ rect: { x: 26, y: 0, w: 4, h: 4 }, grid: true, gridSize: 10, gridOrigin: { x: 5, y: 0 }, threshold: 3, objects: false });
    assert.equal(origin.dx, -1); // lines at 5, 15, 25 …
  });

  test('snapMove: object alignment beats an equally close grid line', () => {
    const r = snap.snapMove({
      rect: { x: 12, y: 0, w: 10, h: 10 }, others: [{ x: 10, y: 100, w: 30, h: 30 }],
      grid: true, gridSize: 10, threshold: 4
    });
    assert.equal(r.dx, -2);
    assert.equal(r.snapped.x, 'edge');
  });

  test('snapMove: equal spacing between two neighbours', () => {
    const L = { x: 0, y: 0, w: 100, h: 100 };
    const R = { x: 300, y: 0, w: 100, h: 100 };
    const r = snap.snapMove({ rect: { x: 148, y: 0, w: 100, h: 100 }, others: [L, R], threshold: 6 });
    assert.equal(r.dx, 2);
    assert.equal(r.snapped.x, 'spacing');
    const sx = r.spacing.filter((s) => s.axis === 'x');
    assert.equal(sx.length, 2);
    for (const s of sx) {
      assert.equal(s.gap, 50);
      assert.equal(s.to - s.from, 50);
      assert.equal(s.pos, 50);
    }
    assert.deepEqual(sx.map((s) => [s.from, s.to]).sort((a, b) => a[0] - b[0]), [[100, 150], [250, 300]]);
  });

  test('snapMove: equal spacing continues an existing gap (both axes)', () => {
    const A = { x: 0, y: 0, w: 100, h: 50 };
    const B = { x: 150, y: 0, w: 100, h: 50 };
    const r = snap.snapMove({ rect: { x: 297, y: 10, w: 60, h: 30 }, others: [A, B], threshold: 6 });
    assert.equal(r.dx, 3);
    const gaps = r.spacing.filter((s) => s.axis === 'x');
    assert.equal(gaps.length, 2, 'A–B and B–rect');
    assert.ok(gaps.every((s) => s.gap === 50));
    assert.ok(gaps.some((s) => s.from === 250 && s.to === 300));
    assert.ok(gaps.some((s) => s.from === 100 && s.to === 150));

    // Before the right neighbour, vertical axis.
    const C = { x: 0, y: 200, w: 50, h: 100 };
    const D = { x: 0, y: 340, w: 50, h: 60 };
    const v = snap.snapMove({ rect: { x: 10, y: 118, w: 20, h: 40 }, others: [C, D], threshold: 5 });
    // gap C–D = 40 → rect bottom should be 200 - 40 = 160 → y = 120
    assert.equal(v.dy, 2);
    assert.equal(v.snapped.y, 'spacing');
    assert.ok(v.spacing.some((s) => s.axis === 'y' && s.from === 160 && s.to === 200 && s.gap === 40));
  });

  test('snapMove: rects not overlapping on the cross axis do not create spacing', () => {
    const L = { x: 0, y: 500, w: 100, h: 100 };
    const R = { x: 300, y: 500, w: 100, h: 100 };
    const r = snap.snapMove({ rect: { x: 148, y: 0, w: 100, h: 100 }, others: [L, R], threshold: 6 });
    assert.equal(r.dx, 0);
    assert.deepEqual(r.spacing, []);
  });

  test('snapMove: guides merge all rects aligned at the same position', () => {
    const others = [{ x: 200, y: 0, w: 50, h: 50 }, { x: 150, y: 400, w: 50, h: 50 }];
    const r = snap.snapMove({ rect: { x: 198, y: 200, w: 30, h: 30 }, others, threshold: 5 });
    assert.equal(r.dx, 2);
    const g = r.guides.filter((x) => x.axis === 'x' && x.pos === 200);
    assert.equal(g.length, 1);
    assert.equal(g[0].from, 0);
    assert.equal(g[0].to, 450);
  });

  test('snapMove: scales to many siblings', () => {
    const others = [];
    for (let i = 0; i < 2000; i++) others.push({ x: (i * 37) % 5000, y: (i * 53) % 4000, w: 20 + (i % 7) * 10, h: 20 + (i % 5) * 10 });
    const t0 = Date.now();
    for (let k = 0; k < 20; k++) snap.snapMove({ rect: { x: 1234.5 + k, y: 987.25, w: 120, h: 60 }, others, parent: { x: 0, y: 0, w: 5000, h: 4000 }, threshold: 4 });
    assert.ok(Date.now() - t0 < 1500, 'fast enough');
    // A prepared index gives identical results.
    const index = snap.createIndex({ others, parent: { x: 0, y: 0, w: 5000, h: 4000 } });
    for (let k = 0; k < 5; k++) {
      const rect = { x: 1234.5 + k * 3.3, y: 987.25 - k, w: 120, h: 60 };
      const a = snap.snapMove({ rect, others, parent: { x: 0, y: 0, w: 5000, h: 4000 }, threshold: 4, grid: true, gridSize: 8 });
      const b = snap.snapMove({ rect, index, threshold: 4, grid: true, gridSize: 8 });
      assert.deepEqual(b, a);
    }
  });

  test('snapMove: invalid input returns zero deltas', () => {
    assert.deepEqual(snap.snapMove({ rect: null }).dx, 0);
    const r = snap.snapMove({ rect: { x: 0, y: 0, w: 10, h: 10 }, others: [null, { x: NaN }], threshold: 5 });
    assert.equal(r.dx, 0);
  });

  test('snapPoint: snaps a point to edges', () => {
    const p = snap.snapPoint({ point: { x: 98, y: 51 }, others: [{ x: 100, y: 50, w: 10, h: 10 }], threshold: 4 });
    assert.equal(p.x, 100);
    assert.equal(p.y, 50);
    assert.ok(p.guides.length >= 2);
  });

  test('snapResize: east and west handles snap the moving edge only', () => {
    const others = [{ x: 300, y: 0, w: 50, h: 50 }];
    const e = snap.snapResize({ rect: { x: 100, y: 100, w: 197, h: 50 }, handle: 'e', others, threshold: 6 });
    assert.deepEqual(e.rect, { x: 100, y: 100, w: 200, h: 50 });
    assert.equal(e.snapped.x, 'edge');
    assert.ok(e.guides.some((g) => g.axis === 'x' && g.pos === 300 && g.from === 0 && g.to === 150));

    const w = snap.snapResize({ rect: { x: 352, y: 100, w: 100, h: 50 }, handle: 'w', others, threshold: 6 });
    assert.deepEqual(w.rect, { x: 350, y: 100, w: 102, h: 50 });

    const none = snap.snapResize({ rect: { x: 100, y: 100, w: 150, h: 50 }, handle: 'e', others, threshold: 6 });
    assert.deepEqual(none.rect, { x: 100, y: 100, w: 150, h: 50 });
    assert.deepEqual(none.guides, []);
  });

  test('snapResize: corner handle snaps both axes; fromCenter mirrors', () => {
    const others = [{ x: 300, y: 400, w: 10, h: 10 }];
    const r = snap.snapResize({ rect: { x: 100, y: 100, w: 198, h: 302 }, handle: 'se', others, threshold: 6 });
    assert.deepEqual(r.rect, { x: 100, y: 100, w: 200, h: 300 });
    const c = snap.snapResize({ rect: { x: 100, y: 100, w: 198, h: 50 }, handle: 'e', others, threshold: 6, fromCenter: true });
    assert.deepEqual(c.rect, { x: 98, y: 100, w: 202, h: 50 });
  });

  test('snapResize: keepAspect snaps the closer axis and derives the other', () => {
    const others = [{ x: 199, y: 0, w: 1, h: 1 }, { x: 0, y: 305, w: 1, h: 1 }];
    const r = snap.snapResize({ rect: { x: 0, y: 0, w: 198, h: 99 }, handle: 'se', others, threshold: 10, keepAspect: true });
    close(r.rect.w, 199);
    close(r.rect.h, 99.5);
    assert.equal(r.rect.x, 0);
    assert.equal(r.rect.y, 0);
    const nw = snap.snapResize({ rect: { x: 2, y: 1, w: 198, h: 99 }, handle: 'nw', others: [{ x: -1, y: 500, w: 1, h: 1 }], threshold: 5, keepAspect: true });
    close(nw.rect.x, 0);
    close(nw.rect.w, 200);
    close(nw.rect.h, 100);
    close(nw.rect.y + nw.rect.h, 100, 1e-6, 'bottom edge stays');
  });

  test('snapResize: min size and grid', () => {
    const tooSmall = snap.snapResize({ rect: { x: 100, y: 0, w: 4, h: 10 }, handle: 'e', others: [{ x: 101, y: 0, w: 5, h: 5 }], threshold: 6, minW: 4 });
    assert.equal(tooSmall.rect.w, 4, 'snap rejected (would be 3.5px < minW)');
    const g = snap.snapResize({ rect: { x: 0, y: 0, w: 47, h: 10 }, handle: 'e', grid: true, gridSize: 8, threshold: 3 });
    assert.equal(g.rect.w, 48);
    assert.equal(g.snapped.x, 'grid');
    assert.ok(g.guides.some((x) => x.kind === 'grid' && x.pos === 48));
  });
}

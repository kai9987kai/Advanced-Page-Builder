export default function (APB, t) {
  const { test, assert } = t;
  const geo = APB.require('geometry');
  const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
  const nearPt = (p, q, eps = 1e-6, msg = '') => { near(p.x, q.x, eps, msg + ' x'); near(p.y, q.y, eps, msg + ' y'); };

  test('rotatePoint / corners / center', () => {
    nearPt(geo.rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
    nearPt(geo.rotatePoint({ x: 5, y: 5 }, { x: 5, y: 5 }, 33), { x: 5, y: 5 });
    const r = { x: 0, y: 0, w: 100, h: 50 };
    assert.deepEqual(geo.center(r), { x: 50, y: 25 });
    const c = geo.corners(r, 180);
    nearPt(c[0], { x: 100, y: 50 });
    nearPt(c[2], { x: 0, y: 0 });
  });

  test('aabb / union / rotatedBounds', () => {
    assert.deepEqual(geo.aabb([{ x: 1, y: 2 }, { x: 5, y: -1 }]), { x: 1, y: -1, w: 4, h: 3 });
    assert.deepEqual(geo.union([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 5, h: 20 }]), { x: 0, y: 0, w: 25, h: 25 });
    assert.deepEqual(geo.aabb([]), { x: 0, y: 0, w: 0, h: 0 });
    const b = geo.rotatedBounds({ x: 0, y: 0, w: 100, h: 100 }, 45);
    near(b.w, Math.SQRT2 * 100, 1e-6);
    near(b.x, 50 - Math.SQRT2 * 50, 1e-6);
  });

  test('intersects / contains / pointInRect (rotated)', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.ok(geo.intersects(a, { x: 5, y: 5, w: 10, h: 10 }));
    assert.ok(geo.intersects(a, { x: 10, y: 0, w: 5, h: 5 }), 'touching counts');
    assert.ok(!geo.intersects(a, { x: 11, y: 0, w: 5, h: 5 }));
    assert.ok(geo.contains(a, { x: 1, y: 1, w: 8, h: 8 }));
    assert.ok(!geo.contains(a, { x: 1, y: 1, w: 10, h: 8 }));
    const thin = { x: 0, y: 45, w: 100, h: 10 };
    assert.ok(geo.pointInRect({ x: 90, y: 50 }, thin, 0));
    assert.ok(!geo.pointInRect({ x: 90, y: 50 }, thin, 90), 'rotated 90° the far end is outside');
    assert.ok(geo.pointInRect({ x: 50, y: 90 }, thin, 90));
  });

  test('angles', () => {
    near(geo.angleFrom({ x: 0, y: 0 }, { x: 0, y: 10 }), 90);
    near(geo.angleFrom({ x: 0, y: 0 }, { x: -10, y: 0 }), 180);
    near(geo.angleFrom({ x: 0, y: 0 }, { x: 0, y: -10 }), 270);
    assert.equal(geo.snapAngle(22, 15), 15);
    assert.equal(geo.snapAngle(23, 15), 30);
    assert.equal(geo.snapAngle(-7, 15), 0);
    assert.equal(geo.normalizeAngle(270), -90);
    assert.equal(geo.normalizeAngle(-180), 180);
    assert.equal(geo.normalizeAngle(720), 0);
  });

  test('resize unrotated: handles move the right edges', () => {
    const r = { x: 10, y: 10, w: 100, h: 50 };
    assert.deepEqual(geo.resize(r, 'se', { x: 20, y: 10 }), { x: 10, y: 10, w: 120, h: 60 });
    assert.deepEqual(geo.resize(r, 'nw', { x: 20, y: 10 }), { x: 30, y: 20, w: 80, h: 40 });
    assert.deepEqual(geo.resize(r, 'e', { x: 5, y: 99 }), { x: 10, y: 10, w: 105, h: 50 });
    assert.deepEqual(geo.resize(r, 'n', { x: 99, y: -10 }), { x: 10, y: 0, w: 100, h: 60 });
    assert.deepEqual(geo.resize(r, 'se', { x: 10, y: 5 }, { fromCenter: true }), { x: 0, y: 5, w: 120, h: 60 });
    const tiny = geo.resize(r, 'e', { x: -500, y: 0 }, { minW: 4 });
    assert.equal(tiny.w, 4);
    assert.equal(tiny.x, 10, 'west edge stays when clamped');
  });

  test('resize keepAspect keeps the ratio', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 };
    const a = geo.resize(r, 'se', { x: 100, y: 0 }, { keepAspect: true });
    assert.deepEqual(a, { x: 0, y: 0, w: 300, h: 150 });
    const b = geo.resize(r, 'e', { x: 100, y: 0 }, { keepAspect: true });
    near(b.w / b.h, 2);
    near(b.y + b.h / 2, 50, 1e-9, 'edge handle grows symmetrically on the other axis');
    const c = geo.resize(r, 'nw', { x: 0, y: -50 }, { keepAspect: true });
    near(c.w / c.h, 2);
    near(c.x + c.w, 200, 1e-9, 'east edge fixed');
    near(c.y + c.h, 100, 1e-9, 'south edge fixed');
  });

  test('rotated resize keeps the opposite corner fixed in world space', () => {
    // Index of the opposite corner in corners() order [tl, tr, br, bl].
    const opposite = { se: 0, sw: 1, nw: 2, ne: 3 };
    for (const rotation of [30, -65, 135, 200]) {
      for (const handle of ['se', 'sw', 'nw', 'ne']) {
        const r = { x: 40, y: 60, w: 160, h: 90 };
        const before = geo.corners(r, rotation)[opposite[handle]];
        const next = geo.resize(r, handle, { x: 37, y: -21 }, { rotation });
        const after = geo.corners(next, rotation)[opposite[handle]];
        nearPt(after, before, 1e-6, `${handle}@${rotation}`);
      }
      // Edge handle: the opposite edge midpoint stays put.
      const r = { x: 0, y: 0, w: 100, h: 40 };
      const cs = geo.corners(r, rotation);
      const westMid = { x: (cs[0].x + cs[3].x) / 2, y: (cs[0].y + cs[3].y) / 2 };
      const next = geo.resize(r, 'e', { x: 30, y: 30 }, { rotation });
      const ns = geo.corners(next, rotation);
      nearPt({ x: (ns[0].x + ns[3].x) / 2, y: (ns[0].y + ns[3].y) / 2 }, westMid, 1e-6, 'e@' + rotation);
      const local = geo.rotateVector({ x: 30, y: 30 }, -rotation);
      near(next.w, 100 + local.x, 1e-6, 'width grows by the local x delta');
    }
    // Rotated + keepAspect + fromCenter keeps the center.
    const r = { x: 0, y: 0, w: 120, h: 60 };
    const next = geo.resize(r, 'se', { x: 20, y: 20 }, { rotation: 45, keepAspect: true, fromCenter: true });
    nearPt(geo.center(next), geo.center(r));
    near(next.w / next.h, 2);
  });

  test('scaleRectsInBounds / rectFromPoints / toLocal', () => {
    const out = geo.scaleRectsInBounds([{ x: 10, y: 10, w: 10, h: 10 }], { x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 200, h: 50 });
    assert.deepEqual(out, [{ x: 120, y: 5, w: 20, h: 5 }]);
    assert.deepEqual(geo.rectFromPoints({ x: 10, y: 5 }, { x: 0, y: 20 }), { x: 0, y: 5, w: 10, h: 15 });
    nearPt(geo.toLocal({ x: 50, y: 50 }, { x: 0, y: 0, w: 100, h: 100 }, 90), { x: 50, y: 50 });
  });
}

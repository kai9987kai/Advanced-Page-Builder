/* @node-testable */
/*
 * geometry — rect math, rotation and resize. Pure. Rect = { x, y, w, h }; angles in degrees,
 * clockwise positive in screen space (y grows downward). See ARCHITECTURE.md §6.4.
 */
APB.define('geometry', [], function () {
  'use strict';

  const RAD = Math.PI / 180;

  function rotateVector(v, deg) {
    if (!deg) return { x: v.x, y: v.y };
    const c = Math.cos(deg * RAD);
    const s = Math.sin(deg * RAD);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }

  function rotatePoint(p, center, deg) {
    const v = rotateVector({ x: p.x - center.x, y: p.y - center.y }, deg);
    return { x: center.x + v.x, y: center.y + v.y };
  }

  function center(rect) {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  /** Corners [tl, tr, br, bl] of rect rotated by deg around its center. */
  function corners(rect, deg = 0) {
    const c = center(rect);
    const pts = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h }
    ];
    return deg ? pts.map((p) => rotatePoint(p, c, deg)) : pts;
  }

  /** Axis-aligned bounding box of points ({x,y}) and/or rects ({x,y,w,h}). */
  function aabb(items) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const it of items || []) {
      if (!it) continue;
      const hasSize = typeof it.w === 'number' && typeof it.h === 'number';
      const x2 = hasSize ? it.x + it.w : it.x;
      const y2 = hasSize ? it.y + it.h : it.y;
      if (it.x < minX) minX = it.x;
      if (it.y < minY) minY = it.y;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function union(rects) {
    return aabb(rects);
  }

  function rotatedBounds(rect, deg) {
    return deg ? aabb(corners(rect, deg)) : { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }

  /** Inclusive overlap test (touching edges count). */
  function intersects(a, b) {
    return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
  }

  /** true when rect a fully contains rect b. */
  function contains(a, b) {
    return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  }

  function pointInRect(p, rect, deg = 0) {
    const q = deg ? rotatePoint(p, center(rect), -deg) : p;
    return q.x >= rect.x && q.x <= rect.x + rect.w && q.y >= rect.y && q.y <= rect.y + rect.h;
  }

  function rectFromPoints(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function expand(rect, n) {
    return { x: rect.x - n, y: rect.y - n, w: rect.w + 2 * n, h: rect.h + 2 * n };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Normalise to (-180, 180]. */
  function normalizeAngle(deg) {
    let d = ((deg % 360) + 360) % 360;
    if (d > 180) d -= 360;
    return Object.is(d, -0) ? 0 : d;
  }

  /** Angle in degrees [0, 360) of the vector center → point (0 = +x, clockwise). */
  function angleFrom(c, p) {
    const deg = Math.atan2(p.y - c.y, p.x - c.x) / RAD;
    return (deg + 360) % 360;
  }

  function snapAngle(deg, step) {
    if (!(step > 0)) return deg;
    const r = Math.round(deg / step) * step;
    return Object.is(r, -0) ? 0 : r;
  }

  /**
   * resize(rect, handle, delta, opts) → rect
   * handle: n s e w ne nw se sw. delta: { x, y } (or { dx, dy }) pointer movement in world space.
   * opts: { rotation, keepAspect, fromCenter, minW = 1, minH = 1 }.
   * The opposite corner/edge (or the center with fromCenter) stays fixed in world space.
   */
  function resize(rect, handle, delta, opts = {}) {
    const rotation = opts.rotation || 0;
    const minW = opts.minW === undefined ? 1 : opts.minW;
    const minH = opts.minH === undefined ? 1 : opts.minH;
    const h = String(handle || '');
    const sx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
    const sy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
    const dxw = delta ? (delta.x !== undefined ? delta.x : delta.dx || 0) : 0;
    const dyw = delta ? (delta.y !== undefined ? delta.y : delta.dy || 0) : 0;
    const local = rotateVector({ x: dxw, y: dyw }, -rotation);
    const factor = opts.fromCenter ? 2 : 1;

    let w = rect.w + sx * local.x * factor;
    let hh = rect.h + sy * local.y * factor;

    if (opts.keepAspect && rect.w > 0 && rect.h > 0) {
      const ratio = rect.w / rect.h;
      if (sx && sy) {
        const rw = w / rect.w;
        const rh = hh / rect.h;
        if (Math.abs(rw - 1) >= Math.abs(rh - 1)) hh = w / ratio; else w = hh * ratio;
      } else if (sx) {
        hh = w / ratio;
      } else if (sy) {
        w = hh * ratio;
      }
      if (w < minW) { w = minW; hh = w / ratio; }
      if (hh < minH) { hh = minH; w = hh * ratio; }
    } else {
      if (w < minW) w = minW;
      if (hh < minH) hh = minH;
    }

    // Anchor offsets from the center in the rect's local frame. For edge handles the other axis
    // is anchored on the center line (sx or sy = 0), so keepAspect grows it symmetrically.
    const ax = opts.fromCenter ? 0 : -sx * rect.w / 2;
    const ay = opts.fromCenter ? 0 : -sy * rect.h / 2;
    const nax = opts.fromCenter ? 0 : -sx * w / 2;
    const nay = opts.fromCenter ? 0 : -sy * hh / 2;

    const c = center(rect);
    const a = rotateVector({ x: ax, y: ay }, rotation);
    const worldAnchor = { x: c.x + a.x, y: c.y + a.y };
    const off = rotateVector({ x: nax, y: nay }, rotation);
    const nc = { x: worldAnchor.x - off.x, y: worldAnchor.y - off.y };
    return { x: nc.x - w / 2, y: nc.y - hh / 2, w, h: hh };
  }

  /** Map rects proportionally from fromBounds into toBounds. */
  function scaleRectsInBounds(rects, fromBounds, toBounds) {
    const sx = fromBounds.w ? toBounds.w / fromBounds.w : 1;
    const sy = fromBounds.h ? toBounds.h / fromBounds.h : 1;
    return (rects || []).map((r) => ({
      x: toBounds.x + (r.x - fromBounds.x) * sx,
      y: toBounds.y + (r.y - fromBounds.y) * sy,
      w: r.w * sx,
      h: r.h * sy
    }));
  }

  /** World point → rect-local point (unrotated frame, origin at rect.x/y). */
  function toLocal(p, rect, deg = 0) {
    const q = deg ? rotatePoint(p, center(rect), -deg) : p;
    return { x: q.x - rect.x, y: q.y - rect.y };
  }

  return {
    rotatePoint, rotateVector, corners, aabb, union, rotatedBounds, intersects, contains, pointInRect,
    center, resize, angleFrom, snapAngle, normalizeAngle, scaleRectsInBounds, rectFromPoints, expand,
    distance, toLocal
  };
});

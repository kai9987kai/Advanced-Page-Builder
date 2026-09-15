/* @node-testable */
/*
 * snapping — pure snap engine for moving and resizing rects (ARCHITECTURE.md §6.10).
 *
 * All rects are axis-aligned { x, y, w, h } in one coordinate space (the caller passes rotated
 * nodes as their AABB). `threshold` is in the same units (document px; the caller divides screen
 * px by the zoom). Candidates per axis are sorted once and queried by binary search, so a move
 * against n siblings costs O(n log n).
 *
 * Guides: { axis, pos, from, to, kind } — axis 'x' is a vertical line at x = pos spanning
 * y ∈ [from, to]; axis 'y' is a horizontal line at y = pos spanning x ∈ [from, to].
 * Spacing: { axis, a, b, gap, from, to, pos } — axis 'x' is a horizontal gap between rect a (left)
 * and rect b (right) from x = from to x = to, drawn at y = pos (and vice versa for 'y').
 */
APB.define('snapping', [], function () {
  'use strict';

  const EPS = 0.01;          // coincidence tolerance for guides after snapping
  const GAP_EPS = 0.5;       // tolerance when listing existing equal gaps
  const PRIORITY = { edge: 0, center: 0, parent: 1, spacing: 2, grid: 3 };
  const AXES = {
    x: { p: 'x', s: 'w', q: 'y', t: 'h' },
    y: { p: 'y', s: 'h', q: 'x', t: 'w' }
  };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, d) => (isNum(v) ? v : d);

  function validRect(r) {
    return !!r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h);
  }

  function normRect(r) {
    let { x, y, w, h } = r;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x, y, w, h };
  }

  function normalizeOthers(list) {
    const others = [];
    if (Array.isArray(list)) for (const r of list) if (validRect(r)) others.push(normRect(r));
    return others;
  }

  function readOptions(o) {
    const idx = o.index && o.index.__snapIndex ? o.index : null;
    const others = idx ? idx.others : normalizeOthers(o.others);
    const gridSize = o.grid && num(o.gridSize, 0) > 0 ? o.gridSize : 0;
    const go = o.gridOrigin && typeof o.gridOrigin === 'object' ? o.gridOrigin : {};
    return {
      threshold: Math.max(0, num(o.threshold, 6)),
      objects: o.objects !== false,
      others,
      index: idx,
      parent: idx ? idx.parent : (validRect(o.parent) ? normRect(o.parent) : null),
      gridSize,
      gridOrigin: { x: num(go.x, 0), y: num(go.y, 0) }
    };
  }

  /* ------------------------------------------------------------ candidates */

  /** Sorted snap lines for one axis: sibling edges/centers and parent edges/center. */
  function buildCandidates(axis, cfg) {
    if (!cfg.objects) return [];
    if (cfg.index) return cfg.index[axis];
    return sortedCandidates(axis, cfg.others, cfg.parent);
  }

  function sortedCandidates(axis, others, parent) {
    const A = AXES[axis];
    const list = [];
    for (const r of others) {
      list.push({ v: r[A.p], kind: 'edge', rect: r });
      list.push({ v: r[A.p] + r[A.s] / 2, kind: 'center', rect: r });
      list.push({ v: r[A.p] + r[A.s], kind: 'edge', rect: r });
    }
    const pr = parent;
    if (pr) {
      list.push({ v: pr[A.p], kind: 'parent', rect: pr });
      list.push({ v: pr[A.p] + pr[A.s] / 2, kind: 'parent', rect: pr });
      list.push({ v: pr[A.p] + pr[A.s], kind: 'parent', rect: pr });
    }
    list.sort((a, b) => a.v - b.v);
    return list;
  }

  /** First index whose value is >= v. */
  function lowerBound(list, v, key) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mv = key ? list[mid][key] : list[mid];
      if (mv < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Nearest candidate to value within thr → { d, ad, kind } | null. */
  function nearest(list, value, thr) {
    let best = null;
    for (let i = lowerBound(list, value - thr, 'v'); i < list.length && list[i].v <= value + thr; i++) {
      const c = list[i];
      const d = c.v - value;
      const ad = Math.abs(d);
      if (!best || ad < best.ad - 1e-9 || (Math.abs(ad - best.ad) <= 1e-9 && PRIORITY[c.kind] < PRIORITY[best.kind])) {
        best = { d, ad, kind: c.kind };
      }
    }
    return best;
  }

  function matchesAt(list, value, eps) {
    const out = [];
    for (let i = lowerBound(list, value - eps, 'v'); i < list.length && list[i].v <= value + eps; i++) out.push(list[i]);
    return out;
  }

  function gridLine(v, size, origin) {
    return origin + Math.round((v - origin) / size) * size;
  }

  function better(cand, best) {
    if (!best) return true;
    if (cand.ad < best.ad - 1e-9) return true;
    return Math.abs(cand.ad - best.ad) <= 1e-9 && PRIORITY[cand.kind] < PRIORITY[best.kind];
  }

  /* -------------------------------------------------------- equal spacing */

  /** Others overlapping `rect` on the cross axis (the "row" for axis x, the "column" for axis y). */
  function lineNeighbours(axis, rect, others) {
    const A = AXES[axis];
    const lo = rect[A.q];
    const hi = rect[A.q] + rect[A.t];
    const out = [];
    for (const r of others) if (r[A.q] < hi && r[A.q] + r[A.t] > lo) out.push(r);
    return out;
  }

  /** Gaps between consecutive non-overlapping neighbours, sorted by start. */
  function gapPairs(axis, row) {
    const A = AXES[axis];
    const sorted = row.slice().sort((a, b) => a[A.p] - b[A.p]);
    const pairs = [];
    let prev = null;
    for (const r of sorted) {
      if (prev) {
        const gap = r[A.p] - (prev[A.p] + prev[A.s]);
        if (gap > EPS) pairs.push({ a: prev, b: r, gap });
      }
      if (!prev || r[A.p] + r[A.s] > prev[A.p] + prev[A.s]) prev = r;
    }
    return pairs;
  }

  function nearestNeighbours(axis, rect, row, tol) {
    const A = AXES[axis];
    const start = rect[A.p];
    const end = start + rect[A.s];
    let L = null;
    let R = null;
    for (const r of row) {
      const rs = r[A.p];
      const re = rs + r[A.s];
      if (re <= start + tol && rs < start && (!L || re > L[A.p] + L[A.s])) L = r;
      if (rs >= end - tol && re > end && (!R || rs < R[A.p])) R = r;
    }
    return { L, R };
  }

  /**
   * Equal-spacing snap along one axis → { d, ad, kind: 'spacing', gap } | null.
   * Cases: centre the rect between its nearest neighbours, or continue an existing gap after the
   * left neighbour / before the right neighbour.
   */
  function spacingSnap(axis, rect, others, thr) {
    const A = AXES[axis];
    const row = lineNeighbours(axis, rect, others);
    if (!row.length) return null;
    const start = rect[A.p];
    const size = rect[A.s];
    const end = start + size;
    const { L, R } = nearestNeighbours(axis, rect, row, thr);
    const lEnd = L ? L[A.p] + L[A.s] : -Infinity;
    const rStart = R ? R[A.p] : Infinity;
    let best = null;
    const consider = (d, gap) => {
      const c = { d, ad: Math.abs(d), kind: 'spacing', gap };
      if (c.ad <= thr && gap > EPS && (!best || c.ad < best.ad - 1e-9)) best = c;
    };
    if (L && R) {
      const gap = (rStart - lEnd - size) / 2;
      consider(lEnd + gap - start, gap);
    }
    if (L || R) {
      // Existing gaps whose interval does not contain the moving rect.
      const gaps = gapPairs(axis, row)
        .filter((p) => !(p.a[A.p] + p.a[A.s] < end && p.b[A.p] > start))
        .map((p) => p.gap)
        .sort((a, b) => a - b);
      if (gaps.length) {
        if (L) {
          const want = start - lEnd; // gap that would leave the rect where it is
          for (let i = lowerBound(gaps, want - thr); i < gaps.length && gaps[i] <= want + thr; i++) {
            const g = gaps[i];
            if (lEnd + g + size <= rStart + EPS) consider(lEnd + g - start, g);
          }
        }
        if (R) {
          const want = rStart - end;
          for (let i = lowerBound(gaps, want - thr); i < gaps.length && gaps[i] <= want + thr; i++) {
            const g = gaps[i];
            if (rStart - g - size >= lEnd - EPS) consider(rStart - g - size - start, g);
          }
        }
      }
    }
    return best;
  }

  function spacingSegment(axis, a, b, gap) {
    const A = AXES[axis];
    const lo = Math.max(a[A.q], b[A.q]);
    const hi = Math.min(a[A.q] + a[A.t], b[A.q] + b[A.t]);
    const pos = hi >= lo ? (lo + hi) / 2 : (Math.min(a[A.q], b[A.q]) + Math.max(a[A.q] + a[A.t], b[A.q] + b[A.t])) / 2;
    return { axis, a, b, gap, from: a[A.p] + a[A.s], to: b[A.p], pos };
  }

  /** Spacing segments equal to `gap` around the (snapped) rect and among its neighbours. */
  function spacingSegments(axis, rect, others, gap) {
    const A = AXES[axis];
    const row = lineNeighbours(axis, rect, others);
    const out = [];
    const { L, R } = nearestNeighbours(axis, rect, row, EPS);
    if (L && Math.abs(rect[A.p] - (L[A.p] + L[A.s]) - gap) <= GAP_EPS) out.push(spacingSegment(axis, L, rect, gap));
    if (R && Math.abs(R[A.p] - (rect[A.p] + rect[A.s]) - gap) <= GAP_EPS) out.push(spacingSegment(axis, rect, R, gap));
    for (const p of gapPairs(axis, row)) {
      if (Math.abs(p.gap - gap) > GAP_EPS) continue;
      if (p.a[A.p] + p.a[A.s] < rect[A.p] + rect[A.s] && p.b[A.p] > rect[A.p]) continue; // spans the rect
      out.push(spacingSegment(axis, p.a, p.b, p.gap));
    }
    return out;
  }

  /* ----------------------------------------------------------------- guides */

  function crossExtent(axis, rects) {
    const A = AXES[axis];
    let from = Infinity;
    let to = -Infinity;
    for (const r of rects) {
      if (r[A.q] < from) from = r[A.q];
      if (r[A.q] + r[A.t] > to) to = r[A.q] + r[A.t];
    }
    return { from, to };
  }

  /**
   * Guides for the given positions of the snapped rect on one axis: every candidate line that
   * coincides with a position, merged per (pos, kind).
   */
  function collectGuides(axis, rect, positions, cands, extra) {
    const map = new Map();
    for (const pos of positions) {
      for (const c of matchesAt(cands, pos, EPS)) {
        const key = c.kind + ':' + Math.round(c.v * 100);
        let g = map.get(key);
        if (!g) { g = { axis, pos: c.v, kind: c.kind, rects: [rect] }; map.set(key, g); }
        g.rects.push(c.rect);
      }
    }
    const out = [];
    for (const g of map.values()) {
      const ext = crossExtent(axis, g.rects);
      out.push({ axis, pos: g.pos, from: ext.from, to: ext.to, kind: g.kind });
    }
    if (extra) out.push(extra);
    out.sort((a, b) => a.pos - b.pos || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out;
  }

  function gridGuide(axis, rect, pos, parent) {
    const ext = crossExtent(axis, parent ? [rect, parent] : [rect]);
    return { axis, pos, from: ext.from, to: ext.to, kind: 'grid' };
  }

  /* ------------------------------------------------------------------- move */

  /**
   * snapMove({ rect, others, parent, grid, gridSize, gridOrigin, threshold, objects })
   *   → { dx, dy, guides, spacing, snapped: { x: kind|null, y: kind|null } }
   * Snaps left/center/right (top/middle/bottom) of rect to sibling lines, parent edges/center,
   * equal gaps between siblings and the grid; the closest candidate per axis wins (ties prefer
   * object alignment over parent, spacing and grid).
   */
  function snapMove(opts) {
    const o = opts || {};
    const result = { dx: 0, dy: 0, guides: [], spacing: [], snapped: { x: null, y: null } };
    if (!validRect(o.rect)) return result;
    const rect = normRect(o.rect);
    const cfg = readOptions(o);
    const thr = cfg.threshold;
    if (!(thr > 0)) return result;

    const perAxis = {};
    for (const axis of ['x', 'y']) {
      const A = AXES[axis];
      const cands = buildCandidates(axis, cfg);
      const start = rect[A.p];
      const size = rect[A.s];
      const anchors = size > 0 ? [start, start + size / 2, start + size] : [start];
      let best = null;
      for (const a of anchors) {
        const n = nearest(cands, a, thr);
        if (n && better(n, best)) best = n;
      }
      let gridPos = null;
      if (cfg.gridSize) {
        for (const a of size > 0 ? [start, start + size] : [start]) {
          const line = gridLine(a, cfg.gridSize, cfg.gridOrigin[axis]);
          const c = { d: line - a, ad: Math.abs(line - a), kind: 'grid' };
          if (c.ad <= thr && better(c, best)) { best = c; gridPos = line; }
        }
      }
      let spacing = null;
      if (cfg.objects && size > 0) {
        spacing = spacingSnap(axis, rect, cfg.others, thr);
        if (spacing && better(spacing, best)) { best = spacing; gridPos = null; }
      }
      if (best && best.kind !== 'grid') gridPos = null;
      perAxis[axis] = { cands, best, spacing, gridPos };
      if (best) {
        result['d' + axis] = best.d;
        result.snapped[axis] = best.kind;
      }
    }

    const moved = { x: rect.x + result.dx, y: rect.y + result.dy, w: rect.w, h: rect.h };
    for (const axis of ['x', 'y']) {
      const info = perAxis[axis];
      if (!info.best) continue;
      const A = AXES[axis];
      const start = moved[A.p];
      const positions = moved[A.s] > 0 ? [start, start + moved[A.s] / 2, start + moved[A.s]] : [start];
      const extra = info.gridPos !== null ? gridGuide(axis, moved, info.gridPos, cfg.parent) : null;
      result.guides.push.apply(result.guides, collectGuides(axis, moved, positions, info.cands, extra));
      if (info.spacing && Math.abs(info.spacing.d - info.best.d) <= EPS) {
        result.spacing.push.apply(result.spacing, spacingSegments(axis, moved, cfg.others, info.spacing.gap));
      }
    }
    return result;
  }

  /** snapPoint({ point, others, parent, grid, gridSize, threshold }) → { x, y, guides } (drawing tools). */
  function snapPoint(opts) {
    const o = opts || {};
    const p = o.point || {};
    if (!isNum(p.x) || !isNum(p.y)) return { x: p.x, y: p.y, guides: [] };
    const r = snapMove(Object.assign({}, o, { rect: { x: p.x, y: p.y, w: 0, h: 0 } }));
    return { x: p.x + r.dx, y: p.y + r.dy, guides: r.guides };
  }

  /* ----------------------------------------------------------------- resize */

  /**
   * snapResize({ rect, handle, others, parent, grid, gridSize, gridOrigin, threshold, objects,
   *              keepAspect, fromCenter, minW = 1, minH = 1 }) → { rect, guides, snapped }
   * `rect` is the proposed (already resized) rect; the edges moved by `handle` (n s e w ne nw se sw)
   * snap to sibling/parent lines and the grid. With keepAspect only the closer axis snaps and the
   * other dimension follows the aspect ratio (anchored like geometry.resize).
   */
  function snapResize(opts) {
    const o = opts || {};
    if (!validRect(o.rect)) return { rect: o.rect ? Object.assign({}, o.rect) : null, guides: [], snapped: { x: null, y: null } };
    const rect = normRect(o.rect);
    const cfg = readOptions(o);
    const thr = cfg.threshold;
    const handle = String(o.handle || '');
    const fromCenter = !!o.fromCenter;
    const mins = { x: Math.max(0, num(o.minW, 1)), y: Math.max(0, num(o.minH, 1)) };
    const moving = {
      x: handle.includes('e') ? 'end' : handle.includes('w') ? 'start' : null,
      y: handle.includes('s') ? 'end' : handle.includes('n') ? 'start' : null
    };
    const out = { rect: Object.assign({}, rect), guides: [], snapped: { x: null, y: null } };
    if (!(thr > 0) || (!moving.x && !moving.y)) return out;

    const found = {};
    for (const axis of ['x', 'y']) {
      if (!moving[axis]) continue;
      const A = AXES[axis];
      const cands = buildCandidates(axis, cfg);
      const edge = moving[axis] === 'end' ? rect[A.p] + rect[A.s] : rect[A.p];
      let best = nearest(cands, edge, thr);
      let gridPos = null;
      if (cfg.gridSize) {
        const line = gridLine(edge, cfg.gridSize, cfg.gridOrigin[axis]);
        const c = { d: line - edge, ad: Math.abs(line - edge), kind: 'grid' };
        if (c.ad <= thr && better(c, best)) { best = c; gridPos = line; }
      }
      if (best) {
        // Reject snaps that would violate the minimum size.
        const k = fromCenter ? 2 : 1;
        const newSize = moving[axis] === 'end' ? rect[A.s] + best.d * k : rect[A.s] - best.d * k;
        if (newSize < mins[axis]) best = null;
      }
      if (best) found[axis] = { best, cands, gridPos: best.kind === 'grid' ? gridPos : null };
    }

    const apply = (r, axis, d) => {
      const A = AXES[axis];
      const k = fromCenter ? 2 : 1;
      if (moving[axis] === 'end') {
        r[A.s] = rect[A.s] + d * k;
        if (fromCenter) r[A.p] = rect[A.p] - d;
      } else {
        r[A.p] = rect[A.p] + d;
        r[A.s] = rect[A.s] - d * k;
      }
    };

    const r = Object.assign({}, rect);
    let axes = Object.keys(found);
    if (o.keepAspect && rect.w > 0 && rect.h > 0 && axes.length) {
      const ratio = rect.w / rect.h;
      const axis = axes.length === 2 ? (found.x.best.ad <= found.y.best.ad ? 'x' : 'y') : axes[0];
      axes = [axis];
      apply(r, axis, found[axis].best.d);
      const other = axis === 'x' ? 'y' : 'x';
      const O = AXES[other];
      const newSize = axis === 'x' ? r.w / ratio : r.h * ratio;
      if (fromCenter || !moving[other]) {
        r[O.p] = rect[O.p] + rect[O.s] / 2 - newSize / 2;
      } else if (moving[other] === 'start') {
        r[O.p] = rect[O.p] + rect[O.s] - newSize;
      } else {
        r[O.p] = rect[O.p];
      }
      r[O.s] = newSize;
    } else {
      for (const axis of axes) apply(r, axis, found[axis].best.d);
    }

    out.rect = r;
    for (const axis of axes) {
      const A = AXES[axis];
      const info = found[axis];
      const edge = moving[axis] === 'end' ? r[A.p] + r[A.s] : r[A.p];
      const positions = fromCenter ? [r[A.p], r[A.p] + r[A.s]] : [edge];
      const extra = info.gridPos !== null ? gridGuide(axis, r, info.gridPos, cfg.parent) : null;
      out.guides.push.apply(out.guides, collectGuides(axis, r, positions, info.cands, extra));
      out.snapped[axis] = info.best.kind;
    }
    return out;
  }

  /**
   * createIndex({ others, parent }) → reusable index for repeated snaps against the same siblings
   * (e.g. every frame of a drag): pass it as `index` instead of `others`/`parent`.
   */
  function createIndex(opts) {
    const o = opts || {};
    const others = normalizeOthers(o.others);
    const parent = validRect(o.parent) ? normRect(o.parent) : null;
    return { __snapIndex: true, others, parent, x: sortedCandidates('x', others, parent), y: sortedCandidates('y', others, parent) };
  }

  return { snapMove, snapResize, snapPoint, createIndex, EPS };
});

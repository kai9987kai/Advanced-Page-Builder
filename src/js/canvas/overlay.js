/*
 * overlay — screen-space selection UI drawn into canvas.overlayEl (ARCHITECTURE.md §7).
 *
 * Draws (in this order): hover outline, per-node selection outlines, selection box, rotate handle,
 * 8 resize handles, "W × H" size label, lock badges, marquee, snap guides, equal-spacing labels and
 * the rotation tooltip. The SVG never receives pointer events: `hitTest(clientX, clientY)` answers
 * which handle / rotation zone / body is under a point, so the renderer's hit testing stays exact.
 *
 * Geometry is measured in page coordinates (renderer.worldRect) only when the selection, the document
 * or the rendered DOM changed, and re-projected on camera changes. `refresh(info)` is called by the
 * canvas frame loop; transient state (marquee, guides, tooltips) is set by the interaction module
 * through `set(patch)`, which schedules a frame.
 */
APB.define('overlay', ['geometry'], function (geometry) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const CORNERS = ['nw', 'ne', 'se', 'sw'];
  const HANDLE_DIR = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
  const HANDLE_ANGLE = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const CORNER_ANGLE = { nw: 0, ne: 90, se: 180, sw: 270 };
  const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
  const HANDLE_SIZE = 8;
  const HIT = 16;
  const HIT_COARSE = 24;
  const ROTATE_ZONE = 20;
  const ROTATE_OFFSET = 22;
  const SMALL_EDGE = 20;
  const MAX_BADGES = 64;
  const MAX_SPACING_LABELS = 32;
  const TRANSIENT_KEYS = ['marquee', 'guides', 'spacing', 'rotation', 'hideHandles', 'hideHover', 'hideSelection', 'label'];

  const cursorCache = new Map();

  function rotateCursor(deg) {
    const a = ((Math.round(deg / 15) * 15) % 360 + 360) % 360;
    if (cursorCache.has(a)) return cursorCache.get(a);
    const arc = 'M7 17a8.5 8.5 0 0 1 10-10';
    const heads = 'M4 14l3 3 3-3M14 4l3 3-3 3';
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
      "<g transform='rotate(" + a + " 12 12)' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
      "<path d='" + arc + ' ' + heads + "' stroke='white' stroke-width='4'/>" +
      "<path d='" + arc + ' ' + heads + "' stroke='black' stroke-width='1.6'/></g></svg>";
    const value = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 12 12, crosshair';
    cursorCache.set(a, value);
    return value;
  }

  function resizeCursor(handle, rotation) {
    const base = HANDLE_ANGLE[handle];
    if (base === undefined) return 'default';
    const a = (((base + (rotation || 0)) % 180) + 180) % 180;
    return RESIZE_CURSORS[Math.round(a / 45) % 4];
  }

  function fmt(v) {
    const r = Math.round(v * 10) / 10;
    return String(Object.is(r, -0) ? 0 : r);
  }

  function rot(x, y, deg) {
    if (!deg) return { x, y };
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  function create(opts) {
    const o = opts || {};
    const app = o.app;
    const canvas = o.canvas;
    const store = app.store;
    const svg = canvas.overlayEl;
    const doc = svg.ownerDocument;
    const offs = [];
    let destroyed = false;

    const transient = {
      marquee: null, guides: [], spacing: [], rotation: null,
      hideHandles: false, hideHover: false, hideSelection: false, label: null
    };

    let geomStale = true;
    let geom = { ids: [], rects: [], box: null, locked: false, anyUnlocked: false };
    let hoverId = null;
    let hoverRect = null;
    let hoverStale = true;

    /* ------------------------------------------------------------- DOM */

    function s(tag, cls, parent, attrs) {
      const e = doc.createElementNS(NS, tag);
      if (cls) e.setAttribute('class', cls);
      if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(e);
      return e;
    }

    function show(e, on) {
      if (on) { if (e.hasAttribute('display')) e.removeAttribute('display'); } else if (e.getAttribute('display') !== 'none') e.setAttribute('display', 'none');
    }

    function attr(e, name, value) {
      const v = String(value);
      if (e.getAttribute(name) !== v) e.setAttribute(name, v);
    }

    function text(e, value) {
      if (e.textContent !== value) e.textContent = value;
    }

    const root = s('g', 'apb-ov');
    const hoverPath = s('path', 'apb-ov-hover', root);
    const outlinePath = s('path', 'apb-ov-outline', root);
    const boxPath = s('path', 'apb-ov-box', root);
    const rotLine = s('path', 'apb-ov-rotate-line', root);
    const rotKnob = s('circle', 'apb-ov-rotate-knob', root, { r: '4.5' });
    const handlesPath = s('path', 'apb-ov-handles', root);
    const badgeGroup = s('g', 'apb-ov-badges', root);
    const sizeLabel = s('g', 'apb-ov-label apb-ov-size', root);
    const sizeBg = s('rect', null, sizeLabel, { rx: '3', ry: '3', height: '18' });
    const sizeText = s('text', null, sizeLabel, { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    const layerHost = s('g', 'apb-ov-layers', root);
    const marqueeRect = s('rect', 'apb-ov-marquee', root);
    const guidePath = s('path', 'apb-ov-guide', root);
    const spacingPath = s('path', 'apb-ov-spacing', root);
    const spacingLabels = s('g', 'apb-ov-spacing-labels', root);
    const tip = s('g', 'apb-ov-label apb-ov-tip', root);
    const tipBg = s('rect', null, tip, { rx: '3', ry: '3', height: '20' });
    const tipText = s('text', null, tip, { 'dominant-baseline': 'central' });
    const layers = new Map();
    const badges = [];
    const spacingPool = [];

    /* --------------------------------------------------------- helpers */

    const renderer = () => canvas.renderer;
    const vp = () => canvas.viewport;

    function project(x, y) {
      return vp().pageToViewport(x, y);
    }

    function isLocked(id) {
      const d = app.docops;
      return !!(d && typeof d.isLocked === 'function' && d.isLocked(store.doc, id));
    }

    function coarsePointer() {
      return !!(app.env && app.env.coarse);
    }

    function polygon(r) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const p = rot((sx * r.w) / 2, (sy * r.h) / 2, r.rotation || 0);
        return project(cx + p.x, cy + p.y);
      });
      return pts;
    }

    function crisp(v) {
      return Math.round(v) + 0.5;
    }

    function polyPath(pts, snap) {
      if (snap) {
        const x1 = crisp(Math.min(pts[0].x, pts[2].x));
        const x2 = crisp(Math.max(pts[0].x, pts[2].x)) - 1;
        const y1 = crisp(Math.min(pts[0].y, pts[2].y));
        const y2 = crisp(Math.max(pts[0].y, pts[2].y)) - 1;
        return 'M' + x1 + ' ' + y1 + 'H' + Math.max(x1, x2) + 'V' + Math.max(y1, y2) + 'H' + x1 + 'Z';
      }
      return 'M' + pts.map((p) => p.x.toFixed(2) + ' ' + p.y.toFixed(2)).join('L') + 'Z';
    }

    function boundsOfPoints(pts) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /* -------------------------------------------------------- geometry */

    function computeGeometry() {
      renderer().flush();
      geomStale = false;
      const doc = store.doc;
      const ids = store.selection.filter((id) => Object.prototype.hasOwnProperty.call(doc.nodes, id));
      const rects = [];
      let anyUnlocked = false;
      let allLocked = ids.length > 0;
      for (const id of ids) {
        const r = renderer().worldRect(id);
        if (!r) continue;
        const locked = isLocked(id);
        if (locked) { /* keep */ } else { anyUnlocked = true; allLocked = false; }
        rects.push({ id, r, locked });
      }
      let box = null;
      if (rects.length === 1) {
        box = Object.assign({}, rects[0].r);
      } else if (rects.length > 1) {
        const items = [];
        for (const it of rects) {
          const r = it.r;
          if (!r.rotation) { items.push(r); continue; }
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const p = rot((sx * r.w) / 2, (sy * r.h) / 2, r.rotation);
            items.push({ x: cx + p.x, y: cy + p.y, w: 0, h: 0 });
          }
        }
        const u = geometry.union(items);
        box = u ? { x: u.x, y: u.y, w: u.w, h: u.h, rotation: 0 } : null;
      }
      let aabb = null;
      if (box && rects.length === 1 && box.rotation) {
        const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
          const p = rot((sx * box.w) / 2, (sy * box.h) / 2, box.rotation);
          return { x: box.x + box.w / 2 + p.x, y: box.y + box.h / 2 + p.y };
        });
        aabb = boundsOfPoints(pts);
      } else if (box) {
        aabb = { x: box.x, y: box.y, w: box.w, h: box.h };
      }
      geom = { ids, rects, box, aabb, locked: allLocked && rects.length > 0, anyUnlocked };
      hoverStale = true;
    }

    /** Axis-aligned page bounds of the rendered selection (shared with the rulers) or null. */
    function selectionBounds() {
      const g = ensureGeometry();
      return g.aabb ? Object.assign({}, g.aabb) : null;
    }

    function markStale() {
      geomStale = true;
      hoverStale = true;
    }

    function ensureGeometry() {
      if (geomStale) computeGeometry();
      return geom;
    }

    function handlesEnabled() {
      const g = ensureGeometry();
      if (!g.box || !g.anyUnlocked) return false;
      if (store.view.editingText) return false;
      if (transient.hideHandles || transient.hideSelection) return false;
      return (store.view.tool || 'select') === 'select';
    }

    function screenBox() {
      const g = ensureGeometry();
      if (!g.box) return null;
      const z = vp().zoom;
      const c = project(g.box.x + g.box.w / 2, g.box.y + g.box.h / 2);
      return { cx: c.x, cy: c.y, w: g.box.w * z, h: g.box.h * z, rotation: g.box.rotation || 0 };
    }

    function handleCenters(sb) {
      const out = {};
      for (const hId of HANDLES) {
        const [sx, sy] = HANDLE_DIR[hId];
        const p = rot((sx * sb.w) / 2, (sy * sb.h) / 2, sb.rotation);
        out[hId] = { x: sb.cx + p.x, y: sb.cy + p.y };
      }
      const k = rot(0, -sb.h / 2 - ROTATE_OFFSET, sb.rotation);
      out.rotate = { x: sb.cx + k.x, y: sb.cy + k.y };
      const t = rot(0, -sb.h / 2, sb.rotation);
      out.top = { x: sb.cx + t.x, y: sb.cy + t.y };
      return out;
    }

    function visibleHandles(sb) {
      const small = sb.w < SMALL_EDGE || sb.h < SMALL_EDGE;
      return small ? CORNERS : HANDLES;
    }

    /* ------------------------------------------------------------ draw */

    function drawHover() {
      const id = transient.hideHover || transient.marquee ? null : store.view.hover;
      const valid = id && Object.prototype.hasOwnProperty.call(store.doc.nodes, id) && !geom.ids.includes(id) && !store.view.editingText;
      if (!valid) { show(hoverPath, false); hoverId = null; return; }
      if (id !== hoverId || hoverStale) {
        hoverId = id;
        hoverStale = false;
        hoverRect = renderer().worldRect(id);
      }
      if (!hoverRect) { show(hoverPath, false); return; }
      const pts = polygon(hoverRect);
      attr(hoverPath, 'd', polyPath(pts, !hoverRect.rotation));
      show(hoverPath, true);
    }

    function drawSelection() {
      const g = geom;
      const editing = !!store.view.editingText;
      const hideSel = transient.hideSelection || !g.box;
      // Per-node outlines (multi-selection, or the single node while a gesture hides the box).
      if (!hideSel && g.rects.length > 1 && !editing) {
        let d = '';
        for (const it of g.rects) d += polyPath(polygon(it.r), !it.r.rotation);
        attr(outlinePath, 'd', d);
        show(outlinePath, true);
      } else {
        show(outlinePath, false);
      }

      if (hideSel || editing) {
        show(boxPath, false);
        show(handlesPath, false);
        show(rotLine, false);
        show(rotKnob, false);
        show(sizeLabel, false);
        drawBadges(editing ? [] : g.rects);
        return;
      }

      const boxPts = polygon(g.box);
      attr(boxPath, 'd', polyPath(boxPts, !g.box.rotation));
      show(boxPath, true);
      boxPath.classList.toggle('apb-ov-locked', g.locked);

      const sb = screenBox();
      const handlesOn = handlesEnabled();
      if (handlesOn) {
        const centers = handleCenters(sb);
        const hs = HANDLE_SIZE / 2;
        let d = '';
        for (const hId of visibleHandles(sb)) {
          const c = centers[hId];
          if (!sb.rotation) {
            const x = crisp(c.x - hs);
            const y = crisp(c.y - hs);
            d += 'M' + x + ' ' + y + 'h' + (HANDLE_SIZE - 1) + 'v' + (HANDLE_SIZE - 1) + 'h' + (1 - HANDLE_SIZE) + 'Z';
          } else {
            const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
              const p = rot(sx * hs, sy * hs, sb.rotation);
              return { x: c.x + p.x, y: c.y + p.y };
            });
            d += polyPath(pts, false);
          }
        }
        attr(handlesPath, 'd', d);
        show(handlesPath, true);
        attr(rotLine, 'd', 'M' + centers.top.x.toFixed(2) + ' ' + centers.top.y.toFixed(2) + 'L' + centers.rotate.x.toFixed(2) + ' ' + centers.rotate.y.toFixed(2));
        attr(rotKnob, 'cx', centers.rotate.x.toFixed(2));
        attr(rotKnob, 'cy', centers.rotate.y.toFixed(2));
        show(rotLine, true);
        show(rotKnob, true);
      } else {
        show(handlesPath, false);
        show(rotLine, false);
        show(rotKnob, false);
      }

      // Size label below the selection.
      const b = boundsOfPoints(boxPts);
      const labelText = transient.label != null ? String(transient.label) : fmt(g.box.w) + ' × ' + fmt(g.box.h);
      text(sizeText, labelText);
      const wLabel = Math.ceil(labelText.length * 6.4 + 12);
      const lx = Math.round(b.x + b.w / 2);
      const ly = Math.round(b.y + b.h + 8);
      attr(sizeBg, 'x', lx - wLabel / 2);
      attr(sizeBg, 'y', ly);
      attr(sizeBg, 'width', wLabel);
      attr(sizeText, 'x', lx);
      attr(sizeText, 'y', ly + 9);
      show(sizeLabel, true);

      drawBadges(g.rects);
    }

    function drawBadges(rects) {
      const locked = rects.filter((it) => it.locked).slice(0, MAX_BADGES);
      while (badges.length < locked.length) {
        const g = s('g', 'apb-ov-badge', badgeGroup);
        s('rect', null, g, { width: '16', height: '16', rx: '3', ry: '3' });
        let icon = null;
        if (typeof APB !== 'undefined' && APB.has('icons')) {
          try { icon = APB.require('icons').get('lock', { size: 12 }); } catch (_) { icon = null; }
        }
        if (icon) {
          icon.setAttribute('x', '2');
          icon.setAttribute('y', '2');
          icon.setAttribute('width', '12');
          icon.setAttribute('height', '12');
          g.appendChild(icon);
        } else {
          s('path', null, g, { d: 'M5 8h6v5H5zM6.5 8V6.5a1.5 1.5 0 0 1 3 0V8', fill: 'none' });
        }
        badges.push(g);
      }
      badges.forEach((g, i) => {
        const it = locked[i];
        if (!it) { show(g, false); return; }
        const b = boundsOfPoints(polygon(it.r));
        attr(g, 'transform', 'translate(' + Math.round(b.x) + ' ' + Math.round(b.y - 20) + ')');
        show(g, true);
      });
    }

    function drawMarquee() {
      const m = transient.marquee;
      if (!m) { show(marqueeRect, false); return; }
      const a = project(m.x, m.y);
      const z = vp().zoom;
      attr(marqueeRect, 'x', crisp(a.x));
      attr(marqueeRect, 'y', crisp(a.y));
      attr(marqueeRect, 'width', Math.max(0, Math.round(m.w * z) - 1));
      attr(marqueeRect, 'height', Math.max(0, Math.round(m.h * z) - 1));
      show(marqueeRect, true);
    }

    function drawGuides() {
      const guides = Array.isArray(transient.guides) ? transient.guides : [];
      if (!guides.length) { show(guidePath, false); } else {
        let d = '';
        for (const gd of guides) {
          if (!gd || !Number.isFinite(gd.pos)) continue;
          if (gd.axis === 'x') {
            const p1 = project(gd.pos, gd.from);
            const p2 = project(gd.pos, gd.to);
            const x = crisp(p1.x);
            d += 'M' + x + ' ' + p1.y.toFixed(1) + 'V' + p2.y.toFixed(1);
            d += 'M' + (x - 3) + ' ' + (p1.y - 3).toFixed(1) + 'l6 6m0 -6l-6 6';
            d += 'M' + (x - 3) + ' ' + (p2.y - 3).toFixed(1) + 'l6 6m0 -6l-6 6';
          } else {
            const p1 = project(gd.from, gd.pos);
            const p2 = project(gd.to, gd.pos);
            const y = crisp(p1.y);
            d += 'M' + p1.x.toFixed(1) + ' ' + y + 'H' + p2.x.toFixed(1);
            d += 'M' + (p1.x - 3).toFixed(1) + ' ' + (y - 3) + 'l6 6m0 -6l-6 6';
            d += 'M' + (p2.x - 3).toFixed(1) + ' ' + (y - 3) + 'l6 6m0 -6l-6 6';
          }
        }
        attr(guidePath, 'd', d);
        show(guidePath, !!d);
      }

      const spacing = Array.isArray(transient.spacing) ? transient.spacing.slice(0, MAX_SPACING_LABELS) : [];
      let d = '';
      spacing.forEach((sp, i) => {
        if (!sp || !Number.isFinite(sp.from) || !Number.isFinite(sp.to) || !Number.isFinite(sp.pos)) return;
        let a;
        let b;
        let mid;
        if (sp.axis === 'x') {
          a = project(sp.from, sp.pos);
          b = project(sp.to, sp.pos);
          const y = crisp(a.y);
          d += 'M' + a.x.toFixed(1) + ' ' + y + 'H' + b.x.toFixed(1) + 'M' + a.x.toFixed(1) + ' ' + (y - 4) + 'v8M' + b.x.toFixed(1) + ' ' + (y - 4) + 'v8';
          mid = { x: (a.x + b.x) / 2, y: y + 12 };
        } else {
          a = project(sp.pos, sp.from);
          b = project(sp.pos, sp.to);
          const x = crisp(a.x);
          d += 'M' + x + ' ' + a.y.toFixed(1) + 'V' + b.y.toFixed(1) + 'M' + (x - 4) + ' ' + a.y.toFixed(1) + 'h8M' + (x - 4) + ' ' + b.y.toFixed(1) + 'h8';
          mid = { x: x + 8 + 14, y: (a.y + b.y) / 2 };
        }
        let lab = spacingPool[i];
        if (!lab) {
          const g = s('g', 'apb-ov-label apb-ov-spacing-label', spacingLabels);
          lab = { g, bg: s('rect', null, g, { rx: '3', ry: '3', height: '16' }), t: s('text', null, g, { 'text-anchor': 'middle', 'dominant-baseline': 'central' }) };
          spacingPool.push(lab);
        }
        const label = fmt(Number.isFinite(sp.gap) ? sp.gap : Math.abs(sp.to - sp.from));
        text(lab.t, label);
        const w = Math.ceil(label.length * 6.4 + 10);
        attr(lab.bg, 'x', Math.round(mid.x - w / 2));
        attr(lab.bg, 'y', Math.round(mid.y - 8));
        attr(lab.bg, 'width', w);
        attr(lab.t, 'x', Math.round(mid.x));
        attr(lab.t, 'y', Math.round(mid.y));
        show(lab.g, true);
      });
      for (let i = spacing.length; i < spacingPool.length; i++) show(spacingPool[i].g, false);
      attr(spacingPath, 'd', d);
      show(spacingPath, !!d);
    }

    function drawTip() {
      const r = transient.rotation;
      if (!r || !Number.isFinite(r.angle)) { show(tip, false); return; }
      const rect = canvas.el.getBoundingClientRect();
      let a = r.angle % 360;
      if (a > 180) a -= 360;
      if (a <= -180) a += 360;
      const label = fmt(a) + '°';
      text(tipText, label);
      const w = Math.ceil(label.length * 6.8 + 14);
      const x = Math.round((Number.isFinite(r.clientX) ? r.clientX - rect.left : 0) + 16);
      const y = Math.round((Number.isFinite(r.clientY) ? r.clientY - rect.top : 0) + 16);
      attr(tipBg, 'x', x);
      attr(tipBg, 'y', y);
      attr(tipBg, 'width', w);
      attr(tipText, 'x', x + 7);
      attr(tipText, 'y', y + 10);
      show(tip, true);
    }

    function refresh(info) {
      if (destroyed) return;
      ensureGeometry();
      drawHover();
      drawSelection();
      drawMarquee();
      drawGuides();
      drawTip();
    }

    /* -------------------------------------------------------- hit test */

    /**
     * hitTest(clientX, clientY, { coarse }) → { type: 'handle', handle } | { type: 'rotate', corner }
     * | { type: 'body' } | null. Handles and rotation zones only exist when handles are shown.
     */
    function hitTest(clientX, clientY, hitOpts) {
      const g = ensureGeometry();
      if (!g.box || store.view.editingText) return null;
      const sb = screenBox();
      const rect = canvas.el.getBoundingClientRect();
      const px = clientX - rect.left - sb.cx;
      const py = clientY - rect.top - sb.cy;
      const l = rot(px, py, -sb.rotation);
      const hw = sb.w / 2;
      const hh = sb.h / 2;
      const inside = Math.abs(l.x) <= hw && Math.abs(l.y) <= hh;
      const coarse = hitOpts && hitOpts.coarse !== undefined ? !!hitOpts.coarse : coarsePointer();
      const r = (coarse ? HIT_COARSE : HIT) / 2;
      if (handlesEnabled()) {
        const k = { x: 0, y: -hh - ROTATE_OFFSET };
        if (Math.hypot(l.x - k.x, l.y - k.y) <= r) return { type: 'rotate', corner: 'n', handle: 'rotate' };
        const small = sb.w < r * 3 || sb.h < r * 3;
        for (const c of CORNERS) {
          const [sx, sy] = HANDLE_DIR[c];
          const dx = l.x - sx * hw;
          const dy = l.y - sy * hh;
          if (Math.abs(dx) <= r && Math.abs(dy) <= r) {
            if (small && inside && Math.hypot(dx, dy) > 5) continue;
            return { type: 'handle', handle: c };
          }
        }
        if (!(sb.w < SMALL_EDGE || sb.h < SMALL_EDGE)) {
          const inY = Math.min(r, hh / 3);
          const inX = Math.min(r, hw / 3);
          if (Math.abs(l.x) <= hw) {
            if (l.y >= -hh - r && l.y <= -hh + inY) return { type: 'handle', handle: 'n' };
            if (l.y <= hh + r && l.y >= hh - inY) return { type: 'handle', handle: 's' };
          }
          if (Math.abs(l.y) <= hh) {
            if (l.x >= -hw - r && l.x <= -hw + inX) return { type: 'handle', handle: 'w' };
            if (l.x <= hw + r && l.x >= hw - inX) return { type: 'handle', handle: 'e' };
          }
        }
        if (!inside) {
          for (const c of CORNERS) {
            const [sx, sy] = HANDLE_DIR[c];
            const ox = sx * l.x - hw;
            const oy = sy * l.y - hh;
            if (ox >= -r && oy >= -r && ox <= r + ROTATE_ZONE && oy <= r + ROTATE_ZONE) return { type: 'rotate', corner: c };
          }
        }
      }
      return inside && !transient.hideSelection ? { type: 'body' } : null;
    }

    function cursorFor(hit) {
      if (!hit) return '';
      const rotation = geom.box ? geom.box.rotation || 0 : 0;
      if (hit.type === 'handle') return resizeCursor(hit.handle, rotation);
      if (hit.type === 'rotate') return rotateCursor((CORNER_ANGLE[hit.corner] !== undefined ? CORNER_ANGLE[hit.corner] : 45) + rotation);
      return '';
    }

    /* -------------------------------------------------------------- API */

    function invalidate() {
      geomStale = true;
      hoverStale = true;
      if (canvas.invalidateOverlay) canvas.invalidateOverlay();
    }

    function set(patch) {
      if (!patch || typeof patch !== 'object') return;
      for (const k of Object.keys(patch)) {
        if (!TRANSIENT_KEYS.includes(k)) continue;
        transient[k] = patch[k];
      }
      if (canvas.invalidateOverlay) canvas.invalidateOverlay();
    }

    function clear() {
      set({ marquee: null, guides: [], spacing: [], rotation: null, hideHandles: false, hideHover: false, hideSelection: false, label: null });
    }

    /** Named <g> layer (page-independent, screen space) for other canvas features (drop indicators, measurements). */
    function layer(name) {
      const key = String(name || 'default');
      if (!layers.has(key)) layers.set(key, s('g', 'apb-ov-layer apb-ov-layer-' + key.replace(/[^\w-]/g, ''), layerHost));
      return layers.get(key);
    }

    /** Client-coordinate handle centres of the current selection box (tests, keyboard helpers). */
    function handlePoints() {
      const sb = screenBox();
      if (!sb) return null;
      const rect = canvas.el.getBoundingClientRect();
      const c = handleCenters(sb);
      const out = {};
      for (const k of Object.keys(c)) out[k] = { x: c[k].x + rect.left, y: c[k].y + rect.top };
      out.center = { x: sb.cx + rect.left, y: sb.cy + rect.top };
      return out;
    }

    offs.push(store.on('selection', () => { geomStale = true; }));
    offs.push(store.on('change', () => { geomStale = true; hoverStale = true; }));
    offs.push(store.on('view', (p) => {
      const ch = (p && p.changed) || [];
      if (ch.some((k) => k !== 'zoom' && k !== 'x' && k !== 'y' && k !== 'hover')) geomStale = true;
    }));

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      root.remove();
    }

    return {
      el: svg,
      refresh, destroy, set, clear, layer, invalidate, markStale, selectionBounds, hitTest, cursorFor, handlePoints,
      get state() { return Object.assign({}, transient); },
      get box() { const g = ensureGeometry(); return g.box ? Object.assign({}, g.box) : null; },
      get rects() { return ensureGeometry().rects.map((it) => ({ id: it.id, locked: it.locked, rect: Object.assign({}, it.r) })); },
      get handlesVisible() { return handlesEnabled(); },
      screenBox
    };
  }

  return { create, HANDLES, resizeCursor, rotateCursor, HIT, HIT_COARSE };
});

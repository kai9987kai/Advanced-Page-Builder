/*
 * viewport — camera (pan / zoom), wheel, pointer, touch and Space navigation, rulers and grid.
 * See ARCHITECTURE.md §7. The camera maps page coordinates to viewport-local screen pixels:
 *
 *   screenLocal = page * zoom + (x, y)        (x, y) = viewport-local position of the page origin
 *
 * The world element carries `transform: translate(x, y) scale(zoom)` (transform-origin 0 0), applied
 * once per animation frame. Camera state is mirrored into store.view (zoom/x/y) without history and
 * remembered per page.
 */
APB.define('viewport', ['util', 'env'], function (util, env) {
  'use strict';

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 64;
  const NICE_ZOOMS = [0.02, 0.03, 0.04, 0.05, 0.0625, 0.08, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1,
    1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
  const RULER_SIZE = 20;
  const FIT_MARGIN = 64;
  const LINE_PX = 16;
  const STEP_RATIO = 1.2;
  const RULER_FONT = '10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function clampZoom(z) {
    return util.clamp(Number.isFinite(z) && z > 0 ? z : 1, MIN_ZOOM, MAX_ZOOM);
  }

  /** Next "nice" zoom level at least ~1.2× above z. */
  function zoomInLevel(z) {
    const target = z * STEP_RATIO * 0.999;
    for (const n of NICE_ZOOMS) if (n > z * 1.001 && n >= target) return n;
    return MAX_ZOOM;
  }

  /** Next "nice" zoom level at least ~1.2× below z. */
  function zoomOutLevel(z) {
    const target = (z / STEP_RATIO) * 1.001;
    for (let i = NICE_ZOOMS.length - 1; i >= 0; i--) {
      if (NICE_ZOOMS[i] < z * 0.999 && NICE_ZOOMS[i] <= target) return NICE_ZOOMS[i];
    }
    return MIN_ZOOM;
  }

  /** Smallest 1/2/5 × 10^n step ≥ min (min ≥ 1 → integer steps). */
  function niceStep(min) {
    const m = Math.max(1e-9, min);
    const base = Math.pow(10, Math.floor(Math.log10(m)));
    for (const k of [1, 2, 5, 10]) if (k * base >= m - 1e-9) return k * base;
    return 10 * base;
  }

  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    return !!(t.closest && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
  }

  /**
   * create({ app, el, world, artboard, grid, label, rulers, requestFrame, getSelectionBounds,
   *          getNodeBounds, beforeMeasure, onCamera }) → viewport API (see bottom).
   */
  function create(opts) {
    const o = opts || {};
    const app = o.app;
    const store = app.store;
    const el = o.el;
    const world = o.world;
    const artboard = o.artboard;
    const grid = o.grid || null;
    const label = o.label || null;
    const rulersEl = o.rulers || null;
    const ownerDoc = el.ownerDocument || document;
    const win = ownerDoc.defaultView || window;
    const requestFrame = typeof o.requestFrame === 'function' ? o.requestFrame : util.rafBatch(() => flush());
    const getSelectionBounds = typeof o.getSelectionBounds === 'function' ? o.getSelectionBounds : () => null;
    const getNodeBounds = typeof o.getNodeBounds === 'function' ? o.getNodeBounds : () => null;
    const beforeMeasure = typeof o.beforeMeasure === 'function' ? o.beforeMeasure : null;
    const onCamera = typeof o.onCamera === 'function' ? o.onCamera : null;

    const cam = { x: 0, y: 0, zoom: clampZoom(store.view.zoom) };
    const cameras = new Map();
    const size = { w: 0, h: 0 };
    const touches = new Map();
    const offs = [];

    let dirtyTransform = true;
    let dirtyRulers = true;
    let dirtyGrid = true;
    let pendingFit = 'initial';
    let syncing = false;
    let destroyed = false;
    let spaceDown = false;
    let hovering = false;
    let pan = null;
    let gesture = null;
    let pointer = null;
    let colors = null;
    let safariZoom = 1;
    let topCanvas = null;
    let leftCanvas = null;
    let corner = null;

    /* ------------------------------------------------------------ geometry */

    function rulersOn() {
      return !!rulersEl && store.prefs.showRulers !== false;
    }

    function inset() {
      const r = rulersOn() ? RULER_SIZE : 0;
      return { left: r, top: r };
    }

    function measureSize() {
      if (!size.w || !size.h) {
        size.w = el.clientWidth;
        size.h = el.clientHeight;
      }
      return size;
    }

    /** Visible content area (viewport minus rulers) in client coordinates. */
    function contentRect() {
      const r = el.getBoundingClientRect();
      const i = inset();
      return {
        left: r.left + i.left, top: r.top + i.top,
        width: Math.max(0, r.width - i.left), height: Math.max(0, r.height - i.top),
        viewport: { left: r.left, top: r.top, width: r.width, height: r.height }
      };
    }

    function screenToPage(clientX, clientY) {
      const r = el.getBoundingClientRect();
      return { x: (clientX - r.left - cam.x) / cam.zoom, y: (clientY - r.top - cam.y) / cam.zoom };
    }

    function pageToScreen(x, y) {
      const r = el.getBoundingClientRect();
      return { x: r.left + cam.x + x * cam.zoom, y: r.top + cam.y + y * cam.zoom };
    }

    function pageToViewport(x, y) {
      return { x: cam.x + x * cam.zoom, y: cam.y + y * cam.zoom };
    }

    function viewportToPage(x, y) {
      return { x: (x - cam.x) / cam.zoom, y: (y - cam.y) / cam.zoom };
    }

    /** Page-coordinate rectangle currently visible in the content area. */
    function visibleRect() {
      const s = measureSize();
      const i = inset();
      const a = viewportToPage(i.left, i.top);
      const b = viewportToPage(s.w, s.h);
      return { x: a.x, y: a.y, w: Math.max(0, b.x - a.x), h: Math.max(0, b.y - a.y) };
    }

    /* -------------------------------------------------------------- camera */

    function camera() {
      return { x: cam.x, y: cam.y, zoom: cam.zoom };
    }

    function sync() {
      const pageId = store.view.pageId;
      if (pageId) cameras.set(pageId, camera());
      syncing = true;
      try {
        store.setView({ zoom: cam.zoom, x: cam.x, y: cam.y });
      } finally {
        syncing = false;
      }
    }

    function setCamera(next) {
      const n = next || {};
      const zoom = clampZoom(n.zoom !== undefined ? n.zoom : cam.zoom);
      const x = Number.isFinite(n.x) ? n.x : cam.x;
      const y = Number.isFinite(n.y) ? n.y : cam.y;
      if (zoom === cam.zoom && x === cam.x && y === cam.y) return false;
      const zoomChanged = zoom !== cam.zoom;
      cam.zoom = zoom;
      cam.x = x;
      cam.y = y;
      dirtyTransform = true;
      dirtyRulers = true;
      if (zoomChanged) dirtyGrid = true;
      sync();
      requestFrame();
      return true;
    }

    /** setZoom(z, { clientX, clientY }) — the page point under the client point stays fixed. */
    function setZoom(z, at) {
      const nz = clampZoom(z);
      const c = contentRect();
      const cx = at && Number.isFinite(at.clientX) ? at.clientX : c.left + c.width / 2;
      const cy = at && Number.isFinite(at.clientY) ? at.clientY : c.top + c.height / 2;
      const lx = cx - c.viewport.left;
      const ly = cy - c.viewport.top;
      const px = (lx - cam.x) / cam.zoom;
      const py = (ly - cam.y) / cam.zoom;
      pendingFit = null;
      return setCamera({ zoom: nz, x: lx - px * nz, y: ly - py * nz });
    }

    function zoomIn(at) { return setZoom(zoomInLevel(cam.zoom), at); }
    function zoomOut(at) { return setZoom(zoomOutLevel(cam.zoom), at); }
    function zoomTo100() { return setZoom(1); }

    function panBy(dx, dy) {
      if (!dx && !dy) return false;
      pendingFit = null;
      return setCamera({ x: cam.x + (Number(dx) || 0), y: cam.y + (Number(dy) || 0) });
    }

    function pageRect() {
      return { x: 0, y: 0, w: artboard.offsetWidth, h: artboard.offsetHeight };
    }

    /**
     * fitRect(rect, { margin = 64, maxZoom, minZoom, tall }) — fit a page-coordinate rectangle into the
     * content area. `tall`: very tall rects fit the width and align to the top instead.
     */
    function fitRect(rect, fitOpts) {
      const f = fitOpts || {};
      if (!rect || !(rect.w >= 0) || !(rect.h >= 0)) return false;
      const c = contentRect();
      if (c.width < 2 || c.height < 2) return false;
      const i = inset();
      const margin = Math.max(0, Math.min(Number.isFinite(f.margin) ? f.margin : FIT_MARGIN, c.width / 4, c.height / 4));
      const zw = (c.width - 2 * margin) / Math.max(1, rect.w);
      const zh = (c.height - 2 * margin) / Math.max(1, rect.h);
      let z = Math.min(zw, zh);
      let alignTop = false;
      if (f.tall && zh < zw * 0.5) { z = zw; alignTop = true; }
      if (Number.isFinite(f.maxZoom)) z = Math.min(z, f.maxZoom);
      if (Number.isFinite(f.minZoom)) z = Math.max(z, f.minZoom);
      z = clampZoom(z);
      const x = i.left + (c.width - rect.w * z) / 2 - rect.x * z;
      const y = alignTop ? i.top + margin - rect.y * z : i.top + (c.height - rect.h * z) / 2 - rect.y * z;
      pendingFit = null;
      setCamera({ zoom: z, x, y });
      return true;
    }

    /** Fit the whole page artboard (64px margin). Deferred to the next frame when not measurable yet. */
    function fit() {
      if (beforeMeasure) beforeMeasure();
      const r = pageRect();
      const c = contentRect();
      if (!r.w || c.width < 2 || c.height < 2) {
        pendingFit = 'page';
        requestFrame();
        return false;
      }
      return fitRect(r);
    }

    function zoomToSelection() {
      if (beforeMeasure) beforeMeasure();
      const b = getSelectionBounds();
      if (!b) return false;
      return fitRect(b, { maxZoom: 8 });
    }

    /** Pan (and zoom out when needed) so the node is visible; no-op when it already is. */
    function scrollToNode(id) {
      if (beforeMeasure) beforeMeasure();
      const b = getNodeBounds(id);
      if (!b) return false;
      const c = contentRect();
      const i = inset();
      const pad = 24;
      const sx = cam.x + b.x * cam.zoom;
      const sy = cam.y + b.y * cam.zoom;
      const sw = b.w * cam.zoom;
      const sh = b.h * cam.zoom;
      const visible = sx >= i.left + pad && sy >= i.top + pad && sx + sw <= i.left + c.width - pad && sy + sh <= i.top + c.height - pad;
      if (visible) return false;
      if (sw > c.width - 2 * pad || sh > c.height - 2 * pad) return fitRect(b, { margin: pad * 2, maxZoom: cam.zoom });
      pendingFit = null;
      return setCamera({
        x: i.left + c.width / 2 - (b.x + b.w / 2) * cam.zoom,
        y: i.top + c.height / 2 - (b.y + b.h / 2) * cam.zoom
      });
    }

    function reset() {
      cameras.clear();
      pendingFit = 'initial';
      dirtyRulers = true;
      requestFrame();
    }

    /* ---------------------------------------------------------------- wheel */

    function onWheel(e) {
      if (destroyed) return;
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) { dx *= LINE_PX; dy *= LINE_PX; }
      else if (e.deltaMode === 2) { const s = measureSize(); dx *= s.w || 800; dy *= s.h || 600; }
      pendingFit = null;
      if (e.ctrlKey || e.metaKey) {
        const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
        if (!d) return;
        let factor;
        const notch = e.deltaMode !== 0 || (Math.abs(d) >= 50 && Math.abs(d - Math.round(d)) < 1e-6);
        if (notch) {
          const steps = Math.min(3, Math.max(1, Math.round(Math.abs(d) / 100)));
          factor = Math.pow(1.25, d < 0 ? steps : -steps);
        } else {
          factor = Math.exp(-util.clamp(d, -50, 50) / 100); // trackpad pinch: deltaY ≈ -100·ln(scale)
        }
        setZoom(cam.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
        return;
      }
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      panBy(-dx, -dy);
    }

    function onGestureStart(e) {
      e.preventDefault();
      safariZoom = cam.zoom;
    }

    function onGestureChange(e) {
      e.preventDefault();
      if (Number.isFinite(e.scale)) setZoom(safariZoom * e.scale, { clientX: e.clientX, clientY: e.clientY });
    }

    /* -------------------------------------------------------------- pointer */

    function startPan(e) {
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
      el.classList.add('apb-panning');
      world.style.willChange = 'transform';
      const active = ownerDoc.activeElement;
      if (!el.contains(active) && typeof el.focus === 'function') el.focus({ preventScroll: true });
    }

    function endPan() {
      if (!pan) return;
      try { if (el.hasPointerCapture && el.hasPointerCapture(pan.id)) el.releasePointerCapture(pan.id); } catch (_) { /* ignore */ }
      pan = null;
      el.classList.remove('apb-panning');
      world.style.willChange = '';
    }

    function touchPair() {
      const pts = Array.from(touches.values());
      const a = pts[0];
      const b = pts[1];
      return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    function onPointerDown(e) {
      if (destroyed) return;
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) {
          if (!gesture) {
            endPan();
            const p = touchPair();
            gesture = { mid: p.mid, dist: p.dist };
            for (const id of touches.keys()) { try { el.setPointerCapture(id); } catch (_) { /* ignore */ } }
            el.dispatchEvent(new CustomEvent('apb:gesturestart', { detail: { pointers: Array.from(touches.keys()) } }));
          }
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (store.view.tool === 'hand') {
          e.preventDefault();
          e.stopImmediatePropagation();
          startPan(e);
        }
        return;
      }
      const middle = e.button === 1;
      const primaryPan = e.button === 0 && (spaceDown || store.view.tool === 'hand');
      if (!middle && !primaryPan) return;
      if (!middle && isEditable(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      startPan(e);
    }

    function onPointerMove(e) {
      if (destroyed) return;
      if (rulersOn()) {
        pointer = { x: e.clientX, y: e.clientY };
        dirtyRulers = true;
        requestFrame();
      }
      if (pan && e.pointerId === pan.id) {
        e.stopImmediatePropagation();
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        pan.x = e.clientX;
        pan.y = e.clientY;
        panBy(dx, dy);
        return;
      }
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!gesture || touches.size < 2) return;
        e.stopImmediatePropagation();
        const p = touchPair();
        if (gesture.dist > 0 && p.dist > 0) setZoom(cam.zoom * (p.dist / gesture.dist), { clientX: p.mid.x, clientY: p.mid.y });
        panBy(p.mid.x - gesture.mid.x, p.mid.y - gesture.mid.y);
        gesture.mid = p.mid;
        gesture.dist = p.dist;
      }
    }

    function onPointerUp(e) {
      if (pan && e.pointerId === pan.id) {
        e.stopImmediatePropagation();
        endPan();
      }
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.delete(e.pointerId);
        if (gesture) {
          e.stopImmediatePropagation();
          if (touches.size < 2) {
            gesture = null;
            el.dispatchEvent(new CustomEvent('apb:gestureend'));
          }
        }
      }
    }

    function onPointerLeave() {
      hovering = false;
      if (pointer) { pointer = null; dirtyRulers = true; requestFrame(); }
    }

    function onAuxClick(e) {
      if (e.button === 1) e.preventDefault();
    }

    function onScroll() {
      // overflow:hidden containers can still be scrolled by focus/caret movement: keep the camera the only offset.
      if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; }
    }

    /* ------------------------------------------------------------ keyboard */

    function focusIsInteractiveElsewhere() {
      const a = ownerDoc.activeElement;
      if (!a || a === ownerDoc.body || a === ownerDoc.documentElement) return false;
      return !el.contains(a);
    }

    function onKeyDown(e) {
      if (destroyed || e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target)) return;
      const inCanvas = el.contains(ownerDoc.activeElement);
      if (!inCanvas && !(hovering && !focusIsInteractiveElsewhere())) return;
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        el.classList.add('apb-space-pan');
      }
    }

    function releaseSpace() {
      if (!spaceDown) return;
      spaceDown = false;
      el.classList.remove('apb-space-pan');
    }

    function onKeyUp(e) {
      if (e.code === 'Space') releaseSpace();
    }

    function onWindowBlur() {
      releaseSpace();
      endPan();
      touches.clear();
      gesture = null;
    }

    /* --------------------------------------------------------------- rulers */

    function buildRulers() {
      if (!rulersEl) return;
      topCanvas = ownerDoc.createElement('canvas');
      topCanvas.className = 'apb-ruler apb-ruler-top';
      leftCanvas = ownerDoc.createElement('canvas');
      leftCanvas.className = 'apb-ruler apb-ruler-left';
      corner = ownerDoc.createElement('div');
      corner.className = 'apb-ruler-corner';
      rulersEl.replaceChildren(topCanvas, leftCanvas, corner);
    }

    /** Resolve themed colours through real properties of the corner element (works with system colours). */
    function rulerColors() {
      if (colors) return colors;
      const cs = win.getComputedStyle(corner);
      colors = {
        bg: cs.backgroundColor || '#f8fafc',
        fg: cs.color || '#4b5563',
        border: cs.borderRightColor || '#d1d5db',
        accent: cs.outlineColor || '#2563eb',
        tick: cs.textDecorationColor || '#9aa3af',
        sel: cs.columnRuleColor || 'rgba(37,99,235,.16)'
      };
      return colors;
    }

    function sizeCanvas(cv, w, h, dpr) {
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (cv.width !== bw) cv.width = bw;
      if (cv.height !== bh) cv.height = bh;
      const cw = w + 'px';
      const ch = h + 'px';
      if (cv.style.width !== cw) cv.style.width = cw;
      if (cv.style.height !== ch) cv.style.height = ch;
    }

    function formatTick(v) {
      const r = Math.round(v * 100) / 100;
      return String(Object.is(r, -0) ? 0 : r);
    }

    function drawAxis(cv, horizontal, length, dpr, col, sel, vpRect) {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const thick = RULER_SIZE;
      const W = horizontal ? length : thick;
      const H = horizontal ? thick : length;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = col.bg;
      ctx.fillRect(0, 0, W, H);
      const z = cam.zoom;
      const origin = (horizontal ? cam.x : cam.y) - RULER_SIZE;

      if (sel) {
        const a = origin + (horizontal ? sel.x : sel.y) * z;
        const b = a + (horizontal ? sel.w : sel.h) * z;
        ctx.fillStyle = col.sel;
        if (horizontal) ctx.fillRect(a, 0, Math.max(1, b - a), H);
        else ctx.fillRect(0, a, W, Math.max(1, b - a));
      }

      const major = niceStep(Math.max(1, 64 / z));
      const majorPx = major * z;
      let sub = 10;
      if (majorPx / sub < 6) sub = 5;
      if (majorPx / sub < 6) sub = 2;
      if (majorPx / sub < 6) sub = 1;
      const minor = major / sub;
      const k0 = Math.floor((-origin / z) / minor) - 1;
      const k1 = Math.ceil(((length - origin) / z) / minor) + 1;

      ctx.strokeStyle = col.tick;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const labels = [];
      for (let k = k0; k <= k1; k++) {
        const v = k * minor;
        const p = Math.round(origin + v * z) + 0.5;
        if (p < -1 || p > length + 1) continue;
        const isMajor = k % sub === 0;
        const isHalf = !isMajor && sub === 10 && k % 5 === 0;
        const len = isMajor ? 10 : isHalf ? 6 : 4;
        if (horizontal) { ctx.moveTo(p, H - len); ctx.lineTo(p, H); }
        else { ctx.moveTo(W - len, p); ctx.lineTo(W, p); }
        if (isMajor) labels.push([p, formatTick(v)]);
      }
      ctx.stroke();

      ctx.fillStyle = col.fg;
      ctx.font = RULER_FONT;
      ctx.textBaseline = 'alphabetic';
      for (const [p, text] of labels) {
        if (horizontal) {
          ctx.fillText(text, p + 3, 10);
        } else {
          ctx.save();
          ctx.translate(10, p - 3);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(text, 0, 0);
          ctx.restore();
        }
      }

      ctx.strokeStyle = col.accent;
      ctx.beginPath();
      if (sel) {
        const a = Math.round(origin + (horizontal ? sel.x : sel.y) * z) + 0.5;
        const b = Math.round(origin + ((horizontal ? sel.x + sel.w : sel.y + sel.h)) * z) + 0.5;
        if (horizontal) { ctx.moveTo(a, 0); ctx.lineTo(a, H); ctx.moveTo(b, 0); ctx.lineTo(b, H); }
        else { ctx.moveTo(0, a); ctx.lineTo(W, a); ctx.moveTo(0, b); ctx.lineTo(W, b); }
      }
      if (pointer && vpRect) {
        const p = Math.round((horizontal ? pointer.x - vpRect.left : pointer.y - vpRect.top) - RULER_SIZE) + 0.5;
        if (p >= 0 && p <= length) {
          if (horizontal) { ctx.moveTo(p, 0); ctx.lineTo(p, H); }
          else { ctx.moveTo(0, p); ctx.lineTo(W, p); }
        }
      }
      ctx.stroke();

      ctx.strokeStyle = col.border;
      ctx.beginPath();
      if (horizontal) { ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); }
      else { ctx.moveTo(W - 0.5, 0); ctx.lineTo(W - 0.5, H); }
      ctx.stroke();
    }

    function drawRulers() {
      if (!rulersEl || !topCanvas) return;
      const on = rulersOn();
      el.classList.toggle('apb-rulers-off', !on);
      if (!on) return;
      const s = measureSize();
      if (!s.w || !s.h) return;
      const dpr = win.devicePixelRatio || 1;
      const topLen = Math.max(0, s.w - RULER_SIZE);
      const leftLen = Math.max(0, s.h - RULER_SIZE);
      sizeCanvas(topCanvas, topLen, RULER_SIZE, dpr);
      sizeCanvas(leftCanvas, RULER_SIZE, leftLen, dpr);
      const col = rulerColors();
      let sel = null;
      try { sel = getSelectionBounds(); } catch (_) { sel = null; }
      const vpRect = pointer ? el.getBoundingClientRect() : null;
      drawAxis(topCanvas, true, topLen, dpr, col, sel, vpRect);
      drawAxis(leftCanvas, false, leftLen, dpr, col, sel, vpRect);
    }

    /* ----------------------------------------------------------------- grid */

    function updateGrid() {
      if (!grid) return;
      const prefs = store.prefs;
      const gs = Math.max(1, Number(prefs.snap && prefs.snap.gridSize) || 8);
      const on = !!prefs.showGrid && gs * cam.zoom >= 4;
      grid.classList.toggle('apb-on', on);
      if (on) {
        grid.style.setProperty('--apb-grid-size', gs + 'px');
        grid.style.setProperty('--apb-grid-line', (1 / cam.zoom) + 'px');
      }
    }

    /* ---------------------------------------------------------------- frame */

    /** Apply pending fit/transform/grid/rulers. Returns true when the camera transform changed. */
    function flush() {
      if (destroyed) return false;
      let changed = false;
      if (pendingFit) {
        const kind = pendingFit;
        if (beforeMeasure) beforeMeasure();
        const r = pageRect();
        const c = contentRect();
        if (r.w > 0 && c.width >= 2 && c.height >= 2) {
          pendingFit = null;
          fitRect(r, kind === 'initial' ? { maxZoom: 1, tall: true } : {});
        }
      }
      if (dirtyTransform) {
        dirtyTransform = false;
        const dpr = win.devicePixelRatio || 1;
        const tx = Math.round(cam.x * dpr) / dpr;
        const ty = Math.round(cam.y * dpr) / dpr;
        world.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + cam.zoom + ')';
        if (label) label.style.setProperty('--apb-zoom', String(cam.zoom));
        el.setAttribute('data-zoom', String(Math.round(cam.zoom * 1000) / 1000));
        changed = true;
      }
      if (dirtyGrid) {
        dirtyGrid = false;
        updateGrid();
      }
      if (dirtyRulers) {
        dirtyRulers = false;
        drawRulers();
      }
      if (changed && onCamera) onCamera(camera());
      return changed;
    }

    /* ------------------------------------------------------------- wiring */

    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      offs.push(() => target.removeEventListener(type, fn, options));
    }

    function bpWidth(bpId) {
      const bps = (store.doc.settings && store.doc.settings.breakpoints) || [];
      const b = bps.find((x) => x.id === bpId) || bps[0];
      return b && Number.isFinite(b.width) ? b.width : 0;
    }

    buildRulers();
    el.setAttribute('data-tool', store.view.tool || 'select');

    listen(el, 'wheel', onWheel, { passive: false });
    listen(el, 'pointerdown', onPointerDown, true);
    listen(el, 'pointermove', onPointerMove, true);
    listen(el, 'pointerup', onPointerUp, true);
    listen(el, 'pointercancel', onPointerUp, true);
    listen(el, 'lostpointercapture', (e) => { if (pan && e.pointerId === pan.id) endPan(); });
    listen(el, 'pointerenter', () => { hovering = true; });
    listen(el, 'pointerleave', onPointerLeave);
    listen(el, 'auxclick', onAuxClick);
    listen(el, 'scroll', onScroll);
    listen(el, 'gesturestart', onGestureStart, { passive: false });
    listen(el, 'gesturechange', onGestureChange, { passive: false });
    listen(win, 'keydown', onKeyDown, true);
    listen(win, 'keyup', onKeyUp, true);
    listen(win, 'blur', onWindowBlur);

    let ro = null;
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver((entries) => {
        const rect = entries[entries.length - 1].contentRect;
        size.w = rect.width;
        size.h = rect.height;
        dirtyRulers = true;
        requestFrame();
      });
      ro.observe(el);
    } else {
      listen(win, 'resize', () => { size.w = 0; size.h = 0; dirtyRulers = true; requestFrame(); });
    }

    let mo = null;
    if (typeof win.MutationObserver === 'function') {
      mo = new win.MutationObserver(() => { colors = null; dirtyRulers = true; requestFrame(); });
      mo.observe(ownerDoc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    }
    for (const q of ['(prefers-color-scheme: dark)', '(forced-colors: active)']) {
      const mql = typeof win.matchMedia === 'function' ? win.matchMedia(q) : null;
      if (mql && typeof mql.addEventListener === 'function') {
        const fn = () => { colors = null; dirtyRulers = true; requestFrame(); };
        mql.addEventListener('change', fn);
        offs.push(() => mql.removeEventListener('change', fn));
      }
    }

    offs.push(store.on('view', (p) => {
      if (syncing || destroyed) return;
      const ch = p.changed || [];
      if (ch.includes('tool')) {
        el.setAttribute('data-tool', p.view.tool || 'select');
        if (p.view.tool !== 'hand' && pan && !spaceDown) endPan();
      }
      if (ch.includes('pageId')) {
        if (p.previous && p.previous.pageId) cameras.set(p.previous.pageId, camera());
        const saved = cameras.get(p.view.pageId);
        if (saved) { pendingFit = null; setCamera(saved); }
        else { pendingFit = 'initial'; requestFrame(); }
      } else {
        if (ch.includes('bp') && p.previous) {
          const ow = bpWidth(p.previous.bp);
          const nw = bpWidth(p.view.bp);
          if (ow && nw && ow !== nw) setCamera({ x: cam.x + ((ow - nw) / 2) * cam.zoom });
        }
        if (ch.includes('x') || ch.includes('y')) {
          setCamera({ zoom: p.view.zoom, x: p.view.x, y: p.view.y });
        } else if (ch.includes('zoom')) {
          setZoom(p.view.zoom);
        }
      }
      dirtyRulers = true;
      requestFrame();
    }));

    offs.push(store.on('prefs', (p) => {
      const ch = p.changed || [];
      if (ch.includes('showGrid') || ch.includes('snap')) dirtyGrid = true;
      if (ch.includes('showRulers') || ch.includes('theme')) { colors = null; dirtyRulers = true; }
      if (ch.includes('theme')) colors = null;
      requestFrame();
    }));

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      endPan();
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      if (rulersEl) rulersEl.replaceChildren();
    }

    requestFrame();

    return {
      get zoom() { return cam.zoom; },
      get x() { return cam.x; },
      get y() { return cam.y; },
      get spacePressed() { return spaceDown; },
      get panning() { return !!pan; },
      get gesturing() { return !!gesture; },
      get rulerSize() { return rulersOn() ? RULER_SIZE : 0; },
      camera,
      setCamera(next) { pendingFit = null; return setCamera(next); },
      setZoom, zoomIn, zoomOut, zoomTo100, fit, fitRect, zoomToSelection, scrollToNode, panBy,
      screenToPage, pageToScreen, pageToViewport, viewportToPage, visibleRect, contentRect,
      invalidateRulers(request) { dirtyRulers = true; if (request !== false) requestFrame(); },
      invalidateGrid(request) { dirtyGrid = true; if (request !== false) requestFrame(); },
      reset, flush, drawRulers, destroy
    };
  }

  return { create, MIN_ZOOM, MAX_ZOOM, NICE_ZOOMS, RULER_SIZE, FIT_MARGIN, clampZoom, zoomInLevel, zoomOutLevel, niceStep };
});

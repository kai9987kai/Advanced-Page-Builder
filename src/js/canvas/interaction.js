/*
 * interaction — pointer tools & gesture state machine for the canvas (ARCHITECTURE.md §7).
 *
 * Architecture (extensible — later canvas features plug in here):
 * - Tools (`registerTool(name, def)`) are keyed by `store.view.tool`. A tool's `down(ctx, pt)` returns
 *   a *pending press* `{ drag(pt) → gesture|null, click(pt), cursor }` (the drag starts after a 3 px
 *   threshold) or directly a *gesture*. Optional: `dblclick(ctx, pt)`, `hover(ctx, pt) → { hover, cursor }`,
 *   `contextmenu(ctx, pt)`, `keydown(ctx, event) → handled`.
 * - Gestures (`registerGesture(name, factory)`; `ctx.gesture(name, opts)` creates one) implement
 *   `{ name, cursor?, move(pt), end(pt), cancel() }`. Built-in: `move`, `resize`, `rotate`, `marquee`.
 * - `pt` = { clientX, clientY, page: {x,y}, shift, alt, mod, coarse, pointerType, event }.
 * - Pointer Events + setPointerCapture; pointercancel / lostpointercapture / Escape / two-finger
 *   viewport gestures cancel the active gesture (document changes are undone through `ctx.history`).
 * - Modifier changes during a gesture re-run `move` with the last pointer position.
 * - Every gesture's document writes share one coalesce key; `ctx.history.finalize` guarantees a
 *   single undo entry per gesture even when the coalesce window lapsed during a slow drag.
 */
APB.define('interaction', ['util', 'geometry', 'snapping', 'schema', 'elements'], function (util, geometry, snapping, schema, elements) {
  'use strict';

  const DRAG_THRESHOLD = 3;
  const PERF_SAMPLES = 240;
  const toolDefs = new Map();
  const gestureDefs = new Map();
  let keySeq = 0;

  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  function registerTool(name, def) {
    if (typeof name !== 'string' || !name || !def || typeof def !== 'object') throw new TypeError('interaction.registerTool(name, def) needs a name and a definition');
    toolDefs.set(name, def);
    return () => { if (toolDefs.get(name) === def) toolDefs.delete(name); };
  }

  function registerGesture(name, factory) {
    if (typeof name !== 'string' || !name || typeof factory !== 'function') throw new TypeError('interaction.registerGesture(name, factory) needs a name and a factory');
    gestureDefs.set(name, factory);
    return () => { if (gestureDefs.get(name) === factory) gestureDefs.delete(name); };
  }

  function normAngle(a) {
    let r = a % 360;
    if (r > 180) r -= 360;
    if (r <= -180) r += 360;
    return Object.is(r, -0) ? 0 : r;
  }

  function rotV(x, y, deg) {
    if (!deg) return { x, y };
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  function layerWord(n) {
    return n === 1 ? 'layer' : n + ' layers';
  }

  /* ================================================================ gestures */

  /** move: drag the movable top-level selection (free parents), snapping, Shift axis lock, Alt duplicates. */
  registerGesture('move', function (ctx, o) {
    const { store, app, canvas } = ctx;
    const docops = app.docops;
    let ids = ctx.movableIds(o.ids || store.selection);
    if (!ids.length || !docops) return null;
    const key = ctx.coalesceKey('move');
    const mark = ctx.history.mark();
    const start = o.start;
    const origIds = ids.slice();
    let duplicated = false;
    if (o.duplicate) {
      const copies = store.transact('Duplicate ' + layerWord(ids.length), () => docops.duplicate(store, ids, { offset: 0 }), { coalesce: key });
      if (Array.isArray(copies) && copies.length) { ids = copies; duplicated = true; }
    }
    const label = duplicated ? 'Duplicate ' + layerWord(ids.length) : 'Move ' + layerWord(ids.length);
    const startRect = canvas.renderer.bounds(origIds);
    if (!startRect) return null;
    const index = snapping.createIndex(ctx.snapTargets(ids));
    const applied = { dx: 0, dy: 0 };
    let axisLock = null;
    let changed = duplicated;

    function move(pt) {
      let dx = pt.page.x - start.page.x;
      let dy = pt.page.y - start.page.y;
      const z = canvas.viewport.zoom || 1;
      if (pt.shift) {
        if (!axisLock && Math.hypot(dx, dy) * z > 4) axisLock = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        if (axisLock === 'x') dy = 0;
        if (axisLock === 'y') dx = 0;
      } else {
        axisLock = null;
      }
      let x = startRect.x + dx;
      let y = startRect.y + dy;
      let guides = [];
      let spacing = [];
      let snapX = false;
      let snapY = false;
      const snap = ctx.snapConfig(pt);
      if (snap.enabled) {
        const r = snapping.snapMove({ rect: { x, y, w: startRect.w, h: startRect.h }, index, grid: snap.grid, gridSize: snap.gridSize, threshold: snap.threshold, objects: snap.objects });
        if (axisLock !== 'y' && r.snapped.x) { x += r.dx; snapX = true; }
        if (axisLock !== 'x' && r.snapped.y) { y += r.dy; snapY = true; }
        guides = r.guides.filter((g) => (g.axis === 'x' ? snapX : snapY));
        spacing = (r.spacing || []).filter((s) => (s.axis === 'x' ? snapX : snapY));
      }
      if (!snapX) x = Math.round(x);
      if (!snapY) y = Math.round(y);
      const tdx = axisLock === 'y' ? 0 : x - startRect.x;
      const tdy = axisLock === 'x' ? 0 : y - startRect.y;
      const sdx = tdx - applied.dx;
      const sdy = tdy - applied.dy;
      if (Math.abs(sdx) > 1e-6 || Math.abs(sdy) > 1e-6) {
        docops.move(store, ids, sdx, sdy, { coalesce: key, label });
        applied.dx = tdx;
        applied.dy = tdy;
        changed = true;
      }
      ctx.overlay.set({ guides, spacing, hideHandles: true, hideHover: true });
    }

    return {
      name: 'move',
      cursor: 'default',
      get ids() { return ids.slice(); },
      move,
      end() {
        ctx.overlay.clear();
        if (!changed) return;
        ctx.history.finalize(mark, () => {
          store.transact(label, () => {
            const t = duplicated ? docops.duplicate(store, origIds, { offset: 0 }) : origIds;
            if (applied.dx || applied.dy) docops.move(store, t, applied.dx, applied.dy, { label });
          });
        });
      },
      cancel() {
        ctx.overlay.clear();
        if (changed) ctx.history.cancel(mark);
      }
    };
  });

  /** resize: 8 handles, rotation-aware for one node; multi-selection scales boxes within the union bounds. */
  registerGesture('resize', function (ctx, o) {
    const { store, app, canvas } = ctx;
    const docops = app.docops;
    if (!docops) return null;
    const handle = String(o.handle || 'se');
    const doc = store.doc;
    const bp = store.view.bp;
    const top = docops.topLevel(doc, store.selection);
    const items = [];
    for (const id of top) {
      const wr = canvas.renderer.worldRect(id);
      const eff = schema.effectiveNode(doc, id, bp);
      if (!wr || !eff) continue;
      items.push(ctx.boxItem(id, wr, eff));
    }
    const movable = items.filter((it) => !it.locked);
    if (!movable.length) return null;
    const single = items.length === 1;
    const key = ctx.coalesceKey('resize');
    const mark = ctx.history.mark();
    const start = o.start;
    const index = snapping.createIndex(ctx.snapTargets(items.map((it) => it.id)));
    const base = single ? { x: items[0].wr.x, y: items[0].wr.y, w: items[0].wr.w, h: items[0].wr.h } : ctx.unionOf(items);
    const rotation = single ? items[0].wr.rotation || 0 : 0;
    const keepDefault = single && ctx.keepsAspect(items[0].eff.type);
    const label = 'Resize ' + layerWord(movable.length);
    let changed = false;
    let lastBoxes = null;

    function roundRect(r, snapped, fromCenter) {
      if (rotation) return r;
      const out = Object.assign({}, r);
      const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
      const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
      if (!snapped.x) {
        const w = Math.max(1, Math.round(r.w));
        out.x = fromCenter || !sx ? Math.round((r.x + r.w / 2 - w / 2) * 2) / 2 : sx > 0 ? r.x : r.x + r.w - w;
        out.w = w;
      }
      if (!snapped.y) {
        const h = Math.max(1, Math.round(r.h));
        out.y = fromCenter || !sy ? Math.round((r.y + r.h / 2 - h / 2) * 2) / 2 : sy > 0 ? r.y : r.y + r.h - h;
        out.h = h;
      }
      return out;
    }

    function move(pt) {
      const delta = { x: pt.page.x - start.page.x, y: pt.page.y - start.page.y };
      const keepAspect = single ? keepDefault !== !!pt.shift : !!pt.shift;
      const fromCenter = !!pt.alt;
      let r = geometry.resize(base, handle, delta, { rotation, keepAspect, fromCenter, minW: 1, minH: 1 });
      let guides = [];
      let snapped = { x: null, y: null };
      const snap = ctx.snapConfig(pt);
      if (snap.enabled && !rotation) {
        const sr = snapping.snapResize({
          rect: r, handle, index, grid: snap.grid, gridSize: snap.gridSize, threshold: snap.threshold, objects: snap.objects,
          keepAspect, fromCenter, minW: 1, minH: 1
        });
        if (sr && sr.rect) { r = sr.rect; guides = sr.guides || []; snapped = sr.snapped || snapped; }
      }
      r = roundRect(r, snapped, fromCenter);
      const boxes = [];
      if (single) {
        boxes.push(ctx.localBox(items[0], { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h }));
      } else {
        const sx = base.w ? r.w / base.w : 1;
        const sy = base.h ? r.h / base.h : 1;
        for (const it of movable) {
          const c0x = it.wr.x + it.wr.w / 2;
          const c0y = it.wr.y + it.wr.h / 2;
          const rad = ((it.wr.rotation || 0) * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const fw = it.wr.rotation ? Math.hypot(cos * sx, sin * sy) : sx;
          const fh = it.wr.rotation ? Math.hypot(sin * sx, cos * sy) : sy;
          boxes.push(ctx.localBox(it, {
            cx: r.x + (c0x - base.x) * sx, cy: r.y + (c0y - base.y) * sy,
            w: Math.max(1, it.wr.w * fw), h: Math.max(1, it.wr.h * fh)
          }));
        }
      }
      lastBoxes = boxes;
      if (ctx.applyBoxes(boxes, { coalesce: key, label })) changed = true;
      ctx.overlay.set({ guides, spacing: [], hideHover: true, label: ctx.fmt(r.w) + ' × ' + ctx.fmt(r.h) });
    }

    return {
      name: 'resize',
      handle,
      cursor: ctx.overlay.cursorFor({ type: 'handle', handle }),
      move,
      end() {
        ctx.overlay.clear();
        if (!changed) return;
        ctx.history.finalize(mark, () => ctx.applyBoxes(lastBoxes, { label }));
      },
      cancel() {
        ctx.overlay.clear();
        if (changed) ctx.history.cancel(mark);
      }
    };
  });

  /** rotate: every unlocked top-level node rotates about its own centre; Shift snaps to prefs.snap.rotationStep. */
  registerGesture('rotate', function (ctx, o) {
    const { store, app, canvas } = ctx;
    const docops = app.docops;
    if (!docops) return null;
    const doc = store.doc;
    const bp = store.view.bp;
    const items = [];
    for (const id of docops.topLevel(doc, store.selection)) {
      const wr = canvas.renderer.worldRect(id);
      const eff = schema.effectiveNode(doc, id, bp);
      if (!wr || !eff) continue;
      const it = ctx.boxItem(id, wr, eff);
      if (!it.locked) items.push(it);
    }
    if (!items.length) return null;
    const box = items.length === 1 ? items[0].wr : ctx.unionOf(items);
    const pivot = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const start = o.start;
    const a0 = geometry.angleFrom(pivot, start.page);
    const key = ctx.coalesceKey('rotate');
    const mark = ctx.history.mark();
    const label = 'Rotate ' + layerWord(items.length);
    const cursorCorner = o.corner || 'ne';
    let changed = false;
    let last = null;

    function targets(pt) {
      const d = geometry.angleFrom(pivot, pt.page) - a0;
      const step = Number(store.prefs.snap && store.prefs.snap.rotationStep) || 15;
      return items.map((it) => {
        let world = (it.wr.rotation || 0) + d;
        world = pt.shift ? geometry.snapAngle(world, step) : Math.round(world * 10) / 10;
        return { it, world: normAngle(world), local: normAngle((it.eff.rotation || 0) + (world - (it.wr.rotation || 0))) };
      });
    }

    function apply(list, opts) {
      let did = false;
      const run = () => {
        for (const t of list) {
          if (docops.setBox(store, t.it.id, { rotation: t.local }, { coalesce: opts.coalesce })) did = true;
        }
      };
      if (list.length === 1) run(); else store.transact(label, run, { coalesce: opts.coalesce });
      return did;
    }

    return {
      name: 'rotate',
      get cursor() { return ctx.overlay.cursorFor({ type: 'rotate', corner: cursorCorner }); },
      move(pt) {
        last = targets(pt);
        if (apply(last, { coalesce: key })) changed = true;
        ctx.overlay.set({ rotation: { angle: last[0].world, clientX: pt.clientX, clientY: pt.clientY }, hideHandles: true, hideHover: true });
        ctx.setCursor(ctx.overlay.cursorFor({ type: 'rotate', corner: cursorCorner }));
      },
      end() {
        ctx.overlay.clear();
        if (!changed) return;
        ctx.history.finalize(mark, () => apply(last, {}));
      },
      cancel() {
        ctx.overlay.clear();
        if (changed) ctx.history.cancel(mark);
      }
    };
  });

  /** marquee: rubber-band selection of a container's direct children (Alt = fully contained, Shift = add). */
  registerGesture('marquee', function (ctx, o) {
    const { store, canvas } = ctx;
    const doc = store.doc;
    const scope = o.scope && own(doc.nodes, o.scope) ? o.scope : canvas.renderer.rootId;
    const start = o.start;
    const startSel = store.selection.slice();
    const base = Array.isArray(o.base) ? o.base.slice() : [];
    const docops = ctx.app.docops;
    const scopeNode = scope ? doc.nodes[scope] : null;
    const children = [];
    for (const cid of (scopeNode && scopeNode.children) || []) {
      if (docops && docops.isLocked(doc, cid)) continue;
      const r = canvas.renderer.bounds([cid]);
      if (r) children.push({ id: cid, r });
    }
    let current = startSel;

    return {
      name: 'marquee',
      scope,
      cursor: 'default',
      move(pt) {
        const x1 = Math.min(start.page.x, pt.page.x);
        const y1 = Math.min(start.page.y, pt.page.y);
        const rect = { x: x1, y: y1, w: Math.abs(pt.page.x - start.page.x), h: Math.abs(pt.page.y - start.page.y) };
        const hits = children.filter((c) => (pt.alt ? geometry.contains(rect, c.r) : geometry.intersects(rect, c.r))).map((c) => c.id);
        const next = pt.shift || o.additive ? Array.from(new Set(base.concat(hits))) : hits;
        if (!util.deepEqual(next, current)) {
          current = next;
          store.select(next);
        }
        ctx.overlay.set({ marquee: rect, hideHover: true });
      },
      end() {
        ctx.overlay.clear();
        if (current.length) ctx.announce(util.plural ? util.plural(current.length, 'layer') + ' selected' : current.length + ' selected');
      },
      cancel() {
        ctx.overlay.clear();
        store.select(startSel);
      }
    };
  });

  /* ============================================================ select tool */

  registerTool('select', {
    cursor: 'default',

    down(ctx, pt) {
      const { store, canvas } = ctx;
      const renderer = canvas.renderer;
      const hit = ctx.overlay.hitTest(pt.clientX, pt.clientY, { coarse: pt.coarse });
      if (hit && (hit.type === 'handle' || hit.type === 'rotate')) {
        return {
          cursor: ctx.overlay.cursorFor(hit),
          drag: (p) => hit.type === 'handle'
            ? ctx.gesture('resize', { handle: hit.handle, start: pt })
            : ctx.gesture('rotate', { corner: hit.corner, start: pt }),
          click() {}
        };
      }
      let target = renderer.nodeAt(pt.clientX, pt.clientY, { deep: pt.mod });
      if (target && target === renderer.rootId) target = null;
      const sel = store.selection.slice();
      const inBody = !!(hit && hit.type === 'body');
      const moveSel = (p, ids) => ctx.gesture('move', { ids: ids || store.selection, start: pt, duplicate: p.alt || pt.alt }) || ctx.stackDrag(ids || store.selection, pt);
      const marqueeIn = (scope, additive) => ctx.gesture('marquee', { scope, start: pt, base: additive ? store.selection : [], additive });

      if (!target) {
        if (inBody && !pt.shift && !pt.mod && sel.length && ctx.movableIds(sel).length) {
          return { drag: (p) => moveSel(p, sel), click: () => ctx.selectTarget(null) };
        }
        const ctxId = store.view.context && own(store.doc.nodes, store.view.context) ? store.view.context : renderer.rootId;
        return {
          drag: () => marqueeIn(ctxId, pt.shift),
          click: () => { if (!pt.shift) ctx.selectTarget(null); }
        };
      }

      const selected = sel.includes(target);
      if (pt.shift) {
        if (selected) return { drag: (p) => moveSel(p, sel), click: () => store.select([target], 'remove') };
        store.select([target], 'add');
        return { drag: (p) => moveSel(p, store.selection), click() {} };
      }

      if (selected) {
        if (!ctx.movableIds(sel).length && ctx.isMarqueeContainer(target) && !ctx.hasGesture('reorder')) {
          return { drag: () => marqueeIn(target, false), click: () => { if (sel.length > 1) ctx.selectTarget(target); } };
        }
        return { drag: (p) => moveSel(p, sel), click: () => { if (sel.length > 1) ctx.selectTarget(target); } };
      }

      if (ctx.isMarqueeContainer(target)) {
        if (inBody && sel.length && ctx.movableIds(sel).length) {
          return { drag: (p) => moveSel(p, sel), click: () => ctx.selectTarget(target) };
        }
        return { drag: () => marqueeIn(target, false), click: () => ctx.selectTarget(target) };
      }

      ctx.selectTarget(target);
      return { drag: (p) => moveSel(p, [target]), click() {} };
    },

    dblclick(ctx, pt) {
      const { store, canvas, app } = ctx;
      const renderer = canvas.renderer;
      const rootId = renderer.rootId;
      const deep = renderer.nodeAt(pt.clientX, pt.clientY, { deep: true });
      if (!deep || deep === rootId) return false;
      const target = renderer.nodeAt(pt.clientX, pt.clientY, { deep: false });
      const node = target ? store.node(target) : null;
      if (!node) return false;
      if (target !== deep && Array.isArray(node.children)) {
        // Enter the group: the next level under the pointer becomes selectable.
        store.setView({ context: target });
        const inner = renderer.nodeAt(pt.clientX, pt.clientY, { deep: false });
        if (inner && inner !== target) {
          store.select([inner]);
          ctx.announce('Entered ' + (node.name || 'group'));
        }
        return true;
      }
      const def = elements.get(node.type);
      if (def && def.textEdit && !(app.docops && app.docops.isLocked(store.doc, target))) {
        if (!store.selection.includes(target) || store.selection.length !== 1) store.select([target]);
        canvas.startTextEdit(target);
        return true;
      }
      return false;
    },

    hover(ctx, pt) {
      const hit = ctx.overlay.hitTest(pt.clientX, pt.clientY, { coarse: pt.coarse });
      const cursor = ctx.overlay.cursorFor(hit);
      if (hit && hit.type !== 'body') return { hover: null, cursor };
      let id = ctx.canvas.renderer.nodeAt(pt.clientX, pt.clientY, { deep: pt.mod });
      if (id === ctx.canvas.renderer.rootId) id = null;
      return { hover: id, cursor };
    }
  });

  /* ================================================================ create */

  function create(opts) {
    const o = opts || {};
    const app = o.app;
    const canvas = o.canvas;
    if (!app || !canvas || !canvas.el) throw new TypeError('interaction.create({ app, canvas }) needs the app and a mounted canvas');
    const store = app.store;
    const el = canvas.el;
    const ownerDoc = el.ownerDocument || document;
    const win = ownerDoc.defaultView || window;
    const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
    const caf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : clearTimeout;
    const perfNow = () => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now());
    const localTools = new Map();
    const localGestures = new Map();
    const offs = [];
    let destroyed = false;
    let active = null;
    let hoverFrame = 0;
    let hoverPt = null;
    let cursor = '';
    const perf = { count: 0, total: 0, max: 0, samples: [] };

    const noopOverlay = {
      set() {}, clear() {}, hitTest() { return null; }, cursorFor() { return ''; }, invalidate() {}
    };

    /* ------------------------------------------------------------ ctx */

    const isMac = () => !!(app.env && app.env.mac);
    const modKey = (e) => !!(e && (isMac() ? e.metaKey : e.ctrlKey));

    function point(e, base) {
      const cx = e && Number.isFinite(e.clientX) ? e.clientX : base ? base.clientX : 0;
      const cy = e && Number.isFinite(e.clientY) ? e.clientY : base ? base.clientY : 0;
      const hasMods = e && typeof e.shiftKey === 'boolean';
      return {
        clientX: cx,
        clientY: cy,
        page: canvas.viewport.screenToPage(cx, cy),
        shift: hasMods ? e.shiftKey : !!(base && base.shift),
        alt: hasMods ? e.altKey : !!(base && base.alt),
        mod: hasMods ? modKey(e) : !!(base && base.mod),
        coarse: e && e.pointerType ? e.pointerType !== 'mouse' : !!(app.env && app.env.coarse),
        pointerType: (e && e.pointerType) || (base && base.pointerType) || 'mouse',
        event: e || null
      };
    }

    function historyMark() {
      const h = store.history();
      return { index: h.index, length: h.entries.length };
    }

    const history = {
      mark: historyMark,
      /** Undo everything recorded since `mark` (the gesture's own entries). */
      cancel(mark) {
        let guard = 1000;
        let h = store.history();
        if (h.index === mark.index && mark.length >= 500 && store.canUndo()) { store.undo(); return; }
        while (h.index > mark.index && store.canUndo() && guard-- > 0) {
          store.undo();
          h = store.history();
        }
      },
      /** Ensure the gesture produced one undo entry: if the coalesce window lapsed, replay it once. */
      finalize(mark, reapply) {
        const h = store.history();
        if (h.index - mark.index <= 1 || typeof reapply !== 'function') return;
        history.cancel(mark);
        reapply();
      }
    };

    function snapConfig(pt) {
      const sp = store.prefs.snap || {};
      const objects = sp.objects !== false;
      const grid = !!sp.grid;
      const z = canvas.viewport.zoom || 1;
      const thr = Number.isFinite(sp.threshold) ? sp.threshold : 6;
      return {
        enabled: !(pt && pt.mod) && (objects || grid),
        objects, grid,
        gridSize: Number(sp.gridSize) > 0 ? Number(sp.gridSize) : 8,
        threshold: thr / z,
        rotationStep: Number(sp.rotationStep) > 0 ? Number(sp.rotationStep) : 15
      };
    }

    /** Snap candidates: visible siblings of the moving nodes (excluding them) and their first parent. */
    function snapTargets(ids, extraOthers) {
      const doc = store.doc;
      const moving = new Set(ids);
      const parents = [];
      for (const id of ids) {
        const n = own(doc.nodes, id) ? doc.nodes[id] : null;
        if (n && n.parent && !parents.includes(n.parent)) parents.push(n.parent);
      }
      const others = [];
      for (const pid of parents) {
        const p = doc.nodes[pid];
        for (const cid of (p && p.children) || []) {
          if (moving.has(cid)) continue;
          const r = canvas.renderer.bounds([cid]);
          if (r) others.push(r);
        }
      }
      for (const id of extraOthers || []) {
        if (moving.has(id)) continue;
        const r = canvas.renderer.bounds([id]);
        if (r) others.push(r);
      }
      const parent = parents.length ? canvas.renderer.bounds([parents[0]]) : null;
      return { others, parent };
    }

    function movableIds(ids) {
      const d = app.docops;
      if (!d) return [];
      const doc = store.doc;
      const bp = store.view.bp;
      return d.topLevel(doc, ids || []).filter((id) => {
        if (d.isLocked(doc, id)) return false;
        const n = doc.nodes[id];
        if (!n || !n.parent) return false;
        const p = schema.effectiveNode(doc, n.parent, bp);
        return !(p && p.layout && p.layout.mode === 'stack');
      });
    }

    function parentRotation(id) {
      const n = store.node(id);
      if (!n || !n.parent) return 0;
      const pr = canvas.renderer.worldRect(n.parent);
      return pr ? pr.rotation || 0 : 0;
    }

    /** Snapshot used by box gestures: world rect, effective node, parent frame rotation, local centre. */
    function boxItem(id, wr, eff) {
      const doc = store.doc;
      const n = doc.nodes[id];
      const p = n && n.parent ? schema.effectiveNode(doc, n.parent, store.view.bp) : null;
      return {
        id, wr, eff,
        locked: !!(app.docops && app.docops.isLocked(doc, id)),
        stack: !!(p && p.layout && p.layout.mode === 'stack'),
        parentRot: parentRotation(id),
        c0: { x: (Number(eff.x) || 0) + wr.w / 2, y: (Number(eff.y) || 0) + wr.h / 2 }
      };
    }

    /** World box { cx, cy, w, h } → local setBox patch for a boxItem (keeps parent frame rotation into account). */
    function localBox(it, wb) {
      const shift = rotV(wb.cx - (it.wr.x + it.wr.w / 2), wb.cy - (it.wr.y + it.wr.h / 2), -it.parentRot);
      const box = { w: wb.w, h: wb.h };
      if (!it.stack) {
        box.x = it.c0.x + shift.x - wb.w / 2;
        box.y = it.c0.y + shift.y - wb.h / 2;
      }
      return { it, box };
    }

    function applyBoxes(list, applyOpts) {
      const d = app.docops;
      if (!d || !Array.isArray(list) || !list.length) return false;
      const ao = applyOpts || {};
      let did = false;
      store.transact(ao.label || 'Resize', () => {
        for (const { it, box } of list) {
          const sz = it.eff.sizing || {};
          const patch = {};
          if (Math.abs(box.w - it.wr.w) > 1e-6 && sz.w && sz.w !== 'fixed') patch['sizing.w'] = 'fixed';
          if (Math.abs(box.h - it.wr.h) > 1e-6 && sz.h && sz.h !== 'fixed') patch['sizing.h'] = 'fixed';
          if (Object.keys(patch).length) d.update(store, [it.id], patch, { coalesce: ao.coalesce });
          if (d.setBox(store, it.id, box, { coalesce: ao.coalesce })) did = true;
        }
      }, { coalesce: ao.coalesce });
      return did;
    }

    function unionOf(items) {
      const pts = [];
      for (const it of items) {
        const r = it.wr;
        if (!r.rotation) { pts.push(r); continue; }
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const p = rotV((sx * r.w) / 2, (sy * r.h) / 2, r.rotation);
          pts.push({ x: cx + p.x, y: cy + p.y, w: 0, h: 0 });
        }
      }
      return geometry.union(pts);
    }

    function keepsAspect(type) {
      const def = elements.get(type);
      return type === 'image' || !!(def && def.caps && (def.caps.keepAspect === true || def.caps.image === true));
    }

    function isMarqueeContainer(id) {
      const n = store.node(id);
      if (!n || !Array.isArray(n.children) || !n.children.length) return false;
      return n.type !== 'group' && n.type !== 'instance';
    }

    function selectTarget(id) {
      if (!id) {
        if (store.selection.length) store.select([]);
        if (store.view.context) store.setView({ context: null });
        return;
      }
      store.select([id]);
      const c = store.view.context;
      if (c && (c === id || !schema.ancestors(store.doc, id).includes(c))) store.setView({ context: null });
    }

    function setCursor(value) {
      const v = value || '';
      if (v === cursor) return;
      cursor = v;
      if (v) el.style.setProperty('--apb-cursor', v); else el.style.removeProperty('--apb-cursor');
    }

    function setHover(id) {
      const v = id || null;
      if (store.view.hover !== v) store.setView({ hover: v });
    }

    function announce(msg) {
      const ui = app.ui;
      if (ui && typeof ui.announce === 'function') { try { ui.announce(msg); } catch (_) { /* optional */ } }
    }

    function gesture(name, gOpts) {
      const factory = localGestures.get(name) || gestureDefs.get(name);
      return factory ? factory(ctx, gOpts || {}) : null;
    }

    function hasGesture(name) {
      return localGestures.has(name) || gestureDefs.has(name);
    }

    /** Stack children cannot move freely; a later `reorder` gesture handles them when registered. */
    function stackDrag(ids, pt) {
      return hasGesture('reorder') ? gesture('reorder', { ids, start: pt }) : null;
    }

    function fmt(v) {
      const r = Math.round(v * 10) / 10;
      return String(Object.is(r, -0) ? 0 : r);
    }

    const ctx = {
      app, store, canvas,
      get overlay() { return canvas.overlay && typeof canvas.overlay.hitTest === 'function' ? canvas.overlay : noopOverlay; },
      get active() { return active; },
      DRAG_THRESHOLD,
      modKey, point, history, snapConfig, snapTargets, movableIds, boxItem, localBox, applyBoxes, unionOf,
      keepsAspect, isMarqueeContainer, selectTarget, setCursor, setHover, announce, gesture, hasGesture, stackDrag, fmt,
      coalesceKey: (name) => 'gesture:' + name + ':' + (++keySeq) + ':' + Date.now(),
      cancel: () => cancelActive(),
      tool: (name) => localTools.get(name) || toolDefs.get(name) || null
    };

    function currentTool() {
      return ctx.tool(store.view.tool || 'select');
    }

    /* ------------------------------------------------------ pipeline */

    function inTextEditor(t) {
      const te = canvas.textedit;
      const host = te && typeof te.host === 'function' ? te.host() : null;
      return !!(host && t && host.contains(t));
    }

    function isGesture(x) {
      return !!(x && typeof x.move === 'function' && typeof x.end === 'function');
    }

    function onPointerDown(e) {
      if (destroyed) return;
      if (active) {
        if (e.pointerId !== active.pointerId) return;
        cancelActive();
      }
      if (e.button !== 0 || e.isPrimary === false) return;
      if (inTextEditor(e.target)) return;
      if (canvas.rulersEl && canvas.rulersEl.contains(e.target)) return;
      const tool = currentTool();
      if (!tool || typeof tool.down !== 'function') return;
      const pt = point(e);
      let res = null;
      try {
        res = tool.down(ctx, pt);
      } catch (err) {
        console.error('[APB] canvas tool failed:', err);
        return;
      }
      if (!res) return;
      e.preventDefault();
      cancelHover();
      active = { pointerId: e.pointerId, start: pt, last: pt, pending: isGesture(res) ? null : res, gesture: isGesture(res) ? res : null, dead: false };
      if (active.gesture) { setHover(null); if (active.gesture.cursor) setCursor(active.gesture.cursor); }
      else if (res.cursor) setCursor(res.cursor);
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      win.addEventListener('keydown', onKey, true);
      win.addEventListener('keyup', onKey, true);
    }

    function runMove(pt) {
      const t0 = perfNow();
      try {
        active.gesture.move(pt);
      } catch (err) {
        console.error('[APB] canvas gesture failed:', err);
        cancelActive();
        return;
      }
      const dt = perfNow() - t0;
      perf.count++;
      perf.total += dt;
      if (dt > perf.max) perf.max = dt;
      perf.samples.push(dt);
      if (perf.samples.length > PERF_SAMPLES) perf.samples.shift();
    }

    function onPointerMove(e) {
      if (destroyed) return;
      if (active && e.pointerId === active.pointerId) {
        const pt = point(e);
        active.last = pt;
        if (active.dead) return;
        if (!active.gesture) {
          const dist = Math.hypot(pt.clientX - active.start.clientX, pt.clientY - active.start.clientY);
          if (dist < DRAG_THRESHOLD) return;
          let g = null;
          try {
            g = active.pending && typeof active.pending.drag === 'function' ? active.pending.drag(pt) : null;
          } catch (err) {
            console.error('[APB] canvas gesture failed to start:', err);
            g = null;
          }
          if (!isGesture(g)) { active.dead = true; return; }
          active.gesture = g;
          setHover(null);
          if (g.cursor) setCursor(g.cursor);
        }
        runMove(pt);
        return;
      }
      if (!active && e.pointerType !== 'touch') scheduleHover(e);
    }

    function onPointerUp(e) {
      if (destroyed || !active || e.pointerId !== active.pointerId) return;
      const a = active;
      const pt = point(e);
      finish();
      try {
        if (a.gesture) a.gesture.end(pt);
        else if (!a.dead && a.pending && typeof a.pending.click === 'function') a.pending.click(pt);
      } catch (err) {
        console.error('[APB] canvas gesture failed to finish:', err);
      }
      scheduleHover(e);
    }

    function onPointerCancel(e) {
      if (active && e.pointerId === active.pointerId) cancelActive();
    }

    function cancelActive() {
      if (!active) return false;
      const a = active;
      finish();
      if (a.gesture && typeof a.gesture.cancel === 'function') {
        try { a.gesture.cancel(); } catch (err) { console.error('[APB] canvas gesture failed to cancel:', err); }
      }
      return true;
    }

    function finish() {
      const a = active;
      active = null;
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('keyup', onKey, true);
      setCursor('');
      if (a) {
        try { if (el.hasPointerCapture && el.hasPointerCapture(a.pointerId)) el.releasePointerCapture(a.pointerId); } catch (_) { /* ignore */ }
      }
    }

    function onKey(e) {
      if (!active) return;
      if (e.type === 'keydown' && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelActive();
        announce('Cancelled');
        return;
      }
      if (e.key === 'Shift' || e.key === 'Alt' || e.key === 'Control' || e.key === 'Meta') {
        if (e.key === 'Alt') e.preventDefault();
        if (!active.gesture) return;
        const pt = point({ clientX: active.last.clientX, clientY: active.last.clientY, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, pointerType: active.last.pointerType });
        active.last = pt;
        runMove(pt);
      }
    }

    function onDblClick(e) {
      if (destroyed || active || inTextEditor(e.target)) return;
      const tool = currentTool();
      if (!tool || typeof tool.dblclick !== 'function') return;
      try {
        if (tool.dblclick(ctx, point(e))) e.preventDefault();
      } catch (err) {
        console.error('[APB] canvas double-click failed:', err);
      }
    }

    function onContextMenu(e) {
      if (destroyed || inTextEditor(e.target)) return;
      e.preventDefault();
      cancelActive();
      const pt = point(e);
      const tool = currentTool();
      if (tool && typeof tool.contextmenu === 'function') {
        try { if (tool.contextmenu(ctx, pt)) return; } catch (err) { console.error('[APB] canvas context menu failed:', err); }
      }
      const renderer = canvas.renderer;
      let id = renderer.nodeAt(pt.clientX, pt.clientY, { deep: pt.mod });
      if (id === renderer.rootId) id = null;
      if (id && !store.selection.includes(id)) ctx.selectTarget(id);
      app.emit('canvas:contextmenu', { clientX: pt.clientX, clientY: pt.clientY, nodeId: id });
    }

    /* ------------------------------------------------------------ hover */

    function scheduleHover(e) {
      hoverPt = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, pointerType: e.pointerType };
      if (!hoverFrame) hoverFrame = raf(runHover);
    }

    function cancelHover() {
      if (hoverFrame) caf(hoverFrame);
      hoverFrame = 0;
      hoverPt = null;
    }

    function runHover() {
      hoverFrame = 0;
      if (destroyed || active || !hoverPt) return;
      const vp = canvas.viewport;
      const tool = currentTool();
      if ((vp && (vp.spacePressed || vp.panning)) || !tool || typeof tool.hover !== 'function') {
        setCursor('');
        setHover(null);
        return;
      }
      let res = null;
      try { res = tool.hover(ctx, point(hoverPt)); } catch (err) { res = null; }
      setCursor(res && res.cursor ? res.cursor : '');
      setHover(res ? res.hover : null);
    }

    function onPointerLeave() {
      if (active) return;
      cancelHover();
      setHover(null);
      setCursor('');
    }

    /* ----------------------------------------------------------- wiring */

    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      offs.push(() => target.removeEventListener(type, fn, options));
    }

    listen(el, 'pointerdown', onPointerDown);
    listen(el, 'pointermove', onPointerMove);
    listen(el, 'pointerup', onPointerUp);
    listen(el, 'pointercancel', onPointerCancel);
    listen(el, 'lostpointercapture', onPointerCancel);
    listen(el, 'pointerleave', onPointerLeave);
    listen(el, 'dblclick', onDblClick);
    listen(el, 'contextmenu', onContextMenu);
    listen(el, 'apb:gesturestart', () => { cancelActive(); cancelHover(); setHover(null); });
    listen(win, 'blur', () => cancelActive());

    offs.push(store.on('view', (p) => {
      const ch = (p && p.changed) || [];
      if (ch.includes('tool') || ch.includes('pageId') || ch.includes('bp') || ch.includes('component')) {
        cancelActive();
        setHover(null);
        setCursor('');
      }
    }));

    offs.push(store.on('change', (p) => {
      // Undo/redo/replace while dragging would fight the gesture: drop it without reverting.
      if (active && p && p.source !== 'user') {
        const a = active;
        finish();
        if (a.gesture && typeof ctx.overlay.clear === 'function') ctx.overlay.clear();
      }
    }));

    function destroy() {
      if (destroyed) return;
      cancelActive();
      cancelHover();
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      el.style.removeProperty('--apb-cursor');
    }

    return {
      ctx,
      destroy,
      cancel: cancelActive,
      get active() { return !!active; },
      get gestureName() { return active && active.gesture ? active.gesture.name || null : null; },
      registerTool(name, def) {
        if (typeof name !== 'string' || !name || !def) throw new TypeError('registerTool(name, def)');
        localTools.set(name, def);
        return () => { if (localTools.get(name) === def) localTools.delete(name); };
      },
      registerGesture(name, factory) {
        if (typeof name !== 'string' || !name || typeof factory !== 'function') throw new TypeError('registerGesture(name, factory)');
        localGestures.set(name, factory);
        return () => { if (localGestures.get(name) === factory) localGestures.delete(name); };
      },
      perf: {
        get stats() {
          const s = perf.samples.slice().sort((a, b) => a - b);
          const pick = (q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
          return { count: perf.count, avg: perf.count ? perf.total / perf.count : 0, max: perf.max, p50: pick(0.5), p95: pick(0.95) };
        },
        reset() { perf.count = 0; perf.total = 0; perf.max = 0; perf.samples.length = 0; }
      }
    };
  }

  return { create, registerTool, registerGesture, DRAG_THRESHOLD, tools: toolDefs, gestures: gestureDefs };
});

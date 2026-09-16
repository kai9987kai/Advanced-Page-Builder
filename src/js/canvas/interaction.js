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
 *
 * B1b-2 adds on top of that: the drawing tools (frame/section/text/rect/ellipse/line/image) and their
 * `tool.*` commands, the `reorder` gesture for stack children (insertion indicator + `docops.reparent`),
 * drop-to-reparent while moving (dwell 400 ms over another container, or leaving the parent), the
 * Alt-hover distance measurement, the keyboard model (nudge / Enter / Escape / Tab) with its `select.*`
 * commands, touch long-press → context menu and file drops (images, `.json` projects).
 */
APB.define('interaction', ['util', 'geometry', 'snapping', 'schema', 'elements', 'commands'],
  function (util, geometry, snapping, schema, elements, commands) {
  'use strict';

  const DRAG_THRESHOLD = 3;
  const PERF_SAMPLES = 240;
  /** Hovering another container this long while dragging reparents into it. */
  const DWELL_MS = 400;
  /** Minimum gap between drop-target hit tests (each one flushes the renderer). */
  const HIT_TEST_MS = 60;
  const LONG_PRESS_MS = 500;
  const NUDGE_IDLE_MS = 600;
  const MAX_IMAGE_INSERT = 640;
  const toolDefs = new Map();
  const gestureDefs = new Map();
  let keySeq = 0;
  let commandsRegistered = false;

  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  /** Drawing tools: the node each one creates and the size a click (no drag) gives it. */
  const DRAW_TOOLS = {
    frame: { spec: () => ({ type: 'frame' }), size: { w: 320, h: 240 } },
    section: { spec: () => ({ type: 'section' }), size: { w: 1440, h: 400 }, root: true },
    text: { spec: () => ({ type: 'text', props: { text: 'Text' } }), size: { w: 240, h: 48 }, edit: true },
    rect: { spec: () => ({ type: 'shape', name: 'Rectangle', props: { shape: 'rect' } }), size: { w: 160, h: 160 } },
    ellipse: { spec: () => ({ type: 'shape', name: 'Ellipse', props: { shape: 'ellipse' } }), size: { w: 160, h: 160 } },
    line: { spec: () => ({ type: 'shape', name: 'Line', props: { shape: 'line' } }), size: { w: 240, h: 1 }, flat: true },
    image: { spec: () => ({ type: 'image' }), size: { w: 320, h: 240 }, pick: true }
  };

  const TOOL_KEYS = [
    ['select', 'Select', 'select', ['V']],
    ['hand', 'Hand (pan)', 'hand', ['H']],
    ['frame', 'Frame', 'frame', ['F']],
    ['section', 'Section', 'section', ['S']],
    ['text', 'Text', 'text', ['T']],
    ['rect', 'Rectangle', 'rect', ['R']],
    ['ellipse', 'Ellipse', 'ellipse', ['O']],
    ['line', 'Line', 'line', ['L']],
    ['image', 'Image', 'image', ['Mod+Shift+K']]
  ];

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
  const JSON_RE = /\.(apb\.)?json$/i;

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
    const drop = ctx.dropDetector(ids);
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
      const d = drop.update(pt);
      ctx.overlay.set({
        guides, spacing, hideHandles: true, hideHover: true,
        highlight: d ? d.highlight : null, indicator: d ? d.indicator : null
      });
    }

    return {
      name: 'move',
      cursor: 'default',
      get ids() { return ids.slice(); },
      move,
      end(pt) {
        ctx.overlay.clear();
        const into = drop.update(pt, true);
        if (!changed && !into) return;
        // Replay as separate coalesced transactions: `docops` reads `store.doc`, which is the
        // pre-transaction state inside a transaction, so these steps must each see the committed doc.
        ctx.history.finalize(mark, () => {
          const replay = ctx.coalesceKey('move');
          const t = duplicated
            ? store.transact(label, () => docops.duplicate(store, origIds, { offset: 0 }), { coalesce: replay })
            : origIds;
          if (applied.dx || applied.dy) docops.move(store, t, applied.dx, applied.dy, { label, coalesce: replay });
          if (into) store.transact(label, () => { docops.reparent(store, t, into.parent, into.index); }, { coalesce: replay });
        }, { force: !!into });
        if (into) ctx.announce(ctx.idsLabel(ids) + ' moved into ' + ctx.nodeLabel(into.parent));
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

  /** reorder: drag a stack child — insertion indicator, then one `docops.reparent` on release. */
  registerGesture('reorder', function (ctx, o) {
    const { store, app } = ctx;
    const docops = app.docops;
    if (!docops) return null;
    const doc = store.doc;
    const ids = docops.sortDocOrder(doc, docops.topLevel(doc, o.ids || store.selection))
      .filter((id) => own(doc.nodes, id) && doc.nodes[id].parent && !docops.isLocked(doc, id));
    if (!ids.length) return null;
    const drop = ctx.dropDetector(ids, { reorder: true });

    return {
      name: 'reorder',
      cursor: 'grabbing',
      get ids() { return ids.slice(); },
      move(pt) {
        const d = drop.update(pt);
        ctx.overlay.set({
          hideHandles: true, hideHover: true,
          highlight: d ? d.highlight : null, indicator: d ? d.indicator : null
        });
      },
      end(pt) {
        ctx.overlay.clear();
        const into = drop.update(pt, true);
        if (!into || !ctx.reorderChanges(into.parent, ids, into.index)) return;
        const moved = docops.reparent(app, ids, into.parent, into.index);
        if (moved && moved.length) ctx.announce(ctx.idsLabel(ids) + ' moved into ' + ctx.nodeLabel(into.parent));
      },
      cancel() { ctx.overlay.clear(); }
    };
  });

  /** draw: rubber-band a new node inside the container under the pointer (drawing tools). */
  registerGesture('draw', function (ctx, o) {
    const start = o.start;
    const tool = o.tool;
    const def = DRAW_TOOLS[tool];
    if (!def) return null;
    let rect = null;
    let guides = [];

    function norm(x, y, w, h) {
      return {
        x: Math.round(x), y: Math.round(y),
        w: Math.max(0, Math.round(w)),
        h: def.flat ? 1 : Math.max(0, Math.round(h))
      };
    }

    function compute(pt) {
      const x1 = start.page.x;
      const y1 = start.page.y;
      let px = pt.page.x;
      let py = def.flat ? y1 : pt.page.y;
      guides = [];
      const snap = ctx.snapConfig(pt);
      if (snap.enabled && o.snap) {
        const s = snapping.snapPoint({
          point: { x: px, y: py }, others: o.snap.others, parent: o.snap.parent,
          grid: snap.grid, gridSize: snap.gridSize, threshold: snap.threshold
        });
        if (s) {
          if (Number.isFinite(s.x)) px = s.x;
          if (Number.isFinite(s.y) && !def.flat) py = s.y;
          guides = s.guides || [];
        }
      }
      let w = Math.abs(px - x1);
      let h = Math.abs(py - y1);
      if (pt.shift && !def.flat) { const m = Math.max(w, h); w = m; h = m; }
      if (pt.alt) return norm(x1 - w, y1 - h, w * 2, h * 2);
      return norm(px < x1 ? x1 - w : x1, py < y1 ? y1 - h : y1, w, h);
    }

    return {
      name: 'draw',
      cursor: tool === 'text' ? 'text' : 'crosshair',
      move(pt) {
        rect = compute(pt);
        ctx.overlay.set({ marquee: rect, guides, hideSelection: true, hideHover: true, hideHandles: true });
      },
      end(pt) {
        ctx.overlay.clear();
        const r = rect && (rect.w >= 2 || rect.h >= 2) ? rect : null;
        ctx.createNode(tool, r, o.target, pt);
      },
      cancel() { ctx.overlay.clear(); }
    };
  });

  /* ============================================================ draw tools */

  for (const name of Object.keys(DRAW_TOOLS)) {
    registerTool(name, {
      cursor: name === 'text' ? 'text' : 'crosshair',
      down(ctx, pt) {
        const target = ctx.drawTarget(name, pt);
        if (!target) return null;
        return {
          cursor: name === 'text' ? 'text' : 'crosshair',
          drag: () => ctx.gesture('draw', { tool: name, start: pt, target, snap: ctx.drawSnap(target.parent) }),
          click: (p) => ctx.createNode(name, null, target, p)
        };
      },
      hover(ctx, pt) {
        const t = ctx.drawTarget(name, pt);
        return { hover: t && t.parent !== ctx.canvas.renderer.rootId ? t.parent : null, cursor: name === 'text' ? 'text' : 'crosshair' };
      }
    });
  }

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

  /* ============================================================== commands */

  const canvasOf = (a) => (a && a.canvas && a.canvas.el ? a.canvas : null);
  const keyboardOf = (a) => { const c = canvasOf(a); return c && c.interaction ? c.interaction.keyboard : null; };

  /** The keyboard model only applies while the canvas viewport itself has focus. */
  function canvasFocused(a) {
    const c = canvasOf(a);
    if (!c || (a.store && a.store.view.editingText)) return false;
    const d = c.el.ownerDocument;
    return !!d && d.activeElement === c.el;
  }

  function run(name) {
    return (a) => {
      const k = keyboardOf(a);
      return k && typeof k[name] === 'function' ? k[name]() : false;
    };
  }

  /** `tool.*` and `select.*`; canvas.js owns the `view.*` zoom commands. */
  function registerCommands() {
    if (commandsRegistered) return;
    commandsRegistered = true;
    const defs = [];
    for (const [tool, title, icon, keys] of TOOL_KEYS) {
      defs.push({
        id: 'tool.' + tool,
        title: title + (tool === 'hand' ? '' : ' tool'),
        category: 'Tools',
        icon,
        keys,
        when: (a) => !!canvasOf(a) && !a.store.view.editingText,
        checked: (a) => !!canvasOf(a) && (a.store.view.tool || 'select') === tool,
        run: (a) => {
          const c = canvasOf(a);
          if (!c) return;
          c.setTool(tool);
          if (tool === 'image' && c.interaction && typeof c.interaction.openImagePicker === 'function') c.interaction.openImagePicker({});
        }
      });
    }
    defs.push(
      {
        id: 'view.toggleSnap', title: 'Toggle snapping', category: 'View', icon: 'magnet',
        checked: (a) => !!(a && (a.store.prefs.snap || {}).objects !== false),
        run: (a) => {
          const snap = Object.assign({}, a.store.prefs.snap);
          snap.objects = snap.objects === false;
          a.store.setPrefs({ snap });
        }
      },
      { id: 'select.all', title: 'Select all in container', icon: 'select-box', keys: ['Mod+A'], when: canvasFocused, run: run('all') },
      {
        id: 'select.none', title: 'Deselect', icon: 'close', keys: ['Escape'],
        when: (a) => canvasFocused(a) && (a.store.selection.length > 0 || !!a.store.view.context), run: run('none')
      },
      {
        id: 'select.parent', title: 'Select parent', icon: 'arrow-up', keys: ['Shift+Enter'],
        when: (a) => canvasFocused(a) && a.store.selection.length > 0, run: run('parent')
      },
      { id: 'select.child', title: 'Select first child', icon: 'arrow-down', keys: ['Enter'], when: canvasFocused, run: run('enter') },
      {
        id: 'select.next', title: 'Select next layer', icon: 'arrow-right', keys: ['Tab'],
        when: canvasFocused, run: (a) => { const k = keyboardOf(a); return k ? k.sibling(1) : false; }
      },
      {
        id: 'select.prev', title: 'Select previous layer', icon: 'arrow-left', keys: ['Shift+Tab'],
        when: canvasFocused, run: (a) => { const k = keyboardOf(a); return k ? k.sibling(-1) : false; }
      }
    );
    for (const d of defs) {
      if (!commands.get(d.id)) commands.register(Object.assign({ category: 'Select' }, d));
    }
  }

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
    let repeatTimer = 0;
    let longPressTimer = 0;
    let nudge = null;
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
      /**
       * Ensure the gesture produced one undo entry: if the coalesce window lapsed, replay it once.
       * `opts.force` replays even from a single entry (used when the final state differs from the
       * live preview, e.g. a drag that also reparents).
       */
      finalize(mark, reapply, opts) {
        const h = store.history();
        if (typeof reapply !== 'function') return;
        if (h.index - mark.index <= 1 && !(opts && opts.force)) return;
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

    /* ------------------------------------------------------- layer naming */

    function nodeLabel(id) {
      const n = store.node(id);
      if (!n) return 'layer';
      if (n.name) return n.name;
      const def = elements.get(n.type);
      return (def && def.label) || n.type;
    }

    function typeLabel(id) {
      const n = store.node(id);
      const def = n ? elements.get(n.type) : null;
      return (def && def.label) || (n ? n.type : '');
    }

    function idsLabel(ids) {
      return ids.length === 1 ? nodeLabel(ids[0]) : util.plural(ids.length, 'layer');
    }

    function announceSelected(id) {
      if (!store.node(id)) return;
      announce('Selected ' + nodeLabel(id) + ', ' + typeLabel(id));
    }

    /* --------------------------------------------------- containers / flow */

    function isStack(id) {
      const e = id ? schema.effectiveNode(store.doc, id, store.view.bp) : null;
      return !!(e && e.layout && e.layout.mode === 'stack');
    }

    /** Where a point falls in a stack parent's flow: `{ index, kids, row }` (kids exclude `skip`). */
    function flowInfo(parentId, pt, skip) {
      const doc = store.doc;
      const eff = schema.effectiveNode(doc, parentId, store.view.bp);
      const L = eff && eff.layout;
      const row = !!(L && L.dir === 'row');
      const kids = (((own(doc.nodes, parentId) && doc.nodes[parentId].children) || [])).filter((c) => !skip || !skip.has(c));
      const at = row ? pt.page.x : pt.page.y;
      let index = kids.length;
      for (let i = 0; i < kids.length; i++) {
        const r = canvas.renderer.bounds([kids[i]]);
        if (!r) continue;
        if (at < (row ? r.x + r.w / 2 : r.y + r.h / 2)) { index = i; break; }
      }
      return { index, kids, row };
    }

    /** Page-space line where an insertion at `info.index` would land. */
    function indicatorFor(parentId, info) {
      const pr = canvas.renderer.bounds([parentId]);
      if (!pr) return null;
      const { index, kids, row } = info;
      let pos = null;
      if (!kids.length) pos = row ? pr.x + 1 : pr.y + 1;
      else {
        const ref = index <= 0 ? canvas.renderer.bounds([kids[0]]) : canvas.renderer.bounds([kids[Math.min(index, kids.length) - 1]]);
        if (ref) pos = index <= 0 ? (row ? ref.x : ref.y) : (row ? ref.x + ref.w : ref.y + ref.h);
      }
      if (pos === null) return null;
      return row
        ? { x1: pos, y1: pr.y, x2: pos, y2: pr.y + pr.h }
        : { x1: pr.x, y1: pos, x2: pr.x + pr.w, y2: pos };
    }

    /** Would `docops.reparent(parent, ids, index)` change anything? */
    function reorderChanges(parentId, ids, index) {
      const doc = store.doc;
      const n = own(doc.nodes, parentId) ? doc.nodes[parentId] : null;
      if (!n || !Array.isArray(n.children)) return false;
      if (ids.some((id) => !own(doc.nodes, id) || doc.nodes[id].parent !== parentId)) return true;
      const set = new Set(ids);
      const base = n.children.filter((c) => !set.has(c));
      const at = index === undefined || index === null ? base.length : util.clamp(Math.round(index), 0, base.length);
      return !util.deepEqual(base.slice(0, at).concat(ids, base.slice(at)), n.children);
    }

    /**
     * Drop target of a drag: the deepest acceptable container under the pointer. Another container
     * needs a 400 ms dwell (immediate once the pointer left the current parent); once accepted it
     * stays accepted while the pointer is over it. `opts.reorder` also reports the flow index of the
     * node's own stack parent. Throttled to one hit test per frame (hit testing flushes the renderer).
     */
    function dropDetector(ids, dOpts) {
      const opts = dOpts || {};
      const doc0 = store.doc;
      const dragged = new Set(ids);
      const types = ids.map((id) => (own(doc0.nodes, id) ? doc0.nodes[id].type : null)).filter(Boolean);
      const home = opts.parent !== undefined ? opts.parent : (own(doc0.nodes, ids[0]) ? doc0.nodes[ids[0]].parent : null);
      let pendingId = null;
      let pendingAt = 0;
      let lockedId = null;
      let out = null;
      let lastRun = 0;
      let lastPt = null;
      let stillSince = 0;
      // Measured before the drag writes anything: re-measuring would flush the renderer every frame.
      const homeRect = home ? canvas.renderer.bounds([home]) : null;

      function insideDragged(id) {
        const doc = store.doc;
        let cur = id;
        let guard = 64;
        while (cur && guard-- > 0) {
          if (dragged.has(cur)) return true;
          cur = own(doc.nodes, cur) ? doc.nodes[cur].parent : null;
        }
        return false;
      }

      function accepts(id) {
        const doc = store.doc;
        const n = own(doc.nodes, id) ? doc.nodes[id] : null;
        if (!n || !Array.isArray(n.children)) return false;
        if (app.docops && app.docops.isLocked(doc, id)) return false;
        if (insideDragged(id)) return false;
        return types.every((t) => elements.canContain(n.type, t));
      }

      function targetFor(parentId, pt, highlight) {
        if (!isStack(parentId)) return { parent: parentId, index: undefined, indicator: null, highlight };
        const info = flowInfo(parentId, pt, dragged);
        return { parent: parentId, index: info.index, indicator: indicatorFor(parentId, info), highlight };
      }

      /** While no other container is accepted yet, a reorder drag keeps showing its own flow position. */
      function homeFallback(pt) {
        return opts.reorder && isStack(home) ? targetFor(home, pt, null) : null;
      }

      function update(pt, force) {
        const now = Date.now();
        if (!lastPt || Math.hypot(pt.clientX - lastPt.x, pt.clientY - lastPt.y) >= 3) {
          lastPt = { x: pt.clientX, y: pt.clientY };
          stillSince = now;
        }
        // Hit testing flushes the renderer, so avoid it while the drag is still inside its own
        // parent and moving: dropping there needs a 400 ms dwell anyway. Leaving the parent (or
        // releasing, which passes `force`) drops immediately, so those always test.
        if (!force) {
          if (now - lastRun < HIT_TEST_MS) {
            if (pendingId && !lockedId) repeat(HIT_TEST_MS + 8);
            return out;
          }
          const inside = !!homeRect && geometry.pointInRect(pt.page, homeRect);
          if (inside && !lockedId && now - stillSince < DWELL_MS) {
            repeat(DWELL_MS - (now - stillSince) + 20);
            out = homeFallback(pt);
            return out;
          }
        }
        lastRun = now;
        const hit = canvas.renderer.nodeAt(pt.clientX, pt.clientY, { deep: true, filter: accepts });
        if (!hit) { pendingId = null; out = homeFallback(pt); return out; }
        if (hit === home) {
          pendingId = null;
          lockedId = null;
          out = homeFallback(pt);
          return out;
        }
        if (lockedId !== hit) {
          const outside = !homeRect || !geometry.pointInRect(pt.page, homeRect);
          if (pendingId !== hit) { pendingId = hit; pendingAt = Math.min(now, stillSince || now); }
          if (!outside && now - pendingAt < DWELL_MS) {
            repeat(Math.max(HIT_TEST_MS + 8, DWELL_MS - (now - pendingAt) + 20));
            out = homeFallback(pt);
            return out;
          }
          lockedId = hit;
        }
        out = targetFor(hit, pt, hit);
        return out;
      }

      return { update, accepts, result: () => out };
    }

    /* -------------------------------------------------------- drawing tools */

    /** Page rect → the parent's local coordinates (parent border box and rotation aware). */
    function localRect(parentId, r) {
      const pr = canvas.renderer.worldRect(parentId);
      if (!pr) return { x: Math.round(r.x), y: Math.round(r.y), w: r.w, h: r.h };
      const pel = canvas.renderer.el(parentId);
      const bl = pel && Number.isFinite(pel.clientLeft) ? pel.clientLeft : 0;
      const bt = pel && Number.isFinite(pel.clientTop) ? pel.clientTop : 0;
      let c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      if (pr.rotation) c = geometry.rotatePoint(c, { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 }, -pr.rotation);
      return { x: Math.round(c.x - r.w / 2 - pr.x - bl), y: Math.round(c.y - r.h / 2 - pr.y - bt), w: r.w, h: r.h };
    }

    /** The container a drawing tool would create into: `{ parent, index? }`. */
    function drawTarget(tool, pt) {
      const def = DRAW_TOOLS[tool];
      if (!def) return null;
      const doc = store.doc;
      const renderer = canvas.renderer;
      const rootId = renderer.rootId;
      const type = def.spec().type || 'frame';
      if (def.root) {
        const root = own(doc.nodes, rootId) ? doc.nodes[rootId] : null;
        if (!root) return null;
        return { parent: rootId, index: flowInfo(rootId, pt, null).index };
      }
      const accepts = (id) => {
        const n = own(doc.nodes, id) ? doc.nodes[id] : null;
        if (!n || !Array.isArray(n.children)) return false;
        if (app.docops && app.docops.isLocked(doc, id)) return false;
        return elements.canContain(n.type, type);
      };
      let parent = renderer.nodeAt(pt.clientX, pt.clientY, { deep: true, filter: accepts });
      if (!parent) {
        const c = store.view.context;
        if (c && own(doc.nodes, c) && accepts(c)) parent = c;
        else if (rootId && accepts(rootId)) parent = rootId;
      }
      if (!parent) return null;
      return isStack(parent) ? { parent, index: flowInfo(parent, pt, null).index } : { parent };
    }

    /** Snap candidates for a drawing tool: the target container and its children. */
    function drawSnap(parentId) {
      const others = [];
      for (const cid of ((own(store.doc.nodes, parentId) && store.doc.nodes[parentId].children) || [])) {
        const r = canvas.renderer.bounds([cid]);
        if (r) others.push(r);
      }
      return { others, parent: canvas.renderer.bounds([parentId]) };
    }

    /** Create the node a drawing tool drew (or clicked). Returns the new id. */
    function createNode(tool, rect, target, pt) {
      const def = DRAW_TOOLS[tool];
      const d = app.docops;
      if (!def || !d) return null;
      const t = target && target.parent ? target : drawTarget(tool, pt);
      if (!t) return null;
      let r = rect;
      if (!r) {
        const p = pt && pt.page ? pt.page : canvas.viewport.screenToPage(0, 0);
        r = { x: p.x - def.size.w / 2, y: p.y - def.size.h / 2, w: def.size.w, h: def.size.h };
      }
      const spec = def.spec();
      const local = localRect(t.parent, r);
      spec.w = Math.max(1, Math.round(local.w || def.size.w));
      spec.h = def.flat ? 1 : Math.max(1, Math.round(local.h || def.size.h));
      if (!def.root && !isStack(t.parent)) {
        spec.x = local.x;
        spec.y = local.y;
      }
      if (def.root) spec.h = Math.max(40, spec.h);
      const opts = { parent: t.parent, select: true };
      if (Number.isFinite(t.index)) opts.index = t.index;
      let ids = [];
      try {
        ids = d.insert(app, [spec], opts);
      } catch (err) {
        console.error('[APB] canvas insert failed:', err);
        return null;
      }
      const id = ids && ids[0];
      if (!id) return null;
      if (!(pt && pt.shift)) canvas.setTool('select');
      announce(typeLabel(id) + ' added to ' + nodeLabel(t.parent));
      if (def.pick) openImagePicker({ replace: id });
      else if (def.edit) canvas.startTextEdit(id);
      return id;
    }

    /* --------------------------------------------------------------- images */

    let fileInput = null;
    let fileInputJob = null;

    function ensureFileInput() {
      if (fileInput && fileInput.isConnected) return fileInput;
      fileInput = ownerDoc.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.multiple = true;
      fileInput.tabIndex = -1;
      fileInput.setAttribute('aria-hidden', 'true');
      fileInput.className = 'apb-canvas-file-input';
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        const job = fileInputJob;
        fileInputJob = null;
        fileInput.value = '';
        if (files.length) placeImages(files, job || {});
      });
      el.appendChild(fileInput);
      return fileInput;
    }

    /** Open the hidden file input; `job.replace` fills an existing image node instead of inserting. */
    function openImagePicker(job) {
      const input = ensureFileInput();
      fileInputJob = job || {};
      try { input.click(); } catch (_) { /* blocked */ }
    }

    function readDataURL(file) {
      return new Promise((resolve) => {
        try {
          const fr = new win.FileReader();
          fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
          fr.onerror = () => resolve('');
          fr.readAsDataURL(file);
        } catch (_) { resolve(''); }
      });
    }

    function measureImage(src) {
      return new Promise((resolve) => {
        if (!src || typeof win.Image !== 'function') { resolve(null); return; }
        const img = new win.Image();
        img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
        img.onerror = () => resolve(null);
        img.src = src;
      });
    }

    /** services.assets.add when a plugin provides it, else a data URL through FileReader. */
    async function assetProps(file) {
      const svc = app.services && app.services.assets;
      if (svc && typeof svc.add === 'function') {
        try {
          const res = await svc.add(file);
          if (typeof res === 'string' && res) return { asset: res, src: '' };
          if (res && typeof res === 'object') return { asset: res.id || '', src: res.src || '' };
        } catch (err) {
          console.error('[APB] assets.add failed:', err);
        }
      }
      return { asset: '', src: await readDataURL(file) };
    }

    function fitSize(nat) {
      if (!nat || !nat.w || !nat.h) return { w: DRAW_TOOLS.image.size.w, h: DRAW_TOOLS.image.size.h };
      const s = Math.min(1, MAX_IMAGE_INSERT / Math.max(nat.w, nat.h));
      return { w: Math.max(1, Math.round(nat.w * s)), h: Math.max(1, Math.round(nat.h * s)) };
    }

    /**
     * Insert image nodes for `files`. `job.replace` = fill that node instead; `job.point` = page
     * position of the first image (later ones cascade by 16 px); otherwise the viewport centre.
     */
    async function placeImages(files, job) {
      const d = app.docops;
      if (!d) return [];
      const list = files.filter((f) => f && (/^image\//.test(f.type || '') || IMAGE_RE.test(f.name || '')));
      if (!list.length) return [];
      const specs = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        const props = await assetProps(file);
        if (!props.src && !props.asset) continue;
        const size = fitSize(await measureImage(props.src));
        if (destroyed) return [];
        if (job.replace && own(store.doc.nodes, job.replace)) {
          const patch = { 'props.src': props.src, 'props.asset': props.asset, name: file.name || 'Image' };
          d.update(app, [job.replace], patch, { label: 'Set image' });
          return [job.replace];
        }
        specs.push({ spec: Object.assign(DRAW_TOOLS.image.spec(), { name: file.name || 'Image', props: { src: props.src, asset: props.asset, alt: '', decorative: false, loading: 'lazy', fetchpriority: '' } }), size, index: i });
      }
      if (!specs.length) return [];
      if (!job.point) {
        const ids = canvas.insertAtViewportCenter(specs.map((s) => Object.assign(s.spec, s.size)));
        if (ids.length) announce(util.plural(ids.length, 'image') + ' inserted');
        return ids;
      }
      const t = drawTarget('image', { clientX: job.clientX, clientY: job.clientY, page: job.point }) || { parent: canvas.renderer.rootId };
      const out = specs.map((s) => {
        const off = s.index * 16;
        const r = { x: job.point.x - s.size.w / 2 + off, y: job.point.y - s.size.h / 2 + off, w: s.size.w, h: s.size.h };
        const local = localRect(t.parent, r);
        return Object.assign(s.spec, { w: s.size.w, h: s.size.h }, isStack(t.parent) ? {} : { x: local.x, y: local.y });
      });
      const opts = { parent: t.parent, select: true, label: out.length === 1 ? 'Insert Image' : 'Insert ' + util.plural(out.length, 'image') };
      if (Number.isFinite(t.index)) opts.index = t.index;
      const ids = d.insert(app, out, opts);
      if (ids.length) announce(util.plural(ids.length, 'image') + ' inserted');
      return ids;
    }

    /* ----------------------------------------------------------- file drops */

    function hasFiles(e) {
      const dt = e.dataTransfer;
      if (!dt) return false;
      const types = dt.types ? Array.from(dt.types) : [];
      return types.indexOf('Files') !== -1;
    }

    function toast(message, kind) {
      const ui = app.ui;
      if (ui && typeof ui.toast === 'function') { try { ui.toast(message, kind ? { kind } : undefined); } catch (_) { /* optional */ } }
      else announce(message);
    }

    function onDragOver(e) {
      if (destroyed || !hasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch (_) { /* read-only in some browsers */ }
      const t = drawTarget('image', { clientX: e.clientX, clientY: e.clientY, page: canvas.viewport.screenToPage(e.clientX, e.clientY) });
      ctx.overlay.set({ highlight: t && t.parent !== canvas.renderer.rootId ? t.parent : null });
    }

    function onDragLeave(e) {
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      ctx.overlay.set({ highlight: null });
    }

    function onDrop(e) {
      if (destroyed || !hasFiles(e)) return;
      e.preventDefault();
      ctx.overlay.set({ highlight: null });
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      const images = files.filter((f) => /^image\//.test(f.type || '') || IMAGE_RE.test(f.name || ''));
      const projects = files.filter((f) => images.indexOf(f) === -1 && (JSON_RE.test(f.name || '') || f.type === 'application/json'));
      if (images.length) {
        placeImages(images, { point: canvas.viewport.screenToPage(e.clientX, e.clientY), clientX: e.clientX, clientY: e.clientY })
          .catch((err) => console.error('[APB] image drop failed:', err));
      }
      for (const file of projects) {
        const imp = app.services && app.services.importers;
        if (imp && typeof imp.fromFile === 'function') {
          Promise.resolve()
            .then(() => imp.fromFile(file))
            .catch((err) => { console.error('[APB] import failed:', err); toast('Could not import ' + (file.name || 'that file') + '.', 'error'); });
        } else {
          toast('Opening project files is not available yet.', 'warn');
        }
      }
      if (!images.length && !projects.length) toast('Drop images or an .apb.json project file.', 'warn');
    }

    /* -------------------------------------------------------- measurements */

    /** Alt-hover: distances between the selection bounds and the hovered node. */
    function measureBetween(a, b) {
      const out = [];
      const midY = util.clamp((a.y + a.h / 2 + b.y + b.h / 2) / 2, Math.max(a.y, b.y), Math.min(a.y + a.h, b.y + b.h));
      const midX = util.clamp((a.x + a.w / 2 + b.x + b.w / 2) / 2, Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w));
      const yPos = Number.isFinite(midY) ? midY : a.y + a.h / 2;
      const xPos = Number.isFinite(midX) ? midX : a.x + a.w / 2;
      if (b.x >= a.x + a.w) out.push({ axis: 'x', from: a.x + a.w, to: b.x, pos: yPos });
      else if (b.x + b.w <= a.x) out.push({ axis: 'x', from: b.x + b.w, to: a.x, pos: yPos });
      if (b.y >= a.y + a.h) out.push({ axis: 'y', from: a.y + a.h, to: b.y, pos: xPos });
      else if (b.y + b.h <= a.y) out.push({ axis: 'y', from: b.y + b.h, to: a.y, pos: xPos });
      if (!out.length) {
        out.push({ axis: 'x', from: a.x, to: b.x, pos: yPos });
        out.push({ axis: 'y', from: a.y, to: b.y, pos: xPos });
      }
      return out.filter((m) => Math.abs(m.to - m.from) >= 1);
    }

    let measureOn = false;

    function clearMeasure() {
      if (!measureOn) return;
      measureOn = false;
      ctx.overlay.set({ measure: null });
    }

    function updateMeasure(pt, hoverId) {
      if (!pt || !pt.alt || !hoverId || !store.selection.length || store.selection.indexOf(hoverId) !== -1) { clearMeasure(); return; }
      const a = canvas.selectionBounds();
      const b = canvas.renderer.bounds([hoverId]);
      if (!a || !b) { clearMeasure(); return; }
      measureOn = true;
      ctx.overlay.set({ measure: measureBetween(a, b) });
    }

    const ctx = {
      app, store, canvas,
      get overlay() { return canvas.overlay && typeof canvas.overlay.hitTest === 'function' ? canvas.overlay : noopOverlay; },
      get active() { return active; },
      DRAG_THRESHOLD,
      modKey, point, history, snapConfig, snapTargets, movableIds, boxItem, localBox, applyBoxes, unionOf,
      keepsAspect, isMarqueeContainer, selectTarget, setCursor, setHover, announce, gesture, hasGesture, stackDrag, fmt,
      dropDetector, reorderChanges, isStack, flowInfo, indicatorFor, localRect, drawTarget, drawSnap, createNode,
      nodeLabel, typeLabel, idsLabel, announceSelected, openImagePicker, repeat,
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
      if (pt.pointerType !== 'mouse') {
        clearLongPress();
        longPressTimer = win.setTimeout(() => {
          longPressTimer = 0;
          if (destroyed || !active || active.gesture) return;
          const last = active.last;
          cancelActive();
          openContextMenu(last);
        }, LONG_PRESS_MS);
      }
    }

    /** Re-run the active gesture with its last pointer position (used by dwell timers). */
    function repeat(ms) {
      if (destroyed || !active || !active.gesture || repeatTimer) return;
      repeatTimer = win.setTimeout(() => {
        repeatTimer = 0;
        if (!destroyed && active && active.gesture && active.last) runMove(active.last);
      }, Math.max(16, ms || DWELL_MS));
    }

    function clearRepeat() {
      if (repeatTimer) win.clearTimeout(repeatTimer);
      repeatTimer = 0;
    }

    function clearLongPress() {
      if (longPressTimer) win.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }

    function runMove(pt) {
      clearRepeat();
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
          if (dist >= DRAG_THRESHOLD) clearLongPress();
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
      clearRepeat();
      clearLongPress();
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

    function openContextMenu(pt) {
      if (!pt) return;
      const tool = currentTool();
      if (tool && typeof tool.contextmenu === 'function') {
        try { if (tool.contextmenu(ctx, pt)) return; } catch (err) { console.error('[APB] canvas context menu failed:', err); }
      }
      const renderer = canvas.renderer;
      let id = renderer.nodeAt(pt.clientX, pt.clientY, { deep: pt.mod });
      if (id === renderer.rootId) id = null;
      if (id && !store.selection.includes(id)) ctx.selectTarget(id);
      app.emit('canvas:contextmenu', { clientX: pt.clientX, clientY: pt.clientY, nodeId: id, pointerType: pt.pointerType });
    }

    function onContextMenu(e) {
      if (destroyed || inTextEditor(e.target)) return;
      e.preventDefault();
      cancelActive();
      openContextMenu(point(e));
    }

    /* --------------------------------------------------------- keyboard */

    function coalesceNudge() {
      const now = Date.now();
      if (!nudge || now - nudge.at > NUDGE_IDLE_MS) nudge = { key: 'nudge:' + (++keySeq) + ':' + now, at: now };
      nudge.at = now;
      return nudge.key;
    }

    function isStackChild(id) {
      const n = store.node(id);
      return !!(n && n.parent && isStack(n.parent));
    }

    /** Arrow keys inside a stack parent move the node up/down the flow instead of nudging. */
    function reorderByKey(ids, dx, dy) {
      const d = app.docops;
      const doc = store.doc;
      const parent = doc.nodes[ids[0]].parent;
      const list = d.sortDocOrder(doc, ids).filter((id) => doc.nodes[id].parent === parent);
      if (!list.length) return false;
      const kids = doc.nodes[parent].children || [];
      const set = new Set(list);
      const base = kids.filter((c) => !set.has(c));
      const before = kids.findIndex((c) => set.has(c));
      const baseIndex = kids.slice(0, Math.max(0, before)).filter((c) => !set.has(c)).length;
      const at = util.clamp(baseIndex + (dx < 0 || dy < 0 ? -1 : 1), 0, base.length);
      if (at === baseIndex) return false;
      d.reparent(app, list, parent, at);
      announce(idsLabel(list) + ' moved to position ' + (at + 1));
      return true;
    }

    function nudgeSelection(dx, dy) {
      const d = app.docops;
      if (!d) return false;
      const doc = store.doc;
      const top = d.topLevel(doc, store.selection).filter((id) => !d.isLocked(doc, id));
      if (!top.length) return false;
      if (top.every(isStackChild)) return reorderByKey(top, dx, dy);
      const free = top.filter((id) => !isStackChild(id));
      if (!free.length) return false;
      const moved = d.move(store, free, dx, dy, { coalesce: coalesceNudge(), label: 'Move ' + (free.length === 1 ? 'layer' : util.plural(free.length, 'layer')) });
      return moved !== false;
    }

    function firstChildOf(id) {
      const n = store.node(id);
      const kids = (n && n.children) || [];
      for (let i = kids.length - 1; i >= 0; i--) {
        if (!store.doc.nodes[kids[i]].hidden) return kids[i];
      }
      return kids.length ? kids[kids.length - 1] : null;
    }

    /** Enter: step into the selected container, or start editing an editable node. */
    function enterSelection() {
      const id = store.selection[0];
      if (!id) {
        const scope = store.view.context && own(store.doc.nodes, store.view.context) ? store.view.context : canvas.renderer.rootId;
        const child = firstChildOf(scope);
        if (!child) return false;
        store.select([child]);
        announceSelected(child);
        return true;
      }
      const child = firstChildOf(id);
      if (child) {
        if (isMarqueeContainer(id) || store.node(id).type === 'group' || store.node(id).type === 'instance') store.setView({ context: id });
        store.select([child]);
        announceSelected(child);
        return true;
      }
      const n = store.node(id);
      const def = n ? elements.get(n.type) : null;
      if (def && def.textEdit && !(app.docops && app.docops.isLocked(store.doc, id))) return canvas.startTextEdit(id);
      return false;
    }

    /** Shift+Enter / Escape: step out to the parent (the page root deselects). */
    function selectParent() {
      const id = store.selection[0];
      const n = id ? store.node(id) : null;
      const parentId = n ? n.parent : null;
      if (!parentId || parentId === canvas.renderer.rootId) {
        if (store.selection.length) store.select([]);
        if (store.view.context) store.setView({ context: null });
        return !!id;
      }
      store.select([parentId]);
      const c = store.view.context;
      if (c && (c === parentId || !schema.ancestors(store.doc, parentId).includes(c))) {
        const up = store.node(parentId);
        store.setView({ context: up && up.parent && up.parent !== canvas.renderer.rootId ? up.parent : null });
      }
      announceSelected(parentId);
      return true;
    }

    function selectSibling(dir) {
      const doc = store.doc;
      const id = store.selection[store.selection.length - 1];
      let list;
      let index;
      if (id && own(doc.nodes, id) && doc.nodes[id].parent) {
        list = (doc.nodes[doc.nodes[id].parent].children || []);
        index = list.indexOf(id);
      } else {
        const scope = store.view.context && own(doc.nodes, store.view.context) ? store.view.context : canvas.renderer.rootId;
        list = ((own(doc.nodes, scope) && doc.nodes[scope].children) || []);
        index = dir > 0 ? -1 : 0;
      }
      if (!list.length) return false;
      const next = list[((index + dir) % list.length + list.length) % list.length];
      if (!next) return false;
      store.select([next]);
      if (canvas.viewport && typeof canvas.viewport.scrollToNode === 'function') canvas.viewport.scrollToNode(next);
      announceSelected(next);
      return true;
    }

    /** Mod+A: every unlocked, visible child of the container the selection lives in. */
    function selectAllInContext() {
      const doc = store.doc;
      const d = app.docops;
      let parentId = null;
      const first = store.selection[0];
      if (first && own(doc.nodes, first)) parentId = doc.nodes[first].parent;
      if (!parentId && store.view.context && own(doc.nodes, store.view.context)) parentId = store.view.context;
      if (!parentId) parentId = canvas.renderer.rootId;
      const kids = ((own(doc.nodes, parentId) && doc.nodes[parentId].children) || [])
        .filter((id) => !doc.nodes[id].hidden && !(d && d.isLocked(doc, id)));
      if (!kids.length) return false;
      store.select(kids);
      announce(util.plural(kids.length, 'layer') + ' selected in ' + nodeLabel(parentId));
      return true;
    }

    function clearSelection() {
      if (store.selection.length || store.view.context) {
        ctx.selectTarget(null);
        announce('Selection cleared');
        return true;
      }
      if (ownerDoc.activeElement === el && typeof el.blur === 'function') { el.blur(); return true; }
      return false;
    }

    const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    function onKeyDown(e) {
      if (destroyed || e.defaultPrevented || e.isComposing) return;
      if (e.target !== el || inTextEditor(e.target) || store.view.editingText) return;
      const key = e.key;
      const mod = modKey(e);
      const take = () => { e.preventDefault(); e.stopPropagation(); };
      if (own(NUDGE_KEYS, key) && !mod && !e.altKey) {
        const [ux, uy] = NUDGE_KEYS[key];
        const step = e.shiftKey ? 10 : 1;
        take();
        nudgeSelection(ux * step, uy * step);
        return;
      }
      if (key === 'Enter' && !mod && !e.altKey) {
        take();
        if (e.shiftKey) selectParent(); else enterSelection();
        return;
      }
      if (key === 'Escape' && !mod && !e.altKey && !e.shiftKey) {
        if (store.selection.length) { take(); selectParent(); } else if (clearSelection()) take();
        return;
      }
      if (key === 'Tab' && !mod && !e.altKey) {
        if (selectSibling(e.shiftKey ? -1 : 1)) take();
        return;
      }
      if (key === 'a' && mod && !e.altKey && !e.shiftKey) {
        if (selectAllInContext()) take();
      }
    }

    function onKeyUp(e) {
      if (own(NUDGE_KEYS, e.key)) nudge = null;
      if (e.key === 'Alt' && !active && hoverPt) scheduleHover(Object.assign({}, hoverPt, { altKey: false }));
    }

    function onAltDown(e) {
      if (e.key === 'Alt' && !active && hoverPt) scheduleHover(Object.assign({}, hoverPt, { altKey: true }));
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
        updateMeasure(null, null);
        return;
      }
      const pt = point(hoverPt);
      let res = null;
      try { res = tool.hover(ctx, pt); } catch (err) { res = null; }
      setCursor(res && res.cursor ? res.cursor : '');
      setHover(res ? res.hover : null);
      updateMeasure(pt, res ? res.hover : null);
    }

    function onPointerLeave() {
      if (active) return;
      cancelHover();
      setHover(null);
      setCursor('');
      updateMeasure(null, null);
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
    listen(el, 'keydown', onKeyDown);
    listen(win, 'keydown', onAltDown, true);
    listen(win, 'keyup', onKeyUp, true);
    listen(el, 'dragover', onDragOver);
    listen(el, 'dragenter', onDragOver);
    listen(el, 'dragleave', onDragLeave);
    listen(el, 'drop', onDrop);
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

    registerCommands();

    function destroy() {
      if (destroyed) return;
      cancelActive();
      cancelHover();
      clearRepeat();
      clearLongPress();
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      el.style.removeProperty('--apb-cursor');
      if (fileInput) { fileInput.remove(); fileInput = null; }
    }

    return {
      ctx,
      destroy,
      cancel: cancelActive,
      openImagePicker,
      keyboard: { nudge: nudgeSelection, enter: enterSelection, parent: selectParent, sibling: selectSibling, all: selectAllInContext, none: clearSelection },
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

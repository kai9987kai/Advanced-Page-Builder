/* @node-testable */
/*
 * docops — high-level document operations (ARCHITECTURE.md §6.11). Every public operation is ONE
 * labelled store transaction (so one undo step) and accepts the `app` or a `store` as first arg.
 *
 * Coordinates: a node's x/y are relative to its parent's (unrotated) local frame; rotation turns a
 * node around its own center. World (page) placement is computed by composing ancestor frames.
 * Children of stack parents are placed by an approximate flow layout (or by the canvas renderer's
 * worldRect when the first argument is an app with a mounted canvas and the doc is unchanged).
 *
 * Breakpoints: geometric/visibility writes (move, setBox, update, align, distribute, tidy, radial,
 * matchSize, setHidden, fitGroup) default to `store.view.bp` (so edits on a non-base breakpoint
 * become overrides); pass { bp } to force one. Structural ops (insert, remove, duplicate, reparent,
 * group, ungroup, wrap, components) work on base values.
 */
APB.define('docops', ['util', 'geometry', 'schema'], function (util, geometry, schema) {
  'use strict';

  const BOX_KEYS = ['x', 'y', 'w', 'h', 'rotation'];
  const PATCH_BLOCKED = new Set(['id', 'parent', 'children', 'type']);
  const TEXTY = new Set(['text', 'list', 'html', 'table']);
  const ALIGN_LABELS = {
    left: 'Align left', hcenter: 'Align horizontal centers', right: 'Align right',
    top: 'Align top', vcenter: 'Align vertical centers', bottom: 'Align bottom'
  };
  const ZORDER_LABELS = { forward: 'Bring forward', backward: 'Send backward', front: 'Bring to front', back: 'Send to back' };

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, d) => (isNum(v) ? v : d);
  const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);

  function rnd(v) {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
  }

  function near(a, b, eps) {
    return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);
  }

  function rotV(v, deg) {
    return geometry.rotateVector(v, deg || 0);
  }

  function normAngle(deg) {
    return rnd(geometry.normalizeAngle(deg || 0));
  }

  /* ---------------------------------------------------------------- basics */

  function resolve(target) {
    if (target && typeof target.transact === 'function') return { store: target, app: null };
    if (target && target.store && typeof target.store.transact === 'function') return { store: target.store, app: target };
    throw new TypeError('docops: first argument must be the app or a store');
  }

  function baseBpId(doc) {
    const bps = doc.settings && doc.settings.breakpoints;
    return bps && bps.length ? bps[0].id : null;
  }

  /** Breakpoint for geometric writes: explicit opts.bp, else the active view breakpoint. */
  function bpFor(store, opts) {
    if (opts && opts.bp !== undefined) return opts.bp || null;
    return (store.view && store.view.bp) || null;
  }

  function toArray(ids) {
    if (ids === undefined || ids === null) return [];
    return Array.isArray(ids) ? ids : [ids];
  }

  function nodeOf(doc, id) {
    return typeof id === 'string' && has(doc.nodes, id) ? doc.nodes[id] : null;
  }

  function isRoot(doc, id) {
    const n = nodeOf(doc, id);
    return !!n && !n.parent;
  }

  function existing(doc, ids) {
    const seen = new Set();
    const out = [];
    for (const id of toArray(ids)) {
      if (seen.has(id) || !nodeOf(doc, id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /** Existing, non-root ids whose ancestors are not also in the list. */
  function topLevel(doc, ids) {
    const list = existing(doc, ids).filter((id) => !isRoot(doc, id));
    const set = new Set(list);
    return list.filter((id) => !schema.ancestors(doc, id).some((a) => set.has(a)));
  }

  function orderKey(doc, id) {
    const key = [];
    let n = nodeOf(doc, id);
    const seen = new Set();
    while (n && n.parent && !seen.has(n.id)) {
      seen.add(n.id);
      const p = nodeOf(doc, n.parent);
      key.unshift(p && Array.isArray(p.children) ? p.children.indexOf(n.id) : 0);
      n = p;
    }
    const pageIdx = doc.pages.findIndex((pg) => n && pg.root === n.id);
    key.unshift(pageIdx < 0 ? doc.pages.length : pageIdx);
    return key;
  }

  /** Sort ids in document (paint) order. */
  function sortDocOrder(doc, ids) {
    const keys = new Map(ids.map((id) => [id, orderKey(doc, id)]));
    return ids.slice().sort((a, b) => {
      const ka = keys.get(a);
      const kb = keys.get(b);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return ka.length - kb.length;
    });
  }

  function isLocked(doc, id) {
    let n = nodeOf(doc, id);
    const seen = new Set();
    while (n && !seen.has(n.id)) {
      if (n.locked) return true;
      seen.add(n.id);
      n = n.parent ? nodeOf(doc, n.parent) : null;
    }
    return false;
  }

  function isContainerNode(n) {
    return !!n && Array.isArray(n.children);
  }

  function parentIsStack(doc, id, bp) {
    const n = nodeOf(doc, id);
    if (!n || !n.parent) return false;
    const p = schema.effectiveNode(doc, n.parent, bp);
    return !!(p && p.layout && p.layout.mode === 'stack');
  }

  function layerLabel(verb, n) {
    return verb + ' ' + (n === 1 ? 'layer' : util.plural(n, 'layer'));
  }

  function typeLabel(type) {
    if (typeof APB !== 'undefined' && APB.has('elements')) {
      try {
        const def = APB.require('elements').get(type);
        if (def && def.label) return def.label;
      } catch (_) { /* fall through */ }
    }
    const t = String(type || 'layer');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function siblingNames(doc, parentId) {
    const p = nodeOf(doc, parentId);
    return new Set(p && Array.isArray(p.children) ? p.children.map((c) => nodeOf(doc, c)).filter(Boolean).map((c) => c.name) : []);
  }

  function currentPage(doc, store) {
    const view = store.view || {};
    return doc.pages.find((p) => p.id === view.pageId) || doc.pages[0] || null;
  }

  /** Default insertion parent: sections go into the page root; others into the view context or first section. */
  function defaultParent(doc, store, type) {
    const page = currentPage(doc, store);
    const root = page ? page.root : null;
    if (type === 'section') return root;
    const view = store.view || {};
    const ctxNode = nodeOf(doc, view.context);
    if (ctxNode && isContainerNode(ctxNode)) return ctxNode.id;
    const rootNode = nodeOf(doc, root);
    if (rootNode && Array.isArray(rootNode.children)) {
      const sec = rootNode.children.map((c) => nodeOf(doc, c)).find((n) => n && n.type === 'section' && isContainerNode(n));
      if (sec) return sec.id;
    }
    return root;
  }

  /* -------------------------------------------------------------- geometry */

  function domHook(c, doc, bp) {
    const app = c.app;
    const renderer = app && app.canvas && app.canvas.renderer;
    if (!renderer || typeof renderer.worldRect !== 'function') return null;
    if (doc !== c.store.doc) return null;
    const viewBp = (c.store.view && c.store.view.bp) || baseBpId(doc);
    if ((bp || baseBpId(doc)) !== viewBp) return null;
    return (id) => {
      try {
        const r = renderer.worldRect(id);
        return r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) ? r : null;
      } catch (_) {
        return null;
      }
    };
  }

  /**
   * Geometry view of a doc snapshot at a breakpoint (memoized; create a new one after structural
   * changes). World boxes are { cx, cy, w, h, rotation }; frames are { x, y, rot } (origin of a
   * container's local coordinate system in world space).
   */
  function makeGeo(doc, bp, dom) {
    const local = new Map();
    const frames = new Map();
    const eff = (id) => schema.effectiveNode(doc, id, bp);

    function bpWidth() {
      const bps = (doc.settings && doc.settings.breakpoints) || [];
      const b = bps.find((x) => x.id === bp) || bps[0];
      return b ? b.width : 1440;
    }

    function stackPlacement(p, id) {
      const L = p.layout;
      const pad = schema.normalizePad(L.pad);
      const row = L.dir === 'row';
      const pbox = localBox(p.id);
      const innerMain = Math.max(0, row ? pbox.w - pad[1] - pad[3] : pbox.h - pad[0] - pad[2]);
      const innerCross = Math.max(0, row ? pbox.h - pad[0] - pad[2] : pbox.w - pad[1] - pad[3]);
      const kids = (p.children || []).map(eff).filter((k) => k && !k.hidden);
      const gap = num(L.gap, 0);
      const psz = p.sizing || {};
      const hugMain = (row ? psz.w : psz.h) === 'hug';
      const items = kids.map((k) => {
        const sz = k.sizing || {};
        const mainMode = row ? sz.w : sz.h;
        const crossMode = row ? sz.h : sz.w;
        let main = num(row ? k.w : k.h, 0);
        let cross = num(row ? k.h : k.w, 0);
        if (k.type === 'page' && !row) cross = bpWidth();
        if (crossMode === 'fill' || (L.align === 'stretch' && crossMode === 'hug')) cross = innerCross;
        return { id: k.id, main, cross, fill: mainMode === 'fill' && !hugMain };
      });
      const fills = items.filter((it) => it.fill);
      const fixedTotal = items.filter((it) => !it.fill).reduce((s, it) => s + it.main, 0) + gap * Math.max(0, items.length - 1);
      if (fills.length) {
        const each = Math.max(0, (innerMain - fixedTotal) / fills.length);
        fills.forEach((it) => { it.main = each; });
      }
      const total = items.reduce((s, it) => s + it.main, 0) + gap * Math.max(0, items.length - 1);
      const free = hugMain ? 0 : innerMain - total;
      let offset = 0;
      let spacing = gap;
      if (free > 0 && !fills.length) {
        if (L.justify === 'center') offset = free / 2;
        else if (L.justify === 'end') offset = free;
        else if (L.justify === 'between' && items.length > 1) spacing = gap + free / (items.length - 1);
        else if (L.justify === 'around' && items.length) { const extra = free / items.length; offset = extra / 2; spacing = gap + extra; }
      }
      const mainStart = row ? pad[3] : pad[0];
      const crossStart = row ? pad[0] : pad[3];
      let acc = mainStart + offset;
      for (const it of items) {
        if (it.id === id) {
          let crossPos = crossStart;
          if (L.align === 'center') crossPos += (innerCross - it.cross) / 2;
          else if (L.align === 'end') crossPos += innerCross - it.cross;
          return row ? { x: acc, y: crossPos, w: it.main, h: it.cross } : { x: crossPos, y: acc, w: it.cross, h: it.main };
        }
        acc += it.main + spacing;
      }
      const n = eff(id);
      return { x: row ? mainStart : crossStart, y: row ? crossStart : mainStart, w: num(n && n.w, 0), h: num(n && n.h, 0) };
    }

    /** Node box in its parent's local frame: { x, y, w, h, rotation }. */
    function localBox(id) {
      if (local.has(id)) return local.get(id);
      const n = eff(id);
      let box;
      if (!n) {
        box = { x: 0, y: 0, w: 0, h: 0, rotation: 0 };
      } else {
        const p = n.parent ? eff(n.parent) : null;
        const w = n.type === 'page' ? bpWidth() : num(n.w, 0);
        box = { x: num(n.x, 0), y: num(n.y, 0), w, h: num(n.h, 0), rotation: num(n.rotation, 0) };
        if (!p) {
          if (n.type === 'page') { box.x = 0; box.y = 0; }
        } else if (p.layout && p.layout.mode === 'stack') {
          local.set(id, box); // provisional (guards against cycles)
          const r = dom ? dom(id) : null;
          if (r) {
            const F = frame(p.id);
            const lc = rotV({ x: r.x + r.w / 2 - F.x, y: r.y + r.h / 2 - F.y }, -F.rot);
            box = { x: lc.x - r.w / 2, y: lc.y - r.h / 2, w: r.w, h: r.h, rotation: 0 };
          } else {
            const s = stackPlacement(p, id);
            box = { x: s.x, y: s.y, w: s.w, h: s.h, rotation: num(n.rotation, 0) };
          }
        } else {
          const sz = n.sizing || {};
          if (sz.w === 'fill') { const pb = localBox(p.id); box.x = 0; box.w = pb.w; }
          if (sz.h === 'fill') { const pb = localBox(p.id); box.y = 0; box.h = pb.h; }
        }
      }
      local.set(id, box);
      return box;
    }

    /** World box of a node. */
    function world(id) {
      const n = nodeOf(doc, id);
      const lb = localBox(id);
      const F = n && n.parent ? frame(n.parent) : { x: 0, y: 0, rot: 0 };
      const c = rotV({ x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 }, F.rot);
      return { cx: F.x + c.x, cy: F.y + c.y, w: lb.w, h: lb.h, rotation: F.rot + lb.rotation };
    }

    /** Frame (origin + rotation) of a container's local coordinate system in world space. */
    function frame(id) {
      if (!id) return { x: 0, y: 0, rot: 0 };
      if (frames.has(id)) return frames.get(id);
      frames.set(id, { x: 0, y: 0, rot: 0 }); // provisional (cycle guard)
      const wb = world(id);
      const o = rotV({ x: -wb.w / 2, y: -wb.h / 2 }, wb.rotation);
      const f = { x: wb.cx + o.x, y: wb.cy + o.y, rot: wb.rotation };
      frames.set(id, f);
      return f;
    }

    function worldAABB(id) {
      const wb = world(id);
      return geometry.aabb(geometry.corners({ x: wb.cx - wb.w / 2, y: wb.cy - wb.h / 2, w: wb.w, h: wb.h }, wb.rotation));
    }

    /** AABB of a node inside its parent's local frame. */
    function parentAABB(id) {
      const lb = localBox(id);
      return geometry.aabb(geometry.corners(lb, lb.rotation));
    }

    return { eff, localBox, world, frame, worldAABB, parentAABB, bpWidth };
  }

  /** World box → local { x, y, w, h, rotation } in a frame. */
  function localFromWorld(F, wb) {
    const lc = rotV({ x: wb.cx - F.x, y: wb.cy - F.y }, -F.rot);
    return { x: lc.x - wb.w / 2, y: lc.y - wb.h / 2, w: wb.w, h: wb.h, rotation: normAngle(wb.rotation - F.rot) };
  }

  /* ------------------------------------------------------- tx-level helpers */

  function shiftBpOverrides(tx, id, dx, dy) {
    const n = tx.node(id);
    if (!n || !util.isPlainObject(n.bp)) return;
    for (const bpId of Object.keys(n.bp)) {
      const o = n.bp[bpId];
      if (!util.isPlainObject(o)) continue;
      if (isNum(o.x) && dx) tx.set(['nodes', id, 'bp', bpId, 'x'], rnd(o.x + dx));
      if (isNum(o.y) && dy) tx.set(['nodes', id, 'bp', bpId, 'y'], rnd(o.y + dy));
    }
  }

  /** Clear the style a type's defaults may have added (wrappers must not change visuals). */
  function clearStyle(tx, id) {
    const n = tx.node(id);
    if (n && util.isPlainObject(n.style) && Object.keys(n.style).length) tx.set(['nodes', id, 'style'], {});
  }

  function fitGroupTx(tx, gid, bp) {
    const d = tx.doc;
    const g = schema.effectiveNode(d, gid, bp);
    if (!g || !Array.isArray(g.children) || !g.children.length) return false;
    const kids = g.children.map((id) => schema.effectiveNode(d, id, bp)).filter(Boolean);
    if (!kids.length) return false;
    const B = geometry.aabb(kids.map((k) => geometry.aabb(geometry.corners({ x: k.x, y: k.y, w: k.w, h: k.h }, k.rotation || 0))));
    const bx = rnd(B.x);
    const by = rnd(B.y);
    const bw = rnd(B.w);
    const bh = rnd(B.h);
    if (near(bx, 0, 1e-3) && near(by, 0, 1e-3) && near(bw, g.w, 1e-3) && near(bh, g.h, 1e-3)) return false;
    const rot = g.rotation || 0;
    const v = rotV({ x: B.x + B.w / 2 - g.w / 2, y: B.y + B.h / 2 - g.h / 2 }, rot);
    const nc = { x: g.x + g.w / 2 + v.x, y: g.y + g.h / 2 + v.y };
    tx.updateNode(gid, { x: rnd(nc.x - B.w / 2), y: rnd(nc.y - B.h / 2), w: bw, h: bh }, { bp });
    if (!near(B.x, 0, 1e-9) || !near(B.y, 0, 1e-9)) {
      for (const k of kids) tx.updateNode(k.id, { x: rnd(k.x - B.x), y: rnd(k.y - B.y) }, { bp });
    }
    return true;
  }

  function depthOf(doc, id) {
    return schema.ancestors(doc, id).length;
  }

  /** Refit every group ancestor of ids (deepest first). */
  function refitGroups(tx, ids, bp) {
    const d = tx.doc;
    const groups = new Set();
    for (const id of toArray(ids)) {
      let n = nodeOf(d, id);
      while (n && n.parent) {
        const p = nodeOf(d, n.parent);
        if (!p || p.type !== 'group') break;
        groups.add(p.id);
        n = p;
      }
    }
    const list = Array.from(groups).sort((a, b) => depthOf(d, b) - depthOf(d, a));
    for (const gid of list) if (nodeOf(tx.doc, gid)) fitGroupTx(tx, gid, bp);
  }

  /** Remove groups left empty (walking up) and refit the others. `parents` are container ids. */
  function cleanupContainers(tx, parents) {
    const toFit = [];
    for (const pid of parents) {
      let id = pid;
      while (id) {
        const n = tx.node(id);
        if (!n || n.type !== 'group') break;
        if (n.children && n.children.length) { toFit.push(id); break; }
        const up = n.parent;
        tx.removeNode(id);
        id = up;
      }
    }
    const d = tx.doc;
    toFit.filter((id) => nodeOf(d, id)).sort((a, b) => depthOf(d, b) - depthOf(d, a)).forEach((id) => {
      fitGroupTx(tx, id, null);
      refitGroups(tx, [id], null);
    });
  }

  /** Scale the children of a group (recursively through nested groups). */
  function scaleGroupChildren(tx, gid, sx, sy, bp) {
    const g = schema.effectiveNode(tx.doc, gid, bp);
    if (!g || !Array.isArray(g.children)) return;
    for (const cid of g.children) {
      const c = schema.effectiveNode(tx.doc, cid, bp);
      if (!c) continue;
      tx.updateNode(cid, { x: rnd(c.x * sx), y: rnd(c.y * sy), w: rnd(Math.max(0, c.w * sx)), h: rnd(Math.max(0, c.h * sy)) }, { bp });
      if (c.type === 'group') scaleGroupChildren(tx, cid, sx, sy, bp);
    }
  }

  /** Apply a box patch (group children scale with the group). */
  function applyBox(tx, id, patch, bp) {
    const n = schema.effectiveNode(tx.doc, id, bp);
    if (!n) return;
    if (n.type === 'group' && (has(patch, 'w') || has(patch, 'h'))) {
      const sx = has(patch, 'w') && n.w > 0 ? patch.w / n.w : 1;
      const sy = has(patch, 'h') && n.h > 0 ? patch.h / n.h : 1;
      if (sx !== 1 || sy !== 1) scaleGroupChildren(tx, id, sx, sy, bp);
    }
    tx.updateNode(id, patch, { bp });
  }

  function boxPatch(box, current) {
    const patch = {};
    if (!box) return patch;
    for (const k of BOX_KEYS) {
      if (!isNum(box[k])) continue;
      let v = k === 'rotation' ? normAngle(box[k]) : rnd(box[k]);
      if ((k === 'w' || k === 'h') && v < 0) v = 0;
      if (current && near(num(current[k], 0), v, 1e-9)) continue;
      patch[k] = v;
    }
    return patch;
  }

  /** Move a node by a world delta. */
  function moveByWorld(tx, geo, id, dx, dy, bp) {
    if (!dx && !dy) return;
    const n = geo.eff(id);
    const F = geo.frame(n.parent);
    const v = rotV({ x: dx, y: dy }, -F.rot);
    if (near(v.x, 0, 1e-9) && near(v.y, 0, 1e-9)) return;
    tx.updateNode(id, { x: rnd(n.x + v.x), y: rnd(n.y + v.y) }, { bp });
  }

  function movableIds(doc, ids, bp) {
    return topLevel(doc, ids).filter((id) => !isLocked(doc, id) && !parentIsStack(doc, id, bp));
  }

  /** Detach ids from their parents and append them (in order) to parentId at index (base without them). */
  function relink(tx, ids, parentId, index) {
    const set = new Set(ids);
    for (const id of ids) {
      const n = tx.node(id);
      if (n.parent === parentId) continue;
      const old = n.parent ? tx.node(n.parent) : null;
      if (old && Array.isArray(old.children) && old.children.includes(id)) {
        tx.set(['nodes', old.id, 'children'], old.children.filter((c) => c !== id));
      }
      tx.set(['nodes', id, 'parent'], parentId);
    }
    const kids = tx.node(parentId).children;
    const base = kids.filter((c) => !set.has(c));
    const at = index === undefined || index === null ? base.length : util.clamp(Math.round(index), 0, base.length);
    const next = base.slice(0, at).concat(ids, base.slice(at));
    if (!util.deepEqual(next, kids)) tx.set(['nodes', parentId, 'children'], next);
  }

  function readingOrder(items, boxOf) {
    const sorted = items.slice().sort((a, b) => boxOf(a).y - boxOf(b).y || boxOf(a).x - boxOf(b).x);
    const rows = [];
    for (const it of sorted) {
      const b = boxOf(it);
      const row = rows[rows.length - 1];
      if (row && b.y < row.ref.y + row.ref.h / 2) row.items.push(it);
      else rows.push({ ref: b, items: [it] });
    }
    return rows.map((r) => r.items.sort((a, b) => boxOf(a).x - boxOf(b).x || boxOf(a).y - boxOf(b).y));
  }

  /* ----------------------------------------------------------------- insert */

  function createSpec(tx, spec, parentId, index, shift) {
    const init = Object.assign({}, spec);
    delete init.children;
    delete init.parent;
    if (!init.type) init.type = 'frame';
    if (shift) {
      init.x = rnd(num(init.x, 0) + shift.x);
      init.y = rnd(num(init.y, 0) + shift.y);
    }
    const id = tx.createNode(init, parentId, index);
    const node = tx.node(id);
    if (Array.isArray(spec.children) && Array.isArray(node.children)) {
      for (const child of spec.children) if (util.isPlainObject(child)) createSpec(tx, child, id, undefined, null);
      if (node.type === 'group' && !isNum(spec.w) && !isNum(spec.h)) fitGroupTx(tx, id, null);
    }
    return id;
  }

  /**
   * insert(target, specs, { parent, index, at: {x,y}, anchor: 'topleft'|'center', select = true, label }) → ids
   * `at` places the union bounds of the top-level specs (top-left, or center with anchor 'center')
   * in the parent's local coordinates.
   */
  function insert(target, specs, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const list = toArray(specs).filter(util.isPlainObject);
    if (!list.length) return [];
    const doc = store.doc;
    const parentId = o.parent || defaultParent(doc, store, list[0].type);
    const parent = nodeOf(doc, parentId);
    if (!isContainerNode(parent)) throw new Error('docops.insert: parent "' + parentId + '" is not a container');
    let shift = null;
    if (o.at && isNum(o.at.x) && isNum(o.at.y)) {
      const rects = list.map((s) => {
        const probe = schema.createNode(s.type || 'frame', util.omit(s, ['children', 'parent', 'id']));
        return geometry.aabb(geometry.corners({ x: probe.x, y: probe.y, w: probe.w, h: probe.h }, probe.rotation || 0));
      });
      const B = geometry.union(rects);
      shift = o.anchor === 'center'
        ? { x: o.at.x - (B.x + B.w / 2), y: o.at.y - (B.y + B.h / 2) }
        : { x: o.at.x - B.x, y: o.at.y - B.y };
    }
    const label = o.label || (list.length === 1 ? 'Insert ' + typeLabel(list[0].type || 'frame') : 'Insert ' + util.plural(list.length, 'layer'));
    return store.transact(label, (tx) => {
      const ids = [];
      let index = isNum(o.index) ? o.index : undefined;
      for (const spec of list) {
        ids.push(createSpec(tx, spec, parentId, index, shift));
        if (index !== undefined) index++;
      }
      refitGroups(tx, ids, null);
      if (o.select !== false) tx.select(ids);
      return ids;
    });
  }

  /* ---------------------------------------------------------- remove / dup */

  function remove(target, ids) {
    const { store } = resolve(target);
    const doc = store.doc;
    const list = topLevel(doc, ids);
    if (!list.length) return 0;
    return store.transact(layerLabel('Delete', list.length), (tx) => {
      const parents = new Set(list.map((id) => doc.nodes[id].parent));
      list.forEach((id) => tx.removeNode(id));
      cleanupContainers(tx, parents);
      return list.length;
    });
  }

  function duplicate(target, ids, opts) {
    const o = opts || {};
    const offset = o.offset === undefined ? 16 : num(Number(o.offset), 0);
    const { store } = resolve(target);
    const doc = store.doc;
    const list = sortDocOrder(doc, topLevel(doc, ids));
    if (!list.length) return [];
    return store.transact(layerLabel('Duplicate', list.length), (tx) => {
      const out = [];
      for (const id of list) {
        const d = tx.doc;
        const orig = d.nodes[id];
        const parent = d.nodes[orig.parent];
        const { nodes, idMap } = schema.reid(d.nodes, [id]);
        const newId = idMap[id];
        const copy = nodes[newId];
        const free = !(parent.layout && parent.layout.mode === 'stack');
        if (free && offset) {
          copy.x = rnd(copy.x + offset);
          copy.y = rnd(copy.y + offset);
          if (util.isPlainObject(copy.bp)) {
            for (const k of Object.keys(copy.bp)) {
              const ov = copy.bp[k];
              if (!util.isPlainObject(ov)) continue;
              if (isNum(ov.x)) ov.x = rnd(ov.x + offset);
              if (isNum(ov.y)) ov.y = rnd(ov.y + offset);
            }
          }
        }
        for (const nid of Object.keys(nodes)) tx.set(['nodes', nid], nodes[nid]);
        const kids = tx.node(parent.id).children.slice();
        kids.splice(kids.indexOf(id) + 1, 0, newId);
        tx.set(['nodes', parent.id, 'children'], kids);
        out.push(newId);
      }
      refitGroups(tx, out, null);
      tx.select(out);
      return out;
    });
  }

  /* ------------------------------------------------------------- move / box */

  function move(target, ids, dx, dy, opts) {
    const o = opts || {};
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const bp = bpFor(store, o);
    const ddx = num(Number(dx), 0);
    const ddy = num(Number(dy), 0);
    const list = movableIds(doc, ids, bp);
    if (!list.length || (!ddx && !ddy)) return [];
    const geo = makeGeo(doc, bp, null);
    return store.transact(o.label || layerLabel('Move', list.length), (tx) => {
      for (const id of list) moveByWorld(tx, geo, id, ddx, ddy, bp);
      refitGroups(tx, list, bp);
      return list;
    }, { coalesce: o.coalesce });
  }

  function setBox(target, id, box, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const n = nodeOf(doc, id);
    if (!n || isLocked(doc, id)) return false;
    const patch = boxPatch(box, schema.effectiveNode(doc, id, bp));
    const keys = Object.keys(patch);
    if (!keys.length) return false;
    let label = 'Resize';
    if (keys.every((k) => k === 'rotation')) label = 'Rotate';
    else if (keys.every((k) => k === 'x' || k === 'y')) label = 'Move';
    return store.transact(o.label || label, (tx) => {
      applyBox(tx, id, patch, bp);
      refitGroups(tx, [id], bp);
      return true;
    }, { coalesce: o.coalesce });
  }

  /** Expand dotted keys ('style.fill') into nested patches for one node. */
  function patchForNode(node, patch) {
    const out = {};
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      const parts = key.split('.');
      const top = parts[0];
      if (PATCH_BLOCKED.has(top) || !schema.NODE_KEYS.includes(top)) continue;
      if (parts.length === 1) {
        if (util.isPlainObject(value) && util.isPlainObject(out[top])) out[top] = Object.assign({}, out[top], value);
        else out[top] = value;
        continue;
      }
      const container = util.isPlainObject(out[top]) ? out[top] : {};
      const sub = parts[1];
      if (parts.length === 2) {
        container[sub] = value;
      } else {
        const currentSub = container[sub] !== undefined ? container[sub] : util.getPath(node, [top, sub]);
        container[sub] = util.setPathImmutable(util.isPlainObject(currentSub) ? currentSub : {}, parts.slice(2), value);
      }
      out[top] = container;
    }
    return out;
  }

  function update(target, ids, patch, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const list = existing(doc, ids);
    if (!list.length || !util.isPlainObject(patch)) return [];
    const label = o.label || (list.length === 1 ? 'Edit layer' : 'Edit ' + util.plural(list.length, 'layer'));
    return store.transact(label, (tx) => {
      let boxChanged = false;
      for (const id of list) {
        const p = patchForNode(tx.node(id), patch);
        if (!Object.keys(p).length) continue;
        if (BOX_KEYS.some((k) => has(p, k))) {
          boxChanged = true;
          const box = {};
          const rest = {};
          for (const k of Object.keys(p)) (BOX_KEYS.includes(k) ? box : rest)[k] = p[k];
          if (Object.keys(rest).length) tx.updateNode(id, rest, { bp });
          applyBox(tx, id, box, bp);
        } else {
          tx.updateNode(id, p, { bp });
        }
      }
      if (boxChanged) refitGroups(tx, list, bp);
      return list;
    }, { coalesce: o.coalesce });
  }

  /* --------------------------------------------------------------- reparent */

  function reparent(target, ids, parentId, index) {
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const parent = nodeOf(doc, parentId);
    if (!isContainerNode(parent)) return [];
    const blocked = new Set([parentId].concat(schema.ancestors(doc, parentId)));
    const list = sortDocOrder(doc, topLevel(doc, ids)).filter((id) => !blocked.has(id));
    if (!list.length) return [];
    const geo = makeGeo(doc, null, domHook(c, doc, null));
    const worlds = new Map(list.map((id) => [id, geo.world(id)]));
    const label = layerLabel('Move', list.length) + ' into ' + (parent.name || typeLabel(parent.type));
    return store.transact(label, (tx) => {
      const oldParents = new Set(list.map((id) => doc.nodes[id].parent));
      const changed = list.filter((id) => doc.nodes[id].parent !== parentId);
      relink(tx, list, parentId, index);
      const targetStack = parent.layout && parent.layout.mode === 'stack';
      if (changed.length && !targetStack) {
        const geo2 = makeGeo(tx.doc, null, null);
        const F = geo2.frame(parentId);
        for (const id of changed) {
          const n = tx.node(id);
          const wb = worlds.get(id);
          const l = localFromWorld(F, wb);
          const patch = { x: rnd(l.x), y: rnd(l.y), rotation: l.rotation };
          const sz = n.sizing || {};
          if (sz.w === 'fill' || sz.h === 'fill') {
            patch.sizing = { w: sz.w === 'fill' ? 'fixed' : sz.w, h: sz.h === 'fill' ? 'fixed' : sz.h };
            patch.w = rnd(wb.w);
            patch.h = rnd(wb.h);
          }
          const prev = doc.nodes[id];
          tx.updateNode(id, patch);
          if (!(prev.rotation || 0) && !l.rotation && !parentIsStack(doc, id, null)) shiftBpOverrides(tx, id, rnd(l.x - prev.x), rnd(l.y - prev.y));
        }
      }
      oldParents.delete(parentId);
      cleanupContainers(tx, oldParents);
      refitGroups(tx, list, null);
      return list;
    });
  }

  /* ------------------------------------------------------ group / ungroup */

  /**
   * Wrap `list` (doc order, top-level) in a new container placed where the topmost item was.
   * Returns { id, bounds }. Children keep their world placement.
   */
  function enclose(tx, c, list, init, orderFn) {
    const doc = tx.doc;
    const top = list[list.length - 1];
    const parentId = doc.nodes[top].parent;
    const geo = makeGeo(doc, null, domHook(c, doc, null));
    const worlds = new Map(list.map((id) => [id, geo.world(id)]));
    const sameParent = new Set(list.filter((id) => doc.nodes[id].parent === parentId));
    const parent = tx.node(parentId);
    const idx = parent.children.indexOf(top);
    const cid = tx.createNode(Object.assign({ x: 0, y: 0, w: 1, h: 1, rotation: 0 }, init), parentId, idx + 1);
    clearStyle(tx, cid);
    const ordered = orderFn ? orderFn(list, worlds) : list;
    relink(tx, ordered, cid, 0);
    const oldParents = new Set(list.map((id) => doc.nodes[id].parent));
    oldParents.delete(parentId);
    const geo2 = makeGeo(tx.doc, null, null);
    const F = geo2.frame(parentId);
    const locals = new Map(list.map((id) => [id, localFromWorld(F, worlds.get(id))]));
    const B = geometry.aabb(list.map((id) => { const l = locals.get(id); return geometry.aabb(geometry.corners(l, l.rotation)); }));
    const bx = rnd(B.x);
    const by = rnd(B.y);
    tx.updateNode(cid, { x: bx, y: by, w: rnd(B.w), h: rnd(B.h) });
    for (const id of list) {
      const l = locals.get(id);
      const prev = doc.nodes[id];
      const patch = { x: rnd(l.x - bx), y: rnd(l.y - by), rotation: l.rotation };
      const sz = prev.sizing || {};
      if (sz.w === 'fill' || sz.h === 'fill') {
        patch.sizing = { w: sz.w === 'fill' ? 'fixed' : sz.w, h: sz.h === 'fill' ? 'fixed' : sz.h };
        patch.w = rnd(l.w);
        patch.h = rnd(l.h);
      }
      tx.updateNode(id, patch);
      if (sameParent.has(id) && !parentIsStack(doc, id, null)) shiftBpOverrides(tx, id, -bx, -by);
    }
    cleanupContainers(tx, oldParents);
    return { id: cid, parentId, bounds: { x: bx, y: by, w: rnd(B.w), h: rnd(B.h) } };
  }

  function group(target, ids, opts) {
    const o = opts || {};
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const list = sortDocOrder(doc, topLevel(doc, ids));
    if (!list.length) return null;
    const parentId = doc.nodes[list[list.length - 1]].parent;
    return store.transact('Group', (tx) => {
      const name = o.name || util.nextName('Group', siblingNames(doc, parentId));
      const res = enclose(tx, c, list, { type: 'group', name, layout: { mode: 'free' } });
      refitGroups(tx, [res.id], null);
      tx.select([res.id]);
      return res.id;
    });
  }

  function ungroup(target, idOrIds) {
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const gids = existing(doc, idOrIds).filter((id) => {
      const n = doc.nodes[id];
      return isContainerNode(n) && n.parent && n.type !== 'page' && n.type !== 'section';
    });
    if (!gids.length) return [];
    return store.transact(gids.length === 1 ? 'Ungroup' : 'Ungroup ' + gids.length, (tx) => {
      const out = [];
      for (const gid of gids) {
        const g = tx.node(gid);
        if (!g) continue;
        const parentId = g.parent;
        const kids = g.children.slice();
        const geo = makeGeo(tx.doc, null, domHook(c, tx.doc, null));
        const worlds = kids.map((k) => geo.world(k));
        const gOpacity = num(g.style && g.style.opacity, 1);
        const p = tx.node(parentId);
        const idx = p.children.indexOf(gid);
        tx.set(['nodes', parentId, 'children'], p.children.slice(0, idx).concat(kids, p.children.slice(idx + 1)));
        kids.forEach((k) => tx.set(['nodes', k, 'parent'], parentId));
        tx.set(['nodes', gid, 'children'], []);
        tx.removeNode(gid);
        const parentStack = !!(p.layout && p.layout.mode === 'stack');
        const geo2 = makeGeo(tx.doc, null, null);
        const F = geo2.frame(parentId);
        kids.forEach((k, i) => {
          const child = tx.node(k);
          const patch = {};
          if (!parentStack) {
            const l = localFromWorld(F, worlds[i]);
            patch.x = rnd(l.x);
            patch.y = rnd(l.y);
            patch.rotation = l.rotation;
            if (!(g.rotation || 0)) shiftBpOverrides(tx, k, g.x, g.y);
          }
          if (gOpacity !== 1) patch.style = { opacity: rnd(num(child.style && child.style.opacity, 1) * gOpacity) };
          if (Object.keys(patch).length) tx.updateNode(k, patch);
        });
        out.push.apply(out, kids);
        refitGroups(tx, kids, null);
      }
      tx.select(out);
      return out;
    });
  }

  /**
   * wrap(target, ids, { layout: 'free'|'stack'|{ mode, dir, gap, … }, name }) → frame id.
   * Stack wraps order children along the detected (or given) direction and hug their content.
   */
  function wrap(target, ids, opts) {
    const o = opts || {};
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const list = sortDocOrder(doc, topLevel(doc, ids));
    if (!list.length) return null;
    const lo = typeof o.layout === 'string' ? { mode: o.layout } : (util.isPlainObject(o.layout) ? Object.assign({}, o.layout) : { mode: 'free' });
    const mode = lo.mode === 'stack' ? 'stack' : 'free';
    const parentId = doc.nodes[list[list.length - 1]].parent;
    return store.transact(mode === 'stack' ? 'Wrap in stack' : 'Wrap in frame', (tx) => {
      const name = o.name || util.nextName(mode === 'stack' ? 'Stack' : 'Frame', siblingNames(doc, parentId));
      let layout = { mode: 'free' };
      let orderFn = null;
      if (mode === 'stack') {
        const geo = makeGeo(doc, null, domHook(c, doc, null));
        const boxes = list.map((id) => geo.worldAABB(id));
        const U = geometry.union(boxes);
        const maxW = Math.max.apply(null, boxes.map((b) => b.w));
        const maxH = Math.max.apply(null, boxes.map((b) => b.h));
        const dir = lo.dir === 'row' || lo.dir === 'column' ? lo.dir : (U.w - maxW > U.h - maxH ? 'row' : 'column');
        const byId = new Map(list.map((id, i) => [id, boxes[i]]));
        const sorted = list.slice().sort((a, b) => (dir === 'row' ? byId.get(a).x - byId.get(b).x : byId.get(a).y - byId.get(b).y));
        let gap = lo.gap;
        if (!isNum(gap)) {
          const gaps = [];
          for (let i = 1; i < sorted.length; i++) {
            const pa = byId.get(sorted[i - 1]);
            const pb = byId.get(sorted[i]);
            gaps.push(dir === 'row' ? pb.x - (pa.x + pa.w) : pb.y - (pa.y + pa.h));
          }
          gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length)) : 16;
        }
        layout = Object.assign({}, lo, { mode: 'stack', dir, gap });
        orderFn = () => sorted;
      } else {
        layout = Object.assign({}, lo, { mode: 'free' });
      }
      const res = enclose(tx, c, list, { type: 'frame', name, layout }, orderFn);
      if (mode === 'stack') tx.updateNode(res.id, { sizing: { w: 'hug', h: 'hug' } });
      refitGroups(tx, [res.id], null);
      tx.select([res.id]);
      return res.id;
    });
  }

  /* ------------------------------------------------------ align & friends */

  function align(target, ids, edge, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    if (!ALIGN_LABELS[edge]) throw new Error('docops.align: unknown edge "' + edge + '"');
    const all = topLevel(doc, ids);
    const list = all.filter((id) => !isLocked(doc, id) && !parentIsStack(doc, id, bp));
    if (!list.length) return [];
    const to = o.to || (all.length === 1 ? 'parent' : 'selection');
    const geo = makeGeo(doc, bp, null);
    const selBounds = geometry.union(all.map((id) => geo.worldAABB(id)));
    const deltaFor = (b, ref) => {
      switch (edge) {
        case 'left': return { x: ref.x - b.x, y: 0 };
        case 'right': return { x: ref.x + ref.w - (b.x + b.w), y: 0 };
        case 'hcenter': return { x: ref.x + ref.w / 2 - (b.x + b.w / 2), y: 0 };
        case 'top': return { x: 0, y: ref.y - b.y };
        case 'bottom': return { x: 0, y: ref.y + ref.h - (b.y + b.h) };
        default: return { x: 0, y: ref.y + ref.h / 2 - (b.y + b.h / 2) };
      }
    };
    return store.transact(ALIGN_LABELS[edge], (tx) => {
      for (const id of list) {
        const n = geo.eff(id);
        if (to === 'parent') {
          const pb = geo.localBox(n.parent);
          const d = deltaFor(geo.parentAABB(id), { x: 0, y: 0, w: pb.w, h: pb.h });
          if (!near(d.x, 0, 1e-9) || !near(d.y, 0, 1e-9)) tx.updateNode(id, { x: rnd(n.x + d.x), y: rnd(n.y + d.y) }, { bp });
        } else {
          const d = deltaFor(geo.worldAABB(id), selBounds);
          moveByWorld(tx, geo, id, d.x, d.y, bp);
        }
      }
      refitGroups(tx, list, bp);
      return list;
    });
  }

  function distribute(target, ids, axis, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const horizontal = axis === 'h' || axis === 'x' || axis === 'horizontal';
    const mode = o.mode === 'center' ? 'center' : 'gap';
    const list = movableIds(doc, ids, bp);
    if (list.length < 3) return [];
    const geo = makeGeo(doc, bp, null);
    const P = horizontal ? 'x' : 'y';
    const S = horizontal ? 'w' : 'h';
    const items = list.map((id) => ({ id, b: geo.worldAABB(id) }));
    return store.transact(horizontal ? 'Distribute horizontally' : 'Distribute vertically', (tx) => {
      if (mode === 'center') {
        items.sort((a, b) => (a.b[P] + a.b[S] / 2) - (b.b[P] + b.b[S] / 2));
        const c0 = items[0].b[P] + items[0].b[S] / 2;
        const cn = items[items.length - 1].b[P] + items[items.length - 1].b[S] / 2;
        const step = (cn - c0) / (items.length - 1);
        items.forEach((it, i) => {
          const d = c0 + step * i - (it.b[P] + it.b[S] / 2);
          moveByWorld(tx, geo, it.id, horizontal ? d : 0, horizontal ? 0 : d, bp);
        });
      } else {
        items.sort((a, b) => a.b[P] - b.b[P] || (a.b[P] + a.b[S]) - (b.b[P] + b.b[S]));
        const start = items[0].b[P];
        const end = Math.max.apply(null, items.map((it) => it.b[P] + it.b[S]));
        const sizes = items.reduce((s, it) => s + it.b[S], 0);
        const gap = (end - start - sizes) / (items.length - 1);
        let pos = start;
        items.forEach((it) => {
          const d = pos - it.b[P];
          moveByWorld(tx, geo, it.id, horizontal ? d : 0, horizontal ? 0 : d, bp);
          pos += it.b[S] + gap;
        });
      }
      refitGroups(tx, list, bp);
      return list;
    });
  }

  function tidy(target, ids, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const list = movableIds(doc, ids, bp);
    if (list.length < 2) return [];
    const geo = makeGeo(doc, bp, null);
    const boxes = new Map(list.map((id) => [id, geo.worldAABB(id)]));
    const rows = readingOrder(list, (id) => boxes.get(id));
    const n = list.length;
    let cols = isNum(o.columns) && o.columns >= 1 ? Math.round(o.columns) : 0;
    if (!cols) {
      cols = rows.length > 1 && rows[0].length > 1 && rows.every((r) => r.length <= rows[0].length)
        ? rows[0].length
        : Math.ceil(Math.sqrt(n));
    }
    const ordered = [].concat.apply([], rows);
    const gapX = isNum(o.gap) ? o.gap : (isNum(o.gapX) ? o.gapX : 16);
    const gapY = isNum(o.gapY) ? o.gapY : gapX;
    const U = geometry.union(Array.from(boxes.values()));
    const rowCount = Math.ceil(n / cols);
    const colW = new Array(cols).fill(0);
    const rowH = new Array(rowCount).fill(0);
    ordered.forEach((id, i) => {
      const b = boxes.get(id);
      colW[i % cols] = Math.max(colW[i % cols], b.w);
      rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], b.h);
    });
    return store.transact('Tidy up', (tx) => {
      ordered.forEach((id, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        let x = U.x;
        for (let k = 0; k < col; k++) x += colW[k] + gapX;
        let y = U.y;
        for (let k = 0; k < row; k++) y += rowH[k] + gapY;
        const b = boxes.get(id);
        moveByWorld(tx, geo, id, x - b.x, y - b.y, bp);
      });
      refitGroups(tx, list, bp);
      return ordered;
    });
  }

  /**
   * radial(target, ids, { radius, startAngle = -90, sweep = 360, cx, cy, rotateItems }) → ids
   * Places item CENTERS on a circle in the order given. Angles in degrees, 0 = +x, clockwise.
   * cx/cy are in the first item's parent coordinates (default: selection bounds center).
   * rotateItems: true|'tangent' → rotation = angle + 90 (item top faces outward); 'radial' → angle.
   */
  function radial(target, ids, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const list = movableIds(doc, ids, bp);
    if (!list.length) return [];
    const geo = makeGeo(doc, bp, null);
    const worlds = new Map(list.map((id) => [id, geo.world(id)]));
    const U = geometry.union(list.map((id) => geo.worldAABB(id)));
    const F0 = geo.frame(doc.nodes[list[0]].parent);
    let C = { x: U.x + U.w / 2, y: U.y + U.h / 2 };
    if (isNum(o.cx) || isNum(o.cy)) {
      const localC = rotV({ x: C.x - F0.x, y: C.y - F0.y }, -F0.rot);
      const lc = { x: isNum(o.cx) ? o.cx : localC.x, y: isNum(o.cy) ? o.cy : localC.y };
      const wc = rotV(lc, F0.rot);
      C = { x: F0.x + wc.x, y: F0.y + wc.y };
    }
    const radius = isNum(o.radius) ? Math.max(0, o.radius) : Math.max(U.w, U.h) / 2;
    const start = isNum(o.startAngle) ? o.startAngle : -90;
    const sweep = isNum(o.sweep) ? util.clamp(o.sweep, -360, 360) : 360;
    const n = list.length;
    const full = Math.abs(sweep) >= 360;
    const step = n <= 1 ? 0 : (full ? sweep / n : sweep / (n - 1));
    const rotMode = o.rotateItems === true ? 'tangent' : (o.rotateItems === 'tangent' || o.rotateItems === 'radial' ? o.rotateItems : null);
    return store.transact('Arrange in circle', (tx) => {
      list.forEach((id, i) => {
        const angle = start + step * i;
        const rad = angle * Math.PI / 180;
        const wc = { x: C.x + radius * Math.cos(rad), y: C.y + radius * Math.sin(rad) };
        const wb = worlds.get(id);
        const node = geo.eff(id);
        const F = geo.frame(node.parent);
        const v = rotV({ x: wc.x - wb.cx, y: wc.y - wb.cy }, -F.rot);
        const patch = { x: rnd(node.x + v.x), y: rnd(node.y + v.y) };
        if (rotMode) patch.rotation = normAngle((rotMode === 'tangent' ? angle + 90 : angle) - F.rot);
        tx.updateNode(id, patch, { bp });
      });
      refitGroups(tx, list, bp);
      return list;
    });
  }

  /**
   * matchSize(target, ids, { w, h }) — numbers set that size; `true` uses the largest selected size.
   * Rotated nodes keep their center.
   */
  function matchSize(target, ids, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, o);
    const all = existing(doc, ids).filter((id) => !isRoot(doc, id));
    const list = all.filter((id) => !isLocked(doc, id));
    if (!list.length || (!o.w && o.w !== 0 && !o.h && o.h !== 0)) return [];
    const effs = all.map((id) => schema.effectiveNode(doc, id, bp));
    const refW = isNum(o.w) ? o.w : (o.w ? Math.max.apply(null, effs.map((n) => n.w)) : null);
    const refH = isNum(o.h) ? o.h : (o.h ? Math.max.apply(null, effs.map((n) => n.h)) : null);
    const label = refW !== null && refH !== null ? 'Match size' : refW !== null ? 'Match width' : 'Match height';
    return store.transact(label, (tx) => {
      for (const id of list) {
        const n = schema.effectiveNode(tx.doc, id, bp);
        const box = {};
        if (refW !== null) box.w = Math.max(0, refW);
        if (refH !== null) box.h = Math.max(0, refH);
        if (n.rotation) {
          if (has(box, 'w')) box.x = n.x - (box.w - n.w) / 2;
          if (has(box, 'h')) box.y = n.y - (box.h - n.h) / 2;
        }
        const patch = boxPatch(box, n);
        if (Object.keys(patch).length) applyBox(tx, id, patch, bp);
      }
      refitGroups(tx, list, bp);
      return list;
    });
  }

  function zorder(target, ids, dir) {
    const { store } = resolve(target);
    const doc = store.doc;
    if (!ZORDER_LABELS[dir]) throw new Error('docops.zorder: unknown direction "' + dir + '"');
    const list = existing(doc, ids).filter((id) => !isRoot(doc, id));
    if (!list.length) return [];
    const byParent = util.groupBy(list, (id) => doc.nodes[id].parent);
    return store.transact(ZORDER_LABELS[dir], (tx) => {
      for (const pid of Object.keys(byParent)) {
        const sel = new Set(byParent[pid]);
        const kids = tx.node(pid).children.slice();
        let next;
        if (dir === 'front') next = kids.filter((k) => !sel.has(k)).concat(kids.filter((k) => sel.has(k)));
        else if (dir === 'back') next = kids.filter((k) => sel.has(k)).concat(kids.filter((k) => !sel.has(k)));
        else if (dir === 'forward') {
          next = kids.slice();
          for (let i = next.length - 2; i >= 0; i--) {
            if (sel.has(next[i]) && !sel.has(next[i + 1])) { const t = next[i]; next[i] = next[i + 1]; next[i + 1] = t; }
          }
        } else {
          next = kids.slice();
          for (let i = 1; i < next.length; i++) {
            if (sel.has(next[i]) && !sel.has(next[i - 1])) { const t = next[i]; next[i] = next[i - 1]; next[i - 1] = t; }
          }
        }
        if (!util.deepEqual(next, kids)) tx.set(['nodes', pid, 'children'], next);
      }
      return list;
    });
  }

  function setLocked(target, ids, locked) {
    const { store } = resolve(target);
    const doc = store.doc;
    const value = !!locked;
    const list = existing(doc, ids).filter((id) => !!doc.nodes[id].locked !== value);
    if (!list.length) return [];
    return store.transact(layerLabel(value ? 'Lock' : 'Unlock', list.length), (tx) => {
      list.forEach((id) => tx.updateNode(id, { locked: value }));
      return list;
    });
  }

  function setHidden(target, ids, hidden, opts) {
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, opts);
    const value = !!hidden;
    const list = existing(doc, ids).filter((id) => !isRoot(doc, id) && !!schema.effectiveNode(doc, id, bp).hidden !== value);
    if (!list.length) return [];
    return store.transact(layerLabel(value ? 'Hide' : 'Show', list.length), (tx) => {
      list.forEach((id) => tx.updateNode(id, { hidden: value }, { bp }));
      return list;
    });
  }

  function fitGroup(target, groupId, opts) {
    const { store } = resolve(target);
    const doc = store.doc;
    const bp = bpFor(store, opts);
    const g = nodeOf(doc, groupId);
    if (!g || !isContainerNode(g)) return false;
    return store.transact('Fit group', (tx) => {
      const changed = fitGroupTx(tx, groupId, bp);
      if (changed) refitGroups(tx, [groupId], bp);
      return changed;
    }) || false;
  }

  /* --------------------------------------------------------- responsive */

  /**
   * makeResponsive(target, pageId, bpId, { pad, gap }) → number of nodes overridden.
   * Free sections: children in reading order stack into one column (x = pad,
   * w = min(w, width − 2·pad), images keep aspect, free containers scale uniformly, text grows),
   * large text shrinks (≥ 40px: ×0.7 mobile, ×0.85 otherwise), section height fits.
   * Row stacks become columns on mobile (width < 600). All writes are bp overrides.
   */
  function makeResponsive(target, pageId, bpId, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const page = doc.pages.find((p) => p.id === pageId) || (!pageId ? currentPage(doc, store) : null);
    if (!page) return 0;
    const bps = doc.settings.breakpoints || [];
    const idx = bps.findIndex((b) => b.id === bpId);
    if (idx <= 0) return 0;
    const bp = bps[idx];
    const width = bp.width;
    const mobile = bp.id === 'mobile' || width < 600;
    const pad = isNum(o.pad) ? o.pad : (mobile ? 16 : 24);
    const GAP = isNum(o.gap) ? o.gap : 16;
    const fontFactor = mobile ? 0.7 : 0.85;
    const avail = Math.max(1, width - 2 * pad);
    const eff = (id) => schema.effectiveNode(doc, id, bpId);

    return store.transact('Make responsive (' + (bp.label || bp.id) + ')', (tx) => {
      const touched = new Set();
      const write = (id, patch) => {
        if (!Object.keys(patch).length) return;
        tx.updateNode(id, patch, { bp: bpId });
        touched.add(id);
      };
      const scaledFont = (n, extra) => {
        const fs = n.style && n.style.fontSize;
        if (!isNum(fs)) return null;
        let next = fs;
        if (fs >= 40) next = fs * fontFactor;
        if (extra && extra < 1) next = Math.max(12, next * extra);
        next = Math.round(next);
        return next !== fs ? next : null;
      };
      const scaleSubtree = (id, s) => {
        const n = eff(id);
        if (!n || !Array.isArray(n.children)) return;
        const free = !(n.layout && n.layout.mode === 'stack');
        for (const cid of n.children) {
          const k = eff(cid);
          if (!k) continue;
          const patch = {};
          if (free) {
            patch.x = rnd(k.x * s);
            patch.y = rnd(k.y * s);
            patch.w = rnd(k.w * s);
            patch.h = rnd(k.h * s);
          } else if ((k.sizing || {}).w !== 'fill' && k.w * s < k.w) {
            patch.w = rnd(k.w * s);
          }
          const f = scaledFont(k, s);
          if (f !== null) patch.style = { fontSize: f };
          write(cid, patch);
          scaleSubtree(cid, s);
        }
      };

      schema.walk(doc, page.root, (node) => {
        const n = eff(node.id);
        if (!n || !Array.isArray(n.children)) return;
        const L = n.layout || {};
        if (L.mode === 'stack') {
          if (mobile && L.dir === 'row' && n.type !== 'page') write(n.id, { layout: { dir: 'column' } });
          for (const cid of n.children) {
            const k = eff(cid);
            if (!k || k.hidden) continue;
            const sz = k.sizing || {};
            if (sz.w === 'fixed' && k.w > avail && n.type !== 'page') write(cid, { w: rnd(avail) });
          }
          return;
        }
        const isSection = n.type === 'section' || (!!n.parent && nodeOf(doc, n.parent) && nodeOf(doc, n.parent).type === 'page');
        if (!isSection) return;
        const kids = n.children.map(eff).filter((k) => k && !k.hidden);
        const rows = readingOrder(kids, (k) => k);
        let y = pad;
        for (const k of [].concat.apply([], rows)) {
          const w = Math.min(k.w, avail);
          const s = k.w > 0 ? w / k.w : 1;
          let h = k.h;
          const patch = { x: pad, y: rnd(y), w: rnd(w) };
          const f = scaledFont(k);
          const fontScale = f !== null && k.style.fontSize ? f / k.style.fontSize : 1;
          if (k.type === 'image' || (isContainerNode(k) && !(k.layout && k.layout.mode === 'stack'))) {
            h = k.h * s;
            if (isContainerNode(k) && s < 1) scaleSubtree(k.id, s);
          } else if (TEXTY.has(k.type)) {
            h = k.h * (s < 1 ? 1 / s : 1) * fontScale;
          }
          if (f !== null) patch.style = { fontSize: f };
          if (k.rotation) patch.rotation = 0;
          patch.h = rnd(h);
          write(k.id, patch);
          y += h + GAP;
        }
        if (kids.length) write(n.id, { h: rnd(Math.max(y - GAP + pad, 1)) });
      });
      return touched.size;
    });
  }

  /* ------------------------------------------------------------- components */

  function createComponent(target, ids, opts) {
    const o = opts || {};
    const c = resolve(target);
    const store = c.store;
    const doc = store.doc;
    const list = sortDocOrder(doc, topLevel(doc, ids)).filter((id) => doc.nodes[id].type !== 'page');
    if (!list.length) return null;
    const top = list[list.length - 1];
    const parentId = doc.nodes[top].parent;
    const geo = makeGeo(doc, null, domHook(c, doc, null));
    const worlds = new Map(list.map((id) => [id, geo.world(id)]));
    const compNames = new Set(Object.values(doc.components || {}).map((cp) => cp && cp.name));
    return store.transact('Create component', (tx) => {
      const cpId = util.uid('cp', doc.components || {});
      const first = doc.nodes[list[0]];
      const single = list.length === 1 && isContainerNode(first);
      const name = o.name || (single ? util.nextName(first.name || 'Component', compNames) : util.nextName('Component', compNames));
      const F = geo.frame(parentId);
      let rootId;
      let inst;
      if (single) {
        const { nodes, idMap } = schema.reid(tx.doc.nodes, [first.id]);
        rootId = idMap[first.id];
        const root = nodes[rootId];
        const l = localFromWorld(F, worlds.get(first.id));
        inst = { x: rnd(l.x), y: rnd(l.y), w: rnd(l.w), h: rnd(l.h), rotation: l.rotation, sizing: util.deepClone(first.sizing), bp: {} };
        if (util.isPlainObject(root.bp)) {
          for (const k of Object.keys(root.bp)) {
            const ov = root.bp[k];
            if (!util.isPlainObject(ov)) continue;
            const boxPart = util.pick(ov, ['x', 'y', 'w', 'h', 'rotation', 'hidden', 'sizing']);
            if (Object.keys(boxPart).length) inst.bp[k] = boxPart;
            root.bp[k] = util.omit(ov, ['x', 'y', 'rotation', 'hidden']);
            if (!Object.keys(root.bp[k]).length) delete root.bp[k];
          }
        }
        Object.assign(root, { parent: null, x: 0, y: 0, rotation: 0, hidden: false, locked: false, name });
        for (const nid of Object.keys(nodes)) tx.set(['nodes', nid], nodes[nid]);
      } else {
        const locals = new Map(list.map((id) => [id, localFromWorld(F, worlds.get(id))]));
        const B = geometry.aabb(list.map((id) => { const l = locals.get(id); return geometry.aabb(geometry.corners(l, l.rotation)); }));
        rootId = tx.createNode({ type: 'frame', name, x: 0, y: 0, w: rnd(B.w), h: rnd(B.h), rotation: 0, layout: { mode: 'free' } }, null);
        clearStyle(tx, rootId);
        const { nodes, idMap } = schema.reid(tx.doc.nodes, list);
        for (const id of list) {
          const copy = nodes[idMap[id]];
          const l = locals.get(id);
          copy.parent = rootId;
          copy.x = rnd(l.x - B.x);
          copy.y = rnd(l.y - B.y);
          copy.rotation = l.rotation;
          copy.locked = false;
          if (util.isPlainObject(copy.bp)) {
            for (const k of Object.keys(copy.bp)) {
              const ov = copy.bp[k];
              if (!util.isPlainObject(ov)) continue;
              if (isNum(ov.x)) ov.x = rnd(ov.x - B.x);
              if (isNum(ov.y)) ov.y = rnd(ov.y - B.y);
            }
          }
          const sz = copy.sizing || {};
          if (sz.w === 'fill' || sz.h === 'fill') {
            copy.sizing = { w: sz.w === 'fill' ? 'fixed' : sz.w, h: sz.h === 'fill' ? 'fixed' : sz.h };
            copy.w = rnd(l.w);
            copy.h = rnd(l.h);
          }
        }
        for (const nid of Object.keys(nodes)) tx.set(['nodes', nid], nodes[nid]);
        tx.set(['nodes', rootId, 'children'], list.map((id) => idMap[id]));
        inst = { x: rnd(B.x), y: rnd(B.y), w: rnd(B.w), h: rnd(B.h), rotation: 0 };
      }
      tx.setDocField(['components', cpId], { id: cpId, name, root: rootId });
      const p = tx.node(parentId);
      const init = Object.assign({ type: 'instance', name, props: { component: cpId, overrides: {} } }, inst);
      if (init.bp && !Object.keys(init.bp).length) delete init.bp;
      const instId = tx.createNode(init, parentId, p.children.indexOf(top) + 1);
      tx.set(['nodes', instId, 'props'], { component: cpId, overrides: {} });
      const oldParents = new Set(list.map((id) => doc.nodes[id].parent));
      list.forEach((id) => tx.removeNode(id));
      cleanupContainers(tx, oldParents);
      refitGroups(tx, [instId], null);
      tx.select([instId]);
      return cpId;
    });
  }

  function instantiate(target, componentId, opts) {
    const o = opts || {};
    const { store } = resolve(target);
    const doc = store.doc;
    const comp = doc.components && doc.components[componentId];
    const root = comp && nodeOf(doc, comp.root);
    if (!root) return null;
    const parentId = o.parent || defaultParent(doc, store, root.type);
    const parent = nodeOf(doc, parentId);
    if (!isContainerNode(parent)) return null;
    let x = 0;
    let y = 0;
    if (o.at && isNum(o.at.x) && isNum(o.at.y)) {
      x = o.at.x;
      y = o.at.y;
    } else if (!(parent.layout && parent.layout.mode === 'stack')) {
      const pb = makeGeo(doc, null, null).localBox(parentId);
      x = Math.max(0, (pb.w - root.w) / 2);
      y = Math.max(0, (pb.h - root.h) / 2);
    }
    return store.transact('Insert ' + (comp.name || 'component'), (tx) => {
      const id = tx.createNode({
        type: 'instance', name: comp.name || 'Component', x: rnd(x), y: rnd(y), w: root.w, h: root.h, rotation: 0,
        sizing: util.deepClone(root.sizing || { w: 'fixed', h: 'fixed' }), props: { component: componentId, overrides: {} }
      }, parentId, isNum(o.index) ? o.index : undefined);
      tx.set(['nodes', id, 'props'], { component: componentId, overrides: {} });
      refitGroups(tx, [id], null);
      if (o.select !== false) tx.select([id]);
      return id;
    });
  }

  function detach(target, instanceId) {
    const { store } = resolve(target);
    const doc = store.doc;
    const inst = nodeOf(doc, instanceId);
    if (!inst || inst.type !== 'instance' || !inst.parent) return [];
    const comp = doc.components && inst.props && doc.components[inst.props.component];
    const root = comp && nodeOf(doc, comp.root);
    if (!root) return [];
    return store.transact('Detach instance', (tx) => {
      const { nodes, idMap } = schema.reid(tx.doc.nodes, [root.id]);
      const overrides = util.isPlainObject(inst.props.overrides) ? inst.props.overrides : {};
      for (const masterId of Object.keys(overrides)) {
        const nid = idMap[masterId];
        const ov = overrides[masterId];
        if (!nid || !util.isPlainObject(ov)) continue;
        const nd = nodes[nid];
        for (const key of schema.MERGE_KEYS) {
          if (util.isPlainObject(ov[key])) nd[key] = Object.assign({}, util.isPlainObject(nd[key]) ? nd[key] : {}, util.deepClone(ov[key]));
        }
        if (typeof ov.hidden === 'boolean') nd.hidden = ov.hidden;
        if (typeof ov.name === 'string' && ov.name) nd.name = ov.name;
      }
      const newRootId = idMap[root.id];
      const nr = nodes[newRootId];
      Object.assign(nr, {
        parent: inst.parent, x: inst.x, y: inst.y, w: inst.w, h: inst.h, rotation: inst.rotation || 0,
        hidden: !!inst.hidden, locked: false, name: inst.name || nr.name,
        sizing: util.deepClone(inst.sizing || nr.sizing)
      });
      if (util.isPlainObject(inst.style) && Object.keys(inst.style).length) nr.style = Object.assign({}, nr.style, util.deepClone(inst.style));
      if (util.isPlainObject(inst.attrs) && Object.keys(inst.attrs).length) nr.attrs = Object.assign({}, nr.attrs, util.deepClone(inst.attrs));
      if (inst.motion) nr.motion = util.deepClone(inst.motion);
      if (inst.css) nr.css = inst.css;
      if (util.isPlainObject(inst.states) && Object.keys(inst.states).length) nr.states = Object.assign({}, nr.states, util.deepClone(inst.states));
      if (util.isPlainObject(inst.bp)) {
        const bpOut = util.isPlainObject(nr.bp) ? Object.assign({}, nr.bp) : {};
        for (const k of Object.keys(inst.bp)) {
          const add = util.pick(inst.bp[k] || {}, ['x', 'y', 'w', 'h', 'rotation', 'hidden', 'sizing']);
          if (Object.keys(add).length) bpOut[k] = Object.assign({}, bpOut[k] || {}, util.deepClone(add));
        }
        nr.bp = bpOut;
      }
      for (const nid of Object.keys(nodes)) tx.set(['nodes', nid], nodes[nid]);
      const p = tx.node(inst.parent);
      tx.set(['nodes', p.id, 'children'], p.children.map((k) => (k === instanceId ? newRootId : k)));
      tx.removeNode(instanceId);
      tx.select([newRootId]);
      return [newRootId];
    });
  }

  /* ---------------------------------------------------------------- helpers */

  /** World box { cx, cy, w, h, rotation } of a node (page coordinates). */
  function worldBox(doc, id, opts) {
    if (!nodeOf(doc, id)) return null;
    return makeGeo(doc, (opts && opts.bp) || null, null).world(id);
  }

  /** Axis-aligned world bounds { x, y, w, h } of a node (rotation included). */
  function worldBounds(doc, id, opts) {
    if (!nodeOf(doc, id)) return null;
    return makeGeo(doc, (opts && opts.bp) || null, null).worldAABB(id);
  }

  /** Convert a world box into the local { x, y, w, h, rotation } of container parentId. */
  function toLocal(doc, parentId, box, opts) {
    const F = makeGeo(doc, (opts && opts.bp) || null, null).frame(parentId);
    return localFromWorld(F, box);
  }

  return {
    insert, remove, duplicate, move, setBox, update, reparent,
    group, ungroup, wrap, align, distribute, tidy, radial, matchSize, zorder,
    setLocked, setHidden, fitGroup, makeResponsive,
    createComponent, instantiate, detach,
    worldBox, worldBounds, toLocal, topLevel, sortDocOrder, isLocked
  };
});

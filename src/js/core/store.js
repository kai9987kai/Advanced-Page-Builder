/* @node-testable */
/*
 * store — immutable document state with copy-on-write transactions, exact inverse ops,
 * undo/redo with coalescing, selection, view and prefs. Pure (no DOM). See ARCHITECTURE.md §6.7.
 *
 * Ops are { path: 'a.b.c', value } (value undefined = delete key). Array items are never deleted by
 * index: such writes are recorded as a replacement of the whole array so every inverse is exact.
 */
APB.define('store', ['util', 'events', 'schema'], function (util, events, schema) {
  'use strict';

  const HISTORY_CAP = 500;
  const COALESCE_MS = 1500;
  const DOC_FIELDS = new Set(['settings', 'tokens', 'pages', 'assets', 'components', 'name']);
  const BOX_KEYS = new Set(['x', 'y', 'w', 'h', 'rotation']);
  const STRUCTURE_FIELDS = new Set(['parent', 'children']);
  const FORBIDDEN_PATCH_KEYS = new Set(['id', 'parent', 'children']);

  const DEFAULT_PREFS = Object.freeze({
    theme: 'system',
    snap: Object.freeze({ objects: true, grid: false, gridSize: 8, rotationStep: 15, threshold: 6 }),
    showGrid: false,
    showRulers: true,
    leftWidth: 280,
    rightWidth: 300,
    leftTab: 'layers',
    rightTab: 'design',
    recentColors: Object.freeze([]),
    ai: Object.freeze({ provider: 'local', model: 'claude-opus-5', effort: 'medium', rememberKey: false })
  });

  function defaultPrefs() {
    return util.deepClone(DEFAULT_PREFS);
  }

  function pathString(path) {
    const keys = util.parsePath(path);
    if (!keys.length) throw new Error('store: empty path');
    for (const k of keys) {
      const s = String(k);
      if (!s || s.includes('.')) throw new Error('store: invalid path segment "' + s + '"');
      if (s === '__proto__' || s === 'constructor' || s === 'prototype') throw new Error('store: unsafe path segment "' + s + '"');
    }
    return keys.map(String);
  }

  function isEmptyObject(v) {
    return util.isPlainObject(v) && Object.keys(v).length === 0;
  }

  /**
   * Drop ops that a LATER op on the same path overwrites with a defined value (the retained op
   * stays at its position). Forward ops are chronological → the latest value wins. Inverse ops are
   * stored in apply order (newest change first) → the earliest original value wins ("keep earliest
   * inverse"). Exactness: every op between the dropped and the retained op either touches a
   * sub-path (overwritten by the retained op), a super-path (which already replaced the dropped
   * op's effect) or an unrelated path. A later *delete* never drops earlier ops, because an earlier
   * write may have created the parent objects that must survive the delete.
   */
  function compressOps(ops) {
    if (ops.length < 2) return ops;
    const overwritten = new Set();
    const out = [];
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (overwritten.has(op.path)) continue;
      if (op.value !== undefined) overwritten.add(op.path);
      out.push(op);
    }
    return out.reverse();
  }

  /*
   * Draft copy-on-write. Within one transaction (or one undo/redo application) every object on a
   * written path is shallow-copied at most once: copies are recorded in `owned` and later writes
   * mutate them in place. Objects of the committed document are never owned, so they stay immutable.
   * While a nested transaction is open (`depth > 0`), in-place writes are journaled so its savepoint
   * can roll back exactly.
   */
  function newDraft() {
    return { owned: new WeakSet(), journal: null, depth: 0 };
  }

  function draftWritable(cur, draft) {
    if (cur !== null && typeof cur === 'object' && draft.owned.has(cur)) return cur;
    const copy = Array.isArray(cur) ? cur.slice() : Object.assign({}, cur !== null && typeof cur === 'object' ? cur : {});
    draft.owned.add(copy);
    return copy;
  }

  function journalWrite(draft, obj, key) {
    if (!draft.journal || !draft.owned.has(obj)) return;
    if (Array.isArray(obj)) draft.journal.push({ obj, arr: obj.slice() });
    else draft.journal.push({ obj, key, had: Object.prototype.hasOwnProperty.call(obj, key), old: obj[key] });
  }

  function rollbackJournal(journal, length) {
    if (!journal) return;
    for (let i = journal.length - 1; i >= length; i--) {
      const j = journal[i];
      if (j.arr) { j.obj.length = 0; Array.prototype.push.apply(j.obj, j.arr); } else if (j.had) j.obj[j.key] = j.old; else delete j.obj[j.key];
    }
    journal.length = length;
  }

  function draftSetIn(cur, keys, i, value, draft) {
    const k = keys[i];
    const isObj = cur !== null && typeof cur === 'object';
    const exists = isObj && Object.prototype.hasOwnProperty.call(cur, k);
    if (i === keys.length - 1) {
      if (value === undefined) {
        if (!exists) return cur;
        journalWrite(draft, cur, k);
        const w = draftWritable(cur, draft);
        if (Array.isArray(w)) w.splice(Number(k), 1); else delete w[k];
        return w;
      }
      if (exists && cur[k] === value) return cur;
      journalWrite(draft, cur, k);
      const w = draftWritable(cur, draft);
      w[k] = value;
      return w;
    }
    const child = exists ? cur[k] : undefined;
    const childObj = child !== null && typeof child === 'object';
    if (value === undefined && !childObj) return cur;
    let base = child;
    if (!childObj) { base = {}; draft.owned.add(base); }
    const nextChild = draftSetIn(base, keys, i + 1, value, draft);
    if (exists && nextChild === child) return cur;
    journalWrite(draft, cur, k);
    const w = draftWritable(cur, draft);
    w[k] = nextChild;
    return w;
  }

  function create(initialDoc, options) {
    const opts = options || {};
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const emitter = new events.Emitter();

    let doc;
    let lastWarnings = [];
    let entries = [];
    let index = 0;
    let coalesceBreak = true;
    let selection = [];
    let prefs = util.deepMerge(defaultPrefs(), opts.prefs || {});
    let view = null;
    let current = null; // open transaction context

    function prepareDoc(input) {
      if (input === undefined || input === null) return { doc: schema.createDocument(), warnings: [] };
      const v = schema.validateDocument(input);
      if (v.ok) return { doc: input, warnings: [] };
      return schema.normalizeDocument(input);
    }

    function baseBp(d) {
      const bps = d.settings && d.settings.breakpoints;
      return bps && bps.length ? bps[0].id : 'desktop';
    }

    function freshView(d, prev) {
      const p = prev || {};
      const pageOk = d.pages.some((pg) => pg.id === p.pageId);
      const bpOk = (d.settings.breakpoints || []).some((b) => b.id === p.bp);
      return {
        pageId: pageOk ? p.pageId : (d.pages[0] ? d.pages[0].id : null),
        bp: bpOk ? p.bp : baseBp(d),
        zoom: Number.isFinite(p.zoom) && p.zoom > 0 ? p.zoom : 1,
        x: Number.isFinite(p.x) ? p.x : 0,
        y: Number.isFinite(p.y) ? p.y : 0,
        tool: typeof p.tool === 'string' ? p.tool : 'select',
        context: null,
        hover: null,
        editingText: null
      };
    }

    {
      const prepared = prepareDoc(initialDoc);
      doc = prepared.doc;
      lastWarnings = prepared.warnings;
      view = freshView(doc, util.isPlainObject(opts.view) ? opts.view : null);
    }

    /* ------------------------------------------------------ change info */

    function newInfo() {
      return { nodes: new Set(), structure: false, global: false };
    }

    function classify(info, keys, before, after) {
      if (keys[0] !== 'nodes') { info.global = true; return; }
      if (keys.length === 1) {
        Object.keys((before && before.nodes) || {}).forEach((id) => info.nodes.add(id));
        Object.keys((after && after.nodes) || {}).forEach((id) => info.nodes.add(id));
        info.structure = true;
        return;
      }
      info.nodes.add(keys[1]);
      if (keys.length === 2 || STRUCTURE_FIELDS.has(keys[2])) info.structure = true;
    }

    /* ------------------------------------------------------ transaction */

    function makeTx(ctx) {
      function set(path, value) {
        if (ctx.closed) throw new Error('store: transaction "' + ctx.label + '" is already finished (transact fn must be synchronous)');
        let keys = pathString(path);
        let val = value;
        let state = ctx.state;
        // Deleting an array item → replace the whole array (keeps inverses exact).
        if (val === undefined && keys.length > 1) {
          const parent = util.getPath(state, keys.slice(0, -1));
          if (Array.isArray(parent)) {
            const idx = Number(keys[keys.length - 1]);
            if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) return;
            val = parent.slice(0, idx).concat(parent.slice(idx + 1));
            keys = keys.slice(0, -1);
          }
        }
        const old = util.getPath(state, keys);
        if (old === val) return;
        // Inverse: restore the highest ancestor that is missing or not an object (it will be created).
        let inverse = null;
        let cur = state;
        for (let i = 0; i < keys.length - 1; i++) {
          const next = cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, keys[i]) ? cur[keys[i]] : undefined;
          if (next === null || typeof next !== 'object') {
            if (val === undefined) return; // deleting below a missing branch: no-op
            inverse = { path: keys.slice(0, i + 1).join('.'), value: next };
            break;
          }
          cur = next;
        }
        if (!inverse) inverse = { path: keys.join('.'), value: old };
        // `old !== val` guarantees a change; objects this transaction already copied are written in place.
        const before = keys.length === 1 ? { nodes: state.nodes } : state;
        const nextState = draftSetIn(state, keys, 0, val, ctx.draft);
        ctx.state = nextState;
        ctx.ops.push({ path: keys.join('.'), value: val });
        ctx.inverse.push(inverse);
        classify(ctx.info, keys, before, nextState);
      }

      function get(path) {
        return util.getPath(ctx.state, path);
      }

      function nodeOf(id) {
        const nodes = ctx.state.nodes;
        return nodes && Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null;
      }

      function requireNode(id, what) {
        const n = nodeOf(id);
        if (!n) throw new Error('store: ' + (what || 'node') + ' "' + id + '" does not exist');
        return n;
      }

      function createNode(nodeInit, parentId, index) {
        const init = Object.assign({}, nodeInit || {});
        delete init.children;
        delete init.parent;
        let parent = null;
        if (parentId !== null && parentId !== undefined) {
          parent = requireNode(parentId, 'parent');
          if (!Array.isArray(parent.children)) throw new Error('store: parent "' + parentId + '" is not a container');
        }
        if (init.id && nodeOf(init.id)) delete init.id;
        const node = schema.createNode(init.type, init);
        if (nodeOf(node.id)) node.id = util.uid('n', ctx.state.nodes);
        node.parent = parent ? parent.id : null;
        set(['nodes', node.id], node);
        if (parent) {
          const kids = parent.children.slice();
          const at = index === undefined || index === null ? kids.length : util.clamp(Math.round(index), 0, kids.length);
          kids.splice(at, 0, node.id);
          set(['nodes', parent.id, 'children'], kids);
        }
        return node.id;
      }

      function removeNode(id) {
        const node = nodeOf(id);
        if (!node) return false;
        const ids = [id].concat(schema.descendants(ctx.state, id));
        if (node.parent) {
          const parent = nodeOf(node.parent);
          if (parent && Array.isArray(parent.children) && parent.children.includes(id)) {
            set(['nodes', parent.id, 'children'], parent.children.filter((c) => c !== id));
          }
        }
        for (let i = ids.length - 1; i >= 0; i--) set(['nodes', ids[i]], undefined);
        const gone = new Set(ids);
        if (ctx.selection.some((s) => gone.has(s))) ctx.selection = ctx.selection.filter((s) => !gone.has(s));
        return true;
      }

      /** index = position in the target's children AFTER removing the node (omit to append). */
      function moveNode(id, parentId, index) {
        const node = requireNode(id);
        const parent = requireNode(parentId, 'parent');
        if (!Array.isArray(parent.children)) throw new Error('store: parent "' + parentId + '" is not a container');
        if (parentId === id || schema.ancestors(ctx.state, parentId).includes(id)) {
          throw new Error('store: cannot move "' + id + '" into itself or its descendant');
        }
        const oldParent = node.parent ? nodeOf(node.parent) : null;
        if (oldParent && oldParent.id !== parent.id && Array.isArray(oldParent.children)) {
          set(['nodes', oldParent.id, 'children'], oldParent.children.filter((c) => c !== id));
        }
        const base = nodeOf(parent.id).children.filter((c) => c !== id);
        const at = index === undefined || index === null ? base.length : util.clamp(Math.round(index), 0, base.length);
        base.splice(at, 0, id);
        const currentKids = nodeOf(parent.id).children;
        if (!util.deepEqual(currentKids, base)) set(['nodes', parent.id, 'children'], base);
        if (node.parent !== parent.id) set(['nodes', id, 'parent'], parent.id);
      }

      function checkBoxValue(key, v) {
        if (BOX_KEYS.has(key) && v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
          throw new TypeError('store: ' + key + ' must be a finite number');
        }
      }

      function prune(path) {
        const v = get(path);
        if (isEmptyObject(v)) set(path, undefined);
      }

      function updateNode(id, patch, updateOpts) {
        const node = requireNode(id);
        if (!util.isPlainObject(patch)) throw new TypeError('store: updateNode patch must be an object');
        const bpId = updateOpts && updateOpts.bp;
        const bps = (ctx.state.settings && ctx.state.settings.breakpoints) || [];
        const toBp = !!bpId && bps.length > 0 && bps[0].id !== bpId;
        if (toBp && !bps.some((b) => b.id === bpId)) throw new Error('store: unknown breakpoint "' + bpId + '"');
        for (const key of Object.keys(patch)) {
          if (!schema.NODE_KEYS.includes(key)) throw new TypeError('store: "' + key + '" is not a node key');
          if (FORBIDDEN_PATCH_KEYS.has(key)) throw new TypeError('store: "' + key + '" cannot be patched (use moveNode/createNode)');
          const value = patch[key];
          checkBoxValue(key, value);
          const isMerge = schema.MERGE_KEYS.includes(key) && util.isPlainObject(value);
          if (toBp && schema.BP_KEYS.includes(key)) {
            const basePath = ['nodes', id, 'bp', bpId, key];
            if (isMerge) {
              for (const sub of Object.keys(value)) set(basePath.concat(sub), value[sub]);
              prune(basePath);
            } else {
              set(basePath, value);
            }
            prune(['nodes', id, 'bp', bpId]);
          } else if (isMerge) {
            const currentVal = nodeOf(id)[key];
            if (!util.isPlainObject(currentVal)) {
              let whole = Object.assign({}, value);
              Object.keys(whole).forEach((k) => { if (whole[k] === undefined) delete whole[k]; });
              if (key === 'layout') whole = schema.fullLayout(whole, node.type);
              set(['nodes', id, key], whole);
            } else {
              for (const sub of Object.keys(value)) set(['nodes', id, key, sub], value[sub]);
            }
          } else {
            set(['nodes', id, key], value);
          }
        }
      }

      function setDocField(path, value) {
        const keys = pathString(path);
        if (!DOC_FIELDS.has(keys[0])) {
          throw new Error('store: setDocField only accepts ' + Array.from(DOC_FIELDS).join('/') + ' (got "' + keys[0] + '")');
        }
        set(keys, value);
      }

      return {
        get, set, createNode, removeNode, moveNode, updateNode, setDocField,
        node: nodeOf,
        get doc() { return ctx.state; },
        get selection() { return ctx.selection; },
        select(ids) {
          if (ctx.closed) throw new Error('store: transaction "' + ctx.label + '" is already finished');
          ctx.selection = normalizeIds(ids, ctx.state);
        }
      };
    }

    function normalizeIds(ids, d) {
      const list = ids === undefined || ids === null ? [] : Array.isArray(ids) ? ids : [ids];
      const nodes = (d || doc).nodes;
      const seen = new Set();
      const out = [];
      for (const id of list) {
        if (typeof id !== 'string' || seen.has(id) || !Object.prototype.hasOwnProperty.call(nodes, id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    }

    /**
     * transact(label, fn(tx), { coalesce, select, silent }) → fn's return value.
     * - fn must be synchronous. If it throws, nothing is applied (no partial state) and the error
     *   is rethrown. A transaction started inside another one joins it (one history entry); an
     *   exception in the inner fn rolls back only the inner changes before rethrowing.
     * - coalesce: consecutive transactions with the same key within COALESCE_MS merge into one entry.
     * - select: ids to select after the transaction (recorded as the entry's selAfter).
     * - silent: apply and emit 'change' but record no undo entry (for non-undoable bookkeeping).
     */
    function transact(label, fn, txOpts) {
      if (typeof label === 'function') { txOpts = fn; fn = label; label = 'Edit'; }
      if (typeof fn !== 'function') throw new TypeError('store.transact: fn must be a function');
      const o = txOpts || {};

      if (current) {
        // Nested: join the outer transaction with a savepoint for rollback.
        const ctx = current;
        const draft = ctx.draft;
        if (!draft.journal) draft.journal = [];
        const save = {
          state: ctx.state, ops: ctx.ops.length, inverse: ctx.inverse.length, selection: ctx.selection,
          nodes: ctx.info.nodes.size, structure: ctx.info.structure, global: ctx.info.global, journal: draft.journal.length
        };
        draft.depth++;
        try {
          const result = fn(ctx.tx);
          if (o.select) ctx.selection = normalizeIds(o.select, ctx.state);
          return result;
        } catch (err) {
          rollbackJournal(draft.journal, save.journal);
          ctx.state = save.state;
          ctx.ops.length = save.ops;
          ctx.inverse.length = save.inverse;
          ctx.selection = save.selection;
          if (ctx.info.nodes.size > save.nodes) ctx.info.nodes = new Set(Array.from(ctx.info.nodes).slice(0, save.nodes));
          ctx.info.structure = save.structure;
          ctx.info.global = save.global;
          throw err;
        } finally {
          draft.depth--;
          if (draft.depth === 0) draft.journal = null;
        }
      }

      const ctx = {
        label: String(label || 'Edit'), state: doc, ops: [], inverse: [], info: newInfo(),
        selection: selection, selBefore: selection, tx: null, closed: false,
        draft: newDraft()
      };
      ctx.tx = makeTx(ctx);
      current = ctx;
      let result;
      try {
        result = fn(ctx.tx);
      } catch (err) {
        current = null;
        ctx.closed = true;
        throw err;
      }
      current = null;
      ctx.closed = true;
      if (result && typeof result.then === 'function' && typeof console !== 'undefined') {
        console.warn('[APB] store.transact("' + ctx.label + '"): fn returned a Promise; only synchronous changes are recorded');
      }

      if (o.select) ctx.selection = normalizeIds(o.select, ctx.state);
      if (!ctx.ops.length) {
        if (ctx.selection !== selection) setSelection(normalizeIds(ctx.selection, doc));
        return result;
      }
      commit(String(label || 'Edit'), ctx, o);
      return result;
    }

    function commit(label, ctx, o) {
      const selBefore = ctx.selBefore;
      let nextDoc = ctx.state;
      nextDoc = util.setPathImmutable(nextDoc, ['updatedAt'], new Date(now()).toISOString());
      doc = nextDoc;
      const selAfter = normalizeIds(ctx.selection, doc);
      const ops = ctx.ops.slice();
      const inverseApplyOrder = ctx.inverse.slice().reverse();

      if (!o.silent) {
        const t = now();
        const last = index > 0 ? entries[index - 1] : null;
        const canMerge = !!(o.coalesce && last && !coalesceBreak && index === entries.length &&
          last.coalesce === o.coalesce && t - last.time <= COALESCE_MS);
        if (canMerge) {
          last.ops = compressOps(last.ops.concat(ops));
          last.inverse = compressOps(inverseApplyOrder.concat(last.inverse));
          last.selAfter = selAfter;
          last.time = t;
          last.label = label;
        } else {
          if (entries.length > index) entries = entries.slice(0, index);
          entries.push({
            label,
            ops: compressOps(ops),
            inverse: compressOps(inverseApplyOrder),
            selBefore: selBefore.slice(),
            selAfter: selAfter.slice(),
            time: t,
            coalesce: o.coalesce || null
          });
          if (entries.length > HISTORY_CAP) entries = entries.slice(entries.length - HISTORY_CAP);
          index = entries.length;
        }
        coalesceBreak = false;
      }

      const selChanged = !util.deepEqual(selAfter, selection);
      if (selChanged) selection = selAfter;
      const viewPatch = repairView(ctx.info);
      emitter.emit('change', {
        label, source: 'user', ops, nodes: ctx.info.nodes, structure: ctx.info.structure, global: ctx.info.global
      });
      if (selChanged) emitter.emit('selection', { selection, previous: selBefore });
      if (viewPatch) emitView(viewPatch.previous);
      if (!o.silent) emitHistory();
    }

    /** After a doc change, clear view references to missing pages/nodes/breakpoints. */
    function repairView(info) {
      if (!info.structure && !info.global) return null;
      const previous = view;
      const patch = {};
      const nodes = doc.nodes;
      if (!doc.pages.some((p) => p.id === view.pageId)) patch.pageId = doc.pages[0] ? doc.pages[0].id : null;
      if (!(doc.settings.breakpoints || []).some((b) => b.id === view.bp)) patch.bp = baseBp(doc);
      for (const k of ['context', 'hover', 'editingText']) {
        if (view[k] && !Object.prototype.hasOwnProperty.call(nodes, view[k])) patch[k] = null;
      }
      if (!Object.keys(patch).length) return null;
      view = Object.assign({}, view, patch);
      return { previous };
    }

    function setSelection(next) {
      if (util.deepEqual(next, selection)) return false;
      const previous = selection;
      selection = next;
      emitter.emit('selection', { selection, previous });
      return true;
    }

    function applyOps(opList) {
      const info = newInfo();
      const draft = newDraft();
      let state = doc;
      for (const op of opList) {
        const keys = op.path.split('.');
        const before = keys.length === 1 ? { nodes: state.nodes } : state;
        state = draftSetIn(state, keys, 0, op.value, draft);
        classify(info, keys, before, state);
      }
      doc = util.setPathImmutable(state, ['updatedAt'], new Date(now()).toISOString());
      return info;
    }

    function step(direction, target) {
      if (current) throw new Error('store: cannot ' + direction + ' inside a transaction');
      const steps = [];
      if (direction === 'undo') {
        while (index > target) { steps.push(entries[index - 1]); index--; }
      } else {
        while (index < target) { steps.push(entries[index]); index++; }
      }
      if (!steps.length) return false;
      const opList = [];
      steps.forEach((e) => { opList.push.apply(opList, direction === 'undo' ? e.inverse : e.ops); });
      const info = applyOps(opList);
      coalesceBreak = true;
      const lastStep = steps[steps.length - 1];
      const nextSel = normalizeIds(direction === 'undo' ? lastStep.selBefore : lastStep.selAfter, doc);
      const previousSel = selection;
      const selChanged = !util.deepEqual(nextSel, selection);
      if (selChanged) selection = nextSel;
      const viewPatch = repairView(info);
      const label = steps.length === 1 ? lastStep.label : steps.length + ' steps';
      emitter.emit('change', { label, source: direction, ops: opList, nodes: info.nodes, structure: info.structure, global: info.global });
      if (selChanged) emitter.emit('selection', { selection, previous: previousSel });
      if (viewPatch) emitView(viewPatch.previous);
      emitHistory();
      return true;
    }

    function canUndo() { return index > 0; }
    function canRedo() { return index < entries.length; }
    function assertNoTransaction(what) {
      if (current) throw new Error('store: cannot ' + what + ' inside a transaction');
    }
    function undo() { assertNoTransaction('undo'); return canUndo() ? step('undo', index - 1) : false; }
    function redo() { assertNoTransaction('redo'); return canRedo() ? step('redo', index + 1) : false; }

    function jump(target) {
      assertNoTransaction('jump');
      const t = util.clamp(Math.round(Number(target) || 0), 0, entries.length);
      if (t === index) return false;
      return step(t < index ? 'undo' : 'redo', t);
    }

    function historyInfo() {
      return {
        entries: entries.map((e) => ({ label: e.label, time: e.time })),
        index,
        canUndo: canUndo(),
        canRedo: canRedo()
      };
    }

    function emitHistory() {
      emitter.emit('history', historyInfo());
    }

    function clearHistory() {
      entries = [];
      index = 0;
      coalesceBreak = true;
      emitHistory();
    }

    function replaceDoc(nextDoc, replaceOpts) {
      if (current) throw new Error('store: cannot replace the document inside a transaction');
      const prepared = prepareDoc(nextDoc);
      lastWarnings = prepared.warnings;
      const before = doc;
      doc = prepared.doc;
      entries = [];
      index = 0;
      coalesceBreak = true;
      const nodes = new Set(Object.keys(before.nodes || {}).concat(Object.keys(doc.nodes)));
      const previousSel = selection;
      selection = [];
      const previousView = view;
      view = freshView(doc, before.id === doc.id ? view : { zoom: view.zoom, x: view.x, y: view.y, tool: view.tool });
      const label = (replaceOpts && replaceOpts.label) || 'Replace document';
      emitter.emit('change', { label, source: 'replace', ops: [], nodes, structure: true, global: true });
      if (previousSel.length) emitter.emit('selection', { selection, previous: previousSel });
      emitView(previousView);
      emitHistory();
      return { warnings: prepared.warnings };
    }

    /* ------------------------------------------------------ view/prefs */

    function emitView(previous) {
      const changed = Object.keys(view).filter((k) => !util.deepEqual(view[k], previous[k]));
      if (changed.length) emitter.emit('view', { view, previous, changed });
    }

    function setView(patch) {
      if (!util.isPlainObject(patch)) return false;
      const next = Object.assign({}, view);
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (patch[k] === undefined) continue;
        if (!util.deepEqual(view[k], patch[k])) { next[k] = patch[k]; changed = true; }
      }
      if (!changed) return false;
      if (next.pageId !== view.pageId && !doc.pages.some((p) => p.id === next.pageId)) {
        throw new Error('store.setView: unknown page "' + next.pageId + '"');
      }
      const previous = view;
      view = next;
      emitView(previous);
      return true;
    }

    function setPrefs(patch) {
      if (!util.isPlainObject(patch)) return false;
      const next = util.deepMerge(prefs, patch);
      if (util.deepEqual(next, prefs)) return false;
      const previous = prefs;
      prefs = next;
      const changed = Object.keys(prefs).filter((k) => !util.deepEqual(prefs[k], previous[k]));
      emitter.emit('prefs', { prefs, previous, changed });
      return true;
    }

    /** select(ids, mode). Inside a transaction it updates the transaction's selection (selAfter). */
    function select(ids, mode) {
      const m = mode || 'replace';
      const d = current ? current.state : doc;
      const base = current ? current.selection : selection;
      const list = normalizeIds(ids, d);
      let next;
      if (m === 'replace') next = list;
      else if (m === 'add') next = normalizeIds(base.concat(list), d);
      else if (m === 'remove') next = base.filter((id) => !list.includes(id));
      else if (m === 'toggle') {
        next = base.filter((id) => !list.includes(id)).concat(list.filter((id) => !base.includes(id)));
      } else throw new Error('store.select: unknown mode "' + m + '"');
      if (current) {
        if (util.deepEqual(next, base)) return false;
        current.selection = next;
        return true;
      }
      return setSelection(next);
    }

    const store = {
      get doc() { return doc; },
      get selection() { return selection; },
      get view() { return view; },
      get prefs() { return prefs; },
      get inTransaction() { return !!current; },
      get warnings() { return lastWarnings; },
      node(id) {
        return id && Object.prototype.hasOwnProperty.call(doc.nodes, id) ? doc.nodes[id] : null;
      },
      transact,
      undo, redo, canUndo, canRedo,
      history: historyInfo,
      jump, clearHistory,
      replaceDoc,
      select,
      setView,
      setPrefs,
      on: (evt, fn) => emitter.on(evt, fn),
      once: (evt, fn) => emitter.once(evt, fn),
      off: (evt, fn) => emitter.off(evt, fn),
      /** Internal: full history entries (read-only use; tests & history panel). */
      _entries: () => entries
    };
    return store;
  }

  return { create, DEFAULT_PREFS, defaultPrefs, HISTORY_CAP, COALESCE_MS };
});

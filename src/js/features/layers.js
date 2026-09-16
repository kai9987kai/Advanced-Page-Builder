/*
 * layers — the Layers panel (left side, ARCHITECTURE.md §8; PLAN C1).
 *
 * A keyed, optionally windowed tree (`role=tree`) of the current page's node graph (or of the
 * component master while `view.component` is set). Rows show the element icon, the layer name,
 * component/instance badges and per-row lock / visibility toggles.
 *
 * Rendering rules:
 *  - `store.on('change')` schedules one rAF refresh: the flat row list is rebuilt, but the DOM is
 *    reconciled by node id, so unchanged rows keep their elements (and their focus).
 *  - `store.on('selection')` never rebuilds anything: only the rows that entered or left the
 *    selection are touched, and the newest row is scrolled into view.
 *  - Above 200 visible rows only the scrolled window (plus overscan) is in the DOM; the rest is
 *    reserved with padding on the tree element, so the scrollbar still matches the full list.
 *
 * Interaction: click / Shift-click (range) / Mod-click (toggle) mirror `store.selection` both ways,
 * double-click or F2 renames inline, drag and drop reparents or reorders through `docops.reparent`
 * with a before / after / inside indicator (inside only when `elements.canContain` allows it),
 * Mod+ArrowUp/Down reorders inside the parent (`docops.zorder`), and the context menu reuses the
 * shell's canvas command list.
 */
(function () {
  'use strict';

  const VIRTUAL_MIN = 200;   // visible rows before windowed rendering kicks in
  const OVERSCAN = 8;        // rows rendered above/below the window
  const ROW_H = 26;          // fallback row height (px) — measured at runtime
  const DRAG_THRESHOLD = 4;  // px before a press becomes a drag
  const TYPEAHEAD_MS = 900;
  const MAX_NAME = 200;
  const ICON_ALIAS = { shape: 'rect' };

  APB.plugin({
    id: 'layers',
    order: 40,
    requires: ['util', 'schema', 'elements', 'widgets', 'icons'],

    init(app) {
      const util = APB.require('util');
      const schema = APB.require('schema');
      const elements = APB.require('elements');
      const widgets = APB.require('widgets');
      const icons = APB.require('icons');
      const h = widgets.h;
      const store = app.store;
      const ui = app.ui;
      if (!ui || typeof ui.registerPanel !== 'function') return;
      const docops = app.docops || (APB.has('docops') ? APB.require('docops') : null);

      /** Collapse state is per node and per session (memory only), shared across remounts. */
      const collapsed = new Set();
      let panel = null;

      ui.registerPanel({ id: 'layers', side: 'left', title: 'Layers', icon: 'layers', order: 10, mount });

      /* `edit.rename` (F2) routes here whenever this panel is loaded. */
      app.on('layers:rename', (p) => {
        const id = p && p.id;
        if (!id || !store.node(id)) return;
        try { ui.showPanel('layers'); } catch (_) { /* panel may be a drawer */ }
        const start = () => { if (panel) panel.rename(id); else promptRename(id); };
        if (panel) start();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(start);
        else start();
      });

      /* Fallback for a panel that is not registered (or could not be shown). */
      function promptRename(id) {
        const node = store.node(id);
        if (!node || typeof ui.prompt !== 'function') return;
        ui.prompt({
          title: 'Rename layer', label: 'Layer name', value: displayName(node), confirmLabel: 'Rename',
          validate: (v) => (String(v || '').trim() ? null : 'Enter a name')
        }).then((value) => {
          if (value == null || !store.node(id)) return;
          const name = String(value).trim().slice(0, MAX_NAME);
          if (name && name !== store.node(id).name) store.transact('Rename layer', (tx) => { tx.updateNode(id, { name }); });
        });
      }

      /* ================================================================ helpers */

      function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

      function elementDef(type) {
        try { return elements.get(type); } catch (_) { return null; }
      }

      function typeLabel(type) {
        const def = elementDef(type);
        return (def && def.label) || String(type || 'Element');
      }

      function displayName(node) {
        if (!node) return '';
        const name = typeof node.name === 'string' ? node.name.trim() : '';
        return name || typeLabel(node.type);
      }

      function iconName(node) {
        const def = elementDef(node && node.type);
        const shape = node && node.props && node.props.shape;
        if (node && node.type === 'shape' && shape && icons.has(String(shape))) return String(shape);
        const name = (def && def.icon) || (node && node.type) || 'frame';
        if (icons.has(name)) return name;
        const alias = ICON_ALIAS[node && node.type];
        if (alias && icons.has(alias)) return alias;
        return 'frame';
      }

      function isContainerNode(node) {
        return !!node && Array.isArray(node.children) && schema.isContainer(node.type);
      }

      function canDrop(parentNode, childNode) {
        if (!isContainerNode(parentNode) || !childNode) return false;
        try { return elements.canContain(parentNode.type, childNode.type); } catch (_) { return false; }
      }

      function componentOfRoot(doc, id) {
        const comps = doc && doc.components;
        if (!comps) return null;
        for (const key of Object.keys(comps)) if (comps[key] && comps[key].root === id) return comps[key];
        return null;
      }

      /* ==================================================================== mount */

      function mount(container) {
        let rows = [];                     // flat, visible-in-tree row descriptors
        const index = new Map();           // node id → row descriptor
        const els = new Map();             // node id → row element
        const sigs = new Map();            // node id → last rendered signature
        let selSet = new Set(store.selection);
        let query = '';
        let activeId = null;
        let anchorId = null;
        let renaming = null;
        let drag = null;
        let typeahead = { text: '', time: 0 };
        let rowHeight = ROW_H;
        let measured = false;
        let pendingFull = true;
        let destroyed = false;
        let suppressClick = false;
        let headSig = '';
        let hoverId = null;
        const offs = [];

        /* ---------------------------------------------------------------- DOM */

        const head = h('div', { class: 'apb-layers-head', hidden: true });
        const search = widgets.textField({
          ariaLabel: 'Search layers', placeholder: 'Search layers', icon: 'search', clearable: true,
          className: 'apb-layers-search-field', onInput: (value) => onSearch(value)
        });
        const tree = h('div', {
          class: 'apb-layers-tree', role: 'tree', 'aria-label': 'Layers', 'aria-multiselectable': 'true'
        });
        const indicator = h('div', { class: 'apb-layers-indicator', hidden: true, 'aria-hidden': 'true' });
        const scroll = h('div', { class: 'apb-layers-scroll' }, tree, indicator);
        const emptyBox = h('div', { class: 'apb-layers-empty', hidden: true });
        const root = h('div', { class: 'apb-layers' },
          head, h('div', { class: 'apb-layers-search' }, search), scroll, emptyBox);

        container.appendChild(root);

        /* ------------------------------------------------------------ row model */

        function treeRootId() {
          const doc = store.doc;
          const view = store.view;
          if (view.component && doc.components && own(doc.components, view.component)) {
            const master = doc.components[view.component];
            if (master && own(doc.nodes, master.root)) return master.root;
          }
          const pages = Array.isArray(doc.pages) ? doc.pages : [];
          const page = pages.find((p) => p.id === view.pageId) || pages[0] || null;
          return page && own(doc.nodes, page.root) ? page.root : null;
        }

        function matchesQuery(node, q) {
          if (!q) return true;
          if (displayName(node).toLowerCase().indexOf(q) !== -1) return true;
          if (String(node.type).toLowerCase().indexOf(q) !== -1) return true;
          return typeLabel(node.type).toLowerCase().indexOf(q) !== -1;
        }

        function buildRows() {
          const doc = store.doc;
          const bp = store.view.bp;
          const rootId = treeRootId();
          const out = [];
          if (!rootId) return out;
          const q = query.trim().toLowerCase();
          let keep = null;
          if (q) {
            keep = new Set();
            schema.walk(doc, rootId, (node) => {
              if (!matchesQuery(node, q)) return;
              keep.add(node.id);
              for (const a of schema.ancestors(doc, node.id)) keep.add(a);
            });
            if (!keep.size) return out;
            keep.add(rootId);
          }

          const visit = (id, depth, pos, size, hiddenAnc, lockedAnc) => {
            const node = doc.nodes[id];
            if (!node) return;
            const eff = schema.effectiveNode(doc, node, bp) || node;
            const hidden = !!eff.hidden;
            const locked = !!node.locked;
            const kids = Array.isArray(node.children) ? node.children : [];
            const shown = keep ? kids.filter((k) => keep.has(k)) : kids;
            const expandable = shown.length > 0;
            const expanded = expandable && (keep ? true : !collapsed.has(id));
            const comp = node.type === 'instance'
              ? (doc.components && own(doc.components, node.props && node.props.component) ? doc.components[node.props.component] : null)
              : componentOfRoot(doc, id);
            out.push({
              id, node, depth, pos, size, hidden, locked, hiddenAnc, lockedAnc, expandable, expanded,
              isRoot: id === rootId,
              badge: node.type === 'instance' ? (comp ? comp.name || 'Instance' : 'Instance') : (comp ? 'Component' : ''),
              index: out.length
            });
            if (!expanded) return;
            for (let i = 0; i < shown.length; i++) {
              visit(shown[i], depth + 1, i + 1, shown.length, hidden || hiddenAnc, locked || lockedAnc);
            }
          };
          visit(rootId, 0, 1, 1, false, false);
          return out;
        }

        function rowSignature(r) {
          return [
            displayName(r.node), r.node.type, r.depth, r.pos, r.size, r.badge,
            r.hidden ? 1 : 0, r.locked ? 1 : 0, r.hiddenAnc ? 1 : 0, r.lockedAnc ? 1 : 0,
            r.expandable ? 1 : 0, r.expanded ? 1 : 0, r.isRoot ? 1 : 0
          ].join('');
        }

        /* ------------------------------------------------------------- rendering */

        function createRow(r) {
          const twisty = h('span', { class: 'apb-layer-twisty', 'aria-hidden': 'true' });
          const typeIcon = h('span', { class: 'apb-layer-type', 'aria-hidden': 'true' });
          const name = h('span', { class: 'apb-layer-name' });
          const badge = h('span', { class: 'apb-layer-badge', hidden: true });
          const eye = h('button', { type: 'button', class: 'apb-layer-toggle apb-layer-eye', tabindex: '-1', 'aria-pressed': 'false' },
            icons.get('eye', { size: 14 }));
          const lock = h('button', { type: 'button', class: 'apb-layer-toggle apb-layer-lock', tabindex: '-1', 'aria-pressed': 'false' },
            icons.get('unlock', { size: 14 }));
          const el = h('div', {
            class: 'apb-layer', role: 'treeitem', tabindex: '-1', 'data-id': r.id, 'aria-selected': 'false'
          }, twisty, typeIcon, name, badge, h('span', { class: 'apb-layer-actions' }, eye, lock));
          el.__parts = { twisty, typeIcon, name, badge, eye, lock, icon: '', sig: '' };
          return el;
        }

        function updateRow(el, r) {
          const parts = el.__parts;
          const sig = rowSignature(r);
          if (sigs.get(r.id) !== sig) {
            sigs.set(r.id, sig);
            const label = displayName(r.node);
            el.style.setProperty('--apb-layer-depth', String(r.depth));
            el.setAttribute('aria-level', String(r.depth + 1));
            el.setAttribute('aria-posinset', String(r.pos));
            el.setAttribute('aria-setsize', String(r.size));
            if (r.expandable) el.setAttribute('aria-expanded', String(r.expanded));
            else el.removeAttribute('aria-expanded');
            el.setAttribute('aria-label', label + ', ' + typeLabel(r.node.type)
              + (r.hidden ? ', hidden' : '') + (r.locked ? ', locked' : ''));
            el.classList.toggle('is-hidden', r.hidden || r.hiddenAnc);
            el.classList.toggle('is-locked', r.locked || r.lockedAnc);
            el.classList.toggle('is-root', r.isRoot);
            el.classList.toggle('has-children', r.expandable);

            parts.twisty.replaceChildren(r.expandable
              ? icons.get(r.expanded ? 'chevron-down' : 'chevron-right', { size: 12 })
              : document.createTextNode(''));
            const icon = iconName(r.node);
            if (parts.icon !== icon) {
              parts.icon = icon;
              parts.typeIcon.replaceChildren(icons.get(icon, { size: 14 }));
            }
            if (renaming && renaming.id === r.id) parts.name.hidden = true;
            else { parts.name.hidden = false; parts.name.textContent = label; }

            parts.badge.hidden = !r.badge;
            if (r.badge) {
              parts.badge.textContent = r.badge;
              parts.badge.classList.toggle('is-instance', r.node.type === 'instance');
            }
            parts.eye.setAttribute('aria-pressed', String(r.hidden));
            parts.eye.setAttribute('aria-label', (r.hidden ? 'Show ' : 'Hide ') + label);
            parts.eye.title = r.hidden ? 'Show layer' : 'Hide layer';
            parts.eye.replaceChildren(icons.get(r.hidden ? 'eye-off' : 'eye', { size: 14 }));
            parts.lock.setAttribute('aria-pressed', String(r.locked));
            parts.lock.setAttribute('aria-label', (r.locked ? 'Unlock ' : 'Lock ') + label);
            parts.lock.title = r.locked ? 'Unlock layer' : 'Lock layer';
            parts.lock.replaceChildren(icons.get(r.locked ? 'lock' : 'unlock', { size: 14 }));
          }
          setRowSelected(el, selSet.has(r.id));
          const active = activeId === r.id;
          el.tabIndex = active ? 0 : -1;
          parts.eye.tabIndex = active ? 0 : -1;
          parts.lock.tabIndex = active ? 0 : -1;
          el.classList.toggle('is-hover', hoverId === r.id);
        }

        function setRowSelected(el, on) {
          el.setAttribute('aria-selected', String(!!on));
          el.classList.toggle('is-selected', !!on);
        }

        function windowRange(total) {
          if (total <= VIRTUAL_MIN) return { start: 0, end: total, virtual: false };
          const view = scroll.clientHeight || 400;
          const top = scroll.scrollTop;
          const start = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
          const end = Math.min(total, Math.ceil((top + view) / rowHeight) + OVERSCAN);
          return { start, end, virtual: true };
        }

        function renderWindow() {
          const total = rows.length;
          const { start, end, virtual } = windowRange(total);
          tree.style.paddingTop = virtual ? (start * rowHeight) + 'px' : '';
          tree.style.paddingBottom = virtual ? Math.max(0, (total - end) * rowHeight) + 'px' : '';
          const want = rows.slice(start, end);
          const keep = new Set(want.map((r) => r.id));
          for (const [id, el] of Array.from(els)) {
            if (keep.has(id)) continue;
            if (renaming && renaming.id === id) cancelRename();
            el.remove();
            els.delete(id);
            sigs.delete(id);
          }
          let cursor = tree.firstChild;
          for (const r of want) {
            let el = els.get(r.id);
            if (!el) { el = createRow(r); els.set(r.id, el); }
            updateRow(el, r);
            if (cursor === el) cursor = el.nextSibling;
            else tree.insertBefore(el, cursor);
          }
          if (!measured && tree.firstElementChild) {
            const hgt = tree.firstElementChild.offsetHeight;
            if (hgt > 0) { rowHeight = hgt; measured = true; }
          }
          updateEmpty();
        }

        function updateEmpty() {
          const none = rows.length === 0;
          emptyBox.hidden = !none;
          scroll.hidden = none;
          if (!none) return;
          emptyBox.replaceChildren(widgets.emptyState(query.trim()
            ? { icon: 'search', title: 'No matching layers', message: 'Nothing on this page matches “' + query.trim() + '”.' }
            : { icon: 'layers', title: 'No layers yet', message: 'Insert an element to see it here.' }));
        }

        function refresh() {
          if (destroyed) return;
          rows = buildRows();
          index.clear();
          for (let i = 0; i < rows.length; i++) { rows[i].index = i; index.set(rows[i].id, rows[i]); }
          if (activeId && !index.has(activeId)) activeId = null;
          if (!activeId && rows.length) activeId = rows[0].id;
          renderHead();
          renderWindow();
        }

        const scheduleWindow = util.rafBatch(() => {
          if (destroyed || container.hidden) return;
          renderWindow();
        });

        const scheduleRender = util.rafBatch(() => {
          if (destroyed) return;
          if (container.hidden) return;   // refreshed again by update() when the tab returns
          pendingFull = false;
          refresh();
        });

        function invalidate() {
          pendingFull = true;
          scheduleRender();
        }

        /* --------------------------------------------------------- page switcher */

        function renderHead() {
          const doc = store.doc;
          const pages = Array.isArray(doc.pages) ? doc.pages : [];
          const sig = pages.map((p) => p.id + ':' + p.name).join('') + '|' + store.view.pageId + '|' + (store.view.component || '');
          if (sig === headSig) return;
          headSig = sig;
          if (store.view.component) {
            head.hidden = true;
            head.replaceChildren();
            return;
          }
          head.hidden = false;
          const children = [icons.get('pages', { size: 14, className: 'apb-layers-page-icon' })];
          if (pages.length > 1) {
            children.push(widgets.select({
              ariaLabel: 'Page', className: 'apb-layers-page',
              options: pages.map((p) => ({ value: p.id, label: p.name || 'Page' })),
              value: store.view.pageId,
              onInput: (value) => { if (value && value !== store.view.pageId) store.setView({ pageId: value, context: null }); }
            }));
          } else if (pages.length === 1) {
            children.push(h('span', { class: 'apb-layers-page-name' }, pages[0].name || 'Page'));
          }
          children.push(widgets.iconButton({
            icon: 'plus', label: 'Add page', size: 'sm',
            onClick: () => { if (app.commands.get('pages.add')) app.commands.run('pages.add'); }
          }));
          if (app.commands.get('pages.manage')) {
            children.push(widgets.iconButton({ icon: 'folder', label: 'Manage pages', size: 'sm', onClick: () => app.commands.run('pages.manage') }));
          }
          head.replaceChildren(...children);
        }

        /* -------------------------------------------------------------- selection */

        function applySelection(prev, next) {
          selSet = new Set(next);
          const touched = new Set(prev.concat(next));
          for (const id of touched) {
            const el = els.get(id);
            if (el) setRowSelected(el, selSet.has(id));
          }
          const last = next.length ? next[next.length - 1] : null;
          if (!last || container.hidden) return;
          if (!index.has(last)) {
            if (query.trim()) return;
            let changed = false;
            for (const a of schema.ancestors(store.doc, last)) if (collapsed.delete(a)) changed = true;
            if (!changed) return;
            refresh();
          }
          scrollRowIntoView(last);
        }

        function selectRow(r, ev) {
          if (r.isRoot) {   // the page/master root is a drop target, not a selectable element
            store.select([], 'replace');
            setActive(r.id, { focus: true });
            return;
          }
          const mod = !!(ev && (ev.metaKey || ev.ctrlKey));
          const shift = !!(ev && ev.shiftKey);
          if (shift && anchorId && index.has(anchorId) && anchorId !== r.id) {
            const a = index.get(anchorId).index;
            const b = r.index;
            const ids = rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => !x.isRoot).map((x) => x.id);
            store.select(ids, 'replace');
          } else if (mod) {
            store.select([r.id], 'toggle');
            anchorId = r.id;
          } else {
            store.select([r.id], 'replace');
            anchorId = r.id;
          }
          setActive(r.id, { focus: true });
          revealInCanvas(r.id);
        }

        function revealInCanvas(id) {
          const canvas = app.canvas;
          if (!canvas || !canvas.viewport || typeof canvas.viewport.scrollToNode !== 'function') return;
          const run = () => { try { canvas.viewport.scrollToNode(id); } catch (_) { /* not rendered */ } };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else run();
        }

        /* ------------------------------------------------------ focus / roving tab */

        function setActive(id, opts) {
          const o = opts || {};
          if (activeId && activeId !== id) {
            const prev = els.get(activeId);
            if (prev) { prev.tabIndex = -1; prev.__parts.eye.tabIndex = -1; prev.__parts.lock.tabIndex = -1; }
          }
          activeId = id;
          if (o.focus !== false) scrollRowIntoView(id);
          const el = els.get(id);
          if (!el) return;
          el.tabIndex = 0;
          el.__parts.eye.tabIndex = 0;
          el.__parts.lock.tabIndex = 0;
          if (o.focus) el.focus({ preventScroll: true });
        }

        function scrollRowIntoView(id) {
          const r = index.get(id);
          if (!r) return;
          if (rows.length > VIRTUAL_MIN) {
            const top = r.index * rowHeight;
            const view = scroll.clientHeight || 0;
            if (top < scroll.scrollTop) scroll.scrollTop = top;
            else if (top + rowHeight > scroll.scrollTop + view) scroll.scrollTop = top + rowHeight - view;
            if (!els.has(id)) scheduleWindow();   // the new window renders on the next frame
            return;
          }
          const el = els.get(id);
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
        }

        function moveActive(delta, ev) {
          if (!rows.length) return;
          const cur = activeId && index.has(activeId) ? index.get(activeId).index : -1;
          const next = Math.max(0, Math.min(rows.length - 1, cur + delta));
          focusIndex(next, ev);
        }

        function focusIndex(i, ev) {
          const r = rows[i];
          if (!r) return;
          setActive(r.id, { focus: true });
          if (ev && ev.shiftKey && !r.isRoot) {
            if (!anchorId || !index.has(anchorId)) anchorId = r.id;
            const a = index.get(anchorId).index;
            const ids = rows.slice(Math.min(a, i), Math.max(a, i) + 1).filter((x) => !x.isRoot).map((x) => x.id);
            store.select(ids, 'replace');
          }
        }

        /* ------------------------------------------------------------- expansion */

        function setExpanded(id, on) {
          if (on) collapsed.delete(id); else collapsed.add(id);
          const el = els.get(id);
          if (el) el.setAttribute('aria-expanded', String(!!on));
          refresh();
        }

        function expandAll() {
          collapsed.clear();
          refresh();
        }

        function collapseAll() {
          const rootId = treeRootId();
          schema.walk(store.doc, rootId, (node) => {
            if (node.id !== rootId && Array.isArray(node.children) && node.children.length) collapsed.add(node.id);
          });
          refresh();
        }

        function expandTo(id) {
          let changed = false;
          for (const a of schema.ancestors(store.doc, id)) if (collapsed.delete(a)) changed = true;
          return changed;
        }

        /* ---------------------------------------------------------------- search */

        const applySearch = util.debounce((value) => {
          if (destroyed) return;
          query = value;
          activeId = null;
          refresh();
        }, 120);

        function onSearch(value) {
          applySearch(String(value == null ? '' : value));
        }

        /* --------------------------------------------------------------- toggles */

        function toggleHidden(r) {
          if (!docops) return;
          docops.setHidden(app, [r.id], !r.hidden);
        }

        function toggleLocked(r) {
          if (!docops) return;
          docops.setLocked(app, [r.id], !r.locked);
        }

        /* ---------------------------------------------------------------- rename */

        function startRename(id) {
          const node = store.node(id);
          if (!node) return;
          if (!index.has(id)) {
            if (query.trim()) { query = ''; search.apbControl.value = ''; }
            expandTo(id);
            refresh();
          }
          scrollRowIntoView(id);
          const el = els.get(id);
          if (!el) return;
          cancelRename();
          const parts = el.__parts;
          const input = h('input', {
            type: 'text', class: 'apb-layer-rename', 'aria-label': 'Layer name', spellcheck: 'false', autocomplete: 'off'
          });
          input.value = displayName(node);
          parts.name.hidden = true;
          el.insertBefore(input, parts.badge);
          renaming = { id, input, el };
          input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(true); }
          });
          input.addEventListener('blur', () => { if (renaming && renaming.input === input) commitRename(); });
          input.focus();
          input.select();
        }

        function finishRename(focusRow) {
          if (!renaming) return;
          const { id, input, el } = renaming;
          renaming = null;
          input.remove();
          if (el.__parts) { el.__parts.name.hidden = false; }
          sigs.delete(id);
          const r = index.get(id);
          if (r && els.has(id)) updateRow(els.get(id), r);
          if (focusRow) {
            const rowEl = els.get(id);
            if (rowEl) { setActive(id, { focus: false }); rowEl.focus({ preventScroll: true }); }
          }
        }

        function commitRename() {
          if (!renaming) return;
          const { id, input } = renaming;
          const value = String(input.value || '').trim().slice(0, MAX_NAME);
          const node = store.node(id);
          finishRename(true);
          if (!node || !value || value === (node.name || '')) return;
          store.transact('Rename layer', (tx) => { tx.updateNode(id, { name: value }); });
          if (typeof ui.announce === 'function') ui.announce('Renamed to ' + value);
        }

        function cancelRename(focusRow) {
          finishRename(!!focusRow);
        }

        /* ----------------------------------------------------------- context menu */

        /** Raw combo (e.g. 'F2') — the menu formats and announces it itself. */
        function shortcutFor(id) {
          try {
            const keys = app.commands.keysFor(id);
            return keys && keys.length ? keys[0] : null;
          } catch (_) { return null; }
        }

        function openContextMenu(ev, r) {
          ev.preventDefault();
          if (!r.isRoot && !store.selection.includes(r.id)) store.select([r.id], 'replace');
          setActive(r.id, { focus: false });
          const items = [
            { label: 'Rename', icon: 'type', shortcut: shortcutFor('edit.rename'), run: () => startRename(r.id) }
          ];
          if (r.expandable) {
            items.push({ label: r.expanded ? 'Collapse' : 'Expand', icon: r.expanded ? 'chevron-right' : 'chevron-down',
              run: () => setExpanded(r.id, !r.expanded) });
          }
          items.push({ label: 'Expand all', run: expandAll }, { label: 'Collapse all', run: collapseAll });
          let extra = [];
          if (typeof ui.contextMenuItems === 'function') {
            try { extra = ui.contextMenuItems({ nodeId: r.isRoot ? null : r.id, clientX: ev.clientX, clientY: ev.clientY }) || []; } catch (_) { extra = []; }
          }
          if (extra.length) items.push({ separator: true }, ...extra);
          ui.menu(ev, items, { label: 'Layer actions' });
        }

        /* ------------------------------------------------------------ drag & drop */

        function dragIdsFor(id) {
          const sel = store.selection.includes(id) ? store.selection.slice() : [id];
          const list = docops ? docops.topLevel(store.doc, sel) : sel;
          const rootId = treeRootId();
          return list.filter((x) => x !== rootId && store.node(x));
        }

        function subtreeSet(ids) {
          const out = new Set();
          for (const id of ids) schema.walk(store.doc, id, (n) => { out.add(n.id); });
          return out;
        }

        function makeTarget(r, pos, state) {
          const doc = store.doc;
          const node = doc.nodes[r.id];
          if (!node) return null;
          if (pos === 'inside') {
            if (!state.dragged.every((id) => canDrop(node, doc.nodes[id]))) return null;
            if (state.blocked.has(r.id)) return null;
            const kids = Array.isArray(node.children) ? node.children : [];
            const base = kids.filter((k) => !state.set.has(k));
            return { parent: r.id, index: base.length, pos, row: r };
          }
          const parentId = node.parent;
          const parent = parentId ? doc.nodes[parentId] : null;
          if (!parent || state.blocked.has(parentId)) return null;
          if (!state.dragged.every((id) => canDrop(parent, doc.nodes[id]))) return null;
          const kids = Array.isArray(parent.children) ? parent.children : [];
          const at = kids.indexOf(r.id) + (pos === 'after' ? 1 : 0);
          let idx = 0;
          for (let i = 0; i < at; i++) if (!state.set.has(kids[i])) idx++;
          return { parent: parentId, index: idx, pos, row: r };
        }

        function dropTargetAt(clientX, clientY, state) {
          const el = document.elementFromPoint(clientX, clientY);
          const rowEl = el && el.closest ? el.closest('.apb-layer') : null;
          if (rowEl && tree.contains(rowEl)) {
            const r = index.get(rowEl.dataset.id);
            if (!r) return null;
            const rect = rowEl.getBoundingClientRect();
            const rel = rect.height ? (clientY - rect.top) / rect.height : 0.5;
            const node = store.doc.nodes[r.id];
            const container2 = isContainerNode(node);
            let order = [];
            if (r.isRoot) order = ['inside'];
            else if (container2) order = rel < 0.28 ? ['before', 'inside', 'after'] : rel > 0.72 ? ['after', 'inside', 'before'] : ['inside', rel < 0.5 ? 'before' : 'after'];
            else order = rel < 0.5 ? ['before', 'after'] : ['after', 'before'];
            for (const pos of order) {
              const t = makeTarget(r, pos, state);
              if (t) return t;
            }
            return null;
          }
          const sr = scroll.getBoundingClientRect();
          if (clientX < sr.left || clientX > sr.right || clientY < sr.top || clientY > sr.bottom) return null;
          if (!rows.length) return null;
          const last = rows[rows.length - 1];
          return makeTarget(last, 'after', state) || makeTarget(rows[0], 'inside', state);
        }

        function showDropTarget(target) {
          for (const el of els.values()) el.classList.remove('is-drop-inside');
          if (!target) { indicator.hidden = true; return; }
          if (target.pos === 'inside') {
            indicator.hidden = true;
            const el = els.get(target.parent);
            if (el) el.classList.add('is-drop-inside');
            return;
          }
          const el = els.get(target.row.id);
          if (!el) { indicator.hidden = true; return; }
          indicator.hidden = false;
          indicator.style.top = (el.offsetTop + (target.pos === 'after' ? el.offsetHeight : 0)) + 'px';
          indicator.style.insetInlineStart = (8 + target.row.depth * 12) + 'px';
        }

        function beginDrag(state, ev) {
          state.active = true;
          root.classList.add('is-dragging');
          for (const id of state.dragged) {
            const el = els.get(id);
            if (el) el.classList.add('is-drag-source');
          }
          if (typeof ui.announce === 'function') ui.announce('Dragging ' + state.dragged.length + ' layer' + (state.dragged.length === 1 ? '' : 's'));
          moveDrag(state, ev);
        }

        function moveDrag(state, ev) {
          state.target = dropTargetAt(ev.clientX, ev.clientY, state);
          showDropTarget(state.target);
          const sr = scroll.getBoundingClientRect();
          if (ev.clientY < sr.top + 24) scroll.scrollTop -= 12;
          else if (ev.clientY > sr.bottom - 24) scroll.scrollTop += 12;
        }

        function endDrag(commit) {
          if (!drag) return;
          const state = drag;
          drag = null;
          detachDragListeners();
          root.classList.remove('is-dragging');
          indicator.hidden = true;
          for (const el of els.values()) el.classList.remove('is-drop-inside', 'is-drag-source');
          if (!state.active) return;
          suppressClick = true;
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { suppressClick = false; });
          else suppressClick = false;
          const t = state.target;
          if (!commit || !t || !docops) return;
          const moved = docops.reparent(app, state.dragged, t.parent, t.index);
          if (moved && moved.length) {
            collapsed.delete(t.parent);
            store.select(moved, 'replace');
            const parentName = displayName(store.node(t.parent));
            if (typeof ui.announce === 'function') ui.announce('Moved ' + moved.length + ' layer' + (moved.length === 1 ? '' : 's') + ' into ' + parentName);
          }
        }

        /* ------------------------------------------------------------- listeners */

        function rowFrom(ev) {
          const el = ev.target && ev.target.closest ? ev.target.closest('.apb-layer') : null;
          if (!el || !tree.contains(el)) return null;
          return index.get(el.dataset.id) || null;
        }

        tree.addEventListener('click', (ev) => {
          if (suppressClick) return;
          const r = rowFrom(ev);
          if (!r) return;
          if (ev.target.closest('.apb-layer-eye')) { toggleHidden(r); return; }
          if (ev.target.closest('.apb-layer-lock')) { toggleLocked(r); return; }
          if (ev.target.closest('.apb-layer-twisty')) {
            if (r.expandable) setExpanded(r.id, !r.expanded);
            return;
          }
          if (renaming && renaming.id === r.id) return;
          selectRow(r, ev);
        });

        tree.addEventListener('dblclick', (ev) => {
          const r = rowFrom(ev);
          if (!r || ev.target.closest('.apb-layer-toggle') || ev.target.closest('.apb-layer-twisty')) return;
          ev.preventDefault();
          startRename(r.id);
        });

        tree.addEventListener('contextmenu', (ev) => {
          const r = rowFrom(ev);
          if (!r) return;
          openContextMenu(ev, r);
        });

        tree.addEventListener('focusin', (ev) => {
          const r = rowFrom(ev);
          if (r && r.id !== activeId) setActive(r.id, { focus: false });
        });

        /* Pointer capture would retarget the trailing `click` to the tree, so the drag listens on
           the window instead and plain clicks keep reaching their row. */
        function onDragMove(ev) {
          if (!drag || ev.pointerId !== drag.pointerId) return;
          if (!drag.active) {
            if (Math.abs(ev.clientX - drag.startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - drag.startY) < DRAG_THRESHOLD) return;
            if (!store.selection.includes(drag.row.id)) store.select([drag.row.id], 'replace');
            beginDrag(drag, ev);
            return;
          }
          ev.preventDefault();
          moveDrag(drag, ev);
        }

        function onDragUp(ev) {
          if (!drag || ev.pointerId !== drag.pointerId) return;
          endDrag(true);
        }

        function onDragCancel() { endDrag(false); }

        function onDragKey(ev) {
          if (drag && ev.key === 'Escape') { ev.preventDefault(); endDrag(false); }
        }

        function attachDragListeners() {
          window.addEventListener('pointermove', onDragMove, { passive: false });
          window.addEventListener('pointerup', onDragUp);
          window.addEventListener('pointercancel', onDragCancel);
          window.addEventListener('keydown', onDragKey, true);
        }

        function detachDragListeners() {
          window.removeEventListener('pointermove', onDragMove, { passive: false });
          window.removeEventListener('pointerup', onDragUp);
          window.removeEventListener('pointercancel', onDragCancel);
          window.removeEventListener('keydown', onDragKey, true);
        }

        tree.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0 || renaming) return;
          const r = rowFrom(ev);
          if (!r || r.isRoot) return;
          if (ev.target.closest('.apb-layer-toggle') || ev.target.closest('.apb-layer-twisty')) return;
          const dragged = dragIdsFor(r.id);
          if (!dragged.length) return;
          const set = subtreeSet(dragged);
          drag = {
            pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false, target: null,
            dragged, set, blocked: set, row: r
          };
          attachDragListeners();
        });

        tree.addEventListener('keydown', (ev) => {
          if (renaming) return;
          const r = rowFrom(ev) || (activeId ? index.get(activeId) : null);
          const mod = ev.metaKey || ev.ctrlKey;
          const key = ev.key;
          if (drag && key === 'Escape') { endDrag(false); ev.preventDefault(); return; }
          if (mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
            ev.preventDefault();
            ev.stopPropagation();
            reorderSelection(key === 'ArrowUp' ? -1 : 1);
            return;
          }
          switch (key) {
            case 'ArrowDown': ev.preventDefault(); moveActive(1, ev); return;
            case 'ArrowUp': ev.preventDefault(); moveActive(-1, ev); return;
            case 'Home': ev.preventDefault(); focusIndex(0, ev); return;
            case 'End': ev.preventDefault(); focusIndex(rows.length - 1, ev); return;
            case 'ArrowRight':
              ev.preventDefault();
              if (!r) return;
              if (r.expandable && !r.expanded) setExpanded(r.id, true);
              else if (r.expandable) moveActive(1, null);
              return;
            case 'ArrowLeft':
              ev.preventDefault();
              if (!r) return;
              if (r.expandable && r.expanded) setExpanded(r.id, false);
              else if (r.depth > 0) {
                const parentId = r.node.parent;
                if (parentId && index.has(parentId)) setActive(parentId, { focus: true });
              }
              return;
            case 'Enter':
              ev.preventDefault();
              if (r) selectRow(r, ev);
              return;
            case ' ':
              ev.preventDefault();
              if (r && !r.isRoot) { store.select([r.id], 'toggle'); anchorId = r.id; }
              return;
            case 'F2':
              ev.preventDefault();
              ev.stopPropagation();
              if (r) startRename(r.id);
              return;
            case 'Delete':
            case 'Backspace':
              if (!r || r.isRoot) return;
              ev.preventDefault();
              ev.stopPropagation();
              if (!store.selection.includes(r.id)) store.select([r.id], 'replace');
              app.commands.run('edit.delete', { source: 'layers' });
              return;
            default:
              break;
          }
          if (!mod && !ev.altKey && key.length === 1 && key !== ' ') {
            ev.preventDefault();
            typeaheadTo(key);
          }
        });

        function typeaheadTo(ch) {
          const now = Date.now();
          typeahead.text = now - typeahead.time > TYPEAHEAD_MS ? ch.toLowerCase() : typeahead.text + ch.toLowerCase();
          typeahead.time = now;
          const startAt = activeId && index.has(activeId) ? index.get(activeId).index : -1;
          const single = typeahead.text.length === 1;
          for (let i = 1; i <= rows.length; i++) {
            const r = rows[(startAt + (single ? i : i - 1) + rows.length) % rows.length];
            if (displayName(r.node).toLowerCase().startsWith(typeahead.text)) { setActive(r.id, { focus: true }); return; }
          }
        }

        function reorderSelection(dir) {
          if (!docops) return;
          const rootId = treeRootId();
          const ids = docops.topLevel(store.doc, store.selection).filter((id) => id !== rootId);
          if (!ids.length) return;
          docops.zorder(app, ids, dir < 0 ? 'backward' : 'forward');
          if (typeof ui.announce === 'function') ui.announce(dir < 0 ? 'Moved up' : 'Moved down');
        }

        scroll.addEventListener('scroll', () => {
          if (rows.length > VIRTUAL_MIN) scheduleWindow();
        }, { passive: true });

        /* ---------------------------------------------------------- store wiring */

        offs.push(store.on('change', () => { invalidate(); }));

        offs.push(store.on('selection', (p) => {
          if (destroyed) return;
          applySelection((p && p.previous) || [], (p && p.selection) || []);
        }));

        offs.push(store.on('view', (p) => {
          if (destroyed) return;
          const changed = (p && p.changed) || [];
          if (changed.includes('pageId') || changed.includes('bp') || changed.includes('component')) { invalidate(); return; }
          if (changed.includes('hover')) {
            const next = store.view.hover;
            if (next === hoverId) return;
            const prevEl = hoverId && els.get(hoverId);
            if (prevEl) prevEl.classList.remove('is-hover');
            hoverId = next;
            const nextEl = next && els.get(next);
            if (nextEl) nextEl.classList.add('is-hover');
          }
        }));

        /* --------------------------------------------------------------- panel API */

        const api = {
          refresh,
          flush() { if (pendingFull) { pendingFull = false; refresh(); } },
          rename: startRename,
          rowIds: () => rows.map((r) => r.id),
          setQuery(value) { query = String(value || ''); refresh(); },
          expandAll,
          collapseAll,
          get activeId() { return activeId; },
          get virtual() { return rows.length > VIRTUAL_MIN; },
          get renderedCount() { return els.size; }
        };
        root.apbLayers = api;
        panel = api;

        refresh();
        if (store.selection.length) applySelection([], store.selection.slice());

        return {
          update() {
            if (destroyed) return;
            pendingFull = false;
            refresh();
            if (store.selection.length) scrollRowIntoView(store.selection[store.selection.length - 1]);
          },
          destroy() {
            destroyed = true;
            cancelRename();
            endDrag(false);
            offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
            els.clear();
            sigs.clear();
            index.clear();
            rows = [];
            if (panel === api) panel = null;
            root.remove();
          }
        };
      }
    }
  });
})();

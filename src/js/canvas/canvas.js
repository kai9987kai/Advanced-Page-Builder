/*
 * canvas — mount facade: builds the canvas DOM and combines viewport, renderer, text editing and
 * (when their modules are defined) overlay and interaction. See ARCHITECTURE.md §7.
 *
 * DOM: host > .apb-viewport[tabindex=0][role=application][aria-roledescription="design canvas"]
 *        > .apb-world (transform) > (.apb-artboard-label, .apb-artboard > page root, .apb-grid)
 *        > svg.apb-overlay (screen space)  > .apb-rulers (top, left, corner)
 *
 * One animation-frame loop drives everything in a fixed order: renderer.flush() → viewport.flush()
 * (fit, transform, grid, rulers) → overlay.refresh() → 'render'/'camera'/'frame' events.
 */
APB.define('canvas', ['util', 'events', 'schema', 'elements', 'geometry', 'commands', 'viewport', 'renderer', 'textedit'],
  function (util, events, schema, elements, geometry, commands, viewportModule, rendererModule, texteditModule) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const TOOLS = ['select', 'hand', 'frame', 'section', 'text', 'rect', 'ellipse', 'line', 'image'];
    let commandsRegistered = false;
    const menusRegistered = new WeakSet();

    /* ------------------------------------------------------------ commands */

    function registerCommands() {
      if (commandsRegistered) return;
      commandsRegistered = true;
      const has = (a) => !!(a && a.canvas && a.canvas.viewport);
      const vp = (a) => a.canvas.viewport;
      const defs = [
        { id: 'view.zoomIn', title: 'Zoom in', icon: 'zoom-in', keys: ['Mod+=', 'Mod+Shift+=', 'Mod++'], when: has, run: (a) => vp(a).zoomIn() },
        { id: 'view.zoomOut', title: 'Zoom out', icon: 'zoom-out', keys: ['Mod+-', 'Mod+Shift+-'], when: has, run: (a) => vp(a).zoomOut() },
        { id: 'view.zoom100', title: 'Zoom to 100%', icon: 'search', keys: ['Shift+0', 'Mod+0'], when: has, run: (a) => vp(a).zoomTo100() },
        { id: 'view.zoomFit', title: 'Zoom to fit page', icon: 'fit', keys: ['Shift+1'], when: has, run: (a) => vp(a).fit() },
        {
          id: 'view.zoomSelection', title: 'Zoom to selection', icon: 'fit', keys: ['Shift+2'],
          when: (a) => has(a) && a.store.selection.length > 0, run: (a) => vp(a).zoomToSelection()
        },
        {
          id: 'view.toggleGrid', title: 'Toggle grid', icon: 'grid', keys: ["Mod+'"],
          checked: (a) => !!(a && a.store.prefs.showGrid),
          run: (a) => a.store.setPrefs({ showGrid: !a.store.prefs.showGrid })
        },
        {
          id: 'view.toggleRulers', title: 'Toggle rulers', icon: 'ruler', keys: ['Shift+R'],
          checked: (a) => !!(a && a.store.prefs.showRulers !== false),
          run: (a) => a.store.setPrefs({ showRulers: a.store.prefs.showRulers === false })
        }
      ];
      for (const d of defs) {
        if (!commands.get(d.id)) commands.register(Object.assign({ category: 'View' }, d));
      }
    }

    function registerMenus(app) {
      const ui = app.ui;
      if (!ui || typeof ui.registerMenuItem !== 'function' || menusRegistered.has(ui)) return;
      menusRegistered.add(ui);
      const items = [
        ['view.zoomIn', 10], ['view.zoomOut', 11], ['view.zoom100', 12], ['view.zoomFit', 13], ['view.zoomSelection', 14],
        ['view.toggleGrid', 20, true], ['view.toggleRulers', 21]
      ];
      for (const [command, order, separatorBefore] of items) {
        try { ui.registerMenuItem({ menu: 'view', command, order, separatorBefore: !!separatorBefore }); } catch (_) { /* optional */ }
      }
    }

    /* --------------------------------------------------------------- mount */

    function mount(host, app) {
      if (!host || !app || !app.store) throw new TypeError('canvas.mount(host, app) needs a host element and the app');
      const store = app.store;
      const doc = host.ownerDocument || document;
      const win = doc.defaultView || window;
      const emitter = new events.Emitter();
      const offs = [];
      let destroyed = false;
      let frameId = 0;
      let overlayDirty = true;
      let selBounds;

      function h(tag, cls, attrs) {
        const e = doc.createElement(tag);
        if (cls) e.className = cls;
        if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
        return e;
      }

      if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';

      const hintId = util.uid('apb-canvas-hint');
      const el = h('div', 'apb-viewport', {
        tabindex: '0', role: 'application', 'aria-roledescription': 'design canvas',
        'aria-label': 'Design canvas', 'aria-describedby': hintId, 'data-tool': store.view.tool || 'select'
      });
      const world = h('div', 'apb-world');
      const label = h('div', 'apb-artboard-label', { 'aria-hidden': 'true' });
      const artboard = h('div', 'apb-artboard');
      const grid = h('div', 'apb-grid', { 'aria-hidden': 'true' });
      world.append(label, artboard, grid);
      const overlayEl = doc.createElementNS(SVG_NS, 'svg');
      overlayEl.setAttribute('class', 'apb-overlay');
      overlayEl.setAttribute('aria-hidden', 'true');
      overlayEl.setAttribute('focusable', 'false');
      const rulers = h('div', 'apb-rulers', { 'aria-hidden': 'true' });
      const hint = h('p', 'apb-canvas-hint', { id: hintId });
      hint.textContent = 'Scroll to pan. Hold ' + (app.env && app.env.mac ? 'Command' : 'Control') +
        ' and scroll, or pinch, to zoom. Hold Space and drag, or drag with the middle mouse button, to pan. ' +
        'Shift+1 fits the page, Shift+0 zooms to 100%.';
      el.append(world, overlayEl, rulers, hint);

      /* ------------------------------------------------------- frame loop */

      const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (fn) => setTimeout(fn, 16);
      const caf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : clearTimeout;

      function requestFrame() {
        if (!frameId && !destroyed) frameId = raf(frame);
      }

      function frame() {
        frameId = 0;
        if (destroyed) return;
        let rendered = null;
        let moved = false;
        try { rendered = renderer.flush(); } catch (err) { console.error('[APB] canvas render failed:', err); }
        if (rendered) { selBounds = undefined; viewport.invalidateRulers(false); }
        try { moved = viewport.flush(); } catch (err) { console.error('[APB] canvas viewport update failed:', err); }
        if (rendered || moved || overlayDirty) {
          overlayDirty = false;
          const ov = api.overlay;
          if (ov && typeof ov.refresh === 'function') {
            try { ov.refresh({ rendered: !!rendered, camera: moved }); } catch (err) { console.error('[APB] overlay refresh failed:', err); }
          }
          if (rendered) emitter.emit('render', rendered);
          if (moved) emitter.emit('camera', viewport.camera());
          emitter.emit('frame', { rendered, camera: moved });
        }
      }

      function selectionBounds() {
        const ov = api.overlay;
        if (ov && typeof ov.selectionBounds === 'function') return ov.selectionBounds();
        if (selBounds !== undefined) return selBounds;
        const ids = store.selection;
        selBounds = ids.length ? renderer.bounds(ids) : null;
        return selBounds;
      }

      /* ---------------------------------------------------------- modules */

      // Guard listeners first (capture): content never activates, focus goes to the canvas.
      function inEditor(t) {
        const te = api.textedit;
        const hostEl = te && te.host ? te.host() : null;
        return !!(hostEl && t && hostEl.contains(t));
      }

      function onPointerDownGuard(e) {
        const t = e.target;
        const te = api.textedit;
        if (te && te.active() && !inEditor(t)) te.stop(true);
        if (inEditor(t)) return;
        if (artboard.contains(t)) e.preventDefault();
        if (!rulers.contains(t) && doc.activeElement !== el && typeof el.focus === 'function') el.focus({ preventScroll: true });
      }

      function onClickGuard(e) {
        if (artboard.contains(e.target) && !inEditor(e.target)) e.preventDefault();
      }

      function onFocusInGuard(e) {
        if (artboard.contains(e.target) && !inEditor(e.target)) el.focus({ preventScroll: true });
      }

      function listen(target, type, fn, options) {
        target.addEventListener(type, fn, options);
        offs.push(() => target.removeEventListener(type, fn, options));
      }

      listen(el, 'pointerdown', onPointerDownGuard, true);
      listen(el, 'click', onClickGuard, true);
      listen(el, 'auxclick', onClickGuard, true);
      listen(el, 'submit', (e) => e.preventDefault(), true);
      listen(el, 'dragstart', (e) => { if (!inEditor(e.target)) e.preventDefault(); }, true);
      listen(el, 'focusin', onFocusInGuard);

      host.appendChild(el);

      const renderer = rendererModule.create({
        app, artboard, requestFrame,
        onRender: () => {
          selBounds = undefined;
          let ov = null;
          try { ov = api.overlay; } catch (_) { ov = null; } // api is created after the renderer
          if (ov && typeof ov.markStale === 'function') ov.markStale();
        }
      });

      const viewport = viewportModule.create({
        app, el, world, artboard, grid, label, rulers, requestFrame,
        getSelectionBounds: selectionBounds,
        getNodeBounds: (id) => renderer.bounds([id]),
        beforeMeasure: () => { renderer.flush(); }
      });

      const api = {
        el, host, world, artboard, grid, label, overlayEl, rulersEl: rulers,
        renderer, viewport,
        overlay: { refresh() {}, destroy() {} },
        textedit: null,
        interaction: null,
        setTool, insertAtViewportCenter, startTextEdit, stopTextEdit,
        requestFrame, invalidateOverlay, selectionBounds,
        on: (evt, fn) => emitter.on(evt, fn),
        off: (evt, fn) => emitter.off(evt, fn),
        destroy
      };
      app.canvas = api;

      api.textedit = texteditModule.create({ app, canvas: api });

      function optionalFactory(name) {
        if (typeof APB === 'undefined' || !APB.has(name)) return null;
        try {
          const mod = APB.require(name);
          return mod && typeof mod.create === 'function' ? mod.create({ app, canvas: api }) : null;
        } catch (err) {
          console.error('[APB] canvas module "' + name + '" failed to start:', err);
          return null;
        }
      }

      /* ---------------------------------------------------------- helpers */

      function updateLabels() {
        const d = store.doc;
        const v = store.view;
        const bps = (d.settings && d.settings.breakpoints) || schema.DEFAULT_BREAKPOINTS;
        const bp = bps.find((b) => b.id === v.bp) || bps[0];
        const comps = d.components || {};
        const comp = typeof v.component === 'string' && Object.prototype.hasOwnProperty.call(comps, v.component) ? comps[v.component] : null;
        let name;
        if (comp) name = 'Component: ' + (comp.name || 'Untitled');
        else {
          const page = (d.pages || []).find((p) => p.id === v.pageId) || (d.pages || [])[0];
          name = page ? page.name || 'Untitled page' : 'No page';
        }
        const bpText = bp ? (bp.label || bp.id) + ' ' + bp.width : '';
        const text = bpText ? name + ' · ' + bpText : name;
        if (label.textContent !== text) label.textContent = text;
        el.setAttribute('aria-label', 'Design canvas: ' + text);
        const width = !comp && bp && Number.isFinite(bp.width) ? bp.width + 'px' : '';
        if (artboard.style.width !== width) artboard.style.width = width;
      }

      function invalidateOverlay() {
        overlayDirty = true;
        requestFrame();
      }

      function setTool(tool) {
        const t = typeof tool === 'string' && tool ? tool : 'select';
        if (!TOOLS.includes(t) && !/^[\w.-]{1,40}$/.test(t)) return false;
        if (api.textedit && api.textedit.active()) api.textedit.stop(true);
        store.setView({ tool: t });
        el.setAttribute('data-tool', t);
        return true;
      }

      function startTextEdit(id) {
        return api.textedit ? api.textedit.start(id) : false;
      }

      function stopTextEdit(commit) {
        return api.textedit ? api.textedit.stop(commit) : false;
      }

      function specsBounds(list) {
        const rects = list.map((s) => {
          const probe = schema.createNode(s.type || 'frame', util.omit(s, ['children', 'parent', 'id']));
          return { x: 0, y: 0, w: Number(probe.w) || 0, h: Number(probe.h) || 0 };
        });
        return geometry.union(rects);
      }

      function localPoint(parentId, pt) {
        const pr = renderer.worldRect(parentId);
        if (!pr) return null;
        const pel = renderer.el(parentId);
        const c = { x: pr.x + pr.w / 2, y: pr.y + pr.h / 2 };
        const p = pr.rotation ? geometry.rotatePoint(pt, c, -pr.rotation) : pt;
        const bl = pel && Number.isFinite(pel.clientLeft) ? pel.clientLeft : 0;
        const bt = pel && Number.isFinite(pel.clientTop) ? pel.clientTop : 0;
        return { x: p.x - pr.x - bl, y: p.y - pr.y - bt, w: pr.w - 2 * bl, h: pr.h - 2 * bt };
      }

      function stackIndex(parentId, peff, pt) {
        const row = peff.layout && peff.layout.dir === 'row';
        let index = 0;
        for (const cid of peff.children || []) {
          const r = renderer.worldRect(cid);
          if (!r) continue;
          const mid = row ? r.x + r.w / 2 : r.y + r.h / 2;
          if (mid < (row ? pt.x : pt.y)) index = (peff.children.indexOf(cid)) + 1;
        }
        return index;
      }

      /**
       * insertAtViewportCenter(specs, opts) → ids. Inserts into the deepest container under the viewport
       * centre that accepts every spec (fallback: docops default parent), centred on that point (free
       * parents, clamped inside the parent) or at the matching index (stack parents).
       */
      function insertAtViewportCenter(specs, opts) {
        const list = (Array.isArray(specs) ? specs : [specs]).filter(util.isPlainObject);
        if (!list.length || !app.docops) return [];
        renderer.flush();
        const d = store.doc;
        const types = list.map((s) => s.type || 'frame');
        const accepts = (id) => {
          const n = Object.prototype.hasOwnProperty.call(d.nodes, id) ? d.nodes[id] : null;
          return !!n && Array.isArray(n.children) && !app.docops.isLocked(d, id) && types.every((t) => elements.canContain(n.type, t));
        };
        const c = viewport.contentRect();
        const cx = c.left + c.width / 2;
        const cy = c.top + c.height / 2;
        const pt = viewport.screenToPage(cx, cy);
        let parent = null;
        if (c.width > 0 && c.height > 0) parent = renderer.nodeAt(cx, cy, { deep: true, filter: accepts });
        if (!parent) {
          const rootId = renderer.rootId;
          const root = rootId ? d.nodes[rootId] : null;
          if (root && types.every((t) => t !== 'section')) {
            const ctx = store.view.context;
            if (ctx && accepts(ctx)) parent = ctx;
            else {
              let best = null;
              let bestDist = Infinity;
              for (const cid of root.children || []) {
                if (!accepts(cid)) continue;
                const r = renderer.worldRect(cid);
                if (!r) continue;
                const dist = pt.y < r.y ? r.y - pt.y : pt.y > r.y + r.h ? pt.y - (r.y + r.h) : 0;
                if (dist < bestDist) { bestDist = dist; best = cid; }
              }
              parent = best || (rootId && accepts(rootId) ? rootId : null);
            }
          } else if (rootId && accepts(rootId)) {
            parent = rootId;
          }
        }
        if (!parent) return app.docops.insert(store, list, opts);
        const peff = schema.effectiveNode(d, parent, store.view.bp) || d.nodes[parent];
        const insertOpts = Object.assign({ parent }, opts || {});
        if (peff.layout && peff.layout.mode === 'stack') {
          if (!Number.isFinite(insertOpts.index)) insertOpts.index = stackIndex(parent, peff, pt);
        } else if (!insertOpts.at) {
          const lp = localPoint(parent, pt);
          if (lp) {
            const B = specsBounds(list);
            const x = lp.w > B.w ? util.clamp(lp.x, B.w / 2, lp.w - B.w / 2) : lp.w / 2;
            const y = lp.h > B.h ? util.clamp(lp.y, B.h / 2, lp.h - B.h / 2) : B.h / 2;
            insertOpts.at = { x: Math.round(x), y: Math.round(y) };
            insertOpts.anchor = 'center';
          }
        }
        return app.docops.insert(store, list, insertOpts);
      }

      /* ----------------------------------------------------------- events */

      offs.push(store.on('change', (p) => {
        if (p.source === 'replace') viewport.reset();
        if (p.global || p.source === 'replace') updateLabels();
        selBounds = undefined;
        overlayDirty = true;
        requestFrame();
      }));

      offs.push(store.on('selection', () => {
        selBounds = undefined;
        overlayDirty = true;
        viewport.invalidateRulers(false);
        requestFrame();
      }));

      offs.push(store.on('view', (p) => {
        const ch = p.changed || [];
        if (ch.includes('pageId') || ch.includes('bp') || ch.includes('component')) {
          updateLabels();
          selBounds = undefined;
          viewport.invalidateRulers(false);
        }
        if (ch.some((k) => k !== 'zoom' && k !== 'x' && k !== 'y')) overlayDirty = true;
        requestFrame();
      }));

      function destroy() {
        if (destroyed) return;
        for (const part of [api.interaction, api.overlay, api.textedit]) {
          if (part && typeof part.destroy === 'function') {
            try { part.destroy(); } catch (err) { console.error('[APB] canvas part failed to stop:', err); }
          }
        }
        destroyed = true;
        if (frameId) caf(frameId);
        frameId = 0;
        offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
        viewport.destroy();
        renderer.destroy();
        el.remove();
        if (app.canvas === api) app.canvas = null;
        emitter.emit('destroy', {});
      }

      /* ------------------------------------------------------------ start */

      updateLabels();
      renderer.renderAll();
      api.overlay = optionalFactory('overlay') || api.overlay;
      api.interaction = optionalFactory('interaction');
      registerCommands();
      registerMenus(app);
      requestFrame();
      return api;
    }

    return { mount, TOOLS };
  });

/*
 * shell — the editor frame and the `app.ui` API (ARCHITECTURE.md §8): toolbar (main menu, project name, tools, slots,
 * undo/redo, zoom menu), left/right tab panels with lazy mounting and badges, resizable splitters, collapsible panels
 * (Mod+\) that turn into drawers below 900 px, status bar (selection summary, snapping, zoom, theme), theme application,
 * main menus built from registerMenuItem and the canvas context menu (`canvas:contextmenu`).
 * shell.mount(root, app) → ui
 */
APB.define('shell', ['env', 'util', 'schema', 'commands', 'widgets', 'icons', 'dialogs'],
  function (env, util, schema, commands, widgets, icons, dialogs) {
    'use strict';

    const { h } = widgets;
    const isFn = (v) => typeof v === 'function';

    const MENUS = [['file', 'File'], ['edit', 'Edit'], ['view', 'View'], ['insert', 'Insert'], ['arrange', 'Arrange'], ['help', 'Help']];
    const TOOL_LABELS = {
      select: 'Select', hand: 'Hand', frame: 'Frame', section: 'Section', text: 'Text', rect: 'Rectangle',
      ellipse: 'Ellipse', line: 'Line', image: 'Image'
    };
    const THEMES = ['system', 'light', 'dark'];
    const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
    const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' };
    const WIDTH = { min: 200, max: 640, left: 280, right: 300, step: 10, bigStep: 50 };
    const COMPACT_QUERY = '(max-width: 899.98px)';
    const CONTEXT_GROUPS = [
      ['edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.delete'],
      ['arrange.group', 'arrange.ungroup', 'arrange.wrapStack'],
      ['arrange.bringForward', 'arrange.sendBackward', 'arrange.bringToFront', 'arrange.sendToBack'],
      ['arrange.lock', 'arrange.hide'],
      ['component.create'],
      ['view.zoomSelection']
    ];

    let seq = 0;
    const byOrder = (a, b) => ((a.order == null ? 100 : a.order) - (b.order == null ? 100 : b.order)) || (a.seq - b.seq);
    const safeId = (id) => String(id).replace(/[^\w-]/g, '_');

    function applyTheme(theme) {
      const t = THEMES.includes(theme) ? theme : 'system';
      if (typeof document !== 'undefined' && document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
      return t;
    }

    function fmtNum(v) {
      if (typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v * 100) / 100);
      return v == null || v === '' ? '–' : String(v);
    }

    function mount(root, app) {
      if (!root || !app || !app.store) throw new TypeError('shell.mount(root, app) needs a root element and the app');
      const store = app.store;
      const offs = [];
      const listen = (target, type, fn, opts) => {
        target.addEventListener(type, fn, opts);
        offs.push(() => target.removeEventListener(type, fn, opts));
      };
      const reg = { panels: new Map(), toolbar: new Map(), status: new Map(), menu: [], inspector: new Map() };
      const canvasModule = APB.has('canvas') ? APB.require('canvas') : null;

      applyTheme(store.prefs.theme);

      /* ------------------------------------------------------------ frame batching */
      const flags = new Set();
      let raf = 0;
      function schedule(flag) {
        flags.add(flag);
        if (!raf) raf = requestAnimationFrame(flush);
      }
      function flush() {
        raf = 0;
        const f = new Set(flags);
        flags.clear();
        if (f.has('status')) renderSelection();
        if (f.has('history')) renderHistory();
        if (f.has('zoom')) renderZoom();
        if (f.has('badges')) renderBadges();
        if (f.has('name')) renderName();
        if (f.has('shortcuts')) renderShortcuts();
      }

      function runOr(id, fallback, args) {
        if (commands.get(id)) return commands.run(id, Object.assign({ source: 'ui' }, args));
        return isFn(fallback) ? fallback() : undefined;
      }

      /* =============================================================== toolbar */
      while (root.firstChild) root.removeChild(root.firstChild);
      root.classList.add('apb-app');

      const menuBtn = widgets.iconButton({ icon: 'menu', label: 'Main menu', className: 'apb-appmenu-btn', onClick: () => toggleMainMenu() });
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      listen(menuBtn, 'keydown', (e) => {
        if (e.key === 'ArrowDown' && !e.altKey) { e.preventDefault(); openMainMenu(); }
      });

      const nameInput = h('input', {
        type: 'text', class: 'apb-project-name', 'aria-label': 'Project name', spellcheck: 'false', autocomplete: 'off', maxlength: '120'
      });
      nameInput.value = store.doc.name || 'Untitled';
      let nameEscaped = false;
      function commitName() {
        const raw = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 120);
        const next = raw || store.doc.name || 'Untitled';
        nameInput.value = next;
        if (next !== store.doc.name) {
          store.transact('Rename project', (tx) => tx.setDocField('name', next));
          dialogs.announce('Project renamed to ' + next);
        }
      }
      listen(nameInput, 'focus', () => { nameEscaped = false; nameInput.select(); });
      listen(nameInput, 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitName(); nameInput.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nameEscaped = true; nameInput.value = store.doc.name; nameInput.blur(); }
      });
      listen(nameInput, 'blur', () => { if (!nameEscaped) commitName(); nameEscaped = false; });

      const tools = (canvasModule && Array.isArray(canvasModule.TOOLS) ? canvasModule.TOOLS : Object.keys(TOOL_LABELS)).slice();
      const toolsGroup = h('div', { class: 'apb-toolbar-group apb-tools', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'horizontal' });
      const toolBtns = new Map();
      function setTool(t) {
        if (commands.get('tool.' + t) && commands.enabled('tool.' + t)) commands.run('tool.' + t, { source: 'toolbar' });
        else if (app.canvas && isFn(app.canvas.setTool)) app.canvas.setTool(t);
        else store.setView({ tool: t });
        if (store.view.tool !== t) store.setView({ tool: t });
      }
      for (const t of tools) {
        const label = TOOL_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1));
        const btn = widgets.iconButton({ icon: icons.has(t) ? t : 'select', label, pressed: store.view.tool === t, className: 'apb-tool-btn', onClick: () => setTool(t) });
        btn.setAttribute('data-tool', t);
        btn.tabIndex = -1;
        toolBtns.set(t, btn);
        toolsGroup.appendChild(btn);
      }
      listen(toolsGroup, 'keydown', (e) => {
        const list = Array.from(toolBtns.values());
        const i = list.indexOf(document.activeElement);
        if (i < 0) return;
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % list.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = list.length - 1;
        if (next < 0) return;
        e.preventDefault();
        list.forEach((b, k) => { b.tabIndex = k === next ? 0 : -1; });
        list[next].focus();
      });
      function renderTools() {
        const current = store.view.tool || 'select';
        let any = false;
        toolBtns.forEach((btn, t) => {
          const on = t === current;
          btn.setAttribute('aria-pressed', String(on));
          if (on) any = true;
          if (!toolsGroup.contains(document.activeElement)) btn.tabIndex = on ? 0 : -1;
        });
        if (!any && toolBtns.size && !toolsGroup.contains(document.activeElement)) toolBtns.values().next().value.tabIndex = 0;
      }

      const slotStart = h('div', { class: 'apb-toolbar-slot apb-toolbar-slot--start', 'data-area': 'start' });
      const slotCenter = h('div', { class: 'apb-toolbar-slot apb-toolbar-slot--center', 'data-area': 'center' });
      const slotEnd = h('div', { class: 'apb-toolbar-slot apb-toolbar-slot--end', 'data-area': 'end' });

      const undoBtn = widgets.iconButton({ icon: 'undo', label: 'Undo', className: 'apb-undo-btn', onClick: () => runOr('edit.undo', () => store.undo()) });
      const redoBtn = widgets.iconButton({ icon: 'redo', label: 'Redo', className: 'apb-redo-btn', onClick: () => runOr('edit.redo', () => store.redo()) });
      const historyGroup = h('div', { class: 'apb-toolbar-group', role: 'group', 'aria-label': 'History' }, undoBtn, redoBtn);

      const zoomText = h('span', { class: 'apb-zoom-value' }, '100%');
      const zoomBtn = h('button', { type: 'button', class: 'apb-btn apb-btn--ghost apb-btn--md apb-zoom-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
        h('span', { class: 'apb-sr-only' }, 'Zoom '), zoomText, icons.get('chevron-down', { size: 14 }));
      widgets.tooltip(zoomBtn, { label: 'Zoom options' });
      listen(zoomBtn, 'click', () => openZoomMenu(zoomBtn, 'bottom-end'));

      const toolbarStart = h('div', { class: 'apb-toolbar-start' }, menuBtn, nameInput, h('span', { class: 'apb-toolbar-sep', 'aria-hidden': 'true' }), toolsGroup, slotStart);
      const toolbarCenter = h('div', { class: 'apb-toolbar-center' }, slotCenter);
      const toolbarEnd = h('div', { class: 'apb-toolbar-end' }, historyGroup, zoomBtn, slotEnd);
      const toolbar = h('header', { class: 'apb-toolbar' }, toolbarStart, toolbarCenter, toolbarEnd);

      /* ================================================================= sides */
      const shellEl = h('div', { class: 'apb-shell' });
      const canvasHost = h('main', { class: 'apb-canvas-host', id: 'apb-canvas-host', 'aria-label': 'Canvas' });
      const scrim = h('div', { class: 'apb-drawer-scrim', hidden: true });
      const sides = {};
      let compact = false;
      let drawer = null;

      function createSide(side) {
        const title = side === 'left' ? 'Left panel' : 'Right panel';
        const s = { side, recs: [], active: null };
        s.el = h('aside', { class: 'apb-side apb-side--' + side, id: 'apb-side-' + side, 'aria-label': title, hidden: true });
        s.tablist = h('div', { class: 'apb-tabs', role: 'tablist', 'aria-label': title + ' tabs', 'aria-orientation': 'horizontal' });
        s.hideBtn = widgets.iconButton({ icon: side === 'left' ? 'chevron-left' : 'chevron-right', label: 'Hide ' + title.toLowerCase(), size: 'sm',
          className: 'apb-side-hide', onClick: () => togglePanel(side) });
        s.body = h('div', { class: 'apb-side-body' });
        s.el.append(h('div', { class: 'apb-side-header' }, s.tablist, s.hideBtn), s.body);
        s.splitter = h('div', {
          class: 'apb-splitter apb-splitter--' + side, role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
          'aria-label': 'Resize ' + title.toLowerCase(), 'aria-controls': s.el.id, 'aria-valuemin': String(WIDTH.min),
          'aria-valuemax': String(WIDTH.max), hidden: true
        });
        s.toggle = widgets.iconButton({ icon: side === 'left' ? 'layers' : 'design', label: title, className: 'apb-side-toggle apb-side-toggle--' + side,
          onClick: () => togglePanel(side) });
        s.toggle.setAttribute('aria-controls', s.el.id);
        s.toggle.setAttribute('aria-expanded', 'false');
        s.toggle.hidden = true;

        listen(s.tablist, 'keydown', (e) => {
          const tabs = s.recs.map((r) => r.tab);
          const i = tabs.indexOf(document.activeElement);
          if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
          let next = -1;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabs.length - 1;
          if (next < 0) return;
          e.preventDefault();
          activate(s, s.recs[next].id, { focus: true, persist: true });
        });
        listen(s.el, 'keydown', (e) => {
          if (e.key === 'Escape' && compact && drawer === side && !e.defaultPrevented) {
            e.preventDefault();
            closeDrawer(true);
          }
        });
        setupSplitter(s);
        sides[side] = s;
        return s;
      }

      function widthOf(side) {
        const v = Number(store.prefs[side + 'Width']);
        return util.clamp(Number.isFinite(v) ? v : WIDTH[side], WIDTH.min, WIDTH.max);
      }

      function applyWidth(side, w) {
        const s = sides[side];
        const px = Math.round(util.clamp(w, WIDTH.min, WIDTH.max));
        shellEl.style.setProperty('--apb-' + side + '-w', px + 'px');
        s.splitter.setAttribute('aria-valuenow', String(px));
        s.splitter.setAttribute('aria-valuetext', px + ' pixels');
        return px;
      }

      function setupSplitter(s) {
        const key = s.side + 'Width';
        const dir = s.side === 'left' ? 1 : -1;
        let drag = null;
        let pending = 0;
        let frame = 0;
        listen(s.splitter, 'pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          try { s.splitter.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
          drag = { x: e.clientX, w: widthOf(s.side), id: e.pointerId };
          pending = drag.w;
          shellEl.classList.add('is-resizing');
          s.splitter.focus({ preventScroll: true });
        });
        listen(s.splitter, 'pointermove', (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          pending = util.clamp(drag.w + (e.clientX - drag.x) * dir, WIDTH.min, WIDTH.max);
          if (!frame) frame = requestAnimationFrame(() => { frame = 0; applyWidth(s.side, pending); });
        });
        const end = (e) => {
          if (!drag || (e && e.pointerId !== drag.id)) return;
          drag = null;
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
          shellEl.classList.remove('is-resizing');
          store.setPrefs({ [key]: Math.round(pending) });
          applyWidth(s.side, widthOf(s.side));
        };
        listen(s.splitter, 'pointerup', end);
        listen(s.splitter, 'pointercancel', end);
        listen(s.splitter, 'lostpointercapture', end);
        listen(s.splitter, 'dblclick', () => store.setPrefs({ [key]: WIDTH[s.side] }));
        listen(s.splitter, 'keydown', (e) => {
          const step = e.shiftKey ? WIDTH.bigStep : WIDTH.step;
          const cur = widthOf(s.side);
          let next = null;
          if (e.key === 'ArrowRight') next = cur + step * dir;
          else if (e.key === 'ArrowLeft') next = cur - step * dir;
          else if (e.key === 'Home') next = WIDTH.min;
          else if (e.key === 'End') next = WIDTH.max;
          else if (e.key === 'Enter') next = WIDTH[s.side];
          if (next == null) return;
          e.preventDefault();
          store.setPrefs({ [key]: Math.round(util.clamp(next, WIDTH.min, WIDTH.max)) });
        });
      }

      createSide('left');
      createSide('right');

      function sideVisible(side) {
        const s = sides[side];
        if (!s.recs.length) return false;
        return compact ? drawer === side : !store.prefs[side + 'Collapsed'];
      }

      function renderSides() {
        for (const side of ['left', 'right']) {
          const s = sides[side];
          const visible = sideVisible(side);
          const wasHidden = s.el.hidden;
          if (!visible && s.el.contains(document.activeElement)) s.toggle.hidden ? canvasFocus() : s.toggle.focus({ preventScroll: true });
          s.el.hidden = !visible;
          s.splitter.hidden = !visible || compact;
          s.toggle.hidden = !s.recs.length;
          s.toggle.setAttribute('aria-expanded', String(visible));
          s.toggle.setAttribute('aria-pressed', String(visible));
          s.hideBtn.apbControl.setLabel((compact ? 'Close ' : 'Hide ') + (side === 'left' ? 'left panel' : 'right panel'));
          shellEl.setAttribute('data-' + side, visible ? 'open' : 'closed');
          if (visible && wasHidden) {
            const rec = reg.panels.get(s.active);
            if (rec) { ensureMounted(rec); updatePanel(rec); }
          }
        }
        scrim.hidden = !(compact && drawer);
      }

      function canvasFocus() {
        const vp = app.canvas && app.canvas.el;
        if (vp && isFn(vp.focus)) vp.focus({ preventScroll: true });
      }

      function setCollapsed(side, collapsed) {
        store.setPrefs({ [side + 'Collapsed']: !!collapsed });
        renderSides();
      }

      function openDrawer(side, focus) {
        if (!sides[side] || !sides[side].recs.length) return;
        drawer = side;
        renderSides();
        if (focus !== false) {
          const rec = reg.panels.get(sides[side].active);
          if (rec) rec.tab.focus({ preventScroll: true });
        }
      }

      function closeDrawer(returnFocus) {
        const was = drawer;
        if (!was) return;
        const hadFocus = sides[was].el.contains(document.activeElement);
        drawer = null;
        renderSides();
        if (returnFocus || hadFocus) sides[was].toggle.focus({ preventScroll: true });
      }

      function togglePanel(side) {
        if (compact) {
          if (drawer === side) closeDrawer(true);
          else openDrawer(side);
        } else {
          setCollapsed(side, !store.prefs[side + 'Collapsed']);
          if (!store.prefs[side + 'Collapsed']) dialogs.announce((side === 'left' ? 'Left' : 'Right') + ' panel shown');
          else dialogs.announce((side === 'left' ? 'Left' : 'Right') + ' panel hidden');
        }
      }

      function togglePanels() {
        if (compact) {
          if (drawer) closeDrawer(true);
          else openDrawer(sides.left.recs.length ? 'left' : 'right');
          return;
        }
        const anyVisible = sideVisible('left') || sideVisible('right');
        store.setPrefs({ leftCollapsed: anyVisible, rightCollapsed: anyVisible });
        renderSides();
        dialogs.announce(anyVisible ? 'Panels hidden' : 'Panels shown');
      }

      /* ---------------------------------------------------------------- panels */
      function ensureMounted(rec) {
        if (rec.mounted) return;
        rec.mounted = true;
        try {
          rec.instance = rec.def.mount(rec.container, app) || null;
        } catch (err) {
          console.error('[APB] panel "' + rec.id + '" failed to mount:', err);
          if (isFn(app.log)) app.log('Panel "' + rec.id + '" failed: ' + (err && err.message), { level: 'error' });
          rec.container.replaceChildren(widgets.emptyState({ icon: 'warning', title: 'This panel could not be loaded', message: String(err && err.message || err) }));
        }
      }

      function updatePanel(rec) {
        if (rec.instance && isFn(rec.instance.update)) {
          try { rec.instance.update(); } catch (err) { console.error('[APB] panel "' + rec.id + '" update failed:', err); }
        }
      }

      function activate(s, id, opts) {
        const o = opts || {};
        const rec = reg.panels.get(id);
        s.active = rec && rec.side === s.side ? id : null;
        for (const r of s.recs) {
          const on = r.id === s.active;
          r.tab.setAttribute('aria-selected', String(on));
          r.tab.tabIndex = on ? 0 : -1;
          r.container.hidden = !on;
        }
        if (!s.active) return;
        if (!s.el.hidden) { ensureMounted(rec); updatePanel(rec); }
        if (o.focus) rec.tab.focus({ preventScroll: true });
        if (o.persist && store.prefs[s.side + 'Tab'] !== id) store.setPrefs({ [s.side + 'Tab']: id });
      }

      function renderTabs(s) {
        s.recs = Array.from(reg.panels.values()).filter((r) => r.side === s.side).sort(byOrder);
        s.tablist.replaceChildren(...s.recs.map((r) => r.tab));
        const pref = store.prefs[s.side + 'Tab'];
        let active = null;
        if (s.recs.some((r) => r.id === pref)) active = pref;
        else if (s.recs.some((r) => r.id === s.active)) active = s.active;
        else if (s.recs.length) active = s.recs[0].id;
        renderSides();
        activate(s, active, { persist: false });
      }

      function registerPanel(def) {
        if (!def || typeof def.id !== 'string' || !def.id || !isFn(def.mount)) throw new TypeError('ui.registerPanel: id and mount() are required');
        if (reg.panels.has(def.id)) unregisterPanel(def.id);
        const side = def.side === 'right' ? 'right' : 'left';
        const sid = safeId(def.id);
        const title = String(def.title || def.id);
        const badgeEl = h('span', { class: 'apb-tab-badge', hidden: true });
        const tab = h('button', {
          type: 'button', role: 'tab', class: 'apb-tab', id: 'apb-tab-' + sid, 'aria-selected': 'false',
          'aria-controls': 'apb-tabpanel-' + sid, tabindex: '-1', 'data-panel': def.id
        },
        def.icon ? icons.get(String(def.icon), { size: 16, className: 'apb-tab-icon' }) : null,
        h('span', { class: 'apb-tab-label' }, title), badgeEl);
        widgets.tooltip(tab, { label: title, placement: 'bottom' });
        const container = h('div', {
          class: 'apb-tabpanel', role: 'tabpanel', id: 'apb-tabpanel-' + sid, 'aria-labelledby': tab.id, tabindex: '0', hidden: true,
          'data-panel': def.id
        });
        const rec = { id: def.id, def, side, order: def.order, seq: ++seq, tab, badgeEl, container, instance: null, mounted: false };
        tab.addEventListener('click', () => activate(sides[side], def.id, { persist: true }));
        reg.panels.set(def.id, rec);
        sides[side].body.appendChild(container);
        renderTabs(sides[side]);
        schedule('badges');
        return () => unregisterPanel(def.id);
      }

      function unregisterPanel(id) {
        const rec = reg.panels.get(id);
        if (!rec) return false;
        if (rec.instance && isFn(rec.instance.destroy)) {
          try { rec.instance.destroy(); } catch (err) { console.error('[APB] panel "' + id + '" destroy failed:', err); }
        }
        rec.tab.remove();
        rec.container.remove();
        reg.panels.delete(id);
        const s = sides[rec.side];
        if (s.active === id) s.active = null;
        renderTabs(s);
        return true;
      }

      function showPanel(id) {
        const rec = reg.panels.get(id);
        if (!rec) return false;
        const s = sides[rec.side];
        if (compact) {
          drawer = rec.side;
        } else if (store.prefs[rec.side + 'Collapsed']) {
          store.setPrefs({ [rec.side + 'Collapsed']: false });
        }
        renderSides();
        activate(s, id, { persist: true });
        return true;
      }

      function renderBadges() {
        reg.panels.forEach((rec) => {
          if (!isFn(rec.def.badge)) return;
          let v = '';
          try { v = rec.def.badge(app); } catch (_) { v = ''; }
          const text = v == null || v === '' || v === 0 || v === false ? '' : String(v);
          if (rec.badgeEl.textContent !== text) rec.badgeEl.textContent = text;
          rec.badgeEl.hidden = !text;
        });
      }

      /* ============================================================ status bar */
      const selInfo = h('div', { class: 'apb-status-selection' });
      const statusSlotStart = h('div', { class: 'apb-status-slot apb-status-slot--start', 'data-side': 'start' });
      const statusSlotEnd = h('div', { class: 'apb-status-slot apb-status-slot--end', 'data-side': 'end' });
      const snapObjBtn = widgets.iconButton({ icon: 'magnet', label: 'Snap to objects', size: 'sm', className: 'apb-status-snap-objects',
        pressed: !!(store.prefs.snap && store.prefs.snap.objects),
        onClick: () => store.setPrefs({ snap: { objects: !(store.prefs.snap && store.prefs.snap.objects) } }) });
      const snapGridBtn = widgets.iconButton({ icon: 'grid', label: 'Snap to grid', size: 'sm', className: 'apb-status-snap-grid',
        pressed: !!(store.prefs.snap && store.prefs.snap.grid),
        onClick: () => store.setPrefs({ snap: { grid: !(store.prefs.snap && store.prefs.snap.grid) } }) });
      const statusZoomText = h('span', { class: 'apb-zoom-value' }, '100%');
      const statusZoomBtn = h('button', { type: 'button', class: 'apb-btn apb-btn--ghost apb-btn--sm apb-status-zoom', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
        h('span', { class: 'apb-sr-only' }, 'Zoom '), statusZoomText);
      widgets.tooltip(statusZoomBtn, { label: 'Zoom options' });
      listen(statusZoomBtn, 'click', () => openZoomMenu(statusZoomBtn, 'top-end'));
      const themeBtn = widgets.iconButton({ icon: THEME_ICONS.system, label: 'Theme: System', size: 'sm', className: 'apb-status-theme', onClick: cycleTheme });
      const statusbar = h('footer', { class: 'apb-statusbar' },
        h('div', { class: 'apb-status-start' }, selInfo, statusSlotStart),
        h('div', { class: 'apb-status-end' }, statusSlotEnd,
          h('div', { class: 'apb-toolbar-group', role: 'group', 'aria-label': 'Snapping' }, snapObjBtn, snapGridBtn),
          statusZoomBtn, themeBtn));

      let selKey = '';
      function renderSelection() {
        const doc = store.doc;
        const sel = store.selection.filter((id) => doc.nodes[id]);
        let parts;
        if (!sel.length) {
          parts = [['muted', 'No selection']];
        } else if (sel.length === 1) {
          const node = doc.nodes[sel[0]];
          let eff = node;
          try { eff = schema.effectiveNode(doc, node, store.view.bp) || node; } catch (_) { eff = node; }
          const def = app.elements && isFn(app.elements.get) ? app.elements.get(node.type) : null;
          const label = node.name || (def && def.label) || node.type;
          parts = [['name', label], ['metric', 'X', fmtNum(eff.x)], ['metric', 'Y', fmtNum(eff.y)], ['metric', 'W', fmtNum(eff.w)], ['metric', 'H', fmtNum(eff.h)]];
        } else {
          parts = [['name', sel.length + ' layers selected']];
        }
        const key = JSON.stringify(parts);
        if (key === selKey) return;
        selKey = key;
        selInfo.replaceChildren(...parts.map((p) => {
          if (p[0] === 'metric') return h('span', { class: 'apb-status-metric' }, h('span', { class: 'apb-status-key' }, p[1]), ' ' + p[2]);
          return h('span', { class: p[0] === 'muted' ? 'apb-status-muted' : 'apb-status-name' }, p[1]);
        }));
      }

      function renderHistory() {
        undoBtn.apbControl.setDisabled(!store.canUndo(), 'Nothing to undo');
        redoBtn.apbControl.setDisabled(!store.canRedo(), 'Nothing to redo');
      }

      function renderZoom() {
        const pct = Math.round((Number(store.view.zoom) || 1) * 100) + '%';
        if (zoomText.textContent !== pct) zoomText.textContent = pct;
        if (statusZoomText.textContent !== pct) statusZoomText.textContent = pct;
      }

      function renderName() {
        const name = store.doc.name || 'Untitled';
        if (document.activeElement !== nameInput && nameInput.value !== name) nameInput.value = name;
        const title = name + ' – Advanced Page Builder';
        if (document.title !== title) document.title = title;
      }

      function renderSnap() {
        const snap = store.prefs.snap || {};
        snapObjBtn.setAttribute('aria-pressed', String(!!snap.objects));
        snapGridBtn.setAttribute('aria-pressed', String(!!snap.grid));
      }

      function renderTheme() {
        const t = applyTheme(store.prefs.theme);
        const nextTheme = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
        themeBtn.apbControl.setIcon(THEME_ICONS[t]);
        themeBtn.apbControl.setLabel('Theme: ' + THEME_LABELS[t] + ' (switch to ' + THEME_LABELS[nextTheme] + ')');
      }

      function cycleTheme() {
        const t = THEMES.includes(store.prefs.theme) ? store.prefs.theme : 'system';
        const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
        store.setPrefs({ theme: next });
        dialogs.announce('Theme: ' + THEME_LABELS[next]);
      }

      function shortcutTip(btn, label, id) {
        const keys = commands.get(id) ? commands.keysFor(id) : [];
        widgets.tooltip(btn, { label, shortcut: keys.length ? keys : null });
      }

      function renderShortcuts() {
        toolBtns.forEach((btn, t) => shortcutTip(btn, TOOL_LABELS[t] || t, 'tool.' + t));
        shortcutTip(undoBtn, 'Undo', 'edit.undo');
        shortcutTip(redoBtn, 'Redo', 'edit.redo');
        shortcutTip(sides.left.toggle, 'Left panel', 'view.toggleLeftPanel');
        shortcutTip(sides.right.toggle, 'Right panel', 'view.toggleRightPanel');
        renderHistory();
      }

      /* ============================================================ slot items */
      function slotRegistrar(map, kind, areaKey, areas, containers) {
        function place(area) {
          const recs = Array.from(map.values()).filter((r) => r.area === area).sort(byOrder);
          containers[area].replaceChildren(...recs.map((r) => r.el));
        }
        function unregister(id) {
          const rec = map.get(id);
          if (!rec) return false;
          map.delete(id);
          place(rec.area);
          return true;
        }
        function register(def) {
          if (!def || typeof def.id !== 'string' || !def.id || !isFn(def.render)) throw new TypeError('ui.' + kind + ': id and render() are required');
          if (map.has(def.id)) unregister(def.id);
          const area = areas.includes(def[areaKey]) ? def[areaKey] : areas[areas.length - 1];
          let el = null;
          try { el = def.render(app); } catch (err) {
            console.error('[APB] ' + kind + ' "' + def.id + '" failed to render:', err);
            return () => false;
          }
          if (!el || typeof el.nodeType !== 'number') return () => false;
          if (el.nodeType === 1) el.setAttribute('data-ui-item', def.id);
          map.set(def.id, { id: def.id, def, area, order: def.order, seq: ++seq, el });
          place(area);
          return () => unregister(def.id);
        }
        return { register, unregister };
      }
      const toolbarReg = slotRegistrar(reg.toolbar, 'registerToolbarItem', 'area', ['start', 'center', 'end'], { start: slotStart, center: slotCenter, end: slotEnd });
      const statusReg = slotRegistrar(reg.status, 'registerStatusItem', 'side', ['start', 'end'], { start: statusSlotStart, end: statusSlotEnd });

      /* ================================================================= menus */
      function registerMenuItem(def) {
        if (!def || !def.command) throw new TypeError('ui.registerMenuItem: command is required');
        const menu = String(def.menu || 'help');
        if (typeof def.command === 'string') {
          const at = reg.menu.findIndex((e) => e.menu === menu && e.command === def.command);
          if (at !== -1) reg.menu.splice(at, 1);
        } else if (!def.command.label || !isFn(def.command.run) && def.command.submenu == null) {
          throw new TypeError('ui.registerMenuItem: { label, run } is required');
        }
        const entry = Object.assign({}, def, { menu, seq: ++seq });
        reg.menu.push(entry);
        return () => {
          const i = reg.menu.indexOf(entry);
          if (i !== -1) reg.menu.splice(i, 1);
          return i !== -1;
        };
      }

      const evalFlag = (v) => (isFn(v) ? !!v(app) : v);

      function commandItem(id, args) {
        const def = commands.get(id);
        if (!def) return null;
        const item = {
          label: def.title || id,
          icon: def.icon || null,
          shortcut: commands.keysFor(id),
          disabled: !commands.enabled(id, args),
          danger: id === 'edit.delete',
          command: id,
          run: () => commands.run(id, Object.assign({ source: 'menu' }, args))
        };
        if (isFn(def.checked)) {
          try { item.checked = !!def.checked(app); } catch (_) { item.checked = false; }
        }
        return item;
      }

      function menuItems(menuId) {
        const out = [];
        for (const e of reg.menu.filter((x) => x.menu === menuId).sort(byOrder)) {
          let item = null;
          if (typeof e.command === 'string') {
            item = commandItem(e.command);
          } else {
            const c = e.command;
            item = {
              label: c.label, icon: c.icon, shortcut: c.shortcut, danger: c.danger,
              disabled: !!evalFlag(c.disabled), checked: c.checked == null ? undefined : !!evalFlag(c.checked),
              submenu: c.submenu, run: isFn(c.run) ? () => c.run(app) : null
            };
          }
          if (!item) continue;
          if (e.separatorBefore && out.length) out.push({ separator: true });
          out.push(item);
        }
        return out;
      }

      function mainMenuItems() {
        const out = [];
        for (const [id, label] of MENUS) {
          if (menuItems(id).length) out.push({ label, submenu: () => menuItems(id), id });
        }
        const custom = Array.from(new Set(reg.menu.map((e) => e.menu))).filter((m) => !MENUS.some((x) => x[0] === m));
        for (const id of custom) out.push({ label: id.charAt(0).toUpperCase() + id.slice(1), submenu: () => menuItems(id) });
        return out;
      }

      let mainMenu = null;
      function openMainMenu() {
        mainMenu = dialogs.menu(menuBtn, mainMenuItems(), { label: 'Main menu', emptyLabel: 'No menu items yet' });
        return mainMenu;
      }
      function toggleMainMenu() {
        if (mainMenu && mainMenu.isOpen) { mainMenu.close(); mainMenu = null; return null; }
        return openMainMenu();
      }

      function openZoomMenu(anchor, placement) {
        const vp = app.canvas && app.canvas.viewport;
        const items = [];
        const add = (id) => { const it = commandItem(id); if (it) items.push(it); };
        add('view.zoomIn');
        add('view.zoomOut');
        items.push({ separator: true });
        for (const z of [0.5, 1, 2]) {
          items.push({ label: Math.round(z * 100) + '%', disabled: !vp, run: () => vp && vp.setZoom(z) });
        }
        items.push({ separator: true });
        add('view.zoom100');
        add('view.zoomFit');
        add('view.zoomSelection');
        items.push({ separator: true });
        add('view.toggleGrid');
        add('view.toggleRulers');
        return dialogs.menu(anchor, items, { label: 'Zoom', placement });
      }

      function contextMenuItems(payload) {
        const args = { nodeId: payload && payload.nodeId || null, clientX: payload && payload.clientX, clientY: payload && payload.clientY };
        const out = [];
        for (const group of CONTEXT_GROUPS) {
          const items = group.map((id) => commandItem(id, args)).filter(Boolean);
          if (!items.length) continue;
          if (out.length) out.push({ separator: true });
          out.push(...items);
        }
        return out;
      }

      offs.push(app.on('canvas:contextmenu', (p) => {
        const payload = p || {};
        const nodeId = payload.nodeId;
        if (nodeId && store.node(nodeId) && !store.selection.includes(nodeId)) store.select([nodeId]);
        const items = contextMenuItems(payload);
        if (!items.length) return;
        const x = Number.isFinite(payload.clientX) ? payload.clientX : window.innerWidth / 2;
        const y = Number.isFinite(payload.clientY) ? payload.clientY : window.innerHeight / 2;
        dialogs.menu({ clientX: x, clientY: y }, items, { label: 'Canvas actions' });
      }));

      /* ========================================================= inspector reg */
      function registerInspectorSection(def) {
        if (!def || typeof def.id !== 'string' || !def.id || !isFn(def.mount)) throw new TypeError('ui.registerInspectorSection: id and mount() are required');
        reg.inspector.set(def.id, Object.assign({}, def, { seq: ++seq }));
        app.emit('ui:inspector-sections', { id: def.id });
        return () => {
          const ok = reg.inspector.delete(def.id);
          if (ok) app.emit('ui:inspector-sections', { id: def.id, removed: true });
          return ok;
        };
      }
      function inspectorSections() {
        return Array.from(reg.inspector.values()).sort(byOrder).map((d) => {
          const copy = Object.assign({}, d);
          delete copy.seq;
          return copy;
        });
      }

      /* ============================================================== commands */
      const commandDefs = [
        { id: 'view.togglePanels', title: 'Toggle panels', icon: 'layout-grid', keys: ['Mod+\\'], run: () => togglePanels() },
        { id: 'view.toggleLeftPanel', title: 'Toggle left panel', icon: 'layers', checked: () => sideVisible('left'), when: () => sides.left.recs.length > 0, run: () => togglePanel('left') },
        { id: 'view.toggleRightPanel', title: 'Toggle right panel', icon: 'design', checked: () => sideVisible('right'), when: () => sides.right.recs.length > 0, run: () => togglePanel('right') },
        { id: 'view.theme.light', title: 'Light theme', icon: 'sun', checked: (a) => a.store.prefs.theme === 'light', run: (a) => a.store.setPrefs({ theme: 'light' }) },
        { id: 'view.theme.dark', title: 'Dark theme', icon: 'moon', checked: (a) => a.store.prefs.theme === 'dark', run: (a) => a.store.setPrefs({ theme: 'dark' }) },
        { id: 'view.theme.system', title: 'System theme', icon: 'monitor', checked: (a) => !THEMES.includes(a.store.prefs.theme) || a.store.prefs.theme === 'system', run: (a) => a.store.setPrefs({ theme: 'system' }) }
      ];
      for (const d of commandDefs) {
        if (!commands.get(d.id)) offs.push(commands.register(Object.assign({ category: 'View' }, d)));
      }
      [['view.togglePanels', 40, true], ['view.toggleLeftPanel', 41], ['view.toggleRightPanel', 42],
        ['view.theme.light', 60, true], ['view.theme.dark', 61], ['view.theme.system', 62]]
        .forEach(([command, order, separatorBefore]) => registerMenuItem({ menu: 'view', command, order, separatorBefore: !!separatorBefore }));

      /* ================================================================ assemble */
      const leftToggle = sides.left.toggle;
      const rightToggle = sides.right.toggle;
      toolbarStart.insertBefore(leftToggle, nameInput);
      toolbarEnd.appendChild(rightToggle);

      const main = h('div', { class: 'apb-main' },
        sides.left.el, sides.left.splitter, canvasHost, sides.right.splitter, sides.right.el, scrim);
      shellEl.append(toolbar, main, statusbar);
      root.appendChild(shellEl);
      listen(scrim, 'click', () => closeDrawer(false));

      applyWidth('left', widthOf('left'));
      applyWidth('right', widthOf('right'));

      const mq = isFn(window.matchMedia) ? window.matchMedia(COMPACT_QUERY) : null;
      function applyCompact() {
        compact = !!(mq && mq.matches);
        shellEl.toggleAttribute('data-compact', compact);
        if (!compact) drawer = null;
        renderSides();
      }
      if (mq) {
        const onMq = () => applyCompact();
        if (isFn(mq.addEventListener)) { mq.addEventListener('change', onMq); offs.push(() => mq.removeEventListener('change', onMq)); }
      }
      applyCompact();

      /* ============================================================= listeners */
      offs.push(store.on('change', () => {
        schedule('status');
        schedule('history');
        schedule('badges');
        schedule('name');
      }));
      offs.push(store.on('selection', () => { schedule('status'); schedule('badges'); }));
      offs.push(store.on('history', () => schedule('history')));
      offs.push(store.on('view', (p) => {
        const ch = (p && p.changed) || [];
        if (!ch.length || ch.includes('zoom')) schedule('zoom');
        if (!ch.length || ch.includes('tool')) renderTools();
        if (!ch.length || ch.includes('bp') || ch.includes('pageId')) schedule('status');
      }));
      offs.push(store.on('prefs', (p) => {
        const ch = (p && p.changed) || [];
        const all = !ch.length;
        if (all || ch.includes('theme')) renderTheme();
        if (all || ch.includes('snap')) renderSnap();
        if (all || ch.includes('leftWidth')) applyWidth('left', widthOf('left'));
        if (all || ch.includes('rightWidth')) applyWidth('right', widthOf('right'));
        if (all || ch.includes('leftCollapsed') || ch.includes('rightCollapsed')) renderSides();
        for (const side of ['left', 'right']) {
          if (!all && !ch.includes(side + 'Tab')) continue;
          const id = store.prefs[side + 'Tab'];
          const s = sides[side];
          if (id !== s.active && s.recs.some((r) => r.id === id)) activate(s, id, { persist: false });
        }
      }));
      if (isFn(commands.on)) offs.push(commands.on('change', () => schedule('shortcuts')));
      listen(window, 'resize', () => { if (drawer && !compact) closeDrawer(false); });

      renderTools();
      renderTheme();
      renderSnap();
      renderSelection();
      renderZoom();
      renderName();
      renderShortcuts();

      function destroy() {
        if (raf) cancelAnimationFrame(raf);
        offs.splice(0).forEach((off) => { try { if (isFn(off)) off(); } catch (_) { /* ignore */ } });
        reg.panels.forEach((rec) => { if (rec.instance && isFn(rec.instance.destroy)) { try { rec.instance.destroy(); } catch (_) { /* ignore */ } } });
        dialogs.closeMenus();
        shellEl.remove();
      }

      const ui = {
        el: shellEl,
        root: shellEl,
        toolbarEl: toolbar,
        statusEl: statusbar,
        canvasHost,
        registerPanel,
        unregisterPanel,
        showPanel,
        panels: () => Array.from(reg.panels.values()).map((r) => ({ id: r.id, side: r.side, title: r.def.title, icon: r.def.icon, order: r.def.order, mounted: r.mounted })),
        activePanel: (side) => (sides[side] ? sides[side].active : null),
        registerToolbarItem: toolbarReg.register,
        registerStatusItem: statusReg.register,
        registerMenuItem,
        menuItems,
        openMainMenu,
        registerInspectorSection,
        inspectorSections,
        toast: dialogs.toast,
        confirm: dialogs.confirm,
        prompt: dialogs.prompt,
        dialog: dialogs.dialog,
        menu: dialogs.menu,
        closeMenus: dialogs.closeMenus,
        announce: dialogs.announce,
        togglePanels,
        togglePanel,
        setPanelCollapsed: setCollapsed,
        isCompact: () => compact,
        contextMenuItems,
        destroy
      };
      return ui;
    }

    return { mount, applyTheme, MENUS, CONTEXT_GROUPS, THEMES };
  });

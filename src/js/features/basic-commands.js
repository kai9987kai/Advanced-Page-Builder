/*
 * basic-commands — plugin registering the everyday edit / arrange / help commands (ARCHITECTURE.md §6.8, §8; PLAN B2),
 * their menu entries, the "Arrange in circle" dialog (live preview, Cancel reverts), the keyboard shortcuts
 * dialog and the About dialog.
 *
 * Every command has a `when()` so menus, the palette and the keyboard dispatcher disable it when it does not apply.
 * Command ids match the shell's canvas context menu (edit.duplicate, edit.delete, arrange.group, …).
 */
(function () {
  'use strict';

  const CATEGORY_ORDER = ['Edit', 'Arrange', 'Tools', 'Insert', 'View', 'Pages', 'File', 'Help'];
  const ROTATE_STEP = 15;

  const CSS = `
.apb-shortcuts { display: flex; flex-direction: column; gap: var(--apb-space-3); min-height: 0; }
.apb-shortcuts-list { columns: 2 300px; column-gap: var(--apb-space-6); }
.apb-shortcuts-section { break-inside: avoid; margin: 0 0 var(--apb-space-4); }
.apb-shortcuts-section h3 { margin: 0 0 var(--apb-space-1); font-size: var(--apb-font-size-sm); font-weight: var(--apb-weight-semibold); color: var(--apb-text-muted); }
.apb-shortcuts-table { width: 100%; border-collapse: collapse; }
.apb-shortcuts-table th, .apb-shortcuts-table td { padding: 5px 0; border-bottom: 1px solid var(--apb-border); vertical-align: middle; }
.apb-shortcuts-table th { text-align: left; font-weight: normal; padding-right: var(--apb-space-3); }
.apb-shortcuts-table td { text-align: right; white-space: nowrap; color: var(--apb-text-muted); }
.apb-shortcuts-table tr.is-disabled th { color: var(--apb-text-muted); }
.apb-shortcuts-none { color: var(--apb-text-subtle); }
.apb-shortcuts-empty { margin: var(--apb-space-4) 0; text-align: center; color: var(--apb-text-muted); }
.apb-about { display: flex; flex-direction: column; align-items: center; gap: var(--apb-space-2); text-align: center; padding-top: var(--apb-space-2); }
.apb-about-mark { display: inline-flex; padding: var(--apb-space-3); border-radius: var(--apb-radius-3); background: var(--apb-accent-soft); color: var(--apb-accent-text); }
.apb-about h3 { margin: 0; font-size: var(--apb-font-size-xl); font-weight: var(--apb-weight-semibold); }
.apb-about p { margin: 0; }
.apb-about-version { color: var(--apb-text-muted); }
.apb-about-privacy { display: flex; gap: var(--apb-space-2); align-items: flex-start; text-align: left; margin-top: var(--apb-space-2) !important; padding: var(--apb-space-3); border-radius: var(--apb-radius-2); background: var(--apb-success-soft); color: var(--apb-text); }
.apb-about-privacy svg { flex: none; color: var(--apb-success); margin-top: 2px; }
.apb-about-meta { display: grid; grid-template-columns: auto auto; gap: 2px var(--apb-space-3); margin: var(--apb-space-2) 0 0; font-size: var(--apb-font-size-sm); color: var(--apb-text-muted); }
.apb-about-meta dt { text-align: right; }
.apb-about-meta dd { margin: 0; text-align: left; color: var(--apb-text); }
.apb-radial { display: flex; flex-direction: column; gap: var(--apb-space-2); }
.apb-radial-note { margin: 0; font-size: var(--apb-font-size-sm); color: var(--apb-text-muted); }
@media (forced-colors: active) { .apb-about-privacy { border: 1px solid CanvasText; } }`;

  function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('apb-basic-commands-style')) return;
    const style = document.createElement('style');
    style.id = 'apb-basic-commands-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  APB.plugin({
    id: 'basic-commands',
    requires: ['docops', 'schema', 'widgets', 'icons', 'geometry'],
    order: 30,
    init(app) {
      const { store, commands, docops } = app;
      const schema = APB.require('schema');
      const widgets = APB.require('widgets');
      const icons = APB.require('icons');
      const geometry = APB.require('geometry');
      const util = app.util;
      const { h } = widgets;
      const ui = app.ui || {};
      ensureStyles();

      /* ------------------------------------------------------------ selection helpers */
      const doc = () => store.doc;
      const bp = () => store.view.bp;
      const sel = () => store.selection || [];
      const top = () => docops.topLevel(doc(), sel());
      const locked = (id) => docops.isLocked(doc(), id);
      const eff = (id) => schema.effectiveNode(doc(), id, bp());
      const isStackChild = (id) => {
        const n = store.node(id);
        if (!n || !n.parent) return false;
        const p = eff(n.parent);
        return !!(p && p.layout && p.layout.mode === 'stack');
      };
      const movable = () => top().filter((id) => !locked(id) && !isStackChild(id));
      const unlocked = () => top().filter((id) => !locked(id));
      const noText = () => !store.view.editingText;
      const isStructural = (id) => { const n = store.node(id); return !n || n.type === 'page' || n.type === 'section'; };
      const say = (msg) => { if (typeof ui.announce === 'function') ui.announce(msg); };
      const layers = (n) => util.plural(n, 'layer');
      const ungroupable = () => sel().filter((id) => {
        const n = store.node(id);
        return !!(n && n.parent && Array.isArray(n.children) && n.children.length && !isStructural(id) && !locked(id));
      });
      const canZ = (dir) => {
        const ids = top();
        if (!ids.length) return false;
        return ids.some((id) => {
          const n = store.node(id);
          const p = n && n.parent ? store.node(n.parent) : null;
          if (!p || !Array.isArray(p.children)) return false;
          const i = p.children.indexOf(id);
          return dir === 'up' ? i < p.children.length - 1 : i > 0;
        });
      };
      const normAngle = (a) => {
        let r = ((a % 360) + 540) % 360 - 180;
        if (r === -180) r = 180;
        return Math.round(r * 100) / 100;
      };

      function rotateBy(delta, reset) {
        const ids = unlocked();
        if (!ids.length) return 0;
        let changed = 0;
        store.transact(reset ? 'Reset rotation' : 'Rotate', () => {
          for (const id of ids) {
            const n = eff(id);
            const next = reset ? 0 : normAngle((Number(n.rotation) || 0) + delta);
            if ((Number(n.rotation) || 0) === next) continue;
            if (docops.setBox(app, id, { rotation: next })) changed++;
          }
        });
        return changed;
      }

      /* ---------------------------------------------------------------- rename */
      async function rename(args) {
        const id = (args && args.nodeId) || sel()[0];
        const node = store.node(id);
        if (!node) return;
        if (app.emitter && typeof app.emitter.listenerCount === 'function' && app.emitter.listenerCount('layers:rename') > 0) {
          app.emit('layers:rename', { id });
          return;
        }
        if (typeof ui.prompt !== 'function') return;
        const def = app.elements && app.elements.get(node.type);
        const value = await ui.prompt({
          title: 'Rename layer', label: 'Layer name', value: node.name || (def && def.label) || '', confirmLabel: 'Rename',
          validate: (v) => (String(v || '').trim() ? null : 'Enter a name')
        });
        if (value == null || !store.node(id)) return;
        const name = String(value).trim().slice(0, 200);
        if (name && name !== node.name) {
          docops.update(app, [id], { name }, { bp: null, label: 'Rename layer' });
          say('Renamed to ' + name);
        }
      }

      /* ------------------------------------------------------------- select all */
      function selectAll() {
        const d = doc();
        const page = (d.pages || []).find((p) => p.id === store.view.pageId);
        let parentId = store.view.context && store.node(store.view.context) ? store.view.context : null;
        if (!parentId && sel().length) parentId = (store.node(sel()[0]) || {}).parent || null;
        const pick = (list) => (list || []).filter((id) => store.node(id) && !locked(id) && !eff(id).hidden);
        let ids;
        if (parentId) {
          const parent = store.node(parentId);
          if (!parent || !Array.isArray(parent.children)) return;
          ids = pick(parent.children);
        } else {
          // Nothing selected: every element inside the page's sections (falls back to the sections themselves).
          const root = page && store.node(page.root);
          if (!root || !Array.isArray(root.children)) return;
          const sections = pick(root.children);
          ids = [];
          for (const id of sections) {
            const n = store.node(id);
            ids = ids.concat(n.type === 'section' ? pick(n.children) : [id]);
          }
          if (!ids.length) ids = sections;
        }
        store.select(ids);
        say(ids.length ? layers(ids.length) + ' selected' : 'Nothing to select');
      }

      /* --------------------------------------------------------- radial dialog */
      function radialDialog() {
        const ids = movable();
        if (ids.length < 2 || typeof ui.dialog !== 'function') return null;
        const d = doc();
        const bounds = geometry.union(ids.map((id) => docops.worldBounds(d, id, { bp: bp() })).filter(Boolean));
        const firstParent = store.node(ids[0]).parent;
        const parentEff = firstParent ? eff(firstParent) : null;
        const parentSized = !!(parentEff && Number.isFinite(parentEff.w) && Number.isFinite(parentEff.h));
        const state = {
          radius: Math.max(40, Math.round(Math.max(bounds ? bounds.w : 0, bounds ? bounds.h : 0) / 2)),
          startAngle: -90, sweep: 360, center: 'selection', rotateItems: 'none'
        };
        let appliedIndex = null;
        let frame = 0;

        const historyTop = () => {
          const info = store.history();
          const entry = info.entries[info.index - 1];
          return { index: info.index, label: entry && entry.label };
        };
        function revert() {
          if (appliedIndex == null) return;
          const t = historyTop();
          if (t.index === appliedIndex && t.label === 'Arrange in circle' && store.canUndo()) store.undo();
          appliedIndex = null;
        }
        function preview() {
          frame = 0;
          revert();
          const opts = { radius: state.radius, startAngle: state.startAngle, sweep: state.sweep };
          if (state.rotateItems !== 'none') opts.rotateItems = state.rotateItems;
          if (state.center === 'parent' && parentSized) { opts.cx = parentEff.w / 2; opts.cy = parentEff.h / 2; }
          const alive = ids.filter((id) => store.node(id));
          const res = alive.length >= 2 ? docops.radial(app, alive, opts) : [];
          if (res && res.length) appliedIndex = historyTop().index;
        }
        const schedule = () => {
          if (frame) return;
          frame = requestAnimationFrame(preview);
        };
        const flush = () => {
          if (frame) { cancelAnimationFrame(frame); preview(); }
        };
        const num = (key, opts) => widgets.numberField(Object.assign({
          value: state[key],
          onInput(v) { if (Number.isFinite(v)) { state[key] = v; schedule(); } }
        }, opts));
        const radiusField = num('radius', { ariaLabel: 'Radius', icon: 'radius', min: 0, max: 20000, step: 1, unit: 'px' });
        const startField = num('startAngle', { ariaLabel: 'Start angle', icon: 'rotate', min: -360, max: 360, step: 1, unit: '°' });
        const sweepField = num('sweep', { ariaLabel: 'Sweep', icon: 'radial', min: -360, max: 360, step: 5, unit: '°' });
        const centerField = widgets.select({
          ariaLabel: 'Center', value: state.center,
          options: [{ value: 'selection', label: 'Selection center' }, { value: 'parent', label: 'Parent center', disabled: !parentSized }],
          onInput(v) { state.center = v; schedule(); }
        });
        const rotateField = widgets.select({
          ariaLabel: 'Rotate items', value: state.rotateItems,
          options: [{ value: 'none', label: 'Keep rotation' }, { value: 'tangent', label: 'Follow the circle' }, { value: 'radial', label: 'Point outward' }],
          onInput(v) { state.rotateItems = v; schedule(); }
        });
        const content = h('div', { class: 'apb-radial' },
          widgets.fieldRow({ label: 'Radius', control: radiusField }),
          widgets.fieldRow({ label: 'Start angle', control: startField }),
          widgets.fieldRow({ label: 'Sweep', control: sweepField }),
          widgets.fieldRow({ label: 'Center', control: centerField }),
          widgets.fieldRow({ label: 'Rotate items', control: rotateField }),
          h('p', { class: 'apb-radial-note' }, 'Changes preview on the canvas. ' + layers(ids.length) + ' will be placed in selection order.'));

        preview();
        const dlg = ui.dialog({
          title: 'Arrange in circle',
          className: 'apb-radial-dialog',
          content,
          actions: [
            { label: 'Cancel', kind: 'cancel', value: 'cancel' },
            { label: 'Apply', kind: 'primary', run(close) { flush(); close('apply'); } }
          ],
          onClose(result) {
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            if (result === 'apply') {
              if (appliedIndex == null) preview();
              say('Arranged ' + layers(ids.length) + ' in a circle');
            } else {
              revert();
            }
          }
        });
        return dlg;
      }

      /* ------------------------------------------------------ shortcuts dialog */
      function categoryRank(c) {
        const i = CATEGORY_ORDER.indexOf(c);
        return i === -1 ? CATEGORY_ORDER.length : i;
      }

      function gestureRows() {
        const mod = app.env && app.env.mac ? '⌘' : 'Ctrl';
        const alt = app.env && app.env.mac ? '⌥' : 'Alt';
        const rows = [
          ['Pan the canvas', 'Space + drag · Scroll'],
          ['Zoom around the pointer', mod + ' + scroll · Pinch'],
          ['Select inside groups', mod + ' + click'],
          ['Add to or remove from selection', 'Shift + click'],
          ['Duplicate while dragging', alt + ' + drag'],
          ['Keep aspect ratio while resizing', 'Shift + drag handle'],
          ['Resize from the center', alt + ' + drag handle'],
          ['Turn off snapping while dragging', 'Hold ' + mod],
          ['Enter a group or edit text', 'Double-click'],
          ['Cancel the current gesture', 'Esc']
        ];
        const hasNudge = commands.list().some((c) => (c.keys || []).some((k) => /Arrow/.test(k)));
        if (!hasNudge) rows.push(['Nudge selection (Shift: 10 px)', 'Arrow keys']);
        return rows;
      }

      function shortcutsDialog() {
        if (typeof ui.dialog !== 'function') return null;
        const byCat = new Map();
        for (const def of commands.list()) {
          const cat = def.category || 'General';
          if (!byCat.has(cat)) byCat.set(cat, []);
          byCat.get(cat).push(def);
        }
        const cats = Array.from(byCat.keys()).sort((a, b) => (categoryRank(a) - categoryRank(b)) || a.localeCompare(b));
        const rowsIndex = [];
        const sections = [];
        const addSection = (title, rows) => {
          const tbody = h('tbody');
          const section = h('section', { class: 'apb-shortcuts-section', dataset: { category: title } },
            h('h3', null, title), h('table', { class: 'apb-shortcuts-table' }, tbody));
          rows.forEach((r) => { tbody.appendChild(r.el); rowsIndex.push(Object.assign(r, { section, lower: r.text.toLowerCase() })); });
          sections.push(section);
        };
        for (const cat of cats) {
          const defs = byCat.get(cat).slice().sort((a, b) => ((b.keys || []).length > 0) - ((a.keys || []).length > 0));
          addSection(cat, defs.map((def) => {
            const keys = def.keys || [];
            const disabled = !commands.enabled(def.id);
            const el = h('tr', { class: disabled && 'is-disabled', dataset: { command: def.id } },
              h('th', { scope: 'row' }, String(def.title || def.id)),
              h('td', null, keys.length ? widgets.kbd(keys) : h('span', { class: 'apb-shortcuts-none', 'aria-label': 'No shortcut' }, '—')));
            return { el, text: [def.title, def.id, cat, commands.formatKeys(keys)].join(' ') };
          }));
        }
        addSection('Canvas', gestureRows().map(([label, keys]) => ({
          el: h('tr', null, h('th', { scope: 'row' }, label), h('td', null, h('kbd', { class: 'apb-kbd' }, keys))),
          text: 'Canvas ' + label + ' ' + keys
        })));

        const list = h('div', { class: 'apb-shortcuts-list' }, sections);
        const empty = h('p', { class: 'apb-shortcuts-empty', hidden: true, role: 'status' }, 'No shortcuts match your search.');
        const filter = widgets.textField({
          icon: 'search', ariaLabel: 'Filter shortcuts', placeholder: 'Filter by name or key…', clearable: true,
          onInput(value) {
            const tokens = String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
            let visible = 0;
            const seen = new Set();
            for (const r of rowsIndex) {
              const show = !tokens.length || tokens.every((t) => r.lower.includes(t));
              r.el.hidden = !show;
              if (show) { visible++; seen.add(r.section); }
            }
            sections.forEach((s) => { s.hidden = !seen.has(s); });
            empty.hidden = visible > 0;
          }
        });
        const input = filter.apbControl && filter.apbControl.input;
        return ui.dialog({
          title: 'Keyboard shortcuts',
          wide: true,
          className: 'apb-shortcuts-dialog',
          content: h('div', { class: 'apb-shortcuts' }, filter, list, empty),
          initialFocus: input || null,
          actions: [{ label: 'Close', kind: 'primary' }]
        });
      }

      /* ----------------------------------------------------------- about dialog */
      function aboutDialog() {
        if (typeof ui.dialog !== 'function') return null;
        const env = app.env || {};
        const platform = env.mac ? 'macOS' : (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent) ? 'Windows' : 'Other');
        const shortcutKeys = commands.keysFor('help.shortcuts');
        const paletteKeys = commands.keysFor('view.palette');
        const content = h('div', { class: 'apb-about' },
          h('span', { class: 'apb-about-mark', 'aria-hidden': 'true' }, icons.get('layout-grid', { size: 32 })),
          h('h3', null, 'Advanced Page Builder'),
          h('p', { class: 'apb-about-version' }, 'Version ' + String(app.version || '2')),
          h('p', null, 'A visual page builder that exports clean, standards-based HTML and CSS.'),
          h('p', { class: 'apb-about-privacy' }, icons.get('lock', { size: 16 }),
            h('span', null, 'Everything stays in your browser. Projects, images and settings are kept on this device — nothing is uploaded unless you choose to export or connect a service yourself.')),
          h('dl', { class: 'apb-about-meta' },
            h('dt', null, 'Platform'), h('dd', null, platform),
            h('dt', null, 'Commands'), h('dd', null, String(commands.list().length)),
            paletteKeys.length ? [h('dt', null, 'Command palette'), h('dd', null, widgets.kbd(paletteKeys[0]))] : null,
            shortcutKeys.length ? [h('dt', null, 'Shortcuts'), h('dd', null, widgets.kbd(shortcutKeys[shortcutKeys.length - 1]))] : null));
        return ui.dialog({
          title: 'About',
          className: 'apb-about-dialog',
          content,
          actions: [
            commands.get('help.shortcuts') ? { label: 'Keyboard shortcuts', kind: 'default', run(close) { close('shortcuts'); commands.run('help.shortcuts', { source: 'about' }); } } : null,
            { label: 'Close', kind: 'primary', autofocus: true }
          ]
        });
      }

      /* ------------------------------------------------------------- commands */
      const alignCmd = (edge, title, key) => ({
        id: 'arrange.align.' + edge, title, category: 'Arrange', icon: 'align-' + edge, keys: [key],
        when: () => movable().length >= 1,
        run: () => { const r = docops.align(app, top(), edge); if (r && r.length) say(title); return r; }
      });

      const defs = [
        { id: 'edit.undo', title: 'Undo', category: 'Edit', icon: 'undo', keys: ['Mod+Z'], when: () => store.canUndo(), run: () => store.undo() },
        { id: 'edit.redo', title: 'Redo', category: 'Edit', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], when: () => store.canRedo(), run: () => store.redo() },
        {
          id: 'edit.delete', title: 'Delete', category: 'Edit', icon: 'trash', keys: ['Delete', 'Backspace'],
          when: () => noText() && top().length > 0,
          run: () => { const n = top().length; const r = docops.remove(app, top()); if (r) say('Deleted ' + layers(n)); return r; }
        },
        {
          id: 'edit.duplicate', title: 'Duplicate', category: 'Edit', icon: 'duplicate', keys: ['Mod+D'],
          when: () => noText() && top().length > 0,
          run: () => { const r = docops.duplicate(app, top()); if (r && r.length) say('Duplicated ' + layers(r.length)); return r; }
        },
        { id: 'edit.rename', title: 'Rename…', category: 'Edit', icon: 'type', keys: ['F2'], when: (a, args) => noText() && !!store.node((args && args.nodeId) || sel()[0]) && sel().length <= 1, run: (a, args) => rename(args) },
        { id: 'edit.selectAll', title: 'Select all', category: 'Edit', icon: 'select-box', keys: ['Mod+A'], when: () => noText(), run: () => selectAll() },

        {
          id: 'arrange.group', title: 'Group', category: 'Arrange', icon: 'group', keys: ['Mod+G'],
          when: () => top().length > 0 && !top().some(isStructural),
          run: () => { const n = top().length; const id = docops.group(app, top()); if (id) say('Grouped ' + layers(n)); return id; }
        },
        {
          id: 'arrange.ungroup', title: 'Ungroup', category: 'Arrange', icon: 'wrap', keys: ['Mod+Shift+G'],
          when: () => ungroupable().length > 0,
          run: () => { const r = docops.ungroup(app, ungroupable()); if (r && r.length) say('Ungrouped ' + layers(r.length)); return r; }
        },
        {
          id: 'arrange.wrapFrame', title: 'Wrap in frame', category: 'Arrange', icon: 'frame',
          when: () => top().length > 0 && !top().some(isStructural),
          run: () => docops.wrap(app, top(), { layout: 'free' })
        },
        {
          id: 'arrange.wrapStack', title: 'Wrap in stack', category: 'Arrange', icon: 'stack-column', keys: ['Mod+Alt+G'],
          when: () => top().length > 0 && !top().some(isStructural),
          run: () => docops.wrap(app, top(), { layout: 'stack' })
        },
        alignCmd('left', 'Align left', 'Alt+A'),
        alignCmd('hcenter', 'Align horizontal centers', 'Alt+H'),
        alignCmd('right', 'Align right', 'Alt+D'),
        alignCmd('top', 'Align top', 'Alt+W'),
        alignCmd('vcenter', 'Align vertical centers', 'Alt+V'),
        alignCmd('bottom', 'Align bottom', 'Alt+S'),
        {
          id: 'arrange.distribute.h', title: 'Distribute horizontally', category: 'Arrange', icon: 'distribute-h', keys: ['Alt+Shift+H'],
          when: () => movable().length >= 3, run: () => docops.distribute(app, top(), 'h')
        },
        {
          id: 'arrange.distribute.v', title: 'Distribute vertically', category: 'Arrange', icon: 'distribute-v', keys: ['Alt+Shift+V'],
          when: () => movable().length >= 3, run: () => docops.distribute(app, top(), 'v')
        },
        { id: 'arrange.tidy', title: 'Tidy up', category: 'Arrange', icon: 'tidy', keys: ['Alt+Shift+T'], when: () => movable().length >= 2, run: () => docops.tidy(app, top()) },
        { id: 'arrange.radial', title: 'Arrange in circle…', category: 'Arrange', icon: 'radial', when: () => movable().length >= 2, run: () => radialDialog() },
        { id: 'arrange.matchWidth', title: 'Match width', category: 'Arrange', icon: 'sizing-fixed', when: () => unlocked().length >= 2, run: () => docops.matchSize(app, top(), { w: true }) },
        { id: 'arrange.matchHeight', title: 'Match height', category: 'Arrange', icon: 'sizing-fixed', when: () => unlocked().length >= 2, run: () => docops.matchSize(app, top(), { h: true }) },
        { id: 'arrange.bringForward', title: 'Bring forward', category: 'Arrange', icon: 'bring-forward', keys: ['Mod+]'], when: () => canZ('up'), run: () => docops.zorder(app, top(), 'forward') },
        { id: 'arrange.sendBackward', title: 'Send backward', category: 'Arrange', icon: 'send-backward', keys: ['Mod+['], when: () => canZ('down'), run: () => docops.zorder(app, top(), 'backward') },
        { id: 'arrange.bringToFront', title: 'Bring to front', category: 'Arrange', icon: 'bring-front', keys: ['Mod+Alt+]'], when: () => canZ('up'), run: () => docops.zorder(app, top(), 'front') },
        { id: 'arrange.sendToBack', title: 'Send to back', category: 'Arrange', icon: 'send-back', keys: ['Mod+Alt+['], when: () => canZ('down'), run: () => docops.zorder(app, top(), 'back') },
        {
          id: 'arrange.lock', title: 'Lock', category: 'Arrange', icon: 'lock', keys: ['Mod+Shift+L'],
          when: () => top().length > 0,
          checked: () => top().length > 0 && top().every((id) => !!(store.node(id) || {}).locked),
          run: () => {
            const ids = top();
            const value = !ids.every((id) => !!store.node(id).locked);
            const r = docops.setLocked(app, ids, value);
            say((value ? 'Locked ' : 'Unlocked ') + layers(ids.length));
            return r;
          }
        },
        {
          id: 'arrange.hide', title: 'Hide', category: 'Arrange', icon: 'eye-off', keys: ['Mod+Shift+H'],
          when: () => top().length > 0,
          checked: () => top().length > 0 && top().every((id) => !!eff(id).hidden),
          run: () => {
            const ids = top();
            const value = !ids.every((id) => !!eff(id).hidden);
            const r = docops.setHidden(app, ids, value);
            say((value ? 'Hid ' : 'Showed ') + layers(ids.length));
            return r;
          }
        },
        { id: 'arrange.rotateLeft', title: 'Rotate 15° left', category: 'Arrange', icon: 'rotate', when: () => unlocked().length > 0, run: () => rotateBy(-ROTATE_STEP) },
        { id: 'arrange.rotateRight', title: 'Rotate 15° right', category: 'Arrange', icon: 'rotate', when: () => unlocked().length > 0, run: () => rotateBy(ROTATE_STEP) },
        {
          id: 'arrange.resetRotation', title: 'Reset rotation', category: 'Arrange', icon: 'refresh',
          when: () => unlocked().some((id) => (Number(eff(id).rotation) || 0) !== 0), run: () => rotateBy(0, true)
        },

        { id: 'help.shortcuts', title: 'Keyboard shortcuts', category: 'Help', icon: 'keyboard', keys: ['Shift+?', 'Mod+/'], run: () => shortcutsDialog() },
        { id: 'help.about', title: 'About Advanced Page Builder', category: 'Help', icon: 'info', run: () => aboutDialog() }
      ];

      for (const def of defs) {
        if (!commands.get(def.id)) commands.register(def);
      }

      /* ---------------------------------------------------------------- menus */
      if (typeof ui.registerMenuItem !== 'function') return;
      const item = (id) => {
        const def = commands.get(id);
        if (!def) return null;
        const it = {
          label: def.title, icon: def.icon, shortcut: commands.keysFor(id), disabled: !commands.enabled(id), command: id,
          run: () => commands.run(id, { source: 'menu' })
        };
        if (typeof def.checked === 'function') it.checked = !!def.checked(app);
        return it;
      };
      const submenu = (ids) => () => ids.map((id) => (id === '-' ? '-' : item(id))).filter(Boolean);
      const anyEnabled = (ids) => () => !ids.some((id) => commands.enabled(id));
      const menu = (menuId, command, order, separatorBefore) => ui.registerMenuItem({ menu: menuId, command, order, separatorBefore: !!separatorBefore });

      menu('edit', 'edit.undo', 10);
      menu('edit', 'edit.redo', 11);
      menu('edit', 'edit.duplicate', 30, true);
      menu('edit', 'edit.delete', 31);
      menu('edit', 'edit.rename', 32);
      menu('edit', 'edit.selectAll', 40, true);

      const ALIGN = ['arrange.align.left', 'arrange.align.hcenter', 'arrange.align.right', '-', 'arrange.align.top', 'arrange.align.vcenter', 'arrange.align.bottom'];
      const DISTRIBUTE = ['arrange.distribute.h', 'arrange.distribute.v', '-', 'arrange.tidy', 'arrange.radial'];
      const SIZE = ['arrange.matchWidth', 'arrange.matchHeight'];
      const ORDER = ['arrange.bringToFront', 'arrange.bringForward', 'arrange.sendBackward', 'arrange.sendToBack'];
      const ROTATE = ['arrange.rotateLeft', 'arrange.rotateRight', 'arrange.resetRotation'];
      menu('arrange', 'arrange.group', 10);
      menu('arrange', 'arrange.ungroup', 11);
      menu('arrange', 'arrange.wrapFrame', 12);
      menu('arrange', 'arrange.wrapStack', 13);
      menu('arrange', { label: 'Align', icon: 'align-left', submenu: submenu(ALIGN), disabled: anyEnabled(ALIGN) }, 20, true);
      menu('arrange', { label: 'Distribute', icon: 'distribute-h', submenu: submenu(DISTRIBUTE), disabled: anyEnabled(DISTRIBUTE) }, 21);
      menu('arrange', { label: 'Match size', icon: 'sizing-fixed', submenu: submenu(SIZE), disabled: anyEnabled(SIZE) }, 22);
      menu('arrange', { label: 'Order', icon: 'bring-front', submenu: submenu(ORDER), disabled: anyEnabled(ORDER) }, 30, true);
      menu('arrange', { label: 'Rotate', icon: 'rotate', submenu: submenu(ROTATE), disabled: anyEnabled(ROTATE) }, 31);
      menu('arrange', 'arrange.lock', 40, true);
      menu('arrange', 'arrange.hide', 41);

      menu('help', 'help.shortcuts', 10);
      menu('help', 'help.about', 90, true);
    }
  });
})();

/*
 * inspector — the Design panel (right side, ARCHITECTURE.md §8; PLAN C1).
 *
 * One panel, two faces:
 *  - with a selection it is the node inspector: header (type, name, breakpoint, lock/hide) plus
 *    Position & size, Layout, Content (from the element type's `inspector` specs), Typography,
 *    Fill, Border, Effects, Attributes, Custom CSS and — for instances — component overrides,
 *    followed by any section other plugins registered with `ui.registerInspectorSection`;
 *  - with nothing selected it shows the document styles UI owned by `features/tokens.js`.
 *
 * Editing model
 *  - No Apply button: every control writes through `docops.update` as it changes, with the
 *    coalesce key `inspector:<field>:<ids>#<burst>`, so a whole drag or typing burst collapses
 *    into ONE undo entry and the next burst starts a new one.
 *  - Values are shown for the active breakpoint (`schema.effectiveNode`). Away from the base
 *    breakpoint, a field that carries an override at that breakpoint shows the override dot and
 *    its reset button deletes just that override.
 *  - Multi-selection shows shared values, "Mixed" where they differ, and writes to every node the
 *    field applies to (fields that apply to nothing are hidden).
 *  - Refreshes are rAF-throttled and only push new values into the existing controls; the DOM is
 *    rebuilt only when the selected ids/types (or the things the layout depends on) change, and
 *    never while the focus is inside the control being updated.
 */
(function () {
  'use strict';

  const ICON_ALIAS = { shape: 'rect' };
  const MAX_NAME = 200;

  const FONT_WEIGHTS = [['', 'Inherit'], ['300', 'Light 300'], ['400', 'Regular 400'], ['500', 'Medium 500'],
    ['600', 'Semibold 600'], ['700', 'Bold 700'], ['800', 'Extrabold 800'], ['900', 'Black 900']];

  const SHADOW_PRESETS = [
    { value: '', label: 'None' },
    { value: '0 1px 2px rgba(0,0,0,0.08)', label: 'Subtle' },
    { value: '0 4px 12px rgba(0,0,0,0.12)', label: 'Soft' },
    { value: '0 12px 32px rgba(0,0,0,0.16)', label: 'Medium' },
    { value: '0 24px 64px rgba(0,0,0,0.20)', label: 'Large' },
    { value: 'inset 0 2px 6px rgba(0,0,0,0.15)', label: 'Inner' }
  ];

  const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge',
    'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

  const ROLES = ['', 'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'search',
    'form', 'list', 'listitem', 'group', 'presentation', 'none', 'img', 'button', 'link', 'heading'];

  const THIRDS = ['start', 'center', 'end'];

  APB.plugin({
    id: 'inspector',
    order: 41,
    requires: ['util', 'schema', 'elements', 'style', 'widgets', 'icons', 'sanitize', 'color', 'docops'],

    init(app) {
      const util = APB.require('util');
      const schema = APB.require('schema');
      const elements = APB.require('elements');
      const widgets = APB.require('widgets');
      const icons = APB.require('icons');
      const sanitize = APB.require('sanitize');
      const docops = APB.require('docops');
      const tokensMod = APB.has('tokens') ? APB.require('tokens') : null;
      const h = widgets.h;
      const store = app.store;
      const ui = app.ui;
      if (!ui || typeof ui.registerPanel !== 'function') return;

      ui.registerPanel({ id: 'design', side: 'right', title: 'Design', icon: 'design', order: 10, mount });

      /* ================================================================= mount */

      function mount(container) {
        const root = h('div', { class: 'apb-inspector apb-panel-fill' });
        const head = h('div', { class: 'apb-inspector-head' });
        const body = h('div', { class: 'apb-panel-scroll apb-inspector-body' });
        root.append(head, body);
        container.appendChild(root);

        const offs = [];
        const bursts = new Map();
        const aspect = { locked: false, ratios: new Map() };
        const fillMode = new Map();      // node id → last chosen fill editor ('solid'|'gradient'|'image')
        let fields = [];
        let extInstances = [];
        let docStyles = null;
        let selNodes = [];
        let lastSelection = [];
        let sig = null;
        let raf = 0;
        let destroyed = false;

        /* ------------------------------------------------------------ model */

        const doc = () => store.doc;
        const bpList = () => {
          const s = doc().settings;
          return s && Array.isArray(s.breakpoints) && s.breakpoints.length ? s.breakpoints : schema.DEFAULT_BREAKPOINTS;
        };
        const bpId = () => store.view.bp || bpList()[0].id;
        const isBase = () => bpId() === bpList()[0].id;
        const bpLabel = () => { const b = bpList().find((x) => x.id === bpId()); return b ? b.label : bpId(); };
        const effOf = (node) => schema.effectiveNode(doc(), node, bpId()) || node;
        const defOf = (node) => elements.get(node.type) || null;
        const capsOf = (node) => { const d = defOf(node); return (d && d.caps) || elements.DEFAULT_CAPS; };
        const isContainer = (node) => Array.isArray(node.children);
        const parentEffOf = (node) => {
          const p = node.parent ? doc().nodes[node.parent] : null;
          return p ? effOf(p) : null;
        };
        const inStack = (node) => {
          const pe = parentEffOf(node);
          return !!(pe && pe.layout && pe.layout.mode === 'stack');
        };
        const omits = (node, key) => {
          try { return elements.styleOmit(node.type, effOf(node)).includes(key); } catch (_) { return false; }
        };
        const selectionNodes = () => store.selection.map((id) => doc().nodes[id]).filter(Boolean);

        /* ---------------------------------------------------------- history */

        function burstKey(id, ids) {
          return 'inspector:' + id + ':' + ids.join(',') + '#' + (bursts.get(id) || 0);
        }

        function hasOverride(node, top, sub) {
          if (isBase() || !top || !schema.BP_KEYS.includes(top)) return false;
          const bag = node.bp && node.bp[bpId()];
          if (!util.isPlainObject(bag)) return false;
          if (!sub) return bag[top] !== undefined;
          const inner = bag[top];
          if (!util.isPlainObject(inner)) return false;
          return (Array.isArray(sub) ? sub : [sub]).some((s) => inner[s] !== undefined);
        }

        function overrideParts(def) {
          const key = typeof def.key === 'string' ? def.key : '';
          const parts = key.split('.');
          const top = def.bpTop !== undefined ? def.bpTop : parts[0];
          const sub = def.bpSub !== undefined ? def.bpSub : (parts.length > 1 ? parts[1] : null);
          return { top, sub };
        }

        function commit(f, value, ctx) {
          const def = f.def;
          const ids = f.nodes.map((n) => n.id);
          if (!ids.length) return;
          const opts = { coalesce: burstKey(def.id, ids) };
          if (def.label) opts.label = 'Set ' + String(def.label).toLowerCase();
          if (def.base) opts.bp = null;
          try {
            if (typeof def.write === 'function') def.write(value, ids, opts, ctx);
            else docops.update(app, ids, def.patch ? def.patch(value) : { [def.key]: value }, opts);
          } catch (err) {
            if (typeof app.notifyError === 'function') app.notifyError('That value could not be applied.');
            app.log('inspector write failed: ' + (err && err.message), { level: 'error' });
          }
          if (ctx && ctx.commit) {
            bursts.set(def.id, (bursts.get(def.id) || 0) + 1);
            aspect.ratios.clear();
          }
        }

        function resetOverride(f) {
          if (isBase()) return;
          const { top, sub } = overrideParts(f.def);
          const subs = sub == null ? null : (Array.isArray(sub) ? sub : [sub]);
          const b = bpId();
          const ids = f.nodes.map((n) => n.id).filter((id) => hasOverride(doc().nodes[id], top, sub));
          if (!ids.length) return;
          store.transact('Reset ' + String(f.def.label || 'value').toLowerCase(), (tx) => {
            for (const id of ids) {
              const base = ['nodes', id, 'bp', b];
              if (subs) {
                subs.forEach((s) => tx.set(base.concat(top, s), undefined));
                const inner = tx.get(base.concat(top));
                if (util.isPlainObject(inner) && !Object.keys(inner).length) tx.set(base.concat(top), undefined);
              } else {
                tx.set(base.concat(top), undefined);
              }
              const bag = tx.get(base);
              if (util.isPlainObject(bag) && !Object.keys(bag).length) tx.set(base, undefined);
            }
          });
        }

        function resetAllOverrides() {
          const b = bpId();
          const ids = selNodes.map((n) => n.id).filter((id) => util.isPlainObject((doc().nodes[id].bp || {})[b]));
          if (!ids.length) return;
          store.transact('Reset ' + bpLabel() + ' overrides', (tx) => {
            ids.forEach((id) => tx.set(['nodes', id, 'bp', b], undefined));
          });
        }

        function overrideCount() {
          const b = bpId();
          if (isBase()) return 0;
          return selNodes.filter((n) => util.isPlainObject((n.bp || {})[b]) && Object.keys(n.bp[b]).length).length;
        }

        /* ------------------------------------------------------ field plumbing */

        /**
         * addField(parent, def) — def:
         *   { id, label, key, hint, base, control(write) → element, read(eff, node), out(value),
         *     fallback, applies(node, eff, def), disabled(nodes) → false|string, tune(f, nodes),
         *     write(value, ids, opts, ctx), patch(value), bpTop, bpSub, row: false }
         */
        function addField(parent, def) {
          let f = null;
          const write = (value, ctx) => commit(f, value, ctx);
          const ctl = def.control(write);
          const row = widgets.fieldRow({
            label: def.label, control: ctl, hint: def.hint,
            layout: def.layout, className: def.className,
            onReset: () => (typeof def.onReset === 'function' ? def.onReset(f) : resetOverride(f))
          });
          f = { def, ctl, row, api: ctl.apbControl || null, nodes: [] };
          fields.push(f);
          if (parent) parent.appendChild(row);
          return f;
        }

        function syncField(f) {
          const def = f.def;
          const nodes = def.applies ? selNodes.filter((n) => def.applies(n, effOf(n), defOf(n))) : selNodes.slice();
          f.nodes = nodes;
          f.row.hidden = !nodes.length;
          if (!nodes.length) return;
          if (typeof def.tune === 'function') def.tune(f, nodes);
          const api = f.api;
          if (api) {
            const focused = f.ctl.contains(document.activeElement);
            if (!focused) {
              const vals = nodes.map((n) => (def.read ? def.read(effOf(n), n) : util.getPath(effOf(n), def.key)));
              const first = vals[0];
              const mixed = vals.some((v) => !util.deepEqual(v, first));
              if (mixed && typeof api.setMixed === 'function') api.setMixed(true);
              else {
                if (typeof api.setMixed === 'function') api.setMixed(false);
                const out = def.out ? def.out(first) : first;
                api.value = out === undefined || out === null ? (def.fallback !== undefined ? def.fallback : null) : out;
              }
            }
            if (typeof api.setDisabled === 'function') {
              const d = def.disabled ? def.disabled(nodes) : false;
              api.setDisabled(!!d);
              f.row.classList.toggle('is-disabled', !!d);
              if (f.row.apbRow && (typeof d === 'string' || def.hint !== undefined)) {
                f.row.apbRow.setHint(typeof d === 'string' ? d : (def.hint || ''));
              }
            }
          }
          if (f.row.apbRow) {
            const { top, sub } = overrideParts(def);
            f.row.apbRow.setOverridden(typeof def.overridden === 'function'
              ? !!def.overridden(nodes)
              : nodes.some((n) => hasOverride(n, top, sub)));
          }
        }

        /* ------------------------------------------------------ section helper */

        function sectionPrefs() {
          const p = store.prefs.inspector;
          return (p && util.isPlainObject(p.sections)) ? p.sections : {};
        }

        function sec(id, title, opts) {
          const o = opts || {};
          const saved = sectionPrefs()[id];
          const collapsed = saved === undefined ? !!o.collapsed : !!saved;
          const el = widgets.section({
            title, collapsed, className: 'apb-inspector-section', actions: o.actions,
            onToggle: (c) => store.setPrefs({ inspector: { sections: { [id]: c } } })
          });
          el.dataset.section = id;
          return el;
        }

        /* ==================================================== custom controls */

        /** 4-side numeric control (padding, radius) with a link toggle. */
        function sidesControl(o) {
          let linked = true;
          let forced = false;
          let mixed = false;
          let disabled = false;
          let current = [0, 0, 0, 0];
          const labels = o.labels || ['Top', 'Right', 'Bottom', 'Left'];

          const emit = (commitFlag) => {
            if (disabled) return;
            const v = linked
              ? (o.allowScalar ? current[0] : [current[0], current[0], current[0], current[0]])
              : current.slice();
            o.onInput(v, { commit: !!commitFlag });
          };

          const single = widgets.numberField({
            ariaLabel: o.label || 'All sides', min: o.min, step: 1, unit: o.unit,
            onInput: (v, ctx) => { current = [v || 0, v || 0, v || 0, v || 0]; emit(ctx && ctx.commit); }
          });
          const inputs = labels.map((lbl, i) => widgets.numberField({
            ariaLabel: lbl, min: o.min, step: 1, unit: o.unit,
            onInput: (v, ctx) => { current[i] = v || 0; emit(ctx && ctx.commit); }
          }));
          const grid = h('div', { class: 'apb-sides-grid' }, inputs.map((el, i) =>
            h('span', { class: 'apb-sides-cell', 'data-side': labels[i] }, el)));
          const linkBtn = widgets.iconButton({
            icon: 'link', label: 'Link all sides', pressed: true, size: 'sm', className: 'apb-sides-link',
            onClick: () => { forced = true; setLinked(!linked); if (linked) { current = [current[0], current[0], current[0], current[0]]; emit(true); } }
          });
          const el = h('div', { class: 'apb-sides' }, single, grid, linkBtn);

          function setLinked(v) {
            linked = !!v;
            single.hidden = !linked;
            grid.hidden = linked;
            linkBtn.apbControl.setPressed(linked);
            el.classList.toggle('is-linked', linked);
          }
          setLinked(true);

          function render() {
            single.apbControl.value = current[0];
            inputs.forEach((inp, i) => { inp.apbControl.value = current[i]; });
          }

          const api = {
            el,
            labelTarget: single.apbControl.input,
            get value() { return mixed ? null : (linked && o.allowScalar ? current[0] : current.slice()); },
            set value(v) {
              mixed = false;
              const arr = Array.isArray(v) ? [0, 1, 2, 3].map((i) => Number(v[i]) || 0)
                : [Number(v) || 0, Number(v) || 0, Number(v) || 0, Number(v) || 0];
              current = arr;
              const same = arr.every((n) => n === arr[0]);
              if (!forced) setLinked(same);
              render();
            },
            setMixed(m) {
              mixed = !!m;
              single.apbControl.setMixed(mixed);
              inputs.forEach((inp) => inp.apbControl.setMixed(mixed));
            },
            setDisabled(d) {
              disabled = !!d;
              single.apbControl.setDisabled(disabled);
              inputs.forEach((inp) => inp.apbControl.setDisabled(disabled));
              linkBtn.apbControl.setDisabled(disabled);
            },
            focus() { (linked ? single : inputs[0]).apbControl.focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /** 3×3 alignment picker → { align, justify } for a stack container. */
        function alignGrid(o) {
          let dir = 'column';
          let value = { align: 'start', justify: 'start' };
          let disabled = false;
          const cells = [];
          const el = h('div', { class: 'apb-aligngrid', role: 'radiogroup', 'aria-label': 'Content alignment' });

          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
              const btn = h('button', {
                type: 'button', class: 'apb-aligngrid-cell', role: 'radio', 'aria-checked': 'false', tabindex: '-1',
                'data-r': String(r), 'data-c': String(c)
              }, h('span', { class: 'apb-aligngrid-dot', 'aria-hidden': 'true' }));
              btn.addEventListener('click', () => choose(r, c));
              cells.push(btn);
              el.appendChild(btn);
            }
          }

          const pair = (r, c) => (dir === 'row'
            ? { justify: THIRDS[c], align: THIRDS[r] }
            : { justify: THIRDS[r], align: THIRDS[c] });

          function labelFor(r, c) {
            const p = pair(r, c);
            return 'Justify ' + p.justify + ', align ' + p.align;
          }

          function choose(r, c) {
            if (disabled) return;
            value = pair(r, c);
            render();
            o.onInput(Object.assign({}, value), { commit: true });
          }

          el.addEventListener('keydown', (e) => {
            const idx = cells.indexOf(document.activeElement);
            if (idx < 0) return;
            const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
            if (!(e.key in map)) return;
            e.preventDefault();
            const next = Math.max(0, Math.min(8, idx + map[e.key]));
            cells[next].focus();
            choose(Math.floor(next / 3), next % 3);
          });

          function render() {
            let activeIdx = -1;
            for (let i = 0; i < 9; i++) {
              const r = Math.floor(i / 3);
              const c = i % 3;
              const p = pair(r, c);
              const on = p.align === value.align && p.justify === value.justify;
              if (on) activeIdx = i;
              cells[i].setAttribute('aria-checked', String(on));
              cells[i].setAttribute('aria-label', labelFor(r, c));
              cells[i].classList.toggle('is-active', on);
              cells[i].tabIndex = -1;
            }
            cells[activeIdx >= 0 ? activeIdx : 0].tabIndex = 0;
          }
          render();

          const api = {
            el,
            labelTarget: el,
            get value() { return Object.assign({}, value); },
            set value(v) {
              if (v && typeof v === 'object') value = { align: v.align || 'start', justify: v.justify || 'start' };
              render();
            },
            setMixed(m) { el.classList.toggle('is-mixed', !!m); },
            setDisabled(d) { disabled = !!d; cells.forEach((b) => { b.disabled = disabled; }); el.setAttribute('aria-disabled', String(disabled)); },
            setDir(d) { dir = d === 'row' ? 'row' : 'column'; render(); },
            focus() { (cells.find((b) => b.tabIndex === 0) || cells[0]).focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /**
         * Editable string list (list element items). `o.checkable` switches items to
         * `{ id, text, checked }` objects with a checkbox per row (used by the `checklist` type —
         * see `features/element-types-extra.js`); plain items stay flat strings.
         */
        function listEditor(o) {
          const checkable = !!o.checkable;
          let items = [];
          let disabled = false;
          const rows = h('div', { class: 'apb-listedit-rows' });
          const addBtn = widgets.button({
            label: 'Add item', icon: 'plus', size: 'sm', variant: 'subtle',
            onClick: () => {
              items = items.concat([checkable ? { id: util.uid('ci'), text: 'New item', checked: false } : 'New item']);
              render(); o.onInput(items.slice(), { commit: true }); focusRow(items.length - 1);
            }
          });
          const el = h('div', { class: ['apb-listedit', checkable && 'apb-listedit--checkable'] }, rows, addBtn);

          function focusRow(i) {
            const input = rows.children[i] && rows.children[i].querySelector('input');
            if (input) { input.focus(); input.select(); }
          }
          function move(i, delta) {
            const j = i + delta;
            if (j < 0 || j >= items.length) return;
            const copy = items.slice();
            const [it] = copy.splice(i, 1);
            copy.splice(j, 0, it);
            items = copy;
            render();
            o.onInput(items.slice(), { commit: true });
            focusRow(j);
          }
          function render() {
            rows.replaceChildren(...items.map((item, i) => {
              const text = checkable ? (item && item.text) || '' : item;
              const input = widgets.textField({
                value: text, ariaLabel: 'Item ' + (i + 1),
                onInput: (v, ctx) => {
                  items[i] = checkable ? Object.assign({}, items[i], { text: v }) : v;
                  o.onInput(items.slice(), { commit: !!(ctx && ctx.commit) });
                }
              });
              const check = checkable ? widgets.toggle({
                ariaLabel: 'Checked', checked: !!(item && item.checked), labelVisible: false,
                onInput: (v) => { items[i] = Object.assign({}, items[i], { checked: v }); o.onInput(items.slice(), { commit: true }); }
              }) : null;
              return h('div', { class: 'apb-listedit-row' }, check, input,
                widgets.iconButton({ icon: 'chevron-up', label: 'Move item ' + (i + 1) + ' up', size: 'sm', disabled: i === 0, onClick: () => move(i, -1) }),
                widgets.iconButton({ icon: 'chevron-down', label: 'Move item ' + (i + 1) + ' down', size: 'sm', disabled: i === items.length - 1, onClick: () => move(i, 1) }),
                widgets.iconButton({ icon: 'trash', label: 'Remove item ' + (i + 1), size: 'sm', onClick: () => { items = items.filter((_, k) => k !== i); render(); o.onInput(items.slice(), { commit: true }); } }));
            }));
          }

          const api = {
            el, labelTarget: addBtn,
            get value() { return items.slice(); },
            set value(v) {
              const list = Array.isArray(v) ? v : [];
              const next = checkable
                ? list.map((it) => (util.isPlainObject(it)
                  ? { id: typeof it.id === 'string' && it.id ? it.id : util.uid('ci'), text: String(it.text || ''), checked: !!it.checked }
                  : { id: util.uid('ci'), text: String(it == null ? '' : it), checked: false }))
                : list.map((it) => (util.isPlainObject(it) ? String(it.text || '') : String(it == null ? '' : it)));
              if (util.deepEqual(next, items)) return;
              items = next;
              render();
            },
            setMixed(m) { el.classList.toggle('is-mixed', !!m); if (m) { items = []; render(); } },
            setDisabled(d) { disabled = !!d; el.inert = disabled; el.classList.toggle('is-disabled', disabled); },
            focus() { addBtn.focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /** Editable cell grid (table element rows). */
        function tableEditor(o) {
          let rowsData = [];
          const gridEl = h('div', { class: 'apb-tableedit-grid' });
          const bar = h('div', { class: 'apb-tableedit-bar' },
            widgets.button({ label: 'Row', icon: 'plus', size: 'sm', variant: 'subtle', onClick: () => addRow() }),
            widgets.button({ label: 'Column', icon: 'plus', size: 'sm', variant: 'subtle', onClick: () => addCol() }));
          const el = h('div', { class: 'apb-tableedit' }, gridEl, bar);

          const cols = () => rowsData.reduce((m, r) => Math.max(m, r.length), 1);
          const fire = (commitFlag) => o.onInput(rowsData.map((r) => r.slice()), { commit: !!commitFlag });

          function addRow() { rowsData = rowsData.concat([new Array(cols()).fill('')]); render(); fire(true); }
          function addCol() { rowsData = rowsData.map((r) => r.concat([''])); if (!rowsData.length) rowsData = [['']]; render(); fire(true); }
          function delRow(i) { rowsData = rowsData.filter((_, k) => k !== i); render(); fire(true); }
          function delCol(c) { rowsData = rowsData.map((r) => r.filter((_, k) => k !== c)); render(); fire(true); }

          function render() {
            const n = cols();
            gridEl.style.setProperty('--apb-table-cols', String(n));
            const children = [];
            for (let c = 0; c < n; c++) {
              children.push(widgets.iconButton({ icon: 'trash', label: 'Delete column ' + (c + 1), size: 'sm', onClick: () => delCol(c) }));
            }
            children.push(h('span', { class: 'apb-tableedit-corner' }));
            rowsData.forEach((row, r) => {
              for (let c = 0; c < n; c++) {
                children.push(widgets.textField({
                  value: row[c] == null ? '' : String(row[c]), ariaLabel: 'Row ' + (r + 1) + ' column ' + (c + 1),
                  onInput: (v, ctx) => { rowsData[r][c] = v; fire(!!(ctx && ctx.commit)); }
                }));
              }
              children.push(widgets.iconButton({ icon: 'trash', label: 'Delete row ' + (r + 1), size: 'sm', onClick: () => delRow(r) }));
            });
            gridEl.replaceChildren(...children);
          }

          const api = {
            el, labelTarget: gridEl.querySelector('input') || bar.firstChild,
            get value() { return rowsData.map((r) => r.slice()); },
            set value(v) {
              const next = (Array.isArray(v) ? v : []).filter(Array.isArray).map((r) => r.map((c) => (c == null ? '' : String(c))));
              if (util.deepEqual(next, rowsData)) return;
              rowsData = next;
              render();
            },
            setMixed(m) { el.classList.toggle('is-mixed', !!m); if (m) { rowsData = []; render(); } },
            setDisabled(d) { el.inert = !!d; el.classList.toggle('is-disabled', !!d); },
            focus() { const i = gridEl.querySelector('input'); if (i) i.focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /** Icon name picker (searchable grid over icons.list()). */
        function iconPicker(o) {
          let value = '';
          const preview = h('span', { class: 'apb-iconpick-preview', 'aria-hidden': 'true' });
          const btn = h('button', { type: 'button', class: 'apb-iconpick' }, preview, h('span', { class: 'apb-iconpick-name' }, 'None'));
          const el = h('div', { class: 'apb-iconpick-wrap' }, btn);
          let pop = null;

          function render() {
            preview.replaceChildren(value && icons.has(value) ? icons.get(value, { size: 16 }) : icons.get('image-off', { size: 16 }));
            btn.lastChild.textContent = value || 'None';
            btn.setAttribute('aria-label', 'Icon: ' + (value || 'none'));
          }

          function open() {
            if (pop) { pop.close('toggle'); return; }
            const search = widgets.textField({ ariaLabel: 'Search icons', placeholder: 'Search…', icon: 'search', onInput: (v) => paint(v) });
            const grid = h('div', { class: 'apb-iconpick-grid', role: 'listbox', 'aria-label': 'Icons' });
            const paint = (q) => {
              const query = String(q || '').trim().toLowerCase();
              const names = icons.list().filter((n) => !query || n.includes(query)).slice(0, 200);
              grid.replaceChildren(...names.map((n) => {
                const b = h('button', {
                  type: 'button', class: ['apb-iconpick-item', n === value && 'is-active'], role: 'option',
                  'aria-selected': String(n === value), title: n, 'aria-label': n
                }, icons.get(n, { size: 18 }));
                b.addEventListener('click', () => { value = n; render(); o.onInput(n, { commit: true }); if (pop) pop.close('pick'); });
                return b;
              }));
            };
            paint('');
            pop = widgets.popover({
              anchor: btn, className: 'apb-iconpick-pop', label: 'Choose an icon', matchWidth: false,
              content: h('div', {}, search, grid), onClose: () => { pop = null; }
            });
          }
          btn.addEventListener('click', open);
          render();

          const api = {
            el, labelTarget: btn,
            get value() { return value; },
            set value(v) { value = typeof v === 'string' ? v : ''; render(); },
            setMixed(m) { el.classList.toggle('is-mixed', !!m); if (m) { value = ''; render(); } },
            setDisabled(d) { btn.disabled = !!d; },
            focus() { btn.focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /** Asset chooser: thumbnail + pick/clear (services.assets when available). */
        function assetField(o) {
          let value = '';
          const assets = () => (app.services && app.services.assets) || null;
          const thumb = h('span', { class: 'apb-assetfield-thumb', 'aria-hidden': 'true' });
          const pickBtn = widgets.button({
            label: 'Choose…', size: 'sm', variant: 'subtle',
            onClick: () => {
              const svc = assets();
              if (!svc || typeof svc.pick !== 'function') return;
              Promise.resolve(svc.pick({ accept: o.accept || 'image/*' })).then((id) => {
                if (!id) return;
                value = id;
                render();
                o.onInput(id, { commit: true });
              }).catch(() => { /* cancelled */ });
            }
          });
          const clearBtn = widgets.iconButton({
            icon: 'close', label: 'Remove image', size: 'sm',
            onClick: () => { value = ''; render(); o.onInput('', { commit: true }); }
          });
          const el = h('div', { class: 'apb-assetfield' }, thumb, pickBtn, clearBtn);

          function render() {
            const svc = assets();
            const src = value && svc && typeof svc.url === 'function' ? svc.url(value) : '';
            thumb.replaceChildren();
            if (src) {
              const img = h('img', { alt: '', loading: 'lazy' });
              img.src = src;
              thumb.appendChild(img);
            } else {
              thumb.appendChild(icons.get('image', { size: 16 }));
            }
            clearBtn.hidden = !value;
            const ok = !!svc && typeof svc.pick === 'function';
            pickBtn.apbControl.setDisabled(!ok, ok ? '' : 'The asset library is not loaded — use the URL field.');
          }
          render();

          const api = {
            el, labelTarget: pickBtn,
            get value() { return value; },
            set value(v) { value = typeof v === 'string' ? v : ''; render(); },
            setMixed(m) { el.classList.toggle('is-mixed', !!m); if (m) { value = ''; render(); } },
            setDisabled(d) { pickBtn.apbControl.setDisabled(!!d); clearBtn.disabled = !!d; },
            focus() { pickBtn.focus(); }
          };
          el.apbControl = api;
          return el;
        }

        /* ======================================================= section builders */

        function numberCtl(o) {
          return (write) => widgets.numberField(Object.assign({}, o, {
            onInput: (v, ctx) => write(v == null ? (o.clearTo !== undefined ? o.clearTo : undefined) : v, ctx)
          }));
        }

        function selectCtl(options, o) {
          return (write) => widgets.select(Object.assign({ options }, o, {
            onInput: (v, ctx) => write(v === '' && (!o || o.emptyClears !== false) ? undefined : v, ctx)
          }));
        }

        function colorCtl(o) {
          return (write) => widgets.colorField(Object.assign({ app }, o, {
            onInput: (v, ctx) => write(v == null ? undefined : v, ctx)
          }));
        }

        function textCtl(o) {
          return (write) => widgets.textField(Object.assign({}, o, { onInput: (v, ctx) => write(v, ctx) }));
        }

        /* ------------------------------------------------- position & size */

        function buildPosition(parent) {
          const s = sec('position', 'Position & size');
          const grid = h('div', { class: 'apb-field-grid' });
          s.apbSection.body.appendChild(grid);

          const geom = (key, label) => addField(grid, {
            id: key, key, label,
            control: numberCtl({ ariaLabel: label, step: 1, scrub: true }),
            applies: (n) => !!n.parent,
            disabled: (nodes) => {
              if ((key === 'x' || key === 'y') && nodes.every(inStack)) return 'Positioned by the stack layout';
              if (key === 'w' && nodes.every((n) => (effOf(n).sizing || {}).w !== 'fixed')) return 'Width follows the sizing mode';
              if (key === 'h' && nodes.every((n) => (effOf(n).sizing || {}).h !== 'fixed')) return 'Height follows the sizing mode';
              return false;
            },
            write: (value, ids, opts, ctx) => writeGeom(key, value, ids, opts, ctx)
          });

          geom('x', 'X');
          geom('y', 'Y');
          geom('w', 'W');
          geom('h', 'H');

          const lockBtn = widgets.iconButton({
            icon: 'link', label: 'Lock aspect ratio', pressed: false, size: 'sm', className: 'apb-aspect-lock',
            onClick: (e, api) => { aspect.locked = !aspect.locked; api.setPressed(aspect.locked); }
          });
          grid.appendChild(h('div', { class: 'apb-field-grid-extra' }, lockBtn));

          addField(s.apbSection.body, {
            id: 'rotation', key: 'rotation', label: 'Rotation',
            control: numberCtl({ ariaLabel: 'Rotation', step: 1, unit: '°', wrap: true, min: -360, max: 360 }),
            applies: (n) => !!n.parent && !inStack(n)
          });

          const sizingOptions = (axis) => [
            { value: 'fixed', label: 'Fixed', icon: 'sizing-fixed', title: 'Fixed size' },
            { value: 'fill', label: 'Fill', icon: 'sizing-fill', title: 'Fill the parent' },
            { value: 'hug', label: 'Hug', icon: 'sizing-hug', title: 'Hug the content' + (axis === 'h' ? '' : '') }
          ];

          ['w', 'h'].forEach((axis) => {
            const options = sizingOptions(axis);
            addField(s.apbSection.body, {
              id: 'sizing-' + axis, key: 'sizing.' + axis, label: axis === 'w' ? 'Width sizing' : 'Height sizing',
              fallback: 'fixed',
              control: (write) => widgets.segmented({
                options, iconOnly: false, size: 'sm', ariaLabel: (axis === 'w' ? 'Width' : 'Height') + ' sizing',
                onInput: (v, ctx) => write(v, ctx)
              }),
              applies: (n) => !!n.parent,
              tune: (f, nodes) => {
                options[1].disabled = !nodes.some((n) => !!n.parent);
                options[2].disabled = !nodes.some((n) => canHug(n, axis));
                if (f.api && typeof f.api.setDisabled === 'function') f.api.setDisabled(false);
              }
            });
          });

          parent.appendChild(s);
        }

        function canHug(node, axis) {
          if (!inStack(node)) return false;                       // free parents place children absolutely
          if (isContainer(node)) {
            const layout = effOf(node).layout || {};
            if (layout.mode === 'free' && axis === 'h') return false; // free containers cannot hug height
          }
          return true;
        }

        function ensureRatios(ids) {
          if (aspect.ratios.size) return aspect.ratios;
          for (const id of ids) {
            const e = effOf(doc().nodes[id]);
            const w = Number(e.w) || 1;
            const ht = Number(e.h) || 1;
            aspect.ratios.set(id, w / ht);
          }
          return aspect.ratios;
        }

        function writeGeom(key, value, ids, opts, ctx) {
          if (value === undefined || value === null) return;
          if (!aspect.locked || (key !== 'w' && key !== 'h')) {
            docops.update(app, ids, { [key]: value }, opts);
            return;
          }
          const ratios = ensureRatios(ids);
          for (const id of ids) {
            const r = ratios.get(id) || 1;
            const patch = key === 'w'
              ? { w: value, h: Math.max(1, Math.round(value / (r || 1))) }
              : { h: value, w: Math.max(1, Math.round(value * (r || 1))) };
            docops.update(app, [id], patch, opts);
          }
          if (ctx && ctx.commit) aspect.ratios.clear();
        }

        /* --------------------------------------------------------- layout */

        function buildLayout(parent) {
          const anyContainer = selNodes.some(isContainer);
          const anyPadding = selNodes.some((n) => capsOf(n).padding && !isContainer(n) && !omits(n, 'padding'));
          if (!anyContainer && !anyPadding) return;
          const s = sec('layout', 'Layout');
          const bodyEl = s.apbSection.body;

          addField(bodyEl, {
            id: 'layout-mode', key: 'layout.mode', label: 'Layout', fallback: 'free',
            control: (write) => widgets.segmented({
              ariaLabel: 'Layout mode', size: 'sm',
              options: [{ value: 'free', label: 'Free', icon: 'frame' }, { value: 'stack', label: 'Stack', icon: 'stack-column' }],
              onInput: (v, ctx) => write(v, ctx)
            }),
            applies: (n) => isContainer(n)
          });

          addField(bodyEl, {
            id: 'layout-dir', key: 'layout.dir', label: 'Direction', fallback: 'column',
            control: (write) => widgets.segmented({
              ariaLabel: 'Stack direction', size: 'sm',
              options: [{ value: 'column', label: 'Vertical', icon: 'stack-column' }, { value: 'row', label: 'Horizontal', icon: 'stack-row' }],
              onInput: (v, ctx) => write(v, ctx)
            }),
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack'
          });

          addField(bodyEl, {
            id: 'layout-gap', key: 'layout.gap', label: 'Gap', fallback: 0,
            control: numberCtl({ ariaLabel: 'Gap', min: 0, step: 1, clearTo: 0 }),
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack'
          });

          addField(bodyEl, {
            id: 'layout-align', label: 'Align', key: 'layout.align', bpTop: 'layout', bpSub: ['align', 'justify'],
            layout: 'stacked',
            control: (write) => alignGrid({ onInput: (v, ctx) => write(v, ctx) }),
            read: (eff) => {
              const l = eff.layout || {};
              return { align: THIRDS.includes(l.align) ? l.align : 'start', justify: THIRDS.includes(l.justify) ? l.justify : 'start' };
            },
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack',
            tune: (f, nodes) => {
              const dir = (effOf(nodes[0]).layout || {}).dir === 'row' ? 'row' : 'column';
              if (f.api && f.api.setDir) f.api.setDir(dir);
            },
            patch: (v) => ({ 'layout.align': v.align, 'layout.justify': v.justify })
          });

          addField(bodyEl, {
            id: 'layout-justify', key: 'layout.justify', label: 'Distribute', fallback: 'start',
            control: selectCtl([
              { value: 'start', label: 'Packed at start' }, { value: 'center', label: 'Packed centre' },
              { value: 'end', label: 'Packed at end' }, { value: 'between', label: 'Space between' },
              { value: 'around', label: 'Space around' }
            ], { ariaLabel: 'Distribute', emptyClears: false }),
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack'
          });

          addField(bodyEl, {
            id: 'layout-stretch', key: 'layout.align', label: 'Stretch children',
            control: (write) => widgets.toggle({
              ariaLabel: 'Stretch children across the cross axis', labelVisible: false,
              onInput: (v, ctx) => write(v ? 'stretch' : 'start', ctx)
            }),
            read: (eff) => (eff.layout || {}).align === 'stretch',
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack'
          });

          addField(bodyEl, {
            id: 'layout-wrap', key: 'layout.wrap', label: 'Wrap', fallback: false,
            control: (write) => widgets.toggle({ ariaLabel: 'Wrap children', labelVisible: false, onInput: (v, ctx) => write(!!v, ctx) }),
            applies: (n) => isContainer(n) && (effOf(n).layout || {}).mode === 'stack' && (effOf(n).layout || {}).dir === 'row'
          });

          addField(bodyEl, {
            id: 'layout-pad', key: 'layout.pad', label: 'Padding', layout: 'stacked',
            control: (write) => sidesControl({ label: 'Padding', min: 0, onInput: (v, ctx) => write(v, ctx) }),
            read: (eff) => schema.normalizePad((eff.layout || {}).pad),
            applies: (n) => isContainer(n)
          });

          addField(bodyEl, {
            id: 'style-pad', key: 'style.padding', label: 'Padding', layout: 'stacked',
            control: (write) => sidesControl({ label: 'Padding', min: 0, onInput: (v, ctx) => write(v, ctx) }),
            read: (eff) => schema.normalizePad((eff.style || {}).padding),
            applies: (n) => !isContainer(n) && capsOf(n).padding && !omits(n, 'padding')
          });

          addField(bodyEl, {
            id: 'style-overflow', key: 'style.overflow', label: 'Overflow', fallback: 'visible',
            control: selectCtl([
              { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' },
              { value: 'auto', label: 'Scroll when needed' }
            ], { ariaLabel: 'Overflow', emptyClears: false }),
            applies: (n) => isContainer(n)
          });

          parent.appendChild(s);
        }

        /* -------------------------------------------------------- content */

        function contentFields(parent) {
          const types = util.uniq(selNodes.map((n) => n.type));
          if (types.length !== 1) return;
          const def = elements.get(types[0]);
          const groups = def && Array.isArray(def.inspector) ? def.inspector : [];
          groups.forEach((group, gi) => {
            const list = (group.fields || []).filter((spec) => spec && typeof spec.key === 'string');
            if (!list.length) return;
            const s = sec('content-' + types[0] + '-' + gi, group.title || 'Content');
            let any = false;
            list.forEach((spec) => { if (contentField(s.apbSection.body, spec, def)) any = true; });
            if (any) parent.appendChild(s);
          });
        }

        function contentField(parent, spec, def) {
          const key = spec.key;
          const label = spec.label || key.split('.').pop();
          const id = 'content:' + key;
          const bpAble = key.startsWith('props.')
            ? (Array.isArray(def.bpProps) && def.bpProps.includes(key.slice(6)))
            : key.startsWith('style.');
          const base = { id, key, label, hint: spec.hint, base: !bpAble };
          const applies = (n) => {
            if (typeof spec.when === 'function') {
              try { return !!spec.when(effOf(n), n); } catch (_) { return false; }
            }
            return true;
          };

          const options = () => {
            if (spec.options === 'components') {
              const comps = doc().components || {};
              return [{ value: '', label: 'None' }].concat(Object.keys(comps).map((cid) => ({ value: cid, label: comps[cid].name || cid })));
            }
            return Array.isArray(spec.options) ? spec.options : [];
          };

          switch (spec.type) {
            case 'textarea':
              addField(parent, Object.assign({}, base, {
                layout: 'stacked', fallback: '',
                control: (write) => widgets.textArea({ ariaLabel: label, rows: 3, placeholder: spec.placeholder, onInput: (v, ctx) => write(v, ctx) }),
                applies
              }));
              return true;
            case 'number':
              addField(parent, Object.assign({}, base, {
                control: numberCtl({ ariaLabel: label, min: spec.min, max: spec.max, step: spec.step == null ? 1 : spec.step }),
                applies
              }));
              return true;
            case 'url':
              addField(parent, Object.assign({}, base, {
                fallback: '',
                control: (write) => widgets.textField({
                  ariaLabel: label, placeholder: spec.placeholder || 'https://', type: 'text', clearable: true,
                  validate: (v) => (!v || sanitize.url(v, spec.urlKind || 'link') ? null : 'That link is not allowed (only http, https, mailto, tel and relative paths).'),
                  onInput: (v, ctx) => {
                    if (v && !sanitize.url(v, spec.urlKind || 'link')) return;   // never store a blocked URL
                    write(v, ctx);
                  }
                }),
                applies
              }));
              return true;
            case 'select':
              addField(parent, Object.assign({}, base, {
                fallback: '',
                control: (write) => {
                  const el = widgets.select({ ariaLabel: label, options: options(), onInput: (v, ctx) => write(v, ctx) });
                  if (spec.options === 'components') el.apbControl.setOptions(options());
                  return el;
                },
                tune: (f) => { if (spec.options === 'components' && f.api.setOptions) f.api.setOptions(options()); },
                applies
              }));
              return true;
            case 'toggle':
              addField(parent, Object.assign({}, base, {
                fallback: false,
                control: (write) => widgets.toggle({ ariaLabel: label, labelVisible: false, onInput: (v, ctx) => write(!!v, ctx) }),
                applies
              }));
              return true;
            case 'color':
              addField(parent, Object.assign({}, base, {
                control: colorCtl({ ariaLabel: label }),
                applies
              }));
              return true;
            case 'asset':
              addField(parent, Object.assign({}, base, {
                fallback: '',
                control: (write) => assetField({ accept: spec.accept, onInput: (v, ctx) => write(v, ctx) }),
                applies
              }));
              return true;
            case 'icon':
              addField(parent, Object.assign({}, base, {
                fallback: '',
                control: (write) => iconPicker({ onInput: (v, ctx) => write(v, ctx) }),
                applies
              }));
              return true;
            case 'list':
              addField(parent, Object.assign({}, base, {
                layout: 'stacked', fallback: [],
                control: (write) => listEditor({ checkable: !!spec.checkable, onInput: (v, ctx) => write(v, ctx) }),
                applies
              }));
              return true;
            case 'table':
              addField(parent, Object.assign({}, base, {
                layout: 'stacked', fallback: [],
                control: (write) => tableEditor({ onInput: (v, ctx) => write(v, ctx) }),
                applies
              }));
              return true;
            case 'code':
              addField(parent, Object.assign({}, base, {
                layout: 'stacked', fallback: '',
                hint: 'Sanitized when you leave the field.',
                control: (write) => widgets.textArea({
                  ariaLabel: label, rows: 5, monospace: true,
                  onInput: (v, ctx) => {
                    if (!ctx || !ctx.commit) { write(v, ctx); return; }
                    const clean = spec.language === 'css' ? sanitize.css(v) : sanitize.html(v, 'html');
                    write(clean, ctx);
                    if (clean !== v && ui.toast) ui.toast('Unsafe markup was removed', { kind: 'warning' });
                  }
                }),
                applies
              }));
              return true;
            default:
              addField(parent, Object.assign({}, base, {
                fallback: '',
                control: textCtl({ ariaLabel: label, placeholder: spec.placeholder }),
                applies
              }));
              return true;
          }
        }

        /* ----------------------------------------------------- typography */

        function buildTypography(parent) {
          if (!selNodes.some((n) => capsOf(n).text)) return;
          const s = sec('typography', 'Typography');
          const bodyEl = s.apbSection.body;
          const textish = (n) => capsOf(n).text;

          const textTokens = tokensMod ? tokensMod.texts(doc()) : [];
          if (textTokens.length) {
            addField(bodyEl, {
              id: 'textStyle', key: 'style.textStyle', label: 'Text style', fallback: '',
              control: selectCtl([{ value: '', label: 'Custom' }].concat(textTokens.map((t) => ({ value: t.id, label: t.name }))),
                { ariaLabel: 'Text style' }),
              applies: textish
            });
          }

          const fontOptions = () => [{ value: '', label: 'Inherit' }].concat(
            tokensMod ? tokensMod.fontOptions(doc()) : [{ value: 'system-ui, sans-serif', label: 'System sans' }]);

          addField(bodyEl, {
            id: 'fontFamily', key: 'style.fontFamily', label: 'Font', fallback: '',
            control: (write) => widgets.select({ ariaLabel: 'Font family', options: fontOptions(), onInput: (v, ctx) => write(v || undefined, ctx) }),
            tune: (f) => { if (f.api.setOptions) f.api.setOptions(fontOptions()); },
            applies: textish
          });

          const grid = h('div', { class: 'apb-field-grid' });
          bodyEl.appendChild(grid);
          addField(grid, { id: 'fontSize', key: 'style.fontSize', label: 'Size', control: numberCtl({ ariaLabel: 'Font size', min: 1, max: 400, step: 1 }), applies: textish });
          addField(grid, { id: 'lineHeight', key: 'style.lineHeight', label: 'Line height', control: numberCtl({ ariaLabel: 'Line height', min: 0, max: 10, step: 0.1, precision: 2 }), applies: textish });
          addField(grid, { id: 'letterSpacing', key: 'style.letterSpacing', label: 'Letter spacing', control: numberCtl({ ariaLabel: 'Letter spacing', min: -20, max: 40, step: 0.1, precision: 2 }), applies: textish });
          addField(grid, {
            id: 'fontWeight', key: 'style.fontWeight', label: 'Weight', fallback: '',
            control: selectCtl(FONT_WEIGHTS.map(([value, label]) => ({ value, label })), { ariaLabel: 'Font weight' }),
            out: (v) => (v == null ? '' : String(v)),
            write: (value, ids, opts) => docops.update(app, ids, { 'style.fontWeight': value ? Number(value) : undefined }, opts),
            applies: textish
          });

          addField(bodyEl, {
            id: 'textAlign', key: 'style.textAlign', label: 'Align', fallback: 'left',
            control: (write) => widgets.segmented({
              ariaLabel: 'Text align', size: 'sm', iconOnly: true,
              options: [
                { value: 'left', label: 'Left', icon: 'text-align-left' },
                { value: 'center', label: 'Centre', icon: 'text-align-center' },
                { value: 'right', label: 'Right', icon: 'text-align-right' },
                { value: 'justify', label: 'Justify', icon: 'text-align-justify' }
              ],
              onInput: (v, ctx) => write(v, ctx)
            }),
            applies: textish
          });

          addField(bodyEl, {
            id: 'valign', key: 'style.valign', label: 'Vertical align', fallback: 'top',
            control: (write) => widgets.segmented({
              ariaLabel: 'Vertical align', size: 'sm',
              options: [{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }],
              onInput: (v, ctx) => write(v, ctx)
            }),
            applies: textish
          });

          addField(bodyEl, {
            id: 'textDecoration', key: 'style.textDecoration', label: 'Decoration', fallback: '',
            control: selectCtl([
              { value: '', label: 'Inherit' }, { value: 'none', label: 'None' }, { value: 'underline', label: 'Underline' },
              { value: 'line-through', label: 'Strikethrough' }, { value: 'overline', label: 'Overline' }
            ], { ariaLabel: 'Text decoration' }),
            applies: textish
          });

          addField(bodyEl, {
            id: 'textTransform', key: 'style.textTransform', label: 'Case', fallback: '',
            control: selectCtl([
              { value: '', label: 'Inherit' }, { value: 'none', label: 'As typed' }, { value: 'uppercase', label: 'UPPERCASE' },
              { value: 'lowercase', label: 'lowercase' }, { value: 'capitalize', label: 'Capitalise' }
            ], { ariaLabel: 'Text transform' }),
            applies: textish
          });

          addField(bodyEl, {
            id: 'color', key: 'style.color', label: 'Colour',
            control: colorCtl({ ariaLabel: 'Text colour' }),
            applies: textish
          });

          parent.appendChild(s);
        }

        /* ----------------------------------------------------------- fill */

        function currentFillMode(node) {
          const st = effOf(node).style || {};
          if (util.isPlainObject(st.fillImage) && Object.keys(st.fillImage).length) return 'image';
          if (typeof st.fill === 'string' && /gradient\(/i.test(st.fill)) return 'gradient';
          if (typeof st.fill === 'string' && st.fill) return 'solid';
          // No value yet: keep the editor the user opened (so "no fill" does not jump back to None).
          return fillMode.get(node.id) === 'solid' ? 'solid' : 'none';
        }

        function buildFill(parent) {
          const fillable = (n) => capsOf(n).fill && !omits(n, 'fill');
          if (!selNodes.some(fillable)) return;
          const s = sec('fill', 'Fill');
          const bodyEl = s.apbSection.body;
          const modeHost = h('div', { class: 'apb-fill-body' });

          const modeCtl = widgets.segmented({
            ariaLabel: 'Fill type', size: 'sm',
            options: [
              { value: 'none', label: 'None' }, { value: 'solid', label: 'Solid', icon: 'droplet' },
              { value: 'gradient', label: 'Gradient', icon: 'palette' }, { value: 'image', label: 'Image', icon: 'image' }
            ],
            onInput: (v) => {
              const ids = selNodes.filter(fillable).map((n) => n.id);
              if (!ids.length) return;
              ids.forEach((id) => fillMode.set(id, v));
              const current = (effOf(doc().nodes[ids[0]]).style || {}).fill;
              const isGradient = typeof current === 'string' && /gradient\(/i.test(current);
              const solid = typeof current === 'string' && current && !isGradient ? current : '';
              const patch = {};
              if (v === 'none') { patch['style.fill'] = undefined; patch['style.fillImage'] = undefined; }
              else if (v === 'solid') { patch['style.fillImage'] = undefined; patch['style.fill'] = solid || '#e5e7eb'; }
              else if (v === 'gradient') {
                patch['style.fillImage'] = undefined;
                if (!isGradient) patch['style.fill'] = 'linear-gradient(90deg, #2563eb 0%, #7c3aed 100%)';
              } else {
                patch['style.fillImage'] = { size: 'cover', position: 'center', repeat: false };
                if (isGradient) patch['style.fill'] = undefined;   // an image cannot sit on a gradient
              }
              docops.update(app, ids, patch, { label: 'Set fill', coalesce: burstKey('fill-mode', ids) });
              bursts.set('fill-mode', (bursts.get('fill-mode') || 0) + 1);
              renderFillBody(v);
              scheduleSync();
            }
          });
          bodyEl.appendChild(widgets.fieldRow({ label: 'Type', control: modeCtl }));
          bodyEl.appendChild(modeHost);

          let mode = null;
          function renderFillBody(next) {
            if (next === mode) return;
            mode = next;
            fields = fields.filter((f) => !modeHost.contains(f.row));
            modeHost.replaceChildren();
            if (mode === 'solid') {
              addField(modeHost, {
                id: 'fill', key: 'style.fill', label: 'Colour', control: colorCtl({ ariaLabel: 'Fill colour' }), applies: fillable
              });
            } else if (mode === 'gradient') {
              addField(modeHost, {
                id: 'fill-gradient', key: 'style.fill', label: 'Gradient', layout: 'stacked',
                control: (write) => widgets.gradientField({ app, onInput: (v, ctx) => write(v, ctx) }),
                applies: fillable
              });
            } else if (mode === 'image') {
              addField(modeHost, {
                id: 'fillImage-asset', key: 'style.fillImage.asset', label: 'Image', bpTop: 'style', bpSub: 'fillImage', fallback: '',
                control: (write) => assetField({ onInput: (v, ctx) => write(v, ctx) }),
                applies: fillable
              });
              addField(modeHost, {
                id: 'fillImage-src', key: 'style.fillImage.src', label: 'Image URL', bpTop: 'style', bpSub: 'fillImage', fallback: '',
                control: (write) => widgets.textField({
                  ariaLabel: 'Background image URL', placeholder: 'https://', clearable: true,
                  validate: (v) => (!v || sanitize.url(v, 'image') ? null : 'That URL is not allowed.'),
                  onInput: (v, ctx) => { if (v && !sanitize.url(v, 'image')) return; write(v, ctx); }
                }),
                applies: fillable
              });
              addField(modeHost, {
                id: 'fillImage-size', key: 'style.fillImage.size', label: 'Size', bpTop: 'style', bpSub: 'fillImage', fallback: 'cover',
                control: selectCtl([{ value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }, { value: 'auto', label: 'Original' }],
                  { ariaLabel: 'Background size', emptyClears: false }),
                applies: fillable
              });
              addField(modeHost, {
                id: 'fillImage-position', key: 'style.fillImage.position', label: 'Position', bpTop: 'style', bpSub: 'fillImage', fallback: 'center',
                control: selectCtl(['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right']
                  .map((v) => ({ value: v, label: v.replace(/^./, (c) => c.toUpperCase()) })), { ariaLabel: 'Background position', emptyClears: false }),
                applies: fillable
              });
              addField(modeHost, {
                id: 'fillImage-repeat', key: 'style.fillImage.repeat', label: 'Repeat', bpTop: 'style', bpSub: 'fillImage', fallback: false,
                control: (write) => widgets.toggle({ ariaLabel: 'Repeat the background image', labelVisible: false, onInput: (v, ctx) => write(!!v, ctx) }),
                applies: fillable
              });
            }
            fields.filter((f) => modeHost.contains(f.row)).forEach(syncField);
          }

          const initial = currentFillMode(selNodes.find(fillable) || selNodes[0]);
          modeCtl.apbControl.value = initial;
          renderFillBody(initial);
          s.apbFill = {
            sync() {
              const node = selNodes.find(fillable);
              if (!node) return;
              const next = currentFillMode(node);
              if (!modeCtl.contains(document.activeElement)) modeCtl.apbControl.value = next;
              renderFillBody(next);
            }
          };
          parent.appendChild(s);
          return s;
        }

        /* --------------------------------------------------------- border */

        function buildBorder(parent) {
          const bordered = (n) => capsOf(n).border && !omits(n, 'borderWidth');
          const rounded = (n) => capsOf(n).radius && !omits(n, 'radius');
          if (!selNodes.some((n) => bordered(n) || rounded(n))) return;
          const s = sec('border', 'Border');
          const bodyEl = s.apbSection.body;

          const grid = h('div', { class: 'apb-field-grid' });
          bodyEl.appendChild(grid);
          addField(grid, {
            id: 'borderWidth', key: 'style.borderWidth', label: 'Width',
            control: numberCtl({ ariaLabel: 'Border width', min: 0, max: 200, step: 1 }), applies: bordered
          });
          addField(grid, {
            id: 'borderStyle', key: 'style.borderStyle', label: 'Style', fallback: 'solid',
            control: selectCtl(['solid', 'dashed', 'dotted', 'double', 'none'].map((v) => ({ value: v, label: v.replace(/^./, (c) => c.toUpperCase()) })),
              { ariaLabel: 'Border style', emptyClears: false }),
            applies: bordered
          });
          addField(bodyEl, {
            id: 'borderColor', key: 'style.borderColor', label: 'Colour',
            control: colorCtl({ ariaLabel: 'Border colour' }), applies: bordered
          });
          addField(bodyEl, {
            id: 'radius', key: 'style.radius', label: 'Radius', layout: 'stacked',
            control: (write) => sidesControl({
              label: 'Corner radius', min: 0, allowScalar: true,
              labels: ['Top left', 'Top right', 'Bottom right', 'Bottom left'],
              onInput: (v, ctx) => write(v, ctx)
            }),
            read: (eff) => {
              const r = (eff.style || {}).radius;
              return Array.isArray(r) ? r.map((n) => Number(n) || 0) : (Number(r) || 0);
            },
            applies: rounded
          });
          parent.appendChild(s);
        }

        /* -------------------------------------------------------- effects */

        function buildEffects(parent) {
          const fx = (n) => capsOf(n).effects;
          if (!selNodes.some(fx)) return;
          const s = sec('effects', 'Effects');
          const bodyEl = s.apbSection.body;

          addField(bodyEl, {
            id: 'opacity', key: 'style.opacity', label: 'Opacity', fallback: 1,
            control: (write) => widgets.slider({
              min: 0, max: 1, step: 0.01, ariaLabel: 'Opacity', showValue: true,
              valueText: (v) => Math.round(v * 100) + '%',
              onInput: (v, ctx) => write(v, ctx)
            }),
            applies: fx
          });

          const shadowPreset = (value) => {
            const found = SHADOW_PRESETS.find((p) => p.value === (value || ''));
            return found ? found.value : '__custom__';
          };
          addField(bodyEl, {
            id: 'shadow-preset', key: 'style.shadow', label: 'Shadow', fallback: '',
            control: (write) => widgets.select({
              ariaLabel: 'Shadow preset',
              options: SHADOW_PRESETS.concat([{ value: '__custom__', label: 'Custom…' }]),
              onInput: (v, ctx) => { if (v !== '__custom__') write(v || undefined, ctx); }
            }),
            out: (v) => shadowPreset(v),
            applies: (n) => fx(n) && capsOf(n).shadow !== false && !omits(n, 'shadow')
          });
          addField(bodyEl, {
            id: 'shadow', key: 'style.shadow', label: 'Shadow value', fallback: '',
            control: textCtl({ ariaLabel: 'Custom shadow', placeholder: '0 4px 12px rgba(0,0,0,.12)' }),
            applies: (n) => fx(n) && capsOf(n).shadow !== false && !omits(n, 'shadow')
          });
          addField(bodyEl, {
            id: 'textShadow', key: 'style.textShadow', label: 'Text shadow', fallback: '',
            control: textCtl({ ariaLabel: 'Text shadow', placeholder: '0 1px 2px rgba(0,0,0,.3)' }),
            applies: (n) => fx(n) && capsOf(n).text
          });

          const grid = h('div', { class: 'apb-field-grid' });
          bodyEl.appendChild(grid);
          addField(grid, { id: 'blur', key: 'style.blur', label: 'Blur', control: numberCtl({ ariaLabel: 'Blur', min: 0, max: 200, step: 1 }), applies: fx });
          addField(grid, { id: 'backdropBlur', key: 'style.backdropBlur', label: 'Backdrop', control: numberCtl({ ariaLabel: 'Backdrop blur', min: 0, max: 200, step: 1 }), applies: fx });

          addField(bodyEl, {
            id: 'blend', key: 'style.blend', label: 'Blend mode', fallback: 'normal',
            control: selectCtl(BLEND_MODES.map((v) => ({ value: v, label: v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) })),
              { ariaLabel: 'Blend mode', emptyClears: false }),
            applies: fx
          });
          parent.appendChild(s);
        }

        /* ----------------------------------------------------- attributes */

        function buildAttributes(parent) {
          const s = sec('attributes', 'Attributes', { collapsed: true });
          const bodyEl = s.apbSection.body;
          const single = selNodes.length === 1;

          addField(bodyEl, {
            id: 'attr-id', key: 'attrs.htmlId', label: 'HTML id', base: true, fallback: '',
            hint: 'Used as the anchor target — letters, digits, "-" and "_".',
            control: (write) => widgets.textField({
              ariaLabel: 'HTML id', placeholder: 'section-hero',
              onInput: (v, ctx) => write(ctx && ctx.commit ? sanitize.id(v) : v, ctx)
            }),
            applies: () => single
          });
          addField(bodyEl, {
            id: 'attr-class', key: 'attrs.className', label: 'CSS classes', base: true, fallback: '',
            control: (write) => widgets.textField({
              ariaLabel: 'CSS classes', placeholder: 'card featured',
              onInput: (v, ctx) => write(ctx && ctx.commit ? sanitize.className(v) : v, ctx)
            })
          });
          addField(bodyEl, {
            id: 'attr-aria', key: 'attrs.ariaLabel', label: 'ARIA label', base: true, fallback: '',
            control: textCtl({ ariaLabel: 'ARIA label' })
          });
          addField(bodyEl, {
            id: 'attr-role', key: 'attrs.role', label: 'ARIA role', base: true, fallback: '',
            control: selectCtl(ROLES.map((v) => ({ value: v, label: v || 'Default' })), { ariaLabel: 'ARIA role' })
          });
          addField(bodyEl, {
            id: 'attr-title', key: 'attrs.title', label: 'Title', base: true, fallback: '',
            control: textCtl({ ariaLabel: 'Title attribute' })
          });
          parent.appendChild(s);
        }

        function buildCustomCSS(parent) {
          const s = sec('css', 'Custom CSS', { collapsed: true });
          addField(s.apbSection.body, {
            id: 'css', key: 'css', label: 'Declarations', base: true, layout: 'stacked', fallback: '',
            hint: 'Declarations only (no selectors or braces). Sanitized when you leave the field.',
            control: (write) => widgets.textArea({
              ariaLabel: 'Custom CSS declarations', rows: 4, monospace: true, placeholder: 'box-shadow: 0 0 0 2px #000;',
              onInput: (v, ctx) => {
                if (!ctx || !ctx.commit) { write(v, ctx); return; }
                const clean = sanitize.css(v);
                write(clean, ctx);
                if (clean !== v && ui.toast) ui.toast('Some declarations were removed', { kind: 'warning' });
              }
            })
          });
          parent.appendChild(s);
        }

        /* ---------------------------------------------- instance overrides */

        function buildInstanceOverrides(parent) {
          if (selNodes.length !== 1 || selNodes[0].type !== 'instance') return;
          const node = selNodes[0];
          const comp = (doc().components || {})[(node.props || {}).component];
          if (!comp || !doc().nodes[comp.root]) return;
          const ids = [comp.root].concat(schema.descendants(doc(), comp.root));
          const editable = [];
          for (const mid of ids) {
            const master = doc().nodes[mid];
            if (!master) continue;
            const def = elements.get(master.type);
            const keys = [];
            if (def && def.textEdit) keys.push(def.textEdit);
            if (master.type === 'image') keys.push('alt', 'src');
            if (master.type === 'button' || master.type === 'text') keys.push('href');
            util.uniq(keys).forEach((k) => editable.push({ master, key: k }));
          }
          if (!editable.length) return;

          const s = sec('overrides', 'Component overrides');
          const bodyEl = s.apbSection.body;

          editable.forEach(({ master, key }) => {
            const id = 'override:' + master.id + ':' + key;
            const label = (master.name || master.type) + ' · ' + key;
            const liveOverride = () => {
              const live = doc().nodes[node.id];
              return ((live && live.props ? live.props.overrides : null) || {})[master.id] || null;
            };
            const f = addField(bodyEl, {
              id, label, fallback: '',
              control: (write) => widgets.textField({ ariaLabel: label, onInput: (v, ctx) => write(v, ctx) }),
              read: () => {
                const ov = liveOverride();
                const own = ov && util.isPlainObject(ov.props) ? ov.props[key] : undefined;
                return own === undefined ? (master.props || {})[key] : own;
              },
              overridden: () => {
                const ov = liveOverride();
                return !!(ov && util.isPlainObject(ov.props) && ov.props[key] !== undefined);
              },
              onReset: () => resetInstanceOverride(node, master.id, key),
              write: (value, nodeIds, opts) => {
                const live = doc().nodes[node.id];
                const overrides = util.deepClone((live.props || {}).overrides || {});
                const entry = util.isPlainObject(overrides[master.id]) ? overrides[master.id] : {};
                entry.props = Object.assign({}, entry.props, { [key]: value });
                overrides[master.id] = entry;
                docops.update(app, nodeIds, { 'props.overrides': overrides }, opts);
              }
            });
            f.row.classList.add('apb-override-row');
          });

          parent.appendChild(s);
        }

        function resetInstanceOverride(node, masterId, key) {
          const live = doc().nodes[node.id];
          if (!live) return;
          const overrides = util.deepClone((live.props || {}).overrides || {});
          const entry = overrides[masterId];
          if (!entry || !util.isPlainObject(entry.props) || entry.props[key] === undefined) return;
          delete entry.props[key];
          if (!Object.keys(entry.props).length) delete entry.props;
          if (!Object.keys(entry).length) delete overrides[masterId];
          docops.update(app, [live.id], { 'props.overrides': overrides }, { label: 'Reset override' });
        }

        /* ------------------------------------------------- foreign sections */

        function buildExternal(parent) {
          const list = typeof ui.inspectorSections === 'function' ? ui.inspectorSections() : [];
          for (const def of list) {
            try {
              if (typeof def.applies === 'function' && !def.applies(selNodes, app)) continue;
              const s = sec('ext-' + def.id, def.title || def.id);
              const inst = def.mount(s.apbSection.body, app) || null;
              extInstances.push(inst);
              parent.appendChild(s);
            } catch (err) {
              app.log('inspector section "' + def.id + '" failed: ' + (err && err.message), { level: 'error' });
            }
          }
        }

        /* ==================================================== head + rebuild */

        function buildHead() {
          head.replaceChildren();
          head.apbResetAll = null;
          head.apbName = null;
          if (!selNodes.length) { head.hidden = true; return; }
          head.hidden = false;
          const multi = selNodes.length > 1;
          const first = selNodes[0];
          const def = defOf(first);
          const iconName = ICON_ALIAS[(def && def.icon) || first.type] || (def && def.icon) || first.type;

          const typeIcon = h('span', { class: 'apb-inspector-type', title: multi ? 'Multiple layers' : (def ? def.label : first.type) },
            icons.get(icons.has(iconName) ? iconName : 'rect', { size: 16 }));

          const nameCtl = widgets.textField({
            value: multi ? '' : (first.name || ''),
            ariaLabel: 'Layer name', className: 'apb-inspector-name',
            placeholder: multi ? util.plural(selNodes.length, 'layer') + ' selected' : 'Layer name',
            onInput: (v, ctx) => {
              if (!ctx || !ctx.commit || multi) return;
              const live = doc().nodes[first.id];
              const clean = String(v || '').slice(0, MAX_NAME).trim();
              if (!live || !clean || clean === live.name) return;
              docops.update(app, [first.id], { name: clean }, { bp: null, label: 'Rename layer' });
            }
          });
          if (multi) nameCtl.apbControl.setDisabled(true);
          else head.apbName = { id: first.id, ctl: nameCtl };

          const bpBadge = widgets.badge(bpLabel(), {
            kind: isBase() ? 'neutral' : 'accent',
            title: isBase() ? 'Editing the base breakpoint' : 'Edits are saved as ' + bpLabel() + ' overrides'
          });
          bpBadge.classList.add('apb-inspector-bp');

          const allLocked = selNodes.every((n) => n.locked);
          const lockBtn = widgets.iconButton({
            icon: allLocked ? 'lock' : 'unlock', label: allLocked ? 'Unlock' : 'Lock', pressed: allLocked, size: 'sm',
            onClick: () => docops.setLocked(app, selNodes.map((n) => n.id), !allLocked)
          });
          const allHidden = selNodes.every((n) => effOf(n).hidden);
          const hideBtn = widgets.iconButton({
            icon: allHidden ? 'eye-off' : 'eye', label: allHidden ? 'Show' : 'Hide', pressed: allHidden, size: 'sm',
            onClick: () => docops.setHidden(app, selNodes.map((n) => n.id), !allHidden)
          });

          const tools = h('div', { class: 'apb-inspector-tools' }, bpBadge, lockBtn, hideBtn);
          if (!isBase()) {
            const resetBtn = widgets.iconButton({
              icon: 'refresh', label: 'Reset all ' + bpLabel() + ' overrides', size: 'sm',
              className: 'apb-inspector-resetall', onClick: () => resetAllOverrides()
            });
            resetBtn.hidden = overrideCount() === 0;
            head.apbResetAll = resetBtn;
            tools.appendChild(resetBtn);
          }
          head.append(h('div', { class: 'apb-inspector-title' }, typeIcon, nameCtl), tools);
        }

        function destroyExternal() {
          extInstances.splice(0).forEach((inst) => {
            if (inst && typeof inst.destroy === 'function') { try { inst.destroy(); } catch (_) { /* ignore */ } }
          });
        }

        function rebuild() {
          const focusId = activeFieldId();
          fields = [];
          destroyExternal();
          if (docStyles) { docStyles.destroy(); docStyles = null; }
          body.replaceChildren();
          buildHead();

          if (!selNodes.length) {
            body.appendChild(widgets.emptyState({
              icon: 'design', title: 'Nothing selected',
              message: 'Select a layer on the canvas or in the Layers panel to edit it. Document styles are below.'
            }));
            const host = h('div', { class: 'apb-inspector-docstyles' });
            body.appendChild(host);
            if (tokensMod) docStyles = tokensMod.mount(host, app, { targets: () => lastSelection.filter((id) => doc().nodes[id]) });
            return;
          }

          const fillSection = (function () {
            buildPosition(body);
            buildLayout(body);
            contentFields(body);
            buildTypography(body);
            const fs = buildFill(body);
            buildBorder(body);
            buildEffects(body);
            buildInstanceOverrides(body);
            buildAttributes(body);
            buildCustomCSS(body);
            buildExternal(body);
            return fs;
          }());
          body.apbFillSection = fillSection || null;
          fields.forEach(syncField);
          if (focusId) restoreFocus(focusId);
        }

        function activeFieldId() {
          const el = document.activeElement;
          if (!el || !body.contains(el)) return null;
          const f = fields.find((x) => x.ctl.contains(el));
          return f ? f.def.id : null;
        }

        function restoreFocus(id) {
          const f = fields.find((x) => x.def.id === id);
          if (f && f.api && typeof f.api.focus === 'function' && !f.row.hidden) {
            try { f.api.focus(); } catch (_) { /* ignore */ }
          }
        }

        function syncAll() {
          if (!selNodes.length) return;
          if (body.apbFillSection && body.apbFillSection.apbFill) body.apbFillSection.apbFill.sync();
          fields.forEach(syncField);
          if (head.apbResetAll) head.apbResetAll.hidden = overrideCount() === 0;
          if (head.apbName && !head.apbName.ctl.contains(document.activeElement)) {
            const live = doc().nodes[head.apbName.id];
            if (live && head.apbName.ctl.apbControl.value !== (live.name || '')) head.apbName.ctl.apbControl.value = live.name || '';
          }
          extInstances.forEach((inst) => {
            if (inst && typeof inst.update === 'function') { try { inst.update(selNodes); } catch (_) { /* ignore */ } }
          });
        }

        function signature() {
          return JSON.stringify([bpId(), store.view.component || '', selNodes.map((n) => {
            const eff = effOf(n);
            const def = defOf(n);
            const when = def && Array.isArray(def.inspector)
              ? def.inspector.map((g) => (g.fields || []).map((sp) => (typeof sp.when === 'function' ? (function () {
                try { return sp.when(eff, n) ? 1 : 0; } catch (_) { return 0; }
              }()) : 1)).join('')).join('|')
              : '';
            return [n.id, n.type, Array.isArray(n.children), !!n.locked, (eff.layout || {}).mode || '',
              (eff.layout || {}).dir || '', inStack(n), (n.props || {}).component || '', when].join('~');
          })]);
        }

        function refresh(force) {
          if (destroyed) return;
          selNodes = selectionNodes();
          if (selNodes.length) lastSelection = selNodes.map((n) => n.id);
          const next = signature();
          if (force || next !== sig) {
            sig = next;
            rebuild();
          } else {
            syncAll();
          }
        }

        function scheduleSync() {
          if (destroyed || raf) return;
          raf = requestAnimationFrame(() => { raf = 0; refresh(false); });
        }

        /* ------------------------------------------------------------ wiring */

        offs.push(store.on('change', scheduleSync));
        offs.push(store.on('selection', scheduleSync));
        offs.push(store.on('view', (p) => {
          const changed = p.changed || [];
          if (changed.includes('bp') || changed.includes('component') || changed.includes('pageId')) refresh(true);
        }));
        const offSections = app.on('ui:inspector-sections', () => refresh(true));
        if (typeof offSections === 'function') offs.push(offSections);

        root.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return;
          const el = document.activeElement;
          if (el && el.closest && el.closest('.apb-popover, .apb-dialog, [role="menu"]')) return;
          e.preventDefault();
          if (app.canvas && app.canvas.el && typeof app.canvas.el.focus === 'function') app.canvas.el.focus();
        });

        root.apbInspector = {
          refresh: () => refresh(true),
          fieldIds: () => fields.map((f) => f.def.id),
          field: (id) => {
            const f = fields.find((x) => x.def.id === id);
            return f ? { el: f.ctl, row: f.row, api: f.api, nodes: f.nodes.map((n) => n.id) } : null;
          },
          get docStyles() { return docStyles ? docStyles.el : null; },
          get selection() { return selNodes.map((n) => n.id); }
        };

        refresh(true);

        return {
          update() { refresh(true); },
          destroy() {
            destroyed = true;
            if (raf) cancelAnimationFrame(raf);
            offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
            destroyExternal();
            if (docStyles) { docStyles.destroy(); docStyles = null; }
            fields = [];
            root.remove();
          }
        };
      }
    }
  });
})();

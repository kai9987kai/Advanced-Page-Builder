/*
 * actions (UI) — the inspector "Actions" section for `button` and `checklist` nodes: add / edit /
 * remove entries from `node.actions` (shape and runtime owned by `core/actions.js`). Buttons fire on
 * click, checklist items fire on change (the checkbox that changed bubbles a native `change` event
 * up to the checklist's root element, which is what the exported runtime listens on).
 *
 * Single-selection only (one node, type `button` or `checklist`) — editing a heterogeneous list
 * field across a multi-selection would need a "mixed" model this doesn't attempt.
 */
(function () {
  'use strict';

  const APPLIES_TYPES = ['button', 'checklist'];

  APB.plugin({
    id: 'actionsUI',
    order: 42,
    requires: ['actions', 'widgets', 'icons'],

    init(app) {
      const actionsMod = APB.require('actions');
      const widgets = APB.require('widgets');
      const { h } = widgets;
      const store = app.store;
      const docops = app.docops;
      const schema = app.schema;

      if (!app.ui || typeof app.ui.registerInspectorSection !== 'function') return;

      function currentPage() {
        const doc = store.doc;
        const pages = Array.isArray(doc.pages) ? doc.pages : [];
        return pages.find((p) => p.id === store.view.pageId) || pages[0] || null;
      }

      function targetOptions(ownId) {
        const doc = store.doc;
        const page = currentPage();
        const opts = [{ value: '', label: 'Choose an element…' }];
        if (!page || !doc.nodes[page.root]) return opts;
        const ids = [page.root].concat(schema.descendants(doc, page.root));
        for (const id of ids) {
          if (id === ownId) continue;
          const n = doc.nodes[id];
          if (n) opts.push({ value: id, label: (n.name || n.type) + '  ·  ' + n.type });
        }
        return opts;
      }

      function mount(container) {
        let node = null;
        let renderedSig = null;
        const bursts = new Map();
        const list = h('div', { class: 'apb-actions-list' });
        const addBtn = widgets.button({ label: 'Add action', icon: 'plus', size: 'sm', variant: 'subtle', onClick: openAddMenu });
        const el = h('div', { class: 'apb-actions-section' }, list, addBtn);
        container.appendChild(el);

        function burstKey(fieldKey) {
          return 'actions:' + node.id + ':' + fieldKey + '#' + (bursts.get(fieldKey) || 0);
        }

        function write(nextActions, fieldKey, commit) {
          renderedSig = JSON.stringify(nextActions);
          const opts = { bp: null, label: 'Edit actions', coalesce: burstKey(fieldKey || 'row') };
          docops.update(app, [node.id], { actions: nextActions }, opts);
          if (commit !== false) bursts.set(fieldKey || 'row', (bursts.get(fieldKey || 'row') || 0) + 1);
        }

        function openAddMenu(e) {
          if (!node || !app.ui.menu) return;
          const items = actionsMod.TYPES.map((t) => ({
            label: t.label, icon: t.icon,
            run: () => {
              const next = (node.actions || []).concat([actionsMod.create(t.id, node.type)]);
              node = Object.assign({}, node, { actions: next });
              renderList(next);
              write(next, 'add', true);
            }
          }));
          app.ui.menu(e, items, { label: 'Add action' });
        }

        function fieldControl(action, index, field) {
          const onChange = (value, ctx) => {
            const next = (node.actions || []).slice();
            next[index] = Object.assign({}, next[index], { [field.key]: value });
            node = Object.assign({}, node, { actions: next });
            write(next, action.id + ':' + field.key, !ctx || ctx.commit !== false);
          };
          if (field.kind === 'toggle') {
            return h('div', { class: 'apb-actions-field apb-actions-field--toggle' },
              widgets.toggle({ label: field.label, checked: !!action[field.key], onInput: (v) => onChange(v, { commit: true }) }));
          }
          if (field.kind === 'target') {
            return h('div', { class: 'apb-actions-field' },
              h('label', { class: 'apb-actions-field-label' }, field.label),
              widgets.select({ ariaLabel: field.label, value: action[field.key] || '', options: targetOptions(node.id), onInput: (v) => onChange(v, { commit: true }) }));
          }
          if (field.kind === 'code') {
            return h('div', { class: 'apb-actions-field apb-actions-field--code' },
              h('label', { class: 'apb-actions-field-label' }, field.label),
              widgets.textArea({ ariaLabel: field.label, value: action[field.key] || '', rows: 6, monospace: true, placeholder: field.placeholder, onInput: onChange }));
          }
          return h('div', { class: 'apb-actions-field' },
            h('label', { class: 'apb-actions-field-label' }, field.label),
            widgets.textField({ ariaLabel: field.label, value: action[field.key] || '', placeholder: field.placeholder, type: field.kind === 'url' ? 'url' : 'text', onInput: onChange }));
        }

        function renderList(arr) {
          const items = Array.isArray(arr) ? arr : [];
          list.replaceChildren();
          if (!items.length) {
            list.appendChild(widgets.emptyState({
              icon: 'code', title: 'No actions yet',
              message: node && node.type === 'checklist'
                ? 'Add an action to run when an item is checked or unchecked.'
                : 'Add an action to run when this button is clicked.'
            }));
            return;
          }
          items.forEach((action, i) => {
            const def = actionsMod.TYPES.find((t) => t.id === action.type) || actionsMod.TYPES[0];
            const typeSelect = widgets.select({
              ariaLabel: 'Action type', value: action.type,
              options: actionsMod.TYPES.map((t) => ({ value: t.id, label: t.label })),
              onInput: (v) => {
                const next = (node.actions || []).slice();
                next[i] = Object.assign(actionsMod.create(v, node.type), { id: action.id });
                node = Object.assign({}, node, { actions: next });
                renderList(next);
                write(next, 'type', true);
              }
            });
            const removeBtn = widgets.iconButton({
              icon: 'trash', label: 'Remove action', size: 'sm',
              onClick: () => {
                const next = (node.actions || []).filter((a) => a.id !== action.id);
                node = Object.assign({}, node, { actions: next });
                renderList(next);
                write(next, 'remove', true);
              }
            });
            const card = h('div', { class: 'apb-actions-card' },
              h('div', { class: 'apb-actions-card-head' }, typeSelect, removeBtn),
              def.fields.map((f) => fieldControl(action, i, f)));
            list.appendChild(card);
          });
        }

        function update(nodes) {
          const n = nodes && nodes.length === 1 ? nodes[0] : null;
          if (!n) { node = null; return; }
          node = n;
          const sig = JSON.stringify(n.actions || []);
          if (sig === renderedSig) return;
          renderedSig = sig;
          renderList(n.actions || []);
        }

        // `buildExternal` mounts but does not immediately call update() — the section would stay
        // empty until some unrelated store event happens to schedule the next inspector refresh.
        // Seed it from the current selection right away.
        update(store.selection.map((id) => store.doc.nodes[id]).filter(Boolean));

        return { el, update, destroy() {} };
      }

      app.ui.registerInspectorSection({
        id: 'actions',
        title: 'Actions',
        order: 55,
        applies: (nodes) => nodes.length === 1 && APPLIES_TYPES.includes(nodes[0].type),
        mount
      });
    }
  });
})();

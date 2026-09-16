/*
 * components — `component.create`/`component.detach` commands (referenced by `shell.js`'s
 * `CONTEXT_GROUPS` since B2 but never registered until now — right-clicking a selection has always
 * had a slot for "Create component" in its menu, just nothing behind it) plus a left "Components"
 * panel to browse and insert them. `docops.js` already has the node-tree operations
 * (`createComponent instantiate detach`); this only adds UI and the one operation docops doesn't
 * own — deleting a component *definition* (`doc.components[id]` + its master subtree), which is a
 * doc-level resource like `assets`/`tokens`, not a node-tree edit, so it's handled directly here
 * with `store.transact` rather than added to docops (same reasoning as `features/assets.js`).
 */
(function () {
  'use strict';

  APB.plugin({
    id: 'components',
    order: 34,
    requires: ['widgets', 'icons'],

    init(app) {
      const widgets = APB.require('widgets');
      const icons = APB.require('icons');
      const { h } = widgets;
      const store = app.store;
      const docops = app.docops;

      function removeComponent(id) {
        const comp = (store.doc.components || {})[id];
        if (!comp) return false;
        store.transact('Delete component', (tx) => {
          if (tx.doc.nodes[comp.root]) tx.removeNode(comp.root);
          const next = Object.assign({}, tx.doc.components);
          delete next[id];
          tx.setDocField('components', next);
        });
        return true;
      }

      function mount(container) {
        const list = h('div', { class: 'apb-components-list' });
        const el = h('div', { class: 'apb-panel-fill' },
          h('div', { class: 'apb-panel-bar' }, h('strong', {}, 'Components')),
          h('div', { class: 'apb-panel-scroll' }, list));
        container.appendChild(el);

        function render() {
          const comps = Object.keys(store.doc.components || {}).map((id) => store.doc.components[id]);
          list.replaceChildren();
          if (!comps.length) {
            list.appendChild(widgets.emptyState({
              icon: 'component', title: 'No components yet',
              message: 'Select one or more layers, then "Create component" (right-click menu or the command palette) to make one reusable.'
            }));
            return;
          }
          for (const c of comps) {
            const row = h('button', { type: 'button', class: 'apb-component-row', title: 'Insert an instance of ' + (c.name || 'this component') },
              icons.get('component', { size: 16 }), h('span', { class: 'apb-component-row-name' }, c.name || 'Component'));
            const del = widgets.iconButton({
              icon: 'trash', label: 'Delete ' + (c.name || 'this component'), size: 'sm',
              onClick: (e) => { e.stopPropagation(); if (removeComponent(c.id)) render(); }
            });
            row.appendChild(del);
            row.addEventListener('click', () => {
              const id = docops.instantiate(app, c.id, {});
              if (id && app.ui.announce) app.ui.announce((c.name || 'Component') + ' inserted');
            });
            list.appendChild(row);
          }
        }
        render();
        const off = store.on('change', (payload) => { if (payload && payload.global) render(); });
        return { destroy: () => { if (off) off(); } };
      }

      if (app.commands && !app.commands.get('component.create')) {
        app.commands.register({
          id: 'component.create', title: 'Create component', category: 'Component', icon: 'component',
          when: (a) => a.store.selection.length > 0 && a.store.selection.every((id) => { const n = a.store.doc.nodes[id]; return n && n.type !== 'page'; }),
          run: (a) => {
            const id = docops.createComponent(a, a.store.selection, {});
            if (id && a.ui.announce) a.ui.announce('Component created');
          }
        });
      }
      if (app.commands && !app.commands.get('component.detach')) {
        app.commands.register({
          id: 'component.detach', title: 'Detach instance', category: 'Component', icon: 'component',
          when: (a) => {
            const n = a.store.selection.length === 1 ? a.store.doc.nodes[a.store.selection[0]] : null;
            return !!n && n.type === 'instance';
          },
          run: (a) => docops.detach(a, a.store.selection[0])
        });
      }
      if (typeof app.ui.registerPanel === 'function') {
        app.ui.registerPanel({ id: 'components', side: 'left', title: 'Components', icon: 'component', order: 30, mount });
      }
    }
  });
})();

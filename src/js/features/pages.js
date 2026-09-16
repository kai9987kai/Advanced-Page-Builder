/*
 * pages — multi-page management. `docops.js` already has the node-tree operations
 * (`createPage duplicatePage removePage reorderPages renamePage setPageSlug setPageSeo`); this
 * plugin is just the UI over them plus the `pages.add`/`pages.manage` commands that
 * `features/layers.js`'s page-switcher head calls (it checks `app.commands.get(...)` before
 * showing those buttons, so this can load in either order). No panel of its own — the page
 * *switcher* already lives in the Layers panel head; this only adds the "+"/manage affordances
 * and the full editor dialog (rename, duplicate, reorder, delete, per-page SEO).
 */
(function () {
  'use strict';

  APB.plugin({
    id: 'pages',
    order: 33,
    requires: ['widgets', 'icons'],

    init(app) {
      const widgets = APB.require('widgets');
      const { h } = widgets;
      const store = app.store;
      const docops = app.docops;

      function labeled(label, ctl) {
        return h('div', { class: 'apb-actions-field' }, h('label', { class: 'apb-actions-field-label' }, label), ctl);
      }

      function addPage() {
        const id = docops.createPage(store, {});
        store.setView({ pageId: id, context: null });
        if (app.ui.announce) app.ui.announce('Page added');
        return id;
      }

      function openSeoEditor(pageId) {
        const page = (store.doc.pages || []).find((p) => p.id === pageId);
        if (!page || !app.ui || typeof app.ui.dialog !== 'function') return;
        const seo = page.seo || {};
        const titleField = widgets.textField({ value: seo.title, placeholder: page.name, onInput: (v, ctx) => { if (ctx && ctx.commit) docops.setPageSeo(store, pageId, { title: v }); } });
        const descField = widgets.textArea({ value: seo.description, rows: 3, placeholder: 'Shown in search results and link previews', onInput: (v, ctx) => { if (ctx && ctx.commit) docops.setPageSeo(store, pageId, { description: v }); } });
        const canonicalField = widgets.textField({ value: seo.canonical, type: 'url', placeholder: 'https://…', onInput: (v, ctx) => { if (ctx && ctx.commit) docops.setPageSeo(store, pageId, { canonical: v }); } });
        const ogField = widgets.textField({ value: seo.ogImage, type: 'url', placeholder: 'https://…/share-image.png', onInput: (v, ctx) => { if (ctx && ctx.commit) docops.setPageSeo(store, pageId, { ogImage: v }); } });
        const slugField = widgets.textField({ value: page.slug, onInput: (v, ctx) => { if (ctx && ctx.commit) docops.setPageSlug(store, pageId, v); } });
        const noindexToggle = widgets.toggle({ label: 'Hide from search engines (noindex)', checked: !!seo.noindex, onInput: (v) => docops.setPageSeo(store, pageId, { noindex: v }) });
        const content = h('div', { class: 'apb-page-seo-form' },
          labeled('URL slug (used by "Export → Site")', slugField),
          labeled('SEO title', titleField),
          labeled('Meta description', descField),
          labeled('Canonical URL', canonicalField),
          labeled('Social share image URL', ogField),
          h('div', { class: 'apb-actions-field apb-actions-field--toggle' }, noindexToggle));
        app.ui.dialog({ title: 'Page settings — ' + (page.name || 'Page'), wide: true, content, actions: [{ label: 'Done', kind: 'cancel' }] });
      }

      function openManager() {
        if (!app.ui || typeof app.ui.dialog !== 'function') return;
        const list = h('div', { class: 'apb-pages-list' });

        function move(id, delta) {
          const pages = store.doc.pages || [];
          const i = pages.findIndex((p) => p.id === id);
          const j = i + delta;
          if (i === -1 || j < 0 || j >= pages.length) return;
          const order = pages.map((p) => p.id);
          const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
          docops.reorderPages(store, order);
          render();
        }

        function render() {
          const pages = store.doc.pages || [];
          list.replaceChildren();
          pages.forEach((p, i) => {
            const nameField = widgets.textField({
              value: p.name, ariaLabel: 'Page name',
              onInput: (v, ctx) => { if (ctx && ctx.commit) { docops.renamePage(store, p.id, v); render(); } }
            });
            const row = h('div', { class: ['apb-page-row', p.id === store.view.pageId && 'is-active'] },
              h('div', { class: 'apb-page-row-name' }, nameField),
              widgets.iconButton({
                icon: 'arrow-right', label: 'Switch to ' + (p.name || 'this page'), size: 'sm',
                onClick: () => { store.setView({ pageId: p.id, context: null }); render(); }
              }),
              widgets.iconButton({ icon: 'copy', label: 'Duplicate ' + (p.name || 'this page'), size: 'sm', onClick: () => { docops.duplicatePage(store, p.id); render(); } }),
              widgets.iconButton({ icon: 'chevron-up', label: 'Move up', size: 'sm', disabled: i === 0, onClick: () => move(p.id, -1) }),
              widgets.iconButton({ icon: 'chevron-down', label: 'Move down', size: 'sm', disabled: i === pages.length - 1, onClick: () => move(p.id, 1) }),
              widgets.iconButton({ icon: 'settings', label: 'Page settings', size: 'sm', onClick: () => openSeoEditor(p.id) }),
              widgets.iconButton({
                icon: 'trash', label: 'Delete ' + (p.name || 'this page'), size: 'sm', disabled: pages.length <= 1,
                onClick: () => { if (docops.removePage(store, p.id)) render(); }
              }));
            list.appendChild(row);
          });
        }
        render();
        app.ui.dialog({
          title: 'Pages', wide: true, content: list,
          actions: [{ label: 'Add page', icon: 'plus', run: () => { addPage(); render(); } }, { label: 'Done', kind: 'cancel' }]
        });
      }

      if (app.commands && !app.commands.get('pages.add')) {
        app.commands.register({ id: 'pages.add', title: 'Add page', category: 'Insert', icon: 'plus', run: () => addPage() });
      }
      if (app.commands && !app.commands.get('pages.manage')) {
        app.commands.register({ id: 'pages.manage', title: 'Manage pages…', category: 'File', icon: 'folder', run: () => openManager() });
      }
      if (app.ui && typeof app.ui.registerMenuItem === 'function') {
        app.ui.registerMenuItem({ menu: 'file', command: 'pages.manage', order: 6 });
      }
    }
  });
})();

/*
 * preview — `services.preview` (ARCHITECTURE.md §9): opens the current page, rendered exactly as
 * `services.exporters.html()` would export it, in a new tab via a `blob:` URL. Not a live/synced
 * preview — each click re-renders the current document state; the tab is a disposable static page.
 */
(function () {
  'use strict';

  APB.plugin({
    id: 'preview',
    order: 61,
    requires: ['widgets', 'icons'],

    init(app) {
      const widgets = APB.require('widgets');
      const win = typeof window !== 'undefined' ? window : null;

      function open(opts) {
        const o = opts || {};
        const exporters = app.services && app.services.exporters;
        if (!exporters || !win || typeof win.open !== 'function') {
          if (app.ui && app.ui.toast) app.ui.toast('Preview is unavailable in this environment', { kind: 'error' });
          return null;
        }
        const doc = app.store.doc;
        const pageId = o.pageId || app.store.view.pageId;
        let out = null;
        try { out = exporters.html(doc, { pageId, sourceComment: false, includeHidden: false }); } catch (err) {
          app.log('preview render failed: ' + (err && err.message), { level: 'error' });
        }
        if (!out) {
          if (app.ui && app.ui.toast) app.ui.toast('Add a page before previewing', { kind: 'warning' });
          return null;
        }
        const blob = new Blob([out.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const tab = win.open(url, '_blank');
        if (!tab) {
          URL.revokeObjectURL(url);
          if (app.ui && app.ui.toast) app.ui.toast('Preview blocked — allow pop-ups for this page', { kind: 'warning' });
          return null;
        }
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return tab;
      }

      app.services = app.services || {};
      app.services.preview = { open };

      if (app.commands && !app.commands.get('view.preview')) {
        app.commands.register({
          id: 'view.preview', title: 'Preview page', category: 'View', icon: 'preview', keys: ['Alt+P'],
          when: (a) => !!(a.store.doc.pages && a.store.doc.pages.length),
          run: (a) => open({ pageId: a.store.view.pageId })
        });
      }

      if (app.ui && typeof app.ui.registerToolbarItem === 'function') {
        app.ui.registerToolbarItem({
          id: 'preview', area: 'end', order: 20,
          render: (a) => widgets.iconButton({
            icon: 'preview', label: 'Preview page',
            shortcut: a.commands.get('view.preview') ? a.commands.keysFor('view.preview') : null,
            onClick: () => (a.commands.get('view.preview') ? a.commands.run('view.preview') : open({}))
          })
        });
      }
    }
  });
})();

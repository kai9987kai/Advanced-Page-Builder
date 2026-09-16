/*
 * assets — `services.assets` (ARCHITECTURE.md §9) and the left "Assets" panel. Images are stored
 * as `data:` URLs directly on `doc.assets[id]` (ARCHITECTURE.md §5 model comment) — no separate
 * blob store, so they autosave with the rest of the document via `features/storage.js` and travel
 * with `.apb.json` exports/imports for free.
 *
 * Contract (already depended on by `features/clipboard.js` and `canvas/interaction.js`, which both
 * work without it — see their `assetProps()`/paste-image fallbacks — this just makes the better
 * path available): `add(file) → Promise<id>`, `pick(opts) → Promise<id|null>` (used by the
 * inspector's `type:'asset'` field, see `features/inspector.js`'s `assetField()`), `url(id) →
 * string`, `list() → record[]`, `remove(id) → boolean`.
 */
(function () {
  'use strict';

  function readDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
      fr.onerror = () => reject(fr.error || new Error('Could not read file'));
      fr.readAsDataURL(file);
    });
  }

  function measureImage(src) {
    return new Promise((resolve) => {
      if (!src || typeof Image !== 'function') { resolve(null); return; }
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function kindOf(file) {
    const type = (file && file.type) || '';
    if (/^image\//.test(type)) return 'image';
    if (/^video\//.test(type)) return 'video';
    return 'file';
  }

  APB.plugin({
    id: 'assets',
    order: 32,
    requires: ['widgets', 'icons', 'util'],

    init(app) {
      const widgets = APB.require('widgets');
      const icons = APB.require('icons');
      const util = APB.require('util');
      const { h } = widgets;
      const store = app.store;

      function list() {
        const assets = store.doc.assets || {};
        return Object.keys(assets).map((id) => assets[id]).reverse();
      }
      function url(id) {
        const a = (store.doc.assets || {})[id];
        return a && typeof a.src === 'string' ? a.src : '';
      }
      function remove(id) {
        if (!store.doc.assets || !store.doc.assets[id]) return false;
        store.transact('Remove asset', (tx) => {
          const assets = Object.assign({}, tx.doc.assets);
          delete assets[id];
          tx.setDocField('assets', assets);
        });
        return true;
      }
      async function add(file) {
        const src = await readDataURL(file);
        const kind = kindOf(file);
        const dims = kind === 'image' ? await measureImage(src) : null;
        return store.transact('Add asset', (tx) => {
          const id = util.uid('as', tx.doc.assets || {});
          const rec = {
            id, name: (file && file.name) || 'Untitled', kind, mime: (file && file.type) || '', src,
            w: dims ? dims.w : undefined, h: dims ? dims.h : undefined, bytes: (file && file.size) || 0
          };
          tx.setDocField(['assets', id], rec);
          return id;
        });
      }

      function cardEl(rec, onPick) {
        const thumb = h('div', { class: 'apb-asset-card-thumb' },
          rec.kind === 'image' && rec.src ? (() => { const img = h('img', { alt: '' }); img.src = rec.src; return img; })() : icons.get(rec.kind === 'video' ? 'video' : 'file', { size: 20 }));
        const card = h('button', { type: 'button', class: 'apb-asset-card', title: rec.name },
          thumb, h('div', { class: 'apb-asset-card-name' }, rec.name));
        card.addEventListener('click', () => onPick(rec.id));
        return card;
      }

      function fileInputEl(accept, onFiles) {
        const input = h('input', { type: 'file', accept: accept || 'image/*', multiple: true, style: 'display:none' });
        input.addEventListener('change', () => { if (input.files && input.files.length) onFiles(Array.from(input.files)); input.value = ''; });
        return input;
      }

      /* -------------------------------------------------------------- panel */

      function mount(container) {
        const grid = h('div', { class: 'apb-assets-grid' });
        const drop = h('div', { class: 'apb-asset-drop' }, 'Drop images here, or ');
        const uploadBtn = widgets.button({ label: 'Upload…', icon: 'plus', size: 'sm', variant: 'subtle' });
        const input = fileInputEl('image/*,video/*', (files) => { Promise.all(files.map((f) => add(f))).then(render); });
        uploadBtn.addEventListener('click', () => input.click());
        drop.append(uploadBtn, input);
        const el = h('div', { class: 'apb-panel-fill' },
          h('div', { class: 'apb-panel-bar' }, h('strong', {}, 'Assets')),
          h('div', { class: 'apb-panel-scroll' }, drop, grid));
        container.appendChild(el);

        ['dragenter', 'dragover'].forEach((evt) => drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('is-dragover'); }));
        ['dragleave', 'drop'].forEach((evt) => drop.addEventListener(evt, () => drop.classList.remove('is-dragover')));
        drop.addEventListener('drop', (e) => {
          e.preventDefault();
          const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
          if (files.length) Promise.all(files.map((f) => add(f))).then(render);
        });

        function render() {
          const items = list();
          grid.replaceChildren();
          if (!items.length) { grid.appendChild(widgets.emptyState({ icon: 'image', title: 'No assets yet', message: 'Upload images to reuse them across the document.' })); return; }
          for (const rec of items) {
            const card = cardEl(rec, () => { store.select([]); });
            const del = widgets.iconButton({ icon: 'trash', label: 'Delete ' + rec.name, size: 'sm', className: 'apb-asset-card-delete', onClick: (e) => { e.stopPropagation(); remove(rec.id); render(); } });
            card.appendChild(del);
            grid.appendChild(card);
          }
        }
        render();
        const off = store.on('change', (payload) => { if (payload && payload.global) render(); });
        return { destroy: () => { if (off) off(); } };
      }

      /* ------------------------------------------------------------- picker */

      function pick(opts) {
        const o = opts || {};
        return new Promise((resolve) => {
          if (!app.ui || typeof app.ui.dialog !== 'function') { resolve(null); return; }
          let settled = false;
          const finish = (id) => { if (!settled) { settled = true; resolve(id); } };
          const grid = h('div', { class: 'apb-assets-grid' });
          const input = fileInputEl(o.accept || 'image/*', (files) => {
            if (!files.length) return;
            add(files[0]).then((id) => { finish(id); dlg.close(); });
          });
          const uploadBtn = widgets.button({ label: 'Upload…', icon: 'plus', size: 'sm' });
          uploadBtn.addEventListener('click', () => input.click());
          function render() {
            const items = list();
            grid.replaceChildren();
            if (!items.length) { grid.appendChild(widgets.emptyState({ icon: 'image', title: 'No assets yet', message: 'Upload an image to get started.' })); return; }
            for (const rec of items) grid.appendChild(cardEl(rec, (id) => { finish(id); dlg.close(); }));
          }
          render();
          const content = h('div', { class: 'apb-assets-picker' }, h('div', { class: 'apb-templates-grid' }, uploadBtn, input), grid);
          const dlg = app.ui.dialog({
            title: 'Choose an image', wide: true, content,
            actions: [{ label: 'Cancel', kind: 'cancel', run: (close) => { finish(null); close(); } }],
            dismissible: true
          });
        });
      }

      app.services = app.services || {};
      app.services.assets = { add, pick, url, list, remove };

      if (typeof app.ui.registerPanel === 'function') {
        app.ui.registerPanel({ id: 'assets', side: 'left', title: 'Assets', icon: 'image', order: 20, mount });
      }
    }
  });
})();

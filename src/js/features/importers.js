/*
 * importers — `services.importers` (ARCHITECTURE.md §9): turns pasted/dropped content into node
 * specs. `fromHTML(html, { parent }) → Promise<ids>` is what `features/clipboard.js`'s HTML paste
 * path calls; `fromFile(file) → Promise<result>` is what the canvas's file-drop handler
 * (`canvas/interaction.js`) calls for a dropped `.json`. Best-effort, not a full HTML-to-design
 * converter: headings/paragraphs/images/lists/tables/links/buttons map to real element types,
 * absolutely-positioned content keeps its x/y/w/h/rotation (this also covers the predecessor
 * single-file app's own saved layout — its `.element-wrapper` divs are exactly this shape, which is
 * why `features/storage.js` can offer that saved data for import), everything else becomes a block
 * of sanitized HTML via the `html` element type.
 */
(function () {
  'use strict';

  const BLOCK_TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote']);

  function pxNum(v) {
    if (typeof v !== 'string') return null;
    const m = /^(-?\d*\.?\d+)px$/.exec(v.trim());
    return m ? parseFloat(m[1]) : null;
  }

  function rotationOf(transform) {
    if (typeof transform !== 'string') return 0;
    const m = /rotate\((-?\d*\.?\d+)deg\)/.exec(transform);
    return m ? parseFloat(m[1]) : 0;
  }

  function isHandle(el) {
    return el.nodeType === 1 && /\b(resize-handle|rotate-handle)\b/.test(el.className || '');
  }

  APB.plugin({
    id: 'importers',
    order: 31,
    requires: ['sanitize', 'style', 'util'],

    init(app) {
      const sanitize = APB.require('sanitize');
      const styleMod = APB.require('style');
      const util = APB.require('util');
      const win = typeof window !== 'undefined' ? window : null;

      function currentParent(explicit) {
        if (explicit && app.store.doc.nodes[explicit]) return explicit;
        const view = app.store.view;
        if (view.context && app.store.doc.nodes[view.context]) return view.context;
        const pages = app.store.doc.pages || [];
        const page = pages.find((p) => p.id === view.pageId) || pages[0];
        return page ? page.root : null;
      }

      function textOf(el) { return (el.textContent || '').trim(); }

      /** Best-effort tag → element-type mapping for one (already-sanitized) DOM element. */
      function elementSpec(el) {
        if (!el || el.nodeType !== 1) return null;
        const tag = el.tagName.toLowerCase();
        if (tag === 'img') return { type: 'image', props: { src: el.getAttribute('src') || '', alt: el.getAttribute('alt') || '' } };
        if (tag === 'button' || (tag === 'a' && /\bbutton\b/.test(el.className || ''))) {
          return { type: 'button', props: { text: textOf(el) || 'Button' } };
        }
        if (tag === 'ul' || tag === 'ol') {
          const items = Array.from(el.children).filter((c) => c.tagName === 'LI').map((li) => textOf(li));
          return items.length ? { type: 'list', props: { items, ordered: tag === 'ol' } } : null;
        }
        if (tag === 'table') {
          const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((td) => textOf(td)));
          return rows.length ? { type: 'table', props: { rows, header: !!el.querySelector('th') } } : null;
        }
        if (BLOCK_TEXT_TAGS.has(tag) || tag === 'span' || tag === 'a') {
          const inner = el.innerHTML || '';
          const html = inner && inner !== util.escapeHTML(textOf(el)) ? inner : null;
          return { type: 'text', props: html ? { html } : { text: textOf(el) } };
        }
        const txt = textOf(el);
        if (!el.children.length) return txt ? { type: 'text', props: { text: txt } } : null;
        return el.innerHTML.trim() ? { type: 'html', props: { html: el.outerHTML } } : null;
      }

      /** An absolutely-positioned wrapper (pasted content or the legacy app's own export) → a fixed-box spec. */
      function wrapperSpec(el) {
        const decls = styleMod.parseDecls(el.getAttribute('style') || '');
        const x = pxNum(decls.get('left')) || 0;
        const y = pxNum(decls.get('top')) || 0;
        const w = pxNum(decls.get('width')) || 160;
        const h = pxNum(decls.get('height')) || 80;
        const rotation = rotationOf(decls.get('transform'));
        const content = el.querySelector(':scope > .element-content') || el;
        const inner = Array.from(content.children).find((c) => !isHandle(c)) || content;
        const spec = elementSpec(inner) || { type: 'frame' };
        return Object.assign(spec, { x, y, w, h, rotation, sizing: { w: 'fixed', h: 'fixed' } });
      }

      function flowSpec(node) {
        if (node.nodeType === 3) {
          const txt = (node.textContent || '').trim();
          return txt ? { type: 'text', props: { text: txt }, sizing: { w: 'fill', h: 'hug' } } : null;
        }
        if (node.nodeType !== 1 || isHandle(node)) return null;
        if (/\belement-wrapper\b/.test(node.className || '')) return wrapperSpec(node);
        const spec = elementSpec(node);
        if (!spec) return null;
        spec.sizing = spec.sizing || { w: 'fill', h: 'hug' };
        return spec;
      }

      /** fromHTML(html, { parent }) → Promise<ids[]> — inserted top-level node ids, [] if nothing usable. */
      async function fromHTML(html, opts) {
        const o = opts || {};
        if (!win || typeof win.DOMParser !== 'function' || typeof html !== 'string' || !html.trim()) return [];
        const clean = sanitize.html(html, 'html');
        if (!clean.trim()) return [];
        let parsed;
        try { parsed = new win.DOMParser().parseFromString('<div id="apb-import-root">' + clean + '</div>', 'text/html'); } catch (err) { return []; }
        const root = parsed.getElementById('apb-import-root');
        if (!root) return [];
        const specs = Array.from(root.childNodes).map(flowSpec).filter(Boolean);
        if (!specs.length) return [];
        const parent = currentParent(o.parent);
        if (!parent) return [];
        return app.docops.insert(app, specs, { parent, select: true, label: 'Paste' });
      }

      /** fromFile(file) → Promise<{ opened: boolean, ids?: string[] }> — a dropped/opened .json file. */
      async function fromFile(file) {
        if (!file) throw new Error('No file given');
        const name = file.name || '';
        if (!/\.json$/i.test(name) && file.type !== 'application/json') throw new Error('Not a JSON file');
        const text = await file.text();
        let data;
        try { data = JSON.parse(text); } catch (err) { throw new Error('That file is not valid JSON'); }
        if (util.isPlainObject(data) && data.format === 'apb' && Array.isArray(data.pages)) {
          app.store.replaceDoc(data, { label: 'Import project' });
          if (app.services.storage && typeof app.services.storage.saveAsNew === 'function') app.services.storage.saveAsNew();
          if (app.ui && app.ui.toast) app.ui.toast('Imported "' + (data.name || 'Untitled') + '"');
          return { opened: true };
        }
        if (util.isPlainObject(data) && typeof data.html === 'string') {
          const ids = await fromHTML(data.html, {});
          if (app.ui && app.ui.toast) {
            app.ui.toast(ids.length ? 'Imported ' + util.plural(ids.length, 'element') + ' from the saved layout' : 'Nothing recognizable in that file');
          }
          return { opened: false, ids };
        }
        throw new Error('Unrecognized project file');
      }

      app.services = app.services || {};
      app.services.importers = { fromHTML, fromFile };

      if (app.commands && !app.commands.get('file.import')) {
        app.commands.register({
          id: 'file.import', title: 'Import file…', category: 'File', icon: 'folder',
          run: () => {
            if (!win || typeof document === 'undefined') return;
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.addEventListener('change', () => {
              const f = input.files && input.files[0];
              if (f) {
                fromFile(f).catch((err) => { if (app.ui.toast) app.ui.toast((err && err.message) || 'Import failed', { kind: 'error' }); });
              }
            });
            input.click();
          }
        });
      }
      if (app.ui && typeof app.ui.registerMenuItem === 'function') {
        app.ui.registerMenuItem({ menu: 'file', command: 'file.import', order: 5, separatorBefore: true });
      }
    }
  });
})();

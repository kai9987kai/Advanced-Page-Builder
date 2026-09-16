/*
 * clipboard — copy / cut / paste for canvas nodes (ARCHITECTURE.md §7, §9; PLAN B1).
 *
 * Writes three flavours of the same selection to the system clipboard through
 * `navigator.clipboard.write`: the custom format `web application/x-apb+json` (lossless), `text/plain`
 * (the same JSON envelope, so it survives apps that only keep text) and `text/html` (the selection
 * exported with `vdom.toHTML`). Everything is best effort: an in-memory buffer always holds the last
 * copy, and the DOM `copy`/`cut`/`paste` events are handled too, so a native paste (browser menu,
 * middle-click paste) still works when the async Clipboard API is unavailable or not permitted.
 *
 * Pasting understands: an APB envelope (new ids, cascading +16 px offsets, into the selected
 * container / `view.context`), image files or blobs (→ `image` node, `services.assets.add` when a
 * plugin provides one), HTML (`services.importers.fromHTML` when present, else its text) and plain
 * text (→ `text` node). Inputs and contenteditable are never intercepted.
 */
(function () {
  'use strict';

  const FORMAT = 'apb-clipboard';
  const VERSION = 2;
  const CUSTOM_MIME = 'web application/x-apb+json';
  const PASTE_OFFSET = 16;
  const MAX_IMAGE = 640;
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

  APB.plugin({
    id: 'clipboard',
    order: 20,
    requires: ['util', 'schema', 'vdom', 'elements'],

    init(app) {
      const util = APB.require('util');
      const schema = APB.require('schema');
      const vdom = APB.require('vdom');
      const elements = APB.require('elements');
      const store = app.store;
      const commands = app.commands;
      const ownerDoc = typeof document !== 'undefined' ? document : null;
      const win = ownerDoc ? ownerDoc.defaultView : null;
      const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

      /** The last copy, used whenever the async Clipboard API is unavailable or denied. */
      let memory = null;
      let lastSignature = '';
      let pasteCount = 0;

      /* ------------------------------------------------------------ build */

      function docops() { return app.docops; }

      function collect(id, nodes, assets) {
        const doc = store.doc;
        const n = own(doc.nodes, id) ? doc.nodes[id] : null;
        if (!n || own(nodes, id)) return;
        nodes[id] = util.deepClone(n);
        const aid = n.props && n.props.asset;
        if (aid && doc.assets && own(doc.assets, aid)) assets[aid] = util.deepClone(doc.assets[aid]);
        for (const cid of n.children || []) collect(cid, nodes, assets);
      }

      /** `{ format, version, nodes, roots, assets }` for the given ids (top level, doc order). */
      function buildPayload(ids) {
        const d = docops();
        const doc = store.doc;
        if (!d) return null;
        const roots = d.sortDocOrder(doc, d.topLevel(doc, ids || store.selection))
          .filter((id) => own(doc.nodes, id) && doc.nodes[id].parent);
        if (!roots.length) return null;
        const nodes = {};
        const assets = {};
        for (const id of roots) collect(id, nodes, assets);
        return { format: FORMAT, version: VERSION, roots, nodes, assets };
      }

      function isPayload(value) {
        return !!(value && value.format === FORMAT && Array.isArray(value.roots) && value.nodes && typeof value.nodes === 'object');
      }

      function parsePayload(text) {
        if (typeof text !== 'string' || text.length < 20 || text.indexOf(FORMAT) === -1) return null;
        let value = null;
        try { value = JSON.parse(text); } catch (_) { return null; }
        return isPayload(value) ? value : null;
      }

      function signatureOf(payload) {
        return payload.roots.join(',') + ':' + Object.keys(payload.nodes).length;
      }

      function htmlFor(payload) {
        try {
          return payload.roots.map((id) => {
            const tree = vdom.buildTree(store.doc, id, { mode: 'export', parentEff: null, inlineStyles: true, bp: store.view.bp });
            return tree ? vdom.toHTML(tree, { pretty: true }) : '';
          }).filter(Boolean).join('\n');
        } catch (err) {
          console.error('[APB] clipboard HTML export failed:', err);
          return '';
        }
      }

      /* ------------------------------------------------------------ system */

      function clipboardAPI() {
        return win && win.navigator && win.navigator.clipboard ? win.navigator.clipboard : null;
      }

      async function writeSystem(json, html) {
        const api = clipboardAPI();
        if (!api || typeof api.write !== 'function' || typeof win.ClipboardItem !== 'function' || typeof win.Blob !== 'function') {
          if (api && typeof api.writeText === 'function') {
            try { await api.writeText(json); return true; } catch (_) { return false; }
          }
          return false;
        }
        const base = { 'text/plain': new win.Blob([json], { type: 'text/plain' }) };
        if (html) base['text/html'] = new win.Blob([html], { type: 'text/html' });
        const rich = Object.assign({}, base);
        try { rich[CUSTOM_MIME] = new win.Blob([json], { type: CUSTOM_MIME }); } catch (_) { /* unsupported */ }
        for (const data of [rich, base]) {
          try {
            await api.write([new win.ClipboardItem(data)]);
            return true;
          } catch (_) { /* fall through to the simpler item, then to the memory buffer */ }
        }
        return false;
      }

      /** → { payload } | { blob, type } | { html } | { text } | null */
      async function readSystem() {
        const api = clipboardAPI();
        if (!api) return null;
        let items = null;
        if (typeof api.read === 'function') {
          try { items = await api.read(); } catch (_) { items = null; }
        }
        if (items) {
          const list = Array.from(items);
          for (const item of list) {
            for (const type of item.types) {
              if (type !== CUSTOM_MIME && type !== 'text/plain') continue;
              try {
                const payload = parsePayload(await (await item.getType(type)).text());
                if (payload) return { payload };
              } catch (_) { /* unreadable entry */ }
            }
          }
          for (const item of list) {
            const image = item.types.find((t) => t.indexOf('image/') === 0);
            if (image) {
              try { return { blob: await item.getType(image), type: image }; } catch (_) { /* unreadable */ }
            }
          }
          for (const item of list) {
            for (const type of ['text/html', 'text/plain']) {
              if (item.types.indexOf(type) === -1) continue;
              try {
                const text = await (await item.getType(type)).text();
                if (text) return type === 'text/html' ? { html: text } : { text };
              } catch (_) { /* unreadable */ }
            }
          }
          return null;
        }
        if (typeof api.readText === 'function') {
          try {
            const text = await api.readText();
            const payload = parsePayload(text);
            if (payload) return { payload };
            if (text) return { text };
          } catch (_) { /* denied */ }
        }
        return null;
      }

      /* ------------------------------------------------------------ insert */

      function canContainAll(parentId, types) {
        const doc = store.doc;
        const n = own(doc.nodes, parentId) ? doc.nodes[parentId] : null;
        if (!n || !Array.isArray(n.children)) return false;
        const d = docops();
        if (d && d.isLocked(doc, parentId)) return false;
        return types.every((t) => elements.canContain(n.type, t));
      }

      /**
       * Selected container → parent of the selection → `view.context` → docops' default.
       * `skip` holds the ids being pasted, so copying a frame and pasting drops the copy beside it
       * instead of inside itself.
       */
      function targetParent(types, opts, skip) {
        const doc = store.doc;
        const o = opts || {};
        if (o.parent && canContainAll(o.parent, types)) return o.parent;
        const sel = store.selection;
        const skipped = (id) => !!skip && own(skip, id);
        if (sel.length === 1 && !skipped(sel[0]) && canContainAll(sel[0], types)) return sel[0];
        if (sel.length && own(doc.nodes, sel[0])) {
          const p = doc.nodes[sel[0]].parent;
          if (p && canContainAll(p, types)) return p;
        }
        const c = store.view.context;
        if (c && own(doc.nodes, c) && canContainAll(c, types)) return c;
        return null;
      }

      function specFor(nodes, id) {
        const n = nodes[id];
        if (!n) return null;
        const spec = util.omit(n, ['id', 'parent', 'children']);
        const kids = (n.children || []).map((cid) => specFor(nodes, cid)).filter(Boolean);
        if (kids.length) spec.children = kids;
        return spec;
      }

      function isStack(parentId) {
        const eff = parentId ? schema.effectiveNode(store.doc, parentId, store.view.bp) : null;
        return !!(eff && eff.layout && eff.layout.mode === 'stack');
      }

      function addAssets(tx, assets) {
        if (!assets || !store.doc.assets) return;
        for (const id of Object.keys(assets)) {
          if (!own(store.doc.assets, id)) tx.set(['assets', id], assets[id]);
        }
      }

      /** Paste an APB envelope: new ids, offset cascade (unless `inPlace`), into the target container. */
      function pasteNodes(payload, opts) {
        const d = docops();
        const doc = store.doc;
        const o = opts || {};
        if (!d || !isPayload(payload)) return [];
        const roots = payload.roots.filter((id) => own(payload.nodes, id));
        if (!roots.length) return [];
        const specs = roots.map((id) => specFor(payload.nodes, id)).filter(Boolean);
        if (!specs.length) return [];
        const types = roots.map((id) => payload.nodes[id].type);
        const sig = signatureOf(payload);
        let offset = 0;
        if (o.inPlace) {
          pasteCount = 0;
          lastSignature = sig;
        } else {
          pasteCount = sig === lastSignature ? pasteCount + 1 : 1;
          lastSignature = sig;
          offset = pasteCount * PASTE_OFFSET;
        }
        let parent = null;
        if (o.inPlace) {
          const home = payload.nodes[roots[0]].parent;
          if (home && own(doc.nodes, home) && canContainAll(home, types)) parent = home;
        }
        if (!parent) parent = targetParent(types, o, payload.nodes);
        if (offset && !isStack(parent)) {
          for (const spec of specs) {
            spec.x = Math.round((Number(spec.x) || 0) + offset);
            spec.y = Math.round((Number(spec.y) || 0) + offset);
          }
        }
        const label = specs.length === 1 ? 'Paste layer' : 'Paste ' + util.plural(specs.length, 'layer');
        const insertOpts = { select: true, label };
        if (parent) insertOpts.parent = parent;
        let ids = [];
        store.transact(label, (tx) => {
          addAssets(tx, payload.assets);
          ids = d.insert(app, specs, insertOpts);
        });
        announce(util.plural(ids.length, 'layer') + ' pasted');
        return ids;
      }

      function insertSpecs(specs, label) {
        const d = docops();
        if (!d || !specs.length) return [];
        const canvas = app.canvas;
        if (canvas && typeof canvas.insertAtViewportCenter === 'function') {
          const ids = canvas.insertAtViewportCenter(specs, { label });
          if (ids.length) return ids;
        }
        return d.insert(app, specs, { label });
      }

      function readDataURL(file) {
        return new Promise((resolve) => {
          try {
            const fr = new win.FileReader();
            fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
            fr.onerror = () => resolve('');
            fr.readAsDataURL(file);
          } catch (_) { resolve(''); }
        });
      }

      function measure(src) {
        return new Promise((resolve) => {
          if (!src || !win || typeof win.Image !== 'function') { resolve(null); return; }
          const img = new win.Image();
          img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
          img.onerror = () => resolve(null);
          img.src = src;
        });
      }

      async function imageSpec(file) {
        let src = '';
        let asset = '';
        const svc = app.services && app.services.assets;
        if (svc && typeof svc.add === 'function') {
          try {
            const res = await svc.add(file);
            if (typeof res === 'string') asset = res;
            else if (res && typeof res === 'object') { asset = res.id || ''; src = res.src || ''; }
          } catch (err) { console.error('[APB] assets.add failed:', err); }
        }
        if (!src && !asset) src = await readDataURL(file);
        if (!src && !asset) return null;
        const nat = await measure(src);
        const scale = nat && nat.w && nat.h ? Math.min(1, MAX_IMAGE / Math.max(nat.w, nat.h)) : 0;
        return {
          type: 'image',
          name: file.name || 'Pasted image',
          w: scale ? Math.max(1, Math.round(nat.w * scale)) : 320,
          h: scale ? Math.max(1, Math.round(nat.h * scale)) : 240,
          props: { src, asset, alt: '', decorative: false, loading: 'lazy', fetchpriority: '' }
        };
      }

      async function pasteImages(files) {
        const specs = [];
        for (const file of files) {
          const spec = await imageSpec(file);
          if (spec) specs.push(spec);
        }
        if (!specs.length) return [];
        const ids = insertSpecs(specs, specs.length === 1 ? 'Paste image' : 'Paste ' + util.plural(specs.length, 'image'));
        if (ids.length) announce(util.plural(ids.length, 'image') + ' pasted');
        return ids;
      }

      function textToSpec(text) {
        const value = String(text).replace(/\r\n?/g, '\n').trim();
        if (!value) return null;
        const lines = value.split('\n').length;
        return {
          type: 'text',
          name: value.slice(0, 40) || 'Text',
          w: 360,
          h: Math.max(32, Math.min(600, lines * 28 + 12)),
          props: { text: value, html: null, tag: 'p', href: '', target: '' }
        };
      }

      function pasteText(text) {
        const spec = textToSpec(text);
        if (!spec) return [];
        const ids = insertSpecs([spec], 'Paste text');
        if (ids.length) announce('Text pasted');
        return ids;
      }

      function htmlToText(html) {
        if (!win || typeof win.DOMParser !== 'function') return String(html).replace(/<[^>]*>/g, ' ');
        try {
          const parsed = new win.DOMParser().parseFromString(String(html), 'text/html');
          return parsed && parsed.body ? parsed.body.textContent || '' : '';
        } catch (_) {
          return '';
        }
      }

      async function pasteHTML(html) {
        const importers = app.services && app.services.importers;
        if (importers && typeof importers.fromHTML === 'function') {
          try {
            const res = await importers.fromHTML(html, { parent: targetParent(['frame'], {}) });
            return Array.isArray(res) ? res : [];
          } catch (err) {
            console.error('[APB] importers.fromHTML failed:', err);
          }
        }
        return pasteText(htmlToText(html));
      }

      function announce(message) {
        const ui = app.ui;
        if (ui && typeof ui.announce === 'function') { try { ui.announce(message); } catch (_) { /* optional */ } }
      }

      function toast(message, kind) {
        const ui = app.ui;
        if (ui && typeof ui.toast === 'function') { try { ui.toast(message, kind ? { kind } : undefined); } catch (_) { /* optional */ } }
        else announce(message);
      }

      /* -------------------------------------------------------- public API */

      /** Copy the selection (or `ids`). Resolves to the ids that were copied. */
      async function copy(ids) {
        const payload = buildPayload(ids);
        if (!payload) return [];
        const json = JSON.stringify(payload);
        const html = htmlFor(payload);
        memory = { payload, json, html, at: Date.now() };
        lastSignature = signatureOf(payload);
        pasteCount = 0;
        await writeSystem(json, html);
        announce(util.plural(payload.roots.length, 'layer') + ' copied');
        return payload.roots.slice();
      }

      async function cut(ids) {
        const d = docops();
        const copied = await copy(ids);
        if (!copied.length || !d) return [];
        d.remove(app, copied);
        announce(util.plural(copied.length, 'layer') + ' cut');
        return copied;
      }

      /** Paste whatever the clipboard holds. `{ inPlace, parent }`. */
      async function paste(opts) {
        const o = opts || {};
        let data = null;
        try { data = await readSystem(); } catch (_) { data = null; }
        if (!data && memory) data = { payload: memory.payload };
        if (!data) { toast('The clipboard is empty.', 'info'); return []; }
        if (data.payload) return pasteNodes(data.payload, o);
        if (data.blob) return pasteImages([data.blob]);
        if (data.html) return pasteHTML(data.html);
        if (data.text) return pasteText(data.text);
        return [];
      }

      const api = {
        copy,
        cut,
        paste,
        pasteInPlace: (opts) => paste(Object.assign({}, opts, { inPlace: true })),
        payload: (ids) => buildPayload(ids),
        write: (payload) => {
          if (!isPayload(payload)) return Promise.resolve(false);
          const json = JSON.stringify(payload);
          memory = { payload, json, html: '', at: Date.now() };
          lastSignature = signatureOf(payload);
          pasteCount = 0;
          return writeSystem(json, '');
        },
        read: () => readSystem(),
        insertPayload: (payload, opts) => pasteNodes(payload, opts),
        get buffer() { return memory ? memory.payload : null; },
        clear() { memory = null; lastSignature = ''; pasteCount = 0; },
        FORMAT, CUSTOM_MIME, VERSION
      };
      app.services.clipboard = api;

      /* ------------------------------------------------------- DOM events */

      function editableTarget(target) {
        return !!(commands && typeof commands.isEditableTarget === 'function' && commands.isEditableTarget(target));
      }

      function inCanvas() {
        const canvas = app.canvas;
        if (!canvas || !canvas.el || !ownerDoc) return false;
        const activeEl = ownerDoc.activeElement;
        return !!activeEl && (activeEl === canvas.el || canvas.el.contains(activeEl));
      }

      function onCopyEvent(e, isCut) {
        if (editableTarget(e.target) || store.view.editingText) return;
        if (!store.selection.length) return;
        const payload = buildPayload();
        if (!payload) return;
        const json = JSON.stringify(payload);
        const html = htmlFor(payload);
        memory = { payload, json, html, at: Date.now() };
        lastSignature = signatureOf(payload);
        pasteCount = 0;
        const dt = e.clipboardData;
        if (dt) {
          try {
            dt.setData('text/plain', json);
            if (html) dt.setData('text/html', html);
            try { dt.setData(CUSTOM_MIME, json); } catch (_) { /* unsupported type */ }
          } catch (_) { /* read-only */ }
        }
        e.preventDefault();
        if (isCut && docops()) docops().remove(app, payload.roots);
        announce(util.plural(payload.roots.length, 'layer') + (isCut ? ' cut' : ' copied'));
      }

      function onPasteEvent(e) {
        if (editableTarget(e.target) || store.view.editingText) return;
        const dt = e.clipboardData;
        if (!dt) return;
        let text = '';
        try { text = dt.getData(CUSTOM_MIME) || dt.getData('text/plain') || ''; } catch (_) { text = ''; }
        const payload = parsePayload(text);
        if (payload) {
          e.preventDefault();
          pasteNodes(payload, {});
          return;
        }
        const files = Array.from(dt.files || []).filter((f) => /^image\//.test(f.type || '') || IMAGE_RE.test(f.name || ''));
        if (files.length) {
          e.preventDefault();
          pasteImages(files).catch((err) => console.error('[APB] paste image failed:', err));
          return;
        }
        let html = '';
        try { html = dt.getData('text/html') || ''; } catch (_) { html = ''; }
        if (html) {
          e.preventDefault();
          pasteHTML(html).catch((err) => console.error('[APB] paste HTML failed:', err));
          return;
        }
        if (text && inCanvas()) {
          e.preventDefault();
          pasteText(text);
        }
      }

      if (ownerDoc) {
        ownerDoc.addEventListener('copy', (e) => onCopyEvent(e, false));
        ownerDoc.addEventListener('cut', (e) => onCopyEvent(e, true));
        ownerDoc.addEventListener('paste', onPasteEvent);
      }

      /* ---------------------------------------------------------- commands */

      const hasSelection = () => !store.view.editingText && store.selection.length > 0 && !!docops();
      const canPaste = () => !store.view.editingText && !!docops();

      const defs = [
        {
          id: 'edit.copy', title: 'Copy', category: 'Edit', icon: 'copy', keys: ['Mod+C'],
          when: hasSelection, run: () => copy()
        },
        {
          id: 'edit.cut', title: 'Cut', category: 'Edit', icon: 'cut', keys: ['Mod+X'],
          when: hasSelection, run: () => cut()
        },
        {
          id: 'edit.paste', title: 'Paste', category: 'Edit', icon: 'paste', keys: ['Mod+V'],
          when: canPaste, run: () => paste()
        },
        {
          id: 'edit.pasteInPlace', title: 'Paste in place', category: 'Edit', icon: 'paste', keys: ['Mod+Shift+V'],
          when: canPaste, run: () => paste({ inPlace: true })
        }
      ];
      for (const def of defs) {
        if (!commands.get(def.id)) commands.register(def);
      }

      const ui = app.ui;
      if (ui && typeof ui.registerMenuItem === 'function') {
        const items = [['edit.cut', 20, true], ['edit.copy', 21], ['edit.paste', 22], ['edit.pasteInPlace', 23]];
        for (const [command, order, separatorBefore] of items) {
          try { ui.registerMenuItem({ menu: 'edit', command, order, separatorBefore: !!separatorBefore }); } catch (_) { /* optional */ }
        }
      }
    }
  });
})();

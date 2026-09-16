/*
 * tokens — document styles: colour tokens, text styles, page background and document fonts
 * (ARCHITECTURE.md §5 `doc.tokens` / `doc.settings.fonts`; PLAN C1).
 *
 * This module owns every write to `doc.tokens` and `doc.settings.fonts` plus the "Document styles"
 * UI that the Design panel (features/inspector.js) shows while nothing is selected. Everything goes
 * through `store.transact`, so each edit is one undo entry, and colour edits coalesce per token so
 * dragging a colour picker does not flood the history.
 *
 * Colour tokens are referenced from node styles as the string `$<id>` (resolved to `var(--t-<id>)`
 * by `style`), text styles as `style.textStyle = '<id>'`. Renaming an id rewrites every reference
 * in the same transaction, deleting a text style inlines it into the nodes that used it, so the
 * document never keeps a dangling reference.
 *
 * No network access: Google fonts are recorded as family names only (the exporter adds the link).
 */
APB.define('tokens', ['util', 'schema', 'color', 'docops', 'widgets', 'icons'],
  function (util, schema, color, docops, widgets, icons) {
    'use strict';

    const h = widgets.h;

    const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const MAX_TOKENS = 200;
    const MAX_NAME = 60;

    /** Style keys copied into / out of a text style token. */
    const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'textAlign', 'textDecoration', 'textTransform', 'color'];

    /** Style keys whose value may be a `$token` colour reference. */
    const COLOR_STYLE_KEYS = ['fill', 'color', 'borderColor', 'stroke'];

    const SYSTEM_STACKS = [
      { label: 'System sans', value: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
      { label: 'System serif', value: 'Georgia, "Times New Roman", Times, serif' },
      { label: 'Monospace', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      { label: 'Rounded', value: 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif' },
      { label: 'Humanist', value: 'Optima, Candara, "Gill Sans", "Trebuchet MS", sans-serif' }
    ];

    const isStr = (v) => typeof v === 'string';
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

    /* ------------------------------------------------------------ reading */

    function colors(doc) {
      const list = doc && doc.tokens && Array.isArray(doc.tokens.colors) ? doc.tokens.colors : [];
      return list.filter((t) => t && isStr(t.id) && TOKEN_ID_RE.test(t.id));
    }

    function texts(doc) {
      const list = doc && doc.tokens && Array.isArray(doc.tokens.text) ? doc.tokens.text : [];
      return list.filter((t) => t && isStr(t.id) && TOKEN_ID_RE.test(t.id));
    }

    function fonts(doc) {
      const list = doc && doc.settings && Array.isArray(doc.settings.fonts) ? doc.settings.fonts : [];
      return list.filter((f) => f && isStr(f.family) && f.family.trim());
    }

    function colorToken(doc, id) {
      return colors(doc).find((t) => t.id === id) || null;
    }

    function textToken(doc, id) {
      return texts(doc).find((t) => t.id === id) || null;
    }

    /** Family names + system stacks for the Typography font picker. */
    function fontOptions(doc) {
      const out = SYSTEM_STACKS.map((s) => ({ value: s.value, label: s.label, group: 'System' }));
      for (const f of fonts(doc)) {
        const family = f.family.trim();
        const quoted = /[^A-Za-z0-9-]/.test(family) ? '"' + family.replace(/["\\]/g, '') + '"' : family;
        out.push({ value: quoted + ', system-ui, sans-serif', label: family, group: 'Document' });
      }
      return out;
    }

    /** A fresh, unique, id-safe token id derived from `name`. */
    function makeId(name, taken) {
      const used = new Set(taken || []);
      let base = util.slugify(String(name || '')).replace(/[^A-Za-z0-9_-]/g, '');
      if (!base || !/^[A-Za-z0-9]/.test(base)) base = 'token' + (base ? '-' + base : '');
      base = base.slice(0, 48);
      if (!used.has(base)) return base;
      let i = 2;
      while (used.has(base + '-' + i) && i < 999) i++;
      return base + '-' + i;
    }

    /* ------------------------------------------------------------- usage */

    function styleUsesToken(style, id) {
      if (!util.isPlainObject(style)) return false;
      for (const key of COLOR_STYLE_KEYS) {
        const v = style[key];
        if (isStr(v) && v.indexOf('$') !== -1 && refNames(v).includes(id)) return true;
      }
      const fi = style.fillImage;
      if (util.isPlainObject(fi) && isStr(fi.src) && refNames(fi.src).includes(id)) return true;
      return false;
    }

    function refNames(value) {
      const out = [];
      const re = /\$([A-Za-z0-9_-]{1,64})/g;
      let m;
      while ((m = re.exec(value))) out.push(m[1]);
      return out;
    }

    function eachStyleBag(node, fn) {
      fn(node.style, ['style']);
      if (util.isPlainObject(node.bp)) {
        for (const bpId of Object.keys(node.bp)) {
          const over = node.bp[bpId];
          if (util.isPlainObject(over) && util.isPlainObject(over.style)) fn(over.style, ['bp', bpId, 'style']);
        }
      }
      if (util.isPlainObject(node.states)) {
        for (const state of Object.keys(node.states)) {
          const s = node.states[state];
          if (util.isPlainObject(s) && util.isPlainObject(s.style)) fn(s.style, ['states', state, 'style']);
        }
      }
    }

    /** usage(doc, id, kind) → node ids referencing this colour ('color') or text style ('text'). */
    function usage(doc, id, kind) {
      const out = [];
      const nodes = (doc && doc.nodes) || {};
      for (const nodeId of Object.keys(nodes)) {
        const node = nodes[nodeId];
        let hit = false;
        eachStyleBag(node, (style) => {
          if (hit || !util.isPlainObject(style)) return;
          if (kind === 'text') hit = style.textStyle === id;
          else hit = styleUsesToken(style, id);
        });
        if (hit) out.push(nodeId);
      }
      return out;
    }

    /* ------------------------------------------------------- colour CRUD */

    function storeOf(app) {
      return app && app.store ? app.store : app;
    }

    function writeColors(app, list, label, opts) {
      return storeOf(app).transact(label, (tx) => {
        tx.setDocField('tokens.colors', list);
        return true;
      }, opts);
    }

    function writeTexts(app, list, label, opts) {
      return storeOf(app).transact(label, (tx) => {
        tx.setDocField('tokens.text', list);
        return true;
      }, opts);
    }

    /** addColor(app, { name, value }) → new token id (or null when the document is full). */
    function addColor(app, init) {
      const store = storeOf(app);
      const list = colors(store.doc);
      if (list.length >= MAX_TOKENS) return null;
      const o = init || {};
      const name = String(o.name || 'Colour').trim().slice(0, MAX_NAME) || 'Colour';
      const parsed = color.parse(o.value || '');
      const value = parsed ? color.toHex(parsed, 'auto') : '#2563eb';
      const id = isStr(o.id) && TOKEN_ID_RE.test(o.id) && !list.some((t) => t.id === o.id)
        ? o.id
        : makeId(name, list.map((t) => t.id));
      writeColors(app, list.concat([{ id, name, value }]), 'Add colour style');
      return id;
    }

    /** setColor(app, id, { name, value }) — live edits coalesce per token. */
    function setColor(app, id, patch, opts) {
      const store = storeOf(app);
      const list = colors(store.doc);
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0 || !util.isPlainObject(patch)) return false;
      const next = Object.assign({}, list[idx]);
      if (isStr(patch.name)) next.name = patch.name.slice(0, MAX_NAME);
      if (patch.value !== undefined) {
        const parsed = color.parse(patch.value || '');
        next.value = parsed ? color.toHex(parsed, 'auto') : String(patch.value || '');
      }
      if (util.deepEqual(next, list[idx])) return false;
      const copy = list.slice();
      copy[idx] = next;
      writeColors(app, copy, 'Edit colour style', { coalesce: (opts && opts.coalesce) || 'tokens:color:' + id });
      return true;
    }

    /** renameColor(app, id, nextId) — rewrites every `$id` reference in one transaction. */
    function renameColor(app, id, nextId) {
      const store = storeOf(app);
      const list = colors(store.doc);
      const idx = list.findIndex((t) => t.id === id);
      const clean = isStr(nextId) ? nextId.trim() : '';
      if (idx < 0 || !TOKEN_ID_RE.test(clean) || clean === id) return false;
      if (list.some((t) => t.id === clean)) return false;
      const affected = usage(store.doc, id, 'color');
      const copy = list.slice();
      copy[idx] = Object.assign({}, copy[idx], { id: clean });
      store.transact('Rename colour style', (tx) => {
        tx.setDocField('tokens.colors', copy);
        for (const nodeId of affected) rewriteRefs(tx, nodeId, id, '$' + clean);
      });
      return true;
    }

    /** Replace `$from` inside every style bag of one node with `to` (a `$id` ref or a literal). */
    function rewriteRefs(tx, nodeId, from, to) {
      const node = tx.node(nodeId);
      if (!node) return;
      const re = new RegExp('\\$' + from.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?![A-Za-z0-9_-])', 'g');
      eachStyleBag(node, (style, path) => {
        if (!util.isPlainObject(style)) return;
        for (const key of COLOR_STYLE_KEYS) {
          const v = style[key];
          if (isStr(v) && re.test(v)) tx.set(['nodes', nodeId].concat(path, key), to === null ? undefined : v.replace(re, to));
        }
        const fi = style.fillImage;
        if (util.isPlainObject(fi) && isStr(fi.src) && re.test(fi.src)) {
          tx.set(['nodes', nodeId].concat(path, 'fillImage', 'src'), fi.src.replace(re, to === null ? '' : to));
        }
      });
    }

    /**
     * removeColor(app, id, { inline = true }) — deletes the token; referencing nodes keep the look
     * by getting the literal colour value instead of the reference.
     */
    function removeColor(app, id, opts) {
      const store = storeOf(app);
      const list = colors(store.doc);
      const token = list.find((t) => t.id === id);
      if (!token) return false;
      const inline = !opts || opts.inline !== false;
      const affected = usage(store.doc, id, 'color');
      store.transact('Delete colour style', (tx) => {
        tx.setDocField('tokens.colors', list.filter((t) => t.id !== id));
        for (const nodeId of affected) rewriteRefs(tx, nodeId, id, inline ? token.value : 'transparent');
      });
      return true;
    }

    /**
     * replaceEverywhere(app, id) → number of style declarations changed. Every literal use of the
     * token's colour in the document becomes a reference to the token.
     */
    function replaceEverywhere(app, id) {
      const store = storeOf(app);
      const token = colorToken(store.doc, id);
      if (!token) return 0;
      const target = color.parse(token.value);
      if (!target) return 0;
      const targetHex = color.toHex(target, 'auto').toLowerCase();
      const nodes = store.doc.nodes || {};
      const jobs = [];
      for (const nodeId of Object.keys(nodes)) {
        eachStyleBag(nodes[nodeId], (style, path) => {
          if (!util.isPlainObject(style)) return;
          for (const key of COLOR_STYLE_KEYS) {
            const v = style[key];
            if (!isStr(v) || v.charAt(0) === '$') continue;
            const parsed = color.parse(v);
            if (!parsed || color.toHex(parsed, 'auto').toLowerCase() !== targetHex) continue;
            jobs.push(['nodes', nodeId].concat(path, key));
          }
        });
      }
      if (!jobs.length) return 0;
      store.transact('Replace colour everywhere', (tx) => {
        for (const path of jobs) tx.set(path, '$' + id);
      });
      return jobs.length;
    }

    /** applyColor(app, ids, ref, target: 'fill'|'color'|'borderColor'|'stroke') */
    function applyColor(app, ids, ref, target) {
      const key = COLOR_STYLE_KEYS.includes(target) ? target : 'fill';
      const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => isStr(id) && storeOf(app).node(id));
      if (!list.length) return [];
      return docops.update(app, list, { ['style.' + key]: ref }, { label: 'Apply colour style' });
    }

    /* --------------------------------------------------------- text styles */

    /** textStyleFromNode(doc, node, bp) → the text declarations of a node, ready to store. */
    function textStyleFromNode(doc, node, bp) {
      const eff = schema.effectiveNode(doc, node, bp);
      const style = (eff && util.isPlainObject(eff.style) ? eff.style : {});
      const base = textToken(doc, style.textStyle);
      const merged = base && util.isPlainObject(base.style) ? Object.assign({}, base.style, style) : style;
      const out = {};
      for (const key of TEXT_STYLE_KEYS) if (merged[key] !== undefined && merged[key] !== '') out[key] = merged[key];
      return out;
    }

    function addTextStyle(app, init) {
      const store = storeOf(app);
      const list = texts(store.doc);
      if (list.length >= MAX_TOKENS) return null;
      const o = init || {};
      const name = String(o.name || 'Text style').trim().slice(0, MAX_NAME) || 'Text style';
      const id = isStr(o.id) && TOKEN_ID_RE.test(o.id) && !list.some((t) => t.id === o.id)
        ? o.id
        : makeId(name, list.map((t) => t.id));
      const style = util.isPlainObject(o.style) ? util.pick(o.style, TEXT_STYLE_KEYS) : {};
      writeTexts(app, list.concat([{ id, name, style }]), 'Add text style');
      return id;
    }

    function setTextStyle(app, id, patch, opts) {
      const store = storeOf(app);
      const list = texts(store.doc);
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0 || !util.isPlainObject(patch)) return false;
      const next = Object.assign({}, list[idx]);
      if (isStr(patch.name)) next.name = patch.name.slice(0, MAX_NAME);
      if (util.isPlainObject(patch.style)) next.style = util.pick(patch.style, TEXT_STYLE_KEYS);
      if (util.deepEqual(next, list[idx])) return false;
      const copy = list.slice();
      copy[idx] = next;
      writeTexts(app, copy, 'Edit text style', { coalesce: (opts && opts.coalesce) || 'tokens:text:' + id });
      return true;
    }

    function renameTextStyle(app, id, nextId) {
      const store = storeOf(app);
      const list = texts(store.doc);
      const idx = list.findIndex((t) => t.id === id);
      const clean = isStr(nextId) ? nextId.trim() : '';
      if (idx < 0 || !TOKEN_ID_RE.test(clean) || clean === id || list.some((t) => t.id === clean)) return false;
      const affected = usage(store.doc, id, 'text');
      const copy = list.slice();
      copy[idx] = Object.assign({}, copy[idx], { id: clean });
      store.transact('Rename text style', (tx) => {
        tx.setDocField('tokens.text', copy);
        for (const nodeId of affected) {
          const node = tx.node(nodeId);
          eachStyleBag(node, (style, path) => {
            if (util.isPlainObject(style) && style.textStyle === id) tx.set(['nodes', nodeId].concat(path, 'textStyle'), clean);
          });
        }
      });
      return true;
    }

    /** Deleting a text style inlines its declarations into the nodes that referenced it. */
    function removeTextStyle(app, id) {
      const store = storeOf(app);
      const list = texts(store.doc);
      const token = list.find((t) => t.id === id);
      if (!token) return false;
      const affected = usage(store.doc, id, 'text');
      store.transact('Delete text style', (tx) => {
        tx.setDocField('tokens.text', list.filter((t) => t.id !== id));
        for (const nodeId of affected) {
          const node = tx.node(nodeId);
          eachStyleBag(node, (style, path) => {
            if (!util.isPlainObject(style) || style.textStyle !== id) return;
            for (const key of Object.keys(token.style || {})) {
              if (style[key] === undefined) tx.set(['nodes', nodeId].concat(path, key), token.style[key]);
            }
            tx.set(['nodes', nodeId].concat(path, 'textStyle'), undefined);
          });
        }
      });
      return true;
    }

    function applyTextStyle(app, ids, id) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter((n) => isStr(n) && storeOf(app).node(n));
      if (!list.length) return [];
      return docops.update(app, list, { 'style.textStyle': id || undefined }, { label: 'Apply text style' });
    }

    /* ------------------------------------------------------- page / fonts */

    function currentPageRoot(app) {
      const store = storeOf(app);
      const doc = store.doc;
      const view = store.view || {};
      if (view.component && doc.components && doc.components[view.component]) return doc.components[view.component].root;
      const page = (doc.pages || []).find((p) => p.id === view.pageId) || (doc.pages || [])[0];
      return page ? page.root : null;
    }

    function pageBackground(app) {
      const id = currentPageRoot(app);
      const node = id ? storeOf(app).node(id) : null;
      return node && util.isPlainObject(node.style) ? (node.style.fill || null) : null;
    }

    function setPageBackground(app, value, opts) {
      const id = currentPageRoot(app);
      if (!id) return false;
      docops.update(app, [id], { 'style.fill': value }, {
        label: 'Page background', coalesce: (opts && opts.coalesce) || 'tokens:page-bg'
      });
      return true;
    }

    function addFont(app, family, source) {
      const store = storeOf(app);
      const name = String(family || '').trim().replace(/["\\<>]/g, '').slice(0, 64);
      if (!name) return false;
      const list = fonts(store.doc);
      if (list.some((f) => f.family.toLowerCase() === name.toLowerCase())) return false;
      const entry = { family: name, source: source === 'google' ? 'google' : 'system', weights: [400, 700] };
      store.transact('Add font', (tx) => { tx.setDocField('settings.fonts', list.concat([entry])); });
      return true;
    }

    function removeFont(app, family) {
      const store = storeOf(app);
      const list = fonts(store.doc);
      const next = list.filter((f) => f.family !== family);
      if (next.length === list.length) return false;
      store.transact('Remove font', (tx) => { tx.setDocField('settings.fonts', next); });
      return true;
    }

    /* =================================================================== UI */

    const swatchCSS = (value, doc) => {
      if (!isStr(value) || !value) return 'transparent';
      if (value.charAt(0) === '$') {
        const t = colorToken(doc, value.slice(1));
        return t ? (color.parse(t.value) ? color.toRGBString(color.parse(t.value)) : 'transparent') : 'transparent';
      }
      const p = color.parse(value);
      return p ? color.toRGBString(p) : 'transparent';
    };

    /**
     * mount(container, app, { targets() → nodeIds, onFocusChange() }) → { update(), destroy() }
     * The Document styles view. `targets()` supplies the layers an "Apply" action writes to (the
     * Design panel remembers the last selection, since this view is shown when nothing is selected).
     */
    function mount(container, app, opts) {
      const o = opts || {};
      const store = app.store;
      const ui = app.ui;
      const root = h('div', { class: 'apb-docstyles' });
      const offs = [];
      let raf = 0;
      let destroyed = false;
      let sig = '';

      const targets = () => {
        const list = typeof o.targets === 'function' ? o.targets() : [];
        return (Array.isArray(list) ? list : []).filter((id) => store.node(id));
      };

      const toast = (msg, kind) => { if (ui && typeof ui.toast === 'function') ui.toast(msg, { kind: kind || 'info' }); };

      function signature() {
        const doc = store.doc;
        return JSON.stringify([doc.tokens && doc.tokens.colors, doc.tokens && doc.tokens.text,
          doc.settings && doc.settings.fonts, pageBackground(app), targets().length]);
      }

      function schedule() {
        if (destroyed || raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (destroyed) return;
          const next = signature();
          if (next === sig) return;
          if (root.contains(document.activeElement)) return; // never steal focus mid-edit
          sig = next;
          render();
        });
      }

      /* --------------------------------------------------------- colours */

      function colorRow(token) {
        const doc = store.doc;
        const count = usage(doc, token.id, 'color').length;
        const swatch = h('span', { class: 'apb-token-swatch', 'aria-hidden': 'true' });
        swatch.style.setProperty('--apb-token-color', swatchCSS(token.value, doc));

        const name = widgets.textField({
          value: token.name, ariaLabel: 'Colour name', className: 'apb-token-name',
          onInput: (v, ctx) => { if (ctx && ctx.commit) setColor(app, token.id, { name: v }); }
        });

        const value = widgets.colorField({
          value: token.value, app, allowTokens: false, allowNone: false, ariaLabel: token.name + ' value',
          className: 'apb-token-value',
          onInput: (v) => {
            setColor(app, token.id, { value: v });
            swatch.style.setProperty('--apb-token-color', swatchCSS(v, store.doc));
          }
        });

        const usageBadge = widgets.badge(String(count), {
          kind: count ? 'accent' : 'neutral',
          title: count ? util.plural(count, 'layer') + ' use this colour' : 'Not used yet'
        });
        usageBadge.classList.add('apb-token-usage');

        const applyBtn = widgets.iconButton({
          icon: 'droplet', label: 'Apply as fill', size: 'sm',
          onClick: () => {
            const ids = targets();
            if (!ids.length) { toast('Select a layer first', 'info'); return; }
            applyColor(app, ids, '$' + token.id, 'fill');
            toast('Applied to ' + util.plural(ids.length, 'layer'), 'success');
          }
        });

        const more = widgets.iconButton({
          icon: 'more', label: 'Colour style actions', size: 'sm',
          onClick: (e) => ui.menu(e.currentTarget, [
            { label: 'Apply as fill', icon: 'droplet', disabled: !targets().length, run: () => applyColor(app, targets(), '$' + token.id, 'fill') },
            { label: 'Apply as text colour', icon: 'type', disabled: !targets().length, run: () => applyColor(app, targets(), '$' + token.id, 'color') },
            '-',
            { label: 'Replace everywhere', icon: 'refresh', run: () => {
              const n = replaceEverywhere(app, token.id);
              toast(n ? 'Replaced ' + util.plural(n, 'value') : 'No matching colours found', n ? 'success' : 'info');
            } },
            { label: 'Rename id…', icon: 'text', run: () => renamePrompt(token, 'color') },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, run: () => deleteColor(token, count) }
          ], { label: 'Colour style actions' })
        });

        return h('div', { class: 'apb-token-row', 'data-token': token.id },
          h('div', { class: 'apb-token-lead' }, swatch, name),
          h('div', { class: 'apb-token-tail' }, value, usageBadge, applyBtn, more),
          h('div', { class: 'apb-token-id' }, '$' + token.id));
      }

      function renamePrompt(token, kind) {
        const list = kind === 'text' ? texts(store.doc) : colors(store.doc);
        ui.prompt({
          title: 'Rename token id',
          label: 'Id',
          message: 'References in the document are updated automatically.',
          value: token.id,
          validate: (v) => {
            const s = String(v || '').trim();
            if (!TOKEN_ID_RE.test(s)) return 'Letters, digits, "-" and "_" only.';
            if (s !== token.id && list.some((t) => t.id === s)) return 'That id is already used.';
            return null;
          }
        }).then((v) => {
          if (v == null) return;
          const ok = kind === 'text' ? renameTextStyle(app, token.id, String(v).trim()) : renameColor(app, token.id, String(v).trim());
          if (!ok) toast('Could not rename that token', 'error');
        });
      }

      function deleteColor(token, count) {
        const run = () => { removeColor(app, token.id); };
        if (!count) { run(); return; }
        ui.confirm({
          title: 'Delete "' + token.name + '"?',
          message: util.plural(count, 'layer') + ' use this colour and will keep ' + token.value + ' instead.',
          danger: true
        }).then((ok) => { if (ok) run(); });
      }

      /* ----------------------------------------------------- text styles */

      function textRow(token) {
        const count = usage(store.doc, token.id, 'text').length;
        const preview = h('span', { class: 'apb-token-preview' }, 'Ag');
        const st = token.style || {};
        if (isStr(st.fontFamily)) preview.style.fontFamily = st.fontFamily;
        if (isNum(st.fontSize)) preview.style.fontSize = Math.max(10, Math.min(22, st.fontSize)) + 'px';
        if (st.fontWeight) preview.style.fontWeight = String(st.fontWeight);

        const name = widgets.textField({
          value: token.name, ariaLabel: 'Text style name', className: 'apb-token-name',
          onInput: (v, ctx) => { if (ctx && ctx.commit) setTextStyle(app, token.id, { name: v }); }
        });

        const apply = widgets.button({
          label: 'Apply', size: 'sm', variant: 'subtle', disabled: !targets().length,
          onClick: () => { applyTextStyle(app, targets(), token.id); }
        });

        const more = widgets.iconButton({
          icon: 'more', label: 'Text style actions', size: 'sm',
          onClick: (e) => ui.menu(e.currentTarget, [
            { label: 'Update from selection', icon: 'refresh', disabled: !targets().length, run: () => {
              const id = targets()[0];
              setTextStyle(app, token.id, { style: textStyleFromNode(store.doc, id, store.view.bp) });
              toast('Text style updated', 'success');
            } },
            { label: 'Rename id…', icon: 'text', run: () => renamePrompt(token, 'text') },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, run: () => {
              if (!count) { removeTextStyle(app, token.id); return; }
              ui.confirm({ title: 'Delete "' + token.name + '"?', danger: true,
                message: util.plural(count, 'layer') + ' use it; the declarations are copied onto them.' })
                .then((ok) => { if (ok) removeTextStyle(app, token.id); });
            } }
          ], { label: 'Text style actions' })
        });

        const meta = h('span', { class: 'apb-token-id' }, describeTextStyle(st) + ' · ' + util.plural(count, 'use'));
        return h('div', { class: 'apb-token-row apb-token-row--text', 'data-token': token.id },
          h('div', { class: 'apb-token-lead' }, preview, name),
          h('div', { class: 'apb-token-tail' }, apply, more), meta);
      }

      function describeTextStyle(st) {
        const parts = [];
        if (isNum(st.fontSize)) parts.push(st.fontSize + 'px');
        if (st.fontWeight) parts.push(String(st.fontWeight));
        if (isNum(st.lineHeight)) parts.push('lh ' + st.lineHeight);
        return parts.length ? parts.join(' · ') : 'No declarations';
      }

      /* ---------------------------------------------------------- render */

      function render() {
        const doc = store.doc;
        const colorList = colors(doc);
        const textList = texts(doc);
        const fontList = fonts(doc);
        const selCount = targets().length;

        const addColorBtn = widgets.button({
          label: 'Add', icon: 'plus', size: 'sm', variant: 'subtle',
          onClick: () => {
            const ids = targets();
            const from = ids.length ? (store.node(ids[0]).style || {}).fill : null;
            const id = addColor(app, { name: 'Colour ' + (colorList.length + 1), value: isStr(from) && from.charAt(0) !== '$' ? from : '#2563eb' });
            if (!id) { toast('This document already has the maximum number of colour styles', 'error'); return; }
            sig = '';
            schedule();
            requestAnimationFrame(() => {
              const row = root.querySelector('.apb-token-row[data-token="' + id + '"] input');
              if (row) row.focus();
            });
          }
        });

        const colorsSection = widgets.section({ title: 'Colours', className: 'apb-docstyles-section', actions: addColorBtn },
          colorList.length
            ? h('div', { class: 'apb-token-list' }, colorList.map(colorRow))
            : widgets.emptyState({ title: 'No colour styles', message: 'Add one to reuse a colour across the document.' }));

        const addTextBtn = widgets.button({
          label: 'From selection', icon: 'plus', size: 'sm', variant: 'subtle', disabled: !selCount,
          onClick: () => {
            const id = targets()[0];
            const created = addTextStyle(app, {
              name: 'Text style ' + (textList.length + 1),
              style: textStyleFromNode(store.doc, id, store.view.bp)
            });
            if (created) { sig = ''; schedule(); }
          }
        });

        const textSection = widgets.section({ title: 'Text styles', className: 'apb-docstyles-section', actions: addTextBtn },
          textList.length
            ? h('div', { class: 'apb-token-list' }, textList.map(textRow))
            : widgets.emptyState({ title: 'No text styles', message: 'Select a text layer, then create a style from it.' }));

        const bg = widgets.colorField({
          value: pageBackground(app), app, ariaLabel: 'Page background',
          onInput: (v) => setPageBackground(app, v)
        });
        const pageSection = widgets.section({ title: 'Page', className: 'apb-docstyles-section' },
          widgets.fieldRow({ label: 'Background', control: bg }));

        const familyInput = widgets.textField({ placeholder: 'Family name', ariaLabel: 'Font family' });
        const sourceSelect = widgets.select({
          ariaLabel: 'Font source', value: 'system',
          options: [{ value: 'system', label: 'System / self-hosted' }, { value: 'google', label: 'Google Fonts' }]
        });
        const addFontBtn = widgets.button({
          label: 'Add', icon: 'plus', size: 'sm', variant: 'subtle',
          onClick: () => {
            const family = familyInput.apbControl.value;
            if (!addFont(app, family, sourceSelect.apbControl.value)) { toast('Enter a new font family name', 'info'); return; }
            familyInput.apbControl.value = '';
            sig = '';
            schedule();
          }
        });
        const fontRows = fontList.map((f) => h('div', { class: 'apb-font-row' },
          h('span', { class: 'apb-font-family' }, f.family),
          widgets.badge(f.source === 'google' ? 'Google' : 'System', { kind: 'neutral' }),
          widgets.iconButton({ icon: 'trash', label: 'Remove ' + f.family, size: 'sm', onClick: () => { removeFont(app, f.family); sig = ''; schedule(); } })));

        const fontSection = widgets.section({ title: 'Fonts', className: 'apb-docstyles-section', collapsed: true },
          fontList.length ? h('div', { class: 'apb-font-list' }, fontRows) : null,
          h('div', { class: 'apb-font-add' }, familyInput, sourceSelect, addFontBtn),
          h('p', { class: 'apb-field-hint' }, 'Google families are recorded by name only — nothing is downloaded in the editor.'));

        root.replaceChildren(colorsSection, textSection, pageSection, fontSection);
      }

      offs.push(store.on('change', schedule));
      offs.push(store.on('selection', schedule));
      offs.push(store.on('view', schedule));

      sig = signature();
      render();
      container.appendChild(root);

      return {
        update() { sig = ''; schedule(); },
        refresh() { sig = signature(); render(); },
        el: root,
        destroy() {
          destroyed = true;
          if (raf) cancelAnimationFrame(raf);
          offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
          root.remove();
        }
      };
    }

    return {
      TOKEN_ID_RE, TEXT_STYLE_KEYS, COLOR_STYLE_KEYS, SYSTEM_STACKS,
      colors, texts, fonts, colorToken, textToken, fontOptions, makeId, usage,
      addColor, setColor, renameColor, removeColor, replaceEverywhere, applyColor,
      addTextStyle, setTextStyle, renameTextStyle, removeTextStyle, applyTextStyle, textStyleFromNode,
      addFont, removeFont, pageBackground, setPageBackground, currentPageRoot,
      mount
    };
  });

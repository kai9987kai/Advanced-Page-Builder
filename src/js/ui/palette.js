/*
 * palette — command palette (ARCHITECTURE.md §6.8, §8; PLAN B2).
 *
 * A modal combobox + listbox (aria-activedescendant) that fuzzy-searches
 *   • commands (title, category, formatted shortcut, id; disabled ones are greyed and not runnable),
 *   • "Insert <Element>" entries from the element registry (inserted at the viewport centre),
 *   • "Go to <layer>" entries for the nodes of the current page (select + scroll into view).
 * Recently run commands are listed first. Prefixes narrow the search: `>` commands, `@` layers, `+` insert.
 *
 * Module API: open(app, { query }) → api | null, close(), toggle(app, opts), isOpen, search(app, query) → entries,
 * recent(app) → ids, remember(app, id), PREFIXES, MAX_RECENT, MAX_RESULTS.
 * The plugin in this file registers `view.palette` (Mod+K, Mod+Shift+P) and its menu entries.
 */
APB.define('palette', ['util', 'commands', 'widgets', 'icons', 'dialogs', 'schema'],
  function (util, commands, widgets, icons, dialogs, schema) {
    'use strict';

    const { h } = widgets;
    const MAX_RECENT = 8;
    const MAX_RESULTS = 120;
    const MAX_LAYERS = 5000;
    const PREFIXES = { '>': 'commands', '@': 'layers', '+': 'insert' };
    const PALETTE_COMMAND = 'view.palette';
    const TOGGLE_KEYS = ['Mod+K', 'Mod+Shift+P'];
    const MODE_PLACEHOLDER = {
      all: 'Search commands, layers, or insert…',
      commands: 'Search commands…',
      layers: 'Go to layer…',
      insert: 'Insert an element…'
    };
    const MODE_LABEL = { commands: 'Commands', layers: 'Layers', insert: 'Insert' };

    let current = null; // the open palette

    /* ------------------------------------------------------------------ styles */

    const CSS = `
.apb-dialog.apb-palette { width: min(640px, calc(100vw - 32px)); margin: min(12vh, 96px) auto auto; max-height: min(600px, calc(100vh - 48px)); }
.apb-palette .apb-dialog-header { display: none; }
.apb-palette .apb-dialog-body { padding: 0; gap: 0; overflow: hidden; }
.apb-palette-search { display: flex; align-items: center; gap: var(--apb-space-2); padding: var(--apb-space-2) var(--apb-space-4); border-bottom: 1px solid var(--apb-border); color: var(--apb-text-muted); }
.apb-palette-search:focus-within { box-shadow: inset 0 -2px 0 var(--apb-focus); }
.apb-palette-input { flex: 1 1 auto; min-width: 0; height: 40px; border: 0; outline: none; background: transparent; color: var(--apb-text); font: inherit; font-size: var(--apb-font-size-lg); }
.apb-palette-input::placeholder { color: var(--apb-text-muted); opacity: 1; }
.apb-palette-mode { flex: none; }
.apb-palette-list { overflow: auto; overscroll-behavior: contain; max-height: min(420px, calc(100vh - 220px)); padding: var(--apb-space-1) var(--apb-space-2) var(--apb-space-2); }
.apb-palette-group-label { padding: var(--apb-space-2) var(--apb-space-2) var(--apb-space-1); font-size: var(--apb-font-size-xs); font-weight: var(--apb-weight-semibold); color: var(--apb-text-muted); letter-spacing: 0.02em; }
.apb-palette-item { display: flex; align-items: center; gap: var(--apb-space-2); min-height: 34px; padding: 0 var(--apb-space-2); border-radius: var(--apb-radius-2); color: var(--apb-text); cursor: pointer; user-select: none; }
.apb-palette-item[aria-selected="true"] { background: var(--apb-active); box-shadow: inset 2px 0 0 var(--apb-accent); }
.apb-palette-item[aria-disabled="true"] { color: var(--apb-text-subtle); cursor: default; }
.apb-palette-item[aria-disabled="true"] .apb-palette-icon, .apb-palette-item[aria-disabled="true"] .apb-kbd { opacity: 0.6; }
.apb-palette-icon { flex: none; display: inline-flex; color: var(--apb-text-muted); }
.apb-palette-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apb-palette-label mark { background: transparent; color: inherit; font-weight: var(--apb-weight-semibold); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.apb-palette-meta { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--apb-font-size-sm); color: var(--apb-text-muted); }
.apb-palette-empty { padding: var(--apb-space-5) var(--apb-space-4); text-align: center; color: var(--apb-text-muted); }
.apb-palette-footer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--apb-space-1) var(--apb-space-3); padding: var(--apb-space-2) var(--apb-space-4); border-top: 1px solid var(--apb-border); background: var(--apb-surface-2); font-size: var(--apb-font-size-xs); color: var(--apb-text-muted); }
.apb-palette-footer span { display: inline-flex; align-items: center; gap: var(--apb-space-1); }
@media (max-width: 600px) { .apb-dialog.apb-palette { margin-top: var(--apb-space-4); } .apb-palette-footer { display: none; } }
@media (forced-colors: active) {
  .apb-palette-item[aria-selected="true"] { outline: 2px solid Highlight; outline-offset: -2px; box-shadow: none; }
  .apb-palette-item[aria-disabled="true"] { color: GrayText; }
}`;

    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('apb-palette-style')) return;
      const style = document.createElement('style');
      style.id = 'apb-palette-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ----------------------------------------------------------------- recents */

    function recent(app) {
      const list = app && app.store && app.store.prefs && app.store.prefs.recentCommands;
      return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, MAX_RECENT) : [];
    }

    function remember(app, id) {
      if (!app || !app.store || typeof id !== 'string' || id === PALETTE_COMMAND) return;
      const next = [id].concat(recent(app).filter((x) => x !== id)).slice(0, MAX_RECENT);
      app.store.setPrefs({ recentCommands: next });
    }

    /* ----------------------------------------------------------------- entries */

    function parseQuery(raw) {
      const text = String(raw == null ? '' : raw);
      const trimmed = text.replace(/^\s+/, '');
      const first = trimmed.charAt(0);
      if (PREFIXES[first]) return { mode: PREFIXES[first], q: trimmed.slice(1).trim() };
      return { mode: 'all', q: text.trim() };
    }

    function iconName(name, fallback) {
      return name && icons.has(name) ? name : fallback;
    }

    function commandEntries(app) {
      const out = [];
      const rec = recent(app);
      commands.list().forEach((def, i) => {
        if (!def || def.palette === false || def.id === PALETTE_COMMAND) return;
        const keys = Array.isArray(def.keys) ? def.keys : [];
        const title = String(def.title || def.id);
        out.push({
          kind: 'command', id: def.id, title, meta: def.category || 'General',
          icon: iconName(def.icon, 'command'), keys, keysText: keys.length ? commands.formatKeys(keys) : '',
          disabled: !commands.enabled(def.id), recentRank: rec.indexOf(def.id), order: i
        });
      });
      return out;
    }

    function insertEntries(app) {
      const elements = app && app.elements;
      if (!elements || typeof elements.list !== 'function') return [];
      const canInsert = !!(app.canvas && typeof app.canvas.insertAtViewportCenter === 'function');
      return elements.list({ insertable: true }).map((def, i) => ({
        kind: 'insert', id: 'insert:' + def.type, type: def.type, title: 'Insert ' + (def.label || def.type), meta: 'Insert',
        icon: iconName(def.icon, 'insert'), keys: [], keysText: '', disabled: !canInsert, recentRank: -1, order: 1000 + i
      }));
    }

    function layerEntries(app) {
      const store = app && app.store;
      if (!store) return [];
      const doc = store.doc;
      const page = (doc.pages || []).find((p) => p.id === store.view.pageId) || (doc.pages || [])[0];
      if (!page || !page.root) return [];
      const out = [];
      schema.walk(doc, page.root, (node) => {
        if (out.length >= MAX_LAYERS) return false;
        if (node.id === page.root) return undefined;
        const def = app.elements ? app.elements.get(node.type) : null;
        const label = (def && def.label) || node.type;
        const name = String(node.name || label);
        out.push({
          kind: 'layer', id: 'layer:' + node.id, nodeId: node.id, name, title: 'Go to ' + name, meta: label,
          icon: iconName(def && def.icon, 'layers'), keys: [], keysText: '', disabled: false, recentRank: -1, order: 2000 + out.length
        });
        return undefined;
      });
      return out;
    }

    function scoreEntry(entry, q, mode) {
      const f = util.fuzzyScore;
      let score = f(q, entry.title);
      const bonus = (s, add) => (s > 0 ? s + add : 0);
      if (entry.kind === 'layer') score = Math.max(score, bonus(f(q, entry.name), 2), f(q, entry.meta) * 0.5);
      else if (entry.kind === 'insert') score = Math.max(score, bonus(f(q, entry.title.slice(7)), 1));
      else {
        score = Math.max(score, f(q, entry.meta + ' ' + entry.title) * 0.85, f(q, entry.id) * 0.6);
        if (entry.keysText) score = Math.max(score, f(q, entry.keysText) * 0.75);
      }
      // Drop scattered subsequence matches: require roughly 1.5 points per typed character.
      if (score <= 0 || score < q.replace(/\s+/g, '').length * 1.5) return 0;
      if (entry.recentRank >= 0) score += 6 - entry.recentRank * 0.5;
      if (entry.disabled) score *= 0.85;
      if (mode === 'all' && entry.kind === 'layer') score *= 0.9;
      return score;
    }

    /**
     * search(app, query) → ranked entries { kind: 'command'|'insert'|'layer', id, title, meta, icon, keys, keysText, disabled,
     * score, group, positions }. An empty query lists recent commands, then enabled commands, disabled ones, and inserts.
     */
    function search(app, rawQuery) {
      const { mode, q } = parseQuery(rawQuery);
      let pool = [];
      if (mode === 'all' || mode === 'commands') pool = pool.concat(commandEntries(app));
      if (mode === 'all' || mode === 'insert') pool = pool.concat(insertEntries(app));
      if (mode === 'layers' || (mode === 'all' && q)) pool = pool.concat(layerEntries(app));

      if (!q) {
        const rec = pool.filter((e) => e.recentRank >= 0).sort((a, b) => a.recentRank - b.recentRank);
        const rest = pool.filter((e) => e.recentRank < 0);
        const cmds = rest.filter((e) => e.kind === 'command').sort((a, b) => (a.disabled - b.disabled) || (a.order - b.order));
        rec.forEach((e) => { e.group = 'Recently used'; e.score = 1; });
        cmds.forEach((e) => { e.group = 'Commands'; e.score = 1; });
        const inserts = rest.filter((e) => e.kind === 'insert');
        inserts.forEach((e) => { e.group = 'Insert'; e.score = 1; });
        const layers = rest.filter((e) => e.kind === 'layer');
        layers.forEach((e) => { e.group = 'Layers'; e.score = 1; });
        return rec.concat(cmds, inserts, layers).slice(0, mode === 'layers' ? MAX_RESULTS * 4 : MAX_RESULTS * 2);
      }

      const out = [];
      for (const e of pool) {
        const s = scoreEntry(e, q, mode);
        if (s > 0) {
          e.score = s;
          const m = util.fuzzyMatch(q, e.title);
          e.positions = m ? m.positions : [];
          out.push(e);
        }
      }
      out.sort((a, b) => (b.score - a.score) || (a.order - b.order));
      return out.slice(0, MAX_RESULTS);
    }

    /* ---------------------------------------------------------------------- UI */

    function highlight(text, positions) {
      if (!positions || !positions.length) return [text];
      const set = new Set(positions);
      const parts = [];
      let buf = '';
      let marked = false;
      for (let i = 0; i < text.length; i++) {
        const m = set.has(i);
        if (m !== marked && buf) { parts.push(marked ? h('mark', null, buf) : buf); buf = ''; }
        marked = m;
        buf += text[i];
      }
      if (buf) parts.push(marked ? h('mark', null, buf) : buf);
      return parts;
    }

    function announce(app, message) {
      if (app && app.ui && typeof app.ui.announce === 'function') app.ui.announce(message);
      else dialogs.announce(message);
    }

    function close() {
      if (current) current.close();
    }

    function toggle(app, opts) {
      if (current) { close(); return null; }
      return open(app, opts);
    }

    /** open(app, { query }) — opens (or refocuses) the palette. */
    function open(app, opts) {
      const o = opts || {};
      if (current) {
        if (o.query != null) current.setQuery(String(o.query));
        current.focus();
        return current;
      }
      if (typeof document === 'undefined') return null;
      ensureStyles();

      const listId = widgets.uid('apb-palette-list');
      const input = h('input', {
        type: 'text', class: 'apb-palette-input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId,
        'aria-autocomplete': 'list', 'aria-haspopup': 'listbox', 'aria-label': 'Search commands', autocomplete: 'off',
        spellcheck: 'false', placeholder: MODE_PLACEHOLDER.all
      });
      const modeBadge = h('span', { class: 'apb-badge apb-badge--accent apb-palette-mode', hidden: true });
      const list = h('div', { class: 'apb-palette-list', id: listId, role: 'listbox', 'aria-label': 'Results' });
      const status = h('div', { class: 'apb-sr-only', role: 'status', 'aria-live': 'polite' });
      const hint = (keys, text) => h('span', null, widgets.kbd(keys), text);
      const footer = h('div', { class: 'apb-palette-footer', 'aria-hidden': 'true' },
        hint(['ArrowUp', 'ArrowDown'], 'Navigate'), hint('Enter', 'Run'), hint('Escape', 'Close'),
        h('span', null, '> commands · @ layers · + insert'));
      const searchRow = h('div', { class: 'apb-palette-search' }, icons.get('search', { size: 18 }), input, modeBadge);

      let results = [];
      let optionEls = [];
      let active = -1;
      let statusTimer = 0;

      const dlg = dialogs.dialog({
        label: 'Command palette',
        className: 'apb-palette',
        content: [searchRow, list, status, footer],
        initialFocus: input,
        onClose() {
          clearTimeout(statusTimer);
          if (current === api) current = null;
        }
      });

      function setActive(i, scroll) {
        if (active >= 0 && optionEls[active]) optionEls[active].setAttribute('aria-selected', 'false');
        active = results.length ? Math.max(0, Math.min(results.length - 1, i)) : -1;
        const el = active >= 0 ? optionEls[active] : null;
        if (el) {
          el.setAttribute('aria-selected', 'true');
          input.setAttribute('aria-activedescendant', el.id);
          if (scroll !== false && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
        } else {
          input.removeAttribute('aria-activedescendant');
        }
      }

      function optionFor(entry, index) {
        const el = h('div', {
          id: listId + '-' + index, role: 'option', class: ['apb-palette-item', 'apb-palette-item--' + entry.kind],
          'aria-selected': 'false', 'aria-disabled': entry.disabled ? 'true' : null,
          dataset: { kind: entry.kind, id: entry.id }
        },
        h('span', { class: 'apb-palette-icon', 'aria-hidden': 'true' }, icons.get(entry.icon, { size: 16 })),
        h('span', { class: 'apb-palette-label' }, highlight(entry.title, entry.positions)),
        entry.meta && entry.kind !== 'insert' ? h('span', { class: 'apb-palette-meta' }, entry.meta) : null,
        entry.keys && entry.keys.length ? widgets.kbd(entry.keys[0]) : null);
        return el;
      }

      function render() {
        const { mode, q } = parseQuery(input.value);
        input.placeholder = MODE_PLACEHOLDER[mode];
        modeBadge.hidden = mode === 'all';
        modeBadge.textContent = MODE_LABEL[mode] || '';
        results = search(app, input.value);
        optionEls = [];
        list.textContent = '';
        const frag = document.createDocumentFragment();
        let groupEl = null;
        let groupName = null;
        results.forEach((entry, i) => {
          const el = optionFor(entry, i);
          optionEls.push(el);
          if (!q && entry.group) {
            if (entry.group !== groupName) {
              groupName = entry.group;
              const labelId = listId + '-g' + i;
              groupEl = h('div', { role: 'group', class: 'apb-palette-group', 'aria-labelledby': labelId },
                h('div', { class: 'apb-palette-group-label', id: labelId, role: 'presentation' }, groupName));
              frag.appendChild(groupEl);
            }
            groupEl.appendChild(el);
          } else {
            frag.appendChild(el);
          }
        });
        if (!results.length) {
          frag.appendChild(h('div', { class: 'apb-palette-empty', role: 'presentation' },
            q ? 'No results for “' + q + '”' : 'Nothing to show'));
        }
        list.appendChild(frag);
        list.scrollTop = 0;
        active = -1;
        const firstEnabled = results.findIndex((e) => !e.disabled);
        setActive(firstEnabled >= 0 ? firstEnabled : 0, false);
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
          status.textContent = results.length ? util.plural(results.length, 'result') + ' available' : 'No results';
        }, 250);
      }

      function activate(index) {
        const entry = results[index];
        if (!entry) return;
        if (entry.disabled) {
          announce(app, entry.title + ' is not available right now');
          return;
        }
        dlg.close();
        try {
          if (entry.kind === 'command') {
            remember(app, entry.id);
            commands.run(entry.id, { source: 'palette' });
          } else if (entry.kind === 'insert') {
            const ids = app.canvas.insertAtViewportCenter({ type: entry.type });
            if (ids && ids.length) announce(app, entry.title.replace(/^Insert /, '') + ' inserted');
          } else if (entry.kind === 'layer') {
            const id = entry.nodeId;
            if (!app.store.node(id)) return;
            app.store.select([id]);
            const vp = app.canvas && app.canvas.viewport;
            if (vp && typeof vp.scrollToNode === 'function') vp.scrollToNode(id);
            announce(app, entry.name + ' selected');
          }
        } catch (err) {
          console.error('[APB] palette action failed:', err);
          if (typeof app.notifyError === 'function') app.notifyError('Could not run “' + entry.title + '”');
        }
      }

      input.addEventListener('input', render);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (TOGGLE_KEYS.some((k) => commands.matchKey(e, k))) {
          e.preventDefault();
          dlg.close();
          return;
        }
        const page = 8;
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            if (results.length) setActive(active >= results.length - 1 ? 0 : active + 1);
            break;
          case 'ArrowUp':
            e.preventDefault();
            if (results.length) setActive(active <= 0 ? results.length - 1 : active - 1);
            break;
          case 'PageDown':
            e.preventDefault();
            setActive(active + page);
            break;
          case 'PageUp':
            e.preventDefault();
            setActive(active - page);
            break;
          case 'Home':
          case 'End':
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              setActive(e.key === 'Home' ? 0 : results.length - 1);
            }
            break;
          case 'Enter':
            e.preventDefault();
            activate(active);
            break;
          case 'Tab':
            e.preventDefault();
            break;
          default:
        }
      });
      list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
      list.addEventListener('pointermove', (e) => {
        const opt = e.target.closest && e.target.closest('[role="option"]');
        if (!opt) return;
        const i = optionEls.indexOf(opt);
        if (i >= 0 && i !== active) setActive(i, false);
      });
      list.addEventListener('click', (e) => {
        const opt = e.target.closest && e.target.closest('[role="option"]');
        if (!opt) return;
        const i = optionEls.indexOf(opt);
        if (i >= 0) activate(i);
      });

      const api = {
        el: dlg.el,
        input,
        list,
        get results() { return results.slice(); },
        get active() { return active; },
        closed: dlg.closed,
        close: () => dlg.close(),
        focus() { try { input.focus(); input.select(); } catch (_) { /* ignore */ } },
        setQuery(text) { input.value = text; render(); },
        run: (index) => activate(index == null ? active : index)
      };
      current = api;
      if (o.query != null) input.value = String(o.query);
      render();
      return api;
    }

    return {
      open, close, toggle, search, recent, remember, parseQuery,
      get isOpen() { return !!current; },
      get current() { return current; },
      PREFIXES, MAX_RECENT, MAX_RESULTS
    };
  });

APB.plugin({
  id: 'palette',
  requires: ['palette', 'dialogs', 'widgets'],
  order: 20,
  init(app) {
    'use strict';
    const palette = APB.require('palette');
    const commands = app.commands;
    if (!commands.get('view.palette')) {
      commands.register({
        id: 'view.palette', title: 'Command palette…', category: 'View', icon: 'command',
        keys: ['Mod+K', 'Mod+Shift+P'], allowInInputs: true, palette: false,
        run: (a, args) => palette.open(a, { query: args && typeof args.query === 'string' ? args.query : undefined })
      });
    }
    const ui = app.ui;
    if (ui && typeof ui.registerMenuItem === 'function') {
      ui.registerMenuItem({ menu: 'view', command: 'view.palette', order: 1 });
      ui.registerMenuItem({ menu: 'help', command: 'view.palette', order: 2 });
    }
  }
});

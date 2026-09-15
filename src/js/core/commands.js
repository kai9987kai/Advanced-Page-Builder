/* @node-testable */
/*
 * commands — command registry + keymap + keydown dispatcher. See ARCHITECTURE.md §6.8.
 *
 * Key syntax: modifiers Mod (Cmd on mac, Ctrl elsewhere), Ctrl, Alt, Shift, Meta/Cmd, then a key:
 * A–Z, 0–9, F1–F12, ArrowUp/Down/Left/Right, Delete, Backspace, Enter, Escape, Tab, Space, Home,
 * End, PageUp, PageDown, [ ] = - / ? \ ' , . ; `. Letters, digits and punctuation match via
 * event.code (layout/CapsLock independent) with event.key as a fallback for punctuation.
 */
APB.define('commands', ['env', 'events'], function (env, events) {
  'use strict';

  const NAMED_KEYS = {
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    delete: 'Delete', del: 'Delete', backspace: 'Backspace', enter: 'Enter', return: 'Enter',
    escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space', home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert'
  };

  const PUNCT_CODES = {
    '[': 'BracketLeft', ']': 'BracketRight', '=': 'Equal', '-': 'Minus', '/': 'Slash', '\\': 'Backslash',
    "'": 'Quote', ',': 'Comma', '.': 'Period', ';': 'Semicolon', '`': 'Backquote', '+': 'Equal', '?': 'Slash'
  };
  /** Keys that are typed with Shift on common layouts: the Shift state is not compared. */
  const SHIFTED_CHARS = new Set(['?', '+']);

  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super', 'Fn']);

  const MAC_SYMBOLS = { mod: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
  const KEY_LABELS = {
    ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
    Delete: ['⌦', 'Del'], Backspace: ['⌫', 'Backspace'], Enter: ['↩', 'Enter'], Escape: ['Esc', 'Esc'],
    Tab: ['⇥', 'Tab'], Space: ['Space', 'Space'], PageUp: ['PgUp', 'PgUp'], PageDown: ['PgDn', 'PgDn'],
    Home: ['Home', 'Home'], End: ['End', 'End']
  };

  const parseCache = new Map();

  /** parseKey('Mod+Shift+G') → { mods: ['mod','shift'], mod, ctrl, meta, alt, shift, key: 'G' } */
  function parseKey(combo) {
    const src = String(combo || '').trim();
    if (parseCache.has(src)) return parseCache.get(src);
    let parts;
    if (src.endsWith('++')) parts = src.slice(0, -2).split('+').filter(Boolean).concat('+');
    else if (src === '+') parts = ['+'];
    else parts = src.split('+');
    const out = { mods: [], mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
    for (const raw of parts.slice(0, -1)) {
      const p = raw.trim();
      const lower = p.toLowerCase();
      let flag;
      if (lower === 'mod') flag = 'mod';
      else if (lower === 'ctrl' || lower === 'control') flag = 'ctrl';
      else if (lower === 'alt' || lower === 'option') flag = 'alt';
      else if (lower === 'shift') flag = 'shift';
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command') flag = 'meta';
      else throw new Error('commands: unknown modifier "' + p + '" in "' + src + '"');
      if (!out[flag]) { out[flag] = true; out.mods.push(flag); }
    }
    const p = (parts[parts.length - 1] || '').trim();
    const lower = p.toLowerCase();
    if (NAMED_KEYS[lower]) out.key = NAMED_KEYS[lower];
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) out.key = p.toUpperCase();
    else if (p.length === 1) out.key = /[a-z]/i.test(p) ? p.toUpperCase() : p;
    if (!out.key) throw new Error('commands: unknown or missing key in "' + src + '"');
    parseCache.set(src, out);
    return out;
  }

  /** Resolve Mod for a platform → required modifier state. */
  function requiredMods(parsed, mac) {
    return {
      ctrl: parsed.ctrl || (parsed.mod && !mac),
      meta: parsed.meta || (parsed.mod && mac),
      alt: parsed.alt,
      shift: parsed.shift
    };
  }

  function keyMatches(e, key) {
    const code = e.code || '';
    const k = e.key;
    if (/^[A-Z]$/.test(key)) {
      if (code) return code === 'Key' + key;
      return typeof k === 'string' && k.toUpperCase() === key;
    }
    if (/^[0-9]$/.test(key)) {
      if (code) return code === 'Digit' + key || code === 'Numpad' + key;
      return k === key;
    }
    if (key === 'Space') return code === 'Space' || k === ' ' || k === 'Spacebar';
    if (key === 'Enter') return k === 'Enter' || code === 'Enter' || code === 'NumpadEnter';
    if (key === 'Escape') return k === 'Escape' || k === 'Esc';
    if (key === '?') return k === '?' || (code === 'Slash' && !!e.shiftKey);
    if (key === '+') return k === '+' || code === 'NumpadAdd' || (code === 'Equal' && !!e.shiftKey);
    if (key === '-' && code === 'NumpadSubtract') return true;
    if (PUNCT_CODES[key]) return code === PUNCT_CODES[key] || k === key;
    return k === key;
  }

  /** matchKey(event, 'Mod+Z', { mac }) → boolean */
  function matchKey(e, combo, opts) {
    if (!e) return false;
    let parsed;
    try { parsed = typeof combo === 'string' ? parseKey(combo) : combo; } catch (_) { return false; }
    const mac = opts && typeof opts.mac === 'boolean' ? opts.mac : env.mac;
    const need = requiredMods(parsed, mac);
    if (!!e.ctrlKey !== need.ctrl || !!e.metaKey !== need.meta || !!e.altKey !== need.alt) return false;
    if (!SHIFTED_CHARS.has(parsed.key) && !!e.shiftKey !== need.shift) return false;
    return keyMatches(e, parsed.key);
  }

  /** formatKeys('Mod+Shift+G') → '⌘⇧G' (mac) | 'Ctrl+Shift+G'. Arrays are joined with ' / '. */
  function formatKeys(keys, opts) {
    if (Array.isArray(keys)) return keys.map((k) => formatKeys(k, opts)).filter(Boolean).join(' / ');
    if (!keys) return '';
    let parsed;
    try { parsed = parseKey(keys); } catch (_) { return String(keys); }
    const mac = opts && typeof opts.mac === 'boolean' ? opts.mac : env.mac;
    const label = KEY_LABELS[parsed.key] ? KEY_LABELS[parsed.key][mac ? 0 : 1] : parsed.key;
    if (mac) return parsed.mods.map((m) => MAC_SYMBOLS[m]).join('') + label;
    const names = parsed.mods.map((m) => ({ mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' })[m]);
    return names.concat(label).join('+');
  }

  /* -------------------------------------------------------------- guards */

  const TEXTLESS_INPUTS = new Set(['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color']);

  function isEditableTarget(target) {
    let el = target;
    if (!el) return false;
    if (el.nodeType === 3) el = el.parentElement || el.parentNode;
    if (!el || typeof el !== 'object') return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || el.localName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = String((el.type || (el.getAttribute && el.getAttribute('type')) || 'text')).toLowerCase();
      // Range sliders keep their arrow keys; checkboxes/radios keep Space.
      return !TEXTLESS_INPUTS.has(type) || type === 'checkbox' || type === 'radio';
    }
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (role && /^(textbox|searchbox|combobox|spinbutton|slider)$/.test(role)) return true;
    if (el.closest && el.closest('[data-apb-keys="local"]')) return true;
    return false;
  }

  function defaultDialogOpen() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.querySelector !== 'function') return false;
    try {
      if (doc.querySelector('dialog:modal')) return true;
    } catch (_) {
      if (doc.querySelector('dialog[open]')) return true;
    }
    const modal = doc.querySelector('[aria-modal="true"]');
    return !!(modal && !modal.hidden && modal.getClientRects && modal.getClientRects().length);
  }

  /* ------------------------------------------------------------ registry */

  function createRegistry() {
    const defs = new Map();
    const emitter = new events.Emitter();
    let app = null;
    let dialogCheck = defaultDialogOpen;
    const attached = new Map(); // target -> listener

    function register(def) {
      if (!def || typeof def.id !== 'string' || !def.id) throw new TypeError('commands.register: id is required');
      if (typeof def.run !== 'function') throw new TypeError('commands.register(' + def.id + '): run must be a function');
      const keys = Array.isArray(def.keys) ? def.keys.slice() : def.keys ? [def.keys] : [];
      keys.forEach(parseKey); // validate early
      const full = Object.assign({
        title: def.id, category: 'General', icon: null, when: null, palette: true,
        allowInInputs: false, allowInDialog: false, repeat: true
      }, def, { keys });
      const replaced = defs.has(def.id);
      defs.set(def.id, full);
      emitter.emit('change', { id: def.id, replaced });
      return () => unregister(def.id);
    }

    function unregister(id) {
      if (!defs.delete(id)) return false;
      emitter.emit('change', { id, removed: true });
      return true;
    }

    function get(id) { return defs.get(id) || null; }
    function list() { return Array.from(defs.values()); }

    function enabled(id, args) {
      const def = defs.get(id);
      if (!def) return false;
      if (typeof def.when !== 'function') return true;
      try { return !!def.when(app, args); } catch (err) {
        if (typeof console !== 'undefined') console.error('[APB] when() of command "' + id + '" threw:', err);
        return false;
      }
    }

    function report(id, err) {
      if (typeof console !== 'undefined') console.error('[APB] command "' + id + '" failed:', err);
      emitter.emit('error', { id, error: err });
    }

    function run(id, args) {
      const def = defs.get(id);
      if (!def) {
        if (typeof console !== 'undefined') console.warn('[APB] unknown command "' + id + '"');
        return undefined;
      }
      if (!enabled(id, args)) return undefined;
      let result;
      try {
        result = def.run(app, args);
      } catch (err) {
        report(id, err);
        return undefined;
      }
      if (result && typeof result.then === 'function') result.then(null, (err) => report(id, err));
      emitter.emit('run', { id, args, result });
      return result;
    }

    function keysFor(id) {
      const def = defs.get(id);
      return def ? def.keys.slice() : [];
    }

    function setKeys(id, keys) {
      const def = defs.get(id);
      if (!def) return false;
      const list = Array.isArray(keys) ? keys.slice() : keys ? [keys] : [];
      list.forEach(parseKey);
      def.keys = list;
      emitter.emit('change', { id, keys: list });
      return true;
    }

    /** Find commands bound to a key event (ignores guards and `when`). */
    function commandsForEvent(e, opts) {
      const out = [];
      for (const def of defs.values()) {
        if (def.keys.some((k) => matchKey(e, k, opts))) out.push(def);
      }
      return out;
    }

    /** Dispatch a keydown event. Returns the id of the command that ran, or null. */
    function handleKeydown(e, opts) {
      if (!e || e.defaultPrevented || e.isComposing || e.keyCode === 229) return null;
      if (MODIFIER_KEYS.has(e.key)) return null;
      const candidates = commandsForEvent(e, opts);
      if (!candidates.length) return null;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      const target = path && path.length ? path[0] : e.target;
      const editable = isEditableTarget(target);
      let dialogOpen = false;
      try { dialogOpen = !!dialogCheck(e); } catch (_) { dialogOpen = false; }
      for (const def of candidates) {
        if (editable && !def.allowInInputs) continue;
        if (dialogOpen && !def.allowInDialog) continue;
        if (e.repeat && def.repeat === false) continue;
        if (!enabled(def.id)) continue;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        run(def.id, { event: e, source: 'keyboard' });
        return def.id;
      }
      return null;
    }

    function attach(target) {
      const t = target || (typeof document !== 'undefined' ? document : null);
      if (!t || typeof t.addEventListener !== 'function') return () => {};
      if (attached.has(t)) return attached.get(t).detach;
      const listener = (e) => handleKeydown(e);
      t.addEventListener('keydown', listener);
      const detach = () => {
        t.removeEventListener('keydown', listener);
        attached.delete(t);
      };
      attached.set(t, { listener, detach });
      return detach;
    }

    function detachAll() {
      Array.from(attached.values()).forEach((a) => a.detach());
    }

    return {
      register, unregister, run, get, list, enabled, keysFor, setKeys,
      formatKeys, parseKey, matchKey, isEditableTarget,
      attach, detachAll, handleKeydown, commandsForEvent,
      setApp(a) { app = a; },
      getApp() { return app; },
      setDialogCheck(fn) { dialogCheck = typeof fn === 'function' ? fn : defaultDialogOpen; },
      on: (evt, fn) => emitter.on(evt, fn),
      off: (evt, fn) => emitter.off(evt, fn),
      createRegistry
    };
  }

  return createRegistry();
});

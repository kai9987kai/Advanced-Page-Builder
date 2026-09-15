/* @node-testable */
/*
 * util — ids, math, cloning, paths, escaping, timing helpers. Pure; safe in Node.
 * See ARCHITECTURE.md §6.1.
 */
APB.define('util', [], function () {
  'use strict';

  const g = globalThis;
  const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

  /* ------------------------------------------------------------------ ids */

  function randomChars(n) {
    let out = '';
    const cryptoObj = g.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const bytes = new Uint8Array(n);
      cryptoObj.getRandomValues(bytes);
      for (let i = 0; i < n; i++) out += ID_CHARS[bytes[i] % 36];
    } else {
      for (let i = 0; i < n; i++) out += ID_CHARS[Math.floor(Math.random() * 36)];
    }
    return out;
  }

  /**
   * uid('n') → 'n_ab12cd34'. `existing` (object map, Set, Map or array) avoids collisions.
   */
  function uid(prefix, existing) {
    const head = prefix ? (String(prefix).endsWith('_') ? String(prefix) : prefix + '_') : '';
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = head + randomChars(8);
      if (!existing || !containsKey(existing, id)) return id;
    }
    return head + randomChars(12);
  }

  function containsKey(coll, key) {
    if (coll instanceof Set || coll instanceof Map) return coll.has(key);
    if (Array.isArray(coll)) return coll.includes(key);
    if (coll && typeof coll === 'object') return Object.prototype.hasOwnProperty.call(coll, key);
    return false;
  }

  /* ----------------------------------------------------------------- math */

  function clamp(v, min, max) {
    if (min > max) { const t = min; min = max; max = t; }
    return v < min ? min : v > max ? max : v;
  }

  function decimalsOf(step) {
    const s = String(step);
    if (s.includes('e-')) return parseInt(s.split('e-')[1], 10) || 0;
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  function round(v, step = 1) {
    if (!(step > 0) || !Number.isFinite(v)) return v;
    const r = Math.round(v / step) * step;
    const out = Number(r.toFixed(Math.min(20, decimalsOf(step))));
    return Object.is(out, -0) ? 0 : out;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /* -------------------------------------------------------------- objects */

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    // Objects created in another realm (vm context, iframe) have a different Object.prototype.
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function deepClone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(deepClone);
    if (isPlainObject(v)) {
      const out = {};
      for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
      return out;
    }
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof Map) return new Map(Array.from(v, ([k, x]) => [k, deepClone(x)]));
    if (v instanceof Set) return new Set(Array.from(v, deepClone));
    if (ArrayBuffer.isView(v)) return v.slice ? v.slice() : new v.constructor(v);
    if (typeof g.structuredClone === 'function') {
      try { return g.structuredClone(v); } catch (_) { /* fall through */ }
    }
    return v;
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
      for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
      return true;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  /**
   * Merge b over a. Plain-object values merge one level deep; arrays and primitives are
   * replaced; `undefined` values in b are ignored. Returns a new object (inputs untouched).
   */
  function deepMerge(a, b) {
    const out = isPlainObject(a) ? Object.assign({}, a) : {};
    if (!isPlainObject(b)) return out;
    for (const k of Object.keys(b)) {
      const bv = b[k];
      if (bv === undefined) continue;
      const av = out[k];
      if (isPlainObject(av) && isPlainObject(bv)) {
        const merged = Object.assign({}, av);
        for (const kk of Object.keys(bv)) if (bv[kk] !== undefined) merged[kk] = bv[kk];
        out[k] = merged;
      } else {
        out[k] = bv;
      }
    }
    return out;
  }

  /** 'a.b.0' | ['a','b',0] → array of keys. */
  function parsePath(path) {
    if (Array.isArray(path)) return path.slice();
    if (path === undefined || path === null || path === '') return [];
    if (typeof path === 'number') return [path];
    return String(path).split('.');
  }

  function getPath(obj, path) {
    const keys = parsePath(path);
    let cur = obj;
    for (const k of keys) {
      if (cur === null || cur === undefined) return undefined;
      if (typeof cur !== 'object' && typeof cur !== 'function') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
      cur = cur[k];
    }
    return cur;
  }

  const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  /**
   * Copy-on-write set. Only objects along the path are shallow-copied; untouched branches keep
   * their identity. `undefined` deletes the key (array items are spliced out). Returns the
   * original object when nothing changes.
   */
  function setPathImmutable(obj, path, value) {
    const keys = parsePath(path);
    if (!keys.length) return value;
    for (const k of keys) {
      if (UNSAFE_KEYS.has(String(k))) throw new Error('setPathImmutable: unsafe path segment "' + k + '"');
    }
    return setIn(obj, keys, 0, value);
  }

  function setIn(cur, keys, i, value) {
    const k = keys[i];
    const last = i === keys.length - 1;
    const isArr = Array.isArray(cur);
    const container = cur !== null && typeof cur === 'object' ? cur : null;
    const exists = container !== null && Object.prototype.hasOwnProperty.call(container, k);
    if (last) {
      if (value === undefined) {
        if (!exists) return cur;
        if (isArr) {
          const copy = cur.slice();
          copy.splice(Number(k), 1);
          return copy;
        }
        const copy = Object.assign({}, cur);
        delete copy[k];
        return copy;
      }
      if (exists && container[k] === value) return cur;
      const copy = isArr ? cur.slice() : Object.assign({}, container || {});
      copy[k] = value;
      return copy;
    }
    const child = exists ? container[k] : undefined;
    if (value === undefined && (child === null || child === undefined || typeof child !== 'object')) return cur;
    const nextChild = setIn(child !== null && typeof child === 'object' ? child : {}, keys, i + 1, value);
    if (exists && nextChild === child) return cur;
    const copy = isArr ? cur.slice() : Object.assign({}, container || {});
    copy[k] = nextChild;
    return copy;
  }

  function pick(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  function omit(obj, keys) {
    const out = Object.assign({}, obj || {});
    for (const k of keys) delete out[k];
    return out;
  }

  function groupBy(arr, keyOrFn) {
    const fn = typeof keyOrFn === 'function' ? keyOrFn : (x) => (x == null ? undefined : x[keyOrFn]);
    const out = {};
    (arr || []).forEach((item, i) => {
      const key = fn(item, i);
      (out[key] || (out[key] = [])).push(item);
    });
    return out;
  }

  function uniq(arr) {
    return Array.from(new Set(arr || []));
  }

  /* --------------------------------------------------------------- timing */

  function debounce(fn, ms) {
    let timer = null;
    let lastArgs = null;
    let lastThis = null;
    function debounced(...args) {
      lastArgs = args;
      lastThis = this;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, ms);
    }
    function run() {
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      return fn.apply(lastThis, args || []);
    }
    debounced.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; lastArgs = null; };
    debounced.flush = () => {
      if (timer === null) return undefined;
      clearTimeout(timer);
      return run();
    };
    debounced.pending = () => timer !== null;
    return debounced;
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let lastArgs = null;
    let lastThis = null;
    const now = () => (g.performance && g.performance.now ? g.performance.now() : Date.now());
    function invoke() {
      last = now();
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      fn.apply(lastThis, args || []);
    }
    function throttled(...args) {
      lastArgs = args;
      lastThis = this;
      const remaining = ms - (now() - last);
      if (remaining <= 0 || remaining > ms) {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        invoke();
      } else if (timer === null) {
        timer = setTimeout(invoke, remaining);
      }
    }
    throttled.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; lastArgs = null; last = 0; };
    return throttled;
  }

  /**
   * Coalesce calls into one invocation per animation frame (Node / no rAF: one per microtask).
   * The latest arguments win. Returns a function with cancel() and flush().
   */
  function rafBatch(fn) {
    let scheduled = false;
    let handle = null;
    let token = 0;
    let lastArgs = [];
    let lastThis = null;
    const hasRaf = typeof g.requestAnimationFrame === 'function';
    function run(t) {
      if (t !== token || !scheduled) return;
      scheduled = false;
      handle = null;
      fn.apply(lastThis, lastArgs);
    }
    function batched(...args) {
      lastArgs = args;
      lastThis = this;
      if (scheduled) return;
      scheduled = true;
      const t = ++token;
      if (hasRaf) handle = g.requestAnimationFrame(() => run(t));
      else queueMicrotask(() => run(t));
    }
    batched.cancel = () => {
      if (scheduled && hasRaf && handle !== null && typeof g.cancelAnimationFrame === 'function') g.cancelAnimationFrame(handle);
      scheduled = false;
      handle = null;
      token++;
    };
    batched.flush = () => {
      if (!scheduled) return;
      batched.cancel();
      fn.apply(lastThis, lastArgs);
    };
    batched.pending = () => scheduled;
    return batched;
  }

  /* ------------------------------------------------------------- strings */

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHTML(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function escapeAttr(str) {
    return String(str == null ? '' : str).replace(/[&<>"'`]/g, (c) => (c === '`' ? '&#96;' : HTML_ESCAPES[c]));
  }

  function slugify(str, fallback = '') {
    const s = String(str == null ? '' : str)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '');
    return s || fallback;
  }

  function kebab(str) {
    return String(str).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  }

  function camel(str) {
    return String(str).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function formatBytes(bytes, decimals = 1) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return (i === 0 ? String(Math.round(v)) : String(Number(v.toFixed(decimals)))) + ' ' + units[i];
  }

  function pluralWord(word) {
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
    return word + 's';
  }

  /** plural(3, 'layer') → '3 layers'; plural(1, 'layer') → '1 layer'. */
  function plural(n, word, pluralForm) {
    return n + ' ' + (n === 1 ? word : (pluralForm || pluralWord(word)));
  }

  /**
   * Fuzzy subsequence match. Returns { score, positions } or null. Higher score = better.
   * Rewards exact/prefix matches, word-start hits and consecutive runs; penalises gaps and length.
   */
  function fuzzyMatch(query, text) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const t = String(text == null ? '' : text);
    const tl = t.toLowerCase();
    if (!q) return { score: 1, positions: [] };
    if (!tl) return null;
    const positions = [];
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') continue;
      // Prefer a consecutive or word-start occurrence, as long as the rest of the query still fits.
      let found = -1;
      for (let j = ti; j < tl.length; j++) {
        if (tl[j] !== ch) continue;
        if (found < 0) found = j;
        if (j === prev + 1 || isWordStart(t, j)) {
          if (isSubsequence(q, qi + 1, tl, j + 1)) found = j;
          break;
        }
      }
      if (found < 0) return null;
      let s = 1;
      if (found === prev + 1) s += 5;
      if (isWordStart(t, found)) s += 8;
      if (found === 0) s += 4;
      s -= Math.min(3, (found - ti) * 0.2);
      score += s;
      positions.push(found);
      prev = found;
      ti = found + 1;
    }
    if (tl === q) score += 40;
    else if (tl.startsWith(q)) score += 20;
    else if (tl.includes(q)) score += 10;
    score -= Math.min(10, tl.length * 0.05);
    return { score: Math.max(0.01, score), positions };
  }

  function isSubsequence(q, qi, tl, ti) {
    let j = ti;
    for (let i = qi; i < q.length; i++) {
      if (q[i] === ' ') continue;
      j = tl.indexOf(q[i], j);
      if (j < 0) return false;
      j++;
    }
    return true;
  }

  function isWordStart(text, i) {
    if (i === 0) return true;
    const prev = text[i - 1];
    const cur = text[i];
    if (/[\s\-_./:·>]/.test(prev)) return true;
    return /[a-z]/.test(prev) && /[A-Z]/.test(cur);
  }

  function fuzzyScore(query, text) {
    const m = fuzzyMatch(query, text);
    return m ? m.score : 0;
  }

  /** nextName('Frame', ['Frame', 'Frame 2']) → 'Frame 3'. */
  function nextName(base, existingNames) {
    const names = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
    const b = String(base == null ? '' : base).trim() || 'Layer';
    if (!names.has(b)) return b;
    const m = /^(.*?)\s+(\d+)$/.exec(b);
    const stem = m ? m[1] : b;
    let max = m ? parseInt(m[2], 10) : 1;
    const re = new RegExp('^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s+(\\d+))?$');
    for (const name of names) {
      const mm = re.exec(String(name));
      if (mm) max = Math.max(max, mm[1] ? parseInt(mm[1], 10) : 1);
    }
    return stem + ' ' + (max + 1);
  }

  function noop() {}

  return {
    uid, clamp, round, lerp,
    deepClone, deepEqual, deepMerge,
    parsePath, getPath, setPathImmutable,
    debounce, throttle, rafBatch,
    escapeHTML, escapeAttr, slugify, kebab, camel, formatBytes, plural,
    isPlainObject, pick, omit, groupBy, uniq,
    fuzzyScore, fuzzyMatch, nextName, noop
  };
});

/* @node-testable */
/*
 * elements — element type registry. See ARCHITECTURE.md §5.4.
 *
 * Definitions are validated and normalized on register(). The core types live in
 * `element-types` (which depends on this module); they are loaded lazily the first time the
 * registry is queried, so `schema.createNode()` picks up their defaults without anyone having to
 * require `element-types` explicitly.
 */
APB.define('elements', ['util'], function (util) {
  'use strict';

  const CATEGORIES = Object.freeze(['basic', 'text', 'media', 'layout', 'form', 'advanced']);

  /** Default capabilities; a definition's `caps` object is merged over these. */
  const DEFAULT_CAPS = Object.freeze({
    fill: true, border: true, radius: true, shadow: true, text: false, padding: false,
    effects: true, stroke: false, image: false, layout: false
  });

  const FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'url', 'select', 'toggle', 'color', 'asset', 'icon', 'list', 'table', 'code']);

  const TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;

  const defs = new Map(); // type -> normalized def (registration order preserved)
  let coreState = 0;      // 0 = not loaded, 1 = loading, 2 = done

  function ensureCore() {
    if (coreState !== 0) return;
    coreState = 1;
    try {
      if (typeof APB !== 'undefined' && APB.has('element-types')) APB.require('element-types');
    } catch (err) {
      // A circular require means element-types is being instantiated right now (it registers
      // itself); anything else is a genuine failure worth reporting.
      if (!/circular/i.test(String(err && err.message)) && typeof console !== 'undefined') {
        console.error('[APB] failed to load core element types:', err);
      }
    }
    coreState = 2;
  }

  function fail(def, msg) {
    const name = def && typeof def.type === 'string' ? def.type : '?';
    throw new TypeError('elements.register(' + name + '): ' + msg);
  }

  function normalizeInspector(def, list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) fail(def, 'inspector must be an array of sections');
    return list.map((section, i) => {
      if (!util.isPlainObject(section)) fail(def, 'inspector section #' + i + ' must be an object');
      const fields = Array.isArray(section.fields) ? section.fields : [];
      fields.forEach((f, j) => {
        if (!util.isPlainObject(f) || typeof f.key !== 'string' || !f.key) fail(def, 'inspector field #' + j + ' of section #' + i + ' needs a key');
        if (f.type !== undefined && !FIELD_TYPES.includes(f.type)) fail(def, 'inspector field "' + f.key + '" has unknown type "' + f.type + '"');
      });
      return Object.freeze(Object.assign({}, section, {
        title: typeof section.title === 'string' ? section.title : '',
        fields: Object.freeze(fields.map((f) => Object.freeze(Object.assign({ label: f.key, type: 'text' }, f))))
      }));
    });
  }

  /**
   * register(def) → normalized (frozen) def. Throws TypeError on invalid definitions. Registering
   * an existing type throws unless `def.replace === true`.
   */
  function register(def) {
    if (!util.isPlainObject(def)) throw new TypeError('elements.register: definition must be an object');
    if (typeof def.type !== 'string' || !TYPE_RE.test(def.type)) fail(def, 'type must match ' + TYPE_RE);
    if (typeof def.label !== 'string' || !def.label.trim()) fail(def, 'label must be a non-empty string');
    if (typeof def.vnode !== 'function') fail(def, 'vnode must be a function');
    if (typeof def.defaults !== 'function') fail(def, 'defaults must be a function');
    if (def.category !== undefined && !CATEGORIES.includes(def.category)) fail(def, 'category must be one of ' + CATEGORIES.join(', '));
    if (def.accepts !== undefined && def.accepts !== null && typeof def.accepts !== 'function') fail(def, 'accepts must be a function or null');
    if (def.audit !== undefined && def.audit !== null && typeof def.audit !== 'function') fail(def, 'audit must be a function');
    if (def.styleOmit !== undefined && def.styleOmit !== null && typeof def.styleOmit !== 'function' && !Array.isArray(def.styleOmit)) fail(def, 'styleOmit must be a function or an array');
    if (def.caps !== undefined && !util.isPlainObject(def.caps)) fail(def, 'caps must be an object');
    if (def.bpProps !== undefined && (!Array.isArray(def.bpProps) || def.bpProps.some((k) => typeof k !== 'string'))) fail(def, 'bpProps must be an array of strings');
    if (def.textEdit !== undefined && def.textEdit !== null && typeof def.textEdit !== 'string') fail(def, 'textEdit must be a props key or null');
    if (defs.has(def.type) && def.replace !== true) throw new Error('elements.register: type "' + def.type + '" is already registered');

    const container = !!def.container;
    const normalized = Object.assign({}, def, {
      type: def.type,
      label: def.label.trim(),
      icon: typeof def.icon === 'string' && def.icon ? def.icon : def.type,
      category: def.category || 'basic',
      container,
      accepts: typeof def.accepts === 'function' ? def.accepts : null,
      caps: Object.freeze(Object.assign({}, DEFAULT_CAPS, { layout: container }, def.caps || {})),
      bpProps: Object.freeze((def.bpProps || []).slice()),
      textEdit: typeof def.textEdit === 'string' && def.textEdit ? def.textEdit : null,
      inspector: Object.freeze(normalizeInspector(def, def.inspector)),
      audit: typeof def.audit === 'function' ? def.audit : null,
      insertable: def.insertable !== false
    });
    delete normalized.replace;
    const frozen = Object.freeze(normalized);
    defs.set(def.type, frozen);
    return frozen;
  }

  function unregister(type) {
    return defs.delete(type);
  }

  function get(type) {
    if (typeof type !== 'string') return null;
    if (!defs.has(type)) ensureCore();
    return defs.get(type) || null;
  }

  function has(type) {
    return get(type) !== null;
  }

  /** list({ category, insertable }) → defs in registration order. */
  function list(filter) {
    ensureCore();
    const f = filter || {};
    let out = Array.from(defs.values());
    if (f.category) out = out.filter((d) => d.category === f.category);
    if (f.insertable !== undefined) out = out.filter((d) => d.insertable === !!f.insertable);
    return out;
  }

  function types() {
    ensureCore();
    return Array.from(defs.keys());
  }

  /** canContain(parentType, childType) → boolean (container + accepts check). */
  function canContain(parentType, childType) {
    const parent = get(parentType);
    if (!parent || !parent.container) return false;
    if (childType === 'page') return false;
    if (!parent.accepts) return true;
    try { return !!parent.accepts(childType); } catch (_) { return false; }
  }

  /** styleOmit(def, effectiveNode) → string[] of STYLE_KEYS the style module must not emit. */
  function styleOmit(typeOrDef, eff) {
    const def = typeof typeOrDef === 'string' ? get(typeOrDef) : typeOrDef;
    if (!def || !def.styleOmit) return [];
    try {
      const v = typeof def.styleOmit === 'function' ? def.styleOmit(eff) : def.styleOmit;
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }

  return { register, unregister, get, has, list, types, canContain, styleOmit, CATEGORIES, DEFAULT_CAPS, FIELD_TYPES };
});

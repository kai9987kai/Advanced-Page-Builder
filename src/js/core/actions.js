/* @node-testable */
/*
 * actions — click/change interactions ("actions") a node can carry: a small set of built-in
 * behaviours (navigate, scroll to, show/hide/toggle another node, toggle a class, submit the
 * nearest form) plus a "run custom code" escape hatch. Pure (no DOM); consumed by
 * `features/actions.js` (the inspector "Actions" section), `features/exporters.js` and
 * `features/preview.js` (which append `runtimeSource()` as a trusted <script> — vdom never emits
 * <script> tags itself, see ARCHITECTURE.md §6.9.1). See ARCHITECTURE.md "Contract additions".
 *
 * Node shape: `node.actions = [{ id, trigger: 'click'|'change', type, ...type-specific fields }]`.
 * `type` is one of `TYPES[].id`; each type declares the fields it needs (`fields: [{ key, label,
 * kind }]`, `kind` one of `url|toggle|target|text|code`). `normalize(list, { sanitizeUrl, doc })`
 * drops anything malformed and is the only writer other modules should trust.
 */
APB.define('actions', ['util', 'sanitize'], function (util, sanitize) {
  'use strict';

  const MAX_ACTIONS = 40;
  const MAX_CODE = 20000;
  const TRIGGERS = new Set(['click', 'change']);

  const TYPES = [
    { id: 'link', label: 'Go to URL', icon: 'export', fields: [
      { key: 'url', label: 'URL', kind: 'url', placeholder: 'https://' },
      { key: 'newTab', label: 'Open in a new tab', kind: 'toggle' }
    ] },
    { id: 'scrollTo', label: 'Scroll to element', icon: 'arrow-down', fields: [
      { key: 'target', label: 'Element', kind: 'target' }
    ] },
    { id: 'toggle', label: 'Toggle visibility', icon: 'eye', fields: [
      { key: 'target', label: 'Element', kind: 'target' }
    ] },
    { id: 'show', label: 'Show element', icon: 'eye', fields: [
      { key: 'target', label: 'Element', kind: 'target' }
    ] },
    { id: 'hide', label: 'Hide element', icon: 'eye', fields: [
      { key: 'target', label: 'Element', kind: 'target' }
    ] },
    { id: 'toggleClass', label: 'Toggle CSS class', icon: 'code', fields: [
      { key: 'target', label: 'Element', kind: 'target' },
      { key: 'className', label: 'Class name', kind: 'text', placeholder: 'is-active' }
    ] },
    { id: 'submit', label: 'Submit the form', icon: 'button', fields: [] },
    { id: 'code', label: 'Run custom code', icon: 'code', fields: [
      { key: 'code', label: 'JavaScript', kind: 'code', placeholder: '// event, el, document, window are in scope' }
    ] }
  ];

  const TYPES_BY_ID = new Map(TYPES.map((t) => [t.id, t]));

  /** The event a node type's actions listen for. Buttons/links click; checklist items change. */
  const DEFAULT_TRIGGER = { button: 'click', checklist: 'change', text: 'click', frame: 'click', shape: 'click', image: 'click' };

  function triggerFor(nodeType) {
    return DEFAULT_TRIGGER[nodeType] || 'click';
  }

  function has(type) {
    return TYPES_BY_ID.has(type);
  }

  function fieldsFor(type) {
    const def = TYPES_BY_ID.get(type);
    return def ? def.fields.slice() : [];
  }

  function makeId() {
    return util.uid('act');
  }

  /** New action of `type` for a node of `nodeType`, sane empty defaults for every field. */
  function create(type, nodeType) {
    const def = TYPES_BY_ID.get(type) || TYPES[0];
    const a = { id: makeId(), trigger: triggerFor(nodeType), type: def.id };
    for (const f of def.fields) {
      if (f.kind === 'toggle') a[f.key] = false;
      else a[f.key] = '';
    }
    return a;
  }

  /** normalize(list, { sanitizeUrl, doc }) → clean array; drops anything malformed or unknown. */
  function normalize(list, opts) {
    if (!Array.isArray(list)) return [];
    const o = opts || {};
    const urlFn = typeof o.sanitizeUrl === 'function' ? o.sanitizeUrl : (u) => sanitize.url(u, 'link');
    const nodes = o.doc && util.isPlainObject(o.doc.nodes) ? o.doc.nodes : null;
    const out = [];
    for (const raw of list) {
      if (!util.isPlainObject(raw) || !has(raw.type)) continue;
      const def = TYPES_BY_ID.get(raw.type);
      const a = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : makeId(),
        trigger: TRIGGERS.has(raw.trigger) ? raw.trigger : 'click',
        type: def.id
      };
      for (const f of def.fields) {
        const v = raw[f.key];
        if (f.kind === 'url') a[f.key] = typeof v === 'string' && v ? urlFn(v) : '';
        else if (f.kind === 'toggle') a[f.key] = !!v;
        else if (f.kind === 'target') a[f.key] = typeof v === 'string' && v && (!nodes || Object.prototype.hasOwnProperty.call(nodes, v)) ? v : '';
        else if (f.kind === 'code') a[f.key] = typeof v === 'string' ? v.slice(0, MAX_CODE) : '';
        else if (f.key === 'className') a[f.key] = typeof v === 'string' ? sanitize.className(v) : '';
        else a[f.key] = typeof v === 'string' ? v.slice(0, 200) : '';
      }
      out.push(a);
      if (out.length >= MAX_ACTIONS) break;
    }
    return out;
  }

  /** Short one-line summary for a collapsed row, e.g. "Go to URL — https://example.com". */
  function describe(action) {
    const def = TYPES_BY_ID.get(action && action.type);
    if (!def) return 'Unknown action';
    if (action.type === 'link') return def.label + (action.url ? ' — ' + action.url : '');
    if (action.type === 'code') return def.label + (action.code ? ' — ' + action.code.trim().slice(0, 40).replace(/\s+/g, ' ') : '');
    if (['scrollTo', 'toggle', 'show', 'hide', 'toggleClass'].includes(action.type)) return def.label + (action.target ? '' : ' — no target set');
    return def.label;
  }

  /**
   * Trusted runtime appended verbatim (never through vdom/sanitize) by exporters/preview when any
   * node in the exported tree carries actions. Delegates one listener per (element, trigger); a
   * 'code' action runs in the page's own scope with (event, el, document, window) — this is the
   * site owner's own code, the same trust boundary as `node.css` / `settings.globalCSS`.
   */
  function runtimeSource() {
    return '(function(){\n' +
      '  function apbRunAction(a, el, evt) {\n' +
      '    try {\n' +
      '      switch (a.type) {\n' +
      '        case "link":\n' +
      '          if (!a.url) return;\n' +
      '          if (a.newTab) window.open(a.url, "_blank", "noopener"); else window.location.href = a.url;\n' +
      '          break;\n' +
      '        case "scrollTo": {\n' +
      '          var t = a.target && document.querySelector(\'[data-node-id="\' + a.target + \'"]\');\n' +
      '          if (t && t.scrollIntoView) t.scrollIntoView({ behavior: "smooth", block: "start" });\n' +
      '          break;\n' +
      '        }\n' +
      '        case "toggle": case "show": case "hide": {\n' +
      '          var t2 = a.target && document.querySelector(\'[data-node-id="\' + a.target + \'"]\');\n' +
      '          if (!t2) return;\n' +
      '          var hidden = t2.style.display === "none";\n' +
      '          var next = a.type === "show" ? false : a.type === "hide" ? true : !hidden;\n' +
      '          t2.style.display = next ? "none" : "";\n' +
      '          break;\n' +
      '        }\n' +
      '        case "toggleClass": {\n' +
      '          var t3 = a.target && document.querySelector(\'[data-node-id="\' + a.target + \'"]\');\n' +
      '          if (t3 && a.className) t3.classList.toggle(a.className);\n' +
      '          break;\n' +
      '        }\n' +
      '        case "submit": {\n' +
      '          var f = el.closest("form");\n' +
      '          if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); }\n' +
      '          break;\n' +
      '        }\n' +
      '        case "code":\n' +
      '          if (a.code) new Function("event", "el", "document", "window", a.code).call(el, evt, el, document, window);\n' +
      '          break;\n' +
      '      }\n' +
      '    } catch (err) { if (window.console) console.error("[apb-action]", err); }\n' +
      '  }\n' +
      '  function apbInit(root) {\n' +
      '    (root || document).querySelectorAll("[data-apb-actions]").forEach(function (el) {\n' +
      '      if (el.__apbActionsBound) return;\n' +
      '      el.__apbActionsBound = true;\n' +
      '      var list = [];\n' +
      '      try { list = JSON.parse(el.getAttribute("data-apb-actions") || "[]"); } catch (e) { list = []; }\n' +
      '      var byTrigger = {};\n' +
      '      list.forEach(function (a) { (byTrigger[a.trigger] = byTrigger[a.trigger] || []).push(a); });\n' +
      '      Object.keys(byTrigger).forEach(function (trigger) {\n' +
      '        el.addEventListener(trigger, function (evt) { byTrigger[trigger].forEach(function (a) { apbRunAction(a, el, evt); }); });\n' +
      '      });\n' +
      '    });\n' +
      '  }\n' +
      '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { apbInit(document); });\n' +
      '  else apbInit(document);\n' +
      '})();';
  }

  return { TYPES, has, fieldsFor, triggerFor, create, normalize, describe, runtimeSource, MAX_ACTIONS, MAX_CODE };
});

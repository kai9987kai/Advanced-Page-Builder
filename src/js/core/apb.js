/* @node-testable */
/*
 * APB module system — the only global of Advanced Page Builder 2.
 * Classic script (no ES modules, works on file://). Works in browsers (window.APB)
 * and in Node vm contexts (globalThis.APB). See docs/ARCHITECTURE.md §3.
 */
(function (root) {
  'use strict';

  if (root.APB && root.APB.__isAPB) return;

  const defs = new Map();      // name -> { name, deps, factory }
  const instances = new Map(); // name -> api
  const resolving = [];        // stack of names currently being instantiated
  const pluginDefs = [];       // plugin definitions in registration order

  function define(name, deps, factory) {
    if (typeof deps === 'function' && factory === undefined) { factory = deps; deps = []; }
    if (typeof name !== 'string' || !name) throw new TypeError('APB.define: name must be a non-empty string');
    if (!Array.isArray(deps)) throw new TypeError('APB.define(' + name + '): deps must be an array');
    if (typeof factory !== 'function') throw new TypeError('APB.define(' + name + '): factory must be a function');
    if (defs.has(name)) throw new Error('APB.define: module "' + name + '" is already defined');
    defs.set(name, { name, deps: deps.slice(), factory });
  }

  function require(name) {
    if (instances.has(name)) return instances.get(name);
    const def = defs.get(name);
    if (!def) {
      const from = resolving.length ? ' (required by "' + resolving[resolving.length - 1] + '")' : '';
      throw new Error('APB.require: module "' + name + '" is not defined' + from);
    }
    if (resolving.includes(name)) {
      throw new Error('APB.require: circular dependency ' + resolving.concat(name).join(' -> '));
    }
    resolving.push(name);
    let api;
    try {
      const depApis = def.deps.map(require);
      api = def.factory.apply(null, depApis);
    } finally {
      resolving.pop();
    }
    if (api === undefined) api = {};
    instances.set(name, api);
    return api;
  }

  function has(name) {
    return defs.has(name);
  }

  function list() {
    return Array.from(defs.keys());
  }

  function plugin(def) {
    if (!def || typeof def !== 'object') throw new TypeError('APB.plugin: definition must be an object');
    if (typeof def.id !== 'string' || !def.id) throw new TypeError('APB.plugin: id must be a non-empty string');
    if (typeof def.init !== 'function') throw new TypeError('APB.plugin(' + def.id + '): init must be a function');
    if (pluginDefs.some((p) => p.id === def.id)) throw new Error('APB.plugin: plugin "' + def.id + '" is already registered');
    pluginDefs.push(def);
  }

  function plugins() {
    return pluginDefs
      .map((p, i) => ({ p, i }))
      .sort((a, b) => ((a.p.order ?? 100) - (b.p.order ?? 100)) || (a.i - b.i))
      .map((x) => x.p);
  }

  const APB = {
    version: '2.0.0',
    define,
    require,
    has,
    list,
    plugin,
    plugins
  };
  Object.defineProperty(APB, '__isAPB', { value: true });

  root.APB = APB;
})(typeof globalThis !== 'undefined' ? globalThis : this);

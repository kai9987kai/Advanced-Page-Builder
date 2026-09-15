/* @node-testable */
/*
 * events — tiny Emitter. Listener errors are reported via console.error and never break emit.
 * See ARCHITECTURE.md §6.2.
 */
APB.define('events', [], function () {
  'use strict';

  class Emitter {
    constructor() {
      this._listeners = new Map(); // evt -> array of { fn, once }
    }

    on(evt, fn) {
      if (typeof fn !== 'function') throw new TypeError('Emitter.on: listener must be a function');
      let list = this._listeners.get(evt);
      if (!list) { list = []; this._listeners.set(evt, list); }
      const entry = { fn, once: false };
      list.push(entry);
      return () => this._remove(evt, entry);
    }

    once(evt, fn) {
      if (typeof fn !== 'function') throw new TypeError('Emitter.once: listener must be a function');
      let list = this._listeners.get(evt);
      if (!list) { list = []; this._listeners.set(evt, list); }
      const entry = { fn, once: true };
      list.push(entry);
      return () => this._remove(evt, entry);
    }

    off(evt, fn) {
      const list = this._listeners.get(evt);
      if (!list) return;
      if (fn === undefined) { this._listeners.delete(evt); return; }
      const idx = list.findIndex((e) => e.fn === fn);
      if (idx >= 0) list.splice(idx, 1);
      if (!list.length) this._listeners.delete(evt);
    }

    emit(evt, payload) {
      const list = this._listeners.get(evt);
      if (!list || !list.length) return 0;
      const snapshot = list.slice();
      let called = 0;
      for (const entry of snapshot) {
        if (!list.includes(entry)) continue; // removed by an earlier listener
        if (entry.once) this._remove(evt, entry);
        called++;
        try {
          entry.fn(payload);
        } catch (err) {
          if (typeof console !== 'undefined' && console.error) {
            console.error('[APB] listener for "' + String(evt) + '" threw:', err);
          }
        }
      }
      return called;
    }

    listenerCount(evt) {
      const list = this._listeners.get(evt);
      return list ? list.length : 0;
    }

    clear() {
      this._listeners.clear();
    }

    _remove(evt, entry) {
      const list = this._listeners.get(evt);
      if (!list) return;
      const idx = list.indexOf(entry);
      if (idx >= 0) list.splice(idx, 1);
      if (!list.length) this._listeners.delete(evt);
    }
  }

  return { Emitter };
});

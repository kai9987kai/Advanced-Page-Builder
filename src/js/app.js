/*
 * app — bootstrap. Builds the `app` object (ARCHITECTURE.md §9) and sets `APB.app` immediately, mounts the shell
 * (or a minimal fallback layout), mounts the canvas into `ui.canvasHost`, runs plugins, sets `app.ready` and emits
 * `ready`. Uncaught errors, rejections, command and plugin failures go to `app.log` (ring buffer of 500, `app.logs()`)
 * and a rate-limited error toast. Shows a welcome toast when no storage service is registered.
 * Must never throw while other modules are still stubs.
 */
APB.define('app', ['util', 'events', 'env', 'schema', 'store', 'commands', 'sanitize'],
  function (util, events, env, schema, storeModule, commands, sanitize) {
    'use strict';

    const LOG_LIMIT = 500;
    let app = null;

    function optional(name) {
      if (!APB.has(name)) return null;
      try {
        return APB.require(name);
      } catch (err) {
        console.error('[APB] module "' + name + '" failed to initialise:', err);
        return null;
      }
    }

    /** Minimal implementation of the app.ui contract (§8) used until the shell exists. */
    function minimalUI(root, appRef) {
      const registry = { panels: [], toolbar: [], status: [], menu: [], inspector: [] };
      while (root.firstChild) root.removeChild(root.firstChild);

      const wrap = document.createElement('div');
      wrap.className = 'apb-foundation';
      wrap.style.cssText = 'display:flex;flex-direction:column;min-height:100vh;box-sizing:border-box;' +
        'font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:Canvas;color:CanvasText;';

      const header = document.createElement('header');
      header.style.cssText = 'padding:16px 24px;border-bottom:1px solid GrayText;';
      const h1 = document.createElement('h1');
      h1.style.cssText = 'margin:0;font-size:18px;font-weight:650;';
      h1.textContent = 'Advanced Page Builder 2 — foundation';
      const info = document.createElement('p');
      info.className = 'apb-foundation-info';
      info.style.cssText = 'margin:4px 0 0;font-size:13px;';
      const doc = appRef.store.doc;
      info.textContent = 'Core runtime ready · ' + util.plural(APB.list().length, 'module') + ' defined · document "' +
        doc.name + '" with ' + util.plural(Object.keys(doc.nodes).length, 'node') + '.';
      header.append(h1, info);

      const main = document.createElement('main');
      main.style.cssText = 'flex:1;display:flex;min-height:0;';
      const canvasHost = document.createElement('div');
      canvasHost.className = 'apb-canvas-host';
      canvasHost.style.cssText = 'flex:1;position:relative;min-height:320px;';
      main.append(canvasHost);

      const toasts = document.createElement('div');
      toasts.className = 'apb-toasts';
      toasts.setAttribute('role', 'status');
      toasts.style.cssText = 'position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;';

      wrap.append(header, main, toasts);
      root.append(wrap);

      const live = document.getElementById('apb-live');
      if (live && getComputedStyle(live).position !== 'absolute') {
        // tokens.css (B2) normally provides .apb-sr-only; keep the live region visually hidden without it.
        live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
          'clip-path:inset(50%);white-space:nowrap;border:0;';
      }
      const sorted = (list) => list.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
      const dialogs = optional('dialogs');

      return {
        canvasHost,
        root: wrap,
        registerPanel(def) { registry.panels.push(def); registry.panels = sorted(registry.panels); },
        showPanel() {},
        registerToolbarItem(def) { registry.toolbar.push(def); },
        registerStatusItem(def) { registry.status.push(def); },
        registerMenuItem(def) { registry.menu.push(def); },
        registerInspectorSection(def) { registry.inspector.push(def); },
        inspectorSections: () => sorted(registry.inspector),
        toast(message, opts) {
          if (dialogs) return dialogs.toast(message, opts);
          const el = document.createElement('div');
          el.textContent = String(message);
          el.style.cssText = 'padding:8px 12px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;';
          toasts.append(el);
          setTimeout(() => el.remove(), (opts && opts.timeout) || 4000);
          return { el, close: () => el.remove() };
        },
        confirm(o) { return dialogs ? dialogs.confirm(o) : Promise.resolve(false); },
        prompt(o) { return dialogs ? dialogs.prompt(o) : Promise.resolve(null); },
        dialog(o) { return dialogs ? dialogs.dialog(o) : { close() {}, el: null }; },
        menu(a, items, o) { return dialogs ? dialogs.menu(a, items, o) : null; },
        announce(message) {
          if (dialogs) { dialogs.announce(message); return; }
          if (live) { live.textContent = ''; live.textContent = String(message); }
        },
        _registry: registry
      };
    }

    /** Errors that browsers report but that never indicate a user-facing failure. */
    const BENIGN_ERRORS = /ResizeObserver loop|Script error\.?$/i;
    const ERROR_TOAST_INTERVAL = 5000;
    const truncate = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

    function start(options) {
      if (app) return app;
      const opts = options || {};
      const root = opts.root || document.getElementById('apb-app') || document.body.appendChild(document.createElement('div'));
      const emitter = new events.Emitter();
      const logEntries = [];

      const store = storeModule.create(opts.doc || schema.createDocument());

      app = {
        version: APB.version,
        env,
        util,
        store,
        commands,
        elements: optional('elements'),
        docops: optional('docops'),
        schema,
        style: optional('style'),
        sanitize,
        ui: null,
        canvas: null,
        services: {},
        emitter,
        ready: false,
        on: (evt, fn) => emitter.on(evt, fn),
        emit: (evt, payload) => emitter.emit(evt, payload),
        log(msg, logOpts) {
          const entry = { time: Date.now(), level: (logOpts && logOpts.level) || 'info', message: String(msg), data: logOpts && logOpts.data };
          logEntries.push(entry);
          if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT);
          emitter.emit('log', { entry });
          return entry;
        },
        logs: () => logEntries.slice()
      };
      APB.app = app;

      // User-facing failure reporting: every error is logged; at most one toast per interval (repeats are dropped).
      let lastErrorToast = 0;
      let lastErrorText = '';
      function notifyError(text) {
        const now = Date.now();
        if (!app.ui || typeof app.ui.toast !== 'function') return;
        if (now - lastErrorToast < ERROR_TOAST_INTERVAL || (text === lastErrorText && now - lastErrorToast < ERROR_TOAST_INTERVAL * 6)) return;
        lastErrorToast = now;
        lastErrorText = text;
        try { app.ui.toast(text, { kind: 'error', timeout: 6000 }); } catch (_) { /* never throw from the error path */ }
      }
      app.notifyError = notifyError;

      window.addEventListener('error', (e) => {
        const message = (e && e.message) || (e && e.error && e.error.message) || 'Uncaught error';
        if (BENIGN_ERRORS.test(message)) return;
        app.log(message, { level: 'error', data: { source: e.filename, line: e.lineno, column: e.colno, stack: e.error && e.error.stack } });
        notifyError('Something went wrong: ' + truncate(message, 120));
      });
      window.addEventListener('unhandledrejection', (e) => {
        const reason = e && e.reason;
        const message = (reason && reason.message) || String(reason);
        if (reason && reason.name === 'AbortError') return;
        app.log('Unhandled rejection: ' + message, { level: 'error', data: { stack: reason && reason.stack } });
        notifyError('Something went wrong: ' + truncate(message, 120));
      });

      commands.setApp(app);
      commands.attach(document);
      if (typeof commands.on === 'function') {
        commands.on('error', (p) => {
          const def = commands.get(p.id);
          const message = (p.error && p.error.message) || String(p.error);
          app.log('Command "' + p.id + '" failed: ' + message, { level: 'error', data: { id: p.id, stack: p.error && p.error.stack } });
          notifyError('Could not ' + ((def && def.title) || p.id).toLowerCase() + ': ' + truncate(message, 100));
        });
      }

      const shell = optional('shell');
      if (shell && typeof shell.mount === 'function') {
        try { app.ui = shell.mount(root, app); } catch (err) { console.error('[APB] shell failed to mount:', err); }
      }
      if (!app.ui) app.ui = minimalUI(root, app);

      const canvas = optional('canvas');
      if (canvas && typeof canvas.mount === 'function' && app.ui.canvasHost) {
        try { app.canvas = canvas.mount(app.ui.canvasHost, app); } catch (err) { console.error('[APB] canvas failed to mount:', err); }
      }

      for (const plugin of APB.plugins()) {
        const missing = (plugin.requires || []).filter((name) => !APB.has(name));
        if (missing.length) {
          console.warn('[APB] plugin "' + plugin.id + '" skipped: missing ' + missing.join(', '));
          continue;
        }
        try {
          plugin.init(app);
        } catch (err) {
          console.error('[APB] plugin "' + plugin.id + '" failed:', err);
          app.log('Plugin "' + plugin.id + '" failed: ' + (err && err.message), { level: 'error', data: { stack: err && err.stack } });
          notifyError('A feature failed to start (' + plugin.id + '). Some tools may be unavailable.');
        }
      }

      app.ready = true;
      app.emit('ready', { app });

      if (!app.services.storage && opts.welcome !== false) {
        // Without the storage plugin nothing is persisted; say so once instead of silently losing work.
        setTimeout(() => {
          try {
            app.ui.toast('Welcome to Advanced Page Builder. Saving isn’t available in this build — export your work before you close the tab.',
              { kind: 'info', timeout: 7000 });
          } catch (_) { /* optional */ }
        }, 0);
      }
      return app;
    }

    return { start, get app() { return app; } };
  });

(function boot() {
  'use strict';
  if (typeof document === 'undefined') return;
  const run = () => APB.require('app').start();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();

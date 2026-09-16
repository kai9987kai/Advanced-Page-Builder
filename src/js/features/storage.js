/*
 * storage — `services.storage` (ARCHITECTURE.md §10): project persistence. IndexedDB database
 * `apb` (stores `projects` keyed by id, `versions`, `kv`) with a `localStorage` fallback for
 * origins where IndexedDB is unavailable or throws (notably `file://`, the app's primary
 * distribution mode — this is why the fallback exists at all, not a nice-to-have). Autosaves the
 * open document 800 ms after the last change and again on `pagehide`/`visibilitychange`, so
 * closing the tab never loses the last edit. Not `@node-testable` — inherently storage/DOM-API
 * heavy; `docops`'s page functions and `store.replaceDoc` (the two things this leans on) are unit
 * tested there instead.
 */
(function () {
  'use strict';

  const DB_NAME = 'apb';
  const DB_VERSION = 1;
  const LAST_KEY = 'apb.v2.last';
  const LS_PREFIX = 'apb.v2.project.';
  const LS_INDEX_KEY = 'apb.v2.projects';
  const AUTOSAVE_MS = 800;
  /** Saved by the predecessor single-file app (see docs/ARCHITECTURE.md §10) — offered for import, never deleted by us. */
  const LEGACY_KEYS = ['ultimateBuilderPlusLayout', 'ultimateBuilderLayout'];

  function hasIDB() { return typeof indexedDB !== 'undefined'; }
  function hasLS() { try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (err) { return false; } }
  function safeGet(key) { try { return localStorage.getItem(key); } catch (err) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (err) { /* quota or blocked — ignored, save() surfaces failures */ } }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch (err) { /* ignored */ } }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!hasIDB()) { reject(new Error('IndexedDB unavailable')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('versions')) {
          const vs = db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
          vs.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked (another tab holds an upgrade lock)'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function objectStore(db, name, mode) { return db.transaction(name, mode).objectStore(name); }
  const stripDoc = (rec) => ({ id: rec.id, name: rec.name, updatedAt: rec.updatedAt, thumb: rec.thumb || '' });
  const byRecency = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

  const idbBackend = {
    name: 'indexeddb',
    async list() {
      const db = await openDB();
      const all = await reqP(objectStore(db, 'projects', 'readonly').getAll());
      return all.map(stripDoc).sort(byRecency);
    },
    async save(project) {
      const db = await openDB();
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(project);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(project.id);
        tx.onerror = () => reject(tx.error);
      });
    },
    async load(id) {
      const db = await openDB();
      const rec = await reqP(objectStore(db, 'projects', 'readonly').get(id));
      return rec ? rec.doc : null;
    },
    async remove(id) {
      const db = await openDB();
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(id);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }
  };

  function lsIndex() { try { return JSON.parse(safeGet(LS_INDEX_KEY) || '[]'); } catch (err) { return []; } }
  function lsSetIndex(list) { safeSet(LS_INDEX_KEY, JSON.stringify(list)); }

  const lsBackend = {
    name: 'localstorage',
    async list() { return lsIndex().sort(byRecency); },
    async save(project) {
      // Let a QuotaExceededError from the (large) doc payload propagate — the index write below
      // only happens once the payload itself is confirmed to fit.
      localStorage.setItem(LS_PREFIX + project.id, JSON.stringify(project.doc));
      lsSetIndex(lsIndex().filter((p) => p.id !== project.id).concat([stripDoc(project)]));
      return project.id;
    },
    async load(id) {
      const text = safeGet(LS_PREFIX + id);
      return text ? JSON.parse(text) : null;
    },
    async remove(id) {
      safeRemove(LS_PREFIX + id);
      lsSetIndex(lsIndex().filter((p) => p.id !== id));
      return true;
    }
  };

  let backendPromise = null;
  function pickBackend() {
    if (backendPromise) return backendPromise;
    backendPromise = (async () => {
      if (hasIDB()) {
        try { await openDB(); return idbBackend; } catch (err) { /* fall through to localStorage */ }
      }
      return hasLS() ? lsBackend : null;
    })();
    return backendPromise;
  }

  APB.plugin({
    id: 'storage',
    order: 30,
    requires: ['widgets', 'icons', 'schema'],

    init(app) {
      const widgets = APB.require('widgets');
      const schema = APB.require('schema');
      const icons = APB.require('icons');
      icons.add('file', 'M6 3.5h8l4 4v12.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15.5a1 1 0 0 1 1-1z|M14 3.5v4h4');
      icons.add('folder', 'M3.5 6.5h6l2 2.5h9v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z');
      const { h } = widgets;
      const store = app.store;

      let currentId = safeGet(LAST_KEY) || store.doc.id;
      let dirty = false;
      let saving = false;
      let timer = 0;
      let statusText = 'Saved';
      const statusListeners = new Set();

      function setStatus(text) {
        statusText = text;
        statusListeners.forEach((fn) => { try { fn(text); } catch (err) { /* ignore */ } });
      }

      async function backend() {
        const b = await pickBackend();
        if (!b && app.ui && app.ui.toast) {
          app.ui.toast('Nothing can be saved here — this browser has no working storage', { kind: 'warning', timeout: 6000 });
        }
        return b;
      }

      async function persist() {
        const b = await backend();
        if (!b) { setStatus('Unavailable'); return null; }
        const doc = store.doc;
        saving = true;
        setStatus('Saving…');
        try {
          await b.save({ id: currentId, name: doc.name, updatedAt: doc.updatedAt, thumb: '', doc });
          safeSet(LAST_KEY, currentId);
          dirty = false;
          setStatus('Saved');
          app.emit('project:saved', { doc });
        } catch (err) {
          setStatus('Save failed');
          app.log('autosave failed: ' + (err && err.message), { level: 'error' });
          if (app.ui && app.ui.toast) app.ui.toast('Could not save — the browser storage may be full', { kind: 'error' });
        } finally {
          saving = false;
        }
        return currentId;
      }

      function scheduleSave() {
        dirty = true;
        setStatus('Unsaved changes');
        clearTimeout(timer);
        timer = setTimeout(persist, AUTOSAVE_MS);
      }

      store.on('change', (payload) => {
        if (payload && payload.source === 'replace') return; // opening/creating a project isn't a user edit to autosave
        scheduleSave();
      });

      const win = typeof window !== 'undefined' ? window : null;
      if (win) {
        win.addEventListener('pagehide', () => { if (dirty) { clearTimeout(timer); persist(); } });
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && dirty) { clearTimeout(timer); persist(); }
          });
        }
      }

      async function listProjects() {
        const b = await backend();
        return b ? b.list() : [];
      }

      async function openProject(id) {
        const b = await backend();
        if (!b) return false;
        const doc = await b.load(id);
        if (!doc) { if (app.ui.toast) app.ui.toast('That project could not be found'); return false; }
        store.replaceDoc(doc, { label: 'Open project' });
        currentId = id;
        safeSet(LAST_KEY, id);
        dirty = false;
        setStatus('Saved');
        app.emit('project:loaded', { doc });
        if (app.ui.announce) app.ui.announce('Opened ' + (doc.name || 'project'));
        return true;
      }

      function newProject() {
        const doc = schema.createDocument();
        store.replaceDoc(doc, { label: 'New project' });
        currentId = doc.id;
        safeSet(LAST_KEY, doc.id);
        dirty = false;
        setStatus('Saved');
        app.emit('project:loaded', { doc });
        persist();
      }

      function saveAsNew() {
        currentId = app.util.uid('doc');
        scheduleSave();
        if (app.ui.toast) app.ui.toast('Saved as a new project');
      }

      async function removeProject(id) {
        const b = await backend();
        if (!b) return false;
        await b.remove(id);
        if (id === currentId && app.ui.toast) app.ui.toast('That was the project you have open — it will re-save on your next edit');
        return true;
      }

      /* ---------------------------------------------------------- Open dialog */

      async function openBrowser() {
        if (!app.ui || typeof app.ui.dialog !== 'function') return;
        const list = h('div', { class: 'apb-projects-list' });
        const empty = widgets.emptyState({ icon: 'file', title: 'No saved projects yet', message: 'Projects autosave as you work.' });

        async function render() {
          const projects = await listProjects();
          list.replaceChildren();
          if (!projects.length) { list.appendChild(empty); return; }
          for (const p of projects) {
            const row = h('div', { class: ['apb-project-row', p.id === currentId && 'is-current'] },
              h('div', { class: 'apb-project-row-main' },
                h('div', { class: 'apb-project-row-name' }, p.name || 'Untitled site'),
                h('div', { class: 'apb-project-row-date' }, p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '')),
              widgets.iconButton({
                icon: 'trash', label: 'Delete ' + (p.name || 'this project'), size: 'sm',
                onClick: async (e) => { e.stopPropagation(); await removeProject(p.id); render(); }
              }));
            row.addEventListener('click', async () => { const ok = await openProject(p.id); if (ok) dlg.close(); });
            list.appendChild(row);
          }
        }
        await render();
        const dlg = app.ui.dialog({
          title: 'Open a project', wide: true, content: list,
          actions: [
            { label: 'New project', icon: 'plus', run: (close) => { newProject(); close(); } },
            { label: 'Close', kind: 'cancel' }
          ]
        });
      }

      /* --------------------------------------------------------------- legacy */

      function offerLegacyImport() {
        if (currentId !== store.doc.id) return; // already opened a real project this session
        if (Object.keys(store.doc.nodes).length > 2) return; // already has content — not a blank first run
        const key = LEGACY_KEYS.find((k) => !!safeGet(k));
        if (!key || !app.ui || !app.ui.toast) return;
        app.ui.toast('Found a saved layout from the previous builder', {
          kind: 'info', timeout: 10000,
          action: {
            label: 'Import',
            run: async () => {
              const importers = app.services && app.services.importers;
              if (!importers) { app.ui.toast('Import is not available right now', { kind: 'warning' }); return; }
              try {
                const raw = JSON.parse(safeGet(key));
                const html = typeof raw.html === 'string' ? raw.html : '';
                if (!html) throw new Error('no markup in the saved layout');
                await importers.fromHTML(app, html, { target: 'context' });
                if (app.ui.toast) app.ui.toast('Imported — review and re-save when you’re happy with it');
              } catch (err) {
                app.log('legacy import failed: ' + (err && err.message), { level: 'error' });
                if (app.ui.toast) app.ui.toast('Could not read that saved layout', { kind: 'error' });
              }
            }
          }
        });
      }

      /* -------------------------------------------------------------- wiring */

      app.services = app.services || {};
      app.services.storage = {
        list: listProjects, save: persist, load: (id) => backend().then((b) => (b ? b.load(id) : null)),
        remove: removeProject, open: openProject, new: newProject, saveAsNew,
        currentId: () => currentId, isDirty: () => dirty
      };

      const commands = [
        { id: 'file.new', title: 'New project', category: 'File', icon: 'plus', keys: [], run: () => newProject() },
        { id: 'file.save', title: 'Save now', category: 'File', icon: 'save', keys: ['Mod+S'], run: () => persist() },
        { id: 'file.saveAs', title: 'Save as a new project', category: 'File', icon: 'save', keys: ['Mod+Shift+S'], run: () => saveAsNew() },
        { id: 'file.open', title: 'Open project…', category: 'File', icon: 'folder', keys: ['Mod+O'], run: () => openBrowser() }
      ];
      for (const def of commands) if (app.commands && !app.commands.get(def.id)) app.commands.register(def);
      if (app.ui && typeof app.ui.registerMenuItem === 'function') {
        ['file.new', 'file.open', 'file.save', 'file.saveAs'].forEach((id, i) => app.ui.registerMenuItem({ menu: 'file', command: id, order: i }));
      }

      if (app.ui && typeof app.ui.registerStatusItem === 'function') {
        app.ui.registerStatusItem({
          id: 'autosave', side: 'end', order: 5,
          render: () => {
            const label = h('span', { class: 'apb-autosave-status' }, statusText);
            statusListeners.add((text) => { label.textContent = text; });
            return label;
          }
        });
      }

      app.on('ready', () => setTimeout(offerLegacyImport, 300));
    }
  });
})();

/*
 * textedit — inline text editing on the canvas. See ARCHITECTURE.md §7.
 *
 * start(id) turns the rendered element of a node whose element type declares `textEdit` (a props key)
 * into a plain-text editing host in place, so it keeps its rendered styles and works at any zoom.
 * `contenteditable="plaintext-only"` is used when supported (fallback: `true` + plain-text paste).
 * Escape, Mod+Enter and blur commit; Enter inserts a newline for text nodes and commits for single-line
 * types (buttons, …). A commit is one undo step (`docops.update(…, { label: 'Edit text' })`).
 * While editing, store.view.editingText = id and the renderer does not re-render that node.
 */
APB.define('textedit', ['util', 'env', 'schema', 'elements'], function (util, env, schema, elements) {
  'use strict';

  const NON_HOST_TAGS = new Set(['button', 'input', 'select', 'option', 'textarea', 'img', 'svg', 'hr', 'iframe', 'video',
    'audio', 'canvas', 'summary', 'details', 'table', 'ul', 'ol', 'tr', 'thead', 'tbody']);
  const BLOCK_TAGS = new Set(['div', 'p', 'li', 'section', 'article', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

  let plaintextSupport = null;

  function supportsPlaintextOnly(doc) {
    if (plaintextSupport !== null) return plaintextSupport;
    try {
      const probe = doc.createElement('div');
      probe.contentEditable = 'plaintext-only';
      plaintextSupport = probe.contentEditable === 'plaintext-only';
    } catch (_) {
      plaintextSupport = false;
    }
    return plaintextSupport;
  }

  /** Plain text of an editing host (text nodes, <br> and block boundaries → newlines). */
  function readText(host, normalizeSpaces) {
    let out = '';
    const walk = (n) => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3) {
          out += c.data;
        } else if (c.nodeType === 1) {
          const tag = c.localName;
          if (tag === 'br') { out += '\n'; continue; }
          const block = BLOCK_TAGS.has(tag);
          if (block && out && !out.endsWith('\n')) out += '\n';
          walk(c);
        }
      }
    };
    walk(host);
    // A trailing <br> placeholder after a final line break is not content.
    if (host.lastChild && host.lastChild.nodeName === 'BR' && out.endsWith('\n\n')) out = out.slice(0, -1);
    if (normalizeSpaces) out = out.replace(/ /g, ' ');
    return out;
  }

  /** Deepest element without element children whose text equals `text` (or null). */
  function findTextElement(root, text) {
    if (root.textContent !== text) return null;
    let cur = root;
    for (;;) {
      if (!cur.firstElementChild) return cur;
      const kids = Array.from(cur.children).filter((k) => k.textContent.length > 0);
      if (kids.length !== 1 || kids[0].textContent !== text || kids[0].hasAttribute('data-node-id')) return null;
      cur = kids[0];
    }
  }

  /** create({ app, canvas }) → { start(id), stop(commit = true), active(), host() , destroy() } */
  function create(opts) {
    const o = opts || {};
    const app = o.app;
    const canvas = o.canvas;
    const store = app.store;
    const offs = [];
    let session = null;
    let destroyed = false;

    function renderer() {
      return canvas && canvas.renderer ? canvas.renderer : null;
    }

    function baseBp(doc) {
      const bps = doc.settings && doc.settings.breakpoints;
      return bps && bps.length ? bps[0].id : undefined;
    }

    function selectAll(host) {
      const doc = host.ownerDocument;
      const sel = doc.getSelection ? doc.getSelection() : null;
      if (!sel) return;
      const range = doc.createRange();
      range.selectNodeContents(host);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function insertText(text) {
      if (!session) return;
      const doc = session.host.ownerDocument;
      let ok = false;
      try { ok = doc.execCommand('insertText', false, text); } catch (_) { ok = false; }
      if (ok) return;
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!session.host.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const node = doc.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function onKeyDown(e) {
      if (!session || e.isComposing || e.keyCode === 229) return;
      const mod = env.mac ? e.metaKey : e.ctrlKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stop(true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (mod || !session.multiline) stop(true);
        else insertText('\n');
      }
    }

    function onPaste(e) {
      if (!session) return;
      const data = e.clipboardData;
      if (!data) return;
      e.preventDefault();
      let text = String(data.getData('text/plain') || '').replace(/\r\n?/g, '\n');
      if (!session.multiline) text = text.replace(/\n+/g, ' ');
      if (text) insertText(text);
    }

    function onDrop(e) {
      e.preventDefault();
    }

    function onBlur() {
      if (session) stop(true);
    }

    /** start(id) → true when editing started. */
    function start(id) {
      if (destroyed) return false;
      if (session) {
        if (session.id === id) return true;
        stop(true);
      }
      const doc = store.doc;
      const node = store.node(id);
      if (!node) return false;
      const def = elements.get(node.type);
      const key = def && typeof def.textEdit === 'string' ? def.textEdit : null;
      if (!key) return false;
      if (app.docops && typeof app.docops.isLocked === 'function' && app.docops.isLocked(doc, id)) return false;
      const r = renderer();
      if (!r) return false;
      r.flush();
      const el = r.el(id);
      if (!el || !el.isConnected) return false;

      const view = store.view;
      const eff = schema.effectiveNode(doc, node, view.bp) || node;
      const props = util.isPlainObject(eff.props) ? eff.props : {};
      const original = props[key] === null || props[key] === undefined ? '' : String(props[key]);
      const hadHTML = key === 'text' && typeof props.html === 'string' && props.html !== '';
      const ownerDoc = el.ownerDocument;

      let host = null;
      let injected = false;
      if (hadHTML) {
        const inner = el.firstElementChild && el.children.length === 1 && el.firstElementChild.localName === 'a' ? el.firstElementChild : null;
        host = inner || el;
      } else {
        host = findTextElement(el, original);
      }
      if (host && NON_HOST_TAGS.has(host.localName)) {
        const span = ownerDoc.createElement('span');
        span.className = 'apb-textedit-host';
        host.replaceChildren(span);
        host = span;
        injected = true;
      } else if (!host) {
        const span = ownerDoc.createElement('span');
        span.className = 'apb-textedit-host';
        el.replaceChildren(span);
        host = span;
        injected = true;
      }

      r.setEditing(id);
      if (injected || hadHTML || host.textContent !== original) host.textContent = original;

      const plain = supportsPlaintextOnly(ownerDoc);
      const multiline = node.type === 'text' || def.textMultiline === true;
      const bps = (doc.settings && doc.settings.breakpoints) || [];
      const bpProps = Array.isArray(def.bpProps) ? def.bpProps : [];
      const writeBp = view.bp && bpProps.includes(key) ? view.bp : baseBp(doc);
      host.setAttribute('contenteditable', plain ? 'plaintext-only' : 'true');
      host.setAttribute('spellcheck', 'true');
      host.setAttribute('role', 'textbox');
      host.setAttribute('aria-multiline', multiline ? 'true' : 'false');
      host.setAttribute('aria-label', 'Edit text: ' + (node.name || def.label || node.type));
      el.classList.add('apb-editing');

      session = { id, key, el, host, original, hadHTML, plain, multiline, bp: bps.length ? writeBp : undefined, listeners: [] };
      const listen = (type, fn) => {
        host.addEventListener(type, fn);
        session.listeners.push(() => host.removeEventListener(type, fn));
      };
      listen('keydown', onKeyDown);
      listen('paste', onPaste);
      listen('drop', onDrop);
      listen('blur', onBlur);

      if (store.view.editingText !== id) store.setView({ editingText: id });
      try { host.focus({ preventScroll: true }); } catch (_) { host.focus(); }
      selectAll(host);
      return true;
    }

    /** stop(commit = true) → true when the text changed and was committed. */
    function stop(commit) {
      const s = session;
      if (!s) return false;
      session = null;
      const text = readText(s.host, !s.plain);
      s.listeners.forEach((off) => off());
      const ownerDoc = s.host.ownerDocument;
      const hadFocus = ownerDoc.activeElement === s.host;
      s.host.removeAttribute('contenteditable');
      s.host.removeAttribute('role');
      s.host.removeAttribute('aria-multiline');
      s.host.removeAttribute('aria-label');
      s.host.removeAttribute('spellcheck');
      s.el.classList.remove('apb-editing');
      const sel = ownerDoc.getSelection ? ownerDoc.getSelection() : null;
      if (sel && sel.rangeCount && s.host.contains(sel.anchorNode)) sel.removeAllRanges();
      if (hadFocus && canvas && canvas.el && typeof canvas.el.focus === 'function') canvas.el.focus({ preventScroll: true });

      const r = renderer();
      if (r) r.setEditing(null);
      if (store.view.editingText) store.setView({ editingText: null });

      const exists = !!store.node(s.id);
      if (commit === false || !exists || text === s.original) return false;
      const patch = {};
      patch['props.' + s.key] = text;
      if (s.hadHTML) patch['props.html'] = null;
      if (app.docops && typeof app.docops.update === 'function') {
        app.docops.update(store, [s.id], patch, { label: 'Edit text', bp: s.bp });
      } else {
        store.transact('Edit text', (tx) => tx.updateNode(s.id, { props: { [s.key]: text } }, { bp: s.bp }));
      }
      return true;
    }

    offs.push(store.on('change', () => {
      if (session && !store.node(session.id)) stop(false);
    }));
    offs.push(store.on('view', (p) => {
      if (!session) return;
      const ch = p.changed || [];
      if (ch.includes('pageId') || ch.includes('bp') || ch.includes('component')) stop(true);
      else if (ch.includes('editingText') && p.view.editingText !== session.id) stop(true);
    }));

    function destroy() {
      if (destroyed) return;
      stop(true);
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
    }

    return {
      start,
      stop,
      active: () => (session ? session.id : null),
      host: () => (session ? session.host : null),
      destroy
    };
  }

  return { create, readText };
});

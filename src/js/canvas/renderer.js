/*
 * renderer — document → editor DOM inside the artboard. See ARCHITECTURE.md §7.
 *
 * Incremental keyed rendering: store 'change' events mark node ids dirty (plus parents on structural
 * changes); flush() (normally once per animation frame) re-renders only those nodes. Each node is
 * rendered from its effective node at the active breakpoint: elements.get(type).vnode(eff, ctx) +
 * style.nodeDecls(…, { mode: 'editor' }) → vdom.patch into the node's own element. Child node elements
 * are placed into the slot element of their container (elements reused by id, moved only when the order
 * changed). A per-node memo (node object identity + parent layout key + breakpoint + global version)
 * skips unchanged nodes entirely, so a full re-render of an unchanged document is cheap.
 */
APB.define('renderer', ['util', 'schema', 'sanitize', 'elements', 'style', 'vdom'], function (util, schema, sanitize, elements, style, vdom) {
  'use strict';

  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const GROUPING_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'document', '-moz-document', 'starting-style']);
  const DROP_AT_RULES = new Set(['import', 'charset', 'namespace']);
  const ROOT_SELECTOR_RE = /^(?:(?:html|:root)(?![\w-])(?:\s*>\s*|\s+)body(?![\w-])|(?:html|:root|body)(?![\w-]))/i;

  /* ------------------------------------------------------- user CSS scoping */

  function stripComments(css) {
    let out = '';
    let q = '';
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (q) {
        out += c;
        if (c === '\\' && i + 1 < css.length) out += css[++i];
        else if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        i = end < 0 ? css.length : end + 1;
        out += ' ';
        continue;
      }
      out += c;
    }
    return out;
  }

  /** Top-level rules: [{ prelude, body }] (body null for statements such as `@layer a;`). */
  function splitRules(css) {
    const rules = [];
    let depth = 0;
    let q = '';
    let start = 0;
    let open = -1;
    let paren = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      else if (c === '{') {
        if (depth === 0) open = i;
        depth++;
      } else if (c === '}') {
        if (depth === 0) { start = i + 1; continue; }
        depth--;
        if (depth === 0) {
          rules.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1, i) });
          start = i + 1;
        }
      } else if (c === ';' && depth === 0 && paren === 0) {
        const s = css.slice(start, i).trim();
        if (s) rules.push({ prelude: s, body: null });
        start = i + 1;
      }
    }
    if (depth > 0 && open >= 0) rules.push({ prelude: css.slice(start, open).trim(), body: css.slice(open + 1) });
    return rules;
  }

  function splitSelectors(sel) {
    const out = [];
    let depth = 0;
    let q = '';
    let start = 0;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      else if (c === ',' && depth === 0) { out.push(sel.slice(start, i)); start = i + 1; }
    }
    out.push(sel.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function scopeSelector(sel, scopeSel, useScope) {
    if (ROOT_SELECTOR_RE.test(sel)) return sel.replace(ROOT_SELECTOR_RE, useScope ? ':scope' : scopeSel);
    if (useScope) return sel;
    return scopeSel + ' ' + sel;
  }

  function scopeRules(css, useScope, scopeSel) {
    const hoisted = [];
    const inner = [];
    for (const r of splitRules(css)) {
      const pre = r.prelude;
      if (!pre && r.body === null) continue;
      if (pre.charAt(0) === '@') {
        const name = ((/^@([\w-]+)/.exec(pre) || [])[1] || '').toLowerCase();
        if (r.body === null) {
          if (!DROP_AT_RULES.has(name)) hoisted.push(pre + ';');
          continue;
        }
        if (GROUPING_AT_RULES.has(name)) {
          const sub = scopeRules(r.body, useScope, scopeSel);
          if (sub.inner) inner.push(pre + ' {\n' + sub.inner + '\n}');
          if (sub.hoisted) hoisted.push(pre + ' {\n' + sub.hoisted + '\n}');
          continue;
        }
        if (name === 'scope') {
          if (useScope) inner.push(pre + ' {' + r.body + '}');
          continue;
        }
        if (name === 'property' && /^@property\s+--apb-/i.test(pre)) continue;
        hoisted.push(pre + ' {' + r.body + '}');
        continue;
      }
      const sels = splitSelectors(pre).map((s) => scopeSelector(s, scopeSel, useScope));
      if (sels.length) inner.push(sels.join(', ') + ' {' + r.body + '}');
    }
    return { hoisted: hoisted.join('\n'), inner: inner.join('\n') };
  }

  function supportsAtScope() {
    try { return typeof CSSScopeRule === 'function'; } catch (_) { return false; }
  }

  /**
   * scopeCSS(css, { scope = '.apb-artboard', atScope }) → CSS limited to the artboard: wrapped in
   * `@scope (scope) { … }` when supported (html/body/:root selectors → :scope), otherwise every selector
   * is prefixed. @keyframes/@font-face/… are hoisted; @import/@charset/@namespace are dropped.
   */
  function scopeCSS(css, opts) {
    const o = opts || {};
    const scopeSel = typeof o.scope === 'string' && o.scope ? o.scope : '.apb-artboard';
    const useScope = typeof o.atScope === 'boolean' ? o.atScope : supportsAtScope();
    const r = scopeRules(stripComments(String(css || '')), useScope, scopeSel);
    if (useScope) return [r.hoisted, r.inner ? '@scope (' + scopeSel + ') {\n' + r.inner + '\n}' : ''].filter(Boolean).join('\n');
    return [r.hoisted, r.inner].filter(Boolean).join('\n');
  }

  /* --------------------------------------------------------------- vnodes */

  function childList(v) {
    return Array.isArray(v.children)
      ? v.children.filter((c) => typeof c === 'string' || typeof c === 'number' || (c && typeof c === 'object'))
      : [];
  }

  /** Index path (through filtered children) to the slot VNode (breadth-first, like vdom). */
  function slotPathOf(v) {
    if (v.slot) return [];
    const queue = childList(v).map((c, i) => ({ c, path: [i] }));
    while (queue.length) {
      const item = queue.shift();
      if (!item.c || typeof item.c !== 'object') continue;
      if (item.c.slot) return item.path;
      childList(item.c).forEach((k, i) => queue.push({ c: k, path: item.path.concat(i) }));
    }
    return [];
  }

  function locate(el, path) {
    let cur = el;
    for (const i of path) {
      const next = cur && cur.childNodes[i];
      if (!next || next.nodeType !== 1) return el;
      cur = next;
    }
    return cur;
  }

  function childContextKey(eff) {
    if (!eff) return 'root';
    const l = eff.layout;
    return l && l.mode === 'stack' ? 's|' + (l.dir === 'row' ? 'r' : 'c') + '|' + (l.align || '') : 'f';
  }

  function isNodeEl(n) {
    return !!n && n.nodeType === 1 && n.hasAttribute('data-node-id');
  }

  function nextNodeEl(n) {
    let cur = n ? n.nextSibling : null;
    while (cur && !isNodeEl(cur)) cur = cur.nextSibling;
    return cur;
  }

  /** Place child node elements into slot in order; node elements not in `kids` are removed. */
  function placeChildren(slot, kids) {
    let ref = slot.firstChild;
    while (ref && !isNodeEl(ref)) ref = ref.nextSibling;
    for (const k of kids) {
      if (k === ref) { ref = nextNodeEl(ref); continue; }
      slot.insertBefore(k, ref);
    }
    while (ref) {
      const next = nextNodeEl(ref);
      ref.remove();
      ref = next;
    }
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, (c) => '\\' + c);
  }

  /* --------------------------------------------------------------- create */

  /**
   * create({ app, artboard, requestFrame, onRender }) → renderer API.
   * `requestFrame()` schedules flush (default: own rAF batch). `onRender({ full, ids, ms })` runs after
   * every DOM update.
   */
  function create(opts) {
    const o = opts || {};
    const app = o.app;
    const store = app.store;
    const artboard = o.artboard;
    const ownerDoc = artboard.ownerDocument || document;
    const requestFrame = typeof o.requestFrame === 'function' ? o.requestFrame : util.rafBatch(() => flush());
    const onRender = typeof o.onRender === 'function' ? o.onRender : null;

    const els = new Map();
    const slots = new Map();
    const memo = new Map();
    const sigs = new Map();
    const instances = new Set();
    const offs = [];

    let dirty = new Set();
    let needAll = true;
    let cssDirty = true;
    let rootCheck = false;
    let gv = 0;
    let instVersion = 0;
    let rootId = null;
    let pageId = null;
    let componentId = null;
    let bpId;
    let bpDef = null;
    let editingId = null;
    let reveal = new Set();
    let lastMs = 0;
    let lastCount = 0;
    let destroyed = false;
    let styleTokens = null;
    let styleUser = null;

    /* ------------------------------------------------------------ context */

    function resolveRoot() {
      const doc = store.doc;
      const view = store.view;
      bpDef = style.breakpoint(doc, view.bp) || null;
      bpId = bpDef ? bpDef.id : undefined;
      const comps = doc.components || {};
      if (typeof view.component === 'string' && own(comps, view.component) && comps[view.component] && own(doc.nodes, comps[view.component].root)) {
        componentId = view.component;
        rootId = comps[componentId].root;
        pageId = view.pageId;
        return;
      }
      componentId = null;
      const pages = Array.isArray(doc.pages) ? doc.pages : [];
      const page = pages.find((p) => p.id === view.pageId) || pages[0] || null;
      pageId = page ? page.id : null;
      rootId = page && own(doc.nodes, page.root) ? page.root : null;
    }

    function assetURL(id) {
      const doc = store.doc;
      let src = '';
      const svc = app.services && app.services.assets;
      if (svc && typeof svc.url === 'function') {
        try { src = svc.url(id) || ''; } catch (_) { src = ''; }
      }
      if (!src && doc.assets && own(doc.assets, id) && doc.assets[id] && typeof doc.assets[id].src === 'string') src = doc.assets[id].src;
      return src ? (sanitize.url(src, 'image') || sanitize.url(src, 'media')) : '';
    }

    function iconFor(name) {
      if (typeof APB === 'undefined' || !APB.has('icons')) return null;
      try {
        const icons = APB.require('icons');
        return icons && typeof icons.svg === 'function' ? icons.svg(name) : null;
      } catch (_) {
        return null;
      }
    }

    function makeCtx(doc, node, eff) {
      return {
        mode: 'editor', doc, bp: bpId, breakpoint: bpDef, effective: eff, node, virtual: false,
        withIds: true, includeHidden: false, classFor: null,
        assetURL, resolveURL: sanitize.url, sanitizeHTML: sanitize.html,
        escape: util.escapeHTML, icon: iconFor, cssValue: style.cssValue
      };
    }

    function buildVNode(doc, node, eff, parentEff, revealed) {
      const vEff = revealed ? Object.assign({}, eff, { hidden: false }) : eff;
      const def = elements.get(eff.type);
      let v = null;
      if (def) {
        try {
          v = def.vnode(vEff, makeCtx(doc, node, vEff));
        } catch (err) {
          console.error('[APB] vnode() of element type "' + eff.type + '" threw:', err);
        }
      }
      if (!util.isPlainObject(v)) v = { tag: 'div', attrs: def ? {} : { 'data-unknown-type': String(eff.type) } };
      v = Object.assign({}, v, { attrs: util.isPlainObject(v.attrs) ? Object.assign({}, v.attrs) : {} });
      const decls = style.nodeDecls(doc, vEff, bpId, {
        mode: 'editor', parentEff, bp: bpDef, extra: v.style, assetURL, effective: true
      });
      delete v.style;

      const a = v.attrs;
      const at = util.isPlainObject(eff.attrs) ? eff.attrs : {};
      const cls = [];
      if (typeof a.class === 'string' && a.class) cls.push(a.class);
      cls.push('apb-node', 'apb-t-' + String(eff.type).replace(/[^\w-]/g, '_'));
      if (typeof at.className === 'string' && at.className) {
        const c = sanitize.className(at.className);
        if (c) cls.push(c);
      }
      if (revealed) cls.push('apb-hidden-preview');
      if (eff.locked) cls.push('apb-locked');
      a.class = util.uniq(cls.join(' ').split(/\s+/).filter(Boolean)).join(' ');
      if (typeof at.htmlId === 'string' && at.htmlId) {
        const hid = sanitize.id(at.htmlId);
        if (hid && !/^apb-/i.test(hid)) a.id = hid;
      }
      if (typeof at.ariaLabel === 'string' && at.ariaLabel.trim()) a['aria-label'] = at.ariaLabel.trim();
      if (typeof at.role === 'string' && /^[a-z]+(?: [a-z]+)*$/.test(at.role.trim())) a.role = at.role.trim();
      if (typeof at.title === 'string' && at.title.trim()) a.title = at.title.trim();
      a['data-node-id'] = eff.id;
      if (decls.size) v.style = style.declsToObject(decls);

      const container = (def ? !!def.container : true) && Array.isArray(eff.children);
      return {
        v,
        container,
        slotPath: container ? slotPathOf(v) : null,
        sig: container ? JSON.stringify(v) : ''
      };
    }

    /* ------------------------------------------------------------- render */

    function forget(id) {
      const el = els.get(id);
      if (el && el.parentNode) el.remove();
      els.delete(id);
      slots.delete(id);
      memo.delete(id);
      sigs.delete(id);
      instances.delete(id);
    }

    function renderNode(doc, id, parentEff, deep, seen, processed) {
      const node = doc.nodes[id];
      if (!node) return null;
      if (seen) seen.add(id);
      if (processed) processed.add(id);
      const eff = schema.effectiveNode(doc, node, bpId) || node;
      const revealed = !!eff.hidden && reveal.has(id);
      const pkey = childContextKey(parentEff);
      const isInstance = eff.type === 'instance';
      if (isInstance) instances.add(id);
      let el = els.get(id);
      const m = memo.get(id);
      const stale = !el || !m || m.node !== node || m.pkey !== pkey || m.bp !== bpId || m.revealed !== revealed ||
        m.gv !== gv || (isInstance && m.inst !== instVersion);
      let container = Array.isArray(eff.children) && (elements.get(eff.type) ? !!elements.get(eff.type).container : true);

      if (stale && !(editingId === id && el)) {
        const built = buildVNode(doc, node, eff, parentEff, revealed);
        container = built.container;
        if (!el) {
          el = vdom.toDOM(built.v);
          if (!el) return null;
          els.set(id, el);
          if (container) { sigs.set(id, built.sig); slots.set(id, locate(el, built.slotPath)); }
        } else if (container) {
          if (sigs.get(id) !== built.sig || !slots.has(id)) {
            const next = vdom.patch(el, built.v) || el;
            if (next !== el) { els.set(id, next); el = next; }
            sigs.set(id, built.sig);
            slots.set(id, locate(el, built.slotPath));
          }
        } else {
          const next = vdom.patch(el, built.v) || el;
          if (next !== el) { els.set(id, next); el = next; }
          sigs.delete(id);
          slots.delete(id);
        }
        memo.set(id, { node, pkey, bp: bpId, revealed, gv, inst: instVersion });
      }

      if (container && Array.isArray(eff.children)) {
        const slot = slots.get(id) || el;
        const childKey = childContextKey(eff);
        const kids = [];
        for (const cid of eff.children) {
          const child = doc.nodes[cid];
          if (!child || child.parent !== id) continue;
          let cel = els.get(cid);
          if (deep || !cel) {
            cel = renderNode(doc, cid, eff, true, seen, processed);
          } else if (stale && !(processed && processed.has(cid))) {
            const mm = memo.get(cid);
            if (!mm || mm.pkey !== childKey) cel = renderNode(doc, cid, eff, false, seen, processed);
          }
          if (cel) kids.push(cel);
        }
        placeChildren(slot, kids);
      }
      return els.get(id) || null;
    }

    function refreshDocCSS() {
      cssDirty = false;
      const doc = store.doc;
      const head = ownerDoc.head || ownerDoc.documentElement;
      if (!styleTokens || !styleTokens.isConnected) {
        styleTokens = ownerDoc.getElementById('apb-tokens-css');
        if (!styleTokens || styleTokens.localName !== 'style') {
          styleTokens = ownerDoc.createElement('style');
          styleTokens.id = 'apb-tokens-css';
          head.appendChild(styleTokens);
        }
      }
      if (!styleUser || !styleUser.isConnected) {
        styleUser = ownerDoc.getElementById('apb-user-css');
        if (!styleUser || styleUser.localName !== 'style') {
          styleUser = ownerDoc.createElement('style');
          styleUser.id = 'apb-user-css';
          head.appendChild(styleUser);
        }
      }
      const tokens = style.tokensCSS(doc);
      const tokenText = tokens ? tokens.replace(/^:root\s*\{/, '.apb-artboard{') : '';
      if (styleTokens.textContent !== tokenText) styleTokens.textContent = tokenText;
      const raw = doc.settings && typeof doc.settings.globalCSS === 'string' ? doc.settings.globalCSS : '';
      let userText = '';
      if (raw.trim()) {
        try {
          userText = scopeCSS(sanitize.stylesheet(raw));
        } catch (err) {
          console.error('[APB] global CSS could not be applied:', err);
          userText = '';
        }
      }
      if (styleUser.textContent !== userText) styleUser.textContent = userText;
    }

    function finish(result, t0) {
      lastMs = now() - t0;
      result.ms = lastMs;
      if (onRender) {
        try { onRender(result); } catch (err) { console.error('[APB] renderer onRender listener failed:', err); }
      }
      return result;
    }

    /** renderAll({ rebuild }) — synchronous full render (rebuild: discard all elements first). → ms */
    function renderAll(renderOpts) {
      if (destroyed) return 0;
      const t0 = now();
      if (renderOpts && renderOpts.rebuild) {
        els.clear(); slots.clear(); memo.clear(); sigs.clear();
      }
      needAll = false;
      rootCheck = false;
      dirty.clear();
      resolveRoot();
      refreshDocCSS();
      reveal = computeReveal();
      instances.clear();
      const doc = store.doc;
      const seen = new Set();
      const rootEl = rootId ? renderNode(doc, rootId, null, true, seen, null) : null;
      if (rootEl) {
        if (artboard.firstChild !== rootEl || artboard.childNodes.length !== 1) artboard.replaceChildren(rootEl);
      } else if (artboard.firstChild) {
        artboard.replaceChildren();
      }
      for (const id of Array.from(els.keys())) if (!seen.has(id)) forget(id);
      lastCount = seen.size;
      finish({ full: true, ids: null }, t0);
      return lastMs;
    }

    /** Apply pending changes now. → null (nothing to do) | { full, ids, ms } */
    function flush() {
      if (destroyed) return null;
      if (needAll) { renderAll(); return { full: true, ids: null, ms: lastMs }; }
      if (rootCheck) {
        rootCheck = false;
        const prevRoot = rootId;
        const prevComp = componentId;
        resolveRoot();
        if (rootId !== prevRoot || componentId !== prevComp) { renderAll(); return { full: true, ids: null, ms: lastMs }; }
      }
      if (cssDirty) refreshDocCSS();
      if (!dirty.size) return null;
      const t0 = now();
      const doc = store.doc;
      const ids = dirty;
      dirty = new Set();
      const depth = new Map();
      const list = [];
      let masterChanged = false;
      const comps = doc.components || {};
      const isMasterRoot = (id) => Object.keys(comps).some((k) => comps[k] && comps[k].root === id);
      const topOf = (id) => {
        const anc = schema.ancestors(doc, id);
        return { top: anc.length ? anc[anc.length - 1] : id, depth: anc.length };
      };
      for (const id of ids) {
        if (!own(doc.nodes, id)) { forget(id); continue; }
        const t = topOf(id);
        if (t.top !== rootId) {
          if (isMasterRoot(t.top)) masterChanged = true;
          if (els.has(id)) forget(id);
          continue;
        }
        depth.set(id, t.depth);
        list.push(id);
      }
      if (masterChanged && instances.size) {
        instVersion++;
        for (const iid of instances) {
          if (!own(doc.nodes, iid) || depth.has(iid)) continue;
          const t = topOf(iid);
          if (t.top !== rootId) continue;
          depth.set(iid, t.depth);
          list.push(iid);
        }
      }
      list.sort((a, b) => depth.get(a) - depth.get(b));
      const processed = new Set();
      for (const id of list) {
        if (processed.has(id)) continue;
        const node = doc.nodes[id];
        const parentEff = node.parent ? schema.effectiveNode(doc, node.parent, bpId) : null;
        const el = renderNode(doc, id, parentEff, false, null, processed);
        if (!el) continue;
        if (id === rootId) {
          if (artboard.firstChild !== el || artboard.childNodes.length !== 1) artboard.replaceChildren(el);
        } else if (!el.parentNode && node.parent && own(doc.nodes, node.parent)) {
          const parent = doc.nodes[node.parent];
          const grand = parent.parent ? schema.effectiveNode(doc, parent.parent, bpId) : null;
          renderNode(doc, parent.id, grand, false, null, null);
        }
      }
      return finish({ full: false, ids: list }, t0);
    }

    /* ------------------------------------------------------------ queries */

    function el(id) {
      if (typeof id !== 'string' || !id) return null;
      if (els.has(id)) return els.get(id);
      if (id.indexOf(':') > 0) return artboard.querySelector('[data-node-id="' + cssEscape(id) + '"]');
      return null;
    }

    function worldRotation(id) {
      const doc = store.doc;
      let total = 0;
      let cur = own(doc.nodes, id) ? doc.nodes[id] : null;
      const guard = new Set();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        const e = schema.effectiveNode(doc, cur, bpId);
        if (e && Number.isFinite(e.rotation)) total += e.rotation;
        cur = cur.parent && own(doc.nodes, cur.parent) ? doc.nodes[cur.parent] : null;
      }
      total %= 360;
      if (total > 180) total -= 360;
      if (total <= -180) total += 360;
      return total;
    }

    /**
     * worldRect(id) → { x, y, w, h, rotation } in page coordinates (independent of the camera):
     * the unrotated box whose centre is the node's true centre; `rotation` = accumulated rotation.
     * Virtual ids ('instanceId:masterId') are supported. null when not rendered/displayed.
     */
    function worldRect(id) {
      if (needAll || dirty.size || rootCheck) flush();
      const node = el(id);
      if (!node || !node.isConnected || !artboard.contains(node)) return null;
      if (!node.getClientRects().length) return null;
      const ab = artboard.getBoundingClientRect();
      const layoutW = artboard.offsetWidth;
      const scale = layoutW > 0 && ab.width > 0 ? ab.width / layoutW : 1;
      const r = node.getBoundingClientRect();
      const realId = String(id).split(':')[0];
      const rotation = worldRotation(realId);
      const cx = (r.left + r.width / 2 - ab.left) / scale;
      const cy = (r.top + r.height / 2 - ab.top) / scale;
      let w;
      let h;
      if (!rotation) {
        w = r.width / scale;
        h = r.height / scale;
      } else {
        const cs = (ownerDoc.defaultView || window).getComputedStyle(node);
        w = parseFloat(cs.width);
        h = parseFloat(cs.height);
        if (!Number.isFinite(w)) w = node.offsetWidth || 0;
        if (!Number.isFinite(h)) h = node.offsetHeight || 0;
        if (cs.boxSizing !== 'border-box') {
          w += (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
          h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        }
      }
      return { x: cx - w / 2, y: cy - h / 2, w, h, rotation };
    }

    /** Axis-aligned page-coordinate bounds of several nodes (rotation included) or null. */
    function bounds(ids) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const r = worldRect(id);
        if (!r) continue;
        const rad = (r.rotation * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const hw = (r.w * cos + r.h * sin) / 2;
        const hh = (r.w * sin + r.h * cos) / 2;
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        minX = Math.min(minX, cx - hw);
        minY = Math.min(minY, cy - hh);
        maxX = Math.max(maxX, cx + hw);
        maxY = Math.max(maxY, cy + hh);
      }
      return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /** Click target per §7: nodes inside a group select the outermost group outside the current context. */
    function selectable(id) {
      const doc = store.doc;
      if (!own(doc.nodes, id)) return null;
      const ctx = store.view.context;
      const ctxChain = ctx && own(doc.nodes, ctx) ? new Set([ctx].concat(schema.ancestors(doc, ctx))) : null;
      let pick = id;
      for (const a of schema.ancestors(doc, id)) {
        const n = doc.nodes[a];
        if (n && n.type === 'group' && !(ctxChain && ctxChain.has(a))) pick = a;
      }
      return pick;
    }

    function ignored(id, ignoreSet) {
      if (!ignoreSet) return false;
      if (ignoreSet.has(id)) return true;
      return schema.ancestors(store.doc, id).some((a) => ignoreSet.has(a));
    }

    /**
     * nodeAt(clientX, clientY, { deep, ignore: ids, filter(id) → bool, virtual }) → id | null.
     * deep: deepest node; otherwise the selectable node (outermost group). Virtual instance ids map to
     * the instance id unless `virtual: true`. With `filter`, walks up from the hit node until it passes.
     */
    function nodeAt(clientX, clientY, q) {
      const opts = q || {};
      if (needAll || dirty.size || rootCheck) flush();
      if (typeof ownerDoc.elementsFromPoint !== 'function') return null;
      const ignoreSet = opts.ignore ? new Set(Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore]) : null;
      const filter = typeof opts.filter === 'function' ? opts.filter : null;
      const doc = store.doc;
      const tried = new Set();
      for (const hit of ownerDoc.elementsFromPoint(clientX, clientY)) {
        if (hit === artboard || !artboard.contains(hit)) continue;
        let cur = hit.closest('[data-node-id]');
        while (cur && cur !== artboard && artboard.contains(cur)) {
          const raw = cur.getAttribute('data-node-id') || '';
          const realId = raw.split(':')[0];
          if (tried.has(raw)) break;
          tried.add(raw);
          if (!own(doc.nodes, realId) || ignored(realId, ignoreSet)) break;
          const candidate = opts.virtual ? raw : realId;
          if (!filter || filter(candidate)) {
            if (opts.deep) return candidate;
            return selectable(realId);
          }
          cur = cur.parentElement ? cur.parentElement.closest('[data-node-id]') : null;
        }
      }
      return null;
    }

    function computeReveal() {
      const doc = store.doc;
      const s = new Set();
      for (const id of store.selection) {
        if (!own(doc.nodes, id)) continue;
        s.add(id);
        for (const a of schema.ancestors(doc, id)) s.add(a);
      }
      return s;
    }

    function hiddenSomewhere(id) {
      const n = store.doc.nodes[id];
      if (!n) return false;
      if (n.hidden) return true;
      if (util.isPlainObject(n.bp)) for (const k of Object.keys(n.bp)) if (n.bp[k] && n.bp[k].hidden) return true;
      return false;
    }

    /** invalidate(ids | 'all') — mark nodes (or everything, with a global version bump) for re-render. */
    function invalidate(ids) {
      if (ids === undefined || ids === 'all') { gv++; needAll = true; }
      else for (const id of Array.isArray(ids) ? ids : [ids]) if (typeof id === 'string') dirty.add(id);
      requestFrame();
    }

    function setEditing(id) {
      const prev = editingId;
      editingId = typeof id === 'string' && id ? id : null;
      if (prev && prev !== editingId) {
        memo.delete(prev);
        dirty.add(prev);
        requestFrame();
      }
    }

    /* ------------------------------------------------------------- events */

    offs.push(store.on('change', (p) => {
      if (destroyed) return;
      if (p.source === 'replace') { gv++; needAll = true; requestFrame(); return; }
      if (p.global) {
        for (const op of p.ops || []) {
          const k = String(op.path).split('.');
          if (k[0] === 'nodes' || k[0] === 'updatedAt' || k[0] === 'name') continue;
          if (k[0] === 'settings') {
            if (k[1] === 'globalCSS') cssDirty = true;
            else if (k.length === 1 || k[1] === 'breakpoints') { gv++; needAll = true; }
          } else if (k[0] === 'tokens') {
            cssDirty = true;
            if (k.length === 1 || k[1] !== 'colors') { gv++; needAll = true; }
          } else if (k[0] === 'pages') {
            rootCheck = true;
          } else {
            gv++;
            needAll = true;
          }
        }
      }
      const doc = store.doc;
      for (const id of p.nodes || []) {
        dirty.add(id);
        if (p.structure) {
          const n = own(doc.nodes, id) ? doc.nodes[id] : null;
          if (n && n.parent) dirty.add(n.parent);
        }
      }
      if (needAll || dirty.size || cssDirty || rootCheck) requestFrame();
    }));

    offs.push(store.on('view', (p) => {
      if (destroyed) return;
      const ch = p.changed || [];
      if (ch.includes('pageId') || ch.includes('bp') || ch.includes('component')) { needAll = true; requestFrame(); }
    }));

    offs.push(store.on('selection', () => {
      if (destroyed) return;
      const next = computeReveal();
      let any = false;
      for (const id of next) if (!reveal.has(id) && hiddenSomewhere(id)) { dirty.add(id); any = true; }
      for (const id of reveal) if (!next.has(id) && hiddenSomewhere(id)) { dirty.add(id); any = true; }
      reveal = next;
      if (any) requestFrame();
    }));

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      offs.splice(0).forEach((off) => { try { off(); } catch (_) { /* ignore */ } });
      els.clear(); slots.clear(); memo.clear(); sigs.clear(); instances.clear();
      artboard.replaceChildren();
      if (styleTokens) styleTokens.textContent = '';
      if (styleUser) styleUser.textContent = '';
    }

    return {
      renderAll, flush, el, worldRect, bounds, nodeAt, selectable, invalidate, setEditing, destroy, scopeCSS,
      get rootId() { if (needAll || rootCheck) resolveRoot(); return rootId; },
      get pageId() { return pageId; },
      get componentId() { return componentId; },
      get bp() { return bpId; },
      get editing() { return editingId; },
      get pending() { return needAll || rootCheck || cssDirty || dirty.size > 0; },
      stats: () => ({ lastMs, nodes: lastCount, elements: els.size })
    };
  }

  return { create, scopeCSS };
});

/* @node-testable */
/*
 * vdom — VNode → HTML string / DOM, plus the full-tree builder shared by the editor renderer and
 * the exporters (including component instance expansion). See ARCHITECTURE.md §5.4, §6.9.1.
 *
 * toHTML/buildTree/expandInstance are pure and work in Node; toDOM/patch return null (no-op)
 * when there is no DOM.
 */
APB.define('vdom', ['util', 'schema', 'sanitize', 'elements', 'style', 'actions', 'motion'], function (util, schema, sanitize, elements, style, actionsMod, motionMod) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  /** Never emitted (rendered as div, or g inside svg). */
  const BANNED_TAGS = new Set(['script', 'style', 'base', 'meta', 'link', 'noscript', 'template', 'object', 'embed', 'applet',
    'frame', 'frameset', 'xmp', 'plaintext', 'noembed', 'noframes', 'foreignobject', 'use', 'animate', 'set',
    'animatetransform', 'animatemotion', 'handler', 'listener']);
  const TAG_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;
  const ATTR_RE = /^[a-zA-Z_:][a-zA-Z0-9_:.-]{0,63}$/;
  const STYLE_KEY_RE = /^-?-?[A-Za-z][A-Za-z0-9-]*$/;
  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'background', 'xlink:href',
    'srcset', 'ping', 'longdesc', 'manifest', 'codebase', 'lowsrc', 'dynsrc', 'imagesrcset']);
  const DROP_ATTRS = new Set(['srcdoc', 'is']);
  const PRE_TAGS = new Set(['pre', 'textarea']);
  const STRUCT_TAGS = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'svg', 'g', 'defs', 'select', 'optgroup', 'dl', 'menu']);
  const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'kbd',
    'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'label', 'button',
    'input', 'select', 'textarea']);

  /* ------------------------------------------------------------ helpers */

  function tagName(tag, inSvg) {
    if (typeof tag !== 'string' || !TAG_RE.test(tag)) return inSvg ? 'g' : 'div';
    const lower = tag.toLowerCase();
    if (BANNED_TAGS.has(lower)) return inSvg ? 'g' : 'div';
    return inSvg || lower === 'svg' ? tag : lower;
  }

  function stripInvisible(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 32 || (c >= 127 && c <= 159) || c === 173 || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff) continue;
      out += s[i];
    }
    return out;
  }

  function safeURLValue(tag, name, value) {
    const s = stripInvisible(String(value));
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
    if (!m) return true; // relative reference
    const scheme = m[1].toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'livescript') return false;
    if (scheme === 'data') {
      if (name !== 'src' && name !== 'srcset' && name !== 'poster' && name !== 'imagesrcset') return false;
      if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(s)) return true;
      return tag === 'img' && /^data:image\/svg\+xml[;,]/i.test(s);
    }
    return true;
  }

  function safeURLAttr(tag, name, value) {
    if (name === 'srcset' || name === 'imagesrcset') {
      return String(value).split(',').every((part) => safeURLValue(tag, name, part.trim().split(/\s+/)[0] || ''));
    }
    return safeURLValue(tag, name, value);
  }

  function styleString(st) {
    if (!st) return '';
    const entries = Object.prototype.toString.call(st) === '[object Map]' ? Array.from(st) : (typeof st === 'object' ? Object.entries(st) : []);
    const parts = [];
    for (const [k, v] of entries) {
      if (typeof k !== 'string' || !STYLE_KEY_RE.test(k)) continue;
      const val = style.safeValue(v);
      if (val) parts.push((k.startsWith('--') ? k : util.kebab(k)) + ': ' + val);
    }
    return parts.join('; ');
  }

  /** collectAttrs(vnode, tag) → [[name, value|true]] — validated, URL-checked, style last. */
  function collectAttrs(v, tag) {
    const out = [];
    const attrs = v && v.attrs && typeof v.attrs === 'object' ? v.attrs : {};
    let styleAttr = '';
    for (const name of Object.keys(attrs)) {
      const val = attrs[name];
      if (val === undefined || val === null || val === false) continue;
      if (!ATTR_RE.test(name)) continue;
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || DROP_ATTRS.has(lower)) continue;
      if (lower === 'style') {
        if (typeof val === 'string') styleAttr = sanitize.css(val);
        continue;
      }
      if (val === true) { out.push([name, true]); continue; }
      let s;
      if (Array.isArray(val)) s = val.filter((x) => typeof x === 'string' || typeof x === 'number').join(' ');
      else if (typeof val === 'string' || typeof val === 'number') s = String(val);
      else continue;
      if (URL_ATTRS.has(lower) && !safeURLAttr(String(tag).toLowerCase(), lower, s)) continue;
      out.push([name, s]);
    }
    const css = [styleAttr, styleString(v && v.style)].filter(Boolean).join('; ');
    if (css) out.push(['style', css]);
    return out;
  }

  function mergeDefined(a, b) {
    const out = Object.assign({}, util.isPlainObject(a) ? a : {});
    if (util.isPlainObject(b)) for (const k of Object.keys(b)) if (b[k] !== undefined) out[k] = b[k];
    return out;
  }

  function findSlot(v) {
    if (v.slot) return v;
    const queue = Array.isArray(v.children) ? v.children.slice() : [];
    while (queue.length) {
      const c = queue.shift();
      if (!util.isPlainObject(c)) continue;
      if (c.slot) return c;
      if (Array.isArray(c.children)) queue.push(...c.children);
    }
    return v;
  }

  /* ------------------------------------------------------------- toHTML */

  function render(v, depth, o, inSvg) {
    if (v === null || v === undefined || v === false) return '';
    if (typeof v === 'string' || typeof v === 'number') return util.escapeHTML(v);
    if (typeof v !== 'object') return '';
    const tag = tagName(v.tag, inSvg);
    const svg = inSvg || tag === 'svg';
    let out = '<' + tag;
    for (const [n, val] of collectAttrs(v, tag)) out += val === true ? ' ' + n : ' ' + n + '="' + util.escapeAttr(val) + '"';
    out += '>';
    if (!svg && VOID.has(tag)) return out;
    if (v.text !== undefined && v.text !== null) {
      out += util.escapeHTML(v.text);
    } else if (typeof v.html === 'string') {
      out += v.html;
    } else if (Array.isArray(v.children)) {
      const kids = v.children.filter((c) => c !== null && c !== undefined && c !== false && c !== '');
      const block = o.pretty && kids.length > 0 && !PRE_TAGS.has(tag) &&
        (v.slot || STRUCT_TAGS.has(tag.toLowerCase()) || kids.every((c) => util.isPlainObject(c) && !INLINE_TAGS.has(String(c.tag).toLowerCase())));
      if (block) {
        const pad = ' '.repeat(o.indent * (depth + 1));
        out += '\n' + kids.map((c) => pad + render(c, depth + 1, o, svg)).join('\n') + '\n' + ' '.repeat(o.indent * depth);
      } else {
        out += kids.map((c) => render(c, depth + 1, o, svg)).join('');
      }
    }
    return out + '</' + tag + '>';
  }

  /** toHTML(vnode, { indent = 2, pretty = true }) → string (text and attributes escaped). */
  function toHTML(vnode, opts) {
    const o = opts || {};
    const indent = Number.isFinite(o.indent) ? Math.max(0, Math.floor(o.indent)) : 2;
    const pretty = o.pretty !== false;
    if (Array.isArray(vnode)) return vnode.map((v) => render(v, 0, { indent, pretty }, false)).join(pretty ? '\n' : '');
    return render(vnode, 0, { indent, pretty }, false);
  }

  /* -------------------------------------------------------- toDOM/patch */

  function hasDOM() {
    return typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  }

  const htmlCache = new WeakMap();
  const styleCache = new WeakMap();

  function setContentHTML(el, html, profile) {
    if (htmlCache.get(el) === html) return;
    el.innerHTML = sanitize.html(html, profile || 'html'); // defence in depth: always re-sanitized
    htmlCache.set(el, html);
  }

  function applyAttrs(el, v, tag, keep) {
    const next = collectAttrs(v, tag);
    const names = new Set();
    for (const [n, val] of next) {
      names.add(n.toLowerCase());
      if (n === 'style') {
        if (styleCache.get(el) !== val || !el.hasAttribute('style')) { el.style.cssText = val; styleCache.set(el, val); }
      } else {
        const sv = val === true ? '' : val;
        if (el.getAttribute(n) !== sv) el.setAttribute(n, sv);
      }
    }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (!names.has(n) && !(keep && keep.includes(n))) {
        el.removeAttribute(a.name);
        if (n === 'style') styleCache.delete(el);
      }
    }
  }

  function createEl(v, o, inSvg, doc) {
    if (v === null || v === undefined || v === false) return null;
    if (typeof v === 'string' || typeof v === 'number') return doc.createTextNode(String(v));
    if (typeof v !== 'object') return null;
    const tag = tagName(v.tag, inSvg);
    const svg = inSvg || tag === 'svg';
    const el = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    applyAttrs(el, v, tag, null);
    if (v.text !== undefined && v.text !== null) el.textContent = String(v.text);
    else if (typeof v.html === 'string' && !svg) setContentHTML(el, v.html, v.htmlProfile);
    else if (Array.isArray(v.children)) {
      for (const c of v.children) {
        const child = createEl(c, o, svg, doc);
        if (child) el.appendChild(child);
      }
    }
    if (typeof o.onElement === 'function') o.onElement(el, v);
    return el;
  }

  /** toDOM(vnode, { onElement(el, vnode), document }) → Element | null (null without a DOM). */
  function toDOM(vnode, opts) {
    const o = opts || {};
    const doc = o.document || (hasDOM() ? document : null);
    if (!doc) return null;
    return createEl(vnode, o, !!o.svg, doc);
  }

  function nodeKey(v) {
    return util.isPlainObject(v) && v.attrs && typeof v.attrs['data-node-id'] === 'string' ? v.attrs['data-node-id'] : '';
  }

  function patchChildren(parent, kids, o, svg, doc) {
    const list = (Array.isArray(kids) ? kids : []).filter((c) => c !== null && c !== undefined && c !== false);
    const keyed = new Map();
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === 1 && n.hasAttribute('data-node-id')) keyed.set(n.getAttribute('data-node-id'), n);
    }
    let i = 0;
    for (const child of list) {
      let cur = parent.childNodes[i] || null;
      if (typeof child !== 'object') {
        if (cur && cur.nodeType === 3) { if (cur.data !== String(child)) cur.data = String(child); }
        else parent.insertBefore(doc.createTextNode(String(child)), cur);
        i++;
        continue;
      }
      const key = nodeKey(child);
      if (key && keyed.has(key) && keyed.get(key) !== cur) {
        parent.insertBefore(keyed.get(key), cur);
        cur = keyed.get(key);
      }
      const reusable = cur && cur.nodeType === 1 && (cur.getAttribute('data-node-id') || '') === key;
      if (reusable) patchEl(cur, child, o, svg, doc);
      else {
        const fresh = createEl(child, o, svg, doc);
        if (fresh) parent.insertBefore(fresh, cur);
        else continue;
      }
      i++;
    }
    while (parent.childNodes.length > i) parent.removeChild(parent.lastChild);
  }

  function patchEl(el, v, o, parentSvg, doc) {
    const tag = tagName(v && v.tag, parentSvg);
    const svg = parentSvg || tag === 'svg';
    const same = el.nodeType === 1 && util.isPlainObject(v) &&
      (svg ? el.namespaceURI === SVG_NS && el.localName === tag : el.namespaceURI !== SVG_NS && el.localName === tag);
    if (!same) {
      const fresh = createEl(v, o, parentSvg, doc);
      if (fresh && el.parentNode) el.parentNode.replaceChild(fresh, el);
      return fresh;
    }
    applyAttrs(el, v, tag, o.keepAttrs || null);
    if (v.text !== undefined && v.text !== null) {
      const text = String(v.text);
      htmlCache.delete(el);
      if (!(el.childNodes.length === 1 && el.firstChild.nodeType === 3 && el.firstChild.data === text)) el.textContent = text;
    } else if (typeof v.html === 'string' && !svg) {
      setContentHTML(el, v.html, v.htmlProfile);
    } else {
      htmlCache.delete(el);
      patchChildren(el, v.children, o, svg, doc);
    }
    if (typeof o.onElement === 'function') o.onElement(el, v);
    return el;
  }

  /**
   * patch(el, vnode, { onElement, keepAttrs }) → Element — updates attributes/style/text/children in
   * place when the tag matches (children keyed by data-node-id), otherwise replaces the element.
   */
  function patch(el, vnode, opts) {
    if (!el || !hasDOM()) return el || null;
    const o = opts || {};
    const doc = el.ownerDocument || document;
    const parentSvg = !!(el.parentNode && el.parentNode.namespaceURI === SVG_NS);
    return patchEl(el, vnode, o, parentSvg, doc);
  }

  /* ---------------------------------------------------------- buildTree */

  function defaultAssetURL(doc, id) {
    const a = doc && doc.assets && typeof id === 'string' && Object.prototype.hasOwnProperty.call(doc.assets, id) ? doc.assets[id] : null;
    return a && typeof a.src === 'string' ? (sanitize.url(a.src, 'image') || sanitize.url(a.src, 'media')) : '';
  }

  function makeEnv(doc, o) {
    const bp = style.breakpoint(doc, o.bp);
    const mode = o.mode === 'editor' ? 'editor' : 'export';
    const classFor = typeof o.classFor === 'function' ? o.classFor : null;
    return {
      doc, mode, bpId: bp ? bp.id : undefined, bpDef: bp,
      withIds: o.withIds !== undefined && o.withIds !== null ? !!o.withIds : mode === 'editor',
      includeHidden: !!o.includeHidden,
      classFor,
      onNode: typeof o.onNode === 'function' ? o.onNode : null,
      inlineStyles: o.inlineStyles !== undefined && o.inlineStyles !== null ? !!o.inlineStyles : (mode === 'editor' || !classFor),
      sanitizeHTML: typeof o.sanitizeHTML === 'function' ? o.sanitizeHTML : sanitize.html,
      assetURL: typeof o.assetURL === 'function' ? o.assetURL : (id) => defaultAssetURL(doc, id),
      resolveURL: typeof o.resolveURL === 'function' ? o.resolveURL : sanitize.url,
      icon: typeof o.icon === 'function' ? o.icon : () => null
    };
  }

  function docScope(env) {
    return {
      virtual: false,
      stack: [],
      get: (id) => schema.getNode(env.doc, id),
      eff: (node) => schema.effectiveNode(env.doc, node, env.bpId)
    };
  }

  /**
   * Expansion scope of an instance: virtual copies of the master subtree. The root copy takes the
   * instance id (and its box, visibility, attrs, extra style); inner nodes get `${instanceId}:${masterId}`.
   * Overrides `{ [masterId]: { props, style } }` are applied after the breakpoint cascade.
   */
  function expandScope(doc, inst, bpId, parentScope) {
    const p = inst && util.isPlainObject(inst.props) ? inst.props : {};
    const cid = p.component;
    const comps = doc && util.isPlainObject(doc.components) ? doc.components : {};
    if (typeof cid !== 'string' || !Object.prototype.hasOwnProperty.call(comps, cid) || !comps[cid]) return null;
    const stack = parentScope && Array.isArray(parentScope.stack) ? parentScope.stack : [];
    if (stack.includes(cid) || stack.length >= 16) return null;
    const master = schema.getNode(doc, comps[cid].root);
    if (!master) return null;
    const overrides = util.isPlainObject(p.overrides) ? p.overrides : {};
    const prefix = inst.id + ':';
    const entries = new Map();
    const seen = new Set();
    const visit = (m, parentId, isRoot) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      const id = isRoot ? inst.id : prefix + m.id;
      const copy = Object.assign({}, m, { id, parent: parentId });
      const kids = Array.isArray(m.children) ? m.children.map((c) => schema.getNode(doc, c)).filter(Boolean) : null;
      if (kids) copy.children = kids.map((k) => prefix + k.id);
      entries.set(id, { node: copy, masterId: m.id, root: isRoot });
      if (kids) kids.forEach((k) => visit(k, id, false));
    };
    visit(master, inst.parent === undefined ? null : inst.parent, true);

    const cache = new Map();
    const scope = {
      virtual: true,
      stack: stack.concat(cid),
      component: cid,
      get: (id) => { const e = entries.get(id); return e ? e.node : null; },
      eff: (node) => {
        const e = node && entries.get(node.id);
        if (!e || e.node !== node) return parentScope ? parentScope.eff(node) : schema.effectiveNode(doc, node, bpId);
        if (cache.has(node.id)) return cache.get(node.id);
        const eff = Object.assign({}, schema.effectiveNode(doc, e.node, bpId), { bp: {} });
        const ov = overrides[e.masterId];
        if (util.isPlainObject(ov)) {
          if (util.isPlainObject(ov.props)) eff.props = mergeDefined(eff.props, ov.props);
          if (util.isPlainObject(ov.style)) eff.style = mergeDefined(eff.style, ov.style);
          if (util.isPlainObject(ov.sizing)) eff.sizing = mergeDefined(eff.sizing, ov.sizing);
          if (util.isPlainObject(ov.attrs)) eff.attrs = mergeDefined(eff.attrs, ov.attrs);
          if (util.isPlainObject(ov.layout) && util.isPlainObject(eff.layout)) eff.layout = mergeDefined(eff.layout, ov.layout);
          if (typeof ov.hidden === 'boolean') eff.hidden = ov.hidden;
          if (typeof ov.name === 'string' && ov.name) eff.name = ov.name;
        }
        if (e.root) {
          for (const k of ['name', 'x', 'y', 'w', 'h', 'rotation', 'hidden', 'locked', 'sizing', 'parent']) {
            if (inst[k] !== undefined) eff[k] = inst[k];
          }
          eff.style = mergeDefined(eff.style, inst.style);
          const attrs = Object.assign({}, eff.attrs);
          if (util.isPlainObject(inst.attrs)) for (const k of Object.keys(inst.attrs)) if (inst.attrs[k] !== undefined && inst.attrs[k] !== '') attrs[k] = inst.attrs[k];
          eff.attrs = attrs;
          if (inst.motion) eff.motion = inst.motion;
          if (typeof inst.css === 'string' && inst.css.trim()) eff.css = [eff.css, inst.css].filter((s) => typeof s === 'string' && s.trim()).join('; ');
          if (util.isPlainObject(inst.states) && Object.keys(inst.states).length) eff.states = inst.states;
          eff.instance = { id: inst.id, component: cid, master: e.masterId };
        }
        cache.set(node.id, eff);
        return eff;
      }
    };
    return { root: entries.get(inst.id).node, scope, entries };
  }

  function makeCtx(env, node, eff, scope) {
    return {
      mode: env.mode, doc: env.doc, bp: env.bpId, breakpoint: env.bpDef, effective: eff, node,
      virtual: !!scope.virtual, withIds: env.withIds, includeHidden: env.includeHidden, classFor: env.classFor,
      assetURL: env.assetURL, resolveURL: env.resolveURL, sanitizeHTML: env.sanitizeHTML,
      escape: util.escapeHTML, icon: env.icon, cssValue: style.cssValue
    };
  }

  function decorate(env, v, eff, decls, ro) {
    if (ro.decorate !== false) {
      const a = v.attrs;
      const at = util.isPlainObject(eff.attrs) ? eff.attrs : {};
      const classes = [];
      if (typeof a.class === 'string' && a.class) classes.push(a.class);
      if (env.mode === 'editor') classes.push('apb-node');
      if (env.classFor) {
        const c = env.classFor(eff);
        if (typeof c === 'string' && c) classes.push(c);
      }
      if (typeof at.className === 'string' && at.className) {
        const c = sanitize.className(at.className);
        if (c) classes.push(c);
      }
      const cls = util.uniq(classes.join(' ').split(/\s+/).filter(Boolean)).join(' ');
      if (cls) a.class = cls;
      if (typeof at.htmlId === 'string' && at.htmlId) {
        const id = sanitize.id(at.htmlId);
        if (id) a.id = id;
      }
      if (typeof at.ariaLabel === 'string' && at.ariaLabel.trim()) a['aria-label'] = at.ariaLabel.trim();
      if (typeof at.role === 'string' && /^[a-z]+(?: [a-z]+)*$/.test(at.role.trim())) a.role = at.role.trim();
      if (typeof at.title === 'string' && at.title.trim()) a.title = at.title.trim();
      if (env.withIds) a['data-node-id'] = eff.id;
      if (Array.isArray(eff.actions) && eff.actions.length) {
        const clean = actionsMod.normalize(eff.actions, { doc: env.doc });
        if (clean.length) {
          try { a['data-apb-actions'] = JSON.stringify(clean); } catch (err) { /* non-serializable action data is dropped */ }
        }
      }
      if (eff.motion) {
        const cleanMotion = motionMod.normalize(eff.motion);
        if (cleanMotion) a['data-apb-motion'] = cleanMotion.trigger;
      }
    }
    if ((env.inlineStyles || ro.decorate === false) && decls.size) v.style = style.declsToObject(decls);
  }

  function buildNode(env, node, parentEff, scope, rootOpts) {
    const ro = rootOpts || {};
    const eff = scope.eff(node);
    if (!eff) return null;
    if (eff.hidden && !env.includeHidden) return null;
    if (eff.type === 'instance') {
      const exp = expandScope(env.doc, eff, env.bpId, scope);
      if (exp) return buildNode(env, exp.root, parentEff, exp.scope, rootOpts);
    }
    const def = elements.get(eff.type);
    let v = null;
    if (def && eff.type !== 'instance') {
      try {
        v = def.vnode(eff, makeCtx(env, node, eff, scope));
      } catch (err) {
        if (typeof console !== 'undefined') console.error('[APB] vnode() of element type "' + eff.type + '" threw:', err);
      }
    }
    if (!util.isPlainObject(v)) v = eff.type === 'instance' ? { tag: 'div', attrs: { 'data-component-missing': '' } } : { tag: 'div' };
    v = Object.assign({}, v, { attrs: util.isPlainObject(v.attrs) ? Object.assign({}, v.attrs) : {} });
    const decls = style.nodeDecls(env.doc, eff, env.bpId, {
      mode: env.mode, parentEff, bp: env.bpDef, extra: v.style, assetURL: env.assetURL, effective: true, box: ro.box !== false
    });
    delete v.style;
    const container = def ? def.container : Array.isArray(eff.children);
    if (container && Array.isArray(eff.children)) {
      const kids = [];
      for (const cid of eff.children) {
        const c = scope.get(cid);
        if (!c) continue;
        const cv = buildNode(env, c, eff, scope, null);
        if (cv) kids.push(cv);
      }
      const slot = findSlot(v);
      if (kids.length) {
        slot.children = (Array.isArray(slot.children) ? slot.children : []).concat(kids);
        delete slot.text;
        delete slot.html;
      }
      slot.slot = true;
    }
    decorate(env, v, eff, decls, ro);
    if (env.onNode) env.onNode({ id: eff.id, node: eff, parentEff, vnode: v, decls, virtual: !!scope.virtual, bp: env.bpId });
    return v;
  }

  /**
   * buildTree(doc, rootId, { bp, mode = 'export', classFor, withIds, includeHidden, sanitizeHTML,
   *   assetURL, resolveURL, icon, onNode, inlineStyles, parentEff }) → VNode | null
   */
  function buildTree(doc, rootId, opts) {
    const o = opts || {};
    const root = schema.getNode(doc, rootId);
    if (!root) return null;
    const env = makeEnv(doc, o);
    let parentEff = o.parentEff;
    if (parentEff === undefined) parentEff = root.parent ? schema.effectiveNode(doc, root.parent, env.bpId) : null;
    return buildNode(env, root, parentEff, docScope(env), null);
  }

  /**
   * instanceVNode(doc, instanceNode, ctx) → VNode of the expanded master (root undecorated, root
   * `style` = its non-box declarations) or null when the component is missing/cyclic.
   */
  function instanceVNode(doc, node, ctx) {
    const c = ctx || {};
    if (!node) return null;
    const env = makeEnv(doc, {
      mode: c.mode, bp: c.bp, withIds: c.withIds, includeHidden: c.includeHidden, classFor: c.classFor,
      sanitizeHTML: c.sanitizeHTML, assetURL: c.assetURL, resolveURL: c.resolveURL, icon: c.icon
    });
    const inst = c.effective && c.effective.id === node.id ? c.effective : node;
    const exp = expandScope(doc, inst, env.bpId, null);
    if (!exp) return null;
    return buildNode(env, exp.root, null, exp.scope, { box: false, decorate: false });
  }

  /** expandInstance(doc, instance|id, { bp }) → { root, component, nodes: { [id]: effectiveNode } } | null */
  function expandInstance(doc, instOrId, opts) {
    const node = schema.getNode(doc, instOrId);
    if (!node || node.type !== 'instance') return null;
    const bp = style.breakpoint(doc, opts && opts.bp);
    const bpId = bp ? bp.id : undefined;
    const inst = schema.effectiveNode(doc, node, bpId);
    const exp = expandScope(doc, inst, bpId, null);
    if (!exp) return null;
    const nodes = {};
    for (const [id, e] of exp.entries) nodes[id] = exp.scope.eff(e.node);
    return { root: inst.id, component: inst.props.component, nodes };
  }

  return { toHTML, toDOM, patch, buildTree, instanceVNode, expandInstance, collectAttrs, styleString, tagName, VOID };
});

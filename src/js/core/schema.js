/* @node-testable */
/*
 * schema — document & node model: defaults, creation, normalization/validation, traversal,
 * breakpoint cascade, re-id. Pure (no DOM). See ARCHITECTURE.md §5 and §6.6.
 *
 * The `elements` registry is looked up lazily at call time (it may not be defined yet, or may
 * depend on schema itself), so createNode() works before any element type is registered.
 */
APB.define('schema', ['util'], function (util) {
  'use strict';

  const VERSION = 2;

  const STYLE_KEYS = Object.freeze(['fill', 'fillImage', 'color', 'textStyle', 'fontFamily', 'fontWeight', 'fontStyle',
    'textAlign', 'textDecoration', 'textTransform', 'fontSize', 'letterSpacing', 'lineHeight', 'valign', 'padding',
    'borderWidth', 'borderStyle', 'borderColor', 'radius', 'shadow', 'textShadow', 'opacity', 'blur', 'backdropBlur',
    'blend', 'overflow', 'objectFit', 'objectPosition', 'stroke', 'strokeWidth', 'cursor']);

  const BP_KEYS = Object.freeze(['x', 'y', 'w', 'h', 'rotation', 'hidden', 'sizing', 'layout', 'style', 'props']);

  const NODE_KEYS = Object.freeze(['id', 'type', 'name', 'parent', 'children', 'x', 'y', 'w', 'h', 'rotation', 'locked',
    'hidden', 'sizing', 'layout', 'style', 'props', 'bp', 'states', 'motion', 'attrs', 'css']);

  /** Keys whose plain-object values merge one level deep (updateNode patches, cascade). */
  const MERGE_KEYS = Object.freeze(['style', 'props', 'layout', 'sizing', 'attrs']);
  const CASCADE_MERGE_KEYS = new Set(['style', 'layout', 'sizing', 'props']);

  const SIZING_VALUES = new Set(['fixed', 'fill', 'hug']);
  const LAYOUT_MODES = new Set(['free', 'stack']);
  const LAYOUT_DIRS = new Set(['column', 'row']);
  const LAYOUT_ALIGN = new Set(['start', 'center', 'end', 'stretch']);
  const LAYOUT_JUSTIFY = new Set(['start', 'center', 'end', 'between', 'around']);

  const FALLBACK_CONTAINERS = new Set(['page', 'section', 'frame', 'group', 'form']);

  const DEFAULT_BREAKPOINTS = Object.freeze([
    Object.freeze({ id: 'desktop', label: 'Desktop', width: 1440 }),
    Object.freeze({ id: 'tablet', label: 'Tablet', width: 768, max: 1023 }),
    Object.freeze({ id: 'mobile', label: 'Mobile', width: 390, max: 767 })
  ]);

  const DEFAULT_LAYOUT = Object.freeze({ mode: 'free', dir: 'column', gap: 16, pad: Object.freeze([0, 0, 0, 0]), align: 'start', justify: 'start', wrap: false });

  const DEFAULT_SEO = Object.freeze({ title: '', description: '', ogImage: '', canonical: '', noindex: false });

  /* Type-specific defaults used only when the element type is not registered. */
  const FALLBACK_DEFAULTS = {
    page: () => ({ name: 'Page', w: 1440, h: 900, sizing: { w: 'fixed', h: 'hug' },
      layout: { mode: 'stack', dir: 'column', gap: 0, align: 'stretch' }, style: { fill: '#ffffff' }, props: { minHeight: 900 } }),
    section: () => ({ name: 'Section', w: 1440, h: 640, sizing: { w: 'fill', h: 'fixed' }, layout: { mode: 'free' }, props: { tag: 'section' } }),
    frame: () => ({ name: 'Frame', w: 320, h: 240, layout: { mode: 'free' }, props: { tag: 'div', href: '' } }),
    group: () => ({ name: 'Group', w: 100, h: 100, layout: { mode: 'free' } }),
    text: () => ({ name: 'Text', w: 320, h: 64, style: { fontSize: 18, lineHeight: 1.5, color: '#111827' }, props: { text: 'Text', html: null, tag: 'p' } })
  };

  /* ------------------------------------------------------------ elements */

  function elementsApi() {
    if (typeof APB === 'undefined' || !APB.has('elements')) return null;
    try { return APB.require('elements'); } catch (_) { return null; }
  }

  function getElementDef(type) {
    const els = elementsApi();
    if (!els || typeof els.get !== 'function') return null;
    try { return els.get(type) || null; } catch (_) { return null; }
  }

  function isContainer(typeOrNode) {
    const type = typeOrNode && typeof typeOrNode === 'object' ? typeOrNode.type : typeOrNode;
    if (typeof type !== 'string') return false;
    const def = getElementDef(type);
    if (def) return !!def.container;
    return FALLBACK_CONTAINERS.has(type);
  }

  /* ---------------------------------------------------------- factories */

  function isId(v, prefix) {
    return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_:.-]+$/.test(v) &&
      (!prefix || v.startsWith(prefix + '_'));
  }

  function fullLayout(layout, type) {
    const base = type === 'page'
      ? Object.assign({}, DEFAULT_LAYOUT, { mode: 'stack', gap: 0, align: 'stretch' })
      : Object.assign({}, DEFAULT_LAYOUT);
    const l = Object.assign(base, util.isPlainObject(layout) ? layout : {});
    if (!LAYOUT_MODES.has(l.mode)) l.mode = type === 'page' ? 'stack' : 'free';
    if (!LAYOUT_DIRS.has(l.dir)) l.dir = 'column';
    l.gap = Number.isFinite(l.gap) ? l.gap : DEFAULT_LAYOUT.gap;
    l.pad = normalizePad(l.pad);
    if (!LAYOUT_ALIGN.has(l.align)) l.align = 'start';
    if (!LAYOUT_JUSTIFY.has(l.justify)) l.justify = 'start';
    l.wrap = !!l.wrap;
    return l;
  }

  function normalizePad(pad) {
    if (Number.isFinite(pad)) return [pad, pad, pad, pad];
    if (Array.isArray(pad)) {
      const n = pad.map((v) => (Number.isFinite(v) ? v : 0));
      if (n.length === 1) return [n[0], n[0], n[0], n[0]];
      if (n.length === 2) return [n[0], n[1], n[0], n[1]];
      if (n.length === 3) return [n[0], n[1], n[2], n[1]];
      if (n.length >= 4) return n.slice(0, 4);
    }
    return [0, 0, 0, 0];
  }

  function baseNode(type) {
    return {
      id: '', type, name: '', parent: null,
      x: 0, y: 0, w: 100, h: 100, rotation: 0,
      locked: false, hidden: false,
      sizing: { w: 'fixed', h: 'fixed' },
      layout: null,
      style: {}, props: {}, bp: {}, states: {}, motion: null, attrs: {}, css: ''
    };
  }

  function typeLabel(type) {
    const def = getElementDef(type);
    if (def && def.label) return def.label;
    return String(type).charAt(0).toUpperCase() + String(type).slice(1);
  }

  /**
   * createNode(type, init) → node. Merges (base defaults) ⊕ (element type defaults, or built-in
   * fallbacks when the type is not registered) ⊕ init. Object keys merge one level deep.
   */
  function createNode(type, init) {
    const src = util.isPlainObject(init) ? util.deepClone(init) : {};
    const t = String(type || src.type || 'frame');
    const def = getElementDef(t);
    let node = baseNode(t);
    let typeDefaults = null;
    if (def && typeof def.defaults === 'function') {
      try { typeDefaults = def.defaults() || null; } catch (err) {
        if (typeof console !== 'undefined') console.error('[APB] defaults() of element type "' + t + '" threw:', err);
      }
    } else if (!def && FALLBACK_DEFAULTS[t]) {
      typeDefaults = FALLBACK_DEFAULTS[t]();
    }
    if (typeDefaults) node = util.deepMerge(node, util.omit(util.deepClone(typeDefaults), ['id', 'type', 'children', 'parent']));
    node = util.deepMerge(node, util.omit(src, ['id', 'type', 'children']));
    node.id = isId(src.id) ? src.id : util.uid('n');
    node.type = t;
    if (!node.name) node.name = typeLabel(t);
    if (isContainer(t)) {
      node.children = Array.isArray(src.children) && src.children.every((c) => typeof c === 'string') ? src.children.slice() : [];
      node.layout = fullLayout(node.layout, t);
    } else {
      delete node.children;
      node.layout = null;
    }
    if (!util.isPlainObject(node.sizing)) node.sizing = { w: 'fixed', h: 'fixed' };
    return node;
  }

  function uniqueSlug(doc, name, exceptPageId) {
    const pages = (doc && Array.isArray(doc.pages)) ? doc.pages : [];
    const taken = new Set(pages.filter((p) => p && p.id !== exceptPageId).map((p) => p.slug));
    let base = util.slugify(name, 'page');
    if (!taken.size && !pages.length) base = 'index';
    let slug = base;
    let i = 2;
    while (taken.has(slug)) slug = base + '-' + i++;
    return slug;
  }

  /** createPage(doc, name) → { page, root } — does not modify doc. */
  function createPage(doc, name) {
    const bps = doc && doc.settings && Array.isArray(doc.settings.breakpoints) && doc.settings.breakpoints.length
      ? doc.settings.breakpoints : DEFAULT_BREAKPOINTS;
    const pageName = (typeof name === 'string' && name.trim()) ? name.trim() : 'Page ' + (((doc && doc.pages) || []).length + 1);
    const existingIds = doc && doc.nodes ? doc.nodes : undefined;
    const root = createNode('page', { id: util.uid('n', existingIds), name: pageName, parent: null, w: bps[0].width || 1440 });
    const page = {
      id: util.uid('pg', ((doc && doc.pages) || []).map((p) => p.id)),
      name: pageName,
      slug: uniqueSlug(doc, pageName),
      root: root.id,
      seo: Object.assign({}, DEFAULT_SEO)
    };
    return { page, root };
  }

  function defaultSettings() {
    return {
      lang: 'en',
      breakpoints: DEFAULT_BREAKPOINTS.map((b) => Object.assign({}, b)),
      globalCSS: '',
      fonts: [],
      favicon: '',
      export: {}
    };
  }

  /** createDocument({ name, pageName }) → doc with one page root + one empty free section 1440×900. */
  function createDocument(opts) {
    const o = opts || {};
    const now = new Date().toISOString();
    const doc = {
      format: 'apb',
      version: VERSION,
      id: util.uid('doc'),
      name: (typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : 'Untitled site',
      createdAt: now,
      updatedAt: now,
      settings: defaultSettings(),
      tokens: { colors: [], text: [] },
      assets: {},
      components: {},
      pages: [],
      nodes: {}
    };
    const { page, root } = createPage(doc, (typeof o.pageName === 'string' && o.pageName.trim()) ? o.pageName.trim() : 'Home');
    page.slug = 'index';
    const section = createNode('section', {
      name: 'Section', parent: root.id, x: 0, y: 0, w: 1440, h: 900,
      sizing: { w: 'fill', h: 'fixed' }, layout: { mode: 'free' }
    });
    section.layout = fullLayout(Object.assign({}, section.layout, { mode: 'free' }), 'section');
    root.children = [section.id];
    doc.nodes[root.id] = root;
    doc.nodes[section.id] = section;
    doc.pages.push(page);
    return doc;
  }

  /* ---------------------------------------------------------- traversal */

  function getNode(doc, idOrNode) {
    if (!idOrNode) return null;
    if (typeof idOrNode === 'object') return idOrNode;
    return (doc && doc.nodes && Object.prototype.hasOwnProperty.call(doc.nodes, idOrNode)) ? doc.nodes[idOrNode] : null;
  }

  /** walk(doc, rootId, fn(node, depth)) — pre-order; return false from fn to skip a subtree. */
  function walk(doc, rootId, fn) {
    const start = getNode(doc, rootId);
    if (!start) return;
    const stack = [[start, 0]];
    const seen = new Set();
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (fn(node, depth) === false) continue;
      const kids = Array.isArray(node.children) ? node.children : [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const child = getNode(doc, kids[i]);
        if (child) stack.push([child, depth + 1]);
      }
    }
  }

  /** ancestors(doc, id) → ids from the parent up to the root. */
  function ancestors(doc, id) {
    const out = [];
    const seen = new Set([id]);
    let node = getNode(doc, id);
    while (node && node.parent && !seen.has(node.parent)) {
      out.push(node.parent);
      seen.add(node.parent);
      node = getNode(doc, node.parent);
    }
    return out;
  }

  /** descendants(doc, id) → ids of all descendants in pre-order (excluding id). */
  function descendants(doc, id) {
    const out = [];
    const rootId = typeof id === 'object' && id ? id.id : id;
    walk(doc, id, (node) => { if (node.id !== rootId) out.push(node.id); });
    return out;
  }

  function rootOf(doc, id) {
    const anc = ancestors(doc, id);
    if (anc.length) return anc[anc.length - 1];
    return getNode(doc, id) ? (typeof id === 'object' ? id.id : id) : null;
  }

  function pageOf(doc, id) {
    const root = rootOf(doc, id);
    if (!root || !doc || !Array.isArray(doc.pages)) return null;
    return doc.pages.find((p) => p.root === root) || null;
  }

  function indexInParent(doc, id) {
    const node = getNode(doc, id);
    if (!node || !node.parent) return -1;
    const parent = getNode(doc, node.parent);
    return parent && Array.isArray(parent.children) ? parent.children.indexOf(node.id) : -1;
  }

  function bpIndex(doc, bpId) {
    const bps = doc && doc.settings && Array.isArray(doc.settings.breakpoints) ? doc.settings.breakpoints : DEFAULT_BREAKPOINTS;
    if (!bpId) return 0;
    return bps.findIndex((b) => b.id === bpId);
  }

  /* ---------------------------------------------------- breakpoint cascade */

  const effCache = new WeakMap(); // node -> Map(bpId -> { bps, bpProps, eff })

  function applyOverride(eff, over, allowedProps) {
    const out = Object.assign({}, eff);
    for (const key of BP_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(over, key)) continue;
      const val = over[key];
      if (val === undefined) continue;
      if (CASCADE_MERGE_KEYS.has(key) && util.isPlainObject(val)) {
        const merged = Object.assign({}, util.isPlainObject(out[key]) ? out[key] : {});
        for (const k of Object.keys(val)) {
          if (val[k] === undefined) continue;
          if (key === 'props' && allowedProps && !allowedProps.includes(k)) continue;
          merged[k] = val[k];
        }
        out[key] = merged;
      } else if (key !== 'props') {
        out[key] = val;
      }
    }
    return out;
  }

  /**
   * effectiveNode(doc, node|id, bpId) → node after cascade base ⊕ bp[b1] ⊕ … ⊕ bp[bk].
   * Returns the node itself at the base breakpoint or when no override applies.
   */
  function effectiveNode(doc, idOrNode, bpId) {
    const node = getNode(doc, idOrNode);
    if (!node) return null;
    const bps = doc && doc.settings && Array.isArray(doc.settings.breakpoints) ? doc.settings.breakpoints : DEFAULT_BREAKPOINTS;
    const idx = bpId ? bps.findIndex((b) => b.id === bpId) : 0;
    if (idx <= 0 || !node.bp || typeof node.bp !== 'object') return node;
    const def = getElementDef(node.type);
    const allowedProps = def ? (Array.isArray(def.bpProps) ? def.bpProps : []) : null;
    let perNode = effCache.get(node);
    const hit = perNode && perNode.get(bpId);
    if (hit && hit.bps === bps && hit.allowedProps === allowedProps) return hit.eff;
    let eff = node;
    for (let i = 1; i <= idx; i++) {
      const over = node.bp[bps[i].id];
      if (util.isPlainObject(over) && Object.keys(over).length) eff = applyOverride(eff, over, allowedProps);
    }
    if (!perNode) { perNode = new Map(); effCache.set(node, perNode); }
    perNode.set(bpId, { bps, allowedProps, eff });
    return eff;
  }

  /* --------------------------------------------------------------- reid */

  /**
   * reid(nodesMap, rootIds) → { nodes, idMap } — deep copies the subtrees under rootIds with fresh
   * ids. Roots keep their original `parent`; children/parent links inside the subtrees are remapped.
   */
  function reid(nodesMap, rootIds) {
    const src = nodesMap || {};
    const roots = (Array.isArray(rootIds) ? rootIds : [rootIds]).filter((id) => src[id]);
    const order = [];
    const seen = new Set();
    const stack = roots.slice().reverse();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !src[id]) continue;
      seen.add(id);
      order.push(id);
      const kids = Array.isArray(src[id].children) ? src[id].children : [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    const idMap = {};
    const taken = new Set(Object.keys(src));
    for (const id of order) {
      const nid = util.uid('n', taken);
      taken.add(nid);
      idMap[id] = nid;
    }
    const nodes = {};
    for (const id of order) {
      const copy = util.deepClone(src[id]);
      copy.id = idMap[id];
      if (copy.parent && idMap[copy.parent]) copy.parent = idMap[copy.parent];
      if (Array.isArray(copy.children)) copy.children = copy.children.filter((c) => idMap[c]).map((c) => idMap[c]);
      nodes[copy.id] = copy;
    }
    return { nodes, idMap };
  }

  /* ------------------------------------------------------ normalization */

  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v, d) => (typeof v === 'string' ? v : d);
  const obj = (v) => (util.isPlainObject(v) ? v : {});

  function normalizeBreakpoints(list, warnings) {
    if (!Array.isArray(list) || !list.length) {
      if (list !== undefined) warnings.push('Invalid breakpoints replaced with defaults');
      return DEFAULT_BREAKPOINTS.map((b) => Object.assign({}, b));
    }
    const seen = new Set();
    const out = [];
    list.forEach((b, i) => {
      if (!util.isPlainObject(b) || typeof b.id !== 'string' || !b.id || seen.has(b.id) || !(num(b.width, 0) > 0)) {
        warnings.push('Dropped invalid breakpoint #' + i);
        return;
      }
      seen.add(b.id);
      const bp = { id: b.id, label: str(b.label, b.id), width: b.width };
      if (out.length && Number.isFinite(b.max)) bp.max = b.max;
      else if (out.length === 1) bp.max = Math.max(b.width, 1023);
      else if (out.length) bp.max = Math.max(0, out[out.length - 1].width - 1);
      out.push(bp);
    });
    return out.length ? out : DEFAULT_BREAKPOINTS.map((b) => Object.assign({}, b));
  }

  function normalizeNodeFields(id, raw, warnings) {
    const type = typeof raw.type === 'string' && raw.type ? raw.type : 'frame';
    if (type !== raw.type) warnings.push('Node ' + id + ' had no type; set to "frame"');
    const base = baseNode(type);
    const n = Object.assign({}, raw);
    n.id = id;
    n.type = type;
    n.name = str(n.name, '') || typeLabel(type);
    for (const k of ['x', 'y', 'w', 'h', 'rotation']) n[k] = num(n[k], base[k]);
    if (n.w < 0) n.w = 0;
    if (n.h < 0) n.h = 0;
    n.locked = !!n.locked;
    n.hidden = !!n.hidden;
    const sz = obj(n.sizing);
    n.sizing = { w: SIZING_VALUES.has(sz.w) ? sz.w : 'fixed', h: SIZING_VALUES.has(sz.h) ? sz.h : 'fixed' };
    n.style = obj(n.style);
    n.props = obj(n.props);
    n.bp = obj(n.bp);
    n.states = obj(n.states);
    n.attrs = obj(n.attrs);
    n.motion = util.isPlainObject(n.motion) ? n.motion : null;
    n.css = str(n.css, '');
    n.parent = typeof n.parent === 'string' ? n.parent : null;
    if (isContainer(type)) {
      n.children = Array.isArray(n.children) ? n.children.filter((c) => typeof c === 'string') : [];
      n.layout = fullLayout(n.layout, type);
    } else {
      if (Array.isArray(n.children) && n.children.length) warnings.push('Removed children from non-container ' + id);
      delete n.children;
      n.layout = null;
    }
    return n;
  }

  /**
   * normalizeDocument(doc) → { doc, warnings }. Never mutates the input. Repairs parent/children
   * links (first claim wins, cycles broken), removes unreachable nodes and dangling refs, fills
   * defaults.
   */
  function normalizeDocument(input) {
    const warnings = [];
    if (!util.isPlainObject(input)) {
      warnings.push('Document was not an object; created a new document');
      return { doc: createDocument(), warnings };
    }
    const src = util.deepClone(input);
    if (src.format !== undefined && src.format !== 'apb') warnings.push('Unknown format "' + src.format + '"');
    if (typeof src.version === 'number' && src.version > VERSION) warnings.push('Document version ' + src.version + ' is newer than supported (' + VERSION + ')');
    const now = new Date().toISOString();
    const doc = {
      format: 'apb',
      version: VERSION,
      id: isId(src.id) ? src.id : util.uid('doc'),
      name: str(src.name, '') || 'Untitled site',
      createdAt: str(src.createdAt, now),
      updatedAt: str(src.updatedAt, now),
      settings: null,
      tokens: null,
      assets: {},
      components: {},
      pages: [],
      nodes: {}
    };
    // Unknown top-level extension keys are preserved.
    for (const k of Object.keys(src)) if (!(k in doc)) doc[k] = src[k];

    const s = obj(src.settings);
    doc.settings = Object.assign(defaultSettings(), s, {
      lang: str(s.lang, '') || 'en',
      breakpoints: normalizeBreakpoints(s.breakpoints, warnings),
      globalCSS: str(s.globalCSS, ''),
      fonts: Array.isArray(s.fonts) ? s.fonts.filter(util.isPlainObject) : [],
      favicon: str(s.favicon, ''),
      export: obj(s.export)
    });

    const t = obj(src.tokens);
    const tokenIds = new Set();
    const validToken = (tok, field) => {
      if (!util.isPlainObject(tok) || typeof tok.id !== 'string' || !tok.id || tokenIds.has(field + ':' + tok.id)) return false;
      tokenIds.add(field + ':' + tok.id);
      return true;
    };
    doc.tokens = Object.assign({}, t, {
      colors: (Array.isArray(t.colors) ? t.colors : []).filter((c) => validToken(c, 'c') && typeof c.value === 'string')
        .map((c) => Object.assign({}, c, { name: str(c.name, c.id) })),
      text: (Array.isArray(t.text) ? t.text : []).filter((c) => validToken(c, 't'))
        .map((c) => Object.assign({}, c, { name: str(c.name, c.id), style: obj(c.style) }))
    });

    for (const [key, a] of Object.entries(obj(src.assets))) {
      if (!util.isPlainObject(a)) { warnings.push('Dropped invalid asset ' + key); continue; }
      doc.assets[key] = Object.assign({}, a, { id: key });
    }

    // Nodes: basic field repair.
    for (const [key, raw] of Object.entries(obj(src.nodes))) {
      if (!util.isPlainObject(raw)) { warnings.push('Dropped invalid node ' + key); continue; }
      if (raw.id !== undefined && raw.id !== key) warnings.push('Node id mismatch fixed for ' + key);
      doc.nodes[key] = normalizeNodeFields(key, raw, warnings);
    }
    const nodes = doc.nodes;

    // Pages.
    const pageIds = new Set();
    const rootIds = new Set();
    const rawPages = Array.isArray(src.pages) ? src.pages : [];
    for (const rp of rawPages) {
      if (!util.isPlainObject(rp)) { warnings.push('Dropped invalid page'); continue; }
      const page = Object.assign({}, rp);
      if (!isId(page.id) || pageIds.has(page.id)) page.id = util.uid('pg', pageIds);
      pageIds.add(page.id);
      page.name = str(page.name, '') || 'Page ' + (doc.pages.length + 1);
      page.seo = Object.assign({}, DEFAULT_SEO, obj(page.seo));
      let root = nodes[page.root];
      if (!root || rootIds.has(page.root)) {
        warnings.push('Page "' + page.name + '" had a missing or shared root; created a new root');
        const fresh = createNode('page', { id: util.uid('n', nodes), name: page.name, w: doc.settings.breakpoints[0].width });
        nodes[fresh.id] = fresh;
        page.root = fresh.id;
        root = fresh;
      } else if (root.type !== 'page') {
        warnings.push('Page "' + page.name + '" root was a ' + root.type + '; wrapped in a page root');
        const fresh = createNode('page', { id: util.uid('n', nodes), name: page.name, w: doc.settings.breakpoints[0].width });
        fresh.children = [root.id];
        root.parent = fresh.id;
        nodes[fresh.id] = fresh;
        page.root = fresh.id;
      }
      rootIds.add(page.root);
      nodes[page.root].parent = null;
      page.slug = util.slugify(str(page.slug, '') || page.name, 'page');
      doc.pages.push(page);
    }
    // Unique slugs (first page defaults to index when its slug is empty).
    const slugs = new Set();
    doc.pages.forEach((p) => {
      let slug = p.slug;
      let i = 2;
      while (slugs.has(slug)) slug = p.slug + '-' + i++;
      p.slug = slug;
      slugs.add(slug);
    });

    // Components.
    for (const [key, c] of Object.entries(obj(src.components))) {
      if (!util.isPlainObject(c) || !nodes[c.root] || rootIds.has(c.root)) {
        warnings.push('Dropped component ' + key + ' (missing root)');
        continue;
      }
      doc.components[key] = Object.assign({}, c, { id: key, name: str(c.name, '') || 'Component' });
      rootIds.add(c.root);
      nodes[c.root].parent = null;
    }

    // Nodes whose parent points at a container that does not list them get appended.
    for (const n of Object.values(nodes)) {
      if (rootIds.has(n.id) || !n.parent) continue;
      const p = nodes[n.parent];
      if (p && Array.isArray(p.children) && !p.children.includes(n.id)) {
        p.children = p.children.concat(n.id);
        warnings.push('Re-linked node ' + n.id + ' into its parent');
      }
    }

    // Reachability from roots (breadth-first). When several containers list the same child, the
    // container named by the child's own `parent` field wins; otherwise the first claim wins.
    // Cycles and duplicates are cut.
    const visited = new Set(rootIds);
    const entries = new Map(); // containerId -> [{ id, keep }]
    let queue = Array.from(rootIds);
    const claimedBy = (cid, containerId) => {
      visited.add(cid);
      if (nodes[cid].parent !== containerId) nodes[cid].parent = containerId;
      queue.push(cid);
    };
    while (queue.length) {
      const batch = queue;
      queue = [];
      for (const id of batch) {
        const node = nodes[id];
        if (!Array.isArray(node.children)) continue;
        const list = [];
        for (const cid of node.children) {
          if (!nodes[cid]) { warnings.push('Removed dangling child ref ' + cid); continue; }
          if (visited.has(cid) || list.some((e) => e.id === cid)) { warnings.push('Removed duplicate/cyclic child ref ' + cid); continue; }
          const hint = nodes[cid].parent;
          const hinted = hint && hint !== id && nodes[hint] && Array.isArray(nodes[hint].children) && nodes[hint].children.includes(cid);
          if (hinted) { list.push({ id: cid, keep: false }); continue; }
          list.push({ id: cid, keep: true });
          claimedBy(cid, id);
        }
        entries.set(id, list);
      }
      if (!queue.length) {
        // Deferred claims whose hinted parent never claimed them (e.g. unreachable) fall back here.
        for (const [containerId, list] of entries) {
          for (const e of list) {
            if (!e.keep && !visited.has(e.id)) { e.keep = true; claimedBy(e.id, containerId); }
          }
        }
      }
    }
    for (const [containerId, list] of entries) {
      const kept = list.filter((e) => e.keep).map((e) => e.id);
      const node = nodes[containerId];
      if (kept.length !== node.children.length || kept.some((k, i) => node.children[i] !== k)) {
        if (list.some((e) => !e.keep)) warnings.push('Resolved duplicate claims in ' + containerId);
        node.children = kept;
      }
    }
    const unreachable = Object.keys(nodes).filter((id) => !visited.has(id));
    if (unreachable.length) {
      warnings.push('Removed ' + unreachable.length + ' unreachable node(s)');
      unreachable.forEach((id) => delete nodes[id]);
    }

    // Instances referencing missing components.
    for (const n of Object.values(nodes)) {
      if (n.type === 'instance' && !(n.props && doc.components[n.props.component])) {
        warnings.push('Instance ' + n.id + ' references a missing component');
      }
    }

    if (!doc.pages.length) {
      warnings.push('Document had no pages; added one');
      const { page, root } = createPage(doc, 'Home');
      page.slug = slugs.has('index') ? page.slug : 'index';
      nodes[root.id] = root;
      doc.pages.push(page);
    }
    return { doc, warnings };
  }

  /** validateDocument(doc) → { ok, errors } — read-only structural validation. */
  function validateDocument(doc) {
    const errors = [];
    if (!util.isPlainObject(doc)) return { ok: false, errors: ['Document is not an object'] };
    if (doc.format !== 'apb') errors.push('format must be "apb"');
    if (doc.version !== VERSION) errors.push('version must be ' + VERSION);
    if (typeof doc.id !== 'string' || !doc.id) errors.push('id is required');
    const settings = doc.settings;
    if (!util.isPlainObject(settings)) errors.push('settings missing');
    else {
      const bps = settings.breakpoints;
      if (!Array.isArray(bps) || !bps.length) errors.push('settings.breakpoints must be a non-empty array');
      else {
        const ids = new Set();
        bps.forEach((b, i) => {
          if (!b || typeof b.id !== 'string' || !b.id) errors.push('breakpoint #' + i + ' has no id');
          else if (ids.has(b.id)) errors.push('duplicate breakpoint id ' + b.id);
          else ids.add(b.id);
          if (!b || !(b.width > 0)) errors.push('breakpoint #' + i + ' has an invalid width');
        });
      }
    }
    if (!util.isPlainObject(doc.tokens) || !Array.isArray(doc.tokens.colors) || !Array.isArray(doc.tokens.text)) errors.push('tokens must have colors[] and text[]');
    if (!util.isPlainObject(doc.assets)) errors.push('assets must be an object');
    if (!util.isPlainObject(doc.components)) errors.push('components must be an object');
    const nodes = util.isPlainObject(doc.nodes) ? doc.nodes : null;
    if (!nodes) { errors.push('nodes must be an object'); return { ok: false, errors }; }
    if (!Array.isArray(doc.pages) || !doc.pages.length) errors.push('pages must be a non-empty array');

    const roots = new Set();
    const pageIds = new Set();
    const slugs = new Set();
    (Array.isArray(doc.pages) ? doc.pages : []).forEach((p, i) => {
      if (!p || typeof p.id !== 'string') { errors.push('page #' + i + ' has no id'); return; }
      if (pageIds.has(p.id)) errors.push('duplicate page id ' + p.id);
      pageIds.add(p.id);
      if (typeof p.slug !== 'string' || !p.slug) errors.push('page ' + p.id + ' has no slug');
      else if (slugs.has(p.slug)) errors.push('duplicate page slug ' + p.slug);
      slugs.add(p.slug);
      const root = nodes[p.root];
      if (!root) errors.push('page ' + p.id + ' root ' + p.root + ' does not exist');
      else {
        if (root.type !== 'page') errors.push('page ' + p.id + ' root must be of type page');
        if (root.parent !== null) errors.push('page root ' + p.root + ' must have parent null');
        if (roots.has(p.root)) errors.push('root ' + p.root + ' is shared');
        roots.add(p.root);
      }
    });
    if (util.isPlainObject(doc.components)) {
      for (const [key, c] of Object.entries(doc.components)) {
        if (!c || !nodes[c.root]) errors.push('component ' + key + ' root does not exist');
        else {
          if (nodes[c.root].parent !== null) errors.push('component root ' + c.root + ' must have parent null');
          roots.add(c.root);
        }
      }
    }
    const claimed = new Map();
    for (const [key, n] of Object.entries(nodes)) {
      if (!util.isPlainObject(n)) { errors.push('node ' + key + ' is not an object'); continue; }
      if (n.id !== key) errors.push('node key ' + key + ' does not match id ' + n.id);
      if (typeof n.type !== 'string' || !n.type) errors.push('node ' + key + ' has no type');
      for (const k of ['x', 'y', 'w', 'h', 'rotation']) {
        if (typeof n[k] !== 'number' || !Number.isFinite(n[k])) errors.push('node ' + key + '.' + k + ' must be a finite number');
      }
      const container = isContainer(n.type);
      if (container && !Array.isArray(n.children)) errors.push('container ' + key + ' must have children[]');
      if (!container && n.children !== undefined) errors.push('non-container ' + key + ' must not have children');
      if (Array.isArray(n.children)) {
        for (const c of n.children) {
          if (!nodes[c]) errors.push('node ' + key + ' has dangling child ' + c);
          else if (nodes[c].parent !== key) errors.push('child ' + c + ' parent mismatch (expected ' + key + ')');
          if (claimed.has(c)) errors.push('node ' + c + ' is listed in more than one parent');
          claimed.set(c, key);
        }
      }
      if (n.parent === null || n.parent === undefined) {
        if (!roots.has(key)) errors.push('node ' + key + ' has no parent and is not a root');
      } else if (!nodes[n.parent]) {
        errors.push('node ' + key + ' parent ' + n.parent + ' does not exist');
      } else if (!(nodes[n.parent].children || []).includes(key)) {
        errors.push('node ' + key + ' is not listed in its parent children');
      }
    }
    // Reachability / cycles.
    const reach = new Set();
    for (const r of roots) {
      const stack = [r];
      while (stack.length) {
        const id = stack.pop();
        if (reach.has(id)) { errors.push('cycle or duplicate reference at ' + id); continue; }
        reach.add(id);
        const n = nodes[id];
        if (n && Array.isArray(n.children)) for (const c of n.children) if (nodes[c]) stack.push(c);
      }
    }
    for (const key of Object.keys(nodes)) if (!reach.has(key)) errors.push('node ' + key + ' is unreachable');
    return { ok: errors.length === 0, errors };
  }

  return {
    VERSION, STYLE_KEYS, BP_KEYS, NODE_KEYS, MERGE_KEYS, DEFAULT_BREAKPOINTS, DEFAULT_LAYOUT, DEFAULT_SEO,
    createDocument, createNode, createPage, normalizeDocument, validateDocument, effectiveNode,
    isContainer, walk, ancestors, descendants, pageOf, rootOf, indexInParent, bpIndex, reid,
    fullLayout, normalizePad, uniqueSlug, getNode
  };
});

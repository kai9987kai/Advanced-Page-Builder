/* @node-testable */
/*
 * style — node → CSS declarations (shared by the editor renderer and the exporters).
 * See ARCHITECTURE.md §6.9. Pure: no DOM.
 *
 * Every function returns a Map<kebab-property, value> with a deterministic insertion order:
 *   box (position/size) → layout (flex) → type extras (VNode.style) → visual (STYLE_KEYS) →
 *   node.css → hidden (display:none).
 * Values are sanitized: token references `$id` become `var(--t-id)`; free-form strings pass a fast
 * allowlist or `sanitize.css`; URLs only via `sanitize.url(…, 'image')`.
 */
APB.define('style', ['util', 'schema', 'sanitize', 'elements'], function (util, schema, sanitize, elements) {
  'use strict';

  const TOKEN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const TOKEN_REF_RE = /\$([A-Za-z0-9_-]{1,64})/g;
  const FAST_VALUE_RE = /^[#%(),./\w\s+\-'"]*$/;
  const RISKY_VALUE_RE = /url\(|expression|javascript|vbscript|behavior|binding|image-set|@|\\/i;
  const SIZING = new Set(['fixed', 'fill', 'hug']);

  const KEYWORDS = {
    fontStyle: ['normal', 'italic', 'oblique'],
    textAlign: ['left', 'right', 'center', 'justify', 'start', 'end'],
    textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
    borderStyle: ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'none', 'hidden'],
    blend: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
      'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter'],
    overflow: ['visible', 'hidden', 'auto', 'clip', 'scroll'],
    objectFit: ['fill', 'contain', 'cover', 'none', 'scale-down'],
    cursor: ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'not-allowed', 'help', 'wait', 'progress',
      'crosshair', 'zoom-in', 'zoom-out', 'copy', 'cell', 'none'],
    fontWeight: ['normal', 'bold', 'bolder', 'lighter']
  };

  const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
  const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
  const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

  /** Inherited properties reset with `unset` in diffDecls (so they inherit again). */
  const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'text-shadow', 'cursor', 'visibility', 'white-space', 'word-spacing', 'overflow-wrap',
    'fill', 'stroke', 'stroke-width']);

  /* ------------------------------------------------------------ values */

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function fmt(n) {
    const r = Math.round(n * 1000) / 1000;
    return String(Object.is(r, -0) ? 0 : r);
  }

  /** px(12) → '12px'; px(0) → '0'. */
  function px(n) {
    if (!isNum(n)) return '';
    const s = fmt(n);
    return s === '0' ? '0' : s + 'px';
  }

  /** safeValue(value) → sanitized CSS value string or '' (numbers are formatted unitless). */
  function safeValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? fmt(value) : '';
    if (typeof value !== 'string') return '';
    const v = value.trim();
    if (!v || v.length > 4000) return '';
    if (FAST_VALUE_RE.test(v) && !RISKY_VALUE_RE.test(v)) return v;
    if (/[{}<>]|!\s*important/i.test(v)) return '';
    const out = sanitize.css('x: ' + v);
    return out.startsWith('x: ') && splitDecls(out).length === 1 ? out.slice(3) : '';
  }

  /** resolveTokens('$primary') → 'var(--t-primary)' (also inside gradients/shadows). */
  function resolveTokens(value) {
    if (typeof value !== 'string' || value.indexOf('$') === -1) return value;
    return value.replace(TOKEN_REF_RE, (_, id) => 'var(--t-' + id + ')');
  }

  /** cssValue(v) → token-resolved, sanitized CSS value or ''. */
  function cssValue(value) {
    return safeValue(resolveTokens(value));
  }

  function keyword(kind, value) {
    return typeof value === 'string' && KEYWORDS[kind].includes(value) ? value : '';
  }

  function lengthValue(v) {
    if (isNum(v)) return px(v);
    return typeof v === 'string' ? safeValue(v) : '';
  }

  /** boxValue(8) → '8px'; boxValue([1,2,1,2]) → '1px 2px 1px 2px'; equal sides collapse to one value. */
  function boxValue(v) {
    if (isNum(v)) return px(v);
    if (Array.isArray(v)) {
      const n = schema.normalizePad(v);
      if (n[0] === n[1] && n[1] === n[2] && n[2] === n[3]) return px(n[0]);
      return n.map(px).join(' ');
    }
    return typeof v === 'string' ? safeValue(v) : '';
  }

  function fontWeight(v) {
    if (isNum(v)) return v >= 1 && v <= 1000 ? fmt(v) : '';
    if (typeof v === 'string') return /^\d{3}$/.test(v) ? v : keyword('fontWeight', v);
    return '';
  }

  function fontFamily(v) {
    if (typeof v !== 'string' || /[;{}<>\\]/.test(v)) return '';
    return safeValue(v);
  }

  function mergeDefined(a, b) {
    const out = Object.assign({}, util.isPlainObject(a) ? a : {});
    if (util.isPlainObject(b)) for (const k of Object.keys(b)) if (b[k] !== undefined) out[k] = b[k];
    return out;
  }

  function toMap(decls) {
    if (Object.prototype.toString.call(decls) === '[object Map]') return decls;
    const m = new Map();
    if (decls && typeof decls === 'object') for (const k of Object.keys(decls)) m.set(k, decls[k]);
    return m;
  }

  function merge(target, source) {
    for (const [k, v] of source) target.set(k, v);
    return target;
  }

  /* ------------------------------------------------------------ lookups */

  function breakpoints(doc) {
    return doc && doc.settings && Array.isArray(doc.settings.breakpoints) && doc.settings.breakpoints.length
      ? doc.settings.breakpoints : schema.DEFAULT_BREAKPOINTS;
  }

  /** breakpoint(doc, bpId) → breakpoint object (base when unknown). */
  function breakpoint(doc, bpId) {
    const bps = breakpoints(doc);
    return bps.find((b) => b && b.id === bpId) || bps[0];
  }

  function textTokenStyle(doc, id) {
    if (typeof id !== 'string' || !id) return null;
    const key = id.charAt(0) === '$' ? id.slice(1) : id;
    const list = doc && doc.tokens && Array.isArray(doc.tokens.text) ? doc.tokens.text : [];
    const tok = list.find((t) => t && t.id === key);
    return tok && util.isPlainObject(tok.style) ? tok.style : null;
  }

  /** resolvedStyle(eff, doc) → node style with its text-style token merged underneath. */
  function resolvedStyle(eff, doc) {
    const own = eff && util.isPlainObject(eff.style) ? eff.style : {};
    const tok = textTokenStyle(doc, own.textStyle);
    return tok ? mergeDefined(tok, own) : own;
  }

  function effective(doc, idOrNode, bpId) {
    return schema.effectiveNode(doc, idOrNode, bpId);
  }

  /* ---------------------------------------------------------------- box */

  function bpWidth(bp, fallback) {
    if (isNum(bp)) return bp;
    if (bp && isNum(bp.width)) return bp.width;
    return isNum(fallback) ? fallback : 1440;
  }

  /**
   * boxDecls(eff, parentEff, { mode, bp }) — positioning & sizing. `bp` is the breakpoint object
   * (or its width); only the editor page root uses it.
   */
  function boxDecls(eff, parentEff, opts) {
    const o = opts || {};
    const mode = o.mode === 'editor' ? 'editor' : 'export';
    const d = new Map();
    if (!eff) return d;
    const sizing = util.isPlainObject(eff.sizing) ? eff.sizing : {};
    const sw = SIZING.has(sizing.w) ? sizing.w : 'fixed';
    const sh = SIZING.has(sizing.h) ? sizing.h : 'fixed';
    const w = isNum(eff.w) ? Math.max(0, eff.w) : 0;
    const h = isNum(eff.h) ? Math.max(0, eff.h) : 0;

    if (!parentEff) {
      d.set('position', 'relative');
      if (eff.type === 'page') {
        if (mode === 'editor') {
          d.set('width', px(bpWidth(o.bp, w)));
          const minH = eff.props && isNum(eff.props.minHeight) ? eff.props.minHeight : h;
          d.set('min-height', px(Math.max(0, minH)));
        } else {
          d.set('width', '100%');
          d.set('min-height', '100vh');
        }
      } else {
        d.set('width', sw === 'fill' ? '100%' : sw === 'hug' ? 'auto' : px(w));
        d.set('height', sh === 'fill' ? '100%' : sh === 'hug' ? 'auto' : px(h));
      }
    } else if (parentEff.layout && parentEff.layout.mode === 'stack') {
      const dir = parentEff.layout.dir === 'row' ? 'row' : 'column';
      const stretch = parentEff.layout.align === 'stretch';
      const main = dir === 'row' ? 'w' : 'h';
      let flex = false;
      let alignSelf = false;
      const size = {};
      const min = {};
      for (const axis of ['w', 'h']) {
        const m = axis === 'w' ? sw : sh;
        if (m === 'fill') {
          if (axis === main) { flex = true; min[axis] = '0'; } else alignSelf = true;
        } else if (m === 'hug') {
          size[axis] = axis !== main && stretch ? 'fit-content' : 'auto';
        } else {
          size[axis] = px(axis === 'w' ? w : h);
        }
      }
      d.set('position', 'relative');
      if (size.w) d.set('width', size.w);
      if (size.h) d.set('height', size.h);
      if (min.w) d.set('min-width', min.w);
      if (min.h) d.set('min-height', min.h);
      if (flex) d.set('flex', '1 1 0');
      else d.set('flex-shrink', '0');
      if (alignSelf) d.set('align-self', 'stretch');
    } else {
      d.set('position', 'absolute');
      d.set('left', sw === 'fill' ? '0' : px(isNum(eff.x) ? eff.x : 0));
      d.set('top', sh === 'fill' ? '0' : px(isNum(eff.y) ? eff.y : 0));
      d.set('width', sw === 'fill' ? '100%' : sw === 'hug' ? 'auto' : px(w));
      d.set('height', sh === 'fill' ? '100%' : sh === 'hug' ? 'auto' : px(h));
    }
    if (isNum(eff.rotation) && eff.rotation % 360 !== 0) d.set('transform', 'rotate(' + fmt(eff.rotation) + 'deg)');
    return d;
  }

  /* ------------------------------------------------------------- layout */

  /** layoutDecls(eff) — stack containers → flexbox. Free containers emit nothing. */
  function layoutDecls(eff) {
    const d = new Map();
    const l = eff && eff.layout;
    if (!util.isPlainObject(l) || l.mode !== 'stack') return d;
    d.set('display', 'flex');
    d.set('flex-direction', l.dir === 'row' ? 'row' : 'column');
    if (l.wrap) d.set('flex-wrap', 'wrap');
    if (isNum(l.gap) && l.gap > 0) d.set('gap', px(l.gap));
    const pad = schema.normalizePad(l.pad);
    if (pad.some((v) => v !== 0)) d.set('padding', boxValue(pad));
    d.set('align-items', ALIGN[l.align] || 'flex-start');
    d.set('justify-content', JUSTIFY[l.justify] || 'flex-start');
    return d;
  }

  /* ------------------------------------------------------------- visual */

  function imageURL(fi, doc, o) {
    let src = '';
    if (typeof fi.asset === 'string' && fi.asset) {
      if (typeof o.assetURL === 'function') src = o.assetURL(fi.asset) || '';
      else {
        const a = doc && doc.assets && Object.prototype.hasOwnProperty.call(doc.assets, fi.asset) ? doc.assets[fi.asset] : null;
        src = a && typeof a.src === 'string' ? a.src : '';
      }
    }
    if (!src && typeof fi.src === 'string') src = fi.src;
    const safe = sanitize.url(src, 'image');
    return safe ? 'url("' + safe.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c)) + '")' : '';
  }

  /**
   * visualDecls(eff, doc, { mode, assetURL, style, omit }) — declarations from STYLE_KEYS.
   * `style` replaces the resolved node style (used for hover); `omit` overrides the element type's
   * `styleOmit` list.
   */
  function visualDecls(eff, doc, opts) {
    const o = opts || {};
    const d = new Map();
    if (!eff) return d;
    const s = util.isPlainObject(o.style) ? o.style : resolvedStyle(eff, doc);
    const omit = new Set(Array.isArray(o.omit) ? o.omit : elements.styleOmit(eff.type, eff));
    const has = (k) => !omit.has(k) && s[k] !== undefined && s[k] !== null && s[k] !== '';
    const set = (prop, val) => { if (val !== '' && val !== null && val !== undefined) d.set(prop, val); };
    const leaf = !util.isPlainObject(eff.layout);

    // Background (longhands only, so breakpoint diffs never reset each other).
    const fill = has('fill') ? cssValue(s.fill) : '';
    const gradient = /gradient\(/i.test(fill);
    const img = has('fillImage') && util.isPlainObject(s.fillImage) ? imageURL(s.fillImage, doc, o) : '';
    if (fill && !gradient) set('background-color', fill);
    if (img || gradient) {
      set('background-image', [img, gradient ? fill : ''].filter(Boolean).join(', '));
      if (img) {
        const fi = s.fillImage;
        const size = ['cover', 'contain', 'auto'].includes(fi.size) ? fi.size : (safeValue(fi.size) || 'cover');
        const pos = safeValue(fi.position) || 'center';
        const rep = fi.repeat ? 'repeat' : 'no-repeat';
        set('background-size', gradient ? size + ', auto' : size);
        set('background-position', gradient ? pos + ', center' : pos);
        set('background-repeat', gradient ? rep + ', no-repeat' : rep);
      }
    }

    if (has('color')) set('color', cssValue(s.color));
    if (has('fontFamily')) set('font-family', fontFamily(s.fontFamily));
    if (has('fontSize')) set('font-size', lengthValue(s.fontSize));
    if (has('fontWeight')) set('font-weight', fontWeight(s.fontWeight));
    if (has('fontStyle')) set('font-style', keyword('fontStyle', s.fontStyle));
    if (has('lineHeight')) set('line-height', isNum(s.lineHeight) ? fmt(s.lineHeight) : safeValue(s.lineHeight));
    if (has('letterSpacing')) set('letter-spacing', lengthValue(s.letterSpacing));
    if (has('textAlign')) set('text-align', keyword('textAlign', s.textAlign));
    if (has('textDecoration')) set('text-decoration', safeValue(s.textDecoration));
    if (has('textTransform')) set('text-transform', keyword('textTransform', s.textTransform));
    if (has('textShadow')) set('text-shadow', cssValue(s.textShadow));

    if (leaf && has('valign') && (s.valign === 'middle' || s.valign === 'bottom')) {
      d.set('display', 'flex');
      d.set('flex-direction', 'column');
      d.set('justify-content', VALIGN[s.valign]);
    }
    if (leaf && has('padding')) set('padding', boxValue(s.padding));

    if (has('borderWidth') && isNum(s.borderWidth) && s.borderWidth > 0) {
      set('border-width', px(s.borderWidth));
      set('border-style', (has('borderStyle') && keyword('borderStyle', s.borderStyle)) || 'solid');
      if (has('borderColor')) set('border-color', cssValue(s.borderColor));
    }
    if (has('radius')) set('border-radius', boxValue(s.radius));
    if (has('shadow')) set('box-shadow', cssValue(s.shadow));
    if (has('opacity') && isNum(s.opacity) && s.opacity < 1) set('opacity', fmt(Math.max(0, s.opacity)));
    if (has('blur') && isNum(s.blur) && s.blur > 0) set('filter', 'blur(' + px(s.blur) + ')');
    if (has('backdropBlur') && isNum(s.backdropBlur) && s.backdropBlur > 0) {
      set('-webkit-backdrop-filter', 'blur(' + px(s.backdropBlur) + ')');
      set('backdrop-filter', 'blur(' + px(s.backdropBlur) + ')');
    }
    if (has('blend') && s.blend !== 'normal') set('mix-blend-mode', keyword('blend', s.blend));
    if (has('overflow')) set('overflow', keyword('overflow', s.overflow));
    if (has('objectFit')) set('object-fit', keyword('objectFit', s.objectFit));
    if (has('objectPosition')) set('object-position', safeValue(s.objectPosition));
    if (has('cursor')) set('cursor', keyword('cursor', s.cursor));
    return d;
  }

  /** hoverDecls(eff, doc) — from states.hover.style (+ sanitized `transform`, composed with rotation). */
  function hoverDecls(eff, doc, opts) {
    const hover = eff && util.isPlainObject(eff.states) && util.isPlainObject(eff.states.hover) ? eff.states.hover.style : null;
    if (!util.isPlainObject(hover)) return new Map();
    const tok = textTokenStyle(doc, hover.textStyle);
    const d = visualDecls(eff, doc, Object.assign({}, opts, { style: tok ? mergeDefined(tok, hover) : hover }));
    if (typeof hover.transform === 'string' && hover.transform.trim()) {
      const t = safeValue(hover.transform);
      if (t) d.set('transform', isNum(eff.rotation) && eff.rotation % 360 !== 0 ? 'rotate(' + fmt(eff.rotation) + 'deg) ' + t : t);
    }
    return d;
  }

  /* ------------------------------------------------------------ strings */

  function splitDecls(str) {
    const out = [];
    let cur = '';
    let quote = '';
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (quote) {
        cur += c;
        if (c === '\\' && i + 1 < str.length) { cur += str[++i]; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  /** parseDecls('color: red; …') → Map (sanitized through sanitize.css). */
  function parseDecls(str) {
    const m = new Map();
    const clean = sanitize.css(typeof str === 'string' ? str : '');
    if (!clean) return m;
    for (const part of splitDecls(clean)) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      const prop = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (prop && val) m.set(prop, val);
    }
    return m;
  }

  function kebabProp(key) {
    return key.startsWith('--') ? key : util.kebab(key);
  }

  /** extraDecls({ alignItems: 'center' }) → Map (camelCase or kebab keys, values sanitized). */
  function extraDecls(extra) {
    const m = new Map();
    if (!extra) return m;
    const src = toMap(extra);
    for (const [k, v] of src) {
      if (typeof k !== 'string' || !/^-?-?[A-Za-z][A-Za-z0-9-]*$/.test(k)) continue;
      const val = cssValue(v);
      if (val) m.set(kebabProp(k), val);
    }
    return m;
  }

  /** declsToString(map, { sep = '; ' }) → 'position: absolute; left: 0'. */
  function declsToString(decls, opts) {
    const sep = (opts && opts.sep) || '; ';
    const parts = [];
    for (const [k, v] of toMap(decls)) if (v !== '' && v !== null && v !== undefined) parts.push(k + ': ' + v);
    return parts.join(sep);
  }

  /** declsToObject(map, { camel = true }) → plain object for VNode.style (custom properties keep their name). */
  function declsToObject(decls, opts) {
    const camel = !(opts && opts.camel === false);
    const out = {};
    for (const [k, v] of toMap(decls)) out[camel && !k.startsWith('--') ? util.camel(k) : k] = v;
    return out;
  }

  function resetValue(prop) {
    if (prop === 'display') return 'revert';
    return INHERITED.has(prop) ? 'unset' : 'initial';
  }

  /**
   * diffDecls(baseMap, map) → Map of declarations to emit on top of base: removed properties first
   * (reset to 'initial', 'unset' for inherited ones, 'revert' for display), then changed/added
   * ones in `map` order — so a shorthand reset never clobbers a longhand that follows it.
   */
  function diffDecls(baseMap, map) {
    const base = toMap(baseMap);
    const next = toMap(map);
    const out = new Map();
    for (const k of base.keys()) if (!next.has(k)) out.set(k, resetValue(k));
    for (const [k, v] of next) if (base.get(k) !== v) out.set(k, v);
    return out;
  }

  /* --------------------------------------------------------- node decls */

  /**
   * nodeDecls(doc, node, bpId, { mode, parentEff, bp, extra, assetURL, effective, box = true })
   * → Map. `parentEff` defaults to the effective parent (pass null for a root); `extra` is the
   * VNode.style of the type; `effective: true` skips the cascade (node is already effective).
   */
  function nodeDecls(doc, node, bpId, opts) {
    const o = opts || {};
    const d = new Map();
    const eff = o.effective ? (typeof node === 'object' ? node : schema.getNode(doc, node)) : schema.effectiveNode(doc, node, bpId);
    if (!eff) return d;
    let parentEff = o.parentEff;
    if (parentEff === undefined) parentEff = eff.parent ? schema.effectiveNode(doc, eff.parent, bpId) : null;
    if (o.box !== false) merge(d, boxDecls(eff, parentEff, { mode: o.mode, bp: o.bp || breakpoint(doc, bpId) }));
    merge(d, layoutDecls(eff));
    if (o.extra) merge(d, extraDecls(o.extra));
    merge(d, visualDecls(eff, doc, { mode: o.mode, assetURL: o.assetURL }));
    if (typeof eff.css === 'string' && eff.css.trim()) merge(d, parseDecls(eff.css));
    if (eff.hidden) d.set('display', 'none');
    return d;
  }

  /** tokensCSS(doc) → ':root{--t-primary:#2563eb;…}' ('' when the document has no color tokens). */
  function tokensCSS(doc) {
    const list = doc && doc.tokens && Array.isArray(doc.tokens.colors) ? doc.tokens.colors : [];
    const parts = [];
    for (const t of list) {
      if (!t || typeof t.id !== 'string' || !TOKEN_ID_RE.test(t.id)) continue;
      const v = cssValue(t.value);
      if (v) parts.push('--t-' + t.id + ':' + v);
    }
    return parts.length ? ':root{' + parts.join(';') + '}' : '';
  }

  /* ------------------------------------------------ design-unit helpers */

  const SCALE_PROPS = new Set(['left', 'top', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height', 'max-width',
    'max-height', 'font-size', 'letter-spacing', 'gap', 'padding', 'border-width', 'border-radius', 'flex-basis']);

  /**
   * designUnitDecls(decls, { designWidth = 1440, unit = 'var(--u)', centerLeft = false }) → new Map
   * where px lengths of geometric/typographic properties become `calc(N * var(--u))`. With
   * `centerLeft`, `left` also gets the centering offset for screens wider than the design width.
   */
  function designUnitDecls(decls, opts) {
    const o = opts || {};
    const unit = typeof o.unit === 'string' && o.unit ? o.unit : 'var(--u)';
    const W = isNum(o.designWidth) && o.designWidth > 0 ? o.designWidth : 1440;
    const out = new Map();
    for (const [k, v] of toMap(decls)) {
      if (!SCALE_PROPS.has(k) || typeof v !== 'string' || !/\dpx\b/.test(v)) { out.set(k, v); continue; }
      let nv = v.replace(/(-?\d*\.?\d+)px\b/g, (_, n) => 'calc(' + n + ' * ' + unit + ')');
      if (k === 'left' && o.centerLeft && /^-?\d*\.?\d+px$/.test(v)) {
        nv = 'calc(max(0px, (100cqw - ' + fmt(W) + 'px) / 2) + ' + parseFloat(v) + ' * ' + unit + ')';
      }
      out.set(k, nv);
    }
    return out;
  }

  /** designUnitVars(designWidth, { name = '--u' }) → Map for the scaling container (free section). */
  function designUnitVars(designWidth, opts) {
    const W = isNum(designWidth) && designWidth > 0 ? designWidth : 1440;
    const name = opts && typeof opts.name === 'string' && /^--[A-Za-z0-9_-]+$/.test(opts.name) ? opts.name : '--u';
    return new Map([['container-type', 'inline-size'], [name, 'min(1px, calc(100cqw / ' + fmt(W) + '))']]);
  }

  return {
    effective, nodeDecls, boxDecls, layoutDecls, visualDecls, hoverDecls, tokensCSS,
    declsToString, declsToObject, diffDecls, parseDecls, extraDecls,
    designUnitDecls, designUnitVars,
    cssValue, safeValue, resolveTokens, px, fmt, boxValue, resolvedStyle, breakpoint, resetValue
  };
});

/* @node-testable */
/*
 * element-types — the 14 core element types, registered into `elements`. See ARCHITECTURE.md §5.4.
 *
 * VNode functions receive the *effective* node (after the breakpoint cascade) and a ctx
 * (`{ mode, doc, bp, effective, assetURL, resolveURL, sanitizeHTML, escape, icon, cssValue }`).
 * They never position themselves; `VNode.style` only carries type-intrinsic CSS (resets, centering,
 * shape painting) which the renderer/exporter merges with the node's resolved declarations.
 */
APB.define('element-types', ['elements', 'util', 'sanitize'], function (elements, util, sanitize) {
  'use strict';

  const TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'blockquote', 'label', 'li'];
  const SECTION_TAGS = ['section', 'header', 'footer', 'nav', 'main', 'aside', 'article', 'div'];
  const FRAME_TAGS = ['div', 'article', 'aside', 'header', 'footer', 'nav', 'figure', 'section'];
  const SHAPES = ['rect', 'ellipse', 'line', 'triangle', 'star', 'arrow', 'polygon'];
  const SVG_SHAPES = ['triangle', 'star', 'arrow', 'polygon'];
  const LINE_STYLES = ['solid', 'dashed', 'dotted', 'double'];

  const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">' +
    '<rect width="320" height="240" fill="#e5e7eb"/><circle cx="104" cy="84" r="22" fill="#9ca3af"/>' +
    '<path d="M32 204l76-76 52 52 44-44 84 68z" fill="#9ca3af"/></svg>';
  /** Neutral placeholder for images without a source (img-loaded SVG cannot run scripts). */
  const PLACEHOLDER_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(PLACEHOLDER_SVG);

  /* ------------------------------------------------------------ helpers */

  const str = (v) => (v === null || v === undefined ? '' : String(v));
  const opt = (value, label) => ({ value, label });

  function lazyStyle() {
    return typeof APB !== 'undefined' && APB.has('style') ? APB.require('style') : null;
  }

  function cssValueOf(ctx) {
    if (ctx && typeof ctx.cssValue === 'function') return ctx.cssValue;
    const style = lazyStyle();
    return style ? style.cssValue : () => '';
  }

  function resolveURL(ctx, url, kind) {
    const fn = ctx && typeof ctx.resolveURL === 'function' ? ctx.resolveURL : sanitize.url;
    return typeof url === 'string' && url.trim() ? (fn(url.trim(), kind) || '') : '';
  }

  function sanitizeHTML(ctx, html, profile) {
    const fn = ctx && typeof ctx.sanitizeHTML === 'function' ? ctx.sanitizeHTML : sanitize.html;
    return fn(str(html), profile);
  }

  /** Link attributes; in the editor the URL is kept as data-href so links never navigate. */
  function linkAttrs(p, ctx) {
    const href = resolveURL(ctx, p.href, 'link');
    if (!href) return null;
    const attrs = {};
    if (ctx && ctx.mode === 'editor') attrs['data-href'] = href;
    else attrs.href = href;
    if (p.target === '_blank') { attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
    return attrs;
  }

  const notTypes = (...types) => (childType) => !types.includes(childType);

  function fmtN(n) {
    const r = Math.round(n * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
  }

  function regularPoints(count, rOuter, rInner) {
    const total = rInner === undefined ? count : count * 2;
    const pts = [];
    for (let i = 0; i < total; i++) {
      const r = rInner === undefined || i % 2 === 0 ? rOuter : rInner;
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / total;
      pts.push(fmtN(50 + r * Math.cos(a)) + ',' + fmtN(50 + r * Math.sin(a)));
    }
    return pts.join(' ');
  }

  /** shapePoints('star', { points: 5 }) → SVG polygon points in a 0 0 100 100 viewBox. */
  function shapePoints(shape, props) {
    const p = props || {};
    const count = (v, d) => util.clamp(Math.round(Number.isFinite(v) ? v : d), 3, 32);
    switch (shape) {
      case 'triangle': return '50,0 100,100 0,100';
      case 'arrow': return '0,30 60,30 60,0 100,50 60,100 60,70 0,70';
      case 'star': return regularPoints(count(p.points, 5), 50, 19.1);
      case 'polygon': return regularPoints(count(p.sides, 6), 50);
      default: return '0,0 100,0 100,100 0,100';
    }
  }

  function firstColor(value) {
    const m = /(#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|color)\([^()]*\)|var\(--t-[A-Za-z0-9_-]+\))/.exec(value);
    return m ? m[1] : '';
  }

  /* -------------------------------------------------------- inspector */

  const LINK_FIELDS = [
    { key: 'props.href', label: 'Link', type: 'url', placeholder: 'https://' },
    { key: 'props.target', label: 'Open in', type: 'select', options: [opt('', 'Same tab'), opt('_blank', 'New tab')] }
  ];

  /* ------------------------------------------------------------ types */

  const defs = [];

  defs.push({
    type: 'page', label: 'Page', icon: 'page', category: 'layout', container: true, insertable: false,
    accepts: notTypes('page'),
    caps: { fill: true, border: false, radius: false, shadow: false, effects: false },
    defaults: () => ({
      name: 'Page', w: 1440, h: 900, sizing: { w: 'fixed', h: 'hug' },
      layout: { mode: 'stack', dir: 'column', gap: 0, align: 'stretch' },
      style: { fill: '#ffffff' }, props: { minHeight: 900 }
    }),
    vnode: () => ({ tag: 'div', attrs: {}, slot: true }),
    inspector: [{ title: 'Page', fields: [{ key: 'props.minHeight', label: 'Min height', type: 'number', min: 0, step: 10 }] }]
  });

  defs.push({
    type: 'section', label: 'Section', icon: 'section', category: 'layout', container: true,
    accepts: notTypes('page'),
    caps: { fill: true, border: true, radius: true, shadow: true, effects: true },
    defaults: () => ({
      name: 'Section', w: 1440, h: 640, sizing: { w: 'fill', h: 'fixed' },
      layout: { mode: 'free' }, props: { tag: 'section' }
    }),
    vnode: (node) => {
      const p = node.props || {};
      return { tag: SECTION_TAGS.includes(p.tag) ? p.tag : 'section', attrs: {}, slot: true };
    },
    inspector: [{
      title: 'Section', fields: [{
        key: 'props.tag', label: 'HTML tag', type: 'select',
        options: SECTION_TAGS.map((t) => opt(t, '<' + t + '>'))
      }]
    }]
  });

  defs.push({
    type: 'frame', label: 'Frame', icon: 'frame', category: 'layout', container: true,
    accepts: notTypes('page', 'section'),
    caps: { fill: true, border: true, radius: true, shadow: true, effects: true },
    defaults: () => ({
      name: 'Frame', w: 320, h: 240, layout: { mode: 'free' }, props: { tag: 'div', href: '', target: '' }
    }),
    vnode: (node, ctx) => {
      const p = node.props || {};
      const link = linkAttrs(p, ctx);
      if (link) return { tag: 'a', attrs: link, style: { display: 'block', color: 'inherit', textDecoration: 'none' }, slot: true };
      return { tag: FRAME_TAGS.includes(p.tag) ? p.tag : 'div', attrs: {}, slot: true };
    },
    inspector: [{
      title: 'Frame', fields: [
        { key: 'props.tag', label: 'HTML tag', type: 'select', options: FRAME_TAGS.map((t) => opt(t, '<' + t + '>')) }
      ].concat(LINK_FIELDS)
    }]
  });

  defs.push({
    type: 'group', label: 'Group', icon: 'group', category: 'layout', container: true, insertable: false,
    accepts: notTypes('page', 'section'),
    caps: { fill: false, border: false, radius: false, shadow: false, text: false, padding: false, effects: true },
    styleOmit: ['fill', 'fillImage', 'borderWidth', 'borderStyle', 'borderColor', 'radius', 'shadow', 'padding'],
    defaults: () => ({ name: 'Group', w: 100, h: 100, layout: { mode: 'free' } }),
    vnode: () => ({ tag: 'div', attrs: {}, slot: true }),
    inspector: []
  });

  defs.push({
    type: 'text', label: 'Text', icon: 'text', category: 'text',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    bpProps: ['text', 'html'],
    textEdit: 'text',
    defaults: () => ({
      name: 'Text', w: 320, h: 64,
      style: { fontSize: 18, lineHeight: 1.5, color: '#111827' },
      props: { text: 'Text', html: null, tag: 'p', href: '', target: '' }
    }),
    vnode: (node, ctx) => {
      const p = node.props || {};
      const tag = TEXT_TAGS.includes(p.tag) ? p.tag : 'p';
      const content = {};
      if (typeof p.html === 'string' && p.html) content.html = sanitizeHTML(ctx, p.html, tag === 'div' || tag === 'blockquote' ? 'rich' : 'inline');
      else content.text = str(p.text);
      const style = { margin: '0', overflowWrap: 'break-word' };
      if (content.text !== undefined) style.whiteSpace = 'pre-wrap';
      const link = linkAttrs(p, ctx);
      if (link) return { tag, attrs: {}, style, children: [Object.assign({ tag: 'a', attrs: link }, content)] };
      return Object.assign({ tag, attrs: {}, style }, content);
    },
    inspector: [{
      title: 'Content', fields: [
        { key: 'props.text', label: 'Text', type: 'textarea' },
        { key: 'props.tag', label: 'HTML tag', type: 'select', options: TEXT_TAGS.map((t) => opt(t, '<' + t + '>')) }
      ].concat(LINK_FIELDS)
    }]
  });

  defs.push({
    type: 'button', label: 'Button', icon: 'button', category: 'basic',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    bpProps: ['text'],
    textEdit: 'text',
    defaults: () => ({
      name: 'Button', w: 160, h: 48,
      style: { fill: '#2563eb', color: '#ffffff', radius: 10, padding: [12, 20, 12, 20], fontSize: 16, fontWeight: 600, lineHeight: 1.2, textAlign: 'center' },
      props: { text: 'Get started', href: '', target: '', kind: 'button' }
    }),
    vnode: (node, ctx) => {
      const p = node.props || {};
      const style = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', margin: '0', border: '0',
        fontFamily: 'inherit', textDecoration: 'none', cursor: 'pointer'
      };
      const link = linkAttrs(p, ctx);
      if (link) return { tag: 'a', attrs: link, style, text: str(p.text) };
      const attrs = { type: ['button', 'submit', 'reset'].includes(p.kind) ? p.kind : 'button' };
      if (ctx && ctx.mode === 'editor') attrs.tabindex = '-1';
      return { tag: 'button', attrs, style, text: str(p.text) };
    },
    inspector: [{
      title: 'Content', fields: [
        { key: 'props.text', label: 'Label', type: 'text' }
      ].concat(LINK_FIELDS, [
        { key: 'props.kind', label: 'Button type', type: 'select', options: [opt('button', 'Button'), opt('submit', 'Submit'), opt('reset', 'Reset')] }
      ])
    }]
  });

  defs.push({
    type: 'image', label: 'Image', icon: 'image', category: 'media',
    caps: { fill: true, border: true, radius: true, shadow: true, effects: true, image: true },
    defaults: () => ({
      name: 'Image', w: 320, h: 240, style: { objectFit: 'cover' },
      props: { src: '', asset: '', alt: '', decorative: false, loading: 'lazy', fetchpriority: '' }
    }),
    vnode: (node, ctx) => {
      const p = node.props || {};
      let src = '';
      if (typeof p.asset === 'string' && p.asset && ctx && typeof ctx.assetURL === 'function') src = ctx.assetURL(p.asset) || '';
      if (!src) src = resolveURL(ctx, p.src, 'image');
      const attrs = { src: src || PLACEHOLDER_IMAGE, alt: p.decorative ? '' : str(p.alt) };
      if (p.decorative) attrs.role = 'presentation';
      const sizing = node.sizing || {};
      if (sizing.w !== 'fill' && sizing.w !== 'hug' && Number.isFinite(node.w) && node.w > 0) attrs.width = String(Math.round(node.w));
      if (sizing.h !== 'fill' && sizing.h !== 'hug' && Number.isFinite(node.h) && node.h > 0) attrs.height = String(Math.round(node.h));
      if (ctx && ctx.mode === 'editor') {
        attrs.draggable = 'false';
      } else {
        if (p.loading === 'lazy' || p.loading === 'eager') attrs.loading = p.loading;
        if (['high', 'low', 'auto'].includes(p.fetchpriority)) attrs.fetchpriority = p.fetchpriority;
        attrs.decoding = 'async';
      }
      if (!src) attrs['data-placeholder'] = '';
      return { tag: 'img', attrs, style: { display: 'block' } };
    },
    audit: (node) => {
      const p = node.props || {};
      return !p.decorative && !str(p.alt).trim()
        ? [{ rule: 'img-alt', severity: 'error', message: 'Image has no alternative text' }] : [];
    },
    inspector: [{
      title: 'Image', fields: [
        { key: 'props.asset', label: 'Image', type: 'asset', accept: 'image/*' },
        { key: 'props.src', label: 'Image URL', type: 'url', placeholder: 'https://' },
        { key: 'props.alt', label: 'Alt text', type: 'textarea' },
        { key: 'props.decorative', label: 'Decorative (no alt)', type: 'toggle' },
        { key: 'props.loading', label: 'Loading', type: 'select', options: [opt('lazy', 'Lazy'), opt('eager', 'Eager')] },
        { key: 'props.fetchpriority', label: 'Priority', type: 'select', options: [opt('', 'Default'), opt('high', 'High'), opt('low', 'Low')] }
      ]
    }]
  });

  defs.push({
    type: 'shape', label: 'Shape', icon: 'shape', category: 'basic',
    caps: { fill: true, border: true, radius: true, shadow: true, effects: true, stroke: true },
    styleOmit: (eff) => {
      const shape = eff && eff.props ? eff.props.shape : 'rect';
      if (SVG_SHAPES.includes(shape) || shape === 'line') return ['fill', 'fillImage', 'radius', 'borderWidth', 'borderStyle', 'borderColor', 'padding'];
      if (shape === 'ellipse') return ['radius'];
      return [];
    },
    defaults: () => ({
      name: 'Shape', w: 160, h: 160, style: { fill: '#93c5fd' },
      props: { shape: 'rect', sides: 6, points: 5 }
    }),
    vnode: (node, ctx) => {
      const p = node.props || {};
      const s = node.style || {};
      const cssv = cssValueOf(ctx);
      const shape = SHAPES.includes(p.shape) ? p.shape : 'rect';
      const has = (k) => s[k] !== undefined && s[k] !== null && s[k] !== '';
      const stroke = has('stroke') ? cssv(s.stroke) : '';
      const sw = Number.isFinite(s.strokeWidth) ? Math.max(0, s.strokeWidth) : 0;
      if (shape === 'rect' || shape === 'ellipse') {
        const style = {};
        if (shape === 'ellipse') style.borderRadius = '50%';
        if (stroke && sw > 0) style.border = fmtN(sw) + 'px solid ' + stroke;
        return { tag: 'div', attrs: { 'aria-hidden': 'true' }, style };
      }
      if (shape === 'line') {
        const color = stroke || (has('fill') ? firstColor(cssv(s.fill)) || cssv(s.fill) : '') || 'currentColor';
        const lineStyle = LINE_STYLES.includes(s.borderStyle) ? s.borderStyle : 'solid';
        return { tag: 'div', attrs: { 'aria-hidden': 'true' }, style: { borderTop: fmtN(sw > 0 ? sw : 2) + 'px ' + lineStyle + ' ' + color } };
      }
      let fill = has('fill') ? cssv(s.fill) : '';
      if (/gradient\(/i.test(fill)) fill = firstColor(fill) || 'currentColor';
      const style = { display: 'block', overflow: 'visible', fill: fill || 'none' };
      if (stroke && sw > 0) { style.stroke = stroke; style.strokeWidth = fmtN(sw) + 'px'; style.strokeLinejoin = 'round'; }
      return {
        tag: 'svg',
        attrs: { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
        style,
        children: [{ tag: 'polygon', attrs: { points: shapePoints(shape, p), 'vector-effect': 'non-scaling-stroke' } }]
      };
    },
    inspector: [{
      title: 'Shape', fields: [
        { key: 'props.shape', label: 'Shape', type: 'select', options: SHAPES.map((sh) => opt(sh, sh.charAt(0).toUpperCase() + sh.slice(1))) },
        { key: 'props.sides', label: 'Sides', type: 'number', min: 3, max: 32, step: 1, when: (n) => n.props && n.props.shape === 'polygon' },
        { key: 'props.points', label: 'Points', type: 'number', min: 3, max: 32, step: 1, when: (n) => n.props && n.props.shape === 'star' },
        { key: 'style.stroke', label: 'Stroke', type: 'color' },
        { key: 'style.strokeWidth', label: 'Stroke width', type: 'number', min: 0, step: 1 }
      ]
    }]
  });

  defs.push({
    type: 'divider', label: 'Divider', icon: 'divider', category: 'basic',
    caps: { fill: true, border: false, radius: true, shadow: false, effects: true },
    defaults: () => ({ name: 'Divider', w: 480, h: 2, style: { fill: '#e5e7eb' }, props: {} }),
    vnode: () => ({ tag: 'hr', attrs: {}, style: { margin: '0', border: '0' } }),
    inspector: []
  });

  defs.push({
    type: 'spacer', label: 'Spacer', icon: 'spacer', category: 'layout',
    caps: { fill: false, border: false, radius: false, shadow: false, effects: false },
    styleOmit: ['fill', 'fillImage', 'borderWidth', 'borderStyle', 'borderColor', 'radius', 'shadow', 'padding'],
    defaults: () => ({ name: 'Spacer', w: 100, h: 32, props: {} }),
    vnode: () => ({ tag: 'div', attrs: { 'aria-hidden': 'true' } }),
    inspector: []
  });

  defs.push({
    type: 'list', label: 'List', icon: 'list', category: 'text',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    bpProps: ['items'],
    defaults: () => ({
      name: 'List', w: 320, h: 120,
      style: { fontSize: 16, lineHeight: 1.6, color: '#111827' },
      props: { items: ['First item', 'Second item', 'Third item'], ordered: false }
    }),
    vnode: (node) => {
      const p = node.props || {};
      const items = Array.isArray(p.items) ? p.items : [];
      return {
        tag: p.ordered ? 'ol' : 'ul', attrs: {}, style: { margin: '0', paddingLeft: '1.5em' },
        children: items.map((it) => ({ tag: 'li', text: util.isPlainObject(it) ? str(it.text) : str(it) }))
      };
    },
    inspector: [{
      title: 'List', fields: [
        { key: 'props.items', label: 'Items', type: 'list' },
        { key: 'props.ordered', label: 'Numbered', type: 'toggle' }
      ]
    }]
  });

  defs.push({
    type: 'table', label: 'Table', icon: 'table', category: 'text',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    bpProps: ['rows', 'caption'],
    defaults: () => ({
      name: 'Table', w: 480, h: 160,
      style: { fontSize: 16, lineHeight: 1.5, color: '#111827' },
      props: { rows: [['Plan', 'Price'], ['Basic', '$9'], ['Pro', '$29']], header: true, caption: '' }
    }),
    vnode: (node) => {
      const p = node.props || {};
      const rows = Array.isArray(p.rows) ? p.rows.filter(Array.isArray) : [];
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const cells = (row, tag) => {
        const out = [];
        for (let i = 0; i < cols; i++) {
          const cell = { tag, text: str(row[i]) };
          if (tag === 'th') cell.attrs = { scope: 'col' };
          out.push(cell);
        }
        return out;
      };
      const children = [];
      if (str(p.caption).trim()) children.push({ tag: 'caption', text: str(p.caption) });
      let body = rows;
      if (p.header !== false && rows.length) {
        children.push({ tag: 'thead', children: [{ tag: 'tr', children: cells(rows[0], 'th') }] });
        body = rows.slice(1);
      }
      if (body.length) children.push({ tag: 'tbody', children: body.map((r) => ({ tag: 'tr', children: cells(r, 'td') })) });
      return { tag: 'table', attrs: {}, style: { borderCollapse: 'collapse' }, children };
    },
    inspector: [{
      title: 'Table', fields: [
        { key: 'props.rows', label: 'Cells', type: 'table' },
        { key: 'props.header', label: 'First row is header', type: 'toggle' },
        { key: 'props.caption', label: 'Caption', type: 'text' }
      ]
    }]
  });

  defs.push({
    type: 'html', label: 'HTML', icon: 'code', category: 'advanced',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    defaults: () => ({ name: 'HTML', w: 320, h: 160, props: { html: '<p>Custom HTML</p>' } }),
    vnode: (node, ctx) => ({ tag: 'div', attrs: {}, html: sanitizeHTML(ctx, (node.props || {}).html, 'html') }),
    inspector: [{ title: 'HTML', fields: [{ key: 'props.html', label: 'HTML (sanitized)', type: 'code', language: 'html' }] }]
  });

  defs.push({
    type: 'instance', label: 'Instance', icon: 'component', category: 'advanced', insertable: false,
    caps: { fill: false, border: false, radius: false, shadow: false, effects: true },
    styleOmit: ['fill', 'fillImage', 'borderWidth', 'borderStyle', 'borderColor', 'radius', 'shadow', 'padding'],
    defaults: () => ({ name: 'Instance', w: 320, h: 240, props: { component: '', overrides: {} } }),
    vnode: (node, ctx) => {
      // Expansion of the component master (with overrides) lives in vdom; required lazily.
      if (ctx && ctx.doc && typeof APB !== 'undefined' && APB.has('vdom')) {
        const v = APB.require('vdom').instanceVNode(ctx.doc, node, ctx);
        if (v) return v;
      }
      return { tag: 'div', attrs: { 'data-component-missing': '' } };
    },
    inspector: [{ title: 'Component', fields: [{ key: 'props.component', label: 'Component', type: 'select', options: 'components' }] }]
  });

  // A type registered earlier by someone else (e.g. a replacement) is kept.
  const registered = defs.map((def) => elements.get(def.type) || elements.register(Object.assign({ core: true }, def)));

  return { TYPES: registered.map((d) => d.type), PLACEHOLDER_IMAGE, TEXT_TAGS, SECTION_TAGS, FRAME_TAGS, SHAPES, shapePoints };
});

/* @node-testable */
/*
 * exporters — `services.exporters` (ARCHITECTURE.md §11): turns a document into standalone,
 * dependency-free HTML/CSS(/JS). Pure string building (no DOM at call time — every function here
 * works in Node), so it can be unit-tested directly; the plugin at the bottom only attaches
 * `app.services.exporters` and a toolbar "Export" button.
 *
 * `html()` renders the base breakpoint once for markup, then re-renders at every other breakpoint
 * to diff declarations per node class into `@media (max-width)` blocks (`style.diffDecls`) —
 * the class name is a short id (`n-<id>`), stable across breakpoints so the diff lines up.
 * A `<script>` with `actions.runtimeSource()` is appended only when the document actually uses
 * node actions (`core/actions.js`); that's also the only time nodes get `data-node-id`, since the
 * runtime targets other nodes by it.
 */
APB.define('exporters', ['schema', 'vdom', 'style', 'sanitize', 'util', 'actions'], function (schema, vdom, style, sanitize, util, actionsMod) {
  'use strict';

  function shortClass(id) {
    return 'n-' + String(id).replace(/^n_/, '');
  }

  function pageFor(doc, pageId) {
    const pages = Array.isArray(doc && doc.pages) ? doc.pages : [];
    return pages.find((p) => p.id === pageId) || pages[0] || null;
  }

  function docHasActions(doc) {
    const nodes = doc && doc.nodes;
    if (!util.isPlainObject(nodes)) return false;
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      if (n && Array.isArray(n.actions) && n.actions.length) return true;
    }
    return false;
  }

  /** Light, safe CSS minifier: this app only ever feeds it CSS it built itself (not arbitrary input). */
  function minifyCSS(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,])\s*/g, '$1').replace(/;}/g, '}').trim();
  }

  function base64ToBytes(b64) {
    if (typeof atob !== 'function') return null;
    let bin;
    try { bin = atob(b64); } catch (err) { return null; }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const DATA_URL_RE = /^data:([^;,]+)(;charset=[^;,]+)?;base64,([\s\S]*)$/i;

  /** assetResolver({ inlineAssets }) → { assetURL(id), files } — extracts data: assets to files when inlining is off. */
  function assetResolver(doc, opts) {
    const files = [];
    const paths = new Map();
    let seq = 0;
    function assetURL(id) {
      const asset = doc.assets && doc.assets[id];
      if (!asset || typeof asset.src !== 'string') return '';
      const safe = sanitize.url(asset.src, 'image') || sanitize.url(asset.src, 'media') || '';
      if (opts.inlineAssets !== false || !safe) return safe;
      if (paths.has(id)) return paths.get(id);
      const m = DATA_URL_RE.exec(safe);
      if (!m) { paths.set(id, safe); return safe; }
      const mime = m[1];
      const bytes = base64ToBytes(m[3]);
      if (!bytes) { paths.set(id, safe); return safe; }
      const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
      const base = sanitize.id(asset.name || id) || id;
      const path = 'assets/' + base + '-' + (++seq) + '.' + ext;
      files.push({ path, data: bytes, mime });
      paths.set(id, path);
      return path;
    }
    return { assetURL, files };
  }

  function metaHTML(doc, page, opts) {
    const seo = util.isPlainObject(page && page.seo) ? page.seo : {};
    const title = util.escapeHTML(seo.title || (page && page.name) || (doc && doc.name) || 'Untitled');
    const lines = [
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">'
    ];
    if (seo.description) lines.push('<meta name="description" content="' + util.escapeAttr(seo.description) + '">');
    const ogTitle = seo.title || (page && page.name) || '';
    if (ogTitle) lines.push('<meta property="og:title" content="' + util.escapeAttr(ogTitle) + '">');
    if (seo.description) lines.push('<meta property="og:description" content="' + util.escapeAttr(seo.description) + '">');
    if (seo.ogImage) {
      const u = sanitize.url(seo.ogImage, 'image');
      if (u) lines.push('<meta property="og:image" content="' + util.escapeAttr(u) + '">');
    }
    if (seo.canonical) {
      const u = sanitize.url(seo.canonical, 'link');
      if (u) lines.push('<link rel="canonical" href="' + util.escapeAttr(u) + '">');
    }
    if (seo.noindex) lines.push('<meta name="robots" content="noindex, nofollow">');
    lines.push('<meta name="referrer" content="strict-origin-when-cross-origin">');
    const csp = "default-src 'self'; img-src 'self' data: https:; font-src 'self' https: data:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'" + (opts.withActions ? " 'unsafe-inline'" : '') +
      "; base-uri 'none'; form-action 'self'";
    lines.push('<meta http-equiv="Content-Security-Policy" content="' + util.escapeAttr(csp) + '">');
    const favicon = doc.settings && doc.settings.favicon ? sanitize.url(doc.settings.favicon, 'image') : '';
    if (favicon) lines.push('<link rel="icon" href="' + util.escapeAttr(favicon) + '">');
    return { head: lines.join('\n'), title };
  }

  /**
   * html(doc, { pageId, minify, inlineAssets = true, includeHidden = false, motion = true,
   *   sourceComment = true }) → { html, css, files }
   */
  function html(doc, opts) {
    const o = opts || {};
    const page = pageFor(doc, o.pageId);
    if (!page || !doc.nodes[page.root]) return null;
    const minify = !!o.minify;
    const withActions = docHasActions(doc);
    const classFor = (eff) => shortClass(eff.id);
    const baseBp = style.breakpoint(doc, undefined);
    const { assetURL, files } = assetResolver(doc, o);

    const baseClasses = new Map();
    const hoverRules = [];
    const htmlTree = vdom.buildTree(doc, page.root, {
      mode: 'export', bp: baseBp.id, classFor, withIds: withActions, includeHidden: !!o.includeHidden, assetURL,
      onNode: (info) => {
        const cls = classFor(info.node);
        baseClasses.set(cls, info.decls);
        const hover = style.hoverDecls(info.node, doc);
        if (hover.size) hoverRules.push({ cls, decls: hover });
      }
    });
    if (!htmlTree) return null;

    const bps = (doc.settings && Array.isArray(doc.settings.breakpoints) && doc.settings.breakpoints.length)
      ? doc.settings.breakpoints : schema.DEFAULT_BREAKPOINTS;
    const mediaBlocks = [];
    for (let i = 1; i < bps.length; i++) {
      const bp = bps[i];
      const bpClasses = new Map();
      vdom.buildTree(doc, page.root, {
        mode: 'export', bp: bp.id, classFor, withIds: false, includeHidden: true, assetURL,
        onNode: (info) => { bpClasses.set(classFor(info.node), info.decls); }
      });
      const rules = [];
      for (const [cls, baseDecls] of baseClasses) {
        const bpDecls = bpClasses.get(cls);
        if (!bpDecls) continue;
        const diff = style.diffDecls(baseDecls, bpDecls);
        if (diff.size) rules.push('.' + cls + '{' + style.declsToString(diff) + '}');
      }
      if (rules.length && Number.isFinite(bp.max)) mediaBlocks.push('@media (max-width:' + bp.max + 'px){' + rules.join('') + '}');
    }

    const classRules = [];
    for (const [cls, decls] of baseClasses) if (decls.size) classRules.push('.' + cls + '{' + style.declsToString(decls) + '}');
    const hoverCSS = hoverRules.filter((r) => r.decls.size).map((r) => '.' + r.cls + ':hover{' + style.declsToString(r.decls) + '}');
    const tokensCSS = style.tokensCSS(doc);
    const globalCSS = doc.settings && typeof doc.settings.globalCSS === 'string' ? sanitize.stylesheet(doc.settings.globalCSS) : '';

    let css = [tokensCSS, classRules.join(''), hoverCSS.join(''), mediaBlocks.join(''), globalCSS].filter(Boolean).join('\n');
    if (minify) css = minifyCSS(css);

    const bodyHTML = vdom.toHTML(htmlTree, { pretty: !minify });
    const script = withActions ? '<script>' + actionsMod.runtimeSource() + '</script>' : '';
    const { head, title } = metaHTML(doc, page, { withActions });
    const lang = (doc.settings && doc.settings.lang) || 'en';
    const comment = o.sourceComment !== false ? '<!-- Built with Advanced Page Builder (zero-dependency, single file) -->\n' : '';

    const out = comment +
      '<!doctype html>\n<html lang="' + util.escapeAttr(lang) + '">\n<head>\n' + head + '\n<title>' + title + '</title>\n' +
      (css ? '<style>' + css + '</style>\n' : '') + '</head>\n<body>\n' + bodyHTML + (script ? '\n' + script : '') + '\n</body>\n</html>\n';

    return { html: minify ? out.replace(/\n+/g, '\n') : out, css, files };
  }

  /** site(doc, opts) → files [{ path, data, mime }] — one HTML file per page plus shared assets. */
  function site(doc, opts) {
    const o = opts || {};
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const files = [];
    const seenAssets = new Set();
    for (const page of pages) {
      const out = html(doc, Object.assign({}, o, { pageId: page.id }));
      if (!out) continue;
      const path = page.slug === 'index' || !page.slug ? 'index.html' : page.slug + '.html';
      files.push({ path, data: out.html, mime: 'text/html; charset=utf-8' });
      for (const f of out.files) {
        if (seenAssets.has(f.path)) continue;
        seenAssets.add(f.path);
        files.push(f);
      }
    }
    return files;
  }

  /** json(doc) → pretty JSON string of the document as-is (the `.apb.json` project format). */
  function jsonExport(doc) {
    return JSON.stringify(doc, null, 2);
  }

  /* ------------------------------------------------------------------- zip */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  }());

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data);
      const out = [];
      for (let i = 0; i < data.length; i++) out.push(data.charCodeAt(i) & 0xff);
      return new Uint8Array(out);
    }
    return new Uint8Array(0);
  }

  function dosDateTime() {
    const d = new Date();
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  function writeU16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
  function writeU32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

  /** zip(files: [{ path, data, mime }]) → Blob — zero-dep ZIP, STORE (uncompressed) method. */
  function zip(files) {
    const list = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string' && f.path);
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime();
    for (const f of list) {
      const nameBytes = toBytes(f.path.replace(/\\/g, '/'));
      const data = toBytes(f.data);
      const crc = crc32(data);
      const local = [];
      writeU32(local, 0x04034b50);
      writeU16(local, 20); writeU16(local, 0); writeU16(local, 0);
      writeU16(local, time); writeU16(local, date);
      writeU32(local, crc); writeU32(local, data.length); writeU32(local, data.length);
      writeU16(local, nameBytes.length); writeU16(local, 0);
      const localHeader = new Uint8Array(local);
      chunks.push(localHeader, nameBytes, data);
      const localSize = localHeader.length + nameBytes.length + data.length;

      const cd = [];
      writeU32(cd, 0x02014b50);
      writeU16(cd, 20); writeU16(cd, 20); writeU16(cd, 0); writeU16(cd, 0);
      writeU16(cd, time); writeU16(cd, date);
      writeU32(cd, crc); writeU32(cd, data.length); writeU32(cd, data.length);
      writeU16(cd, nameBytes.length); writeU16(cd, 0); writeU16(cd, 0);
      writeU16(cd, 0); writeU16(cd, 0); writeU32(cd, 0);
      writeU32(cd, offset);
      central.push(new Uint8Array(cd), nameBytes);
      offset += localSize;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = [];
    writeU32(eocd, 0x06054b50);
    writeU16(eocd, 0); writeU16(eocd, 0);
    writeU16(eocd, list.length); writeU16(eocd, list.length);
    writeU32(eocd, centralSize); writeU32(eocd, centralStart);
    writeU16(eocd, 0);
    const parts = chunks.concat(central, [new Uint8Array(eocd)]);
    return new Blob(parts, { type: 'application/zip' });
  }

  /* ------------------------------------------------------------------- jsx */

  const JSX_PROP_ALIASES = { class: 'className', for: 'htmlFor' };
  const JSX_VOID = vdom.VOID;

  function jsxAttrs(v) {
    const attrs = util.isPlainObject(v.attrs) ? v.attrs : {};
    const out = [];
    for (const key of Object.keys(attrs)) {
      if (key === 'data-node-id') continue;
      const val = attrs[key];
      const prop = JSX_PROP_ALIASES[key] || key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (val === true) out.push(prop + '={true}');
      else if (typeof val === 'string') out.push(prop + '="' + val.replace(/"/g, '&quot;') + '"');
    }
    if (util.isPlainObject(v.style) && Object.keys(v.style).length) {
      const decls = Object.keys(v.style).map((k) => k + ': ' + JSON.stringify(v.style[k])).join(', ');
      out.push('style={{' + decls + '}}');
    }
    return out.length ? ' ' + out.join(' ') : '';
  }

  function jsxNode(v, depth) {
    if (v === null || v === undefined || v === false) return '';
    if (typeof v === 'string') return util.escapeHTML(v);
    if (typeof v !== 'object') return '';
    const tag = String(v.tag || 'div');
    const attrs = jsxAttrs(v);
    if (JSX_VOID.has(tag)) return '<' + tag + attrs + ' />';
    let inner = '';
    if (typeof v.text === 'string') inner = util.escapeHTML(v.text);
    else if (typeof v.html === 'string') return '<' + tag + attrs + ' dangerouslySetInnerHTML={{ __html: ' + JSON.stringify(v.html) + ' }} />';
    else if (Array.isArray(v.children)) inner = v.children.map((c) => jsxNode(c, depth + 1)).join('');
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  }

  /** jsx(doc, { pageId }) → string — a self-contained React component (inline styles, no classes). */
  function jsx(doc, opts) {
    const o = opts || {};
    const page = pageFor(doc, o.pageId);
    if (!page || !doc.nodes[page.root]) return null;
    const baseBp = style.breakpoint(doc, undefined);
    const tree = vdom.buildTree(doc, page.root, { mode: 'export', bp: baseBp.id, withIds: false, includeHidden: !!o.includeHidden, inlineStyles: true });
    if (!tree) return null;
    const name = util.isPlainObject(page.seo) && page.seo.title ? page.seo.title : (page.name || 'Page');
    const compName = (name.replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || 'Page');
    const tokensCSS = style.tokensCSS(doc);
    const body = jsxNode(tree, 0);
    return 'export default function ' + compName + '() {\n  return (\n    <>\n' +
      (tokensCSS ? '      <style>{' + JSON.stringify(tokensCSS) + '}</style>\n' : '') +
      '      ' + body + '\n    </>\n  );\n}\n';
  }

  const api = { html, site, zip, json: jsonExport, jsx, shortClass, docHasActions };

  if (typeof APB !== 'undefined' && APB.plugin) {
    APB.plugin({
      id: 'exporters',
      order: 60,
      requires: ['widgets', 'icons'],
      init(app) {
        app.services = app.services || {};
        app.services.exporters = api;
      }
    });
  }

  return api;
});

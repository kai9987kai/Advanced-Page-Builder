/* @node-testable */
/*
 * sanitize — HTML / URL / CSS sanitizers. See ARCHITECTURE.md §6.5.
 *
 * - url(), css(), stylesheet(), id(), className() are pure string functions (work in Node).
 * - html() parses into an inert DOMParser document, optionally runs the native Sanitizer API
 *   (Element.prototype.setHTML) first, then ALWAYS runs the allowlist walker and re-parses the
 *   result until the serialization is stable (mXSS defence). Without a DOM (Node) html() escapes
 *   everything, so its output is always inert.
 */
APB.define('sanitize', ['util'], function (util) {
  'use strict';

  const g = globalThis;
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  /* ============================================================== URLs */

  const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp)(;[a-z0-9-]+=[a-z0-9.+-]+)*(;base64)?,[a-z0-9+/=%._~!$&'()*,;:@?-]*$/i;
  const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

  const KIND_SCHEMES = {
    link: ['http', 'https', 'mailto', 'tel'],
    image: ['http', 'https', 'blob', 'data'],
    media: ['http', 'https', 'blob'],
    embed: ['https']
  };

  function httpURL(s) {
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;
    return u;
  }

  function normalizeEmbed(s) {
    const u = httpURL(s);
    if (!u || u.protocol !== 'https:' || u.port) return '';
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
    const path = u.pathname;
    const ytId = (id) => (/^[A-Za-z0-9_-]{6,20}$/.test(id || '') ? id : '');
    const ytStart = () => {
      const t = u.searchParams.get('start') || u.searchParams.get('t') || '';
      let sec = 0;
      if (/^\d+s?$/.test(t)) {
        sec = parseInt(t, 10);
      } else {
        const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
        if (hms) sec = (Number(hms[1]) || 0) * 3600 + (Number(hms[2]) || 0) * 60 + (Number(hms[3]) || 0);
      }
      return sec > 0 ? '?start=' + sec : '';
    };
    if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
      let id = '';
      if (path === '/watch') id = ytId(u.searchParams.get('v'));
      else {
        const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(path);
        if (m) id = ytId(m[1]);
      }
      return id ? 'https://www.youtube-nocookie.com/embed/' + id + ytStart() : '';
    }
    if (host === 'youtu.be') {
      const id = ytId(path.slice(1).split('/')[0]);
      return id ? 'https://www.youtube-nocookie.com/embed/' + id + ytStart() : '';
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const m = /^\/(?:video\/)?(\d{3,12})(?:\/([0-9a-f]{6,20}))?/.exec(path);
      if (!m) return '';
      const hash = m[2] || u.searchParams.get('h');
      return 'https://player.vimeo.com/video/' + m[1] + (hash && /^[0-9a-f]{6,20}$/.test(hash) ? '?h=' + hash : '');
    }
    if (host === 'google.com' || host === 'maps.google.com') {
      if (host === 'google.com' && !/^\/maps(\/|$)/.test(path)) return '';
      if (/^\/maps\/embed/.test(path)) return 'https://www.google.com' + path + u.search;
      const q = u.searchParams.get('q');
      if (q) return 'https://www.google.com/maps?q=' + encodeURIComponent(q) + '&output=embed';
      return 'https://www.google.com' + (host === 'maps.google.com' ? '/maps' : path) + u.search;
    }
    if (host === 'open.spotify.com') {
      const m = /^\/(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{8,40})/.exec(path);
      return m ? 'https://open.spotify.com/embed/' + m[1] + '/' + m[2] : '';
    }
    if (host === 'codepen.io') {
      const m = /^\/([A-Za-z0-9_-]{1,64})\/(?:pen|embed|full|details)\/([A-Za-z0-9]{3,20})/.exec(path);
      return m ? 'https://codepen.io/' + m[1] + '/embed/' + m[2] + '?default-tab=result' : '';
    }
    if (host === 'loom.com') {
      const m = /^\/(?:share|embed)\/([0-9a-f]{16,64})/.exec(path);
      return m ? 'https://www.loom.com/embed/' + m[1] : '';
    }
    if (host === 'figma.com' || host === 'embed.figma.com') {
      if (/^\/embed/.test(path) && host === 'figma.com') return 'https://www.figma.com/embed' + u.search;
      if (/^\/(file|design|proto|board|slides)\//.test(path)) {
        const clean = 'https://www.figma.com' + path + u.search;
        return 'https://www.figma.com/embed?embed_host=share&url=' + encodeURIComponent(clean);
      }
      return '';
    }
    return '';
  }

  /**
   * url(str, kind = 'link') → normalized URL or ''.
   * kinds: link | image | media | embed (see contract §6.5).
   */
  function url(input, kind = 'link') {
    if (typeof input !== 'string') return '';
    let s = input.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
    if (!s || s.length > 8 * 1024 * 1024) return '';
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return '';
    const allowed = KIND_SCHEMES[kind] || KIND_SCHEMES.link;
    if (kind === 'embed') return normalizeEmbed(s.startsWith('//') ? 'https:' + s : s);

    if (s.startsWith('//')) s = 'https:' + s;
    if (/^[\\/][\\/]/.test(s) || s.startsWith('/\\')) return '';

    const m = SCHEME_RE.exec(s);
    if (!m) {
      // Relative reference. Refuse anything that could be re-interpreted as a scheme by a parser.
      if (s.includes('\\')) return '';
      const beforePathEnd = s.split(/[/?#]/)[0];
      if (beforePathEnd.includes(':')) return '';
      if (kind !== 'link' && s[0] === '#') return '';
      return s.replace(/[\s"'<>`]/g, (c) => encodeURIComponent(c));
    }
    const scheme = m[1].toLowerCase();
    if (!allowed.includes(scheme)) return '';
    if (scheme === 'http' || scheme === 'https') {
      const u = httpURL(s);
      return u ? u.href : '';
    }
    if (scheme === 'data') {
      return DATA_IMAGE_RE.test(s) ? s : '';
    }
    if (scheme === 'blob') {
      return /^blob:(null|https?:\/\/[^\s/]+|file:\/\/)\/[0-9a-f-]{8,}$/i.test(s) ? s : '';
    }
    if (scheme === 'mailto') {
      return /^mailto:[^\s<>"'`\\]*$/i.test(s) ? s : '';
    }
    if (scheme === 'tel') {
      return /^tel:\+?[0-9()\-.\s/;=a-z]{1,64}$/i.test(s) ? s.replace(/\s+/g, '') : '';
    }
    return '';
  }

  /* =============================================================== CSS */

  const MAX_CSS = 5000;
  const CSS_PROP_RE = /^(--[a-zA-Z0-9_-]{1,64}|-?[a-zA-Z][a-zA-Z0-9-]{0,64})$/;
  const BANNED_CSS = ['expression(', 'javascript:', 'vbscript:', 'behavior', '-moz-binding', 'binding:', 'image-set(', 'src(', 'element(', '@import'];

  function decodeCSSEscapes(str) {
    return str
      .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex) => {
        const cp = parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd';
      })
      .replace(/\\([^0-9a-fA-F\n])/g, '$1');
  }

  function stripComments(str) {
    let out = str.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = out.indexOf('/*');
    if (open >= 0) out = out.slice(0, open);
    return out;
  }

  function splitDeclarations(str) {
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
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(quote ? '' : cur); // unterminated string → drop
    return out;
  }

  const URL_FN_RE = /url\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|([^)"'\s\\]*))\s*\)/gi;

  function sanitizeValue(value) {
    let v = value.trim();
    if (!v || v.length > MAX_CSS) return '';
    if (/[<>{}@]/.test(v)) return '';
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(v)) return '';
    const lowered = decodeCSSEscapes(v).toLowerCase().replace(/\s+/g, '');
    for (const bad of BANNED_CSS) if (lowered.includes(bad)) return '';
    if (lowered.includes('url(')) {
      let ok = true;
      let found = 0;
      v = v.replace(URL_FN_RE, (_, dq, sq, bare) => {
        found++;
        const safe = url(dq !== undefined ? dq : sq !== undefined ? sq : bare, 'image');
        if (!safe) { ok = false; return 'none'; }
        return 'url("' + safe.replace(/["\\\n]/g, (c) => encodeURIComponent(c)) + '")';
      });
      if (!ok || !found) return '';
      // Any url( left over (escaped or malformed) → reject.
      const rest = v.replace(/url\("[^"]*"\)/gi, '');
      if (decodeCSSEscapes(rest).toLowerCase().replace(/\s+/g, '').includes('url(')) return '';
    }
    return v;
  }

  /** css('color: red; background: url(x.png)') → sanitized declaration list ('' when nothing survives). */
  function css(declarations) {
    if (typeof declarations !== 'string') return '';
    let src = declarations;
    let truncated = false;
    if (src.length > MAX_CSS) { src = src.slice(0, MAX_CSS); truncated = true; }
    src = stripComments(src);
    const parts = splitDeclarations(src);
    if (truncated && parts.length && !/;\s*$/.test(src)) parts.pop();
    const out = [];
    for (const part of parts) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      const prop = part.slice(0, idx).trim();
      let value = part.slice(idx + 1).trim();
      if (!CSS_PROP_RE.test(prop)) continue;
      const propLower = prop.toLowerCase();
      if (propLower === 'behavior' || propLower === '-moz-binding' || propLower === 'binding') continue;
      let important = '';
      const im = /\s*!\s*important\s*$/i.exec(value);
      if (im) { important = ' !important'; value = value.slice(0, im.index); }
      const safe = sanitizeValue(value);
      if (!safe) continue;
      out.push((prop.startsWith('--') ? prop : propLower) + ': ' + safe + important);
    }
    return out.join('; ');
  }

  /** stylesheet(css) → text safe to place inside a <style> element (global CSS). */
  function stylesheet(text) {
    if (typeof text !== 'string') return '';
    let s = text.replace(/\u0000/g, '');
    // Normalise escapes of ASCII word characters so obfuscated keywords are caught.
    s = s.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (m, hex) => {
      const ch = String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd);
      return /[a-zA-Z0-9:(\-]/.test(ch) ? ch : m;
    });
    s = s.replace(/\\([a-zA-Z:(])/g, '$1');
    let prev;
    do {
      prev = s;
      s = s
        .replace(/<\/?(style|script)/gi, '')
        .replace(/<!--|-->/g, '')
        .replace(/@import[^;]*(;|$)/gi, '')
        .replace(/@charset[^;]*(;|$)/gi, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/vbscript\s*:/gi, '')
        .replace(/expression\s*\(/gi, '(')
        .replace(/-moz-binding\s*:[^;}]*/gi, '')
        .replace(/behavior\s*:[^;}]*/gi, '');
    } while (s !== prev);
    s = s.replace(URL_FN_RE, (_, dq, sq, bare) => {
      const safe = url(dq !== undefined ? dq : sq !== undefined ? sq : bare, 'image');
      return safe ? 'url("' + safe.replace(/["\\\n]/g, (c) => encodeURIComponent(c)) + '")' : 'none';
    });
    return s;
  }

  /* ======================================================== id / class */

  const RESERVED_PREFIX = /^apb-/i;

  /** id('Hero title') → 'Hero-title'; '' when nothing valid is left or the id is reserved. */
  function id(str) {
    if (typeof str !== 'string') return '';
    let s = str.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
    if (!s) return '';
    if (!/^[A-Za-z]/.test(s)) s = 'id-' + s.replace(/^[-_]+/, '');
    s = s.slice(0, 64);
    if (RESERVED_PREFIX.test(s)) return '';
    return s;
  }

  /** className('a b 1bad apb-x a') → 'a b' (valid, unique, non-reserved tokens). */
  function className(str) {
    if (typeof str !== 'string') return '';
    const seen = new Set();
    return str.split(/\s+/)
      .filter((t) => t && t.length <= 64 && /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(t) && !RESERVED_PREFIX.test(t))
      .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
      .slice(0, 32)
      .join(' ');
  }

  /* ============================================================== HTML */

  const INLINE_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'mark', 'small', 'sub', 'sup', 'code', 'br', 'span', 'a',
    'del', 'ins', 'abbr', 'q', 'kbd', 'time'];
  const RICH_TAGS = INLINE_TAGS.concat(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr',
    'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'caption', 'tr', 'th', 'td', 'img', 'dl', 'dt', 'dd']);
  const HTML_TAGS = RICH_TAGS.concat(['div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'details',
    'summary', 'label', 'button', 'input', 'select', 'option', 'textarea', 'form', 'fieldset', 'legend']);

  const PROFILES = {
    inline: new Set(INLINE_TAGS),
    rich: new Set(RICH_TAGS),
    html: new Set(HTML_TAGS)
  };

  /** Removed together with their content. */
  const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math',
    'template', 'noscript', 'frame', 'frameset', 'applet', 'noembed', 'noframes', 'xmp', 'plaintext', 'title', 'head',
    'portal', 'fencedframe', 'param', 'source', 'track', 'audio', 'video', 'picture', 'canvas', 'dialog', 'slot', 'selectedcontent']);

  const ARIA_ATTRS = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-expanded', 'aria-controls',
    'aria-current', 'aria-live', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-disabled', 'aria-haspopup',
    'aria-level', 'aria-roledescription', 'aria-details', 'aria-required', 'aria-invalid', 'aria-atomic', 'aria-busy'];
  const GLOBAL_ATTRS = ['title', 'lang', 'dir', 'class', 'id', 'role', 'translate'].concat(ARIA_ATTRS);

  const ELEMENT_ATTRS = {
    a: ['href', 'target', 'rel', 'hreflang'],
    img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'reversed', 'type'],
    li: ['value'],
    blockquote: ['cite'],
    q: ['cite'],
    del: ['cite', 'datetime'],
    ins: ['cite', 'datetime'],
    time: ['datetime'],
    abbr: [],
    details: ['open'],
    label: ['for'],
    button: ['type', 'disabled', 'name', 'value'],
    input: ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'checked', 'readonly', 'min', 'max', 'step',
      'minlength', 'maxlength', 'pattern', 'autocomplete', 'multiple', 'size', 'inputmode'],
    select: ['name', 'required', 'disabled', 'multiple', 'size'],
    option: ['value', 'selected', 'disabled', 'label'],
    textarea: ['name', 'placeholder', 'rows', 'cols', 'required', 'disabled', 'readonly', 'minlength', 'maxlength'],
    form: ['method', 'novalidate', 'autocomplete'],
    fieldset: ['disabled']
  };

  const INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'password', 'search', 'date', 'time',
    'datetime-local', 'month', 'week', 'checkbox', 'radio', 'range', 'color', 'hidden', 'submit', 'reset', 'button']);
  const TARGETS = new Set(['_blank', '_self', '_parent', '_top']);
  const REL_TOKENS = new Set(['noopener', 'noreferrer', 'nofollow', 'ugc', 'sponsored', 'external', 'author', 'license', 'me', 'help', 'tag', 'prev', 'next']);
  const INT_ATTRS = new Set(['width', 'height', 'colspan', 'rowspan', 'start', 'rows', 'cols', 'size', 'minlength', 'maxlength']);

  function allAttrNames(profile) {
    const set = new Set(GLOBAL_ATTRS);
    for (const tag of PROFILES[profile]) (ELEMENT_ATTRS[tag] || []).forEach((a) => set.add(a));
    if (profile === 'html') set.add('style');
    return Array.from(set);
  }

  /*
   * DOM clobbering guard: ids/names that shadow window, document or form properties are dropped.
   * The reserved set is computed once from prototypes/own globals (never from named-access
   * properties created by elements), so results are deterministic within a session.
   */
  let reservedNames = null;
  function getReservedNames() {
    if (reservedNames) return reservedNames;
    const set = new Set();
    const addChain = (obj) => {
      let p = obj;
      let guard = 0;
      while (p && guard++ < 20) {
        let tag = '';
        try { tag = Object.prototype.toString.call(p); } catch (_) { tag = ''; }
        if (tag !== '[object WindowProperties]') {
          try { Object.getOwnPropertyNames(p).forEach((n) => set.add(n)); } catch (_) { /* ignore */ }
        }
        p = Object.getPrototypeOf(p);
      }
    };
    try {
      if (typeof g.window !== 'undefined') addChain(g.window);
      if (typeof g.document !== 'undefined') addChain(g.document);
      if (typeof g.HTMLFormElement === 'function') addChain(g.HTMLFormElement.prototype);
    } catch (_) { /* ignore */ }
    reservedNames = set;
    return set;
  }

  function isClobberingName(name) {
    if (!name) return true;
    return getReservedNames().has(name) || RESERVED_PREFIX.test(name);
  }

  function cleanAttribute(el, tag, attr, profile, allowedForTag) {
    const name = attr.name.toLowerCase();
    let value = attr.value;
    if (attr.namespaceURI || name.includes(':')) return null;
    if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action' || name === 'is') return null;
    if (name === 'style') {
      if (profile !== 'html') return null;
      const v = css(value);
      return v || null;
    }
    if (name.startsWith('data-')) {
      if (profile !== 'html' || !/^data-[a-z0-9_.-]{1,64}$/.test(name) || value.length > 2000) return null;
      return value;
    }
    if (!GLOBAL_ATTRS.includes(name) && !allowedForTag.includes(name)) return null;
    if (value.length > 10000) return null;
    switch (name) {
      case 'id': {
        const v = id(value);
        return v && v === value && !isClobberingName(v) ? v : null;
      }
      case 'class': return className(value) || null;
      case 'role': return /^[a-z]+( [a-z]+)*$/.test(value.trim()) ? value.trim() : null;
      case 'dir': return /^(ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
      case 'lang': case 'hreflang': return /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(value) ? value : null;
      case 'translate': return /^(yes|no)$/i.test(value) ? value.toLowerCase() : null;
      case 'href': return url(value, 'link') || null;
      case 'cite': return url(value, 'link') || null;
      case 'src': return url(value, 'image') || null;
      case 'target': return TARGETS.has(value.toLowerCase()) ? value.toLowerCase() : null;
      case 'rel': {
        const tokens = value.toLowerCase().split(/\s+/).filter((t) => REL_TOKENS.has(t));
        return tokens.length ? util.uniq(tokens).join(' ') : null;
      }
      case 'type':
        if (tag === 'input') return INPUT_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : null;
        if (tag === 'button') return /^(button|submit|reset)$/i.test(value) ? value.toLowerCase() : null;
        if (tag === 'ol') return /^[1aAiI]$/.test(value) ? value : null;
        return null;
      case 'name':
        return /^[A-Za-z][A-Za-z0-9_.\-[\]]{0,63}$/.test(value) && !isClobberingName(value) ? value : null;
      case 'for':
        return id(value) === value ? value : null;
      case 'method': return /^(get|post)$/i.test(value) ? value.toLowerCase() : null;
      case 'loading': return /^(lazy|eager)$/i.test(value) ? value.toLowerCase() : null;
      case 'decoding': return /^(async|sync|auto)$/i.test(value) ? value.toLowerCase() : null;
      case 'scope': return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value.toLowerCase() : null;
      case 'pattern': return value.length <= 500 ? value : null;
      default:
        if (INT_ATTRS.has(name) || (name === 'value' && tag === 'li')) {
          return /^\d{1,6}$/.test(value.trim()) ? value.trim() : null;
        }
        return value;
    }
  }

  function sanitizeElementAttrs(el, tag, profile) {
    const allowedForTag = ELEMENT_ATTRS[tag] || [];
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      let cleaned = null;
      try { cleaned = cleanAttribute(el, tag, attr, profile, allowedForTag); } catch (_) { cleaned = null; }
      if (cleaned === null) {
        el.removeAttributeNode(attr);
      } else if (cleaned !== attr.value) {
        el.setAttribute(attr.name, cleaned);
      }
    }
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      const rel = new Set((el.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      el.setAttribute('rel', Array.from(rel).join(' '));
    }
  }

  const MAX_DEPTH = 200;

  function walk(parent, profile, depth) {
    const allowed = PROFILES[profile];
    let child = parent.firstChild;
    while (child) {
      let next = child.nextSibling;
      if (child.nodeType === 3) {
        // text: keep
      } else if (child.nodeType === 1) {
        const tag = String(child.localName || '').toLowerCase();
        if (child.namespaceURI !== XHTML_NS || DROP_TAGS.has(tag) || depth > MAX_DEPTH) {
          parent.removeChild(child);
        } else if (!allowed.has(tag)) {
          const first = child.firstChild;
          while (child.firstChild) parent.insertBefore(child.firstChild, child);
          parent.removeChild(child);
          if (first) next = first;
        } else {
          sanitizeElementAttrs(child, tag, profile);
          if (tag === 'img' && !child.getAttribute('src')) {
            parent.removeChild(child);
          } else {
            walk(child, profile, depth + 1);
          }
        }
      } else {
        parent.removeChild(child); // comments, processing instructions, CDATA
      }
      child = next;
    }
  }

  let parser = null;
  /** Body of a fresh inert (script-less, no browsing context) document, optionally parsed from markup. */
  function inertBody(markup) {
    if (!parser) parser = new g.DOMParser();
    if (markup !== undefined) {
      const parsed = parser.parseFromString(markup, 'text/html');
      if (parsed.body) return parsed.body;
    }
    return parser.parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html').body;
  }

  function hasDOM() {
    return typeof g.DOMParser === 'function';
  }

  function nativeFirstPass(str, profile) {
    try {
      const body = inertBody();
      const container = body.ownerDocument.createElement('div');
      body.appendChild(container);
      if (typeof container.setHTML !== 'function') return null;
      container.setHTML(str, {
        sanitizer: {
          elements: Array.from(PROFILES[profile]),
          attributes: allAttrNames(profile),
          comments: false,
          dataAttributes: profile === 'html'
        }
      });
      return container;
    } catch (_) {
      return null;
    }
  }

  /**
   * html(str, profile = 'rich') → sanitized HTML string.
   * Profiles: 'inline' | 'rich' | 'html'. Node (no DOMParser): escapes everything.
   */
  function html(str, profile = 'rich') {
    if (str === null || str === undefined) return '';
    const input = String(str);
    if (!PROFILES[profile]) profile = 'inline';
    if (!hasDOM()) return util.escapeHTML(input);
    try {
      let root = nativeFirstPass(input, profile) || inertBody(input);
      walk(root, profile, 0);
      let out = root.innerHTML;
      // Re-parse until the serialization is stable (defends against parser mutations / mXSS).
      for (let i = 0; i < 4; i++) {
        root = inertBody(out);
        walk(root, profile, 0);
        const again = root.innerHTML;
        if (again === out) return out;
        out = again;
      }
      return util.escapeHTML(root.textContent || '');
    } catch (_) {
      return util.escapeHTML(input);
    }
  }

  /** toText(html) → plain text (tags removed, entities decoded in the browser). */
  function toText(str) {
    if (str === null || str === undefined) return '';
    const input = String(str);
    if (hasDOM()) {
      try {
        const body = inertBody(input);
        body.querySelectorAll('script,style,template,noscript').forEach((n) => n.remove());
        body.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
        return (body.textContent || '').replace(/\u00a0/g, ' ');
      } catch (_) { /* fall through */ }
    }
    return input
      .replace(/<(script|style|template)[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  return {
    html, url, css, stylesheet, id, className, toText,
    PROFILES: { inline: INLINE_TAGS.slice(), rich: RICH_TAGS.slice(), html: HTML_TAGS.slice() }
  };
});

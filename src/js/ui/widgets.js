/*
 * widgets — DOM helper + accessible form controls for the editor UI (ARCHITECTURE.md §8, PLAN B2).
 *
 * Every control returns its root element with `el.apbControl = { value (get/set, no events), setMixed(bool),
 * setDisabled(bool), focus(), labelTarget, … }`. Change callbacks are `onInput(value, { commit })`:
 * `commit: false` while the user is dragging/typing, `commit: true` when a discrete value is final.
 * Never uses innerHTML — all text goes through text nodes.
 */
APB.define('widgets', ['env', 'color', 'commands', 'icons'], function (env, color, commands, icons) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted', 'defaultValue']);
  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']);
  const LABELABLE = /^(INPUT|SELECT|TEXTAREA|BUTTON|METER|OUTPUT|PROGRESS)$/;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], summary';

  let seq = 0;
  const uid = (prefix) => (prefix || 'apb') + '-' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isFn = (f) => typeof f === 'function';

  /* ================================================================== h() */

  function classNames(v) {
    if (!v) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(classNames).filter(Boolean).join(' ');
    if (typeof v === 'object') return Object.keys(v).filter((k) => v[k]).join(' ');
    return String(v);
  }

  function appendChildren(el, children) {
    for (const child of children) {
      if (child == null || child === false || child === true) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else if (typeof child === 'object' && typeof child.nodeType === 'number') el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
    return el;
  }

  function applyAttrs(el, attrs) {
    let ref = null;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (key === 'class' || key === 'className') {
        const c = classNames(v);
        if (c) el.setAttribute('class', c);
      } else if (key === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else if (v && typeof v === 'object') {
          for (const prop of Object.keys(v)) {
            const val = v[prop];
            if (val == null || val === false) continue;
            if (prop.includes('-')) el.style.setProperty(prop, String(val));
            else el.style[prop] = String(val);
          }
        }
      } else if (key === 'dataset') {
        if (v) for (const k of Object.keys(v)) if (v[k] != null) el.dataset[k] = String(v[k]);
      } else if (key === 'on') {
        if (v) for (const evt of Object.keys(v)) if (isFn(v[evt])) el.addEventListener(evt, v[evt]);
      } else if (key === 'ref') {
        ref = v;
      } else if (/^on[A-Z]/.test(key) && isFn(v)) {
        el.addEventListener(key.slice(2).toLowerCase(), v);
      } else if (/^on/i.test(key) || key === 'html' || key === 'innerHTML' || key === 'outerHTML' || key === 'srcdoc') {
        continue; // never inline handlers or raw markup
      } else if (PROPS.has(key)) {
        if (v != null) el[key] = v;
      } else {
        const name = key === 'htmlFor' ? 'for' : key === 'tabIndex' ? 'tabindex' : key;
        if (name.startsWith('aria-')) {
          if (v != null) el.setAttribute(name, String(v));
        } else if (v == null || v === false) {
          continue;
        } else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript|data:text)/i.test(String(v))) {
          continue;
        } else {
          el.setAttribute(name, v === true ? '' : String(v));
        }
      }
    }
    if (isFn(ref)) ref(el);
  }

  /** h(tag, attrs?, ...children) — hyperscript. 'svg:path' creates SVG elements. */
  function h(tag, attrs, ...children) {
    if (typeof tag !== 'string' || !tag) throw new TypeError('widgets.h: tag must be a non-empty string');
    const el = tag.startsWith('svg:') ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
    if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs) || typeof attrs.nodeType === 'number')) {
      children.unshift(attrs);
      attrs = null;
    }
    if (attrs) applyAttrs(el, attrs);
    return appendChildren(el, children);
  }

  function iconNode(icon, size, className) {
    if (!icon) return null;
    if (typeof icon === 'object' && typeof icon.nodeType === 'number') return icon;
    return icons.get(String(icon), { size, className });
  }

  function focusables(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.closest('[hidden], [inert]') &&
      (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function control(el) {
    return (el && el.apbControl) || null;
  }

  function decimals(n) {
    const s = String(n);
    if (s.includes('e-')) return Number(s.split('e-')[1]) || 0;
    const i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  }

  /* ============================================================ keyboard labels */

  function parseCombo(combo) {
    try { return commands.parseKey(combo); } catch (_) { return null; }
  }

  function ariaKeys(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return list.filter(Boolean).map((combo) => {
      const p = parseCombo(combo);
      if (!p) return String(combo);
      const mods = p.mods.map((m) => ({ mod: env.mac ? 'Meta' : 'Control', ctrl: 'Control', meta: 'Meta', alt: 'Alt', shift: 'Shift' })[m] || m);
      return mods.concat(p.key === 'Space' ? 'Space' : p.key).join('+');
    }).join(' ');
  }

  function spokenKeys(combo) {
    const p = parseCombo(combo);
    if (!p) return String(combo);
    const names = { mod: env.mac ? 'Command' : 'Control', ctrl: 'Control', meta: env.mac ? 'Command' : 'Windows', alt: env.mac ? 'Option' : 'Alt', shift: 'Shift' };
    const keyNames = { ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow', '[': 'Left bracket',
      ']': 'Right bracket', '=': 'Equals', '-': 'Minus', '/': 'Slash', '\\': 'Backslash', '?': 'Question mark' };
    return p.mods.map((m) => names[m] || m).concat(keyNames[p.key] || p.key).join(' ');
  }

  /** kbd(keys) → <span class="apb-kbd-group"> with one <kbd> per chord (formatted for the platform). */
  function kbd(keys) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    const group = h('span', { class: 'apb-kbd-group' });
    list.forEach((combo, i) => {
      if (i) group.append(h('span', { class: 'apb-kbd-sep', 'aria-hidden': 'true' }, '/'), h('span', { class: 'apb-sr-only' }, ' or '));
      const text = commands.formatKeys(combo);
      const spoken = spokenKeys(combo);
      const k = h('kbd', { class: 'apb-kbd' });
      if (text === spoken) k.textContent = text;
      else k.append(h('span', { 'aria-hidden': 'true' }, text), h('span', { class: 'apb-sr-only' }, spoken));
      group.append(k);
    });
    return group;
  }

  /* ================================================================ positioning */

  function anchorRect(anchor) {
    if (!anchor) return null;
    if (isFn(anchor.getBoundingClientRect)) return anchor.getBoundingClientRect();
    if (typeof anchor.clientX === 'number') {
      return { left: anchor.clientX, top: anchor.clientY, right: anchor.clientX, bottom: anchor.clientY, width: 0, height: 0 };
    }
    if (typeof anchor.x === 'number' || typeof anchor.left === 'number') {
      const x = typeof anchor.left === 'number' ? anchor.left : anchor.x;
      const y = typeof anchor.top === 'number' ? anchor.top : anchor.y;
      const w = anchor.width || anchor.w || 0;
      const ht = anchor.height || anchor.h || 0;
      return { left: x, top: y, right: x + w, bottom: y + ht, width: w, height: ht };
    }
    return null;
  }

  /**
   * positionFloating(el, anchor, { placement = 'bottom-start', offset = 6, margin = 8, matchWidth, fitHeight = true })
   * Places a position:fixed element next to an anchor (Element | DOMRect-like | MouseEvent), flipping to the opposite
   * side when there is not enough room and shifting along the cross axis to stay inside the viewport.
   */
  function positionFloating(el, anchor, opts) {
    const o = Object.assign({ placement: 'bottom-start', offset: 6, margin: 8, fitHeight: true }, opts);
    const r = anchorRect(anchor);
    if (!r || !el) return null;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const parts = String(o.placement).split('-');
    let side = parts[0] || 'bottom';
    const align = parts[1] || 'center';
    if (o.fitHeight) el.style.maxHeight = '';
    if (o.matchWidth) el.style.minWidth = Math.round(r.width) + 'px';
    const w = el.offsetWidth;
    let ht = el.offsetHeight;
    const m = o.margin;
    const space = {
      top: r.top - o.offset - m, bottom: vh - r.bottom - o.offset - m,
      left: r.left - o.offset - m, right: vw - r.right - o.offset - m
    };
    const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
    const vertical = side === 'top' || side === 'bottom';
    const need = vertical ? ht : w;
    if (space[side] < need && space[opposite[side]] > space[side]) side = opposite[side];
    let x;
    let y;
    if (side === 'top' || side === 'bottom') {
      if (o.fitHeight && ht > space[side]) {
        const avail = Math.max(120, Math.floor(space[side]));
        el.style.maxHeight = avail + 'px';
        ht = Math.min(ht, avail);
      }
      y = side === 'bottom' ? r.bottom + o.offset : r.top - o.offset - ht;
      x = align === 'start' ? r.left : align === 'end' ? r.right - w : r.left + r.width / 2 - w / 2;
    } else {
      x = side === 'right' ? r.right + o.offset : r.left - o.offset - w;
      y = align === 'start' ? r.top : align === 'end' ? r.bottom - ht : r.top + r.height / 2 - ht / 2;
      if (o.fitHeight && ht > vh - 2 * m) {
        el.style.maxHeight = (vh - 2 * m) + 'px';
        ht = vh - 2 * m;
      }
    }
    x = w > vw - 2 * m ? m : clamp(x, m, vw - m - w);
    y = ht > vh - 2 * m ? m : clamp(y, m, vh - m - ht);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.setAttribute('data-side', side);
    return { side, x, y };
  }

  /* ==================================================================== tooltip */

  const tip = { el: null, text: null, keys: null, target: null, timer: 0, shown: false, lastHidden: 0, installed: false };
  const TIP_DELAY = 500;

  function tipElement() {
    if (tip.el && tip.el.isConnected) return tip.el;
    tip.text = h('span', { class: 'apb-tooltip-text' });
    tip.keys = h('span', { class: 'apb-tooltip-keys' });
    tip.el = h('div', { class: 'apb-tooltip', role: 'tooltip', id: 'apb-tooltip' }, tip.text, tip.keys);
    if (env.features.popover) tip.el.setAttribute('popover', 'manual');
    document.body.appendChild(tip.el);
    return tip.el;
  }

  function hideTooltip() {
    clearTimeout(tip.timer);
    tip.timer = 0;
    if (tip.shown && tip.el) {
      tip.el.classList.remove('is-open');
      if (env.features.popover) { try { tip.el.hidePopover(); } catch (_) { /* already hidden */ } }
      tip.lastHidden = Date.now();
    }
    tip.shown = false;
    tip.target = null;
  }

  function showTooltipNow(target) {
    if (!target || !target.isConnected) return;
    const label = target.getAttribute('data-apb-tooltip') || '';
    const keys = (target.getAttribute('data-apb-shortcut') || '').split(' ').filter(Boolean);
    if (!label && !keys.length) return;
    const el = tipElement();
    tip.text.textContent = label;
    tip.keys.textContent = '';
    if (keys.length) tip.keys.append(kbd(keys));
    tip.keys.hidden = !keys.length;
    if (env.features.popover) { try { el.showPopover(); } catch (_) { /* ignore */ } }
    el.classList.add('is-open');
    positionFloating(el, target, { placement: target.getAttribute('data-apb-tooltip-placement') || 'bottom', offset: 6, fitHeight: false });
    tip.target = target;
    tip.shown = true;
  }

  function scheduleTooltip(target) {
    if (tip.target === target && (tip.shown || tip.timer)) return;
    hideTooltip();
    tip.target = target;
    const warm = Date.now() - tip.lastHidden < 400;
    tip.timer = setTimeout(() => { tip.timer = 0; showTooltipNow(target); }, warm ? 0 : TIP_DELAY);
  }

  function installTooltips() {
    if (tip.installed || typeof document === 'undefined') return;
    tip.installed = true;
    const find = (node) => (node && node.nodeType === 1 && isFn(node.closest) ? node.closest('[data-apb-tooltip]') : null);
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const t = find(e.target);
      if (t) scheduleTooltip(t);
      else if (tip.target) hideTooltip();
    }, true);
    document.addEventListener('pointerout', (e) => {
      if (!tip.target) return;
      const next = e.relatedTarget;
      if (!next || !tip.target.contains(next)) {
        if (find(next) !== tip.target) hideTooltip();
      }
    }, true);
    document.addEventListener('focusin', (e) => {
      const t = find(e.target);
      let visible = false;
      try { visible = !!t && t.matches(':focus-visible'); } catch (_) { visible = false; }
      if (t && visible) scheduleTooltip(t);
      else if (tip.target) hideTooltip();
    }, true);
    document.addEventListener('focusout', (e) => {
      if (tip.target && tip.target.contains(e.target)) hideTooltip();
    }, true);
    document.addEventListener('pointerdown', hideTooltip, true);
    document.addEventListener('wheel', hideTooltip, { capture: true, passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tip.shown) { hideTooltip(); e.stopPropagation(); e.preventDefault(); }
      else if (tip.shown && e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') hideTooltip();
    }, true);
    window.addEventListener('blur', hideTooltip);
  }

  /**
   * tooltip(el, { label, shortcut, placement } | label) — custom tooltip after 500 ms on hover / keyboard focus.
   * `label` defaults to the element's title attribute (removed to avoid a double native tooltip) or aria-label.
   * Shortcuts are shown with commands.formatKeys and exposed as aria-keyshortcuts.
   */
  function tooltip(el, opts) {
    if (!el) return el;
    const o = typeof opts === 'string' ? { label: opts } : (opts || {});
    let label = o.label;
    if (label == null) label = el.getAttribute('title') || el.getAttribute('aria-label') || '';
    if (el.hasAttribute('title') && !o.native) el.removeAttribute('title');
    if (label) el.setAttribute('data-apb-tooltip', String(label));
    else el.removeAttribute('data-apb-tooltip');
    if (o.shortcut && (!Array.isArray(o.shortcut) || o.shortcut.length)) {
      const list = Array.isArray(o.shortcut) ? o.shortcut : [o.shortcut];
      el.setAttribute('data-apb-shortcut', list.join(' '));
      el.setAttribute('aria-keyshortcuts', ariaKeys(list));
    } else if (o.shortcut === null) {
      el.removeAttribute('data-apb-shortcut');
      el.removeAttribute('aria-keyshortcuts');
    }
    if (o.placement) el.setAttribute('data-apb-tooltip-placement', o.placement);
    installTooltips();
    if (tip.target === el && tip.shown) showTooltipNow(el);
    return el;
  }

  /* ==================================================================== popover */

  const openPopovers = [];

  /**
   * popover({ anchor, content, placement = 'bottom-start', onClose(reason), label, role = 'dialog', className,
   *           focus = true, returnFocus = true, closeOnOutside = true, closeOnBlur = true, trapFocus = false,
   *           offset = 6, matchWidth = false, localKeys = true }) → { el, close(reason), update(), isOpen, contains(node) }
   * localKeys marks the popover data-apb-keys="local" so global command shortcuts ignore keys typed inside it.
   * Uses the Popover API (top layer) when available; otherwise a position:fixed element. Escape closes the topmost
   * popover and returns focus to the anchor; outside pointerdown closes without moving focus.
   */
  function popover(opts) {
    const o = Object.assign({ placement: 'bottom-start', offset: 6, role: 'dialog', focus: true, returnFocus: true,
      closeOnOutside: true, closeOnBlur: true }, opts);
    const anchorEl = o.anchor && o.anchor.nodeType === 1 ? o.anchor : null;
    const el = h('div', { class: ['apb-popover', o.className], role: o.role || null, tabindex: '-1', id: uid('apb-popover'),
      'aria-label': o.label || null });
    if (o.content != null) appendChildren(el, [o.content]);
    const useAPI = env.features.popover;
    let host = document.body;
    if (!useAPI && anchorEl && isFn(anchorEl.closest)) {
      const dlg = anchorEl.closest('dialog[open]');
      if (dlg) host = dlg;
    }
    if (useAPI) el.setAttribute('popover', 'manual');
    if (o.localKeys !== false) el.setAttribute('data-apb-keys', 'local');
    const previousFocus = document.activeElement;
    host.appendChild(el);
    if (useAPI) { try { el.showPopover(); } catch (_) { /* not connected */ } }

    let open = true;
    let raf = 0;
    let setControls = false;
    const entry = { el, api: null };
    openPopovers.push(entry);
    hideTooltip();

    if (anchorEl) {
      if (anchorEl.hasAttribute('aria-haspopup') || anchorEl.hasAttribute('aria-expanded')) anchorEl.setAttribute('aria-expanded', 'true');
      if (!anchorEl.hasAttribute('aria-controls')) { anchorEl.setAttribute('aria-controls', el.id); setControls = true; }
    }

    const laterContains = (node) => {
      const idx = openPopovers.indexOf(entry);
      return openPopovers.slice(idx + 1).some((p) => p.el.contains(node));
    };

    function update() {
      raf = 0;
      if (!open) return;
      if (anchorEl && !anchorEl.isConnected) { close('detached'); return; }
      positionFloating(el, o.anchor, { placement: o.placement, offset: o.offset, matchWidth: o.matchWidth });
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

    const onKeyInside = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && openPopovers[openPopovers.length - 1] === entry) {
        e.preventDefault();
        e.stopPropagation();
        close('escape');
      } else if (e.key === 'Tab' && o.trapFocus) {
        const items = focusables(el);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    const onKeyDoc = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || el.contains(e.target)) return;
      if (openPopovers[openPopovers.length - 1] !== entry || laterContains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      close('escape');
    };
    const onDown = (e) => {
      if (!open || !o.closeOnOutside) return;
      const t = e.target;
      if (el.contains(t) || (anchorEl && anchorEl.contains(t)) || laterContains(t)) return;
      if (tip.el && tip.el.contains(t)) return;
      close('outside');
    };
    const onFocusOut = (e) => {
      const next = e.relatedTarget;
      if (!open || !o.closeOnBlur || !next) return;
      if (el.contains(next) || (anchorEl && anchorEl.contains(next)) || laterContains(next)) return;
      close('blur');
    };

    el.addEventListener('keydown', onKeyInside);
    el.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDoc, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (ro) ro.observe(el);

    function close(reason) {
      if (!open) return;
      // close popovers opened from inside this one first
      const idx = openPopovers.indexOf(entry);
      openPopovers.slice(idx + 1).reverse().forEach((p) => p.api && p.api.close('parent'));
      open = false;
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('keydown', onKeyInside);
      el.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDoc, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (ro) ro.disconnect();
      const hadFocus = el.contains(document.activeElement);
      if (useAPI) { try { el.hidePopover(); } catch (_) { /* ignore */ } }
      el.remove();
      const at = openPopovers.indexOf(entry);
      if (at !== -1) openPopovers.splice(at, 1);
      if (anchorEl) {
        if (anchorEl.getAttribute('aria-expanded') === 'true') anchorEl.setAttribute('aria-expanded', 'false');
        if (setControls) anchorEl.removeAttribute('aria-controls');
      }
      if (o.returnFocus && hadFocus && reason !== 'outside' && reason !== 'blur') {
        const back = anchorEl && anchorEl.isConnected ? anchorEl : previousFocus;
        if (back && isFn(back.focus) && back.isConnected) back.focus({ preventScroll: true });
      }
      if (isFn(o.onClose)) o.onClose(reason || 'close');
    }

    const api = {
      el,
      get isOpen() { return open; },
      close,
      update,
      contains: (node) => el.contains(node) || laterContains(node)
    };
    entry.api = api;
    update();
    if (o.focus) {
      const target = o.focus === 'container' ? el : (el.querySelector('[autofocus]') || focusables(el)[0] || el);
      target.focus({ preventScroll: true });
    }
    return api;
  }

  /* ==================================================================== buttons */

  /**
   * button({ label, icon, iconEnd, title, shortcut, variant: 'default'|'primary'|'ghost'|'danger'|'subtle',
   *          size: 'sm'|'md', pressed, disabled, type = 'button', ariaLabel, className, id, onClick(event, api) })
   */
  function button(opts) {
    const o = opts || {};
    const variant = o.variant || 'default';
    const size = o.size || 'md';
    const iconSize = size === 'sm' ? 14 : 16;
    const hasLabel = o.label != null && o.label !== '';
    let labelText = hasLabel ? String(o.label) : '';
    const labelSpan = h('span', { class: 'apb-btn-label', hidden: !hasLabel }, labelText);
    let iconEl = iconNode(o.icon, iconSize);
    const el = h('button', {
      type: o.type || 'button',
      id: o.id,
      class: ['apb-btn', 'apb-btn--' + variant, 'apb-btn--' + size, !hasLabel && 'apb-btn--icon', o.className],
      'aria-label': o.ariaLabel || null,
      'aria-pressed': o.pressed == null ? null : String(!!o.pressed),
      disabled: !!o.disabled
    }, iconEl, labelSpan, iconNode(o.iconEnd, iconSize));
    let tipLabel = o.title || (!hasLabel ? o.ariaLabel : '') || '';
    let reasonText = '';
    const refreshTip = () => {
      const base = tipLabel || (o.shortcut ? labelText || o.ariaLabel : '');
      const text = reasonText ? (base ? base + ' — ' + reasonText : reasonText) : base;
      if (text || o.shortcut) tooltip(el, { label: text || labelText, shortcut: o.shortcut });
    };
    refreshTip();

    el.addEventListener('click', (e) => {
      if (el.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (isFn(o.onClick)) o.onClick(e, api);
    });

    const api = {
      el,
      labelTarget: el,
      get value() { return el.getAttribute('aria-pressed') === 'true'; },
      set value(v) { el.setAttribute('aria-pressed', String(!!v)); },
      setPressed(v) { el.setAttribute('aria-pressed', String(!!v)); },
      setMixed(m) { if (el.hasAttribute('aria-pressed')) el.setAttribute('aria-pressed', m ? 'mixed' : 'false'); },
      setDisabled(d, reason) {
        reasonText = d && reason ? String(reason) : '';
        if (d && reason) { el.disabled = false; el.setAttribute('aria-disabled', 'true'); }
        else { el.disabled = !!d; el.removeAttribute('aria-disabled'); }
        el.classList.toggle('is-disabled', !!d);
        refreshTip();
      },
      setLabel(text) {
        labelText = text == null ? '' : String(text);
        labelSpan.textContent = labelText;
        labelSpan.hidden = !labelText;
        el.classList.toggle('apb-btn--icon', !labelText);
      },
      setIcon(name) {
        const next = iconNode(name, iconSize);
        if (iconEl && next) iconEl.replaceWith(next);
        else if (next) el.insertBefore(next, el.firstChild);
        else if (iconEl) iconEl.remove();
        iconEl = next;
      },
      setTitle(text) { tipLabel = text || ''; refreshTip(); },
      focus() { el.focus(); }
    };
    el.apbControl = api;
    return el;
  }

  /** iconButton({ icon, label (required: aria-label + tooltip), shortcut, pressed, variant = 'ghost', size, onClick }) */
  function iconButton(opts) {
    const o = opts || {};
    if (!o.label && typeof console !== 'undefined') console.warn('[APB widgets] iconButton without a label (icon "' + o.icon + '")');
    const el = button(Object.assign({}, o, { label: null, ariaLabel: o.label || o.icon || 'Button', title: o.title || o.label,
      variant: o.variant || 'ghost', className: ['apb-icon-btn', o.className] }));
    const api = el.apbControl;
    api.setLabel = (text) => {
      el.setAttribute('aria-label', String(text || ''));
      api.setTitle(text);
    };
    return el;
  }

  /* ================================================================ numberField */

  /** Safe arithmetic evaluator: + - * / parentheses, unary signs, decimals; letters/%/° (units) are ignored. */
  function evaluate(text, current) {
    let s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s || s.length > 200) return null;
    let rel = null;
    const rm = /^([+\-*/])=(.*)$/.exec(s);
    if (rm) { rel = rm[1]; s = rm[2]; }
    s = s.replace(/[a-z%°_$#]+/g, '').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.');
    let i = 0;
    const ws = () => { while (s[i] === ' ') i++; };
    function num() {
      ws();
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
      if (!m) return NaN;
      i += m[0].length;
      return parseFloat(m[0]);
    }
    function factor(depth) {
      if (depth > 40) return NaN;
      ws();
      const c = s[i];
      if (c === '+') { i++; return factor(depth + 1); }
      if (c === '-') { i++; return -factor(depth + 1); }
      if (c === '(') {
        i++;
        const v = expr(depth + 1);
        ws();
        if (s[i] !== ')') return NaN;
        i++;
        return v;
      }
      return num();
    }
    function term(depth) {
      let v = factor(depth);
      for (;;) {
        ws();
        const c = s[i];
        if (c !== '*' && c !== '/') return v;
        i++;
        const r = factor(depth);
        v = c === '*' ? v * r : v / r;
      }
    }
    function expr(depth) {
      let v = term(depth);
      for (;;) {
        ws();
        const c = s[i];
        if (c !== '+' && c !== '-') return v;
        i++;
        const r = term(depth);
        v = c === '+' ? v + r : v - r;
      }
    }
    let v = expr(0);
    ws();
    if (i !== s.length || !Number.isFinite(v)) return null;
    if (rel) {
      const base = Number.isFinite(current) ? current : 0;
      v = rel === '+' ? base + v : rel === '-' ? base - v : rel === '*' ? base * v : (v === 0 ? NaN : base / v);
      if (!Number.isFinite(v)) return null;
    }
    return v;
  }

  /**
   * numberField({ label, icon, ariaLabel, value, min, max, step = 1, unit, precision, placeholder, mixedLabel = 'Mixed',
   *               scrub = true, wrap = false, allowEmpty = false, disabled, id, className, onInput(value, { commit }) })
   */
  function numberField(opts) {
    const o = Object.assign({ step: 1, scrub: true, mixedLabel: 'Mixed' }, opts);
    const step = Math.abs(Number(o.step)) || 1;
    const precision = o.precision != null ? o.precision : Math.max(decimals(step), 2);
    const hasMin = Number.isFinite(o.min);
    const hasMax = Number.isFinite(o.max);
    const toNum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const round = (v) => {
      const f = Math.pow(10, precision);
      const r = Math.round(v * f) / f;
      return Object.is(r, -0) ? 0 : r;
    };
    const fit = (v) => {
      let n = v;
      if (o.wrap && hasMin && hasMax && o.max > o.min) {
        const span = o.max - o.min;
        n = ((((n - o.min) % span) + span) % span) + o.min;
      } else {
        if (hasMin) n = Math.max(o.min, n);
        if (hasMax) n = Math.min(o.max, n);
      }
      return round(n);
    };
    const format = (v) => String(round(v));

    let value = toNum(o.value);
    if (value !== null) value = fit(value);
    let mixed = false;
    let dirty = false;
    let disabled = !!o.disabled;
    let pointerFocus = false;

    const inputId = o.id || uid('apb-num');
    const input = h('input', {
      id: inputId, class: 'apb-num-input', type: 'text', inputmode: 'decimal', role: 'spinbutton', autocomplete: 'off',
      spellcheck: 'false', 'aria-label': o.ariaLabel || null,
      'aria-valuemin': hasMin ? String(o.min) : null, 'aria-valuemax': hasMax ? String(o.max) : null, disabled
    });
    const hasLabel = o.label != null && o.label !== '' || !!o.icon;
    const labelEl = hasLabel
      ? h('label', { class: ['apb-num-label', o.scrub && 'is-scrubbable'], for: inputId },
        o.icon ? iconNode(o.icon, 14) : null,
        o.label != null && o.label !== '' ? h('span', { class: o.icon ? 'apb-sr-only' : null }, String(o.label)) : null)
      : null;
    const unitEl = o.unit ? h('span', { class: 'apb-num-unit', 'aria-hidden': 'true' }, o.unit) : null;
    const root = h('div', { class: ['apb-num', o.className, disabled && 'is-disabled'] }, labelEl, input, unitEl);

    function render() {
      root.classList.toggle('is-mixed', mixed);
      if (dirty && document.activeElement === input) return;
      if (value === null) {
        input.value = '';
        input.placeholder = mixed ? o.mixedLabel : (o.placeholder || '');
        input.removeAttribute('aria-valuenow');
        input.setAttribute('aria-valuetext', mixed ? o.mixedLabel : 'Empty');
      } else {
        const text = format(value);
        input.value = text;
        input.placeholder = o.placeholder || '';
        input.setAttribute('aria-valuenow', text);
        input.setAttribute('aria-valuetext', text + (o.unit ? ' ' + o.unit : ''));
      }
    }

    function emit(next, commit) {
      value = next;
      mixed = false;
      dirty = false;
      render();
      if (isFn(o.onInput)) o.onInput(next, { commit: !!commit });
    }

    function commitText() {
      const text = input.value.trim();
      dirty = false;
      if (text === '') {
        if (o.allowEmpty && value !== null) { value = null; render(); if (isFn(o.onInput)) o.onInput(null, { commit: true }); }
        else render();
        return;
      }
      const v = evaluate(text, value);
      if (v === null) {
        render();
        root.classList.add('is-invalid');
        setTimeout(() => root.classList.remove('is-invalid'), 600);
        return;
      }
      const next = fit(v);
      if (next === value && !mixed) { render(); return; }
      emit(next, true);
    }

    function stepBy(dir, e) {
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      let base = value;
      if (dirty) {
        const typed = evaluate(input.value, value);
        if (typed !== null) base = typed;
      }
      if (base === null) base = hasMin && o.min > 0 ? o.min : 0;
      emit(fit(base + dir * step * mult), true);
      input.select();
    }

    input.addEventListener('keydown', (e) => {
      if (disabled) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        stepBy(e.key === 'ArrowUp' ? 1 : -1, e);
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        stepBy((e.key === 'PageUp' ? 1 : -1) * 10, { shiftKey: false, altKey: false });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitText();
        input.select();
      } else if (e.key === 'Escape' && dirty) {
        e.preventDefault();
        e.stopPropagation();
        dirty = false;
        render();
        input.select();
      }
    });
    input.addEventListener('input', () => { dirty = true; });
    input.addEventListener('pointerdown', () => { pointerFocus = document.activeElement !== input; });
    input.addEventListener('focus', () => {
      if (!pointerFocus) input.select();
    });
    input.addEventListener('mouseup', (e) => {
      if (pointerFocus) {
        pointerFocus = false;
        if (input.selectionStart === input.selectionEnd) { e.preventDefault(); input.select(); }
      }
    });
    input.addEventListener('blur', () => { pointerFocus = false; if (dirty) commitText(); });

    /* scrubbing on the label */
    if (labelEl && o.scrub) {
      let drag = null;
      let suppressClick = false;
      const finish = (cancel) => {
        if (!drag) return;
        const d = drag;
        drag = null;
        document.removeEventListener('keydown', onScrubKey, true);
        document.documentElement.classList.remove('apb-scrubbing');
        root.classList.remove('is-scrubbing');
        if (!d.moved) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        if (cancel) emit(d.start, true);
        else if (value !== d.start || d.changed) emit(value, true);
      };
      const onScrubKey = (e) => {
        if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); finish(true); }
      };
      labelEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || disabled) return;
        e.preventDefault();
        drag = { id: e.pointerId, px: e.clientX, x0: e.clientX, start: value, acc: 0, moved: false, changed: false };
        try { labelEl.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
        document.addEventListener('keydown', onScrubKey, true);
      });
      labelEl.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (!drag.moved) {
          if (Math.abs(e.clientX - drag.x0) < 3) return;
          drag.moved = true;
          drag.px = e.clientX;
          document.documentElement.classList.add('apb-scrubbing');
          root.classList.add('is-scrubbing');
          if (document.activeElement === input && dirty) commitText();
          return;
        }
        const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        drag.acc += (e.clientX - drag.px) * step * mult;
        drag.px = e.clientX;
        const base = drag.start === null ? 0 : drag.start;
        const next = fit(base + drag.acc);
        if (next !== value) { drag.changed = true; emit(next, false); }
      });
      labelEl.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) finish(false); });
      labelEl.addEventListener('pointercancel', () => finish(false));
      labelEl.addEventListener('lostpointercapture', () => finish(false));
      labelEl.addEventListener('click', (e) => {
        if (suppressClick) { e.preventDefault(); suppressClick = false; }
      });
    }

    render();
    const api = {
      el: root,
      input,
      labelTarget: input,
      get value() { return mixed ? null : value; },
      set value(v) {
        const n = toNum(v);
        value = n === null ? null : fit(n);
        mixed = false;
        if (document.activeElement !== input) dirty = false;
        render();
      },
      setMixed(m) { mixed = !!m; if (mixed) { value = null; dirty = false; } render(); },
      setDisabled(d) { disabled = !!d; input.disabled = disabled; root.classList.toggle('is-disabled', disabled); },
      focus() { input.focus(); },
      commit: commitText
    };
    root.apbControl = api;
    return root;
  }

  /* ============================================================ text inputs */

  function wireTextCommit(field, api, o, getValue, setRaw) {
    let committed = getValue();
    const fire = (v, commit) => { if (isFn(o.onInput)) o.onInput(v, { commit }); };
    const validate = () => {
      if (!isFn(o.validate)) return true;
      const msg = o.validate(getValue());
      api.setInvalid(msg || null);
      return !msg;
    };
    field.addEventListener('focus', () => { committed = getValue(); });
    field.addEventListener('input', () => {
      if (api._mixed) { api._mixed = false; field.placeholder = o.placeholder || ''; }
      validate();
      fire(getValue(), false);
    });
    const commit = () => {
      const v = getValue();
      if (v === committed) return;
      committed = v;
      fire(v, true);
    };
    field.addEventListener('change', commit);
    field.addEventListener('keydown', (e) => {
      const isArea = field.tagName === 'TEXTAREA';
      if (e.key === 'Enter' && (!isArea || e.metaKey || e.ctrlKey)) {
        if (isArea) e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && getValue() !== committed) {
        e.preventDefault();
        e.stopPropagation();
        setRaw(committed);
        validate();
        fire(committed, true);
      }
    });
    api.commit = commit;
    api._setCommitted = (v) => { committed = v; };
  }

  function makeInvalidSupport(field, host, api) {
    let errEl = null;
    api.setInvalid = (message) => {
      if (message) {
        field.setAttribute('aria-invalid', 'true');
        if (!errEl) {
          errEl = h('div', { class: 'apb-field-error', id: uid('apb-err'), role: 'status' });
          host.after ? host.after(errEl) : host.appendChild(errEl);
          const ids = (field.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
          field.setAttribute('aria-describedby', ids.concat(errEl.id).join(' '));
        }
        errEl.textContent = String(message);
        errEl.hidden = false;
      } else {
        field.removeAttribute('aria-invalid');
        if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
      }
    };
  }

  /**
   * textField({ label|ariaLabel, value, placeholder, type = 'text', icon, clearable, spellcheck, maxLength, name, id,
   *             inputMode, autocomplete, validate(value) → message|null, disabled, className, onInput(value, { commit }) })
   */
  function textField(opts) {
    const o = opts || {};
    const input = h('input', {
      id: o.id || uid('apb-text'), class: 'apb-input', type: o.type || 'text', placeholder: o.placeholder || null,
      'aria-label': o.ariaLabel || o.label || null, autocomplete: o.autocomplete || 'off',
      spellcheck: o.spellcheck ? 'true' : 'false', maxlength: o.maxLength || null, name: o.name || null,
      inputmode: o.inputMode || null, disabled: !!o.disabled
    });
    input.value = o.value == null ? '' : String(o.value);
    let clearBtn = null;
    const root = h('div', { class: ['apb-textfield', o.icon && 'has-icon', o.clearable && 'is-clearable', o.className] },
      o.icon ? iconNode(o.icon, 14, 'apb-textfield-icon') : null, input);
    const api = { el: root, input, labelTarget: input, _mixed: false };
    makeInvalidSupport(input, root, api);
    const setRaw = (v) => { input.value = v == null ? '' : String(v); syncClear(); };
    function syncClear() { if (clearBtn) clearBtn.hidden = !input.value; }
    wireTextCommit(input, api, o, () => input.value, setRaw);
    if (o.clearable) {
      clearBtn = iconButton({ icon: 'close', label: 'Clear', size: 'sm', className: 'apb-textfield-clear', onClick: () => {
        setRaw('');
        input.focus();
        if (isFn(o.onInput)) o.onInput('', { commit: true });
        api._setCommitted('');
      } });
      root.appendChild(clearBtn);
      input.addEventListener('input', syncClear);
      syncClear();
    }
    Object.defineProperty(api, 'value', {
      get() { return api._mixed ? null : input.value; },
      set(v) { api._mixed = false; input.placeholder = o.placeholder || ''; setRaw(v); api._setCommitted(input.value); }
    });
    api.setMixed = (m) => {
      api._mixed = !!m;
      if (m) { input.value = ''; input.placeholder = o.mixedLabel || 'Mixed'; } else input.placeholder = o.placeholder || '';
      root.classList.toggle('is-mixed', !!m);
      syncClear();
    };
    api.setDisabled = (d) => { input.disabled = !!d; root.classList.toggle('is-disabled', !!d); if (clearBtn) clearBtn.disabled = !!d; };
    api.focus = () => input.focus();
    root.apbControl = api;
    return root;
  }

  /** textArea({ label|ariaLabel, value, placeholder, rows = 3, maxRows = 12, autoGrow = true, monospace, onInput(value, { commit }) }) */
  function textArea(opts) {
    const o = Object.assign({ rows: 3, maxRows: 12, autoGrow: true }, opts);
    const ta = h('textarea', {
      id: o.id || uid('apb-area'), class: ['apb-textarea', o.monospace && 'is-mono', o.className], rows: String(o.rows),
      placeholder: o.placeholder || null, 'aria-label': o.ariaLabel || o.label || null, spellcheck: o.spellcheck ? 'true' : 'false',
      disabled: !!o.disabled, maxlength: o.maxLength || null
    });
    ta.value = o.value == null ? '' : String(o.value);
    ta.style.setProperty('--apb-rows', String(o.rows));
    ta.style.setProperty('--apb-max-rows', String(o.maxRows));
    const nativeSizing = typeof CSS !== 'undefined' && isFn(CSS.supports) && CSS.supports('field-sizing', 'content');
    let raf = 0;
    const grow = () => {
      raf = 0;
      if (!o.autoGrow || nativeSizing || !ta.isConnected) return;
      ta.style.height = 'auto';
      const cs = getComputedStyle(ta);
      const line = parseFloat(cs.lineHeight) || 18;
      const extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const max = line * o.maxRows + extra;
      ta.style.height = Math.min(ta.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), max) + 'px';
    };
    const scheduleGrow = () => { if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(grow); };
    if (o.autoGrow) {
      ta.classList.add(nativeSizing ? 'is-autosize' : 'is-autogrow');
      ta.addEventListener('input', scheduleGrow);
      scheduleGrow();
    }
    const api = { el: ta, input: ta, labelTarget: ta, _mixed: false };
    makeInvalidSupport(ta, ta, api);
    const setRaw = (v) => { ta.value = v == null ? '' : String(v); scheduleGrow(); };
    wireTextCommit(ta, api, o, () => ta.value, setRaw);
    Object.defineProperty(api, 'value', {
      get() { return api._mixed ? null : ta.value; },
      set(v) { api._mixed = false; ta.placeholder = o.placeholder || ''; setRaw(v); api._setCommitted(ta.value); }
    });
    api.setMixed = (m) => {
      api._mixed = !!m;
      if (m) { ta.value = ''; ta.placeholder = o.mixedLabel || 'Mixed'; } else ta.placeholder = o.placeholder || '';
      scheduleGrow();
    };
    api.setDisabled = (d) => { ta.disabled = !!d; };
    api.focus = () => ta.focus();
    api.grow = grow;
    ta.apbControl = api;
    return ta;
  }

  /* ==================================================================== select */

  const sameValue = (a, b) => a === b || (a != null && b != null && String(a) === String(b));

  /** select({ options: [{ value, label, disabled, group }], value, label|ariaLabel, mixedLabel, disabled, onInput(value, { commit: true }) }) */
  function select(opts) {
    const o = opts || {};
    let options = [];
    let mixed = false;
    const sel = h('select', { id: o.id || uid('apb-select'), class: 'apb-select-input', 'aria-label': o.ariaLabel || o.label || null, disabled: !!o.disabled });
    const root = h('div', { class: ['apb-select', o.className] }, sel, icons.get('chevron-down', { size: 14, className: 'apb-select-chevron' }));
    const mixedOpt = () => h('option', { value: '__apb_mixed__', disabled: true, hidden: true }, o.mixedLabel || 'Mixed');

    function setOptions(list, keepValue) {
      const current = keepValue ? api.value : undefined;
      options = (list || []).map((opt) => (opt && typeof opt === 'object' ? opt : { value: opt, label: String(opt) }));
      sel.textContent = '';
      sel.appendChild(mixedOpt());
      const groups = new Map();
      options.forEach((opt, i) => {
        const node = h('option', { value: String(i), disabled: !!opt.disabled }, String(opt.label != null ? opt.label : opt.value));
        if (opt.group) {
          if (!groups.has(opt.group)) {
            const g = h('optgroup', { label: String(opt.group) });
            groups.set(opt.group, g);
            sel.appendChild(g);
          }
          groups.get(opt.group).appendChild(node);
        } else sel.appendChild(node);
      });
      if (keepValue) setValue(current);
    }
    function setValue(v) {
      const idx = options.findIndex((opt) => sameValue(opt.value, v));
      mixed = false;
      sel.value = idx === -1 ? '__apb_mixed__' : String(idx);
      root.classList.remove('is-mixed');
    }
    sel.addEventListener('change', () => {
      const opt = options[Number(sel.value)];
      if (!opt) return;
      mixed = false;
      root.classList.remove('is-mixed');
      if (isFn(o.onInput)) o.onInput(opt.value, { commit: true });
    });
    const api = {
      el: root,
      input: sel,
      labelTarget: sel,
      get value() { const opt = options[Number(sel.value)]; return mixed || !opt ? null : opt.value; },
      set value(v) { setValue(v); },
      get options() { return options.slice(); },
      setOptions: (list) => setOptions(list, true),
      setMixed(m) { mixed = !!m; if (m) sel.value = '__apb_mixed__'; root.classList.toggle('is-mixed', mixed); },
      setDisabled(d) { sel.disabled = !!d; root.classList.toggle('is-disabled', !!d); },
      focus() { sel.focus(); }
    };
    setOptions(o.options, false);
    setValue(o.value);
    root.apbControl = api;
    return root;
  }

  /* ============================================================ toggle/checkbox */

  /** toggle({ label, labelVisible = true, ariaLabel, checked, disabled, onInput(checked, { commit: true }) }) → role=switch button */
  function toggle(opts) {
    const o = Object.assign({ labelVisible: true }, opts);
    let checked = !!o.checked;
    let mixed = false;
    const showLabel = o.label && o.labelVisible;
    const el = h('button', {
      type: 'button', role: 'switch', id: o.id || uid('apb-switch'), class: ['apb-switch', o.className],
      'aria-checked': String(checked), 'aria-label': showLabel ? (o.ariaLabel || null) : (o.ariaLabel || o.label || null), disabled: !!o.disabled
    },
    h('span', { class: 'apb-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'apb-switch-thumb' })),
    showLabel ? h('span', { class: 'apb-switch-label' }, String(o.label)) : null);
    const render = () => {
      el.setAttribute('aria-checked', String(!mixed && checked));
      el.classList.toggle('is-mixed', mixed);
    };
    el.addEventListener('click', () => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      checked = mixed ? true : !checked;
      mixed = false;
      render();
      if (isFn(o.onInput)) o.onInput(checked, { commit: true });
    });
    const api = {
      el,
      labelTarget: el,
      get value() { return mixed ? null : checked; },
      set value(v) { checked = !!v; mixed = false; render(); },
      setMixed(m) { mixed = !!m; render(); },
      setDisabled(d) { el.disabled = !!d; },
      focus() { el.focus(); }
    };
    el.apbControl = api;
    return el;
  }

  /** checkbox({ label, ariaLabel, checked, disabled, onInput(checked, { commit: true }) }) */
  function checkbox(opts) {
    const o = opts || {};
    const input = h('input', { type: 'checkbox', class: 'apb-checkbox-input', id: o.id || uid('apb-check'),
      'aria-label': o.ariaLabel || null, disabled: !!o.disabled });
    input.checked = !!o.checked;
    const root = h('label', { class: ['apb-checkbox', o.className] }, input,
      h('span', { class: 'apb-checkbox-box', 'aria-hidden': 'true' }, icons.get('check', { size: 12, strokeWidth: 2.5 }), h('span', { class: 'apb-checkbox-dash' })),
      o.label ? h('span', { class: 'apb-checkbox-label' }, String(o.label)) : null);
    input.addEventListener('change', () => { if (isFn(o.onInput)) o.onInput(input.checked, { commit: true }); });
    const api = {
      el: root,
      input,
      labelTarget: input,
      get value() { return input.indeterminate ? null : input.checked; },
      set value(v) { input.indeterminate = false; input.checked = !!v; },
      setMixed(m) { input.indeterminate = !!m; },
      setDisabled(d) { input.disabled = !!d; root.classList.toggle('is-disabled', !!d); },
      focus() { input.focus(); }
    };
    root.apbControl = api;
    return root;
  }

  /* ================================================================= segmented */

  /**
   * segmented({ options: [{ value, label, icon, title, shortcut, disabled }], value, label|ariaLabel, iconOnly, size,
   *             disabled, onInput(value, { commit: true }) }) → role=radiogroup with roving tabindex + arrow keys.
   */
  function segmented(opts) {
    const o = opts || {};
    const options = (o.options || []).map((opt) => (opt && typeof opt === 'object' ? opt : { value: opt, label: String(opt) }));
    let value = o.value;
    let mixed = false;
    let disabled = !!o.disabled;
    const root = h('div', { role: 'radiogroup', id: o.id || uid('apb-seg'), class: ['apb-seg', o.size === 'sm' && 'apb-seg--sm', o.className],
      'aria-label': o.ariaLabel || o.label || null });
    const buttons = options.map((opt, i) => {
      const iconOnly = !!opt.icon && (o.iconOnly || opt.iconOnly || !opt.label);
      const b = h('button', {
        type: 'button', role: 'radio', class: 'apb-seg-item', 'aria-checked': 'false', tabindex: '-1',
        'aria-label': iconOnly ? String(opt.label || opt.title || opt.value) : null, disabled: !!opt.disabled || disabled, dataset: { value: String(opt.value) }
      }, iconNode(opt.icon, o.size === 'sm' ? 14 : 16), iconOnly ? null : h('span', { class: 'apb-seg-label' }, String(opt.label)));
      if (iconOnly || opt.title || opt.shortcut) tooltip(b, { label: opt.title || opt.label, shortcut: opt.shortcut });
      b.addEventListener('click', () => choose(i));
      root.appendChild(b);
      return b;
    });
    const enabledIdx = () => buttons.map((b, i) => (b.disabled ? -1 : i)).filter((i) => i !== -1);

    function render() {
      const idx = mixed ? -1 : options.findIndex((opt) => sameValue(opt.value, value));
      const enabled = enabledIdx();
      const tabbable = idx !== -1 && !buttons[idx].disabled ? idx : (enabled.length ? enabled[0] : -1);
      buttons.forEach((b, i) => {
        b.setAttribute('aria-checked', String(i === idx));
        b.tabIndex = i === tabbable ? 0 : -1;
      });
    }
    function choose(i) {
      const opt = options[i];
      if (!opt || opt.disabled || disabled) return;
      const changed = mixed || !sameValue(opt.value, value);
      value = opt.value;
      mixed = false;
      render();
      if (changed && isFn(o.onInput)) o.onInput(opt.value, { commit: true });
    }
    root.addEventListener('keydown', (e) => {
      const deltas = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in deltas) && e.key !== 'Home' && e.key !== 'End') return;
      const enabled = enabledIdx();
      if (!enabled.length) return;
      e.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      let pos = enabled.indexOf(current);
      if (e.key === 'Home') pos = 0;
      else if (e.key === 'End') pos = enabled.length - 1;
      else pos = pos === -1 ? 0 : (pos + deltas[e.key] + enabled.length) % enabled.length;
      const next = enabled[pos];
      buttons[next].focus();
      choose(next);
    });
    render();
    const api = {
      el: root,
      labelTarget: root,
      buttons,
      get value() { return mixed ? null : value; },
      set value(v) { value = v; mixed = false; render(); },
      setMixed(m) { mixed = !!m; render(); },
      setDisabled(d) {
        disabled = !!d;
        buttons.forEach((b, i) => { b.disabled = disabled || !!options[i].disabled; });
        root.setAttribute('aria-disabled', String(disabled));
        render();
      },
      focus() { const b = buttons.find((x) => x.tabIndex === 0); if (b) b.focus(); }
    };
    root.apbControl = api;
    return root;
  }

  /* ==================================================================== slider */

  /** slider({ min = 0, max = 100, step = 1, value, label|ariaLabel, unit, showValue, valueText(v), disabled, onInput(value, { commit }) }) */
  function slider(opts) {
    const o = Object.assign({ min: 0, max: 100, step: 1 }, opts);
    let mixed = false;
    const input = h('input', { type: 'range', class: 'apb-slider-input', id: o.id || uid('apb-slider'), min: String(o.min), max: String(o.max),
      step: String(o.step), 'aria-label': o.ariaLabel || o.label || null, disabled: !!o.disabled });
    const out = o.showValue ? h('span', { class: 'apb-slider-value', 'aria-hidden': 'true' }) : null;
    const root = h('div', { class: ['apb-slider', o.className] }, input, out);
    const text = (v) => (isFn(o.valueText) ? String(o.valueText(v)) : String(v) + (o.unit ? ' ' + o.unit : ''));
    const current = (v) => clamp(Number.isFinite(Number(v)) ? Number(v) : Number(o.min), Number(o.min), Number(o.max));
    function render() {
      const v = Number(input.value);
      const span = Number(o.max) - Number(o.min) || 1;
      input.style.setProperty('--apb-slider-pct', ((v - Number(o.min)) / span) * 100 + '%');
      input.setAttribute('aria-valuetext', mixed ? (o.mixedLabel || 'Mixed') : text(v));
      if (out) out.textContent = mixed ? '–' : text(v);
      root.classList.toggle('is-mixed', mixed);
    }
    input.value = String(current(o.value));
    input.addEventListener('input', () => { mixed = false; render(); if (isFn(o.onInput)) o.onInput(Number(input.value), { commit: false }); });
    input.addEventListener('change', () => { if (isFn(o.onInput)) o.onInput(Number(input.value), { commit: true }); });
    render();
    const api = {
      el: root,
      input,
      labelTarget: input,
      get value() { return mixed ? null : Number(input.value); },
      set value(v) { mixed = false; input.value = String(current(v)); render(); },
      setMixed(m) { mixed = !!m; render(); },
      setDisabled(d) { input.disabled = !!d; root.classList.toggle('is-disabled', !!d); },
      focus() { input.focus(); }
    };
    root.apbControl = api;
    return root;
  }

  /* ================================================================ colors */

  function rgbToHsv(c) {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hue = 0;
    if (d) {
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: max ? d / max : 0, v: max };
  }

  function hsvToRgb(c) {
    const hue = ((c.h % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + hue / 60) % 6;
      return c.v - c.v * c.s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
  }

  const TOKEN_RE = /^\$[A-Za-z0-9_-]+$/;
  const recentFallback = [];

  function appRef(o) {
    const app = (o && o.app) || (typeof APB !== 'undefined' ? APB.app : null);
    return app && app.store ? app : null;
  }

  function docTokens(o) {
    const app = appRef(o);
    const doc = app && app.store.doc;
    const list = doc && doc.tokens && Array.isArray(doc.tokens.colors) ? doc.tokens.colors : [];
    return list.map((t) => ({ label: t.name || t.id, value: '$' + t.id, color: t.value }));
  }

  function recentColors(o) {
    const app = appRef(o);
    const list = app && app.store.prefs && Array.isArray(app.store.prefs.recentColors) ? app.store.prefs.recentColors : recentFallback;
    return list.filter((c) => typeof c === 'string' && color.parse(c));
  }

  /** Remember a committed literal color (store.prefs.recentColors, newest first, max 16). */
  function addRecentColor(value, o) {
    if (typeof value !== 'string' || !color.parse(value) || TOKEN_RE.test(value)) return;
    const app = appRef(o);
    const cur = recentColors(o);
    const next = [value].concat(cur.filter((c) => c.toLowerCase() !== value.toLowerCase())).slice(0, 16);
    if (app && isFn(app.store.setPrefs)) app.store.setPrefs({ recentColors: next });
    else { recentFallback.length = 0; recentFallback.push(...next); }
  }

  /** CSS-safe rgba() string for a color string (never passes raw input through). */
  function cssColor(str) {
    const c = color.parse(str);
    return c ? color.toRGBString(c) : '';
  }

  function formatColor(c, format) {
    if (format === 'rgb') return color.toRGBString(c);
    if (format === 'hsl') {
      const hsl = color.rgbToHsl(c);
      const body = Math.round(hsl.h) + ', ' + Math.round(hsl.s) + '%, ' + Math.round(hsl.l) + '%';
      return c.a < 1 ? 'hsla(' + body + ', ' + Math.round(c.a * 100) / 100 + ')' : 'hsl(' + body + ')';
    }
    return color.toHex(c, 'auto');
  }

  /**
   * colorField({ value, label = 'Color', ariaLabel, swatches: () => [{ label, value, color }], allowAlpha = true,
   *              allowTokens = true, allowNone = true, mixedLabel, app, disabled, onInput(value, { commit }) })
   * Values: '#rrggbb' | '#rrggbbaa' | '$tokenId' | null (no fill).
   */
  function colorField(opts) {
    const o = Object.assign({ label: 'Color', allowAlpha: true, allowTokens: true, allowNone: true, mixedLabel: 'Mixed' }, opts);
    let value = null;
    let mixed = false;
    let dirty = false;
    let pop = null;
    let picker = null;
    let format = 'hex';

    const swatchList = () => {
      let list;
      if (isFn(o.swatches)) { try { list = o.swatches() || []; } catch (_) { list = []; } }
      else if (Array.isArray(o.swatches)) list = o.swatches;
      else list = o.allowTokens ? docTokens(o) : [];
      return list.filter((s) => s && typeof s.value === 'string');
    };
    const tokenFor = (v) => swatchList().find((s) => s.value === v) || null;
    const resolve = (v) => {
      if (v == null) return null;
      if (TOKEN_RE.test(v)) { const t = tokenFor(v); return t ? color.parse(t.color || '') : null; }
      return color.parse(v);
    };
    const toValue = (c) => color.toHex(o.allowAlpha ? c : Object.assign({}, c, { a: 1 }), 'auto');
    function normalize(v) {
      if (v == null || v === '') return null;
      const s = String(v).trim();
      if (TOKEN_RE.test(s)) return o.allowTokens ? s : (resolve(s) ? toValue(resolve(s)) : null);
      const c = color.parse(s);
      return c ? toValue(c) : null;
    }
    function display(v) {
      if (v == null) return '';
      if (TOKEN_RE.test(v)) { const t = tokenFor(v); return t ? String(t.label) : v; }
      const c = color.parse(v);
      return c ? formatColor(c, format) : String(v);
    }
    /** Parse user text → { ok, value } */
    function parseTyped(text) {
      const s = String(text || '').trim();
      if (!s || /^(none|no fill)$/i.test(s)) return o.allowNone ? { ok: true, value: null } : { ok: false };
      if (o.allowTokens) {
        const list = swatchList();
        const byValue = list.find((t) => t.value === s);
        if (byValue) return { ok: true, value: byValue.value };
        const byName = list.find((t) => TOKEN_RE.test(t.value) && String(t.label).toLowerCase() === s.toLowerCase());
        if (byName) return { ok: true, value: byName.value };
      }
      const hex = /^[0-9a-f]{3,8}$/i.test(s) && [3, 4, 6, 8].includes(s.length) ? '#' + s : s;
      const c = color.parse(hex);
      return c ? { ok: true, value: toValue(c) } : { ok: false };
    }

    value = normalize(o.value);

    const chipFill = h('span', { class: 'apb-color-chip-fill' });
    const swatchBtn = h('button', { type: 'button', class: 'apb-color-swatch', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', disabled: !!o.disabled },
      h('span', { class: 'apb-color-chip', 'aria-hidden': 'true' }, chipFill));
    const input = h('input', { type: 'text', id: o.id || uid('apb-color'), class: 'apb-color-input', autocomplete: 'off', spellcheck: 'false',
      'aria-label': o.ariaLabel || o.label, disabled: !!o.disabled });
    const root = h('div', { class: ['apb-color', o.className] }, swatchBtn, input);

    function fire(v, commit) {
      if (commit) addRecentColor(v, o);
      if (isFn(o.onInput)) o.onInput(v, { commit: !!commit });
    }

    function render() {
      const c = mixed ? null : resolve(value);
      chipFill.style.background = c ? color.toRGBString(c) : '';
      root.classList.toggle('is-none', !mixed && value == null);
      root.classList.toggle('is-mixed', mixed);
      root.classList.toggle('is-token', !mixed && value != null && TOKEN_RE.test(value));
      if (!(dirty && document.activeElement === input)) input.value = mixed ? '' : display(value);
      input.placeholder = mixed ? o.mixedLabel : (o.allowNone ? 'None' : '');
      const desc = mixed ? o.mixedLabel : value == null ? 'none' : display(value);
      swatchBtn.setAttribute('aria-label', (o.label || 'Color') + ': ' + desc + '. Open color picker');
      if (picker) picker.sync();
    }

    function setValue(v, commit, from) {
      value = v;
      mixed = false;
      render();
      if (picker && from !== 'picker') picker.fromValue();
      fire(v, commit);
    }

    input.addEventListener('input', () => { dirty = true; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitInput(); }
      else if (e.key === 'Escape' && dirty) { e.preventDefault(); e.stopPropagation(); dirty = false; render(); }
      else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); openPicker(); }
    });
    input.addEventListener('blur', () => { if (dirty) commitInput(); });
    function commitInput() {
      const r = parseTyped(input.value);
      dirty = false;
      if (!r.ok) {
        render();
        root.classList.add('is-invalid');
        setTimeout(() => root.classList.remove('is-invalid'), 600);
        return;
      }
      if (r.value === value && !mixed) { render(); return; }
      setValue(r.value, true);
    }

    function openPicker() {
      if (pop && pop.isOpen) { pop.close('toggle'); return; }
      if (swatchBtn.disabled) return;
      picker = buildPicker();
      pop = popover({ anchor: swatchBtn, content: picker.el, placement: 'bottom-start', label: (o.label || 'Color') + ' picker',
        className: 'apb-colorpicker-popover', onClose: () => { picker = null; pop = null; } });
    }
    swatchBtn.addEventListener('click', openPicker);

    function buildPicker() {
      let hsv = { h: 0, s: 0, v: 1, a: 1 };
      let dragging = false;
      let textDirty = false;
      const fromValue = () => {
        const c = resolve(value);
        if (!c) return;
        const next = rgbToHsv(c);
        hsv = { h: next.s === 0 || next.v === 0 ? hsv.h : next.h, s: next.v === 0 ? hsv.s : next.s, v: next.v, a: c.a };
      };
      fromValue();

      const svThumb = h('div', { class: 'apb-cp-sv-thumb' });
      const sv = h('div', { class: 'apb-cp-sv', role: 'slider', tabindex: '0', 'aria-label': 'Saturation and brightness',
        'aria-roledescription': '2D slider', 'aria-valuemin': '0', 'aria-valuemax': '100' }, svThumb);
      const hue = h('input', { type: 'range', class: 'apb-cp-range apb-cp-hue', min: '0', max: '360', step: '1', 'aria-label': 'Hue' });
      const alpha = o.allowAlpha ? h('input', { type: 'range', class: 'apb-cp-range apb-cp-alpha', min: '0', max: '100', step: '1', 'aria-label': 'Opacity' }) : null;
      const previewFill = h('span', { class: 'apb-cp-preview-fill' });
      const preview = h('span', { class: 'apb-cp-preview', 'aria-hidden': 'true' }, previewFill);
      const text = h('input', { type: 'text', class: 'apb-input apb-cp-text', 'aria-label': 'Color value', spellcheck: 'false', autocomplete: 'off' });
      const fmt = select({ options: [{ value: 'hex', label: 'HEX' }, { value: 'rgb', label: 'RGB' }, { value: 'hsl', label: 'HSL' }], value: format,
        ariaLabel: 'Color format', className: 'apb-cp-format', onInput: (f) => { format = f; textDirty = false; sync(); render(); } });
      const tools = [];
      if (env.features.eyeDropper) {
        tools.push(iconButton({ icon: 'droplet', label: 'Pick color from screen', size: 'sm', onClick: () => {
          try {
            new window.EyeDropper().open().then((res) => {
              const c = res && color.parse(res.sRGBHex);
              if (c) { c.a = 1; hsv = Object.assign(rgbToHsv(c), { a: 1 }); applyHSV(true); }
            }).catch(() => { /* cancelled */ });
          } catch (_) { /* unsupported */ }
        } }));
      }
      if (o.allowNone) {
        tools.push(button({ label: 'No fill', icon: 'image-off', size: 'sm', variant: 'subtle', className: 'apb-cp-none', onClick: () => setValue(null, true) }));
      }

      function applyHSV(commit) {
        const rgb = hsvToRgb(hsv);
        const v = toValue({ r: rgb.r, g: rgb.g, b: rgb.b, a: o.allowAlpha ? hsv.a : 1 });
        value = v;
        mixed = false;
        textDirty = false;
        render();
        fire(v, commit);
      }

      /* SV area */
      const moveSV = (e) => {
        const r = sv.getBoundingClientRect();
        hsv.s = clamp((e.clientX - r.left) / (r.width || 1), 0, 1);
        hsv.v = clamp(1 - (e.clientY - r.top) / (r.height || 1), 0, 1);
        applyHSV(false);
      };
      sv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        sv.focus({ preventScroll: true });
        try { sv.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
        dragging = true;
        moveSV(e);
      });
      sv.addEventListener('pointermove', (e) => { if (dragging) moveSV(e); });
      const endDrag = () => { if (!dragging) return; dragging = false; fire(value, true); };
      sv.addEventListener('pointerup', endDrag);
      sv.addEventListener('pointercancel', endDrag);
      sv.addEventListener('lostpointercapture', endDrag);
      sv.addEventListener('keydown', (e) => {
        const d = e.shiftKey ? 0.1 : 0.01;
        let handled = true;
        if (e.key === 'ArrowLeft') hsv.s = clamp(hsv.s - d, 0, 1);
        else if (e.key === 'ArrowRight') hsv.s = clamp(hsv.s + d, 0, 1);
        else if (e.key === 'ArrowUp') hsv.v = clamp(hsv.v + d, 0, 1);
        else if (e.key === 'ArrowDown') hsv.v = clamp(hsv.v - d, 0, 1);
        else if (e.key === 'PageUp') hsv.v = clamp(hsv.v + 0.1, 0, 1);
        else if (e.key === 'PageDown') hsv.v = clamp(hsv.v - 0.1, 0, 1);
        else if (e.key === 'Home') hsv.s = 0;
        else if (e.key === 'End') hsv.s = 1;
        else handled = false;
        if (handled) { e.preventDefault(); applyHSV(true); }
      });

      hue.addEventListener('input', () => { hsv.h = Number(hue.value); applyHSV(false); });
      hue.addEventListener('change', () => fire(value, true));
      if (alpha) {
        alpha.addEventListener('input', () => { hsv.a = Number(alpha.value) / 100; applyHSV(false); });
        alpha.addEventListener('change', () => fire(value, true));
      }
      text.addEventListener('input', () => { textDirty = true; });
      const commitText = () => {
        if (!textDirty) return;
        textDirty = false;
        const r = parseTyped(text.value);
        if (!r.ok) { sync(); return; }
        if (r.value === value) { sync(); return; }
        value = r.value;
        fromValue();
        mixed = false;
        render();
        fire(value, true);
      };
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        else if (e.key === 'Escape' && textDirty) { e.preventDefault(); e.stopPropagation(); textDirty = false; sync(); }
      });
      text.addEventListener('blur', commitText);

      /* swatches */
      const groups = [];
      const swatchButtons = [];
      function swatchGroup(title, items) {
        if (!items.length) return null;
        const grid = h('div', { class: 'apb-cp-swatches', role: 'group', 'aria-label': title });
        items.forEach((item) => {
          const c = TOKEN_RE.test(item.value) ? color.parse(item.color || '') : color.parse(item.value);
          const name = String(item.label || item.value);
          const hexText = c ? color.toHex(c, 'auto') : '';
          const b = h('button', { type: 'button', class: 'apb-cp-swatch', tabindex: '-1', 'aria-pressed': 'false',
            'aria-label': name + (hexText && hexText !== name ? ' (' + hexText + ')' : ''), dataset: { value: item.value } },
          h('span', { class: 'apb-cp-swatch-fill', style: { background: c ? color.toRGBString(c) : '' } }));
          tooltip(b, { label: name });
          b.addEventListener('click', () => {
            if (value === item.value) return;
            setValue(item.value, true, 'swatch');
          });
          swatchButtons.push(b);
          grid.appendChild(b);
        });
        grid.addEventListener('keydown', (e) => {
          const list = Array.from(grid.children);
          const i = list.indexOf(document.activeElement);
          if (i === -1) return;
          const cols = 8;
          const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
          let next = null;
          if (e.key in moves) next = clamp(i + moves[e.key], 0, list.length - 1);
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = list.length - 1;
          if (next === null) return;
          e.preventDefault();
          list.forEach((b, j) => { b.tabIndex = j === next ? 0 : -1; });
          list[next].focus();
        });
        const group = h('div', { class: 'apb-cp-group' }, h('div', { class: 'apb-cp-group-title', 'aria-hidden': 'true' }, title), grid);
        groups.push(grid);
        return group;
      }
      const tokenItems = swatchList();
      const recentItems = recentColors(o).map((c) => ({ label: color.toHex(c, 'auto'), value: color.toHex(c, 'auto') }));

      const el = h('div', { class: 'apb-colorpicker' },
        sv,
        h('div', { class: 'apb-cp-row' }, h('div', { class: 'apb-cp-sliders' }, hue, alpha), preview),
        h('div', { class: 'apb-cp-row' }, fmt, text),
        tools.length ? h('div', { class: 'apb-cp-row apb-cp-tools' }, tools) : null,
        swatchGroup(o.allowTokens && !o.swatches ? 'Document colors' : 'Swatches', tokenItems),
        swatchGroup('Recent', recentItems));

      function sync() {
        const rgb = hsvToRgb(hsv);
        const opaque = color.toRGBString({ r: rgb.r, g: rgb.g, b: rgb.b, a: 1 });
        const hueColor = color.toRGBString(Object.assign(hsvToRgb({ h: hsv.h, s: 1, v: 1 }), { a: 1 }));
        sv.style.setProperty('--apb-cp-hue', hueColor);
        svThumb.style.left = hsv.s * 100 + '%';
        svThumb.style.top = (1 - hsv.v) * 100 + '%';
        svThumb.style.background = opaque;
        sv.setAttribute('aria-valuenow', String(Math.round(hsv.s * 100)));
        sv.setAttribute('aria-valuetext', 'Saturation ' + Math.round(hsv.s * 100) + '%, brightness ' + Math.round(hsv.v * 100) + '%');
        hue.value = String(Math.round(hsv.h));
        hue.setAttribute('aria-valuetext', Math.round(hsv.h) + ' degrees');
        if (alpha) {
          alpha.value = String(Math.round(hsv.a * 100));
          alpha.setAttribute('aria-valuetext', Math.round(hsv.a * 100) + '%');
          alpha.style.setProperty('--apb-cp-color', opaque);
        }
        const c = mixed ? null : resolve(value);
        previewFill.style.background = c ? color.toRGBString(c) : '';
        preview.classList.toggle('is-none', !c);
        if (!(textDirty && document.activeElement === text)) {
          text.value = value == null || mixed ? '' : (TOKEN_RE.test(value) ? display(value) : formatColor(c || { r: 0, g: 0, b: 0, a: 1 }, format));
          text.placeholder = mixed ? o.mixedLabel : 'None';
        }
        swatchButtons.forEach((b) => {
          const on = !mixed && value != null && b.dataset.value.toLowerCase() === String(value).toLowerCase();
          b.setAttribute('aria-pressed', String(on));
        });
        groups.forEach((grid) => {
          const list = Array.from(grid.children);
          const pressed = list.find((b) => b.getAttribute('aria-pressed') === 'true');
          const focusedInside = list.includes(document.activeElement);
          if (focusedInside) return;
          list.forEach((b) => { b.tabIndex = -1; });
          const first = pressed || list[0];
          if (first) first.tabIndex = 0;
        });
      }

      sync();
      return { el, sync, fromValue: () => { fromValue(); sync(); } };
    }

    render();
    const api = {
      el: root,
      input,
      labelTarget: input,
      get value() { return mixed ? null : value; },
      set value(v) { value = normalize(v); mixed = false; dirty = false; render(); if (picker) picker.fromValue(); },
      setMixed(m) { mixed = !!m; render(); },
      setDisabled(d) { input.disabled = !!d; swatchBtn.disabled = !!d; root.classList.toggle('is-disabled', !!d); if (d && pop) pop.close('disabled'); },
      focus() { input.focus(); },
      open: openPicker,
      close() { if (pop) pop.close('api'); },
      get popover() { return pop; }
    };
    root.apbControl = api;
    return root;
  }

  /* ============================================================== gradients */

  function splitTopLevel(s) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  const TO_ANGLE = { 'to top': 0, 'to top right': 45, 'to right top': 45, 'to right': 90, 'to bottom right': 135, 'to right bottom': 135,
    'to bottom': 180, 'to bottom left': 225, 'to left bottom': 225, 'to left': 270, 'to top left': 315, 'to left top': 315 };

  /** parseGradient('linear-gradient(90deg, #fff 0%, $primary 100%)') → { angle, stops: [{ color, pos }] } | null */
  function parseGradient(str) {
    if (typeof str !== 'string') return null;
    const m = /^\s*linear-gradient\(([\s\S]*)\)\s*$/i.exec(str);
    if (!m) return null;
    const parts = splitTopLevel(m[1]);
    if (!parts.length) return null;
    let angle = 180;
    let start = 0;
    const first = parts[0].toLowerCase().replace(/\s+/g, ' ');
    const am = /^(-?\d*\.?\d+)(deg|turn|rad|grad)?$/.exec(first);
    if (am) {
      const n = parseFloat(am[1]);
      const unit = am[2] || 'deg';
      angle = unit === 'turn' ? n * 360 : unit === 'rad' ? (n * 180) / Math.PI : unit === 'grad' ? n * 0.9 : n;
      start = 1;
    } else if (first.startsWith('to ')) {
      angle = TO_ANGLE[first] != null ? TO_ANGLE[first] : 180;
      start = 1;
    }
    const stops = [];
    for (const part of parts.slice(start)) {
      const pm = /^(.*?)(?:\s+(-?\d*\.?\d+)%)(?:\s+(-?\d*\.?\d+)%)?\s*$/.exec(part);
      const rawColor = (pm ? pm[1] : part).trim();
      const colorValue = TOKEN_RE.test(rawColor) ? rawColor : (color.parse(rawColor) ? color.toHex(color.parse(rawColor), 'auto') : null);
      if (!colorValue) continue;
      stops.push({ color: colorValue, pos: pm ? parseFloat(pm[2]) : null });
    }
    if (stops.length < 2) return null;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 100;
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i].pos != null) continue;
      let j = i;
      while (stops[j].pos == null) j++;
      const a = stops[i - 1].pos;
      const b = stops[j].pos;
      for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    stops.forEach((s) => { s.pos = clamp(Math.round(s.pos * 10) / 10, 0, 100); });
    return { angle: ((Math.round(angle * 10) / 10) % 360 + 360) % 360, stops };
  }

  /** formatGradient({ angle, stops }) → 'linear-gradient(90deg, #ffffff 0%, #000000 100%)' (stops sorted by position) */
  function formatGradient(g) {
    const stops = (g.stops || []).slice().sort((a, b) => a.pos - b.pos);
    const fmt = (n) => String(Math.round(n * 10) / 10);
    return 'linear-gradient(' + fmt(g.angle || 0) + 'deg, ' + stops.map((s) => s.color + ' ' + fmt(s.pos) + '%').join(', ') + ')';
  }

  /** gradientField({ value, label, app, maxStops = 5, onInput(cssString, { commit }) }) — linear gradient editor. */
  function gradientField(opts) {
    const o = Object.assign({ label: 'Gradient', maxStops: 5, minStops: 2 }, opts);
    const fallback = () => ({ angle: 90, stops: [{ color: '#ffffff', pos: 0 }, { color: '#000000', pos: 100 }] });
    let g = parseGradient(o.value) || fallback();
    let selected = 0;
    let mixed = false;

    const resolveStop = (c) => {
      if (TOKEN_RE.test(c)) {
        const t = docTokens(o).find((x) => x.value === c);
        return t ? color.parse(t.color) : null;
      }
      return color.parse(c);
    };
    const fill = h('div', { class: 'apb-gradient-fill' });
    const bar = h('div', { class: 'apb-gradient-bar', 'aria-hidden': 'true' }, fill);
    const stopsLayer = h('div', { class: 'apb-gradient-stops' });
    const track = h('div', { class: 'apb-gradient-track' }, bar, stopsLayer);
    const editor = h('div', { class: 'apb-gradient-editor' });
    const root = h('div', { class: ['apb-gradient', o.className], role: 'group', 'aria-label': o.label }, track, editor);

    const emit = (commit) => { mixed = false; paint(); if (isFn(o.onInput)) o.onInput(formatGradient(g), { commit: !!commit }); };

    function paint() {
      const sorted = g.stops.slice().sort((a, b) => a.pos - b.pos);
      const css = sorted.map((s) => {
        const c = resolveStop(s.color);
        return (c ? color.toRGBString(c) : 'rgba(0, 0, 0, 0)') + ' ' + s.pos + '%';
      });
      fill.style.backgroundImage = 'linear-gradient(90deg, ' + css.join(', ') + ')';
    }

    function renderStops() {
      stopsLayer.textContent = '';
      g.stops.forEach((s, i) => {
        const c = resolveStop(s.color);
        const handle = h('button', {
          type: 'button', class: ['apb-gradient-stop', i === selected && 'is-selected'], role: 'slider', tabindex: i === selected ? '0' : '-1',
          'aria-label': 'Stop ' + (i + 1) + ', ' + s.color, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(s.pos),
          'aria-valuetext': s.pos + '%', style: { left: s.pos + '%' }
        }, h('span', { class: 'apb-gradient-stop-fill', style: { background: c ? color.toRGBString(c) : '' } }));
        let drag = null;
        handle.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          selectStop(i, true);
          const target = stopsLayer.children[i];
          if (!target) return;
          target.focus({ preventScroll: true });
          drag = { id: e.pointerId, moved: false };
          try { target.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
          const move = (ev) => {
            if (!drag || ev.pointerId !== drag.id) return;
            const r = bar.getBoundingClientRect();
            const pos = clamp(Math.round(((ev.clientX - r.left) / (r.width || 1)) * 1000) / 10, 0, 100);
            if (pos === g.stops[i].pos) return;
            drag.moved = true;
            g.stops[i].pos = pos;
            target.style.left = pos + '%';
            target.setAttribute('aria-valuenow', String(pos));
            target.setAttribute('aria-valuetext', pos + '%');
            if (posField) posField.apbControl.value = pos;
            emit(false);
          };
          const up = (ev) => {
            if (!drag || ev.pointerId !== drag.id) return;
            const moved = drag.moved;
            drag = null;
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            target.removeEventListener('pointercancel', up);
            if (moved) emit(true);
          };
          target.addEventListener('pointermove', move);
          target.addEventListener('pointerup', up);
          target.addEventListener('pointercancel', up);
        });
        handle.addEventListener('keydown', (e) => {
          const d = e.shiftKey ? 10 : 1;
          let pos = null;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') pos = s.pos - d;
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') pos = s.pos + d;
          else if (e.key === 'Home') pos = 0;
          else if (e.key === 'End') pos = 100;
          else if ((e.key === 'Delete' || e.key === 'Backspace') && g.stops.length > o.minStops) {
            e.preventDefault();
            removeStop(i);
            return;
          }
          if (pos === null) return;
          e.preventDefault();
          s.pos = clamp(pos, 0, 100);
          renderStops();
          buildEditor();
          const again = stopsLayer.children[i];
          if (again) again.focus({ preventScroll: true });
          emit(true);
        });
        stopsLayer.appendChild(handle);
      });
    }

    let posField = null;
    function buildEditor() {
      editor.textContent = '';
      const s = g.stops[selected];
      const angleField = numberField({ label: 'Angle', icon: 'rotate', ariaLabel: 'Gradient angle', unit: '°', min: 0, max: 360, wrap: true,
        value: g.angle, className: 'apb-gradient-angle', onInput: (v, meta) => { g.angle = v; emit(meta.commit); } });
      const colorCtl = colorField({ value: s.color, label: 'Stop ' + (selected + 1) + ' color', allowNone: false, app: o.app,
        onInput: (v, meta) => {
          if (!v) return;
          g.stops[selected].color = v;
          const fillEl = stopsLayer.children[selected] && stopsLayer.children[selected].firstChild;
          const c = resolveStop(v);
          if (fillEl) fillEl.style.background = c ? color.toRGBString(c) : '';
          emit(meta.commit);
        } });
      posField = numberField({ label: 'Position', icon: 'arrow-right', ariaLabel: 'Stop ' + (selected + 1) + ' position', unit: '%', min: 0, max: 100,
        value: s.pos, className: 'apb-gradient-pos', onInput: (v, meta) => {
          g.stops[selected].pos = v;
          const handle = stopsLayer.children[selected];
          if (handle) { handle.style.left = v + '%'; handle.setAttribute('aria-valuenow', String(v)); handle.setAttribute('aria-valuetext', v + '%'); }
          emit(meta.commit);
        } });
      const addBtn = iconButton({ icon: 'plus', label: 'Add color stop', size: 'sm', onClick: () => addStop() });
      const removeBtn = iconButton({ icon: 'minus', label: 'Remove color stop', size: 'sm', onClick: () => removeStop(selected) });
      if (g.stops.length >= o.maxStops) addBtn.apbControl.setDisabled(true);
      if (g.stops.length <= o.minStops) removeBtn.apbControl.setDisabled(true);
      editor.append(
        h('div', { class: 'apb-gradient-row' }, angleField, addBtn, removeBtn),
        h('div', { class: 'apb-gradient-row' }, colorCtl, posField));
    }

    function selectStop(i, silent) {
      if (i === selected && silent) {
        Array.from(stopsLayer.children).forEach((b, j) => { b.classList.toggle('is-selected', j === i); b.tabIndex = j === i ? 0 : -1; });
        return;
      }
      selected = clamp(i, 0, g.stops.length - 1);
      Array.from(stopsLayer.children).forEach((b, j) => { b.classList.toggle('is-selected', j === selected); b.tabIndex = j === selected ? 0 : -1; });
      buildEditor();
    }

    function addStop(pos) {
      if (g.stops.length >= o.maxStops) return;
      const sorted = g.stops.slice().sort((a, b) => a.pos - b.pos);
      let at = pos;
      if (at == null) {
        let best = { gap: -1, at: 50 };
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = sorted[i + 1].pos - sorted[i].pos;
          if (gap > best.gap) best = { gap, at: sorted[i].pos + gap / 2 };
        }
        at = best.at;
      }
      at = clamp(Math.round(at * 10) / 10, 0, 100);
      const before = sorted.filter((s) => s.pos <= at).pop() || sorted[0];
      const after = sorted.find((s) => s.pos > at) || sorted[sorted.length - 1];
      const ca = resolveStop(before.color) || { r: 0, g: 0, b: 0, a: 1 };
      const cb = resolveStop(after.color) || ca;
      const t = after.pos === before.pos ? 0 : (at - before.pos) / (after.pos - before.pos);
      const mixedColor = color.mix(ca, cb, t) || ca;
      g.stops.push({ color: color.toHex(mixedColor, 'auto'), pos: at });
      selected = g.stops.length - 1;
      renderStops();
      buildEditor();
      emit(true);
    }

    function removeStop(i) {
      if (g.stops.length <= o.minStops) return;
      g.stops.splice(i, 1);
      selected = clamp(i > 0 ? i - 1 : 0, 0, g.stops.length - 1);
      renderStops();
      buildEditor();
      const handle = stopsLayer.children[selected];
      if (handle) handle.focus({ preventScroll: true });
      emit(true);
    }

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = bar.getBoundingClientRect();
      addStop(((e.clientX - r.left) / (r.width || 1)) * 100);
    });

    renderStops();
    buildEditor();
    paint();
    const api = {
      el: root,
      labelTarget: root,
      get value() { return mixed ? null : formatGradient(g); },
      set value(v) { g = parseGradient(v) || fallback(); selected = clamp(selected, 0, g.stops.length - 1); mixed = false; renderStops(); buildEditor(); paint(); },
      setMixed(m) { mixed = !!m; root.classList.toggle('is-mixed', mixed); },
      setDisabled(d) { root.classList.toggle('is-disabled', !!d); root.inert = !!d; },
      focus() { const b = stopsLayer.children[selected]; if (b) b.focus(); }
    };
    root.apbControl = api;
    return root;
  }

  /* ============================================================ layout helpers */

  function labelTargetOf(ctl) {
    if (!ctl || ctl.nodeType !== 1) return null;
    if (ctl.apbControl && ctl.apbControl.labelTarget) return ctl.apbControl.labelTarget;
    if (ctl.matches('input, select, textarea, button, [role]')) return ctl;
    return ctl.querySelector('input, select, textarea, button, [role], [tabindex]');
  }

  /** fieldRow({ label, control, overridden, onReset(event), hint, layout: 'inline'|'stacked', className }) */
  function fieldRow(opts) {
    const o = opts || {};
    const ctl = o.control || null;
    const target = labelTargetOf(ctl);
    const labelText = o.label == null ? '' : String(o.label);
    const labelable = !!target && LABELABLE.test(target.tagName);
    const labelId = uid('apb-label');
    const labelEl = labelText ? h(labelable ? 'label' : 'span', { class: 'apb-field-label', id: labelId }, labelText) : null;
    if (labelEl && target) {
      if (target.getAttribute('aria-label') === labelText) target.removeAttribute('aria-label');
      if (labelable) {
        if (!target.id) target.id = uid('apb-field');
        labelEl.htmlFor = target.id;
      } else {
        const ids = (target.getAttribute('aria-labelledby') || '').split(' ').filter(Boolean);
        if (!ids.includes(labelId)) target.setAttribute('aria-labelledby', ids.concat(labelId).join(' '));
        labelEl.addEventListener('click', () => {
          const f = target.matches('[tabindex="0"]') ? target : (focusables(target).find((x) => x.tabIndex === 0) || focusables(target)[0]);
          if (f) f.focus();
        });
      }
    }
    let onReset = o.onReset;
    const resetBtn = h('button', { type: 'button', class: 'apb-override-dot', hidden: !o.overridden,
      'aria-label': 'Reset ' + (labelText || 'value') + ' to inherited value' });
    tooltip(resetBtn, { label: 'Reset to inherited' });
    resetBtn.addEventListener('click', (e) => { if (isFn(onReset)) onReset(e); });
    const hint = h('div', { class: 'apb-field-hint', id: uid('apb-hint'), hidden: !o.hint }, o.hint || '');
    if (target) {
      const ids = (target.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
      target.setAttribute('aria-describedby', ids.concat(hint.id).join(' '));
    }
    const row = h('div', { class: ['apb-field-row', o.layout === 'stacked' && 'apb-field-row--stacked', !labelText && 'apb-field-row--nolabel',
      o.overridden && 'is-overridden', o.className] },
    labelText ? h('div', { class: 'apb-field-label-wrap' }, labelEl, resetBtn) : null,
    h('div', { class: 'apb-field-control' }, ctl, labelText ? null : resetBtn),
    hint);
    row.apbRow = {
      label: labelEl,
      control: ctl,
      setOverridden(v) { row.classList.toggle('is-overridden', !!v); resetBtn.hidden = !v; },
      setHint(text) { hint.textContent = text || ''; hint.hidden = !text; },
      setLabel(text) { if (labelEl) labelEl.textContent = String(text); resetBtn.setAttribute('aria-label', 'Reset ' + text + ' to inherited value'); },
      setOnReset(fn) { onReset = fn; }
    };
    return row;
  }

  /** section({ title, collapsible = true, collapsed = false, actions, content, level = 3, onToggle(collapsed), className }, ...children) */
  function section(opts, ...children) {
    const o = Object.assign({ collapsible: true, collapsed: false, level: 3 }, opts);
    const headingId = uid('apb-sec');
    const bodyId = uid('apb-sec-body');
    let collapsed = !!(o.collapsible && o.collapsed);
    const titleSpan = h('span', { class: 'apb-section-title' }, o.title == null ? '' : String(o.title));
    const toggleBtn = o.collapsible
      ? h('button', { type: 'button', class: 'apb-section-toggle', id: headingId, 'aria-expanded': String(!collapsed), 'aria-controls': bodyId },
        icons.get('chevron-right', { size: 14, className: 'apb-section-chevron' }), titleSpan)
      : null;
    if (!o.collapsible) titleSpan.id = headingId;
    const level = clamp(Number(o.level) || 3, 2, 6);
    const heading = h('h' + level, { class: 'apb-section-heading' }, toggleBtn || titleSpan);
    const actions = o.actions ? h('div', { class: 'apb-section-actions' }, o.actions) : null;
    const body = h('div', { class: 'apb-section-body', id: bodyId, hidden: collapsed }, o.content, children);
    const root = h('div', { class: ['apb-section', collapsed && 'is-collapsed', o.className], role: 'group', 'aria-labelledby': headingId },
      h('div', { class: 'apb-section-header' }, heading, actions), body);
    function setCollapsed(v, fire) {
      if (!o.collapsible) return;
      collapsed = !!v;
      body.hidden = collapsed;
      root.classList.toggle('is-collapsed', collapsed);
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      if (fire && isFn(o.onToggle)) o.onToggle(collapsed);
    }
    if (toggleBtn) toggleBtn.addEventListener('click', () => setCollapsed(!collapsed, true));
    root.apbSection = {
      body,
      header: heading.parentNode,
      get collapsed() { return collapsed; },
      setCollapsed: (v) => setCollapsed(v, false),
      setTitle(t) { titleSpan.textContent = String(t); }
    };
    return root;
  }

  /** emptyState({ icon, title, message, action: HTMLElement | { label, icon, variant, onClick } }) */
  function emptyState(opts) {
    const o = opts || {};
    let action = null;
    if (o.action && typeof o.action.nodeType === 'number') action = o.action;
    else if (o.action && o.action.label) {
      action = button({ label: o.action.label, icon: o.action.icon, variant: o.action.variant || 'default', size: 'sm', onClick: o.action.onClick || o.action.run });
    }
    return h('div', { class: ['apb-empty', o.className] },
      o.icon ? h('div', { class: 'apb-empty-icon', 'aria-hidden': 'true' }, iconNode(o.icon, 32)) : null,
      o.title ? h('p', { class: 'apb-empty-title' }, String(o.title)) : null,
      o.message ? h('p', { class: 'apb-empty-message' }, String(o.message)) : null,
      action);
  }

  /** badge(text, { kind: 'neutral'|'accent'|'danger'|'warning'|'success', title }) */
  function badge(text, opts) {
    const o = opts || {};
    const el = h('span', { class: ['apb-badge', 'apb-badge--' + (o.kind || 'neutral'), o.className] }, text == null ? '' : String(text));
    if (o.title) tooltip(el, { label: o.title });
    return el;
  }

  return {
    h, uid, control, focusables, kbd, tooltip, hideTooltip, popover, positionFloating,
    button, iconButton, numberField, textField, textArea, select, toggle, checkbox, segmented, slider,
    colorField, gradientField, fieldRow, section, emptyState, badge,
    evaluate, parseGradient, formatGradient, rgbToHsv, hsvToRgb, addRecentColor, formatColor,
    get openPopovers() { return openPopovers.map((p) => p.api); }
  };
});

/*
 * dialogs — modal dialogs (<dialog> + focus trap/restore), confirm/prompt, toast stack, menus with submenus and
 * keyboard navigation, and screen-reader announcements. Used by the shell to implement app.ui (ARCHITECTURE.md §8).
 *
 *   dialog({ title, content, actions: [{ label, kind, run(close, api), value, disabled, autofocus }], wide, className,
 *            dismissible = true, initialFocus, label, onClose(result) }) → { el, body, footer, close(result), closed: Promise, isOpen }
 *   confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger }) → Promise<boolean>
 *   prompt({ title, label, value, placeholder, validate(value) → message|null, confirmLabel = 'OK', cancelLabel }) → Promise<string|null>
 *   toast(message, { kind: 'info'|'success'|'warn'|'error', action: { label, run }, timeout = 4000 (0 = sticky) }) → { el, close() }
 *   menu(anchorOrEvent, items, { label, placement, onClose }) → { el, close() }
 *     items: { label, icon, shortcut, disabled, checked, danger, run, submenu: items | () => items, separator }
 *   announce(message, { assertive })
 */
APB.define('dialogs', ['env', 'commands', 'widgets', 'icons'], function (env, commands, widgets, icons) {
  'use strict';

  const { h } = widgets;
  const isFn = (v) => typeof v === 'function';
  const isNode = (v) => v && typeof v === 'object' && typeof v.nodeType === 'number';

  function focusEl(el) {
    if (el && isFn(el.focus) && el.isConnected) {
      try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      return true;
    }
    return false;
  }

  /* ================================================================== announce */

  let politeTimer = 0;
  function liveRegion(assertive) {
    const id = assertive ? 'apb-live-assertive' : 'apb-live';
    let el = document.getElementById(id);
    if (!el) {
      el = h('div', { id, class: 'apb-sr-only', 'aria-live': assertive ? 'assertive' : 'polite', 'aria-atomic': 'true' });
      document.body.appendChild(el);
    }
    return el;
  }

  function announce(message, opts) {
    if (typeof document === 'undefined' || message == null) return;
    const el = liveRegion(!!(opts && opts.assertive));
    const text = String(message);
    el.textContent = '';
    clearTimeout(politeTimer);
    // Clearing first and re-setting on the next task makes repeated identical messages announce again.
    politeTimer = setTimeout(() => { el.textContent = text; }, 30);
  }

  /* ==================================================================== dialog */

  const openDialogs = [];

  function actionVariant(kind) {
    if (kind === 'primary') return 'primary';
    if (kind === 'danger') return 'danger';
    if (kind === 'ghost' || kind === 'cancel') return 'default';
    return 'default';
  }

  function dialog(opts) {
    const o = Object.assign({ dismissible: true, actions: [] }, opts);
    const titleId = widgets.uid('apb-dialog-title');
    const previousFocus = document.activeElement;
    let open = true;
    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });

    const title = o.title ? h('h2', { class: 'apb-dialog-title', id: titleId }, String(o.title)) : null;
    const closeBtn = o.dismissible ? widgets.iconButton({ icon: 'close', label: 'Close dialog', size: 'sm', className: 'apb-dialog-close',
      onClick: () => close(undefined, 'close') }) : null;
    const body = h('div', { class: 'apb-dialog-body' });
    if (o.content != null) {
      const list = Array.isArray(o.content) ? o.content : [o.content];
      for (const c of list) {
        if (c == null || c === false) continue;
        body.appendChild(isNode(c) ? c : h('p', { class: 'apb-dialog-message' }, String(c)));
      }
    }
    const footer = h('div', { class: 'apb-dialog-actions' });
    const actionEls = [];
    (o.actions || []).forEach((a) => {
      if (!a) return;
      const btn = widgets.button({
        label: a.label, icon: a.icon, variant: actionVariant(a.kind), disabled: !!a.disabled,
        className: ['apb-dialog-action', a.kind === 'cancel' && 'apb-dialog-action--cancel'],
        onClick: () => {
          if (isFn(a.run)) {
            try { a.run((value) => close(value, 'action'), api); } catch (err) { console.error('[APB] dialog action failed:', err); }
          } else {
            close(a.value, 'action');
          }
        }
      });
      if (a.autofocus) btn.setAttribute('data-autofocus', '');
      actionEls.push(btn);
      footer.appendChild(btn);
    });

    const el = h('dialog', {
      class: ['apb-dialog', o.wide && 'apb-dialog--wide', o.className],
      'aria-labelledby': title ? titleId : null,
      'aria-label': title ? null : (o.label || 'Dialog'),
      'data-apb-keys': 'local'
    },
    title || closeBtn ? h('div', { class: 'apb-dialog-header' }, title, closeBtn) : null,
    body,
    actionEls.length ? footer : null);

    function onKeydown(e) {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (o.dismissible && openDialogs[openDialogs.length - 1] === api) close(undefined, 'escape');
      } else if (e.key === 'Tab') {
        const items = widgets.focusables(el);
        if (!items.length) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === el || !el.contains(active))) { e.preventDefault(); focusEl(last); }
        else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); focusEl(first); }
      }
    }
    function onCancel(e) {
      e.preventDefault();
      if (o.dismissible) close(undefined, 'escape');
    }
    function onNativeClose() {
      if (open) close(undefined, 'native');
    }

    el.addEventListener('keydown', onKeydown);
    el.addEventListener('cancel', onCancel);
    el.addEventListener('close', onNativeClose);

    function close(result, reason) {
      if (!open) return;
      open = false;
      el.removeEventListener('keydown', onKeydown);
      el.removeEventListener('cancel', onCancel);
      el.removeEventListener('close', onNativeClose);
      // popovers (selects, colour pickers) opened from inside the dialog go first
      widgets.openPopovers.forEach((p) => { if (p && p.el && (el.contains(p.el) || (p.el.id && el.querySelector('[aria-controls="' + p.el.id + '"]')))) p.close('parent'); });
      const at = openDialogs.indexOf(api);
      if (at !== -1) openDialogs.splice(at, 1);
      try { if (el.open && isFn(el.close)) el.close(); } catch (_) { /* ignore */ }
      el.remove();
      if (!openDialogs.length) document.documentElement.classList.remove('apb-has-modal');
      const top = openDialogs[openDialogs.length - 1];
      if (!focusEl(previousFocus) && top) focusEl(widgets.focusables(top.el)[0] || top.el);
      if (isFn(o.onClose)) {
        try { o.onClose(result, reason); } catch (err) { console.error('[APB] dialog onClose failed:', err); }
      }
      resolveClosed(result);
    }

    const api = {
      el, body, footer,
      get isOpen() { return open; },
      close: (result) => close(result, 'api'),
      closed,
      actions: actionEls
    };

    document.body.appendChild(el);
    widgets.hideTooltip();
    if (isFn(el.showModal)) {
      try { el.showModal(); } catch (_) { el.setAttribute('open', ''); el.setAttribute('aria-modal', 'true'); }
    } else {
      el.setAttribute('open', '');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('role', 'dialog');
    }
    openDialogs.push(api);
    document.documentElement.classList.add('apb-has-modal');

    let target = null;
    if (o.initialFocus) target = isNode(o.initialFocus) ? o.initialFocus : el.querySelector(String(o.initialFocus));
    if (!target) target = body.querySelector('[autofocus], [data-autofocus]') || footer.querySelector('[data-autofocus]');
    if (!target) target = widgets.focusables(body)[0];
    if (!target) target = footer.querySelector('.apb-btn--primary, .apb-btn--danger') || actionEls[actionEls.length - 1] || closeBtn;
    if (!focusEl(target)) { el.setAttribute('tabindex', '-1'); focusEl(el); }
    return api;
  }

  function confirm(opts) {
    const o = Object.assign({ title: 'Are you sure?', confirmLabel: 'OK', cancelLabel: 'Cancel', danger: false }, opts);
    const d = dialog({
      title: o.title,
      content: o.message != null ? o.message : null,
      className: 'apb-dialog--confirm',
      actions: [
        { label: o.cancelLabel, kind: 'cancel', value: false, autofocus: !!o.danger },
        { label: o.confirmLabel, kind: o.danger ? 'danger' : 'primary', value: true, autofocus: !o.danger }
      ]
    });
    d.el.setAttribute('role', 'alertdialog');
    return d.closed.then((v) => v === true);
  }

  function prompt(opts) {
    const o = Object.assign({ title: 'Enter a value', label: 'Value', value: '', confirmLabel: 'OK', cancelLabel: 'Cancel' }, opts);
    const field = widgets.textField({ label: o.label, value: o.value == null ? '' : String(o.value), placeholder: o.placeholder || '' });
    const input = field.querySelector('input');
    const errorId = widgets.uid('apb-prompt-error');
    const error = h('p', { class: 'apb-dialog-error', id: errorId, role: 'alert', hidden: true });
    input.setAttribute('aria-describedby', errorId);
    const labelEl = h('label', { class: 'apb-dialog-label', for: input.id }, String(o.label));
    input.removeAttribute('aria-label');

    function check() {
      let msg = null;
      if (isFn(o.validate)) {
        try { msg = o.validate(input.value); } catch (err) { msg = String(err && err.message || err); }
      }
      if (msg) {
        error.textContent = String(msg);
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        return false;
      }
      error.hidden = true;
      error.textContent = '';
      input.removeAttribute('aria-invalid');
      return true;
    }

    const d = dialog({
      title: o.title,
      content: [o.message != null ? String(o.message) : null, h('div', { class: 'apb-dialog-field' }, labelEl, field, error)],
      className: 'apb-dialog--prompt',
      initialFocus: input,
      actions: [
        { label: o.cancelLabel, kind: 'cancel', value: null },
        { label: o.confirmLabel, kind: 'primary', run: (close) => { if (check()) close(input.value); else focusEl(input); } }
      ]
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (check()) d.close(input.value);
      }
    });
    input.addEventListener('input', () => { if (!error.hidden) check(); });
    try { input.select(); } catch (_) { /* ignore */ }
    return d.closed.then((v) => (typeof v === 'string' ? v : null));
  }

  /* ===================================================================== toast */

  const TOAST_ICONS = { info: 'info', success: 'success', warn: 'warning', warning: 'warning', error: 'error' };
  const MAX_TOASTS = 5;
  let toastHost = null;
  const toasts = [];

  function ensureToastHost() {
    if (toastHost && toastHost.isConnected) return toastHost;
    toastHost = h('div', { class: 'apb-toasts', 'aria-live': 'polite', 'aria-relevant': 'additions', 'data-apb-keys': 'local' });
    if (env.features && env.features.popover) toastHost.setAttribute('popover', 'manual');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function raiseToastHost() {
    if (!toastHost || !toastHost.hasAttribute('popover')) return;
    try {
      if (toastHost.matches(':popover-open')) toastHost.hidePopover();
      toastHost.showPopover();
    } catch (_) { /* ignore */ }
  }

  function toast(message, opts) {
    if (typeof document === 'undefined') return { el: null, close() {} };
    const o = Object.assign({ kind: 'info', timeout: 4000 }, opts);
    const kind = TOAST_ICONS[o.kind] ? (o.kind === 'warning' ? 'warn' : o.kind) : 'info';
    const text = String(message == null ? '' : message);
    const host = ensureToastHost();

    const dupe = toasts.find((t) => t.text === text && t.kind === kind && !o.action);
    if (dupe) {
      dupe.count++;
      dupe.countEl.textContent = '×' + dupe.count;
      dupe.countEl.hidden = false;
      dupe.restart();
      return dupe.api;
    }

    let timer = 0;
    let remaining = Number(o.timeout) || 0;
    let started = 0;
    let closedFlag = false;
    const countEl = h('span', { class: 'apb-toast-count', hidden: true });
    const actionBtn = o.action && o.action.label ? widgets.button({ label: o.action.label, size: 'sm', variant: 'subtle', className: 'apb-toast-action',
      onClick: () => { close(); if (isFn(o.action.run)) o.action.run(); } }) : null;
    const dismiss = widgets.iconButton({ icon: 'close', label: 'Dismiss notification', size: 'sm', className: 'apb-toast-close', onClick: () => close() });
    const el = h('div', { class: ['apb-toast', 'apb-toast--' + kind], role: kind === 'error' ? 'alert' : 'status', 'aria-atomic': 'true' },
      h('span', { class: 'apb-toast-icon', 'aria-hidden': 'true' }, icons.get(TOAST_ICONS[kind], { size: 16 })),
      h('span', { class: 'apb-toast-message' }, text, countEl),
      actionBtn, dismiss);

    function schedule() {
      clearTimeout(timer);
      if (remaining > 0) { started = Date.now(); timer = setTimeout(close, remaining); }
    }
    function pause() {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      remaining = Math.max(1000, remaining - (Date.now() - started));
    }
    function close() {
      if (closedFlag) return;
      closedFlag = true;
      clearTimeout(timer);
      const had = el.contains(document.activeElement);
      el.remove();
      const at = toasts.indexOf(entry);
      if (at !== -1) toasts.splice(at, 1);
      if (had) focusEl(document.querySelector('.apb-viewport'));
      if (!toasts.length && toastHost && toastHost.hasAttribute('popover')) { try { toastHost.hidePopover(); } catch (_) { /* ignore */ } }
    }
    el.addEventListener('pointerenter', pause);
    el.addEventListener('pointerleave', schedule);
    el.addEventListener('focusin', pause);
    el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) schedule(); });

    const api = { el, close };
    const entry = {
      text, kind, count: 1, countEl, api,
      restart() { remaining = Number(o.timeout) || 0; schedule(); }
    };
    toasts.push(entry);
    host.appendChild(el);
    while (toasts.length > MAX_TOASTS) toasts[0].api.close();
    raiseToastHost();
    schedule();
    return api;
  }

  /* ====================================================================== menu */

  let rootMenu = null;

  function formatShortcut(shortcut) {
    const list = Array.isArray(shortcut) ? shortcut.filter(Boolean) : shortcut ? [shortcut] : [];
    if (!list.length) return null;
    try { return { text: commands.formatKeys(list[0]), combos: list }; } catch (_) { return { text: String(list[0]), combos: [] }; }
  }

  function ariaKeyshortcuts(combos) {
    const out = [];
    for (const combo of combos) {
      try {
        const p = commands.parseKey(combo);
        const mods = p.mods.map((m) => ({ mod: env.mac ? 'Meta' : 'Control', ctrl: 'Control', meta: 'Meta', alt: 'Alt', shift: 'Shift' })[m] || m);
        out.push(mods.concat(p.key === ' ' ? 'Space' : p.key).join('+'));
      } catch (_) { /* skip */ }
    }
    return out.join(' ');
  }

  function normalizeItems(items) {
    const src = isFn(items) ? items() : items;
    const out = [];
    for (const it of Array.isArray(src) ? src : []) {
      if (!it) continue;
      const sep = it === '-' || it.separator === true || it.type === 'separator';
      if (sep) {
        if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
        continue;
      }
      if (it.hidden) continue;
      out.push(it);
    }
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  }

  function menuLevel(anchor, items, opts, parent) {
    const o = opts || {};
    const list = normalizeItems(items);
    const anchorEl = isNode(anchor) && anchor.nodeType === 1 ? anchor : null;
    let level = null;
    const pop = widgets.popover({
      anchor,
      role: 'menu',
      label: o.label || null,
      className: ['apb-menu', parent && 'apb-menu--sub'],
      placement: o.placement || (parent ? 'right-start' : 'bottom-start'),
      offset: parent ? 2 : (anchorEl ? 4 : 2),
      focus: false,
      returnFocus: true,
      onClose: (reason) => {
        if (!level) return;
        clearTimeout(level.hoverTimer);
        if (parent && parent.child === level) parent.child = null;
        if (!parent && rootMenu === level) rootMenu = null;
        if (isFn(o.onClose)) o.onClose(reason);
      }
    });
    const el = pop.el;
    el.setAttribute('aria-orientation', 'vertical');
    level = { el, pop, parent, child: null, items: [], hoverTimer: 0, typed: '', typedAt: 0, anchorEl };

    if (!list.length) list.push({ label: o.emptyLabel || 'No actions available', disabled: true });
    if (list.some((it) => !it.separator && it.checked != null && it.submenu == null)) el.setAttribute('data-checks', '');
    if (list.some((it) => !it.separator && it.icon)) el.setAttribute('data-icons', '');

    for (const it of list) {
      if (it.separator) {
        el.appendChild(h('div', { class: 'apb-menu-separator', role: 'separator' }));
        continue;
      }
      const hasSub = it.submenu != null;
      const checkable = it.checked != null && !hasSub;
      const shortcut = hasSub ? null : formatShortcut(it.shortcut);
      const label = String(it.label == null ? '' : it.label);
      const btn = h('button', {
        type: 'button',
        class: ['apb-menu-item', it.danger && 'is-danger'],
        role: checkable ? 'menuitemcheckbox' : 'menuitem',
        tabindex: '-1',
        'aria-checked': checkable ? String(!!it.checked) : null,
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-haspopup': hasSub ? 'menu' : null,
        'aria-expanded': hasSub ? 'false' : null,
        'aria-keyshortcuts': shortcut && shortcut.combos.length ? ariaKeyshortcuts(shortcut.combos) || null : null,
        'data-command': it.command || null
      },
      h('span', { class: 'apb-menu-check', 'aria-hidden': 'true' }, checkable && it.checked ? icons.get('check', { size: 14 }) : null),
      h('span', { class: 'apb-menu-icon', 'aria-hidden': 'true' }, it.icon ? (isNode(it.icon) ? it.icon : icons.get(String(it.icon), { size: 16 })) : null),
      h('span', { class: 'apb-menu-label' }, label),
      shortcut ? h('span', { class: 'apb-menu-shortcut', 'aria-hidden': 'true' }, shortcut.text) : null,
      hasSub ? h('span', { class: 'apb-menu-sub', 'aria-hidden': 'true' }, icons.get('chevron-right', { size: 14 })) : null);
      const entry = { it, btn, label, hasSub };
      level.items.push(entry);
      el.appendChild(btn);
      btn.addEventListener('click', (e) => { e.preventDefault(); activate(level, entry, e.detail === 0); });
      btn.addEventListener('pointermove', () => {
        if (document.activeElement !== btn) focusEl(btn);
        clearTimeout(level.hoverTimer);
        if (entry.hasSub && !it.disabled) {
          if (!level.child || level.child.anchorEl !== btn) level.hoverTimer = setTimeout(() => openSub(level, entry, false), 140);
        } else if (level.child) {
          level.hoverTimer = setTimeout(() => { if (level.child) level.child.pop.close('hover'); }, 220);
        }
      });
    }

    el.addEventListener('keydown', (e) => onMenuKey(level, e));
    return level;
  }

  function focusable(level) {
    return level.items;
  }

  function focusItem(level, index) {
    const items = focusable(level);
    if (!items.length) return;
    const i = ((index % items.length) + items.length) % items.length;
    focusEl(items[i].btn);
  }

  function currentIndex(level) {
    return level.items.findIndex((x) => x.btn === document.activeElement);
  }

  function openSub(level, entry, focusFirst) {
    if (level.child && level.child.anchorEl === entry.btn) {
      if (focusFirst) focusItem(level.child, 0);
      return level.child;
    }
    if (level.child) level.child.pop.close('switch');
    if (!level.pop.isOpen) return null;
    const child = menuLevel(entry.btn, entry.it.submenu, { label: entry.label }, level);
    level.child = child;
    if (focusFirst) focusItem(child, 0);
    return child;
  }

  function closeAll(reason) {
    let top = rootMenu;
    if (top) top.pop.close(reason || 'close');
  }

  function activate(level, entry, fromKeyboard) {
    const it = entry.it;
    if (it.disabled) return;
    if (entry.hasSub) { openSub(level, entry, true); return; }
    let root = level;
    while (root.parent) root = root.parent;
    root.pop.close('select');
    if (isFn(it.run)) {
      try {
        const r = it.run();
        if (r && isFn(r.then)) r.then(null, (err) => console.error('[APB] menu action failed:', err));
      } catch (err) {
        console.error('[APB] menu action failed:', err);
      }
    }
    void fromKeyboard;
  }

  function onMenuKey(level, e) {
    if (e.defaultPrevented) return;
    const items = level.items;
    const idx = currentIndex(level);
    const entry = idx >= 0 ? items[idx] : null;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(level, idx + 1); break;
      case 'ArrowUp': e.preventDefault(); focusItem(level, idx < 0 ? -1 : idx - 1); break;
      case 'Home': case 'PageUp': e.preventDefault(); focusItem(level, 0); break;
      case 'End': case 'PageDown': e.preventDefault(); focusItem(level, items.length - 1); break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (entry) activate(level, entry, true);
        break;
      case 'ArrowRight':
        if (entry && entry.hasSub && !entry.it.disabled) { e.preventDefault(); openSub(level, entry, true); }
        break;
      case 'ArrowLeft':
        if (level.parent) { e.preventDefault(); e.stopPropagation(); level.pop.close('left'); }
        break;
      case 'Tab':
        e.preventDefault();
        closeAll('tab');
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          level.typed = (now - level.typedAt < 600 ? level.typed : '') + e.key.toLowerCase();
          level.typedAt = now;
          const n = items.length;
          const start = level.typed.length === 1 ? idx + 1 : Math.max(idx, 0);
          for (let k = 0; k < n; k++) {
            const cand = items[(start + k) % n];
            if (cand.label.toLowerCase().startsWith(level.typed)) { focusEl(cand.btn); break; }
          }
          e.preventDefault();
        }
    }
  }

  /**
   * menu(anchorOrEvent, items, opts) — anchor: Element (placed below) | MouseEvent / { clientX, clientY } (at the pointer).
   * Only one root menu is open at a time; focus moves to the first item and returns to the anchor on close.
   */
  function menu(anchorOrEvent, items, opts) {
    if (typeof document === 'undefined') return { el: null, close() {} };
    const o = opts || {};
    if (anchorOrEvent && isFn(anchorOrEvent.preventDefault) && anchorOrEvent.type === 'contextmenu') anchorOrEvent.preventDefault();
    closeAll('replace');
    let anchor = anchorOrEvent;
    if (!anchor) {
      const vw = document.documentElement.clientWidth;
      anchor = { clientX: vw / 2, clientY: 80 };
    } else if (!isNode(anchor) && typeof anchor.clientX === 'number') {
      anchor = { clientX: anchor.clientX, clientY: anchor.clientY };
    }
    const level = menuLevel(anchor, items, o, null);
    rootMenu = level;
    const first = level.items.findIndex((x) => !x.it.disabled);
    focusItem(level, first < 0 ? 0 : first);
    return { el: level.el, close: () => level.pop.close('api'), get isOpen() { return level.pop.isOpen; } };
  }

  return {
    dialog, confirm, prompt, toast, menu, announce,
    closeMenus: () => closeAll('api'),
    get openDialogs() { return openDialogs.slice(); },
    get menuOpen() { return !!(rootMenu && rootMenu.pop.isOpen); },
    get toasts() { return toasts.map((t) => t.api); }
  };
});

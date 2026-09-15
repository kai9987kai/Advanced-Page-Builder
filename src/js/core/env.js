/* @node-testable */
/*
 * env — platform & feature detection. Every probe is lazy and safe in Node
 * (no window/document access at define time). See ARCHITECTURE.md §3, PLAN A1.
 */
APB.define('env', [], function () {
  'use strict';

  const g = globalThis;
  const hasWindow = () => typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
  const nav = () => (typeof g.navigator !== 'undefined' ? g.navigator : null);

  function safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function media(query) {
    return safe(() => !!(hasWindow() && typeof g.matchMedia === 'function' && g.matchMedia(query).matches), false);
  }

  function cssSupports(text) {
    return safe(() => !!(g.CSS && typeof g.CSS.supports === 'function' && g.CSS.supports(text)), false);
  }

  function detectMac() {
    const n = nav();
    if (!n) return false;
    const platform = safe(() => (n.userAgentData && n.userAgentData.platform) || n.platform || '', '');
    if (platform) return /mac|iphone|ipad|ipod/i.test(platform);
    return /Mac OS X|Macintosh|iPhone|iPad/.test(n.userAgent || '');
  }

  const featureProbes = {
    pointer: () => typeof g.PointerEvent === 'function',
    dialog: () => typeof g.HTMLDialogElement === 'function' && typeof g.HTMLDialogElement.prototype.showModal === 'function',
    popover: () => typeof g.HTMLElement === 'function' && Object.prototype.hasOwnProperty.call(g.HTMLElement.prototype, 'popover'),
    anchor: () => cssSupports('anchor-name: --a') && cssSupports('position-area: top'),
    scope: () => typeof g.CSSScopeRule === 'function',
    fsAccess: () => typeof g.showSaveFilePicker === 'function' && typeof g.showOpenFilePicker === 'function',
    eyeDropper: () => typeof g.EyeDropper === 'function',
    sanitizerAPI: () => typeof g.Element === 'function' && typeof g.Element.prototype.setHTML === 'function',
    idb: () => typeof g.indexedDB !== 'undefined' && g.indexedDB !== null,
    broadcast: () => typeof g.BroadcastChannel === 'function',
    compression: () => typeof g.CompressionStream === 'function' && typeof g.DecompressionStream === 'function',
    clipboardItem: () => typeof g.ClipboardItem === 'function' && !!(nav() && nav().clipboard && nav().clipboard.write),
    viewTransition: () => hasWindow() && typeof g.document.startViewTransition === 'function',
    scrollTimeline: () => cssSupports('animation-timeline: view()'),
    onDeviceAI: () => typeof g.LanguageModel === 'function' || typeof g.Summarizer === 'function' ||
      typeof g.Writer === 'function' || typeof g.Rewriter === 'function'
  };

  const features = {};
  const cache = {};
  Object.keys(featureProbes).forEach((key) => {
    Object.defineProperty(features, key, {
      enumerable: true,
      get() {
        if (!(key in cache)) cache[key] = safe(featureProbes[key], false);
        return cache[key];
      }
    });
  });

  let macCache;
  const env = {
    get isBrowser() { return hasWindow(); },
    get mac() {
      if (macCache === undefined) macCache = safe(detectMac, false);
      return macCache;
    },
    get touch() {
      const n = nav();
      return safe(() => !!((n && n.maxTouchPoints > 0) || (hasWindow() && 'ontouchstart' in g.window)), false);
    },
    get coarse() { return media('(pointer: coarse)'); },
    reducedMotion() { return media('(prefers-reduced-motion: reduce)'); },
    prefersDark() { return media('(prefers-color-scheme: dark)'); },
    forcedColors() { return media('(forced-colors: active)'); },
    features,
    /** Clear cached probes (tests / after polyfills). */
    reset() {
      Object.keys(cache).forEach((k) => delete cache[k]);
      macCache = undefined;
    },
    /** Test hook: force platform to mac / non-mac (undefined = auto-detect). */
    setMac(value) { macCache = value === undefined ? undefined : !!value; },
    media
  };

  return env;
});

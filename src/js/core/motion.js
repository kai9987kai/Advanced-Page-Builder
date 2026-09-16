/* @node-testable */
/*
 * motion — animation presets for `node.motion` (ARCHITECTURE.md §5.1: `{ preset, duration, delay,
 * easing, trigger: 'enter'|'load' }`). Pure (no DOM); consumed by `features/motion.js` (the
 * inspector "Animation" section + a Web Animations API canvas preview) and `features/exporters.js`
 * (which appends `keyframesCSS()` + `runtimeSource()` — a trusted `<script>`, same reasoning as
 * `core/actions.js` — only when `usesMotion(doc)` is true). See ARCHITECTURE.md §11 for the export
 * contract this fulfils: "@keyframes + scroll-driven animation-timeline: view() with an
 * IntersectionObserver fallback script only when motion is used" and reduced-motion support.
 */
APB.define('motion', ['util'], function (util) {
  'use strict';

  const MAX_MS = 10000;
  const TRIGGERS = new Set(['enter', 'load']);
  const EASINGS = ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear'];

  /** Each preset's `from`/`to` (and optional `mid` steps) are plain CSS declarations — kebab-case, trusted (authored here, never user input). */
  const PRESETS = [
    { id: 'fade', label: 'Fade in', from: { opacity: '0' }, to: { opacity: '1' } },
    { id: 'slide-up', label: 'Slide up', from: { opacity: '0', transform: 'translateY(24px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
    { id: 'slide-down', label: 'Slide down', from: { opacity: '0', transform: 'translateY(-24px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
    { id: 'slide-left', label: 'Slide from right', from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
    { id: 'slide-right', label: 'Slide from left', from: { opacity: '0', transform: 'translateX(-24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
    { id: 'zoom-in', label: 'Zoom in', from: { opacity: '0', transform: 'scale(0.9)' }, to: { opacity: '1', transform: 'scale(1)' } },
    { id: 'zoom-out', label: 'Zoom out', from: { opacity: '0', transform: 'scale(1.08)' }, to: { opacity: '1', transform: 'scale(1)' } },
    {
      id: 'bounce', label: 'Bounce in',
      from: { opacity: '0', transform: 'translateY(16px) scale(0.96)' },
      mid: [{ at: 60, decls: { opacity: '1', transform: 'translateY(-6px) scale(1.01)' } }, { at: 80, decls: { transform: 'translateY(2px) scale(0.995)' } }],
      to: { opacity: '1', transform: 'translateY(0) scale(1)' }
    },
    { id: 'flip', label: 'Flip in', from: { opacity: '0', transform: 'rotateX(-50deg)' }, to: { opacity: '1', transform: 'rotateX(0)' } }
  ];

  const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

  const has = (id) => BY_ID.has(id);
  const list = () => PRESETS.map((p) => ({ id: p.id, label: p.label }));

  function keyframesName(presetId) { return 'apb-mo-' + presetId; }

  function declsToCss(decls) {
    return Object.keys(decls).map((k) => k + ':' + decls[k]).join(';');
  }

  /** keyframesCSS(presetId) → '@keyframes apb-mo-fade{from{...}to{...}}' ('' for an unknown id). */
  function keyframesCSS(presetId) {
    const p = BY_ID.get(presetId);
    if (!p) return '';
    const steps = [['0%', p.from]].concat((p.mid || []).map((m) => [m.at + '%', m.decls])).concat([['100%', p.to]]);
    return '@keyframes ' + keyframesName(presetId) + '{' + steps.map(([pct, decls]) => pct + '{' + declsToCss(decls) + '}').join('') + '}';
  }

  /** normalize(motion, { doc }) → clean { preset, duration, delay, easing, trigger } | null. */
  function normalize(motion) {
    if (!util.isPlainObject(motion) || !has(motion.preset)) return null;
    const duration = Number.isFinite(motion.duration) ? util.clamp(Math.round(motion.duration), 50, MAX_MS) : 500;
    const delay = Number.isFinite(motion.delay) ? util.clamp(Math.round(motion.delay), 0, MAX_MS) : 0;
    const easing = EASINGS.includes(motion.easing) ? motion.easing : 'ease-out';
    const trigger = TRIGGERS.has(motion.trigger) ? motion.trigger : 'enter';
    return { preset: motion.preset, duration, delay, easing, trigger };
  }

  /** framesFor(presetId) → KeyframeEffect-compatible frames, for the Web Animations API canvas preview. */
  function framesFor(presetId) {
    const p = BY_ID.get(presetId);
    if (!p) return null;
    // `opacity`/`transform` are valid Web Animations API property names as-is (no camelCase
    // conversion needed — the only two CSS properties any preset uses happen to already match).
    const frames = [Object.assign({ offset: 0 }, p.from)];
    (p.mid || []).forEach((m) => frames.push(Object.assign({ offset: m.at / 100 }, m.decls)));
    frames.push(Object.assign({ offset: 1 }, p.to));
    return frames;
  }

  /** nodeCSS(className, motion) → the CSS to emit for one node's animation (base/inview/reduced-motion rules). */
  function nodeCSS(className, motion) {
    const clean = normalize(motion);
    if (!clean) return '';
    const p = BY_ID.get(clean.preset);
    const base = '.' + className + '{' + declsToCss(p.from) + '}';
    const anim = 'animation:' + keyframesName(clean.preset) + ' ' + clean.duration + 'ms ' + clean.easing + ' ' + clean.delay + 'ms both;';
    const active = clean.trigger === 'load'
      ? '.' + className + '{' + anim + '}'
      : '.' + className + '.apb-inview{' + anim + '}';
    const scrollDriven = clean.trigger === 'enter'
      ? '@supports (animation-timeline:view()){.' + className + '{' + anim + 'animation-timeline:view();animation-range:entry 0% cover 35%;}}'
      : '';
    // Cancelling the animation alone would leave the element stuck in its `from` state (e.g.
    // invisible) forever, since that's what `base` sets unconditionally — reduced-motion needs to
    // land on `to` instead, not just turn the animation off.
    const reduced = '@media (prefers-reduced-motion:reduce){.' + className + '{animation:none!important;'
      + Object.keys(p.to).map((k) => k + ':' + p.to[k] + ' !important').join(';') + '}}';
    return base + active + scrollDriven + reduced;
  }

  /** usesMotion(doc) → true if any node carries a recognized motion preset (gates the export runtime + withIds-free CSS). */
  function usesMotion(doc) {
    const nodes = doc && doc.nodes;
    if (!util.isPlainObject(nodes)) return false;
    for (const id of Object.keys(nodes)) {
      const n = nodes[id];
      if (n && normalize(n.motion)) return true;
    }
    return false;
  }

  /**
   * Trusted runtime appended verbatim by exporters/preview (never through vdom/sanitize) when
   * `usesMotion(doc)` is true: an IntersectionObserver adds `.apb-inview` to `[data-apb-motion="enter"]`
   * elements (the `@supports` scroll-timeline rule in `nodeCSS` takes over instead, in browsers that
   * support it — the class is harmless there); `[data-apb-motion="load"]` elements animate immediately
   * via `nodeCSS` alone and need no script. `prefers-reduced-motion` disables everything in CSS, so
   * this script only ever toggles a class — nothing here needs to check it itself.
   */
  function runtimeSource() {
    return '(function(){\n' +
      '  if (!("IntersectionObserver" in window)) {\n' +
      '    document.querySelectorAll(\'[data-apb-motion="enter"]\').forEach(function (el) { el.classList.add("apb-inview"); });\n' +
      '    return;\n' +
      '  }\n' +
      '  var io = new IntersectionObserver(function (entries) {\n' +
      '    entries.forEach(function (entry) {\n' +
      '      if (entry.isIntersecting) { entry.target.classList.add("apb-inview"); io.unobserve(entry.target); }\n' +
      '    });\n' +
      '  }, { threshold: 0.2 });\n' +
      '  function apbMotionInit(root) {\n' +
      '    (root || document).querySelectorAll(\'[data-apb-motion="enter"]\').forEach(function (el) { io.observe(el); });\n' +
      '  }\n' +
      '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { apbMotionInit(document); });\n' +
      '  else apbMotionInit(document);\n' +
      '})();';
  }

  return { PRESETS, EASINGS, has, list, normalize, keyframesName, keyframesCSS, nodeCSS, framesFor, usesMotion, runtimeSource };
});

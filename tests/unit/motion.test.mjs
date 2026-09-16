export default function (APB, t) {
  const { test, assert } = t;
  const motion = APB.require('motion');

  test('list()/has() cover every preset', () => {
    const list = motion.list();
    assert.ok(list.length >= 6);
    for (const p of list) { assert.equal(typeof p.id, 'string'); assert.equal(typeof p.label, 'string'); assert.ok(motion.has(p.id)); }
    assert.ok(!motion.has('nope'));
  });

  test('normalize: rejects unknown/missing presets, clamps duration/delay, whitelists easing/trigger', () => {
    assert.equal(motion.normalize(null), null);
    assert.equal(motion.normalize({}), null);
    assert.equal(motion.normalize({ preset: 'nope' }), null);
    const defaults = motion.normalize({ preset: 'fade' });
    assert.deepEqual(defaults, { preset: 'fade', duration: 500, delay: 0, easing: 'ease-out', trigger: 'enter' });
    const clamped = motion.normalize({ preset: 'fade', duration: -5, delay: 999999, easing: 'wobble', trigger: 'nope' });
    assert.equal(clamped.duration, 50);
    assert.equal(clamped.delay, 10000);
    assert.equal(clamped.easing, 'ease-out');
    assert.equal(clamped.trigger, 'enter');
    const good = motion.normalize({ preset: 'slide-up', duration: 800, delay: 100, easing: 'linear', trigger: 'load' });
    assert.deepEqual(good, { preset: 'slide-up', duration: 800, delay: 100, easing: 'linear', trigger: 'load' });
  });

  test('keyframesCSS() emits a valid-looking @keyframes block including any mid steps, "" for an unknown preset', () => {
    assert.equal(motion.keyframesCSS('nope'), '');
    const fade = motion.keyframesCSS('fade');
    assert.match(fade, /^@keyframes apb-mo-fade\{0%\{opacity:0\}100%\{opacity:1\}\}$/);
    const bounce = motion.keyframesCSS('bounce');
    assert.match(bounce, /^@keyframes apb-mo-bounce\{0%\{.*\}60%\{.*\}80%\{.*\}100%\{.*\}\}$/);
  });

  test('nodeCSS(): base + trigger rule + @supports scroll-timeline (enter only) + reduced-motion landing on `to`', () => {
    assert.equal(motion.nodeCSS('n-x', null), '');
    const enter = motion.nodeCSS('n-x', { preset: 'fade', duration: 400, delay: 0, easing: 'ease', trigger: 'enter' });
    assert.match(enter, /\.n-x\{opacity:0\}/, 'base state matches the `from` frame');
    assert.match(enter, /\.n-x\.apb-inview\{animation:apb-mo-fade 400ms ease 0ms both;\}/, 'enter trigger gates on .apb-inview');
    assert.match(enter, /@supports \(animation-timeline:view\(\)\)/, 'progressive enhancement for scroll-linked reveal');
    assert.match(enter, /@media \(prefers-reduced-motion:reduce\)\{\.n-x\{animation:none!important;opacity:1 !important\}\}/);

    const load = motion.nodeCSS('n-y', { preset: 'fade', duration: 400, delay: 0, easing: 'ease', trigger: 'load' });
    assert.match(load, /\.n-y\{animation:apb-mo-fade 400ms ease 0ms both;\}/, 'load trigger animates unconditionally, no .apb-inview needed');
    assert.ok(!load.includes('@supports'), 'scroll-timeline enhancement only applies to the enter trigger');
  });

  test('framesFor(): Web Animations API frames for the canvas preview, offsets in [0,1], null for an unknown preset', () => {
    assert.equal(motion.framesFor('nope'), null);
    const frames = motion.framesFor('slide-up');
    assert.equal(frames[0].offset, 0);
    assert.equal(frames[frames.length - 1].offset, 1);
    assert.equal(frames[0].opacity, '0');
    assert.equal(frames[frames.length - 1].opacity, '1');
    const bounce = motion.framesFor('bounce');
    assert.equal(bounce.length, 4, 'from + two mid steps + to');
    assert.equal(bounce[1].offset, 0.6);
  });

  test('usesMotion(): true only when some node has a recognized preset', () => {
    assert.equal(motion.usesMotion({ nodes: {} }), false);
    assert.equal(motion.usesMotion({ nodes: { a: { motion: null }, b: { motion: { preset: 'nope' } } } }), false);
    assert.equal(motion.usesMotion({ nodes: { a: { motion: null }, b: { motion: { preset: 'fade' } } } }), true);
  });

  test('runtimeSource() is syntactically valid and toggles .apb-inview via IntersectionObserver', () => {
    const src = motion.runtimeSource();
    assert.match(src, /IntersectionObserver/);
    assert.match(src, /apb-inview/);
    assert.match(src, /data-apb-motion/);
    assert.doesNotThrow(() => new Function(src));
  });
}

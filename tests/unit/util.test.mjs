export default function (APB, t) {
  const { test, assert } = t;
  const util = APB.require('util');

  test('uid has prefix and 8 base36 chars, avoids collisions', () => {
    const id = util.uid('n');
    assert.match(id, /^n_[0-9a-z]{8}$/);
    assert.match(util.uid('doc'), /^doc_[0-9a-z]{8}$/);
    const ids = new Set(Array.from({ length: 2000 }, () => util.uid('n')));
    assert.equal(ids.size, 2000);
    const existing = { [id]: 1 };
    assert.notEqual(util.uid('n', existing), id);
  });

  test('clamp / round / lerp', () => {
    assert.equal(util.clamp(5, 0, 3), 3);
    assert.equal(util.clamp(-1, 0, 3), 0);
    assert.equal(util.clamp(2, 3, 0), 2);
    assert.equal(util.round(1.26, 0.1), 1.3);
    assert.equal(util.round(0.1 + 0.2, 0.01), 0.3);
    assert.equal(util.round(17, 8), 16);
    assert.equal(util.round(-0.4), 0);
    assert.equal(util.lerp(10, 20, 0.25), 12.5);
  });

  test('deepClone copies plain data, deepEqual compares structurally', () => {
    const src = { a: [1, { b: 2 }], d: new Date(5), m: new Map([['k', { v: 1 }]]), s: new Set([1, 2]) };
    const copy = util.deepClone(src);
    assert.notEqual(copy.a, src.a);
    assert.notEqual(copy.a[1], src.a[1]);
    assert.ok(util.deepEqual(copy, src));
    assert.ok(util.deepEqual({ a: 1, b: undefined }, { a: 1 }));
    assert.ok(!util.deepEqual({ a: 1 }, { a: 2 }));
    assert.ok(!util.deepEqual([1, 2], [2, 1]));
    assert.ok(util.deepEqual(NaN, NaN));
    assert.ok(!util.deepEqual([], {}));
  });

  test('deepMerge merges plain objects one level, replaces arrays, skips undefined', () => {
    const a = { style: { fill: 'red', color: 'blue' }, pad: [1, 2], x: 1, layout: null };
    const b = { style: { fill: 'green', opacity: undefined }, pad: [3], x: undefined, layout: { mode: 'stack' } };
    const out = util.deepMerge(a, b);
    assert.deepEqual(out, { style: { fill: 'green', color: 'blue' }, pad: [3], x: 1, layout: { mode: 'stack' } });
    assert.equal(a.style.fill, 'red', 'input untouched');
  });

  test('getPath / setPathImmutable are copy-on-write', () => {
    const obj = { a: { b: { c: 1 } }, other: { keep: true }, list: [1, 2, 3] };
    assert.equal(util.getPath(obj, 'a.b.c'), 1);
    assert.equal(util.getPath(obj, ['a', 'x', 'y']), undefined);
    assert.equal(util.getPath(obj, 'list.1'), 2);
    const next = util.setPathImmutable(obj, 'a.b.c', 2);
    assert.equal(next.a.b.c, 2);
    assert.equal(obj.a.b.c, 1);
    assert.equal(next.other, obj.other, 'untouched branches keep identity');
    assert.equal(util.setPathImmutable(obj, 'a.b.c', 1), obj, 'no-op returns same object');
    const created = util.setPathImmutable(obj, 'x.y.z', 5);
    assert.equal(created.x.y.z, 5);
    const deleted = util.setPathImmutable(obj, 'a.b.c', undefined);
    assert.ok(!('c' in deleted.a.b));
    assert.equal(util.setPathImmutable(obj, 'nope.deep', undefined), obj);
    const spliced = util.setPathImmutable(obj, 'list.1', undefined);
    assert.deepEqual(spliced.list, [1, 3]);
    assert.ok(Array.isArray(util.setPathImmutable(obj, 'list.0', 9).list));
    assert.throws(() => util.setPathImmutable({}, '__proto__.polluted', 1), /unsafe/);
  });

  test('escapeHTML / escapeAttr', () => {
    assert.equal(util.escapeHTML('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.equal(util.escapeAttr('`x`'), '&#96;x&#96;');
    assert.equal(util.escapeHTML(null), '');
  });

  test('slugify / formatBytes / plural / kebab', () => {
    assert.equal(util.slugify('  Héllo, Wörld & Friends! '), 'hello-world-and-friends');
    assert.equal(util.slugify('***', 'page'), 'page');
    assert.equal(util.formatBytes(0), '0 B');
    assert.equal(util.formatBytes(512), '512 B');
    assert.equal(util.formatBytes(1536), '1.5 KB');
    assert.equal(util.formatBytes(5 * 1024 * 1024), '5 MB');
    assert.equal(util.plural(1, 'layer'), '1 layer');
    assert.equal(util.plural(3, 'layer'), '3 layers');
    assert.equal(util.plural(2, 'copy'), '2 copies');
    assert.equal(util.plural(2, 'box'), '2 boxes');
    assert.equal(util.kebab('backgroundColor'), 'background-color');
    assert.equal(util.camel('background-color'), 'backgroundColor');
  });

  test('pick / omit / groupBy / uniq', () => {
    assert.deepEqual(util.pick({ a: 1, b: 2 }, ['a', 'z']), { a: 1 });
    assert.deepEqual(util.omit({ a: 1, b: 2 }, ['a']), { b: 2 });
    assert.deepEqual(util.groupBy([{ k: 'x' }, { k: 'y' }, { k: 'x' }], 'k'), { x: [{ k: 'x' }, { k: 'x' }], y: [{ k: 'y' }] });
    assert.deepEqual(util.uniq([1, 1, 2]), [1, 2]);
  });

  test('fuzzyScore ranks prefix/word-start matches higher and rejects non-matches', () => {
    assert.equal(util.fuzzyScore('xyz', 'Zoom to fit'), 0);
    assert.ok(util.fuzzyScore('', 'anything') > 0);
    const zf = util.fuzzyScore('ztf', 'Zoom to fit');
    const zs = util.fuzzyScore('ztf', 'Zoom out fast then');
    assert.ok(zf > 0 && zs > 0);
    assert.ok(util.fuzzyScore('zoom', 'Zoom to fit') > util.fuzzyScore('zoom', 'Reset zoom'));
    assert.ok(util.fuzzyScore('undo', 'Undo') > util.fuzzyScore('undo', 'Undo history panel'));
    assert.deepEqual(util.fuzzyMatch('tf', 'to fit').positions, [0, 3]);
  });

  test('nextName increments numbered copies', () => {
    assert.equal(util.nextName('Frame', []), 'Frame');
    assert.equal(util.nextName('Frame', ['Frame']), 'Frame 2');
    assert.equal(util.nextName('Frame', ['Frame', 'Frame 2', 'Frame 7']), 'Frame 8');
    assert.equal(util.nextName('Card 2', ['Card', 'Card 2']), 'Card 3');
    assert.equal(util.nextName('a.b (x)', ['a.b (x)']), 'a.b (x) 2');
  });

  test('debounce, throttle and rafBatch coalesce calls', async () => {
    let d = 0;
    const deb = util.debounce(() => d++, 20);
    deb(); deb(); deb();
    assert.equal(d, 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(d, 1);
    deb();
    deb.flush();
    assert.equal(d, 2);
    deb();
    deb.cancel();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d, 2);

    let th = 0;
    const thr = util.throttle(() => th++, 30);
    thr(); thr(); thr();
    assert.equal(th, 1, 'leading call');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(th, 2, 'trailing call');

    const calls = [];
    const batched = util.rafBatch((v) => calls.push(v));
    batched(1); batched(2); batched(3);
    assert.equal(calls.length, 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, [3]);
    batched(4);
    batched.cancel();
    await Promise.resolve();
    assert.deepEqual(calls, [3]);
  });

  test('events: Emitter on/once/off and error isolation', () => {
    const { Emitter } = APB.require('events');
    const em = new Emitter();
    const seen = [];
    const off = em.on('x', (p) => seen.push('a' + p));
    em.once('x', (p) => seen.push('b' + p));
    const origError = console.error;
    let reported = 0;
    console.error = () => { reported++; };
    try {
      em.on('x', () => { throw new Error('boom'); });
      em.on('x', (p) => seen.push('c' + p));
      em.emit('x', 1);
      em.emit('x', 2);
    } finally {
      console.error = origError;
    }
    assert.deepEqual(seen, ['a1', 'b1', 'c1', 'a2', 'c2']);
    assert.equal(reported, 2);
    off();
    assert.equal(em.listenerCount('x'), 2);
    em.off('x');
    assert.equal(em.emit('x', 3), 0);
  });

  test('APB module system: lazy require, circular detection, plugins order', () => {
    const A = t.loadAPB();
    let made = 0;
    A.define('t-a', ['t-b'], (b) => { made++; return { b }; });
    A.define('t-b', [], () => ({ v: 1 }));
    assert.equal(made, 0, 'lazy');
    assert.equal(A.require('t-a').b.v, 1);
    assert.equal(A.require('t-a'), A.require('t-a'));
    assert.equal(made, 1);
    A.define('t-c1', ['t-c2'], () => ({}));
    A.define('t-c2', ['t-c1'], () => ({}));
    assert.throws(() => A.require('t-c1'), /circular/);
    assert.throws(() => A.require('t-missing'), /not defined/);
    assert.throws(() => A.define('t-a', [], () => ({})), /already defined/);
    assert.ok(A.has('t-b') && A.list().includes('t-b'));
    A.plugin({ id: 'p1', init() {} });
    A.plugin({ id: 'p2', order: 10, init() {} });
    A.plugin({ id: 'p3', init() {} });
    assert.deepEqual(A.plugins().map((p) => p.id), ['p2', 'p1', 'p3']);
    assert.equal(A.version, '2.0.0');
  });

  test('env is safe in Node and lazily detects features', () => {
    const env = APB.require('env');
    assert.equal(typeof env.mac, 'boolean');
    assert.equal(env.reducedMotion(), false);
    assert.equal(env.features.dialog, false);
    assert.equal(env.features.idb, false);
    assert.deepEqual(Object.keys(env.features).sort(), ['anchor', 'broadcast', 'clipboardItem', 'compression', 'dialog', 'eyeDropper', 'fsAccess', 'idb',
      'onDeviceAI', 'pointer', 'popover', 'sanitizerAPI', 'scope', 'scrollTimeline', 'viewTransition'].sort());
    const macAPB = t.loadAPB({ globals: { navigator: { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)', maxTouchPoints: 0 } } });
    assert.equal(macAPB.require('env').mac, true);
    const winAPB = t.loadAPB({ globals: { navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', maxTouchPoints: 0 } } });
    assert.equal(winAPB.require('env').mac, false);
  });
}

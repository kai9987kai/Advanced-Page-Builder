// style — node → CSS declarations (§6.9)
export default function (APB, t) {
  const { test, assert } = t;
  const style = APB.require('style');
  const schema = APB.require('schema');

  const obj = (m) => Object.fromEntries(m);
  const keys = (m) => [...m.keys()];

  /** doc with page root > free section > nodes. Returns helpers. */
  function setup() {
    const doc = schema.createDocument();
    const root = doc.nodes[doc.pages[0].root];
    const section = doc.nodes[root.children[0]];
    const add = (type, init, parent) => {
      const p = parent || section;
      const n = schema.createNode(type, Object.assign({ parent: p.id }, init));
      doc.nodes[n.id] = n;
      p.children.push(n.id);
      return n;
    };
    return { doc, root, section, add };
  }

  const freeParent = { type: 'frame', layout: { mode: 'free' } };
  const stack = (dir, align) => ({ type: 'frame', layout: { mode: 'stack', dir: dir || 'column', align: align || 'start', gap: 0, pad: [0, 0, 0, 0] } });
  const leaf = (init) => Object.assign({ type: 'text', x: 10, y: 20, w: 200, h: 50, rotation: 0, sizing: { w: 'fixed', h: 'fixed' }, layout: null, style: {} }, init);

  test('free parent → absolute box; fill → left:0;width:100%; hug → auto; rotation', () => {
    assert.deepEqual(obj(style.boxDecls(leaf(), freeParent)), { position: 'absolute', left: '10px', top: '20px', width: '200px', height: '50px' });
    assert.deepEqual(obj(style.boxDecls(leaf({ sizing: { w: 'fill', h: 'hug' } }), freeParent)),
      { position: 'absolute', left: '0', top: '20px', width: '100%', height: 'auto' });
    assert.deepEqual(obj(style.boxDecls(leaf({ sizing: { w: 'hug', h: 'fill' } }), freeParent)),
      { position: 'absolute', left: '10px', top: '0', width: 'auto', height: '100%' });
    assert.equal(style.boxDecls(leaf({ rotation: 15 }), freeParent).get('transform'), 'rotate(15deg)');
    assert.equal(style.boxDecls(leaf({ rotation: -7.5 }), freeParent).get('transform'), 'rotate(-7.5deg)');
    assert.equal(style.boxDecls(leaf({ rotation: 360 }), freeParent).has('transform'), false);
    assert.equal(style.boxDecls(leaf({ x: 0.33333, y: -4 }), freeParent).get('left'), '0.333px');
  });

  test('stack parent → relative flex item; fixed/fill/hug on main and cross axis', () => {
    assert.deepEqual(obj(style.boxDecls(leaf(), stack('column'))),
      { position: 'relative', width: '200px', height: '50px', 'flex-shrink': '0' });
    const fillMain = style.boxDecls(leaf({ sizing: { w: 'fixed', h: 'fill' } }), stack('column'));
    assert.deepEqual(obj(fillMain), { position: 'relative', width: '200px', 'min-height': '0', flex: '1 1 0' });
    const fillCross = style.boxDecls(leaf({ sizing: { w: 'fill', h: 'fixed' } }), stack('column'));
    assert.deepEqual(obj(fillCross), { position: 'relative', height: '50px', 'flex-shrink': '0', 'align-self': 'stretch' });
    const row = style.boxDecls(leaf({ sizing: { w: 'fill', h: 'fill' } }), stack('row'));
    assert.deepEqual(obj(row), { position: 'relative', 'min-width': '0', flex: '1 1 0', 'align-self': 'stretch' });
    const hug = style.boxDecls(leaf({ sizing: { w: 'hug', h: 'hug' } }), stack('row'));
    assert.equal(hug.get('width'), 'auto');
    assert.equal(hug.get('height'), 'auto');
    assert.equal(style.boxDecls(leaf({ sizing: { w: 'hug', h: 'fixed' } }), stack('column', 'stretch')).get('width'), 'fit-content',
      'hug on the cross axis of a stretching stack keeps content size');
    assert.equal(style.boxDecls(leaf({ rotation: 90 }), stack()).get('transform'), 'rotate(90deg)');
    assert.equal(style.boxDecls(leaf(), stack()).has('left'), false, 'x/y ignored in stack parents');
  });

  test('page root: bp width in the editor, 100% / 100vh in exports', () => {
    const { doc, root } = setup();
    assert.deepEqual(obj(style.boxDecls(root, null, { mode: 'editor', bp: { id: 'tablet', width: 768 } })),
      { position: 'relative', width: '768px', 'min-height': '900px' });
    assert.deepEqual(obj(style.boxDecls(root, null, { mode: 'export' })), { position: 'relative', width: '100%', 'min-height': '100vh' });
    const tablet = style.nodeDecls(doc, root, 'tablet', { mode: 'editor' });
    assert.equal(tablet.get('width'), '768px');
    assert.equal(tablet.get('display'), 'flex');
    assert.equal(tablet.get('background-color'), '#ffffff');
    assert.equal(style.nodeDecls(doc, root.id, 'desktop', { mode: 'editor' }).get('width'), '1440px');
    const standalone = style.boxDecls(leaf(), null);
    assert.deepEqual(obj(standalone), { position: 'relative', width: '200px', height: '50px' });
  });

  test('layoutDecls: stack → flexbox, free → nothing', () => {
    const l = { layout: { mode: 'stack', dir: 'row', gap: 12, pad: [8, 16, 8, 16], align: 'center', justify: 'between', wrap: true } };
    assert.deepEqual(obj(style.layoutDecls(l)), {
      display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', gap: '12px', padding: '8px 16px 8px 16px',
      'align-items': 'center', 'justify-content': 'space-between'
    });
    assert.deepEqual(obj(style.layoutDecls({ layout: { mode: 'stack', dir: 'column', gap: 0, pad: [4, 4, 4, 4], align: 'end', justify: 'around' } })),
      { display: 'flex', 'flex-direction': 'column', padding: '4px', 'align-items': 'flex-end', 'justify-content': 'space-around' });
    assert.equal(style.layoutDecls({ layout: { mode: 'free' } }).size, 0);
    assert.equal(style.layoutDecls({ layout: null }).size, 0);
  });

  test('visualDecls: tokens, fill, gradients, fill images, borders, radius, padding, effects', () => {
    const { doc } = setup();
    doc.assets.as_pic00001 = { id: 'as_pic00001', kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' };
    doc.assets.as_svg00001 = { id: 'as_svg00001', kind: 'image', src: 'data:image/svg+xml,<svg onload=alert(1)>' };
    const v = (s, extra) => obj(style.visualDecls(Object.assign({ type: 'text', layout: null, style: s }, extra), doc));
    assert.deepEqual(v({ fill: '$primary', color: '$text-main' }), { 'background-color': 'var(--t-primary)', color: 'var(--t-text-main)' });
    assert.deepEqual(v({ fill: 'linear-gradient(90deg, $primary, #fff)' }), { 'background-image': 'linear-gradient(90deg, var(--t-primary), #fff)' });
    assert.deepEqual(v({ fill: '#000', fillImage: { asset: 'as_pic00001', size: 'contain', position: 'top left', repeat: false } }), {
      'background-color': '#000', 'background-image': 'url("data:image/png;base64,iVBORw0KGgo=")',
      'background-size': 'contain', 'background-position': 'top left', 'background-repeat': 'no-repeat'
    });
    assert.equal(v({ fillImage: { asset: 'as_svg00001' } })['background-image'], undefined, 'svg data URLs are refused');
    assert.equal(v({ fillImage: { src: 'javascript:alert(1)' } })['background-image'], undefined);
    assert.equal(v({ fillImage: { src: 'x.png")' + ';background:url(javascript:alert(1))' } })['background-image'], undefined);
    assert.equal(v({ fillImage: { src: 'https://img.example/a.jpg' } })['background-size'], 'cover');
    const layered = v({ fill: 'linear-gradient(#000, #fff)', fillImage: { src: '/a.png', repeat: true } });
    assert.equal(layered['background-image'], 'url("/a.png"), linear-gradient(#000, #fff)');
    assert.equal(layered['background-repeat'], 'repeat, no-repeat');
    assert.deepEqual(v({ radius: [8, 8, 0, 0], padding: [12, 20, 12, 20] }), { padding: '12px 20px 12px 20px', 'border-radius': '8px 8px 0 0' });
    assert.deepEqual(v({ radius: 6, padding: 10 }), { padding: '10px', 'border-radius': '6px' });
    assert.equal(v({ padding: [4, 4, 4, 4] }, { layout: { mode: 'free' } }).padding, undefined, 'containers pad through layout');
    assert.deepEqual(v({ borderWidth: 2, borderColor: '$line' }), { 'border-width': '2px', 'border-style': 'solid', 'border-color': 'var(--t-line)' });
    assert.deepEqual(v({ borderWidth: 1, borderStyle: 'dashed' }), { 'border-width': '1px', 'border-style': 'dashed' });
    assert.deepEqual(v({ borderWidth: 0, borderColor: '#000' }), {});
    assert.deepEqual(v({ opacity: 1, blur: 0 }), {});
    assert.deepEqual(v({ opacity: 0.5, blur: 4, backdropBlur: 10, blend: 'multiply', overflow: 'hidden', cursor: 'pointer' }), {
      opacity: '0.5', filter: 'blur(4px)', '-webkit-backdrop-filter': 'blur(10px)', 'backdrop-filter': 'blur(10px)',
      'mix-blend-mode': 'multiply', overflow: 'hidden', cursor: 'pointer'
    });
    assert.deepEqual(v({ shadow: '0 4px 12px rgba(0,0,0,0.2)', textShadow: '0 1px 0 $ink' }),
      { 'text-shadow': '0 1px 0 var(--t-ink)', 'box-shadow': '0 4px 12px rgba(0,0,0,0.2)' });
    assert.deepEqual(v({ valign: 'middle' }), { display: 'flex', 'flex-direction': 'column', 'justify-content': 'center' });
    assert.deepEqual(v({ valign: 'top' }), {});
    assert.deepEqual(v({ objectFit: 'cover', objectPosition: '50% 20%' }), { 'object-fit': 'cover', 'object-position': '50% 20%' });
  });

  test('visualDecls rejects injection attempts', () => {
    const { doc } = setup();
    const v = (s) => obj(style.visualDecls({ type: 'text', layout: null, style: s }, doc));
    assert.deepEqual(v({ color: 'red; position: fixed' }), {});
    assert.deepEqual(v({ fill: 'url(javascript:alert(1))' }), {});
    assert.deepEqual(v({ fill: 'expression(alert(1))' }), {});
    assert.deepEqual(v({ shadow: '0 0 0 red} body{display:none' }), {});
    assert.deepEqual(v({ fontFamily: 'Inter</style><script>' }), {});
    assert.deepEqual(v({ textAlign: 'center;x', fontStyle: 'bogus', blend: 'evil', overflow: 'x', cursor: 'url(x)' }), {});
    assert.deepEqual(v({ fontFamily: '"Inter", system-ui, sans-serif', fontWeight: 700, fontSize: 18.5, letterSpacing: -0.5 }), {
      'font-family': '"Inter", system-ui, sans-serif', 'font-size': '18.5px', 'font-weight': '700', 'letter-spacing': '-0.5px'
    });
    assert.deepEqual(v({ fontWeight: 5000 }), {});
  });

  test('textStyle token merges under the node style; styleOmit drops shape fills', () => {
    const { doc, add } = setup();
    doc.tokens.text.push({ id: 'h1', name: 'Heading 1', style: { fontSize: 56, fontWeight: 800, lineHeight: 1.1, color: '#000' } });
    const node = add('text');
    node.style = { textStyle: 'h1', color: '#333' };
    const d = style.visualDecls(node, doc);
    assert.equal(d.get('font-size'), '56px');
    assert.equal(d.get('font-weight'), '800');
    assert.equal(d.get('line-height'), '1.1');
    assert.equal(d.get('color'), '#333', 'own style wins over the token');
    assert.equal(style.visualDecls({ type: 'text', layout: null, style: { textStyle: 'missing' } }, doc).size, 0);
    const star = add('shape', { props: { shape: 'star' }, style: { fill: '#f00', radius: 4, shadow: '0 1px 2px #000' } });
    const sd = style.visualDecls(star, doc);
    assert.equal(sd.has('background-color'), false);
    assert.equal(sd.has('border-radius'), false);
    assert.equal(sd.get('box-shadow'), '0 1px 2px #000');
  });

  test('nodeDecls: order, cascade, extras, custom css, hidden', () => {
    const { doc, add, section } = setup();
    const btn = add('button', {
      x: 40, y: 60, css: 'letter-spacing: 1px; behavior: url(x.htc); color: expression(alert(1))',
      bp: { tablet: { x: 0, sizing: { w: 'fill' }, style: { fill: '$accent' } }, mobile: { hidden: true } }
    });
    const d = style.nodeDecls(doc, btn, 'desktop', { mode: 'export', extra: { display: 'inline-flex', alignItems: 'center', fontFamily: 'inherit' } });
    assert.deepEqual(keys(d), ['position', 'left', 'top', 'width', 'height', 'display', 'align-items', 'font-family',
      'background-color', 'color', 'font-size', 'font-weight', 'line-height', 'text-align', 'padding', 'border-radius', 'letter-spacing']);
    assert.equal(d.get('letter-spacing'), '1px');
    assert.equal(d.get('left'), '40px');
    const tab = style.nodeDecls(doc, btn, 'tablet', { mode: 'export' });
    assert.equal(tab.get('left'), '0');
    assert.equal(tab.get('width'), '100%');
    assert.equal(tab.get('background-color'), 'var(--t-accent)');
    assert.equal(tab.has('display'), false);
    const mob = style.nodeDecls(doc, btn, 'mobile', { mode: 'export' });
    assert.equal(mob.get('display'), 'none', 'hidden wins over everything');
    assert.equal(keys(mob).pop(), 'display');
    const hiddenStack = add('frame', { hidden: true, layout: { mode: 'stack' }, css: 'display: grid' });
    assert.equal(style.nodeDecls(doc, hiddenStack, 'desktop').get('display'), 'none');
    // parentEff defaults to the effective parent: section is free.
    assert.equal(style.nodeDecls(doc, btn.id, 'desktop').get('position'), 'absolute');
    // explicit parentEff / effective:true
    const eff = Object.assign({}, btn, { bp: {} });
    assert.equal(style.nodeDecls(doc, eff, 'tablet', { effective: true, parentEff: stack('row') }).get('position'), 'relative');
    assert.equal(style.nodeDecls(doc, eff, 'desktop', { box: false }).has('position'), false);
    // section inside the stack page root
    const sd = style.nodeDecls(doc, section, 'desktop', { mode: 'export' });
    assert.deepEqual(keys(sd).slice(0, 4), ['position', 'height', 'flex-shrink', 'align-self']);
  });

  test('hoverDecls composes rotation with the hover transform', () => {
    const { doc } = setup();
    const node = { type: 'button', layout: null, rotation: 10, style: { fill: '#000' },
      states: { hover: { style: { fill: '$primary', shadow: '0 8px 24px rgba(0,0,0,.2)', transform: 'scale(1.05)' } } } };
    assert.deepEqual(obj(style.hoverDecls(node, doc)), {
      'background-color': 'var(--t-primary)', 'box-shadow': '0 8px 24px rgba(0,0,0,.2)', transform: 'rotate(10deg) scale(1.05)'
    });
    assert.equal(style.hoverDecls({ type: 'text', style: {} }, doc).size, 0);
    assert.equal(style.hoverDecls({ type: 'text', states: { hover: { style: { transform: 'url(javascript:1)' } } } }, doc).size, 0);
  });

  test('tokensCSS', () => {
    const doc = schema.createDocument();
    assert.equal(style.tokensCSS(doc), '');
    doc.tokens.colors.push({ id: 'primary', name: 'Primary', value: '#2563eb' });
    doc.tokens.colors.push({ id: 'accent', name: 'Accent', value: '$primary' });
    doc.tokens.colors.push({ id: 'bad id', name: 'Bad', value: '#000' });
    doc.tokens.colors.push({ id: 'evil', name: 'Evil', value: 'red;}body{display:none' });
    assert.equal(style.tokensCSS(doc), ':root{--t-primary:#2563eb;--t-accent:var(--t-primary)}');
  });

  test('declsToString, declsToObject, parseDecls', () => {
    const m = new Map([['position', 'absolute'], ['left', '0'], ['-webkit-backdrop-filter', 'blur(2px)'], ['--u', '1px']]);
    assert.equal(style.declsToString(m), 'position: absolute; left: 0; -webkit-backdrop-filter: blur(2px); --u: 1px');
    assert.equal(style.declsToString({ color: 'red' }, { sep: ';' }), 'color: red');
    assert.deepEqual(style.declsToObject(m), { position: 'absolute', left: '0', WebkitBackdropFilter: 'blur(2px)', '--u': '1px' });
    assert.deepEqual(style.declsToObject(m, { camel: false })['-webkit-backdrop-filter'], 'blur(2px)');
    assert.deepEqual(obj(style.parseDecls('color: red; background: url("a;b.png"); x: expression(1)')),
      { color: 'red', background: 'url("a;b.png")' });
  });

  test('diffDecls: changed/added after removed resets', () => {
    const base = new Map([['position', 'absolute'], ['flex', '1 1 0'], ['color', '#000'], ['display', 'none'], ['width', '10px']]);
    const next = new Map([['position', 'relative'], ['flex-shrink', '0'], ['width', '10px']]);
    const diff = style.diffDecls(base, next);
    assert.deepEqual([...diff.entries()], [
      ['flex', 'initial'], ['color', 'unset'], ['display', 'revert'],
      ['position', 'relative'], ['flex-shrink', '0']
    ]);
    assert.equal(style.diffDecls(base, base).size, 0);
    assert.deepEqual(obj(style.diffDecls({}, { left: '1px' })), { left: '1px' });
  });

  test('diffDecls over real breakpoint cascades only emits changes', () => {
    const { doc, add } = setup();
    const txt = add('text', { x: 100, style: { fontSize: 48 }, bp: { mobile: { x: 16, style: { fontSize: 32 } } } });
    const diff = style.diffDecls(style.nodeDecls(doc, txt, 'desktop'), style.nodeDecls(doc, txt, 'mobile'));
    assert.deepEqual(obj(diff), { left: '16px', 'font-size': '32px' });
    assert.equal(style.diffDecls(style.nodeDecls(doc, txt, 'desktop'), style.nodeDecls(doc, txt, 'tablet')).size, 0);
  });

  test('designUnitDecls / designUnitVars for the exporters\' scale strategy', () => {
    const d = new Map([['position', 'absolute'], ['left', '120px'], ['top', '0'], ['width', '320px'], ['padding', '12px 20px'], ['box-shadow', '0 4px 8px #000'], ['font-size', '18px']]);
    assert.deepEqual(obj(style.designUnitDecls(d, { designWidth: 1440 })), {
      position: 'absolute', left: 'calc(120 * var(--u))', top: '0', width: 'calc(320 * var(--u))',
      padding: 'calc(12 * var(--u)) calc(20 * var(--u))', 'box-shadow': '0 4px 8px #000', 'font-size': 'calc(18 * var(--u))'
    });
    assert.equal(style.designUnitDecls(d, { designWidth: 1440, centerLeft: true }).get('left'),
      'calc(max(0px, (100cqw - 1440px) / 2) + 120 * var(--u))');
    assert.deepEqual(obj(style.designUnitVars(1200)), { 'container-type': 'inline-size', '--u': 'min(1px, calc(100cqw / 1200))' });
  });

  test('effective === schema.effectiveNode and cssValue helpers', () => {
    const { doc, add } = setup();
    const n = add('text', { bp: { tablet: { x: 5 } } });
    assert.equal(style.effective(doc, n.id, 'tablet'), schema.effectiveNode(doc, n.id, 'tablet'));
    assert.equal(style.cssValue('$primary'), 'var(--t-primary)');
    assert.equal(style.cssValue(12), '12');
    assert.equal(style.cssValue('calc(100% - 10px)'), 'calc(100% - 10px)');
    assert.equal(style.cssValue('red;color:blue'), '');
    assert.equal(style.px(0), '0');
    assert.equal(style.px(-0.0001), '0');
  });
}

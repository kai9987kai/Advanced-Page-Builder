// vdom — toHTML escaping, buildTree, instance expansion (§6.9.1)
export default function (APB, t) {
  const { test, assert } = t;
  const vdom = APB.require('vdom');
  const schema = APB.require('schema');

  function setup() {
    const doc = schema.createDocument();
    const root = doc.nodes[doc.pages[0].root];
    const section = doc.nodes[root.children[0]];
    const add = (type, init, parent) => {
      const p = parent || section;
      const n = schema.createNode(type, Object.assign({}, init, { parent: p ? p.id : null }));
      doc.nodes[n.id] = n;
      if (p) p.children.push(n.id);
      return n;
    };
    return { doc, root, section, add };
  }

  /** Adds a component whose master is a frame > [title text, image]. */
  function withComponent(ctx) {
    const { doc, add } = ctx;
    const master = add('frame', { name: 'Card', w: 300, h: 200, layout: { mode: 'stack', dir: 'column', gap: 8 }, style: { fill: '#eeeeee' } }, null);
    master.parent = null;
    const title = add('text', { props: { text: 'Master title' }, bp: { mobile: { props: { text: 'Mobile title' } } } }, master);
    const img = add('image', { props: { alt: 'Master alt' } }, master);
    doc.components.cp_card0001 = { id: 'cp_card0001', name: 'Card', root: master.id };
    return { master, title, img };
  }

  const find = (v, pred) => {
    if (!v || typeof v !== 'object') return null;
    if (pred(v)) return v;
    for (const c of v.children || []) { const hit = find(c, pred); if (hit) return hit; }
    return null;
  };
  const byId = (v, id) => find(v, (n) => n.attrs && n.attrs['data-node-id'] === id);

  /* ------------------------------------------------------------ toHTML */

  test('toHTML escapes text and attribute values', () => {
    const html = vdom.toHTML({ tag: 'p', attrs: { title: '"><script>alert(1)</script>', 'data-x': "it's & <ok>" }, text: '<script>alert("x")</script> & more' });
    assert.equal(html, '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" data-x="it&#39;s &amp; &lt;ok&gt;">' +
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more</p>');
    assert.ok(!vdom.toHTML({ tag: 'div', children: ['<img src=x onerror=alert(1)>'] }).includes('<img'));
  });

  test('toHTML drops event handlers, dangerous URLs and banned tags', () => {
    const out = vdom.toHTML({ tag: 'a', attrs: { href: 'javascript:alert(1)', onclick: 'alert(1)', ONMOUSEOVER: 'x', srcdoc: '<b>', 'bad name': '1', 'x"y': '1' }, text: 'x' });
    assert.equal(out, '<a>x</a>');
    assert.equal(vdom.toHTML({ tag: 'a', attrs: { href: ' java\tscript:alert(1)' }, text: 'x' }), '<a>x</a>');
    assert.equal(vdom.toHTML({ tag: 'a', attrs: { href: 'JaVaScRiPt:alert(1)' }, text: 'x' }), '<a>x</a>');
    assert.equal(vdom.toHTML({ tag: 'a', attrs: { href: 'data:text/html,<script>alert(1)</script>' }, text: 'x' }), '<a>x</a>');
    assert.equal(vdom.toHTML({ tag: 'a', attrs: { href: 'data:image/svg+xml,<svg>' }, text: 'x' }), '<a>x</a>');
    assert.equal(vdom.toHTML({ tag: 'img', attrs: { src: 'data:image/svg+xml,%3Csvg%3E' } }), '<img src="data:image/svg+xml,%3Csvg%3E">');
    assert.equal(vdom.toHTML({ tag: 'iframe', attrs: { src: 'data:image/svg+xml,x' } }), '<iframe></iframe>');
    assert.equal(vdom.toHTML({ tag: 'img', attrs: { src: 'data:image/png;base64,AAAA', srcset: 'a.png 1x, javascript:alert(1) 2x' } }), '<img src="data:image/png;base64,AAAA">');
    assert.equal(vdom.toHTML({ tag: 'a', attrs: { href: 'https://example.com/?q=1&b="2"' }, text: 'ok' }), '<a href="https://example.com/?q=1&amp;b=&quot;2&quot;">ok</a>');
    assert.equal(vdom.toHTML({ tag: 'script', text: 'alert(1)' }), '<div>alert(1)</div>');
    assert.equal(vdom.toHTML({ tag: 'STYLE', text: 'x' }), '<div>x</div>');
    assert.equal(vdom.toHTML({ tag: 'img onerror=alert(1)' }), '<div></div>');
    assert.equal(vdom.toHTML({ tag: 'svg', children: [{ tag: 'foreignObject', children: [{ tag: 'script' }] }] }, { pretty: false }), '<svg><g><g></g></g></svg>');
  });

  test('toHTML: void elements, boolean attrs, style objects, svg case, pretty printing', () => {
    assert.equal(vdom.toHTML({ tag: 'img', attrs: { src: '/a.png', alt: '', hidden: true, draggable: false, width: 10 } }), '<img src="/a.png" alt="" hidden width="10">');
    assert.equal(vdom.toHTML({ tag: 'hr' }), '<hr>');
    assert.equal(vdom.toHTML({ tag: 'input', attrs: { required: true, class: ['a', 'b'] } }), '<input required class="a b">');
    assert.equal(vdom.toHTML({ tag: 'div', style: { backgroundColor: 'var(--t-primary)', WebkitBackdropFilter: 'blur(2px)', '--u': '1px', color: 'red;position:fixed', backgroundImage: 'url(javascript:alert(1))' } }),
      '<div style="background-color: var(--t-primary); -webkit-backdrop-filter: blur(2px); --u: 1px"></div>');
    assert.equal(vdom.toHTML({ tag: 'div', attrs: { style: 'color: red; behavior: url(x)' }, style: { margin: '0' } }), '<div style="color: red; margin: 0"></div>');
    assert.equal(vdom.toHTML({ tag: 'svg', attrs: { viewBox: '0 0 10 10' }, children: [{ tag: 'polygon', attrs: { points: '0,0 10,0 5,10' } }] }, { pretty: false }),
      '<svg viewBox="0 0 10 10"><polygon points="0,0 10,0 5,10"></polygon></svg>');
    assert.equal(vdom.toHTML({ tag: 'ul', children: [{ tag: 'li', text: 'a' }, { tag: 'li', text: 'b' }] }), '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>');
    assert.equal(vdom.toHTML({ tag: 'ul', children: [{ tag: 'li', text: 'a' }] }, { indent: 4 }), '<ul>\n    <li>a</li>\n</ul>');
    assert.equal(vdom.toHTML({ tag: 'ul', children: [{ tag: 'li', text: 'a' }] }, { pretty: false }), '<ul><li>a</li></ul>');
    assert.equal(vdom.toHTML({ tag: 'p', children: [{ tag: 'a', attrs: { href: '/x' }, text: 'x' }] }), '<p><a href="/x">x</a></p>', 'inline children stay inline');
    assert.equal(vdom.toHTML({ tag: 'div', html: '<b>pre-sanitized</b>' }), '<div><b>pre-sanitized</b></div>');
    assert.equal(vdom.toHTML([{ tag: 'b', text: '1' }, { tag: 'i', text: '2' }], { pretty: false }), '<b>1</b><i>2</i>');
    assert.equal(vdom.toHTML(null), '');
  });

  test('toDOM and patch are no-ops without a DOM', () => {
    assert.equal(vdom.toDOM({ tag: 'div' }), null);
    assert.equal(vdom.patch(null, { tag: 'div' }), null);
  });

  /* --------------------------------------------------------- buildTree */

  test('buildTree on createDocument() output — export with classFor', () => {
    const { doc, root, section } = setup();
    const seen = [];
    const tree = vdom.buildTree(doc, root.id, { classFor: (n) => 'n-' + n.id.slice(2), onNode: (info) => seen.push(info) });
    assert.equal(tree.tag, 'div');
    assert.equal(tree.attrs.class, 'n-' + root.id.slice(2));
    assert.equal(tree.attrs['data-node-id'], undefined, 'no editor ids in exports');
    assert.equal(tree.style, undefined, 'export with classFor emits no inline styles');
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].tag, 'section');
    assert.equal(tree.children[0].attrs.class, 'n-' + section.id.slice(2));
    assert.deepEqual(seen.map((s) => s.id), [section.id, root.id], 'onNode reports children before their parent');
    const rootInfo = seen[1];
    assert.equal(rootInfo.decls.get('width'), '100%');
    assert.equal(rootInfo.decls.get('min-height'), '100vh');
    assert.equal(rootInfo.decls.get('display'), 'flex');
    assert.equal(seen[0].decls.get('height'), '900px');
    assert.equal(seen[0].parentEff.id, root.id);
    assert.equal(vdom.toHTML(tree), '<div class="n-' + root.id.slice(2) + '">\n  <section class="n-' + section.id.slice(2) + '"></section>\n</div>');
    assert.equal(vdom.buildTree(doc, 'n_missing0'), null);
  });

  test('buildTree editor mode: apb-node, data-node-id, inline styles, breakpoint width', () => {
    const { doc, root, section, add } = setup();
    const txt = add('text', { x: 24, y: 32, props: { text: 'Hello' }, bp: { tablet: { x: 8, props: { text: 'Hi tablet' } } } });
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor' });
    assert.equal(tree.attrs.class, 'apb-node');
    assert.equal(tree.attrs['data-node-id'], root.id);
    assert.equal(tree.style.width, '1440px');
    assert.equal(tree.style.minHeight, '900px');
    const s = byId(tree, section.id);
    assert.equal(s.style.alignSelf, 'stretch');
    const t1 = byId(tree, txt.id);
    assert.equal(t1.text, 'Hello');
    assert.equal(t1.style.left, '24px');
    assert.equal(t1.style.position, 'absolute');
    assert.equal(t1.style.margin, '0', 'type extras merged into inline style');
    const tab = vdom.buildTree(doc, root.id, { mode: 'editor', bp: 'tablet' });
    assert.equal(tab.style.width, '768px');
    assert.equal(byId(tab, txt.id).text, 'Hi tablet');
    assert.equal(byId(tab, txt.id).style.left, '8px');
    const html = vdom.toHTML(tab);
    assert.match(html, /data-node-id="[^"]+" style="position: relative; width: 768px; min-height: 900px; display: flex/);
    const sub = vdom.buildTree(doc, txt.id, { mode: 'export' });
    assert.equal(sub.style.position, 'absolute', 'export without classFor falls back to inline styles');
    assert.equal(vdom.buildTree(doc, txt.id, { mode: 'export', parentEff: null }).style.position, 'relative');
  });

  test('buildTree: hidden nodes, node attrs, text escaping, html sanitizer hook', () => {
    const { doc, root, add } = setup();
    const hidden = add('text', { hidden: true, props: { text: 'secret' } });
    const mobileOnly = add('button', { bp: { mobile: { hidden: true } } });
    const attrs = add('frame', { attrs: { htmlId: 'Hero title', className: 'card apb-evil featured', ariaLabel: ' Hero ', role: 'region', title: 'T' } });
    const evil = add('text', { props: { text: '</p><script>alert(1)</script>' } });
    const custom = add('html', { props: { html: '<img src=x onerror=alert(1)>' } });
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor', sanitizeHTML: (h, p) => '[' + p + ']' });
    assert.equal(byId(tree, hidden.id), null, 'hidden nodes are skipped by default');
    assert.ok(byId(tree, mobileOnly.id));
    assert.equal(byId(vdom.buildTree(doc, root.id, { mode: 'editor', bp: 'mobile' }), mobileOnly.id), null);
    const withHidden = vdom.buildTree(doc, root.id, { mode: 'editor', includeHidden: true });
    assert.equal(byId(withHidden, hidden.id).style.display, 'none');
    const a = byId(tree, attrs.id);
    assert.equal(a.attrs.id, 'Hero-title');
    assert.equal(a.attrs.class, 'apb-node card featured');
    assert.equal(a.attrs['aria-label'], 'Hero');
    assert.equal(a.attrs.role, 'region');
    assert.equal(a.attrs.title, 'T');
    assert.equal(byId(tree, custom.id).html, '[html]');
    const html = vdom.toHTML(vdom.buildTree(doc, root.id, { classFor: () => 'x' }));
    assert.ok(html.includes('&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'), 'Node fallback sanitizer escapes html content');
    assert.equal(byId(tree, evil.id).tag, 'p');
  });

  test('buildTree: stack containers put children into the slot and pass parentEff', () => {
    const { doc, root, add } = setup();
    const row = add('frame', { layout: { mode: 'stack', dir: 'row', gap: 12, align: 'center' }, sizing: { w: 'fill', h: 'hug' } });
    const a = add('button', { sizing: { w: 'fill', h: 'fixed' } }, row);
    const link = add('frame', { props: { href: '/about' } });
    const inner = add('text', {}, link);
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor' });
    const r = byId(tree, row.id);
    assert.equal(r.style.display, 'flex');
    assert.equal(r.style.flexDirection, 'row');
    assert.equal(r.style.gap, '12px');
    assert.equal(r.style.left, '0');
    assert.equal(r.style.height, 'auto');
    assert.equal(r.slot, true);
    const b = byId(r, a.id);
    assert.equal(b.style.position, 'relative');
    assert.equal(b.style.flex, '1 1 0');
    assert.equal(b.style.minWidth, '0');
    const l = byId(tree, link.id);
    assert.equal(l.tag, 'a');
    assert.equal(l.attrs['data-href'], '/about');
    assert.equal(l.children[0].attrs['data-node-id'], inner.id);
  });

  /* --------------------------------------------------------- instances */

  test('instance expansion with overrides; ids become instanceId:masterId', () => {
    const ctx = setup();
    const { doc, root, add } = ctx;
    const { master, title, img } = withComponent(ctx);
    const inst = add('instance', {
      x: 50, y: 60, w: 320, h: 220,
      props: { component: 'cp_card0001', overrides: { [title.id]: { props: { text: 'Overridden' }, style: { color: '#ff0000' } } } },
      attrs: { ariaLabel: 'Card' }
    });
    const plain = add('instance', { x: 400, props: { component: 'cp_card0001' } });
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor' });
    const iv = byId(tree, inst.id);
    assert.equal(iv.tag, 'div', 'root takes the master root type (frame)');
    assert.equal(iv.style.left, '50px', 'root takes the instance box');
    assert.equal(iv.style.width, '320px');
    assert.equal(iv.style.display, 'flex', 'master layout kept');
    assert.equal(iv.style.backgroundColor, '#eeeeee');
    assert.equal(iv.attrs['aria-label'], 'Card');
    const tv = byId(iv, inst.id + ':' + title.id);
    assert.ok(tv, 'inner ids are prefixed');
    assert.equal(tv.text, 'Overridden');
    assert.equal(tv.style.color, '#ff0000');
    assert.equal(tv.style.position, 'relative', 'inner nodes position against the master root');
    assert.ok(byId(iv, inst.id + ':' + img.id));
    assert.equal(byId(byId(tree, plain.id), plain.id + ':' + title.id).text, 'Master title');
    assert.equal(doc.nodes[title.id].props.text, 'Master title', 'master untouched');
    // breakpoint cascade still applies to the master, overrides win
    const mob = vdom.buildTree(doc, root.id, { mode: 'editor', bp: 'mobile' });
    assert.equal(byId(mob, plain.id + ':' + title.id).text, 'Mobile title');
    assert.equal(byId(mob, inst.id + ':' + title.id).text, 'Overridden');
    // exports: classFor receives virtual nodes, onNode reports them
    const virtual = [];
    const exp = vdom.buildTree(doc, root.id, { classFor: (n) => 'n-' + n.id.replace(/[^a-z0-9]/gi, '-'), onNode: (i) => { if (i.virtual) virtual.push(i.id); } });
    assert.ok(virtual.includes(inst.id + ':' + title.id));
    assert.ok(virtual.includes(inst.id));
    assert.ok(vdom.toHTML(exp).includes('>Overridden</p>'));
    assert.equal(master.parent, null);
  });

  test('expandInstance, nested instances, missing and cyclic components', () => {
    const ctx = setup();
    const { doc, root, add } = ctx;
    const { title } = withComponent(ctx);
    // component B wraps an instance of A
    const bRoot = add('frame', { name: 'Wrapper' }, null);
    bRoot.parent = null;
    const nested = add('instance', { props: { component: 'cp_card0001' } }, bRoot);
    doc.components.cp_wrap0001 = { id: 'cp_wrap0001', name: 'Wrapper', root: bRoot.id };
    const outer = add('instance', { props: { component: 'cp_wrap0001' } });
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor' });
    const deepId = outer.id + ':' + nested.id + ':' + title.id;
    assert.equal(byId(tree, deepId).text, 'Master title');

    const exp = vdom.expandInstance(doc, outer.id);
    assert.equal(exp.root, outer.id);
    assert.equal(exp.component, 'cp_wrap0001');
    assert.deepEqual(Object.keys(exp.nodes).sort(), [outer.id, outer.id + ':' + nested.id].sort());
    assert.equal(exp.nodes[outer.id].type, 'frame');
    assert.equal(exp.nodes[outer.id + ':' + nested.id].parent, outer.id);
    assert.equal(vdom.expandInstance(doc, title.id), null);

    const missing = add('instance', { props: { component: 'cp_nope0001' } });
    const mv = byId(vdom.buildTree(doc, root.id, { mode: 'editor' }), missing.id);
    assert.equal(mv.attrs['data-component-missing'], '');
    assert.equal(mv.style.position, 'absolute');

    // cycle: component C contains an instance of itself
    const cRoot = add('frame', {}, null);
    cRoot.parent = null;
    add('instance', { props: { component: 'cp_loop0001' } }, cRoot);
    doc.components.cp_loop0001 = { id: 'cp_loop0001', name: 'Loop', root: cRoot.id };
    const loop = add('instance', { props: { component: 'cp_loop0001' } });
    const lv = byId(vdom.buildTree(doc, root.id, { mode: 'editor' }), loop.id);
    assert.ok(lv, 'cyclic component renders once');
    assert.ok(find(lv, (n) => n.attrs && n.attrs['data-component-missing'] === ''), 'recursion stops with a placeholder');

    // hidden instance skipped
    const hid = add('instance', { hidden: true, props: { component: 'cp_card0001' } });
    assert.equal(byId(vdom.buildTree(doc, root.id, { mode: 'editor' }), hid.id), null);
  });

  test('instance overrides can hide, rename and resize master nodes', () => {
    const ctx = setup();
    const { doc, root, add } = ctx;
    const { title, img } = withComponent(ctx);
    const inst = add('instance', { props: { component: 'cp_card0001', overrides: {
      [img.id]: { hidden: true }, [title.id]: { sizing: { w: 'fill' }, name: 'Card title', attrs: { htmlId: 'card-title' } }
    } } });
    const tree = vdom.buildTree(doc, root.id, { mode: 'editor' });
    assert.equal(byId(tree, inst.id + ':' + img.id), null);
    const tv = byId(tree, inst.id + ':' + title.id);
    assert.equal(tv.style.alignSelf, 'stretch');
    assert.equal(tv.attrs.id, 'card-title');
    assert.equal(vdom.expandInstance(doc, inst).nodes[inst.id + ':' + title.id].name, 'Card title');
  });

  test('instance element type vnode returns the expansion without box declarations', () => {
    const ctx = setup();
    const { doc, add } = ctx;
    const { title } = withComponent(ctx);
    const inst = add('instance', { x: 10, props: { component: 'cp_card0001', overrides: { [title.id]: { props: { text: 'Via type' } } } } });
    const def = APB.require('elements').get('instance');
    const v = def.vnode(inst, { mode: 'editor', doc, bp: 'desktop', effective: inst });
    assert.equal(v.tag, 'div');
    assert.equal(v.style.position, undefined, 'renderer adds the instance box itself');
    assert.equal(v.style.display, 'flex');
    assert.equal(v.attrs['data-node-id'], undefined, 'root is left for the renderer to decorate');
    const tv = byId(v, inst.id + ':' + title.id);
    assert.equal(tv.text, 'Via type');
    assert.equal(tv.attrs.class, 'apb-node');
    assert.equal(vdom.instanceVNode(doc, schema.createNode('instance', { props: { component: 'cp_none' } }), {}), null);
  });
}

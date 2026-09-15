// elements registry + core element types (element-types.js)
export default function (APB, t) {
  const { test, assert } = t;
  const elements = APB.require('elements');
  const schema = APB.require('schema');
  const sanitize = APB.require('sanitize');

  const CORE = ['page', 'section', 'frame', 'group', 'text', 'button', 'image', 'shape', 'divider', 'spacer', 'list', 'table', 'html', 'instance'];

  function ctx(mode, extra) {
    return Object.assign({
      mode, doc: schema.createDocument(), bp: 'desktop',
      assetURL: (id) => (id === 'as_logo0001' ? 'data:image/png;base64,iVBORw0KGgo=' : ''),
      resolveURL: (u, k) => sanitize.url(u, k),
      sanitizeHTML: (h, p) => sanitize.html(h, p),
      escape: (s) => String(s),
      icon: () => null,
      cssValue: (v) => APB.require('style').cssValue(v)
    }, extra || {});
  }

  function vnodeOf(type, init, mode, extra) {
    const node = schema.createNode(type, init || {});
    const c = ctx(mode || 'export', extra);
    c.effective = node;
    return elements.get(type).vnode(node, c);
  }

  test('all core types are registered lazily on first query, in order', () => {
    const fresh = t.loadAPB().require('elements');
    assert.deepEqual(fresh.types(), CORE);
    for (const type of CORE) {
      const def = elements.get(type);
      assert.ok(def, type);
      assert.equal(def.type, type);
      assert.equal(typeof def.label, 'string');
      assert.equal(typeof def.vnode, 'function');
      assert.equal(typeof def.defaults, 'function');
      assert.ok(Object.isFrozen(def), 'normalized defs are frozen');
      for (const key of Object.keys(elements.DEFAULT_CAPS)) assert.equal(typeof def.caps[key], 'boolean', type + ' caps.' + key);
      assert.ok(Array.isArray(def.bpProps));
      assert.ok(Array.isArray(def.inspector));
      assert.ok(elements.CATEGORIES.includes(def.category));
    }
    assert.equal(elements.get('nope'), null);
    assert.equal(elements.has('text'), true);
    assert.equal(elements.has('nope'), false);
  });

  test('container flags, caps, textEdit and bpProps follow the brief', () => {
    for (const type of ['page', 'section', 'frame', 'group']) assert.equal(elements.get(type).container, true, type);
    for (const type of ['text', 'button', 'image', 'shape', 'divider', 'spacer', 'list', 'table', 'html', 'instance']) {
      assert.equal(elements.get(type).container, false, type);
    }
    assert.equal(elements.get('text').textEdit, 'text');
    assert.equal(elements.get('button').textEdit, 'text');
    assert.equal(elements.get('image').textEdit, null);
    assert.ok(elements.get('text').bpProps.includes('text'));
    assert.ok(elements.get('button').bpProps.includes('text'));
    const group = elements.get('group').caps;
    assert.equal(group.fill || group.border || group.radius || group.shadow, false, 'group has no visual style caps');
    assert.equal(elements.get('text').caps.text, true);
    assert.equal(elements.get('section').caps.layout, true);
    assert.equal(elements.get('text').caps.layout, false);
    assert.deepEqual(elements.list({ category: 'media' }).map((d) => d.type), ['image']);
    const insertable = elements.list({ insertable: true }).map((d) => d.type);
    assert.ok(!insertable.includes('page') && !insertable.includes('instance') && insertable.includes('text'));
  });

  test('register validates definitions and merges default caps', () => {
    const reg = t.loadAPB().require('elements');
    const base = { type: 'badge', label: 'Badge', vnode: () => ({ tag: 'span' }), defaults: () => ({ w: 80, h: 24 }) };
    assert.throws(() => reg.register(null), /definition must be an object/);
    assert.throws(() => reg.register(Object.assign({}, base, { type: 'Bad Type' })), /type/);
    assert.throws(() => reg.register(Object.assign({}, base, { label: '' })), /label/);
    assert.throws(() => reg.register(Object.assign({}, base, { vnode: 'x' })), /vnode/);
    assert.throws(() => reg.register(Object.assign({}, base, { defaults: undefined })), /defaults/);
    assert.throws(() => reg.register(Object.assign({}, base, { category: 'weird' })), /category/);
    assert.throws(() => reg.register(Object.assign({}, base, { bpProps: 'text' })), /bpProps/);
    assert.throws(() => reg.register(Object.assign({}, base, { inspector: [{ fields: [{ key: 'props.x', type: 'slider' }] }] })), /unknown type/);
    const def = reg.register(Object.assign({}, base, { caps: { text: true, shadow: false }, bpProps: ['text'] }));
    assert.equal(def.category, 'basic');
    assert.equal(def.icon, 'badge');
    assert.equal(def.caps.text, true);
    assert.equal(def.caps.shadow, false);
    assert.equal(def.caps.fill, true, 'default caps merged');
    assert.equal(def.insertable, true);
    assert.throws(() => reg.register(base), /already registered/);
    const replaced = reg.register(Object.assign({}, base, { label: 'Pill', replace: true }));
    assert.equal(reg.get('badge').label, 'Pill');
    assert.equal(replaced.replace, undefined);
    assert.ok(reg.types().includes('badge'));
    assert.equal(reg.unregister('badge'), true);
    assert.equal(reg.get('badge'), null);
  });

  test('schema.createNode picks up registered defaults', () => {
    const button = schema.createNode('button', { props: { text: 'Buy' } });
    assert.equal(button.name, 'Button');
    assert.equal(button.w, 160);
    assert.equal(button.style.fill, '#2563eb');
    assert.equal(button.style.color, '#ffffff');
    assert.equal(button.style.radius, 10);
    assert.deepEqual(button.style.padding, [12, 20, 12, 20]);
    assert.equal(button.props.text, 'Buy');
    assert.equal(button.props.kind, 'button');
    assert.equal(button.children, undefined);
    const image = schema.createNode('image');
    assert.equal(image.style.objectFit, 'cover');
    assert.equal(image.props.loading, 'lazy');
    assert.equal(image.props.decorative, false);
    const section = schema.createNode('section');
    assert.equal(section.sizing.w, 'fill');
    assert.equal(section.h, 640);
    assert.equal(section.layout.mode, 'free');
    assert.deepEqual(section.children, []);
    const text = schema.createNode('text');
    assert.deepEqual(text.style, { fontSize: 18, lineHeight: 1.5, color: '#111827' });
    assert.equal(text.props.tag, 'p');
    const shape = schema.createNode('shape');
    assert.equal(shape.props.shape, 'rect');
    assert.equal(schema.createNode('list').props.ordered, false);
    assert.equal(schema.createNode('table').props.header, true);
    assert.deepEqual(schema.createNode('instance').props, { component: '', overrides: {} });

    const A = t.loadAPB();
    A.require('elements').register({ type: 'badge', label: 'Badge', vnode: () => ({ tag: 'span' }), defaults: () => ({ w: 90, props: { text: 'New' } }) });
    const badge = A.require('schema').createNode('badge');
    assert.equal(badge.w, 90);
    assert.equal(badge.name, 'Badge');
    assert.equal(badge.props.text, 'New');
  });

  test('canContain and styleOmit', () => {
    assert.equal(elements.canContain('page', 'section'), true);
    assert.equal(elements.canContain('page', 'page'), false);
    assert.equal(elements.canContain('section', 'text'), true);
    assert.equal(elements.canContain('frame', 'section'), false);
    assert.equal(elements.canContain('text', 'text'), false);
    assert.equal(elements.canContain('nope', 'text'), false);
    assert.ok(elements.styleOmit('shape', { props: { shape: 'star' } }).includes('fill'));
    assert.ok(elements.styleOmit('shape', { props: { shape: 'ellipse' } }).includes('radius'));
    assert.deepEqual(elements.styleOmit('shape', { props: { shape: 'rect' } }), []);
    assert.deepEqual(elements.styleOmit('text', {}), []);
  });

  test('bpProps limit breakpoint props overrides for registered types', () => {
    const doc = schema.createDocument();
    const b = schema.createNode('button', { props: { text: 'Buy', href: 'https://a.example' }, bp: { mobile: { props: { text: 'Go', href: 'https://b.example' } } } });
    doc.nodes[b.id] = b;
    const eff = schema.effectiveNode(doc, b, 'mobile');
    assert.equal(eff.props.text, 'Go');
    assert.equal(eff.props.href, 'https://a.example');
  });

  /* ---------------------------------------------------------- vnodes */

  test('page, section, frame, group vnodes are slots with semantic tags', () => {
    assert.deepEqual(vnodeOf('page'), { tag: 'div', attrs: {}, slot: true });
    assert.equal(vnodeOf('section').tag, 'section');
    assert.equal(vnodeOf('section', { props: { tag: 'header' } }).tag, 'header');
    assert.equal(vnodeOf('section', { props: { tag: 'script' } }).tag, 'section', 'tags are allowlisted');
    assert.equal(vnodeOf('section').slot, true);
    const frame = vnodeOf('frame');
    assert.equal(frame.tag, 'div');
    assert.equal(frame.slot, true);
    const link = vnodeOf('frame', { props: { href: 'https://example.com/x', target: '_blank' } });
    assert.equal(link.tag, 'a');
    assert.equal(link.attrs.href, 'https://example.com/x');
    assert.equal(link.attrs.rel, 'noopener noreferrer');
    assert.equal(link.slot, true);
    const editorLink = vnodeOf('frame', { props: { href: 'https://example.com/x' } }, 'editor');
    assert.equal(editorLink.attrs.href, undefined, 'links never navigate in the editor');
    assert.equal(editorLink.attrs['data-href'], 'https://example.com/x');
    assert.equal(vnodeOf('frame', { props: { href: 'javascript:alert(1)' } }).tag, 'div');
    assert.deepEqual(vnodeOf('group'), { tag: 'div', attrs: {}, slot: true });
  });

  test('text vnode: tags, plain text, sanitized html, links', () => {
    const p = vnodeOf('text', { props: { text: 'Hello <b>' } });
    assert.equal(p.tag, 'p');
    assert.equal(p.text, 'Hello <b>', 'text is kept raw (escaped by toHTML/textContent)');
    assert.equal(p.style.margin, '0');
    assert.equal(p.style.whiteSpace, 'pre-wrap');
    assert.equal(vnodeOf('text', { props: { tag: 'h1' } }).tag, 'h1');
    assert.equal(vnodeOf('text', { props: { tag: 'iframe' } }).tag, 'p');
    const calls = [];
    const rich = vnodeOf('text', { props: { html: '<b>x</b><img src=x onerror=alert(1)>' } }, 'export',
      { sanitizeHTML: (h, profile) => { calls.push(profile); return 'SAFE'; } });
    assert.equal(rich.html, 'SAFE');
    assert.equal(rich.text, undefined);
    assert.deepEqual(calls, ['inline']);
    const linked = vnodeOf('text', { props: { text: 'Docs', href: '/docs', target: '_blank' } });
    assert.equal(linked.tag, 'p');
    assert.equal(linked.children[0].tag, 'a');
    assert.equal(linked.children[0].attrs.href, '/docs');
    assert.equal(linked.children[0].text, 'Docs');
    const bad = vnodeOf('text', { props: { text: 'x', href: 'javascript:alert(1)' } });
    assert.equal(bad.children, undefined);
    assert.equal(bad.text, 'x');
  });

  test('button vnode: a when href, button[type] otherwise', () => {
    const btn = vnodeOf('button', { props: { text: 'Send', kind: 'submit' } });
    assert.equal(btn.tag, 'button');
    assert.equal(btn.attrs.type, 'submit');
    assert.equal(btn.text, 'Send');
    assert.equal(btn.style.display, 'inline-flex');
    assert.equal(btn.style.alignItems, 'center');
    assert.equal(btn.attrs.tabindex, undefined);
    assert.equal(vnodeOf('button', { props: { kind: 'evil' } }).attrs.type, 'button');
    assert.equal(vnodeOf('button', {}, 'editor').attrs.tabindex, '-1');
    const a = vnodeOf('button', { props: { href: 'mailto:hi@example.com' } });
    assert.equal(a.tag, 'a');
    assert.equal(a.attrs.href, 'mailto:hi@example.com');
    assert.equal(a.attrs.type, undefined);
  });

  test('image vnode: placeholder, asset, alt/decorative, loading', () => {
    const ph = vnodeOf('image', { props: { alt: 'Team photo' } });
    assert.equal(ph.tag, 'img');
    assert.match(ph.attrs.src, /^data:image\/svg\+xml,/);
    assert.equal(ph.attrs.alt, 'Team photo');
    assert.equal(ph.attrs.width, '320');
    assert.equal(ph.attrs.height, '240');
    assert.equal(ph.attrs.loading, 'lazy');
    assert.equal(ph.attrs.decoding, 'async');
    assert.equal(ph.attrs['data-placeholder'], '');
    assert.equal(ph.style.display, 'block');
    const deco = vnodeOf('image', { props: { alt: 'ignored', decorative: true, src: 'https://img.example/a.png' } });
    assert.equal(deco.attrs.alt, '');
    assert.equal(deco.attrs.role, 'presentation');
    assert.equal(deco.attrs.src, 'https://img.example/a.png');
    assert.equal(deco.attrs['data-placeholder'], undefined);
    const asset = vnodeOf('image', { props: { asset: 'as_logo0001', fetchpriority: 'high' } });
    assert.equal(asset.attrs.src, 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(asset.attrs.fetchpriority, 'high');
    const unsafe = vnodeOf('image', { props: { src: 'javascript:alert(1)' } });
    assert.match(unsafe.attrs.src, /^data:image\/svg\+xml,/);
    const editor = vnodeOf('image', {}, 'editor');
    assert.equal(editor.attrs.loading, undefined);
    assert.equal(editor.attrs.draggable, 'false');
    assert.equal(elements.get('image').audit(schema.createNode('image'), {}).length, 1);
  });

  test('shape vnodes: div for rect/ellipse/line, inline svg polygon otherwise', () => {
    const rect = vnodeOf('shape', { style: { stroke: '#000', strokeWidth: 2 } });
    assert.equal(rect.tag, 'div');
    assert.equal(rect.style.border, '2px solid #000');
    assert.equal(rect.attrs['aria-hidden'], 'true');
    assert.equal(vnodeOf('shape', { props: { shape: 'ellipse' } }).style.borderRadius, '50%');
    const line = vnodeOf('shape', { props: { shape: 'line' }, style: { stroke: '$primary', strokeWidth: 3 } });
    assert.equal(line.tag, 'div');
    assert.equal(line.style.borderTop, '3px solid var(--t-primary)');
    const tri = vnodeOf('shape', { props: { shape: 'triangle' }, style: { fill: '$primary' } });
    assert.equal(tri.tag, 'svg');
    assert.equal(tri.attrs.viewBox, '0 0 100 100');
    assert.equal(tri.attrs.preserveAspectRatio, 'none');
    assert.equal(tri.style.fill, 'var(--t-primary)');
    assert.equal(tri.children[0].tag, 'polygon');
    assert.equal(tri.children[0].attrs.points, '50,0 100,100 0,100');
    const hex = vnodeOf('shape', { props: { shape: 'polygon', sides: 6 } });
    assert.equal(hex.children[0].attrs.points.split(' ').length, 6);
    assert.equal(hex.children[0].attrs.points.split(' ')[0], '50,0');
    const star = vnodeOf('shape', { props: { shape: 'star', points: 5 }, style: { stroke: '#111', strokeWidth: 1 } });
    assert.equal(star.children[0].attrs.points.split(' ').length, 10);
    assert.equal(star.style.stroke, '#111');
    assert.equal(vnodeOf('shape', { props: { shape: 'arrow' } }).children[0].attrs.points.split(' ').length, 7);
    const grad = vnodeOf('shape', { props: { shape: 'star' }, style: { fill: 'linear-gradient(90deg, #ff0000, #00ff00)' } });
    assert.equal(grad.style.fill, '#ff0000', 'gradients fall back to their first color in SVG');
  });

  test('divider, spacer, list, table, html, instance vnodes', () => {
    const hr = vnodeOf('divider');
    assert.equal(hr.tag, 'hr');
    assert.equal(hr.style.border, '0');
    assert.deepEqual(vnodeOf('spacer'), { tag: 'div', attrs: { 'aria-hidden': 'true' } });
    const ul = vnodeOf('list', { props: { items: ['A', '<B>', { text: 'C' }] } });
    assert.equal(ul.tag, 'ul');
    assert.deepEqual(ul.children, [{ tag: 'li', text: 'A' }, { tag: 'li', text: '<B>' }, { tag: 'li', text: 'C' }]);
    assert.equal(vnodeOf('list', { props: { ordered: true } }).tag, 'ol');
    const table = vnodeOf('table', { props: { rows: [['H1', 'H2'], ['a'], ['b', 'c']], caption: 'Prices' } });
    assert.equal(table.tag, 'table');
    assert.deepEqual(table.children.map((c) => c.tag), ['caption', 'thead', 'tbody']);
    assert.deepEqual(table.children[1].children[0].children.map((c) => [c.tag, c.text, c.attrs.scope]), [['th', 'H1', 'col'], ['th', 'H2', 'col']]);
    assert.deepEqual(table.children[2].children[0].children.map((c) => c.text), ['a', ''], 'rows are padded to the column count');
    const noHeader = vnodeOf('table', { props: { rows: [['a', 'b']], header: false } });
    assert.deepEqual(noHeader.children.map((c) => c.tag), ['tbody']);
    const profiles = [];
    const html = vnodeOf('html', { props: { html: '<script>alert(1)</script><p>x</p>' } }, 'export',
      { sanitizeHTML: (h, profile) => { profiles.push(profile); return '<p>x</p>'; } });
    assert.equal(html.tag, 'div');
    assert.equal(html.html, '<p>x</p>');
    assert.deepEqual(profiles, ['html']);
    const nodeSide = vnodeOf('html', { props: { html: '<script>alert(1)</script>' } });
    assert.ok(!nodeSide.html.includes('<script'), 'Node fallback of sanitize.html escapes everything');
    const missing = vnodeOf('instance', { props: { component: 'cp_missing1' } });
    assert.equal(missing.tag, 'div');
    assert.equal(missing.attrs['data-component-missing'], '');
  });

  test('every core type produces a vnode in export and editor mode', () => {
    for (const type of CORE) {
      for (const mode of ['export', 'editor']) {
        const v = vnodeOf(type, {}, mode);
        assert.equal(typeof v, 'object', type + ' ' + mode);
        assert.equal(typeof v.tag, 'string', type + ' ' + mode);
        const content = ['text', 'html', 'children'].filter((k) => v[k] !== undefined);
        assert.ok(content.length <= 1, type + ': text XOR html XOR children');
      }
    }
  });
}

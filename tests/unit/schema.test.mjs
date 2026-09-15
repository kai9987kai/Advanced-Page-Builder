export default function (APB, t) {
  const { test, assert } = t;
  const schema = APB.require('schema');

  test('createDocument produces a valid doc per contract §5', () => {
    const doc = schema.createDocument({ name: 'My site', pageName: 'Start' });
    assert.equal(doc.format, 'apb');
    assert.equal(doc.version, 2);
    assert.match(doc.id, /^doc_[0-9a-z]{8}$/);
    assert.equal(doc.name, 'My site');
    assert.ok(!Number.isNaN(Date.parse(doc.createdAt)));
    assert.deepEqual(doc.settings.breakpoints.map((b) => b.id), ['desktop', 'tablet', 'mobile']);
    assert.equal(doc.settings.breakpoints[0].max, undefined);
    assert.deepEqual(doc.tokens, { colors: [], text: [] });
    assert.equal(doc.pages.length, 1);
    const page = doc.pages[0];
    assert.match(page.id, /^pg_/);
    assert.equal(page.name, 'Start');
    assert.equal(page.slug, 'index');
    assert.deepEqual(page.seo, { title: '', description: '', ogImage: '', canonical: '', noindex: false });
    const root = doc.nodes[page.root];
    assert.equal(root.type, 'page');
    assert.equal(root.parent, null);
    assert.equal(root.layout.mode, 'stack');
    assert.equal(root.layout.dir, 'column');
    assert.equal(root.layout.gap, 0);
    assert.equal(typeof root.props.minHeight, 'number');
    assert.equal(root.children.length, 1);
    const section = doc.nodes[root.children[0]];
    assert.equal(section.type, 'section');
    assert.equal(section.name, 'Section');
    assert.equal(section.parent, root.id);
    assert.equal(section.w, 1440);
    assert.equal(section.h, 900);
    assert.equal(section.sizing.w, 'fill');
    assert.equal(section.layout.mode, 'free');
    assert.deepEqual(section.children, []);
    assert.deepEqual(schema.validateDocument(doc), { ok: true, errors: [] });
    assert.equal(Object.keys(doc.nodes).length, 2);
    assert.equal(schema.createDocument().name, 'Untitled site');
  });

  test('createNode works without registered element types', () => {
    const text = schema.createNode('text', { name: 'Heading', x: 5, style: { fontSize: 40 } });
    assert.match(text.id, /^n_[0-9a-z]{8}$/);
    for (const k of schema.NODE_KEYS.filter((k) => k !== 'children')) assert.ok(k in text, 'has ' + k);
    assert.equal(text.children, undefined);
    assert.equal(text.layout, null);
    assert.equal(text.name, 'Heading');
    assert.equal(text.x, 5);
    assert.equal(text.style.fontSize, 40);
    assert.equal(text.style.lineHeight, 1.5, 'fallback defaults merged under init');
    const frame = schema.createNode('frame');
    assert.deepEqual(frame.children, []);
    assert.equal(frame.layout.mode, 'free');
    assert.deepEqual(frame.layout.pad, [0, 0, 0, 0]);
    assert.equal(frame.name, 'Frame');
    const unknown = schema.createNode('widget', { id: 'n_custom01' });
    assert.equal(unknown.id, 'n_custom01');
    assert.equal(unknown.name, 'Widget');
    assert.equal(schema.isContainer('section'), true);
    assert.equal(schema.isContainer({ type: 'text' }), false);
  });

  test('createNode merges registered element defaults', () => {
    const A = t.loadAPB();
    A.define('elements', [], () => {
      const types = {
        badge: { type: 'badge', label: 'Badge', container: false, bpProps: ['text'],
          defaults: () => ({ w: 80, h: 24, style: { radius: 12, fill: '#000' }, props: { text: 'New', tone: 'info' } }) },
        card: { type: 'card', label: 'Card', container: true, defaults: () => ({ layout: { mode: 'stack', gap: 8 } }) }
      };
      return { get: (type) => types[type] || null };
    });
    const s = A.require('schema');
    const badge = s.createNode('badge', { props: { text: 'Hot' } });
    assert.equal(badge.w, 80);
    assert.equal(badge.name, 'Badge');
    assert.deepEqual(badge.props, { text: 'Hot', tone: 'info' });
    assert.equal(badge.style.radius, 12);
    const card = s.createNode('card');
    assert.deepEqual(card.children, []);
    assert.equal(card.layout.mode, 'stack');
    assert.equal(card.layout.gap, 8);
    assert.equal(card.layout.align, 'start');
    assert.equal(s.isContainer('card'), true);
    assert.equal(s.isContainer('badge'), false);
    assert.equal(s.isContainer('section'), true, 'structural fallback for unregistered types');
    assert.equal(s.isContainer('widget'), false);
  });

  function sampleDoc() {
    const doc = schema.createDocument();
    const root = doc.nodes[doc.pages[0].root];
    const section = doc.nodes[root.children[0]];
    const frame = schema.createNode('frame', { parent: section.id, w: 300, h: 200 });
    const text = schema.createNode('text', {
      parent: frame.id, x: 10, y: 20, w: 200, h: 40,
      style: { fontSize: 48, color: '#111' }, props: { text: 'Hello', secret: 'x' },
      bp: {
        tablet: { x: 0, style: { fontSize: 36 }, props: { text: 'Hi tablet', secret: 'y' } },
        mobile: { w: 150, style: { color: '#222' }, layout: { mode: 'stack' } }
      }
    });
    frame.children = [text.id];
    section.children = [frame.id];
    doc.nodes[frame.id] = frame;
    doc.nodes[text.id] = text;
    return { doc, root, section, frame, text };
  }

  test('effectiveNode cascade: base ⊕ tablet ⊕ mobile, objects merge one level', () => {
    const { doc, text } = sampleDoc();
    assert.equal(schema.effectiveNode(doc, text.id, 'desktop'), text, 'base returns the node itself');
    assert.equal(schema.effectiveNode(doc, text.id), text);
    assert.equal(schema.effectiveNode(doc, text.id, 'unknown'), text);
    const tab = schema.effectiveNode(doc, text, 'tablet');
    assert.equal(tab.x, 0);
    assert.equal(tab.y, 20);
    assert.equal(tab.w, 200);
    assert.deepEqual(tab.style, { fontSize: 36, color: '#111', lineHeight: 1.5 });
    assert.equal(tab.props.text, 'Hi tablet');
    assert.equal(tab.props.secret, 'y', 'without a registry all props may cascade');
    const mob = schema.effectiveNode(doc, text, 'mobile');
    assert.equal(mob.x, 0, 'tablet override inherited by mobile');
    assert.equal(mob.w, 150);
    assert.deepEqual(mob.style, { fontSize: 36, color: '#222', lineHeight: 1.5 });
    assert.equal(mob.props.text, 'Hi tablet');
    assert.deepEqual(mob.layout, { mode: 'stack' });
    assert.equal(text.style.fontSize, 48, 'base untouched');
    assert.equal(schema.effectiveNode(doc, text, 'mobile'), mob, 'memoized per immutable node');
    // bp order follows settings.breakpoints
    const reordered = Object.assign({}, doc, { settings: Object.assign({}, doc.settings, { breakpoints: [doc.settings.breakpoints[0], doc.settings.breakpoints[2], doc.settings.breakpoints[1]] }) });
    const tabletLast = schema.effectiveNode(reordered, text, 'tablet');
    assert.equal(tabletLast.w, 150, 'mobile now applies before tablet');
    assert.equal(tabletLast.style.color, '#222');
    assert.equal(tabletLast.style.fontSize, 36);
  });

  test('effectiveNode restricts props overrides to bpProps when the type is registered', () => {
    const A = t.loadAPB();
    A.define('elements', [], () => ({ get: (type) => (type === 'text' ? { type: 'text', container: false, bpProps: ['text'] } : null) }));
    const s = A.require('schema');
    const { doc, text } = sampleDoc();
    const tab = s.effectiveNode(doc, text, 'tablet');
    assert.equal(tab.props.text, 'Hi tablet');
    assert.equal(tab.props.secret, 'x');
  });

  test('traversal helpers', () => {
    const { doc, root, section, frame, text } = sampleDoc();
    const order = [];
    schema.walk(doc, root.id, (n, depth) => { order.push(n.type + depth); });
    assert.deepEqual(order, ['page0', 'section1', 'frame2', 'text3']);
    const skipped = [];
    schema.walk(doc, root.id, (n) => { skipped.push(n.id); return n.id !== section.id; });
    assert.deepEqual(skipped, [root.id, section.id]);
    assert.deepEqual(schema.ancestors(doc, text.id), [frame.id, section.id, root.id]);
    assert.deepEqual(schema.descendants(doc, section.id), [frame.id, text.id]);
    assert.equal(schema.rootOf(doc, text.id), root.id);
    assert.equal(schema.pageOf(doc, text.id), doc.pages[0]);
    assert.equal(schema.indexInParent(doc, frame.id), 0);
    assert.equal(schema.indexInParent(doc, root.id), -1);
    assert.equal(schema.bpIndex(doc, 'mobile'), 2);
    assert.equal(schema.bpIndex(doc, 'nope'), -1);
    assert.equal(schema.bpIndex(doc), 0);
  });

  test('createPage returns a new page + root without mutating doc', () => {
    const doc = schema.createDocument();
    const before = JSON.stringify(doc);
    const { page, root } = schema.createPage(doc, 'About us');
    assert.equal(JSON.stringify(doc), before);
    assert.equal(page.slug, 'about-us');
    assert.equal(page.root, root.id);
    assert.equal(root.type, 'page');
    const again = schema.createPage(Object.assign({}, doc, { pages: doc.pages.concat(page) }), 'About us');
    assert.equal(again.page.slug, 'about-us-2');
  });

  test('reid deep copies subtrees with fresh ids', () => {
    const { doc, section, frame, text } = sampleDoc();
    const { nodes, idMap } = schema.reid(doc.nodes, [frame.id]);
    assert.equal(Object.keys(nodes).length, 2);
    const nf = nodes[idMap[frame.id]];
    const nt = nodes[idMap[text.id]];
    assert.notEqual(nf.id, frame.id);
    assert.equal(nf.parent, section.id, 'root keeps original parent');
    assert.deepEqual(nf.children, [nt.id]);
    assert.equal(nt.parent, nf.id);
    assert.deepEqual(nt.bp, text.bp);
    assert.notEqual(nt.bp, text.bp, 'deep copy');
    assert.ok(!doc.nodes[nf.id] && !doc.nodes[nt.id]);
  });

  test('normalizeDocument repairs links, removes dangling refs and fills defaults', () => {
    const { doc, section, frame, text } = sampleDoc();
    const broken = JSON.parse(JSON.stringify(doc));
    broken.nodes[section.id].children.push('n_missing1', text.id); // dangling + duplicate claim (text.parent = frame)
    broken.nodes[frame.id].children.push(frame.id, 'n_wrongpar'); // self cycle + child with a wrong parent field
    broken.nodes.n_wrongpar = { type: 'text', parent: 'n_wrong000' };
    broken.nodes.n_dupe0001 = { type: 'text', parent: 'n_nowhere0' };
    broken.nodes[section.id].children.push('n_dupe0001');
    broken.nodes[frame.id].children.push('n_dupe0001'); // no valid hint → first claim (section, shallower) wins
    delete broken.nodes[text.id].sizing;
    broken.nodes[text.id].x = 'abc';
    broken.nodes.n_orphan01 = { type: 'text', parent: 'n_gone0000' };
    broken.nodes.n_linked01 = { type: 'text', parent: frame.id }; // listed nowhere, parent exists → relinked
    broken.nodes[section.id].layout = null;
    broken.settings.breakpoints = 'bad';
    broken.pages.push({ id: broken.pages[0].id, name: 'Dup', root: 'n_nothere' });
    const input = JSON.stringify(broken);
    const { doc: fixed, warnings } = schema.normalizeDocument(broken);
    assert.equal(JSON.stringify(broken), input, 'input not mutated');
    assert.ok(warnings.length >= 5, warnings.join('\n'));
    const v = schema.validateDocument(fixed);
    assert.deepEqual(v.errors, []);
    assert.equal(fixed.nodes.n_orphan01, undefined, 'unreachable node removed');
    assert.ok(fixed.nodes[frame.id].children.includes('n_linked01'));
    assert.equal(fixed.nodes.n_linked01.parent, frame.id);
    assert.ok(!fixed.nodes[frame.id].children.includes(frame.id));
    assert.deepEqual(fixed.nodes[frame.id].children, [text.id, 'n_wrongpar', 'n_linked01']);
    assert.equal(fixed.nodes[text.id].parent, frame.id, 'parent field decides between claimants');
    assert.ok(!fixed.nodes[section.id].children.includes(text.id));
    assert.equal(fixed.nodes.n_wrongpar.parent, frame.id, 'wrong parent field repaired');
    assert.equal(fixed.nodes.n_dupe0001.parent, section.id);
    assert.deepEqual(fixed.nodes[section.id].children, [frame.id, 'n_dupe0001']);
    assert.deepEqual(fixed.nodes[text.id].sizing, { w: 'fixed', h: 'fixed' });
    assert.equal(fixed.nodes[text.id].x, 0);
    assert.equal(fixed.nodes[section.id].layout.mode, 'free');
    assert.equal(fixed.settings.breakpoints.length, 3);
    assert.equal(fixed.pages.length, 2);
    assert.notEqual(fixed.pages[1].id, fixed.pages[0].id);
    assert.equal(fixed.nodes[fixed.pages[1].root].type, 'page');
    assert.notEqual(fixed.pages[1].slug, fixed.pages[0].slug);
  });

  test('normalizeDocument handles garbage and empty documents', () => {
    const a = schema.normalizeDocument(null);
    assert.ok(schema.validateDocument(a.doc).ok);
    assert.ok(a.warnings.length);
    const b = schema.normalizeDocument({ format: 'apb', version: 2, nodes: {}, pages: [] });
    assert.ok(schema.validateDocument(b.doc).ok, b.warnings.join(';'));
    assert.equal(b.doc.pages.length, 1);
    const good = schema.createDocument();
    const c = schema.normalizeDocument(good);
    assert.deepEqual(c.warnings, []);
    assert.deepEqual(c.doc, good);
    const wrapped = schema.normalizeDocument({ pages: [{ id: 'pg_1', name: 'X', root: 'n_s' }], nodes: { n_s: { type: 'section', children: [] } } });
    assert.ok(schema.validateDocument(wrapped.doc).ok, wrapped.doc && JSON.stringify(schema.validateDocument(wrapped.doc).errors));
    assert.equal(wrapped.doc.nodes[wrapped.doc.pages[0].root].children[0], 'n_s');
  });

  test('validateDocument reports structural errors', () => {
    const { doc, frame, text } = sampleDoc();
    const bad = JSON.parse(JSON.stringify(doc));
    bad.nodes[text.id].parent = 'n_x';
    bad.nodes[frame.id].children.push('n_ghost');
    bad.version = 1;
    const v = schema.validateDocument(bad);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /version/.test(e)));
    assert.ok(v.errors.some((e) => /dangling child n_ghost/.test(e)));
    assert.ok(v.errors.some((e) => /parent n_x does not exist/.test(e)));
    assert.equal(schema.validateDocument('x').ok, false);
  });
}

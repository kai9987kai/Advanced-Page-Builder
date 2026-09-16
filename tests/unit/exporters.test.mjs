export default function (APB, t) {
  const { test, assert } = t;
  const schema = APB.require('schema');
  const storeModule = APB.require('store');
  const docops = APB.require('docops');
  const exporters = APB.require('exporters');

  function setup() {
    const store = storeModule.create(schema.createDocument());
    const doc = store.doc;
    const pageId = doc.pages[0].id;
    const pageRoot = doc.pages[0].root;
    const section = doc.nodes[pageRoot].children[0];
    return { store, pageId, pageRoot, section };
  }

  test('html(): returns null when the document has no pages, a full document otherwise', () => {
    const { store } = setup();
    assert.equal(exporters.html(Object.assign({}, store.doc, { pages: [] }), {}), null);
    // An unknown pageId falls back to the document's first page rather than failing.
    const fallback = exporters.html(store.doc, { pageId: 'nope' });
    assert.ok(fallback && fallback.html.includes('<body>'));
    const out = exporters.html(store.doc, {});
    assert.match(out.html, /^<!--/);
    assert.match(out.html, /<!doctype html>/);
    assert.match(out.html, /<meta http-equiv="Content-Security-Policy"/);
    assert.equal(out.files.length, 0);
  });

  test('html(): sourceComment=false and minify options are honoured', () => {
    const { store } = setup();
    const out = exporters.html(store.doc, { sourceComment: false, minify: true });
    assert.ok(!out.html.startsWith('<!--'));
    assert.ok(!out.css.includes('\n'), 'minified css has no newlines');
  });

  test('html(): a per-node class carries its base declarations, breakpoint overrides diff into @media', () => {
    const { store, section } = setup();
    docops.update(store, [section], { style: { fill: '#ff0000' } }, { bp: null });
    docops.update(store, [section], { style: { fill: '#00ff00' } }, { bp: 'tablet' });
    const out = exporters.html(store.doc, {});
    const cls = exporters.shortClass(section);
    assert.match(out.css, new RegExp('\\.' + cls + '\\{[^}]*background-color: #ff0000'));
    assert.match(out.css, new RegExp('@media \\(max-width:1023px\\)\\{\\.' + cls + '\\{[^}]*background-color: #00ff00'));
  });

  test('html(): a node with actions gets data-apb-actions, data-node-id and the runtime script; without actions, neither appears', () => {
    const { store, pageRoot } = setup();
    const [btn] = docops.insert(store, [{ type: 'button', props: { text: 'Go' } }], { parent: pageRoot });
    const before = exporters.html(store.doc, {});
    assert.ok(!before.html.includes('data-apb-actions'));
    assert.ok(!before.html.includes('apbRunAction'));
    assert.ok(!before.html.includes('data-node-id'));

    docops.update(store, [btn], { actions: [{ type: 'link', url: 'https://example.com', newTab: true }] }, { bp: null });
    const after = exporters.html(store.doc, {});
    assert.match(after.html, /data-node-id="/);
    assert.match(after.html, /data-apb-actions="\[/);
    assert.match(after.html, /apbRunAction/);
    assert.match(after.html, new RegExp(exporters.shortClass(btn)));
  });

  test('html(): an unsafe action URL never reaches the exported page', () => {
    const { store, pageRoot } = setup();
    const [btn] = docops.insert(store, [{ type: 'button' }], { parent: pageRoot });
    docops.update(store, [btn], { actions: [{ type: 'link', url: 'javascript:alert(1)' }] }, { bp: null });
    const out = exporters.html(store.doc, {});
    assert.ok(!out.html.includes('javascript:'));
  });

  test('docHasActions() reflects whether any node in the document carries actions', () => {
    const { store, pageRoot } = setup();
    assert.equal(exporters.docHasActions(store.doc), false);
    const [btn] = docops.insert(store, [{ type: 'button' }], { parent: pageRoot });
    docops.update(store, [btn], { actions: [{ type: 'submit' }] }, { bp: null });
    assert.equal(exporters.docHasActions(store.doc), true);
  });

  test('site(): one HTML file per page, "index" slug maps to index.html', () => {
    const { store } = setup();
    const files = exporters.site(store.doc, {});
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'index.html');
    assert.match(files[0].mime, /text\/html/);
  });

  test('json(): pretty JSON that reparses to an equivalent document', () => {
    const { store } = setup();
    const text = exporters.json(store.doc);
    assert.match(text, /\n/, 'pretty-printed');
    const parsed = JSON.parse(text);
    assert.equal(parsed.id, store.doc.id);
    assert.equal(parsed.pages.length, store.doc.pages.length);
  });

  test('zip(): produces a valid local-file-header + end-of-central-directory archive', async () => {
    const files = [{ path: 'index.html', data: '<p>hi</p>', mime: 'text/html' }, { path: 'assets/a.txt', data: 'x'.repeat(50), mime: 'text/plain' }];
    const blob = exporters.zip(files);
    const buf = new Uint8Array(await blob.arrayBuffer());
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
    // End Of Central Directory signature (PK\x05\x06) must appear once, near the end.
    const tail = Array.from(buf.slice(-22));
    assert.deepEqual(tail.slice(0, 4), [0x50, 0x4b, 0x05, 0x06]);
    const entryCount = tail[10] | (tail[11] << 8);
    assert.equal(entryCount, files.length);
  });

  test('zip(): filters out entries with no path', () => {
    const blob = exporters.zip([{ data: 'no path' }, { path: 'ok.txt', data: 'ok' }]);
    assert.ok(blob.size > 0);
  });

  test('html(): a node with motion gets @keyframes + the trigger rule + the IntersectionObserver runtime, but no data-node-id (motion never targets other nodes)', () => {
    const { store, pageRoot } = setup();
    const [textId] = docops.insert(store, [{ type: 'text', props: { text: 'Hi' } }], { parent: pageRoot });
    const before = exporters.html(store.doc, {});
    assert.ok(!before.html.includes('data-apb-motion'));
    assert.ok(!before.css.includes('@keyframes'));

    docops.update(store, [textId], { motion: { preset: 'slide-up', duration: 400, delay: 0, easing: 'ease-out', trigger: 'enter' } }, { bp: null });
    const after = exporters.html(store.doc, {});
    assert.match(after.html, /data-apb-motion="enter"/);
    assert.ok(!after.html.includes('data-node-id'), 'motion alone does not need data-node-id');
    assert.match(after.css, /@keyframes apb-mo-slide-up/);
    assert.match(after.css, new RegExp('\\.' + exporters.shortClass(textId) + '\\.apb-inview\\{animation:apb-mo-slide-up'));
    assert.match(after.html, /IntersectionObserver/);
  });

  test('html(): motion: false suppresses animation CSS/script even when the document has presets set', () => {
    const { store, pageRoot } = setup();
    const [textId] = docops.insert(store, [{ type: 'text' }], { parent: pageRoot });
    docops.update(store, [textId], { motion: { preset: 'fade' } }, { bp: null });
    const out = exporters.html(store.doc, { motion: false });
    assert.ok(!out.css.includes('@keyframes'));
    assert.ok(!out.html.includes('IntersectionObserver'));
  });

  test('html(): actions and motion share one <script> tag when a document uses both', () => {
    const { store, pageRoot } = setup();
    const [btnId] = docops.insert(store, [{ type: 'button' }], { parent: pageRoot });
    docops.update(store, [btnId], {
      actions: [{ type: 'submit' }],
      motion: { preset: 'fade' }
    }, { bp: null });
    const out = exporters.html(store.doc, {});
    const scriptCount = (out.html.match(/<script>/g) || []).length;
    assert.equal(scriptCount, 1, 'one combined <script>, not two');
    assert.match(out.html, /apbRunAction/);
    assert.match(out.html, /IntersectionObserver/);
  });
}

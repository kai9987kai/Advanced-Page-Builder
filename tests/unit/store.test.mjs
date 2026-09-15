export default function (APB, t) {
  const { test, assert } = t;
  const schema = APB.require('schema');
  const storeModule = APB.require('store');

  /** Store with a fake clock and a recorder for every emitted event. */
  function setup(doc) {
    const clock = { now: 1_000_000 };
    const store = storeModule.create(doc || schema.createDocument(), { now: () => clock.now });
    const events = [];
    for (const evt of ['change', 'selection', 'view', 'prefs', 'history']) store.on(evt, (p) => events.push({ evt, p }));
    const d = store.doc;
    const rootId = d.pages[0].root;
    const sectionId = d.nodes[rootId].children[0];
    return { store, clock, events, rootId, sectionId, of: (evt) => events.filter((e) => e.evt === evt).map((e) => e.p) };
  }

  const noStamp = (doc) => Object.assign({}, doc, { updatedAt: '' });

  test('create: default document, valid doc used as-is, invalid doc normalized', () => {
    const a = storeModule.create();
    assert.ok(schema.validateDocument(a.doc).ok);
    assert.deepEqual(a.selection, []);
    assert.equal(a.view.pageId, a.doc.pages[0].id);
    assert.equal(a.view.bp, 'desktop');
    assert.equal(a.view.zoom, 1);
    assert.equal(a.view.tool, 'select');
    assert.deepEqual([a.view.context, a.view.hover, a.view.editingText], [null, null, null]);
    assert.deepEqual(a.prefs, storeModule.defaultPrefs());
    assert.equal(a.prefs.ai.model, 'claude-opus-5');
    assert.deepEqual(a.history(), { entries: [], index: 0, canUndo: false, canRedo: false });

    const good = schema.createDocument();
    assert.equal(storeModule.create(good).doc, good, 'valid documents are not copied');

    const broken = JSON.parse(JSON.stringify(good));
    broken.nodes.n_orphan01 = { type: 'text', parent: 'n_nowhere0' };
    const c = storeModule.create(broken);
    assert.ok(schema.validateDocument(c.doc).ok);
    assert.equal(c.doc.nodes.n_orphan01, undefined);
    assert.ok(c.warnings.length > 0);

    const withPrefs = storeModule.create(good, { prefs: { snap: { grid: true } } });
    assert.equal(withPrefs.prefs.snap.grid, true);
    assert.equal(withPrefs.prefs.snap.gridSize, 8, 'prefs merge one level deep');
  });

  test('transact: copy-on-write, return value, change payload, history entry', () => {
    const { store, events, of, sectionId, rootId, clock } = setup();
    const before = store.doc;
    clock.now += 5000;
    let textId;
    const ret = store.transact('Add text', (tx) => {
      textId = tx.createNode({ type: 'text', name: 'Hello', x: 10, y: 20 }, sectionId);
      assert.equal(tx.get(['nodes', textId, 'name']), 'Hello', 'tx.get reads in-transaction state');
      assert.equal(store.doc, before, 'store.doc is unchanged until commit');
      return 42;
    }, { select: [textId] });
    assert.equal(ret, 42);
    const after = store.doc;
    assert.notEqual(after, before);
    assert.equal(before.nodes[textId], undefined, 'previous doc untouched');
    assert.equal(after.nodes[rootId], before.nodes[rootId], 'untouched nodes keep identity');
    assert.equal(after.settings, before.settings);
    assert.notEqual(after.nodes[sectionId], before.nodes[sectionId]);
    assert.deepEqual(after.nodes[sectionId].children, [textId]);
    assert.equal(after.nodes[textId].parent, sectionId);
    assert.equal(after.updatedAt, new Date(clock.now).toISOString(), 'updatedAt stamped on user change');

    const changes = of('change');
    assert.equal(changes.length, 1);
    const ch = changes[0];
    assert.equal(ch.label, 'Add text');
    assert.equal(ch.source, 'user');
    assert.ok(ch.nodes instanceof Set || Object.prototype.toString.call(ch.nodes) === '[object Set]');
    assert.deepEqual(Array.from(ch.nodes).sort(), [sectionId, textId].sort());
    assert.equal(ch.structure, true);
    assert.equal(ch.global, false);
    assert.ok(ch.ops.every((op) => typeof op.path === 'string' && 'value' in op));
    assert.ok(!ch.ops.some((op) => op.path === 'updatedAt'), 'updatedAt is not part of the ops');
    assert.equal(events.findIndex((e) => e.evt === 'change') < events.findIndex((e) => e.evt === 'history'), true);

    const entry = store._entries()[0];
    assert.deepEqual(Object.keys(entry).sort(), ['coalesce', 'inverse', 'label', 'ops', 'selAfter', 'selBefore', 'time'].sort());
    assert.equal(entry.time, clock.now);
    assert.equal(entry.coalesce, null);
    assert.deepEqual(store.history(), { entries: [{ label: 'Add text', time: clock.now }], index: 1, canUndo: true, canRedo: false });

    // style-only change: not structural, not global; settings change: global
    store.transact('Style', (tx) => tx.updateNode(textId, { style: { color: '#f00' } }));
    assert.equal(of('change')[1].structure, false);
    assert.deepEqual(Array.from(of('change')[1].nodes), [textId]);
    store.transact('Lang', (tx) => tx.setDocField('settings.lang', 'de'));
    assert.equal(of('change')[2].global, true);
    assert.equal(of('change')[2].nodes.size, 0);

    // A transaction without effective ops records nothing.
    const n = store.history().entries.length;
    store.transact('Nothing', (tx) => tx.updateNode(textId, { name: 'Hello' }));
    assert.equal(store.history().entries.length, n);
    assert.equal(of('change').length, 3);
  });

  test('undo/redo restore exact documents for a complex transaction', () => {
    const { store, sectionId, rootId } = setup();
    const ids = {};
    store.transact('Build', (tx) => {
      ids.frame = tx.createNode({ type: 'frame', w: 300, h: 200 }, sectionId);
      ids.a = tx.createNode({ type: 'text', name: 'A' }, ids.frame);
      ids.b = tx.createNode({ type: 'text', name: 'B' }, ids.frame, 0);
    });
    const doc0 = store.doc;
    assert.deepEqual(doc0.nodes[ids.frame].children, [ids.b, ids.a], 'index inserts');

    store.transact('Complex', (tx) => {
      tx.updateNode(ids.a, { x: 40, style: { color: '#123456', fontSize: 30 }, props: { text: 'Hi' } });
      tx.updateNode(ids.a, { style: { fontSize: 20 }, w: 111 }, { bp: 'tablet' });
      tx.updateNode(ids.a, { hidden: true }, { bp: 'mobile' });
      tx.updateNode(ids.frame, { layout: { mode: 'stack', gap: 4 } });
      tx.moveNode(ids.b, sectionId, 0);
      tx.setDocField('tokens.colors', [{ id: 'primary', name: 'Primary', value: '#2563eb' }]);
      tx.setDocField('name', 'Renamed');
      tx.set(['nodes', ids.a, 'motion'], { preset: 'fade', duration: 400 });
      tx.removeNode(ids.frame); // removes a too
      tx.createNode({ type: 'text', name: 'C' }, rootId);
    });
    const doc1 = store.doc;
    assert.equal(doc1.nodes[ids.frame], undefined);
    assert.equal(doc1.nodes[ids.a], undefined);
    assert.deepEqual(doc1.nodes[sectionId].children, [ids.b]);
    assert.equal(doc1.nodes[ids.b].parent, sectionId);
    assert.equal(doc1.name, 'Renamed');
    assert.ok(schema.validateDocument(doc1).ok, schema.validateDocument(doc1).errors.join('\n'));

    assert.equal(store.undo(), true);
    assert.deepEqual(noStamp(store.doc), noStamp(doc0));
    assert.equal(store.redo(), true);
    assert.deepEqual(noStamp(store.doc), noStamp(doc1));
    store.undo();
    store.undo();
    assert.equal(Object.keys(store.doc.nodes).length, 2);
    assert.equal(store.canUndo(), false);
    assert.equal(store.undo(), false);
    store.redo();
    store.redo();
    assert.deepEqual(noStamp(store.doc), noStamp(doc1));
    assert.equal(store.redo(), false);
  });

  test('updateNode: merge keys, breakpoint overrides with pruning, validation and rollback', () => {
    const { store, sectionId } = setup();
    let id;
    store.transact('Add', (tx) => { id = tx.createNode({ type: 'text', style: { color: '#000' } }, sectionId); });
    const doc0 = store.doc;
    store.transact('Tablet', (tx) => tx.updateNode(id, { style: { fontSize: 12 }, x: 5, name: 'Named' }, { bp: 'tablet' }));
    const n = store.node(id);
    assert.deepEqual(n.bp, { tablet: { style: { fontSize: 12 }, x: 5 } });
    assert.equal(n.name, 'Named', 'non-breakpoint keys write to the base node');
    assert.equal(n.style.color, '#000');
    assert.equal(n.style.fontSize, 18, 'base style untouched');
    assert.equal(schema.effectiveNode(store.doc, id, 'mobile').style.fontSize, 12);

    store.transact('Base bp', (tx) => tx.updateNode(id, { x: 7 }, { bp: 'desktop' }));
    assert.equal(store.node(id).x, 7, 'base breakpoint writes the node itself');

    store.transact('Reset', (tx) => tx.updateNode(id, { style: { fontSize: undefined }, x: undefined }, { bp: 'tablet' }));
    assert.deepEqual(store.node(id).bp, {}, 'empty override objects are pruned');
    store.undo();
    assert.deepEqual(store.node(id).bp, { tablet: { style: { fontSize: 12 }, x: 5 } });
    store.undo();
    store.undo();
    assert.deepEqual(noStamp(store.doc), noStamp(doc0), 'creating nested override objects inverts exactly');

    const snapshot = store.doc;
    const historyLen = store.history().entries.length;
    const eventsBefore = [];
    const off = store.on('change', (p) => eventsBefore.push(p));
    assert.throws(() => store.transact('Bad', (tx) => { tx.updateNode(id, { x: 1 }); tx.updateNode(id, { children: [] }); }), /cannot be patched/);
    assert.throws(() => store.transact('Bad', (tx) => tx.updateNode(id, { nope: 1 })), /not a node key/);
    assert.throws(() => store.transact('Bad', (tx) => tx.updateNode(id, { w: NaN })), /finite number/);
    assert.throws(() => store.transact('Bad', (tx) => tx.updateNode(id, { x: 1 }, { bp: 'watch' })), /unknown breakpoint/);
    assert.throws(() => store.transact('Bad', (tx) => tx.updateNode('n_missing0', { x: 1 })), /does not exist/);
    assert.throws(() => store.transact('Bad', (tx) => tx.setDocField('nodes.x', 1)), /setDocField/);
    assert.throws(() => store.transact('Bad', (tx) => tx.set('nodes.__proto__.x', 1)), /unsafe/);
    assert.equal(store.doc, snapshot, 'no partial state after exceptions');
    assert.equal(store.history().entries.length, historyLen);
    assert.equal(eventsBefore.length, 0);
    off();

    store.transact('Layout on leaf→container', (tx) => {
      const f = tx.createNode({ type: 'frame' }, sectionId);
      tx.set(['nodes', f, 'layout'], null);
      tx.updateNode(f, { layout: { mode: 'stack' } });
      assert.equal(tx.get(['nodes', f, 'layout', 'dir']), 'column', 'layout filled with defaults when missing');
    });
  });

  test('moveNode / removeNode structure rules', () => {
    const { store, sectionId, rootId } = setup();
    const ids = {};
    store.transact('Build', (tx) => {
      ids.f = tx.createNode({ type: 'frame' }, sectionId);
      ids.g = tx.createNode({ type: 'frame' }, ids.f);
      ids.x = tx.createNode({ type: 'text' }, sectionId);
      ids.y = tx.createNode({ type: 'text' }, sectionId);
    });
    assert.deepEqual(store.node(sectionId).children, [ids.f, ids.x, ids.y]);
    store.transact('Reorder', (tx) => tx.moveNode(ids.y, sectionId, 0));
    assert.deepEqual(store.node(sectionId).children, [ids.y, ids.f, ids.x]);
    store.transact('Reorder', (tx) => tx.moveNode(ids.y, sectionId));
    assert.deepEqual(store.node(sectionId).children, [ids.f, ids.x, ids.y], 'index omitted appends');
    assert.throws(() => store.transact('Cycle', (tx) => tx.moveNode(ids.f, ids.g, 0)), /itself or its descendant/);
    assert.throws(() => store.transact('Leaf', (tx) => tx.moveNode(ids.f, ids.x, 0)), /not a container/);
    assert.throws(() => store.transact('Leaf', (tx) => tx.createNode({ type: 'text' }, ids.x)), /not a container/);
    store.transact('Move', (tx) => tx.moveNode(ids.x, ids.g, 5));
    assert.equal(store.node(ids.x).parent, ids.g);
    assert.deepEqual(store.node(ids.g).children, [ids.x]);

    store.select([ids.x, ids.y]);
    store.transact('Delete', (tx) => { assert.equal(tx.removeNode(ids.f), true); assert.equal(tx.removeNode('n_nothing0'), false); });
    assert.equal(store.node(ids.f), null);
    assert.equal(store.node(ids.g), null);
    assert.equal(store.node(ids.x), null);
    assert.deepEqual(store.selection, [ids.y], 'removed nodes leave the selection');
    assert.ok(schema.validateDocument(store.doc).ok);
    store.undo();
    assert.deepEqual(store.selection, [ids.x, ids.y], 'undo restores selBefore');
    assert.equal(store.node(ids.x).parent, ids.g);
    assert.equal(store.node(rootId).children.length, 1);
  });

  test('nested transactions join the outer one; exceptions roll back', () => {
    const { store, sectionId, of } = setup();
    let a;
    let b;
    store.transact('Outer', (tx) => {
      a = tx.createNode({ type: 'text', name: 'A' }, sectionId);
      const inner = store.transact('Inner', (tx2) => {
        assert.equal(tx2.get(['nodes', a, 'name']), 'A', 'inner sees outer changes');
        b = tx2.createNode({ type: 'text', name: 'B' }, sectionId);
        return 'inner-result';
      });
      assert.equal(inner, 'inner-result');
      assert.throws(() => store.transact('Failing inner', (tx3) => {
        tx3.updateNode(a, { name: 'changed' });
        tx3.createNode({ type: 'text', name: 'C' }, sectionId);
        throw new Error('boom');
      }), /boom/);
      assert.equal(tx.get(['nodes', a, 'name']), 'A', 'failed inner changes rolled back');
      assert.equal(tx.get(['nodes', sectionId, 'children']).length, 2);
    });
    assert.equal(store.history().entries.length, 1, 'one history entry');
    assert.equal(store.history().entries[0].label, 'Outer');
    assert.equal(of('change').length, 1);
    assert.deepEqual(store.node(sectionId).children, [a, b]);
    store.undo();
    assert.deepEqual(store.node(sectionId).children, []);

    const snapshot = store.doc;
    const err = new Error('outer failure');
    assert.throws(() => store.transact('Outer fail', (tx) => {
      tx.createNode({ type: 'text' }, sectionId);
      store.transact('Inner ok', (tx2) => tx2.setDocField('name', 'X'));
      tx.select([sectionId]);
      throw err;
    }), (e) => e === err, 'rethrows the original error');
    assert.equal(store.doc, snapshot);
    assert.deepEqual(store.selection, []);
    assert.equal(store.canRedo(), true, 'redo stack intact after a failed transaction');
    assert.equal(store.inTransaction, false);

    let leaked;
    store.transact('Leak', (tx) => { leaked = tx; });
    assert.throws(() => leaked.set('name', 'late'), /already finished/);
    assert.throws(() => store.transact('x', (tx) => store.undo()), /inside a transaction/);
  });

  test('coalescing: same key within 1500 ms merges and keeps the earliest inverse', () => {
    const { store, clock, sectionId } = setup();
    let id;
    store.transact('Add', (tx) => { id = tx.createNode({ type: 'text', x: 0 }, sectionId); });
    const doc0 = store.doc;
    for (let i = 1; i <= 5; i++) {
      clock.now += 1000; // each step within the window of the previous one
      store.transact('Nudge', (tx) => tx.updateNode(id, { x: i * 10 }), { coalesce: 'nudge:' + id });
    }
    assert.equal(store.history().entries.length, 2);
    const entry = store._entries()[1];
    assert.equal(entry.coalesce, 'nudge:' + id);
    assert.deepEqual(entry.ops, [{ path: 'nodes.' + id + '.x', value: 50 }], 'ops compressed to the latest value');
    assert.deepEqual(entry.inverse, [{ path: 'nodes.' + id + '.x', value: 0 }], 'earliest inverse kept');
    assert.equal(store.node(id).x, 50);
    store.undo();
    assert.deepEqual(noStamp(store.doc), noStamp(doc0));
    store.redo();
    assert.equal(store.node(id).x, 50);

    // Undo/redo breaks coalescing.
    clock.now += 10;
    store.transact('Nudge', (tx) => tx.updateNode(id, { x: 60 }), { coalesce: 'nudge:' + id });
    assert.equal(store.history().entries.length, 3);
    // Outside the window → new entry.
    clock.now += 1501;
    store.transact('Nudge', (tx) => tx.updateNode(id, { x: 70 }), { coalesce: 'nudge:' + id });
    assert.equal(store.history().entries.length, 4);
    // Different key → new entry; no key → never merges.
    clock.now += 10;
    store.transact('Other', (tx) => tx.updateNode(id, { y: 1 }), { coalesce: 'other' });
    clock.now += 10;
    store.transact('Plain', (tx) => tx.updateNode(id, { y: 2 }));
    clock.now += 10;
    store.transact('Plain', (tx) => tx.updateNode(id, { y: 3 }));
    assert.equal(store.history().entries.length, 7);
  });

  test('coalesced set-then-delete keeps parent objects exactly', () => {
    const { store, clock, sectionId } = setup();
    let id;
    store.transact('Add', (tx) => { id = tx.createNode({ type: 'text' }, sectionId); });
    const doc0 = store.doc;
    store.transact('Edit', (tx) => tx.set(['nodes', id, 'bp', 'tablet', 'style', 'fill'], 'red'), { coalesce: 'k' });
    clock.now += 100;
    store.transact('Edit', (tx) => tx.set(['nodes', id, 'bp', 'tablet', 'style', 'fill'], undefined), { coalesce: 'k' });
    const doc1 = store.doc;
    assert.deepEqual(doc1.nodes[id].bp, { tablet: { style: {} } });
    assert.equal(store.history().entries.length, 2);
    store.undo();
    assert.deepEqual(noStamp(store.doc), noStamp(doc0));
    store.redo();
    assert.deepEqual(noStamp(store.doc), noStamp(doc1));
  });

  test('history cap of 500 entries, jump and clearHistory', () => {
    const { store, sectionId, of } = setup();
    let id;
    store.transact('Add', (tx) => { id = tx.createNode({ type: 'text', x: 0 }, sectionId); });
    for (let i = 1; i <= 510; i++) store.transact('Set ' + i, (tx) => tx.updateNode(id, { x: i }));
    const h = store.history();
    assert.equal(h.entries.length, storeModule.HISTORY_CAP);
    assert.equal(h.entries.length, 500);
    assert.equal(h.index, 500);
    assert.equal(h.entries[0].label, 'Set 11', 'oldest entries are dropped first');
    assert.equal(store.jump(0), true);
    assert.equal(store.node(id).x, 10);
    assert.equal(store.canUndo(), false);
    const jumpChange = of('change').at(-1);
    assert.equal(jumpChange.source, 'undo');
    assert.equal(jumpChange.label, '500 steps');
    store.jump(250);
    assert.equal(store.node(id).x, 260);
    assert.equal(store.history().index, 250);
    assert.equal(of('change').at(-1).source, 'redo');
    assert.equal(store.jump(250), false);
    // New change after undo truncates the redo stack.
    store.transact('Branch', (tx) => tx.updateNode(id, { y: 5 }));
    assert.equal(store.history().entries.length, 251);
    assert.equal(store.canRedo(), false);
    store.clearHistory();
    assert.deepEqual(store.history(), { entries: [], index: 0, canUndo: false, canRedo: false });
    assert.equal(store.node(id).y, 5, 'clearHistory keeps the document');
  });

  test('selection: modes, events, transaction select option and undo/redo restore', () => {
    const { store, sectionId, rootId, of } = setup();
    let a;
    let b;
    store.transact('Add', (tx) => {
      a = tx.createNode({ type: 'text' }, sectionId);
      b = tx.createNode({ type: 'text' }, sectionId);
    });
    assert.equal(store.select([a]), true);
    assert.deepEqual(store.selection, [a]);
    assert.equal(store.select([a]), false, 'no event when unchanged');
    store.select([b], 'add');
    assert.deepEqual(store.selection, [a, b]);
    store.select([a, sectionId], 'toggle');
    assert.deepEqual(store.selection, [b, sectionId]);
    store.select(b, 'remove');
    assert.deepEqual(store.selection, [sectionId]);
    store.select(['n_missing0', rootId, rootId]);
    assert.deepEqual(store.selection, [rootId], 'unknown ids and duplicates are ignored');
    assert.throws(() => store.select([a], 'bogus'), /unknown mode/);
    const sel = of('selection');
    assert.equal(sel.length, 5);
    assert.deepEqual(sel[1], { selection: [a, b], previous: [a] });

    store.select([a]);
    store.transact('Style b', (tx) => tx.updateNode(b, { x: 1 }), { select: [b] });
    assert.deepEqual(store.selection, [b]);
    store.transact('Style a', (tx) => { tx.updateNode(a, { x: 2 }); store.select([a, b]); });
    assert.deepEqual(store.selection, [a, b], 'select() inside a transaction sets selAfter');
    const entry = store._entries().at(-1);
    assert.deepEqual(entry.selBefore, [b]);
    assert.deepEqual(entry.selAfter, [a, b]);
    store.undo();
    assert.deepEqual(store.selection, [b]);
    store.undo();
    assert.deepEqual(store.selection, [a]);
    store.redo();
    assert.deepEqual(store.selection, [b]);
    store.redo();
    assert.deepEqual(store.selection, [a, b]);

    // Selection-only transaction: no history entry, selection event.
    const n = store.history().entries.length;
    store.transact('Select only', () => {}, { select: [sectionId] });
    assert.equal(store.history().entries.length, n);
    assert.deepEqual(store.selection, [sectionId]);
  });

  test('view and prefs emitters; view repaired when referenced nodes disappear', () => {
    const { store, sectionId, of } = setup();
    assert.equal(store.setView({ zoom: 2, x: -100 }), true);
    assert.equal(store.view.zoom, 2);
    const v = of('view')[0];
    assert.deepEqual(Array.from(v.changed).sort(), ['x', 'zoom']);
    assert.equal(v.previous.zoom, 1);
    assert.equal(store.setView({ zoom: 2 }), false, 'no-op patch emits nothing');
    assert.equal(of('view').length, 1);
    assert.throws(() => store.setView({ pageId: 'pg_missing0' }), /unknown page/);

    store.setView({ context: sectionId, hover: sectionId });
    store.transact('Delete section', (tx) => tx.removeNode(sectionId));
    assert.equal(store.view.context, null);
    assert.equal(store.view.hover, null);
    assert.deepEqual(Array.from(of('view').at(-1).changed).sort(), ['context', 'hover']);

    const previousPrefs = store.prefs;
    assert.equal(store.setPrefs({ snap: { grid: true }, theme: 'dark' }), true);
    assert.equal(store.prefs.snap.grid, true);
    assert.equal(store.prefs.snap.threshold, 6);
    assert.equal(store.prefs.theme, 'dark');
    assert.equal(previousPrefs.snap.grid, false, 'prefs are replaced, not mutated');
    const p = of('prefs')[0];
    assert.deepEqual(Array.from(p.changed).sort(), ['snap', 'theme']);
    assert.equal(store.setPrefs({ theme: 'dark' }), false);
    assert.equal(of('prefs').length, 1);
  });

  test('replaceDoc clears history and selection and emits a replace change', () => {
    const { store, sectionId, of } = setup();
    store.transact('Edit', (tx) => tx.updateNode(sectionId, { h: 500 }));
    store.select([sectionId]);
    store.setView({ zoom: 0.5, context: sectionId });
    const next = schema.createDocument({ name: 'Other' });
    const res = store.replaceDoc(next, { label: 'Open project' });
    assert.deepEqual(res, { warnings: [] });
    assert.equal(store.doc, next);
    assert.deepEqual(store.history(), { entries: [], index: 0, canUndo: false, canRedo: false });
    assert.deepEqual(store.selection, []);
    assert.equal(store.view.pageId, next.pages[0].id);
    assert.equal(store.view.zoom, 0.5, 'camera kept');
    assert.equal(store.view.context, null);
    const ch = of('change').at(-1);
    assert.equal(ch.source, 'replace');
    assert.equal(ch.label, 'Open project');
    assert.equal(ch.structure, true);
    assert.equal(ch.global, true);
    assert.ok(ch.nodes.has(sectionId) && ch.nodes.has(next.pages[0].root));
    assert.deepEqual(of('selection').at(-1).selection, []);
    assert.equal(of('history').at(-1).index, 0);
    assert.equal(store.undo(), false);

    const invalid = JSON.parse(JSON.stringify(next));
    invalid.pages = [];
    const res2 = store.replaceDoc(invalid);
    assert.ok(res2.warnings.length > 0);
    assert.ok(schema.validateDocument(store.doc).ok);
    assert.equal(of('change').at(-1).label, 'Replace document');
  });

  test('listeners may start new transactions from change handlers', () => {
    const { store, sectionId } = setup();
    let reacted = 0;
    const off = store.on('change', (p) => {
      if (p.label === 'First') {
        reacted++;
        store.transact('Reaction', (tx) => tx.setDocField('name', 'Reacted'));
      }
    });
    store.transact('First', (tx) => tx.updateNode(sectionId, { h: 10 }));
    off();
    assert.equal(reacted, 1);
    assert.equal(store.doc.name, 'Reacted');
    assert.deepEqual(store.history().entries.map((e) => e.label), ['First', 'Reaction']);
    store.undo();
    assert.equal(store.doc.name, 'Untitled site');
    assert.equal(store.node(sectionId).h, 10);
  });

  test('silent transactions apply without an undo entry', () => {
    const { store, of } = setup();
    store.transact('Remember export options', (tx) => tx.setDocField('settings.export', { minify: true }), { silent: true });
    assert.deepEqual(store.doc.settings.export, { minify: true });
    assert.equal(store.history().entries.length, 0);
    assert.equal(of('change').length, 1);
    assert.equal(of('history').length, 0);
  });
}

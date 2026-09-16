export default function (APB, t) {
  const { test, assert } = t;
  const schema = APB.require('schema');
  const storeModule = APB.require('store');
  const docops = APB.require('docops');

  function setup() {
    const store = storeModule.create(schema.createDocument());
    const doc = store.doc;
    const pageRoot = doc.pages[0].root;
    const section = doc.nodes[pageRoot].children[0];
    return { store, pageRoot, section };
  }

  const strip = (doc) => JSON.parse(JSON.stringify(Object.assign({}, doc, { updatedAt: '' })));
  const N = (store, id) => store.doc.nodes[id];
  const lastLabel = (store) => { const h = store.history(); return h.index ? h.entries[h.index - 1].label : null; };
  const close = (a, b, eps = 1e-3, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
  const angle = (d) => { let r = ((d % 360) + 360) % 360; if (r > 180) r -= 360; return r; };
  const closeBox = (a, b, msg = '') => {
    close(a.cx, b.cx, 1e-2, msg + ' cx');
    close(a.cy, b.cy, 1e-2, msg + ' cy');
    close(a.w, b.w, 1e-2, msg + ' w');
    close(a.h, b.h, 1e-2, msg + ' h');
    close(angle(a.rotation - b.rotation), 0, 1e-2, msg + ' rotation');
  };
  const valid = (store) => {
    const v = schema.validateDocument(store.doc);
    assert.ok(v.ok, v.errors.join('; '));
  };

  /** Runs fn (one docops call), checks one history entry was added, undo restores exactly, then redoes. */
  function undoExact(store, fn) {
    const before = strip(store.doc);
    const count = store.history().index;
    const result = fn();
    assert.equal(store.history().index, count + 1, 'exactly one history entry');
    valid(store);
    const after = strip(store.doc);
    store.undo();
    assert.deepEqual(strip(store.doc), before, 'undo restores the document exactly');
    store.redo();
    assert.deepEqual(strip(store.doc), after, 'redo re-applies');
    return result;
  }

  const leaf = (x, y, w, h, extra) => Object.assign({ type: 'text', x, y, w, h, rotation: 0, props: { text: 'T' } }, extra || {});
  const add = (store, parent, specs, opts) => docops.insert(store, specs, Object.assign({ parent, select: false }, opts || {}));

  /* ----------------------------------------------------------------- insert */

  test('insert: nested children, at placement, selection, label, one undo step', () => {
    const { store, section } = setup();
    const ids = undoExact(store, () => docops.insert(store, [
      { type: 'frame', name: 'Card', x: 10, y: 20, w: 200, h: 100, children: [leaf(5, 5, 50, 20), leaf(60, 5, 50, 20)] },
      leaf(300, 20, 40, 40)
    ], { parent: section, at: { x: 100, y: 100 } }));
    assert.equal(ids.length, 2);
    assert.equal(lastLabel(store), 'Insert 2 layers');
    const card = N(store, ids[0]);
    assert.deepEqual([card.x, card.y], [100, 100]);
    assert.deepEqual([N(store, ids[1]).x, N(store, ids[1]).y], [390, 100]);
    assert.equal(card.children.length, 2);
    assert.deepEqual([N(store, card.children[0]).x, N(store, card.children[0]).y], [5, 5]);
    assert.equal(N(store, card.children[0]).parent, card.id);
    assert.deepEqual(store.selection, ids);
    assert.deepEqual(N(store, section).children, ids);

    const centered = docops.insert(store, leaf(0, 0, 100, 50), { parent: section, at: { x: 500, y: 500 }, anchor: 'center' });
    assert.deepEqual([N(store, centered[0]).x, N(store, centered[0]).y], [450, 475]);
    assert.ok(/^Insert /.test(lastLabel(store)));

    // Default parents: leaves go to the first section, sections to the page root.
    const d1 = docops.insert(store, leaf(1, 1, 10, 10));
    assert.equal(N(store, d1[0]).parent, section);
    const s2 = docops.insert(store, { type: 'section', h: 400, sizing: { w: 'fill', h: 'fixed' }, layout: { mode: 'free' } });
    assert.equal(N(store, s2[0]).parent, store.doc.pages[0].root);
    const at = docops.insert(store, leaf(0, 0, 10, 10), { parent: section, index: 0, select: false });
    assert.equal(N(store, section).children[0], at[0]);
    assert.deepEqual(store.selection, s2, 'select:false keeps the selection');
    assert.throws(() => docops.insert(store, leaf(0, 0, 1, 1), { parent: at[0] }));
  });

  /* -------------------------------------------------------- remove / duplicate */

  test('remove: deletes subtrees (locked too), cleans empty groups, one undo step', () => {
    const { store, section, pageRoot } = setup();
    const [frame, lone] = add(store, section, [
      { type: 'frame', x: 0, y: 0, w: 100, h: 100, locked: true, children: [leaf(1, 1, 10, 10)] },
      leaf(200, 200, 10, 10)
    ]);
    const child = N(store, frame).children[0];
    store.select([frame, child, lone]);
    const count = undoExact(store, () => docops.remove(store, [frame, child, lone, pageRoot]));
    assert.equal(count, 2);
    assert.equal(lastLabel(store), 'Delete 2 layers');
    assert.equal(N(store, frame), undefined);
    assert.equal(N(store, child), undefined);
    assert.deepEqual(store.selection, []);
    assert.ok(N(store, pageRoot), 'page roots are never removed');

    const [a, b] = add(store, section, [leaf(0, 0, 10, 10), leaf(50, 0, 10, 10)]);
    const g = docops.group(store, [a, b]);
    docops.remove(store, [a]);
    assert.ok(N(store, g), 'group with remaining child survives');
    assert.deepEqual([N(store, g).x, N(store, g).w, N(store, b).x], [50, 10, 0], 'group refit to the remaining child');
    docops.remove(store, [b]);
    assert.equal(N(store, g), undefined, 'empty group removed');
    valid(store);
    assert.equal(docops.remove(store, []), 0);
  });

  test('duplicate: deep re-id, offset, placement after original, selection', () => {
    const { store, section } = setup();
    const [frame, other] = add(store, section, [
      { type: 'frame', name: 'Card', x: 10, y: 10, w: 100, h: 100, bp: { mobile: { x: 5 } }, children: [leaf(1, 2, 10, 10)] },
      leaf(300, 0, 10, 10)
    ]);
    const copies = undoExact(store, () => docops.duplicate(store, [frame, N(store, frame).children[0]]));
    assert.equal(copies.length, 1, 'descendants of selected nodes are not duplicated twice');
    assert.equal(lastLabel(store), 'Duplicate layer');
    const copy = N(store, copies[0]);
    assert.notEqual(copy.id, frame);
    assert.equal(copy.name, 'Card');
    assert.deepEqual([copy.x, copy.y], [26, 26]);
    assert.equal(copy.bp.mobile.x, 21);
    assert.equal(copy.children.length, 1);
    const childCopy = N(store, copy.children[0]);
    assert.notEqual(childCopy.id, N(store, frame).children[0]);
    assert.equal(childCopy.parent, copy.id);
    assert.deepEqual([childCopy.x, childCopy.y], [1, 2], 'children keep relative coordinates');
    assert.deepEqual(N(store, section).children, [frame, copy.id, other]);
    assert.deepEqual(store.selection, copies);

    const two = docops.duplicate(store, [frame, other], { offset: 0 });
    assert.equal(lastLabel(store), 'Duplicate 2 layers');
    assert.deepEqual([N(store, two[1]).x, N(store, two[1]).y], [300, 0]);
    valid(store);
  });

  /* ---------------------------------------------------------- move / setBox */

  test('move: label, locked and stack children skipped, coalescing, rotated parents', () => {
    const { store, section, pageRoot } = setup();
    const [a, b, c, locked] = add(store, section, [leaf(0, 0, 10, 10), leaf(20, 0, 10, 10), leaf(40, 0, 10, 10), leaf(60, 0, 10, 10, { locked: true })]);
    const moved = undoExact(store, () => docops.move(store, [a, b, c, locked], 5, -3));
    assert.deepEqual(moved, [a, b, c]);
    assert.equal(lastLabel(store), 'Move 3 layers');
    assert.deepEqual([N(store, a).x, N(store, a).y, N(store, c).x], [5, -3, 45]);
    assert.equal(N(store, locked).x, 60);

    const n = store.history().index;
    docops.move(store, [a], 1, 0, { coalesce: 'nudge' });
    docops.move(store, [a], 1, 0, { coalesce: 'nudge' });
    assert.equal(store.history().index, n + 1, 'coalesced into one entry');
    assert.equal(N(store, a).x, 7);
    assert.equal(lastLabel(store), 'Move layer');

    assert.deepEqual(docops.move(store, [section], 10, 10), [], 'stack children (sections) are not moved');
    assert.deepEqual(docops.move(store, [pageRoot], 10, 10), []);
    assert.deepEqual(docops.move(store, [a], 0, 0), []);

    const [rot] = add(store, section, [{ type: 'frame', x: 300, y: 300, w: 200, h: 100, rotation: 90, children: [leaf(10, 10, 20, 20)] }]);
    const kid = N(store, rot).children[0];
    const before = docops.worldBox(store.doc, kid);
    docops.move({ store }, [kid], 10, 0);
    const after = docops.worldBox(store.doc, kid);
    close(after.cx - before.cx, 10);
    close(after.cy - before.cy, 0);
    assert.deepEqual([N(store, kid).x, N(store, kid).y], [10, 0], 'world +x is local −y inside a 90° parent');
  });

  test('setBox: labels, bp overrides, locked, group children scale', () => {
    const { store, section } = setup();
    const [a, locked] = add(store, section, [leaf(0, 0, 100, 50), leaf(0, 0, 10, 10, { locked: true })]);
    undoExact(store, () => docops.setBox(store, a, { w: 200, h: 60 }));
    assert.equal(lastLabel(store), 'Resize');
    docops.setBox(store, a, { rotation: 375 });
    assert.equal(lastLabel(store), 'Rotate');
    assert.equal(N(store, a).rotation, 15);
    docops.setBox(store, a, { x: 5, y: 6 });
    assert.equal(lastLabel(store), 'Move');
    assert.equal(docops.setBox(store, a, { x: 5, y: 6 }), false, 'no-op');
    assert.equal(docops.setBox(store, locked, { x: 50 }), false);

    docops.setBox(store, a, { x: 77, w: 33 }, { bp: 'mobile' });
    assert.deepEqual([N(store, a).x, N(store, a).w], [5, 200], 'base untouched');
    assert.deepEqual(N(store, a).bp.mobile, { x: 77, w: 33 });

    const [b, c] = add(store, section, [leaf(100, 100, 50, 50), leaf(200, 150, 50, 50)]);
    const g = docops.group(store, [b, c]);
    assert.deepEqual([N(store, g).w, N(store, g).h], [150, 100]);
    undoExact(store, () => docops.setBox(store, g, { w: 300, h: 50 }));
    assert.deepEqual([N(store, c).x, N(store, c).y, N(store, c).w, N(store, c).h], [200, 25, 100, 25]);
    assert.deepEqual([N(store, g).x, N(store, g).y, N(store, g).w, N(store, g).h], [100, 100, 300, 50]);
  });

  test('update: dotted keys, merges, bp overrides, labels, group refit', () => {
    const { store, section } = setup();
    const [a, b] = add(store, section, [leaf(0, 0, 10, 10, { style: { color: '#000', fontSize: 20 } }), leaf(0, 0, 10, 10)]);
    undoExact(store, () => docops.update(store, [a, b], { 'style.fill': '#ff0000', name: 'Renamed', id: 'nope', parent: 'x' }));
    assert.equal(lastLabel(store), 'Edit 2 layers');
    assert.equal(N(store, a).style.fill, '#ff0000');
    assert.equal(N(store, a).style.color, '#000', 'style merges one level');
    assert.equal(N(store, b).name, 'Renamed');
    assert.equal(N(store, a).id, a);

    docops.update(store, a, { 'style.fontSize': 14, name: 'Base name' }, { bp: 'tablet', label: 'Font size' });
    assert.equal(lastLabel(store), 'Font size');
    assert.equal(N(store, a).style.fontSize, 20);
    assert.equal(N(store, a).bp.tablet.style.fontSize, 14);
    assert.equal(N(store, a).name, 'Base name', 'non-bp keys always write the base');
    assert.equal(schema.effectiveNode(store.doc, a, 'mobile').style.fontSize, 14);

    docops.update(store, a, { 'style.fillImage.size': 'cover' });
    assert.deepEqual(N(store, a).style.fillImage, { size: 'cover' });

    const g = docops.group(store, [a, b]);
    docops.update(store, [a], { x: 50 });
    assert.equal(N(store, g).w, 60, 'group refits after box updates');
  });

  /* --------------------------------------------------------------- reparent */

  test('reparent: keeps visual position across free parents, stack sections and rotated targets', () => {
    const { store, section } = setup();
    const [frame, text] = add(store, section, [{ type: 'frame', name: 'Box', x: 100, y: 50, w: 400, h: 300 }, leaf(130, 170, 20, 20, { bp: { mobile: { x: 140 } } })]);
    const res = undoExact(store, () => docops.reparent(store, [text], frame));
    assert.deepEqual(res, [text]);
    assert.equal(lastLabel(store), 'Move layer into Box');
    assert.equal(N(store, text).parent, frame);
    assert.deepEqual([N(store, text).x, N(store, text).y], [30, 120]);
    assert.equal(N(store, text).bp.mobile.x, 40, 'bp positions shift with the parent change');
    assert.ok(!N(store, section).children.includes(text));

    // Across sections stacked in the page root (section 1 is 900 tall).
    const [section2] = docops.insert(store, { type: 'section', w: 1440, h: 500, sizing: { w: 'fill', h: 'fixed' }, layout: { mode: 'free' } });
    const [t2] = add(store, section2, [leaf(10, 10, 20, 20)]);
    assert.deepEqual(docops.worldBounds(store.doc, t2), { x: 10, y: 910, w: 20, h: 20 });
    docops.reparent(store, [t2], section, 0);
    assert.deepEqual([N(store, t2).x, N(store, t2).y], [10, 910]);
    assert.equal(N(store, section).children[0], t2, 'index honoured');

    // Rotated target: world placement (incl. rotation) is preserved.
    const [rot, t3] = add(store, section, [{ type: 'frame', x: 600, y: 100, w: 200, h: 100, rotation: 90 }, leaf(650, 300, 40, 20, { rotation: 10 })]);
    const before = docops.worldBox(store.doc, t3);
    docops.reparent(store, [t3], rot);
    closeBox(docops.worldBox(store.doc, t3), before, 'rotated reparent');
    close(N(store, t3).rotation, -80);

    // Invalid: into itself / descendants / non-containers.
    assert.deepEqual(docops.reparent(store, [frame], frame), []);
    assert.deepEqual(docops.reparent(store, [frame], text), []);
    valid(store);
  });

  test('reparent: reorders within the same parent without changing coordinates', () => {
    const { store, section } = setup();
    const [a, b, c] = add(store, section, [leaf(1, 1, 5, 5), leaf(2, 2, 5, 5), leaf(3, 3, 5, 5)]);
    docops.reparent(store, [c, a], section, 0);
    assert.deepEqual(N(store, section).children, [a, c, b], 'document order kept for the moved set');
    assert.deepEqual([N(store, a).x, N(store, c).x], [1, 3]);
  });

  /* ------------------------------------------------------- group / ungroup */

  test('group: union bounds with rotated children, relative coordinates, one undo step', () => {
    const { store, section } = setup();
    const [x0, a, b, x1] = add(store, section, [leaf(0, 0, 5, 5), leaf(100, 100, 50, 50), leaf(200, 150, 50, 50, { rotation: 45 }), leaf(900, 0, 5, 5)]);
    const worldBefore = [a, b].map((id) => docops.worldBox(store.doc, id));
    const g = undoExact(store, () => docops.group(store, [b, a]));
    assert.equal(lastLabel(store), 'Group');
    const gn = N(store, g);
    assert.equal(gn.type, 'group');
    assert.equal(gn.name, 'Group');
    assert.deepEqual(gn.children, [a, b], 'children in paint order');
    assert.deepEqual(N(store, section).children, [x0, g, x1], 'group takes the topmost item position');
    const half = 25 * Math.SQRT2;
    close(gn.x, 100);
    close(gn.y, 100);
    close(gn.w, 225 + half - 100);
    close(gn.h, 175 + half - 100);
    assert.deepEqual([N(store, a).x, N(store, a).y], [0, 0]);
    assert.deepEqual([N(store, b).x, N(store, b).y, N(store, b).rotation], [100, 50, 45]);
    [a, b].forEach((id, i) => closeBox(docops.worldBox(store.doc, id), worldBefore[i], 'group'));
    assert.deepEqual(store.selection, [g]);
    assert.equal(docops.group(store, []), null);
  });

  test('group/ungroup round trip preserves world positions (rotated group, opacity)', () => {
    const { store, section } = setup();
    const [a, b] = add(store, section, [leaf(100, 100, 50, 30, { style: { opacity: 0.8 } }), leaf(220, 180, 40, 60, { rotation: 20 })]);
    const local = [a, b].map((id) => ({ x: N(store, id).x, y: N(store, id).y, rotation: N(store, id).rotation }));

    // Plain round trip restores the original coordinates.
    const g0 = docops.group(store, [a, b]);
    const back = docops.ungroup(store, g0);
    assert.deepEqual(back, [a, b]);
    [a, b].forEach((id, i) => {
      close(N(store, id).x, local[i].x);
      close(N(store, id).y, local[i].y);
      close(N(store, id).rotation, local[i].rotation);
    });

    // Rotated + translucent group.
    const g = docops.group(store, [a, b]);
    docops.setBox(store, g, { rotation: 30, x: N(store, g).x + 40 });
    docops.update(store, g, { 'style.opacity': 0.5 });
    const worlds = [a, b].map((id) => docops.worldBox(store.doc, id));
    const ids = undoExact(store, () => docops.ungroup(store, g));
    assert.equal(lastLabel(store), 'Ungroup');
    assert.deepEqual(ids, [a, b]);
    assert.equal(N(store, g), undefined);
    assert.equal(N(store, a).parent, section);
    [a, b].forEach((id, i) => closeBox(docops.worldBox(store.doc, id), worlds[i], 'ungroup'));
    close(N(store, a).rotation, 30);
    close(N(store, b).rotation, 50);
    close(N(store, a).style.opacity, 0.4);
    close(N(store, b).style.opacity, 0.5);
    assert.deepEqual(store.selection, [a, b]);
    assert.deepEqual(docops.ungroup(store, section), [], 'sections cannot be ungrouped');
  });

  test('wrap: free frame keeps positions; stack detects direction, order and gap', () => {
    const { store, section } = setup();
    const [a, b, c] = add(store, section, [leaf(200, 10, 50, 20), leaf(0, 10, 50, 20), leaf(100, 12, 50, 20)]);
    const f = undoExact(store, () => docops.wrap(store, [a, b, c], { layout: 'stack' }));
    assert.equal(lastLabel(store), 'Wrap in stack');
    const fn = N(store, f);
    assert.equal(fn.type, 'frame');
    assert.equal(fn.layout.mode, 'stack');
    assert.equal(fn.layout.dir, 'row');
    assert.equal(fn.layout.gap, 50);
    assert.deepEqual(fn.sizing, { w: 'hug', h: 'hug' });
    assert.deepEqual(fn.children, [b, c, a], 'ordered along the main axis');
    assert.deepEqual([fn.x, fn.y, fn.w, fn.h], [0, 10, 250, 22]);
    assert.deepEqual(fn.style, {});

    const [d, e] = add(store, section, [leaf(500, 500, 10, 10), leaf(520, 560, 10, 10)]);
    const worlds = [d, e].map((id) => docops.worldBox(store.doc, id));
    const f2 = docops.wrap(store, [d, e]);
    assert.equal(lastLabel(store), 'Wrap in frame');
    assert.equal(N(store, f2).layout.mode, 'free');
    [d, e].forEach((id, i) => closeBox(docops.worldBox(store.doc, id), worlds[i]));

    const [p, q] = add(store, section, [leaf(0, 700, 10, 10), leaf(0, 750, 10, 30)]);
    const f3 = docops.wrap(store, [q, p], { layout: { mode: 'stack', gap: 8 } });
    assert.equal(N(store, f3).layout.dir, 'column');
    assert.equal(N(store, f3).layout.gap, 8);
    assert.deepEqual(N(store, f3).children, [p, q]);
  });

  /* ------------------------------------------------------------------ align */

  test('align: selection bounds, parent, locked reference, rotated AABB', () => {
    const { store, section } = setup();
    const [a, b, c] = add(store, section, [leaf(10, 10, 50, 50), leaf(100, 40, 80, 20), leaf(300, 5, 10, 10, { locked: true })]);
    const moved = undoExact(store, () => docops.align(store, [a, b, c], 'left'));
    assert.deepEqual(moved, [a, b]);
    assert.equal(lastLabel(store), 'Align left');
    assert.deepEqual([N(store, a).x, N(store, b).x, N(store, c).x], [10, 10, 300]);

    docops.setBox(store, b, { x: 100 });
    docops.align(store, [a, b], 'hcenter');
    assert.equal(lastLabel(store), 'Align horizontal centers');
    assert.deepEqual([N(store, a).x, N(store, b).x], [70, 55]);
    docops.align(store, [a, b], 'bottom');
    assert.deepEqual([N(store, a).y, N(store, b).y], [10, 40]);
    docops.align(store, [a, b], 'vcenter');
    assert.deepEqual([N(store, a).y, N(store, b).y], [10, 25]);

    docops.align(store, [a], 'right');
    assert.equal(N(store, a).x, 1390, 'single item aligns to its parent');
    docops.align(store, [a, b], 'top', { to: 'parent' });
    assert.deepEqual([N(store, a).y, N(store, b).y], [0, 0]);

    const [r] = add(store, section, [leaf(0, 300, 100, 100, { rotation: 45 })]);
    docops.align(store, [r], 'left');
    close(N(store, r).x, 50 * Math.SQRT2 - 50);
    assert.throws(() => docops.align(store, [a], 'diagonal'));
  });

  /* ------------------------------------------------------------- distribute */

  test('distribute: equal gaps with mixed sizes (h), centers (v), locked excluded', () => {
    const { store, section } = setup();
    const ids = add(store, section, [leaf(0, 0, 10, 10), leaf(120, 0, 5, 10), leaf(37, 0, 60, 10), leaf(500, 0, 100, 10), leaf(250, 0, 10, 10, { locked: true })]);
    const moved = undoExact(store, () => docops.distribute(store, ids, 'h'));
    assert.equal(moved.length, 4);
    assert.equal(lastLabel(store), 'Distribute horizontally');
    const boxes = moved.map((id) => N(store, id)).sort((p, q) => p.x - q.x);
    assert.equal(boxes[0].x, 0);
    assert.equal(boxes[3].x + boxes[3].w, 600, 'outer items stay');
    const gaps = [];
    for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w));
    gaps.forEach((g) => close(g, (600 - 175) / 3, 2e-3, 'gap'));
    assert.equal(N(store, ids[4]).x, 250, 'locked untouched');

    const v = add(store, section, [leaf(0, 0, 10, 10), leaf(0, 30, 10, 40), leaf(0, 200, 10, 100)]);
    docops.distribute(store, v, 'v', { mode: 'center' });
    assert.equal(lastLabel(store), 'Distribute vertically');
    const centers = v.map((id) => N(store, id).y + N(store, id).h / 2);
    close(centers[1] - centers[0], centers[2] - centers[1]);
    assert.deepEqual(docops.distribute(store, v.slice(0, 2), 'h'), []);
  });

  test('tidy: arranges into a grid keeping row structure', () => {
    const { store, section } = setup();
    const [a, b, c, d] = add(store, section, [leaf(0, 0, 50, 50), leaf(300, 5, 30, 30), leaf(10, 400, 40, 60), leaf(200, 380, 20, 20)]);
    const order = undoExact(store, () => docops.tidy(store, [a, b, c, d], { gap: 10 }));
    assert.equal(lastLabel(store), 'Tidy up');
    assert.deepEqual(order, [a, b, d, c]);
    const pos = (id) => [N(store, id).x, N(store, id).y];
    assert.deepEqual([pos(a), pos(b), pos(d), pos(c)], [[0, 0], [60, 0], [0, 60], [60, 60]]);
  });

  test('radial: item centers on a circle, sweep, rotateItems, locked skipped', () => {
    const { store, section } = setup();
    const ids = add(store, section, [leaf(0, 0, 20, 20), leaf(40, 0, 30, 10), leaf(80, 0, 20, 40), leaf(120, 0, 10, 10), leaf(9, 9, 9, 9, { locked: true })]);
    const moved = undoExact(store, () => docops.radial(store, ids, { radius: 100, cx: 500, cy: 400, startAngle: 0, rotateItems: true }));
    assert.equal(moved.length, 4);
    assert.equal(lastLabel(store), 'Arrange in circle');
    const expected = [[600, 400], [500, 500], [400, 400], [500, 300]];
    moved.forEach((id, i) => {
      const n = N(store, id);
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      close(Math.hypot(cx - 500, cy - 400), 100);
      close(cx, expected[i][0]);
      close(cy, expected[i][1]);
    });
    assert.deepEqual(moved.map((id) => N(store, id).rotation), [90, 180, -90, 0]);
    assert.deepEqual([N(store, ids[4]).x, N(store, ids[4]).y], [9, 9]);

    const three = moved.slice(0, 3);
    docops.radial(store, three, { radius: 50, cx: 0, cy: 0, startAngle: 0, sweep: 180, rotateItems: 'radial' });
    const c = three.map((id) => [N(store, id).x + N(store, id).w / 2, N(store, id).y + N(store, id).h / 2]);
    close(c[0][0], 50); close(c[0][1], 0);
    close(c[1][0], 0); close(c[1][1], 50);
    close(c[2][0], -50); close(c[2][1], 0);
    assert.deepEqual(three.map((id) => N(store, id).rotation), [0, 90, 180]);
  });

  test('matchSize: largest or explicit size, locked skipped, rotated keep center', () => {
    const { store, section } = setup();
    const [a, b, c, r] = add(store, section, [leaf(0, 0, 10, 20), leaf(0, 0, 40, 5), leaf(0, 0, 100, 100, { locked: true }), leaf(100, 100, 20, 20, { rotation: 30 })]);
    undoExact(store, () => docops.matchSize(store, [a, b, c], { w: true }));
    assert.equal(lastLabel(store), 'Match width');
    assert.deepEqual([N(store, a).w, N(store, b).w, N(store, c).w], [100, 100, 100]);
    docops.matchSize(store, [a, b], { h: 33 });
    assert.equal(lastLabel(store), 'Match height');
    assert.deepEqual([N(store, a).h, N(store, b).h], [33, 33]);
    docops.matchSize(store, [r], { w: 40, h: 40 });
    assert.equal(lastLabel(store), 'Match size');
    assert.deepEqual([N(store, r).x + 20, N(store, r).y + 20], [110, 110]);
    assert.deepEqual(docops.matchSize(store, [a], {}), []);
  });

  test('zorder: forward, backward, front, back', () => {
    const { store, section } = setup();
    const [a, b, c, d] = add(store, section, [leaf(0, 0, 1, 1), leaf(0, 0, 1, 1), leaf(0, 0, 1, 1), leaf(0, 0, 1, 1)]);
    const kids = () => N(store, section).children;
    undoExact(store, () => docops.zorder(store, [b], 'forward'));
    assert.equal(lastLabel(store), 'Bring forward');
    assert.deepEqual(kids(), [a, c, b, d]);
    docops.zorder(store, [a, c], 'front');
    assert.equal(lastLabel(store), 'Bring to front');
    assert.deepEqual(kids(), [b, d, a, c]);
    docops.zorder(store, [a], 'backward');
    assert.equal(lastLabel(store), 'Send backward');
    assert.deepEqual(kids(), [b, a, d, c]);
    docops.zorder(store, [d, c], 'back');
    assert.equal(lastLabel(store), 'Send to back');
    assert.deepEqual(kids(), [d, c, b, a]);
    const n = store.history().index;
    docops.zorder(store, [a], 'front');
    assert.equal(store.history().index, n, 'no-op adds no entry');
  });

  test('setLocked / setHidden: labels, breakpoint overrides, no-ops', () => {
    const { store, section } = setup();
    const [a, b] = add(store, section, [leaf(0, 0, 1, 1), leaf(0, 0, 1, 1)]);
    undoExact(store, () => docops.setLocked(store, [a, b], true));
    assert.equal(lastLabel(store), 'Lock 2 layers');
    assert.ok(N(store, a).locked && N(store, b).locked);
    assert.deepEqual(docops.setLocked(store, [a], true), []);
    docops.setLocked(store, a, false);
    assert.equal(lastLabel(store), 'Unlock layer');

    undoExact(store, () => docops.setHidden(store, [a], true));
    assert.equal(lastLabel(store), 'Hide layer');
    assert.equal(N(store, a).hidden, true);
    docops.setHidden(store, [b], true, { bp: 'mobile' });
    assert.equal(N(store, b).hidden, false);
    assert.equal(N(store, b).bp.mobile.hidden, true);
    store.setView({ bp: 'tablet' });
    docops.setHidden(store, [a], false);
    assert.equal(lastLabel(store), 'Show layer');
    assert.equal(N(store, a).hidden, true, 'view breakpoint is the default target');
    assert.equal(N(store, a).bp.tablet.hidden, false);
  });

  test('fitGroup: wraps children after external edits and keeps world positions; moves refit automatically', () => {
    const { store, section } = setup();
    const [a, b] = add(store, section, [leaf(100, 100, 20, 20), leaf(200, 200, 20, 20)]);
    const g = docops.group(store, [a, b]);
    store.transact('raw', (tx) => tx.updateNode(b, { x: 300, y: -50 }));
    const worlds = [a, b].map((id) => docops.worldBox(store.doc, id));
    const changed = undoExact(store, () => docops.fitGroup(store, g));
    assert.equal(changed, true);
    assert.equal(lastLabel(store), 'Fit group');
    assert.deepEqual([N(store, g).x, N(store, g).y, N(store, g).w, N(store, g).h], [100, 50, 320, 70]);
    [a, b].forEach((id, i) => closeBox(docops.worldBox(store.doc, id), worlds[i]));
    assert.equal(docops.fitGroup(store, g), false);

    docops.move(store, [a], -30, 0);
    assert.deepEqual([N(store, g).x, N(store, g).w, N(store, a).x, N(store, b).x], [70, 350, 0, 330]);

    // Rotated group refit keeps children in place.
    docops.setBox(store, g, { rotation: 40 });
    store.transact('raw2', (tx) => tx.updateNode(a, { x: -100 }));
    const w2 = [a, b].map((id) => docops.worldBox(store.doc, id));
    docops.fitGroup(store, g);
    [a, b].forEach((id, i) => closeBox(docops.worldBox(store.doc, id), w2[i], 'rotated fit'));
    assert.equal(N(store, a).x, 0);
  });

  /* --------------------------------------------------------- makeResponsive */

  test('makeResponsive: mobile overrides stack children within the width', () => {
    const { store, section, pageRoot } = setup();
    const pageId = store.doc.pages[0].id;
    const [heading, image, para, row, hidden] = add(store, section, [
      leaf(100, 100, 600, 80, { style: { fontSize: 56 } }),
      { type: 'image', x: 800, y: 80, w: 500, h: 400 },
      leaf(100, 220, 600, 120, { style: { fontSize: 18 } }),
      { type: 'frame', x: 100, y: 600, w: 900, h: 100, layout: { mode: 'stack', dir: 'row', gap: 10 }, children: [leaf(0, 0, 500, 50), leaf(0, 0, 200, 50)] },
      leaf(0, 0, 10, 10, { hidden: true })
    ]);
    const baseBefore = strip(store.doc);
    const count = undoExact(store, () => docops.makeResponsive(store, pageId, 'mobile'));
    assert.ok(count >= 5);
    assert.equal(lastLabel(store), 'Make responsive (Mobile)');
    const bpOf = (id) => N(store, id).bp.mobile;
    const order = [heading, para, image, row];
    let prevBottom = -Infinity;
    for (const id of order) {
      const o = bpOf(id);
      assert.ok(o, 'override for ' + id);
      assert.equal(o.x, 16);
      assert.ok(o.w <= 358 + 1e-9, 'fits width');
      assert.ok(o.y >= prevBottom + 16 - 1e-3, 'stacked without overlap');
      prevBottom = o.y + o.h;
    }
    assert.equal(bpOf(heading).y, 16);
    assert.equal(bpOf(heading).style.fontSize, 39);
    assert.ok(bpOf(heading).h > 80, 'narrower text grows taller');
    assert.equal(bpOf(para).style, undefined, 'small text keeps its size');
    close(bpOf(image).w / bpOf(image).h, 500 / 400, 1e-2, 'image aspect');
    assert.equal(bpOf(row).layout.dir, 'column');
    assert.equal(N(store, N(store, row).children[0]).bp.mobile.w, 358);
    assert.equal(N(store, hidden).bp.mobile, undefined);
    close(N(store, section).bp.mobile.h, prevBottom + 16);
    assert.equal(N(store, pageRoot).bp.mobile, undefined);
    // Base values untouched.
    for (const id of order) {
      const now = N(store, id);
      const was = baseBefore.nodes[id];
      assert.deepEqual([now.x, now.y, now.w, now.h, now.style, now.layout], [was.x, was.y, was.w, was.h, was.style, was.layout]);
    }
    const eff = schema.effectiveNode(store.doc, heading, 'mobile');
    assert.deepEqual([eff.x, eff.w, eff.style.fontSize], [16, 358, 39]);

    docops.makeResponsive(store, pageId, 'tablet');
    assert.equal(N(store, heading).bp.tablet.x, 24);
    assert.equal(N(store, heading).bp.tablet.style.fontSize, 48);
    assert.equal(N(store, row).bp.tablet && N(store, row).bp.tablet.layout, undefined, 'row stacks stay rows on tablet');
    assert.equal(docops.makeResponsive(store, pageId, 'desktop'), 0, 'base breakpoint is a no-op');
  });

  /* ------------------------------------------------------------- components */

  test('components: create, instantiate, detach with overrides — round trip', () => {
    const { store, section } = setup();
    const [a, b, other] = add(store, section, [leaf(100, 100, 50, 50, { props: { text: 'A' } }), leaf(200, 120, 60, 40, { props: { text: 'B' } }), leaf(0, 0, 5, 5)]);
    const cp = undoExact(store, () => docops.createComponent(store, [a, b]));
    assert.equal(lastLabel(store), 'Create component');
    const comp = store.doc.components[cp];
    assert.ok(comp);
    assert.equal(comp.id, cp);
    assert.equal(comp.name, 'Component');
    const root = N(store, comp.root);
    assert.equal(root.parent, null);
    assert.equal(schema.pageOf(store.doc, root.id), null, 'master is not on a page');
    assert.deepEqual([root.x, root.y, root.w, root.h], [0, 0, 160, 60]);
    assert.equal(root.children.length, 2);
    const [ma, mb] = root.children;
    assert.notEqual(ma, a);
    assert.deepEqual([N(store, ma).x, N(store, ma).y, N(store, mb).x, N(store, mb).y], [0, 0, 100, 20]);
    assert.equal(N(store, a), undefined, 'originals replaced');
    assert.equal(N(store, b), undefined);
    const [inst] = store.selection;
    const instNode = N(store, inst);
    assert.equal(instNode.type, 'instance');
    assert.equal(instNode.props.component, cp);
    assert.deepEqual(instNode.props.overrides, {});
    assert.deepEqual([instNode.x, instNode.y, instNode.w, instNode.h], [100, 100, 160, 60]);
    assert.deepEqual(N(store, section).children, [inst, other]);

    const i2 = undoExact(store, () => docops.instantiate(store, cp, { parent: section, at: { x: 500, y: 400 } }));
    assert.equal(lastLabel(store), 'Insert Component');
    assert.deepEqual([N(store, i2).x, N(store, i2).y, N(store, i2).w], [500, 400, 160]);
    assert.deepEqual(store.selection, [i2]);
    const centered = docops.instantiate(store, cp);
    assert.deepEqual([N(store, centered).x, N(store, centered).y, N(store, centered).parent], [640, 420, section]);
    assert.equal(docops.instantiate(store, 'cp_missing00'), null);

    docops.update(store, inst, { props: { overrides: { [ma]: { props: { text: 'Hello' }, style: { color: '#ff0000' } } } } });
    docops.setBox(store, inst, { x: 300, y: 50 });
    const detached = undoExact(store, () => docops.detach(store, inst));
    assert.equal(lastLabel(store), 'Detach instance');
    assert.equal(detached.length, 1);
    const frame = N(store, detached[0]);
    assert.equal(N(store, inst), undefined);
    assert.equal(frame.parent, section);
    assert.deepEqual(N(store, section).children.indexOf(frame.id), 0, 'takes the instance slot');
    assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [300, 50, 160, 60]);
    assert.notEqual(frame.id, comp.root);
    const [ca, cb] = frame.children;
    assert.ok(ca !== ma && cb !== mb, 're-id');
    assert.equal(N(store, ca).props.text, 'Hello');
    assert.equal(N(store, ca).style.color, '#ff0000');
    assert.equal(N(store, cb).props.text, 'B');
    assert.equal(N(store, ma).props.text, 'A', 'master untouched');
    assert.deepEqual(docops.worldBounds(store.doc, cb), { x: 400, y: 70, w: 60, h: 40 });
    assert.deepEqual(store.selection, detached);
    assert.deepEqual(docops.detach(store, other), []);
  });

  test('components: single container becomes the master root; instance keeps its box', () => {
    const { store, section } = setup();
    const [card] = add(store, section, [{ type: 'frame', name: 'Card', x: 40, y: 60, w: 300, h: 200, rotation: 10, children: [leaf(10, 10, 100, 20)] }]);
    const cp = docops.createComponent(store, [card]);
    const comp = store.doc.components[cp];
    assert.equal(comp.name, 'Card');
    const root = N(store, comp.root);
    assert.deepEqual([root.x, root.y, root.rotation, root.w, root.h, root.parent], [0, 0, 0, 300, 200, null]);
    const inst = N(store, store.selection[0]);
    assert.deepEqual([inst.x, inst.y, inst.w, inst.h, inst.rotation], [40, 60, 300, 200, 10]);
    valid(store);
    const [frameId] = docops.detach(store, inst.id);
    assert.deepEqual([N(store, frameId).x, N(store, frameId).rotation, N(store, frameId).children.length], [40, 10, 1]);
    valid(store);
  });

  test('docops accepts the app object and rejects other targets', () => {
    const { store, section } = setup();
    const app = { store };
    const ids = docops.insert(app, leaf(0, 0, 10, 10), { parent: section });
    assert.equal(ids.length, 1);
    assert.throws(() => docops.move({}, ids, 1, 1), /first argument must be the app or a store/);
    assert.deepEqual(docops.topLevel(store.doc, [section, ids[0], 'n_missing0']), [section]);
  });

  test('pages: create appends (or inserts at index), duplicate re-ids the whole subtree, remove refuses the last page', () => {
    const { store } = setup();
    const firstPageId = store.doc.pages[0].id;
    const id2 = undoExact(store, () => docops.createPage(store, { name: 'About' }));
    assert.equal(store.doc.pages.length, 2);
    assert.equal(store.doc.pages[1].id, id2);
    assert.equal(store.doc.pages[1].name, 'About');
    assert.equal(store.doc.pages[1].slug, 'about');
    assert.ok(store.doc.nodes[store.doc.pages[1].root], 'a fresh page root node exists');

    const id0 = undoExact(store, () => docops.createPage(store, { name: 'Home2', index: 0 }));
    assert.equal(store.doc.pages[0].id, id0, 'index:0 inserts before the existing pages');

    const dupId = undoExact(store, () => docops.duplicatePage(store, firstPageId));
    const original = store.doc.pages.find((p) => p.id === firstPageId);
    const dup = store.doc.pages.find((p) => p.id === dupId);
    assert.notEqual(dup.root, original.root, 'the duplicate gets a fresh root id');
    assert.notEqual(dup.slug, original.slug);
    assert.equal(store.doc.nodes[dup.root].type, 'page');
    valid(store);

    assert.equal(docops.removePage(store, 'nope'), false);
    while (store.doc.pages.length > 1) {
      const before = store.doc.pages.length;
      const removed = store.doc.pages[store.doc.pages.length - 1].id;
      const rootId = store.doc.pages[store.doc.pages.length - 1].root;
      assert.equal(docops.removePage(store, removed), true);
      assert.equal(store.doc.pages.length, before - 1);
      assert.ok(!store.doc.nodes[rootId], 'the removed page root node is gone too');
    }
    assert.equal(docops.removePage(store, store.doc.pages[0].id), false, 'refuses to remove the last page');
  });

  test('pages: reorder validates a full permutation, rename updates the root node name too, setPageSeo merges', () => {
    const { store } = setup();
    const p2 = docops.createPage(store, { name: 'Two' });
    const p3 = docops.createPage(store, { name: 'Three' });
    const p1 = store.doc.pages[0].id;

    assert.equal(docops.reorderPages(store, [p1, p2]), false, 'must include every page id');
    assert.equal(docops.reorderPages(store, [p3, p1, p2]), true);
    assert.deepEqual(store.doc.pages.map((p) => p.id), [p3, p1, p2]);

    assert.equal(docops.renamePage(store, p1, '  Landing  '), true);
    const renamed = store.doc.pages.find((p) => p.id === p1);
    assert.equal(renamed.name, 'Landing');
    assert.equal(N(store, renamed.root).name, 'Landing', 'the root node name follows the page name');
    assert.equal(docops.renamePage(store, 'nope', 'x'), false);

    assert.equal(docops.setPageSeo(store, p1, { title: 'Landing page', noindex: true }), true);
    const seo = store.doc.pages.find((p) => p.id === p1).seo;
    assert.equal(seo.title, 'Landing page');
    assert.equal(seo.noindex, true);
    assert.equal(seo.description, '', 'untouched fields keep their previous value');
    assert.equal(docops.setPageSeo(store, 'nope', { title: 'x' }), false);
  });

  test('pages: setPageSlug slugifies and de-dupes against the other pages, leaves the page itself out of the clash check', () => {
    const { store } = setup();
    const p1 = store.doc.pages[0].id;
    const p2 = docops.createPage(store, { name: 'About' });
    assert.equal(docops.setPageSlug(store, p1, 'Contact Us!'), true);
    assert.equal(store.doc.pages.find((p) => p.id === p1).slug, 'contact-us');
    // Renaming p2's slug to the same value p1 already has must not collide with p1 itself, only dedupe against others.
    assert.equal(docops.setPageSlug(store, p2, 'contact-us'), true);
    assert.equal(store.doc.pages.find((p) => p.id === p2).slug, 'contact-us-2');
    assert.equal(docops.setPageSlug(store, p1, 'Contact Us!'), true, 're-setting a page\'s own slug to itself is not a clash');
    assert.equal(store.doc.pages.find((p) => p.id === p1).slug, 'contact-us');
    assert.equal(docops.setPageSlug(store, 'nope', 'x'), false);
  });
}

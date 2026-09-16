// Layers panel: tree structure, two-way selection (click / Shift range), lock & hide toggles,
// F2 rename, drag-and-drop reparenting, keyboard navigation, search filter and the
// render / selection performance budgets for a 300-node tree.
export const name = 'layers: tree, selection, toggles, rename, drag, search, perf';
export const viewport = { width: 1280, height: 900 };
export const timeout = 90000;

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const idOf = (page, name) => page.eval((n) => {
  const nodes = APB.app.store.doc.nodes;
  return Object.keys(nodes).find((k) => nodes[k].name === n) || null;
}, name);

const row = (id) => '.apb-layer[data-id="' + id + '"]';

export async function run(page, { assert, log }) {
  await page.ready();

  /* ------------------------------------------------------------------ seed */
  await page.eval(() => {
    const app = APB.app;
    app.ui.showPanel('layers');
    app.docops.insert(app, [
      {
        type: 'section', name: 'Hero', children: [
          {
            type: 'frame', name: 'Card', x: 40, y: 40, w: 320, h: 220, children: [
              { type: 'text', name: 'Title', x: 16, y: 16, w: 240, h: 40, props: { text: 'Hello' } },
              { type: 'button', name: 'CTA', x: 16, y: 96, w: 160, h: 48 }
            ]
          },
          { type: 'text', name: 'Tagline', x: 420, y: 60, w: 300, h: 40, props: { text: 'Tagline' } }
        ]
      },
      { type: 'section', name: 'Features' }
    ], { select: false });
  });
  await page.waitFor(() => document.querySelectorAll('.apb-layers-tree [role="treeitem"]').length >= 7);
  const total = await page.eval(() => document.querySelectorAll('.apb-layers-tree [role="treeitem"]').length);

  const ids = {
    hero: await idOf(page, 'Hero'),
    card: await idOf(page, 'Card'),
    title: await idOf(page, 'Title'),
    cta: await idOf(page, 'CTA'),
    tagline: await idOf(page, 'Tagline'),
    features: await idOf(page, 'Features')
  };
  for (const key of Object.keys(ids)) assert.ok(ids[key], 'seeded node "' + key + '"');

  /* ------------------------------------------------------------- structure */
  const tree = await page.eval(() => {
    const treeEl = document.querySelector('.apb-layers-tree');
    const rows = Array.from(treeEl.querySelectorAll('[role="treeitem"]'));
    return {
      role: treeEl.getAttribute('role'),
      multi: treeEl.getAttribute('aria-multiselectable'),
      labelled: !!treeEl.getAttribute('aria-label'),
      rows: rows.map((r) => ({
        id: r.dataset.id,
        level: r.getAttribute('aria-level'),
        expanded: r.getAttribute('aria-expanded'),
        selected: r.getAttribute('aria-selected'),
        tabindex: r.tabIndex,
        label: r.getAttribute('aria-label'),
        name: r.querySelector('.apb-layer-name').textContent,
        icon: !!r.querySelector('.apb-layer-type svg'),
        toggles: Array.from(r.querySelectorAll('.apb-layer-toggle')).map((b) => b.getAttribute('aria-label'))
      })),
      roving: rows.filter((r) => r.tabIndex === 0).length
    };
  });
  assert.equal(tree.role, 'tree');
  assert.equal(tree.multi, 'true');
  assert.ok(tree.labelled, 'tree has an accessible name');
  assert.ok(tree.rows.length >= 7, 'page root, the seeded sections, the frame and its leaves are listed');
  assert.equal(tree.roving, 1, 'exactly one row is in the tab order (roving tabindex)');
  const named = (id) => tree.rows.find((r) => r.id === id);
  assert.equal(tree.rows[0].level, '1', 'page root is level 1');
  assert.equal(named(ids.hero).level, '2');
  assert.equal(named(ids.card).level, '3');
  assert.equal(named(ids.title).level, '4');
  assert.equal(named(ids.card).expanded, 'true', 'containers expose aria-expanded');
  assert.equal(named(ids.title).expanded, null, 'leaves have no aria-expanded');
  assert.equal(named(ids.title).name, 'Title');
  assert.ok(named(ids.title).icon, 'rows show a type icon');
  assert.match(named(ids.title).label, /Title, Text/);
  assert.deepEqual(named(ids.title).toggles, ['Hide Title', 'Lock Title'], 'toggles are labelled');

  /* --------------------------------------------------- click → canvas select */
  await page.click(row(ids.tagline));
  await frames(page, 2);
  const picked = await page.eval((id) => ({
    selection: APB.app.store.selection.slice(),
    aria: document.querySelector('.apb-layer[data-id="' + id + '"]').getAttribute('aria-selected'),
    canvasSelected: !!APB.app.canvas.renderer.el(id),
    overlay: !!APB.app.canvas.selectionBounds()
  }), ids.tagline);
  assert.deepEqual(picked.selection, [ids.tagline], 'clicking a row selects the node');
  assert.equal(picked.aria, 'true');
  assert.ok(picked.canvasSelected && picked.overlay, 'canvas knows about the selection');

  /* ----------------------------------------------------------- Shift range */
  await page.click(row(ids.title));
  await page.click(row(ids.tagline), { modifiers: ['Shift'] });
  await frames(page, 1);
  const range = await page.eval(() => APB.app.store.selection.slice());
  assert.deepEqual(range, [ids.title, ids.cta, ids.tagline].filter(Boolean), 'Shift+click selects the range');

  // Mod+click toggles a single row out of the selection
  await page.click(row(ids.cta), { modifiers: ['Mod'] });
  const toggled = await page.eval(() => APB.app.store.selection.slice());
  assert.ok(!toggled.includes(ids.cta) && toggled.length === 2, 'Mod+click removes a row from the selection');

  await page.screenshot('layers-tree');

  /* ------------------------------------------------------ hide / lock toggles */
  await page.click(row(ids.features));               // move the selection away from Tagline
  await page.click(row(ids.tagline) + ' .apb-layer-eye');
  await frames(page, 3);
  const hidden = await page.eval((id) => {
    const el = APB.app.canvas.renderer.el(id);
    const rowEl = document.querySelector('.apb-layer[data-id="' + id + '"]');
    return {
      docHidden: !!APB.app.store.node(id).hidden,
      display: el ? getComputedStyle(el).display : null,
      pressed: rowEl.querySelector('.apb-layer-eye').getAttribute('aria-pressed'),
      label: rowEl.querySelector('.apb-layer-eye').getAttribute('aria-label'),
      klass: rowEl.classList.contains('is-hidden'),
      canUndo: APB.app.store.canUndo()
    };
  }, ids.tagline);
  assert.ok(hidden.docHidden, 'the eye toggle writes hidden to the document');
  assert.equal(hidden.display, 'none', 'the canvas element is hidden');
  assert.equal(hidden.pressed, 'true');
  assert.equal(hidden.label, 'Show Tagline');
  assert.ok(hidden.klass, 'row shows the hidden styling');
  await page.click(row(ids.tagline) + ' .apb-layer-eye');
  await frames(page, 2);
  assert.equal(await page.eval((id) => !!APB.app.store.node(id).hidden, ids.tagline), false, 'the toggle flips back');

  await page.click(row(ids.card) + ' .apb-layer-lock');
  await frames(page, 2);
  const locked = await page.eval((id) => {
    const rowEl = document.querySelector('.apb-layer[data-id="' + id + '"]');
    return {
      docLocked: !!APB.app.store.node(id).locked,
      pressed: rowEl.querySelector('.apb-layer-lock').getAttribute('aria-pressed'),
      selectable: APB.app.canvas.renderer.selectable ? APB.app.canvas.renderer.selectable(id) : null,
      childLocked: APB.app.docops.isLocked(APB.app.store.doc, APB.app.store.doc.nodes[id].children[0])
    };
  }, ids.card);
  assert.ok(locked.docLocked, 'the lock toggle writes locked to the document');
  assert.equal(locked.pressed, 'true');
  assert.ok(locked.childLocked, 'children inherit the lock on the canvas');
  await page.click(row(ids.card) + ' .apb-layer-lock');
  await frames(page, 2);

  /* ------------------------------------------------------------ F2 rename */
  await page.click(row(ids.title));
  await page.key('F2');
  await frames(page, 1);
  const editing = await page.eval(() => ({
    input: !!document.querySelector('.apb-layer-rename'),
    focused: document.activeElement && document.activeElement.classList.contains('apb-layer-rename')
  }));
  assert.ok(editing.input && editing.focused, 'F2 opens an inline rename input');
  await page.key('Mod+A');
  await page.type('Headline');
  await page.key('Enter');
  await frames(page, 2);
  const renamed = await page.eval((id) => ({
    name: APB.app.store.node(id).name,
    label: document.querySelector('.apb-layer[data-id="' + id + '"] .apb-layer-name').textContent,
    input: !!document.querySelector('.apb-layer-rename'),
    undoLabel: APB.app.store.history().entries.slice(-1)[0].label
  }), ids.title);
  assert.equal(renamed.name, 'Headline');
  assert.equal(renamed.label, 'Headline');
  assert.ok(!renamed.input, 'the rename input is removed on commit');
  assert.equal(renamed.undoLabel, 'Rename layer', 'renaming is one undo entry');

  /* -------------------------------------------------------- drag → reparent */
  const from = await page.rect(row(ids.tagline));
  const to = await page.rect(row(ids.card));
  await page.drag(from.cx, from.cy, to.cx, to.cy, { steps: 14 });
  await frames(page, 3);
  const dropped = await page.eval((args) => ({
    parent: APB.app.store.node(args.tagline).parent,
    children: APB.app.store.node(args.card).children.slice(),
    selection: APB.app.store.selection.slice(),
    entries: APB.app.store.history().entries.length
  }), ids);
  assert.equal(dropped.parent, ids.card, 'dragging a row into a container reparents the node');
  assert.ok(dropped.children.includes(ids.tagline), 'the node is a child of the drop target');
  assert.deepEqual(dropped.selection, [ids.tagline], 'the dragged node stays selected');
  // one undo step returns it
  await page.key('Mod+Z');
  await frames(page, 2);
  assert.equal(await page.eval((id) => APB.app.store.node(id).parent, ids.tagline), ids.hero, 'one undo restores the parent');
  await page.key('Mod+Shift+Z');
  await frames(page, 2);

  /* ---------------------------------------------------- keyboard navigation */
  await page.click(row(ids.hero));
  await page.key('ArrowDown');
  await frames(page, 1);
  const moved = await page.eval(() => ({
    active: document.activeElement ? document.activeElement.dataset.id : null,
    tab: document.activeElement ? document.activeElement.tabIndex : null,
    selection: APB.app.store.selection.slice()
  }));
  assert.equal(moved.active, ids.card, 'ArrowDown moves the roving focus to the next row');
  assert.equal(moved.tab, 0);
  assert.deepEqual(moved.selection, [ids.hero], 'moving focus does not change the selection');
  await page.key('Enter');
  await frames(page, 1);
  assert.deepEqual(await page.eval(() => APB.app.store.selection.slice()), [ids.card], 'Enter selects the focused row');
  await page.key('ArrowLeft');
  await frames(page, 1);
  assert.equal(await page.eval((id) => document.querySelector('.apb-layer[data-id="' + id + '"]').getAttribute('aria-expanded'), ids.card),
    'false', 'ArrowLeft collapses a container');
  await page.key('ArrowRight');
  await frames(page, 1);
  assert.equal(await page.eval((id) => document.querySelector('.apb-layer[data-id="' + id + '"]').getAttribute('aria-expanded'), ids.card),
    'true', 'ArrowRight expands it again');

  /* --------------------------------------------- Mod+Arrow reorder & menu */
  await page.click(row(ids.title));
  await page.key('Mod+ArrowDown');
  await frames(page, 2);
  const reordered = await page.eval((args) => APB.app.store.node(args.card).children.slice(), ids);
  assert.equal(reordered[1], ids.title, 'Mod+ArrowDown moves the layer one step later in its parent');
  await page.key('Mod+ArrowUp');
  await frames(page, 2);
  assert.equal(await page.eval((args) => APB.app.store.node(args.card).children[0], ids), ids.title, 'Mod+ArrowUp moves it back');

  await page.click(row(ids.title), { button: 'right' });
  await page.waitFor(() => !!document.querySelector('.apb-menu'));
  const menu = await page.eval(() => ({
    labels: Array.from(document.querySelectorAll('.apb-menu .apb-menu-label')).map((el) => el.textContent),
    role: document.querySelector('.apb-menu').getAttribute('role')
  }));
  assert.ok(menu.labels.includes('Rename'), 'the context menu offers Rename');
  assert.ok(menu.labels.includes('Delete') || menu.labels.includes('Duplicate'), 'the context menu mirrors the canvas commands');
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('.apb-menu'));

  /* -------------------------------------------------- drag before a sibling */
  const src = await page.rect(row(ids.tagline));
  const dst = await page.rect(row(ids.title));
  await page.drag(src.cx, src.cy, dst.cx, dst.y + 2, { steps: 12 });
  await frames(page, 3);
  assert.equal(await page.eval((args) => APB.app.store.node(args.card).children[0], ids), ids.tagline,
    'dropping on the top edge of a row inserts before it');
  await page.key('Mod+Z');
  await frames(page, 2);

  /* ---------------------------------------------------------------- search */
  await page.click('.apb-layers-search input');
  await page.type('CTA');
  await page.waitFor(() => document.querySelectorAll('.apb-layers-tree [role="treeitem"]').length === 4);
  const filtered = await page.eval(() => Array.from(document.querySelectorAll('.apb-layers-tree [role="treeitem"]'))
    .map((r) => r.querySelector('.apb-layer-name').textContent));
  assert.equal(filtered.length, 4);
  assert.equal(filtered[filtered.length - 1], 'CTA', 'the match is listed');
  assert.ok(filtered.includes('Hero') && filtered.includes('Card'), 'search keeps the ancestors of a match');
  await page.click('.apb-layers-search .apb-textfield-clear');
  await page.waitFor('document.querySelectorAll(".apb-layers-tree [role=treeitem]").length === ' + total);

  /* --------------------------------------------------------- 300-node perf */
  await page.eval((featuresId) => {
    const app = APB.app;
    const specs = [];
    for (let i = 0; i < 300; i++) {
      specs.push({ type: 'shape', name: 'Box ' + i, x: (i % 12) * 48, y: Math.floor(i / 12) * 48, w: 40, h: 40 });
    }
    app.docops.insert(app, specs, { parent: featuresId, select: false });
  }, ids.features);
  await frames(page, 3);

  const perf = await page.eval(() => {
    const panel = document.querySelector('.apb-layers').apbLayers;
    const tree = document.querySelector('.apb-layers-tree');
    const t0 = performance.now();
    panel.refresh();
    tree.getBoundingClientRect();              // force layout into the measurement
    const renderMs = performance.now() - t0;
    const rows = panel.rowIds();
    const target = rows[rows.length - 1];
    const t1 = performance.now();
    APB.app.store.select([target], 'replace');
    tree.getBoundingClientRect();
    const selectMs = performance.now() - t1;
    return {
      renderMs, selectMs, rows: rows.length, rendered: panel.renderedCount, virtual: panel.virtual,
      selected: document.querySelectorAll('.apb-layer[aria-selected="true"]').length,
      selection: APB.app.store.selection.length
    };
  });
  log('300-node tree: render ' + perf.renderMs.toFixed(1) + ' ms, selection update ' + perf.selectMs.toFixed(1)
    + ' ms, ' + perf.rows + ' rows, ' + perf.rendered + ' in the DOM');
  assert.ok(perf.rows >= total + 300, 'the tree lists every seeded node (' + perf.rows + ')');
  assert.ok(perf.virtual && perf.rendered < perf.rows, 'rows are virtualized above 200 (' + perf.rendered + ' rendered)');
  assert.equal(perf.selection, 1);
  assert.ok(perf.renderMs < 200, 'tree renders in < 200 ms (' + perf.renderMs.toFixed(1) + ' ms)');
  assert.ok(perf.selectMs < 30, 'selection updates in < 30 ms (' + perf.selectMs.toFixed(1) + ' ms)');

  /* --------------------------------------------------------- page switcher */
  const aboutRoot = await page.eval(() => {
    const schema = APB.require('schema');
    const store = APB.app.store;
    const made = schema.createPage(store.doc, 'About');
    store.transact('Add page', (tx) => {
      tx.set(['nodes', made.root.id], made.root);
      tx.setDocField('pages', store.doc.pages.concat(made.page));
    });
    return { page: made.page.id, root: made.root.id };
  });
  await page.waitFor(() => !document.querySelector('.apb-layers-head').hidden);
  const switcher = await page.eval(() => {
    const sel = document.querySelector('.apb-layers-page select');
    return {
      label: sel.getAttribute('aria-label'),
      options: Array.from(sel.options).filter((o) => !o.hidden).map((o) => o.textContent)
    };
  });
  assert.equal(switcher.label, 'Page', 'the page switcher is labelled');
  assert.deepEqual(switcher.options, ['Home', 'About'], 'the switcher lists every page');
  await page.eval((pageId) => APB.app.store.setView({ pageId, context: null }), aboutRoot.page);
  await page.waitFor(() => document.querySelectorAll('.apb-layers-tree [role="treeitem"]').length === 1);
  assert.equal(await page.eval(() => document.querySelector('.apb-layers-tree [role="treeitem"]').dataset.id), aboutRoot.root,
    'switching pages retargets the tree');

  await page.screenshot('layers-panel');
}

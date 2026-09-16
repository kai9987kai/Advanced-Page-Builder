// Canvas (B1b-2): drawing tools, stack reorder, drop-to-reparent and the keyboard model.
// Draw a rect by dragging, click the text tool (creates + edits), add a section, reorder sections by
// dragging, nudge with the arrow keys (one history entry per burst), Tab through siblings and drag a
// shape from one frame into another keeping its position.
export const name = 'canvas drawing tools, reorder, reparent and keyboard';
export const viewport = { width: 1400, height: 900 };
// The unrecognized-.json-drop step below intentionally triggers services.importers.fromFile()'s
// error path (features/importers.js) and interaction.js logs it via console.error before toasting.
export const allowErrors = [/import failed: Error: Unrecognized project file/];

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => { if (--left <= 0) resolve(true); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.eval(() => window.APB.app.ui.unregisterPanel('design'));   // keep the canvas at its full width
  await page.waitFor(() => !!(window.APB.app.canvas && window.APB.app.canvas.interaction && document.querySelector('.apb-viewport .apb-artboard')));
  await frames(page, 3);

  /* ------------------------------------------------------------- setup */
  const setup = await page.eval(() => {
    const app = window.APB.app;
    const doc = app.store.doc;
    const root = doc.nodes[doc.pages[0].root];
    const section = root.children.find((id) => doc.nodes[id].type === 'section');
    app.store.setPrefs({ snap: { objects: false, grid: false } });
    app.store.select([]);
    app.store.clearHistory();
    const vp = app.canvas.viewport;
    vp.setZoom(1);
    const cr = vp.contentRect();
    const origin = vp.pageToScreen(0, 0);
    vp.panBy(cr.left + 30 - origin.x, cr.top + 30 - origin.y);
    const ids = (prefix) => app.commands.list().filter((c) => c.id.indexOf(prefix) === 0).map((c) => c.id).sort();
    return { root: root.id, section, tools: ids('tool.'), select: ids('select.') };
  });
  const { root, section } = setup;
  assert.deepEqual(setup.tools, [
    'tool.button', 'tool.checklist', 'tool.ellipse', 'tool.frame', 'tool.hand', 'tool.image', 'tool.line', 'tool.rect', 'tool.section',
    'tool.select', 'tool.text'
  ], 'every tool command is registered');
  assert.deepEqual(setup.select, ['select.all', 'select.child', 'select.next', 'select.none', 'select.parent', 'select.prev'],
    'the selection commands are registered');
  await frames(page, 2);

  const toScreen = (x, y) => page.eval((px, py) => window.APB.app.canvas.viewport.pageToScreen(px, py), x, y);
  const center = (id) => page.eval((nid) => {
    const r = window.APB.app.canvas.renderer.worldRect(nid);
    return window.APB.app.canvas.viewport.pageToScreen(r.x + r.w / 2, r.y + r.h / 2);
  }, id);
  const world = (id) => page.eval((nid) => window.APB.app.canvas.renderer.worldRect(nid), id);
  const node = (id) => page.eval((nid) => {
    const n = window.APB.app.store.doc.nodes[nid];
    return n ? { type: n.type, parent: n.parent, x: n.x, y: n.y, w: n.w, h: n.h, props: n.props } : null;
  }, id);
  const histIndex = () => page.eval(() => window.APB.app.store.history().index);
  const tool = (id) => page.eval((cid) => { window.APB.app.commands.run(cid); return window.APB.app.store.view.tool; }, id);
  const clickAt = async (p) => {
    await page.mouse('move', p.x, p.y);
    await page.mouse('down', p.x, p.y);
    await page.mouse('up', p.x, p.y);
  };
  const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

  /* --------------------------------------------------- draw a rectangle */
  assert.equal(await tool('tool.rect'), 'rect', 'tool.rect activates the rectangle tool');
  let h0 = await histIndex();
  let p1 = await toScreen(120, 120);
  let p2 = await toScreen(260, 220);
  await page.drag(p1.x, p1.y, p2.x, p2.y, { steps: 10 });
  const drawn = await page.eval(() => {
    const app = window.APB.app;
    const id = app.store.selection[0];
    const n = app.store.doc.nodes[id];
    return { id, type: n.type, shape: n.props.shape, parent: n.parent, r: app.canvas.renderer.worldRect(id), tool: app.store.view.tool };
  });
  assert.equal(drawn.type, 'shape', 'a shape node was created');
  assert.equal(drawn.shape, 'rect', 'with the rectangle shape');
  assert.equal(drawn.parent, section, 'inside the section under the pointer');
  assert.ok(near(drawn.r.x, 120) && near(drawn.r.y, 120) && near(drawn.r.w, 140) && near(drawn.r.h, 100),
    'the node matches the dragged rect: ' + JSON.stringify(drawn.r));
  assert.equal(drawn.tool, 'select', 'the tool returns to select afterwards');
  assert.equal(await histIndex(), h0 + 1, 'drawing is one history entry');
  const rectId = drawn.id;

  /* ------------------------------------------- click the text tool = edit */
  assert.equal(await tool('tool.text'), 'text');
  await clickAt(await toScreen(420, 300));
  await page.waitFor(() => !!window.APB.app.store.view.editingText, 2000);
  const textInfo = await page.eval(() => {
    const app = window.APB.app;
    const id = app.store.view.editingText;
    return { id, type: app.store.doc.nodes[id].type, r: app.canvas.renderer.worldRect(id), tool: app.store.view.tool };
  });
  assert.equal(textInfo.type, 'text', 'the text tool creates a text node');
  assert.ok(near(textInfo.r.x + textInfo.r.w / 2, 420, 2) && near(textInfo.r.y + textInfo.r.h / 2, 300, 2),
    'the default-size node is centred on the click: ' + JSON.stringify(textInfo.r));
  await page.key('Escape');
  await page.waitFor(() => !window.APB.app.store.view.editingText, 2000);

  /* ------------------------------------------------- section tool adds one */
  assert.equal(await tool('tool.section'), 'section');
  h0 = await histIndex();
  p1 = await toScreen(200, 680);
  p2 = await toScreen(700, 800);
  await page.drag(p1.x, p1.y, p2.x, p2.y, { steps: 8 });
  const sections = await page.eval((rootId) => {
    const app = window.APB.app;
    const kids = app.store.doc.nodes[rootId].children;
    const last = kids[kids.length - 1];
    return { count: kids.length, last, type: app.store.doc.nodes[last].type, h: app.store.doc.nodes[last].h, kids: kids.slice() };
  }, root);
  assert.equal(sections.count, 2, 'a second section was appended to the page root');
  assert.equal(sections.type, 'section', 'it is a section');
  assert.ok(sections.h >= 40, 'the drawn height is kept: ' + sections.h);
  assert.equal(await histIndex(), h0 + 1, 'one history entry for the section');
  const section2 = sections.last;
  assert.equal(sections.kids[1], section2, 'it was appended below the first section');
  await frames(page, 2);
  await page.screenshot('drawn-nodes');

  /* ------------------------------------------------ reorder in the stack */
  const stack = await page.eval((sec) => {
    const app = window.APB.app;
    const frame = app.docops.insert(app.store, [{
      type: 'frame', name: 'Stack', x: 760, y: 60, w: 300, h: 380,
      layout: { mode: 'stack', dir: 'column', gap: 12, pad: [12, 12, 12, 12] }, style: { fill: '#f1f5f9' }
    }], { parent: sec, select: false })[0];
    const kids = app.docops.insert(app.store, [
      { type: 'shape', name: 'One', w: 200, h: 80, style: { fill: '#93c5fd' } },
      { type: 'shape', name: 'Two', w: 200, h: 80, style: { fill: '#fca5a5' } },
      { type: 'shape', name: 'Three', w: 200, h: 80, style: { fill: '#86efac' } }
    ], { parent: frame, select: false });
    app.store.select([kids[0]]);
    app.store.clearHistory();
    return { frame, kids };
  }, section);
  await frames(page, 3);
  h0 = await histIndex();
  const one = await center(stack.kids[0]);
  const threeBox = await world(stack.kids[2]);
  const below = await toScreen(threeBox.x + threeBox.w / 2, threeBox.y + threeBox.h - 4);
  await page.mouse('move', one.x, one.y);
  await page.mouse('down', one.x, one.y);
  for (let i = 1; i <= 8; i++) {
    await page.mouse('move', one.x + ((below.x - one.x) * i) / 8, one.y + ((below.y - one.y) * i) / 8);
  }
  await frames(page, 2);
  const indicator = await page.eval(() => {
    const p = document.querySelector('.apb-overlay .apb-ov-indicator');
    return { drawn: !!p && p.getAttribute('display') !== 'none' && (p.getAttribute('d') || '').length > 0, gesture: window.APB.app.canvas.interaction.gestureName };
  });
  await page.screenshot('reorder-indicator');
  await page.mouse('up', below.x, below.y);
  assert.equal(indicator.gesture, 'reorder', 'dragging a stack child runs the reorder gesture');
  assert.ok(indicator.drawn, 'the insertion indicator is drawn');
  const order = await page.eval((fid) => window.APB.app.store.doc.nodes[fid].children.slice(), stack.frame);
  assert.deepEqual(order, [stack.kids[1], stack.kids[2], stack.kids[0]], 'the dragged child moved to the end of the stack');
  assert.equal(await histIndex(), h0 + 1, 'the reorder is one history entry');
  await page.eval(() => window.APB.app.store.undo());
  assert.deepEqual(await page.eval((fid) => window.APB.app.store.doc.nodes[fid].children.slice(), stack.frame), stack.kids, 'undo restores the order');

  /* ----------------------------------------------------- keyboard nudge */
  const before = await node(rectId);
  await page.eval((id) => { window.APB.app.store.select([id]); window.APB.app.canvas.el.focus(); }, rectId);
  h0 = await histIndex();
  await page.key('ArrowRight', null, { repeat: 5 });
  let after = await node(rectId);
  assert.equal(after.x, before.x + 5, 'five arrow presses nudge 5 px');
  assert.equal(await histIndex(), h0 + 1, 'the burst is one history entry');
  await page.key('ArrowDown', ['Shift']);
  after = await node(rectId);
  assert.equal(after.y, before.y + 10, 'Shift+Arrow nudges 10 px');
  assert.equal(await histIndex(), h0 + 2, 'the second burst is its own entry');
  await page.eval(() => window.APB.app.store.undo());
  await page.eval(() => window.APB.app.store.undo());
  after = await node(rectId);
  assert.ok(after.x === before.x && after.y === before.y, 'undo restores both bursts');

  /* -------------------------------------------------- Tab through siblings */
  const siblings = await page.eval((sec) => window.APB.app.store.doc.nodes[sec].children.slice(), section);
  await page.eval((id) => { window.APB.app.store.select([id]); window.APB.app.canvas.el.focus(); }, rectId);
  await page.key('Tab');
  const next = await page.eval(() => window.APB.app.store.selection.slice());
  const expected = siblings[(siblings.indexOf(rectId) + 1) % siblings.length];
  assert.deepEqual(next, [expected], 'Tab selects the next sibling');
  await page.key('Tab', ['Shift']);
  assert.deepEqual(await page.eval(() => window.APB.app.store.selection.slice()), [rectId], 'Shift+Tab goes back');
  await page.waitFor(() => {
    const live = document.querySelector('[aria-live="polite"]');
    return !!live && /^Selected .+, .+/.test(live.textContent || '');
  }, 2000);

  /* ---------------------------------- Enter / Shift+Enter walk the tree */
  await page.eval((sec) => { window.APB.app.store.select([sec]); window.APB.app.canvas.el.focus(); }, section);
  await page.key('Enter');
  const child = await page.eval(() => window.APB.app.store.selection.slice());
  assert.equal(child.length, 1, 'Enter selects a child of the section');
  assert.ok(siblings.indexOf(child[0]) !== -1, 'the child belongs to the section');
  await page.key('Enter', ['Shift']);
  assert.deepEqual(await page.eval(() => window.APB.app.store.selection.slice()), [section], 'Shift+Enter selects the parent again');
  await page.key('Escape');
  assert.deepEqual(await page.eval(() => window.APB.app.store.selection.slice()), [], 'Escape on a top-level node clears the selection');

  /* ------------------------------------------- reparent keeps the position */
  const built = await page.eval((sec) => {
    const app = window.APB.app;
    const [fa, fb] = app.docops.insert(app.store, [
      { type: 'frame', name: 'Frame A', x: 60, y: 60, w: 220, h: 200, style: { fill: '#e2e8f0' } },
      { type: 'frame', name: 'Frame B', x: 460, y: 60, w: 220, h: 200, style: { fill: '#fee2e2' } }
    ], { parent: sec, select: false });
    const shape = app.docops.insert(app.store, [{ type: 'shape', name: 'Travels', x: 20, y: 20, w: 60, h: 60, style: { fill: '#2563eb' } }], { parent: fa, select: true })[0];
    app.store.clearHistory();
    return { fa, fb, shape };
  }, section);
  await frames(page, 3);
  const startWorld = await world(built.shape);
  const bWorld = await world(built.fb);
  const dropPage = { x: bWorld.x + 120, y: bWorld.y + 110 };
  const shapeCenter = await center(built.shape);
  const dropScreen = await toScreen(dropPage.x, dropPage.y);
  h0 = await histIndex();
  await page.mouse('move', shapeCenter.x, shapeCenter.y);
  await page.mouse('down', shapeCenter.x, shapeCenter.y);
  for (let i = 1; i <= 10; i++) {
    await page.mouse('move', shapeCenter.x + ((dropScreen.x - shapeCenter.x) * i) / 10, shapeCenter.y + ((dropScreen.y - shapeCenter.y) * i) / 10);
  }
  await frames(page, 2);
  const highlight = await page.eval(() => {
    const p = document.querySelector('.apb-overlay .apb-ov-highlight');
    return !!p && p.getAttribute('display') !== 'none' && (p.getAttribute('d') || '').length > 0;
  });
  await page.screenshot('reparent-highlight');
  await page.mouse('up', dropScreen.x, dropScreen.y);
  await frames(page, 2);
  const moved = await node(built.shape);
  const movedWorld = await world(built.shape);
  assert.ok(highlight, 'the target container is highlighted while dragging over it');
  assert.equal(moved.parent, built.fb, 'the shape was reparented into Frame B');
  assert.ok(near(movedWorld.x + movedWorld.w / 2, dropPage.x, 2) && near(movedWorld.y + movedWorld.h / 2, dropPage.y, 2),
    'it kept its dropped position: ' + JSON.stringify(movedWorld) + ' vs ' + JSON.stringify(dropPage));
  assert.ok(near(movedWorld.w, startWorld.w) && near(movedWorld.h, startWorld.h), 'and its size');
  assert.equal(await histIndex(), h0 + 1, 'move + reparent is one history entry');
  await page.eval(() => window.APB.app.store.undo());
  assert.equal((await node(built.shape)).parent, built.fa, 'undo puts it back in Frame A');
  /* -------------------------------------------- Alt hover measures gaps */
  await page.eval((id) => window.APB.app.store.select([id]), built.fa);
  await frames(page, 2);
  const bCenter = await center(built.fb);
  await page.mouse('move', bCenter.x - 8, bCenter.y - 8, { modifiers: ['Alt'] });
  await page.mouse('move', bCenter.x, bCenter.y, { modifiers: ['Alt'] });
  const measured = await page.waitFor(() => {
    const path = document.querySelector('.apb-overlay .apb-ov-measure');
    const label = document.querySelector('.apb-overlay .apb-ov-measure-label text');
    const drawn = path && path.getAttribute('display') !== 'none' && (path.getAttribute('d') || '').length > 0;
    return drawn && label ? label.textContent : null;
  }, 2000);
  assert.equal(measured, '180', 'Alt-hover labels the 180 px gap between the frames');
  await page.screenshot('alt-measure');
  await page.mouse('move', bCenter.x, bCenter.y);
  await page.waitFor(() => {
    const path = document.querySelector('.apb-overlay .apb-ov-measure');
    return !path || path.getAttribute('display') === 'none';
  }, 2000);

  /* ------------------------------------------------- drop files on the canvas */
  const dropAt = await toScreen(700, 500);
  await page.eval((x, y) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAG0lEQVR42mNk+M9QzzCKRsEoGgWjYBSMglEwCgYAJsQD/a0lGJcAAAAASUVORK5CYII=';
    const bin = atob(png);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const el = window.APB.app.canvas.el;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    el.dispatchEvent(new DragEvent('dragover', opts));
    el.dispatchEvent(new DragEvent('drop', opts));
  }, dropAt.x, dropAt.y);
  const image = await page.waitFor(() => {
    const app = window.APB.app;
    const id = app.store.selection[0];
    const n = id ? app.store.doc.nodes[id] : null;
    if (!n || n.type !== 'image') return null;
    // services.assets (features/assets.js) is registered, so dropped images become an asset
    // reference (props.asset) rather than an inline props.src data URL — see assetProps() in
    // canvas/interaction.js.
    const svc = app.services && app.services.assets;
    const src = n.props.asset && svc ? svc.url(n.props.asset) : n.props.src;
    if (!src) return null;
    const r = app.canvas.renderer.worldRect(id);
    return { id, w: n.w, h: n.h, src: src.slice(0, 15), cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
  }, 4000);
  assert.equal(image.src, 'data:image/png;', 'the dropped image became a data URL');
  assert.ok(image.w === 8 && image.h === 8, 'the natural size is used: ' + image.w + '×' + image.h);
  assert.ok(near(image.cx, 700, 2) && near(image.cy, 500, 2), 'placed at the drop point');

  // services.importers (features/importers.js) is loaded, so this now goes through fromFile()
  // rather than the "no importer" fallback; the fixture is deliberately not a recognizable project
  // (missing `pages`) so it fails gracefully without touching the document, keeping the rest of
  // this scenario's node/selection state intact for the steps that follow.
  const jsonDrop = await page.eval((x, y) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{"format":"apb"}'], 'project.apb.json', { type: 'application/json' }));
    const el = window.APB.app.canvas.el;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt };
    const before = Object.keys(window.APB.app.store.doc.nodes).length;
    el.dispatchEvent(new DragEvent('drop', opts));
    return { before, after: Object.keys(window.APB.app.store.doc.nodes).length };
  }, dropAt.x, dropAt.y);
  assert.equal(jsonDrop.after, jsonDrop.before, 'an unrecognized .json drop inserts nothing');
  const toastText = await page.waitFor(() => {
    const all = Array.from(document.querySelectorAll('.apb-toast')).map((t) => t.textContent).join(' | ');
    return /could not import/i.test(all) ? all : null;
  }, 2000);
  assert.ok(/could not import/i.test(toastText), 'it explains the import failed: ' + toastText);

  /* --------------------------------------------- touch long-press menu */
  const pressAt = await center(stack.kids[0]);
  const longPress = await page.eval((x, y) => new Promise((resolve) => {
    const app = window.APB.app;
    let done = false;
    app.on('canvas:contextmenu', (p) => { if (!done) { done = true; resolve({ nodeId: p.nodeId, pointerType: p.pointerType }); } });
    const el = app.canvas.el;
    const opts = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    setTimeout(() => {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { buttons: 0 })));
      if (!done) { done = true; resolve(null); }
    }, 1200);
  }), pressAt.x, pressAt.y);
  assert.ok(longPress, 'a 500 ms touch press opens the context menu');
  assert.equal(longPress.nodeId, stack.kids[0], 'for the node under the finger');
  assert.equal(longPress.pointerType, 'touch', 'and reports the pointer type');

  log('tools, reorder, reparent, keyboard, Alt measurement, file drops and long-press verified');
}

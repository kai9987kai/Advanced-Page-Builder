// Canvas (B1b-1): overlay + pointer interaction — click/Shift selection, marquee, move (one undo entry),
// snapping guides, Shift-resize keeps aspect, Shift-rotate snaps, Alt-drag duplicates, Escape cancels,
// double-click text edit, context menu, hover, locked nodes and a 500-node drag timing log.
export const name = 'canvas pointer interaction and overlay';
export const viewport = { width: 1440, height: 900 };

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => { if (--left <= 0) resolve(true); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.waitFor(() => !!(window.APB.app.canvas && window.APB.app.canvas.interaction && document.querySelector('.apb-viewport .apb-artboard')));
  await frames(page, 3);

  /* ------------------------------------------------------------- setup */
  const setup = await page.eval(() => {
    const app = window.APB.app;
    const doc = app.store.doc;
    const root = doc.nodes[doc.pages[0].root];
    const section = root.children.find((id) => doc.nodes[id].type === 'section');
    const [a, b, c] = app.docops.insert(app.store, [
      { type: 'shape', name: 'A', x: 100, y: 100, w: 120, h: 80, style: { fill: '#3b82f6' } },
      { type: 'shape', name: 'B', x: 400, y: 100, w: 120, h: 80, style: { fill: '#10b981' } },
      { type: 'shape', name: 'C', x: 100, y: 300, w: 120, h: 80, style: { fill: '#f59e0b' } }
    ], { parent: section, select: false });
    const t = app.docops.insert(app.store, [{ type: 'text', name: 'T', x: 300, y: 460, w: 240, h: 40, props: { text: 'Edit me' } }], { parent: section, select: false })[0];
    app.store.clearHistory();
    const vp = app.canvas.viewport;
    vp.setZoom(1);
    const cr = vp.contentRect();
    const origin = vp.pageToScreen(0, 0);
    vp.panBy(cr.left + 40 - origin.x, cr.top + 40 - origin.y);
    return { section, a, b, c, t, overlay: typeof app.canvas.overlay.hitTest === 'function' };
  });
  assert.ok(setup.overlay, 'overlay module mounted');
  await frames(page, 3);
  const { section, a, b, c, t } = setup;

  const center = (id) => page.eval((nid) => {
    const cv = window.APB.app.canvas;
    const r = cv.renderer.worldRect(nid);
    return cv.viewport.pageToScreen(r.x + r.w / 2, r.y + r.h / 2);
  }, id);
  const toScreen = (x, y) => page.eval((px, py) => window.APB.app.canvas.viewport.pageToScreen(px, py), x, y);
  const box = (id) => page.eval((nid) => {
    const n = window.APB.app.store.doc.nodes[nid];
    return { x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation || 0 };
  }, id);
  const sel = () => page.eval(() => window.APB.app.store.selection.slice());
  const histIndex = () => page.eval(() => window.APB.app.store.history().index);
  const undo = () => page.eval(() => window.APB.app.store.undo());
  const clickAt = async (p, modifiers) => {
    await page.mouse('move', p.x, p.y, { modifiers });
    await page.mouse('down', p.x, p.y, { modifiers });
    await page.mouse('up', p.x, p.y, { modifiers });
  };

  /* ------------------------------------------------------ click select */
  const ca = await center(a);
  await clickAt(ca);
  assert.deepEqual(await sel(), [a], 'click selects A');
  await frames(page, 2);
  const ov = await page.eval(() => {
    const o = window.APB.app.canvas.overlay;
    const svg = document.querySelector('.apb-overlay');
    return {
      handles: o.handlesVisible,
      box: !!svg.querySelector('.apb-ov-box:not([display])'),
      label: svg.querySelector('.apb-ov-size text').textContent
    };
  });
  assert.ok(ov.handles && ov.box, 'selection box and handles drawn');
  assert.equal(ov.label, '120 × 80', 'size label');

  /* ------------------------------------------------------ Shift toggle */
  await clickAt(await center(b), ['Shift']);
  assert.deepEqual((await sel()).sort(), [a, b].sort(), 'Shift+click adds B');
  await clickAt(ca, ['Shift']);
  assert.deepEqual(await sel(), [b], 'Shift+click on selected A removes it');

  /* ----------------------------------------------------------- marquee */
  const m1 = await toScreen(70, 70);
  const m2 = await toScreen(560, 200);
  await page.drag(m1.x, m1.y, m2.x, m2.y, { steps: 10 });
  assert.deepEqual((await sel()).sort(), [a, b].sort(), 'marquee inside the section selects A and B (not C)');
  const marqueeGone = await page.eval(() => window.APB.app.canvas.overlay.state.marquee === null);
  assert.ok(marqueeGone, 'marquee cleared after release');
  await frames(page, 2);
  await page.screenshot('multi-selection');

  /* -------------------------------------------- drag moves, one history */
  await clickAt(ca);
  assert.deepEqual(await sel(), [a], 'A selected again');
  let h0 = await histIndex();
  await page.drag(ca.x, ca.y, ca.x + 37, ca.y + 23, { steps: 12 });
  let bx = await box(a);
  assert.equal(bx.x, 137, 'moved x');
  assert.equal(bx.y, 123, 'moved y');
  assert.equal(await histIndex(), h0 + 1, 'exactly one history entry for the drag');
  await undo();
  bx = await box(a);
  assert.ok(bx.x === 100 && bx.y === 100, 'undo restores the position');

  /* ------------------------------------------------ snapping + guides */
  await page.mouse('move', ca.x, ca.y);
  await page.mouse('down', ca.x, ca.y);
  for (let i = 1; i <= 10; i++) await page.mouse('move', ca.x + 14 * i, ca.y + 0.4 * i);
  await frames(page, 2);
  const snapInfo = await page.eval((bid) => {
    const app = window.APB.app;
    const st = app.canvas.overlay.state;
    const path = document.querySelector('.apb-overlay .apb-ov-guide');
    return { guides: st.guides, drawn: !!path && path.getAttribute('display') !== 'none' && (path.getAttribute('d') || '').length > 0, bTop: app.store.doc.nodes[bid].y };
  }, b);
  await page.screenshot('snap-guides');
  await page.mouse('up', ca.x + 140, ca.y + 4);
  bx = await box(a);
  assert.equal(bx.y, 100, 'y snapped to the sibling top edge (proposed 104)');
  assert.equal(bx.x, 240, 'x unaffected by snapping');
  assert.ok(snapInfo.guides.some((g) => g.axis === 'y' && Math.abs(g.pos - snapInfo.bTop) < 0.01), 'horizontal guide at B top: ' + JSON.stringify(snapInfo.guides));
  assert.ok(snapInfo.drawn, 'guide path drawn in the overlay');
  await undo();

  /* ------------------------------------------- Mod bypasses snapping */
  await page.drag(ca.x, ca.y, ca.x + 140, ca.y + 4, { steps: 10, modifiers: ['Mod'] });
  bx = await box(a);
  assert.equal(bx.y, 104, 'holding Mod disables snapping');
  await undo();

  /* ------------------------------------------ resize se + Shift aspect */
  await frames(page, 2);
  let hp = await page.eval(() => window.APB.app.canvas.overlay.handlePoints());
  h0 = await histIndex();
  await page.drag(hp.se.x, hp.se.y, hp.se.x + 60, hp.se.y + 10, { steps: 10, modifiers: ['Shift'] });
  bx = await box(a);
  assert.ok(bx.w > 150, 'resized wider: ' + JSON.stringify(bx));
  assert.ok(Math.abs(bx.w / bx.h - 1.5) < 0.02, 'Shift keeps aspect 3:2: ' + JSON.stringify(bx));
  assert.ok(bx.x === 100 && bx.y === 100, 'nw corner anchored');
  assert.equal(await histIndex(), h0 + 1, 'one history entry for the resize');
  await undo();

  /* ----------------------------------------------- plain resize (e) */
  await frames(page, 2);
  hp = await page.eval(() => window.APB.app.canvas.overlay.handlePoints());
  const eMid = { x: (hp.ne.x + hp.se.x) / 2, y: (hp.ne.y + hp.se.y) / 2 };
  await page.drag(eMid.x, eMid.y, eMid.x + 31, eMid.y + 40, { steps: 8 });
  bx = await box(a);
  assert.ok(bx.w === 151 && bx.h === 80, 'east handle changes only width: ' + JSON.stringify(bx));
  await undo();

  /* ---------------------------------------------- rotate + Shift snap */
  await frames(page, 2);
  hp = await page.eval(() => window.APB.app.canvas.overlay.handlePoints());
  h0 = await histIndex();
  const R = Math.hypot(hp.rotate.x - hp.center.x, hp.rotate.y - hp.center.y);
  const ang = (310 * Math.PI) / 180;
  const rotTarget = { x: hp.center.x + R * Math.cos(ang), y: hp.center.y + R * Math.sin(ang) };
  await page.mouse('move', hp.rotate.x, hp.rotate.y);
  await page.mouse('down', hp.rotate.x, hp.rotate.y, { modifiers: ['Shift'] });
  for (let i = 1; i <= 10; i++) {
    const a1 = ((270 + 4 * i) * Math.PI) / 180;
    await page.mouse('move', hp.center.x + R * Math.cos(a1), hp.center.y + R * Math.sin(a1), { modifiers: ['Shift'] });
  }
  await frames(page, 1);
  const tip = await page.eval(() => {
    const g = document.querySelector('.apb-overlay .apb-ov-tip');
    return g && g.getAttribute('display') !== 'none' ? g.querySelector('text').textContent : null;
  });
  await page.mouse('up', rotTarget.x, rotTarget.y, { modifiers: ['Shift'] });
  bx = await box(a);
  assert.equal(bx.rotation, 45, 'Shift snaps rotation to 15° steps (40° → 45°)');
  assert.equal(tip, '45°', 'rotation tooltip shows the angle');
  assert.equal(await histIndex(), h0 + 1, 'one history entry for the rotation');
  await undo();

  /* ------------------------------------------------- Alt-drag duplicate */
  const count0 = await page.eval(() => Object.keys(window.APB.app.store.doc.nodes).length);
  h0 = await histIndex();
  await page.drag(ca.x, ca.y, ca.x + 13, ca.y + 250, { steps: 12, modifiers: ['Alt'] });
  const dup = await page.eval((aid) => {
    const s = window.APB.app.store;
    const id = s.selection[0];
    const n = s.doc.nodes[id];
    return { count: Object.keys(s.doc.nodes).length, id, x: n.x, y: n.y, orig: { x: s.doc.nodes[aid].x, y: s.doc.nodes[aid].y } };
  }, a);
  assert.equal(dup.count, count0 + 1, 'Alt+drag duplicated A');
  assert.ok(dup.id !== a, 'the copy is selected');
  assert.ok(dup.x === 113 && dup.y === 350, 'copy moved: ' + JSON.stringify(dup));
  assert.ok(dup.orig.x === 100 && dup.orig.y === 100, 'original stays');
  assert.equal(await histIndex(), h0 + 1, 'duplicate + move is one history entry');
  await undo();
  assert.equal(await page.eval(() => Object.keys(window.APB.app.store.doc.nodes).length), count0, 'undo removes the copy');

  /* ------------------------------------------------ Escape cancels drag */
  await clickAt(ca);
  h0 = await histIndex();
  await page.mouse('move', ca.x, ca.y);
  await page.mouse('down', ca.x, ca.y);
  for (let i = 1; i <= 6; i++) await page.mouse('move', ca.x + 9 * i, ca.y + 11 * i);
  const mid = await box(a);
  assert.ok(mid.x !== 100 || mid.y !== 100, 'moving during the drag');
  await page.key('Escape');
  await page.mouse('up', ca.x + 54, ca.y + 66);
  bx = await box(a);
  assert.ok(bx.x === 100 && bx.y === 100, 'Escape restored the position: ' + JSON.stringify(bx));
  assert.equal(await histIndex(), h0, 'no history entry left after cancel');
  assert.deepEqual(await sel(), [a], 'selection kept');

  /* -------------------------------------------- double-click text edit */
  const ct = await center(t);
  await page.mouse('move', ct.x, ct.y);
  await page.mouse('down', ct.x, ct.y, { clickCount: 1 });
  await page.mouse('up', ct.x, ct.y, { clickCount: 1 });
  await page.mouse('down', ct.x, ct.y, { clickCount: 2 });
  await page.mouse('up', ct.x, ct.y, { clickCount: 2 });
  await page.waitFor('window.APB.app.store.view.editingText === ' + JSON.stringify(t), 2000);
  await frames(page, 2);
  const editHandles = await page.eval(() => window.APB.app.canvas.overlay.handlesVisible);
  assert.equal(editHandles, false, 'handles hidden while editing text');
  await page.key('Escape');
  await page.waitFor(() => !window.APB.app.store.view.editingText, 2000);

  /* ------------------------------------------------------ hover + menu */
  const cc = await center(c);
  await page.mouse('move', cc.x - 5, cc.y - 5);
  await page.mouse('move', cc.x, cc.y);
  await page.waitFor('window.APB.app.store.view.hover === ' + JSON.stringify(c), 2000);
  await page.eval(() => { window.__ctx = null; window.APB.app.on('canvas:contextmenu', (p) => { window.__ctx = p; }); });
  await page.mouse('down', cc.x, cc.y, { button: 'right' });
  await page.mouse('up', cc.x, cc.y, { button: 'right' });
  await page.waitFor(() => !!window.__ctx, 2000);
  const ctxInfo = await page.eval(() => ({ p: window.__ctx, sel: window.APB.app.store.selection.slice() }));
  assert.equal(ctxInfo.p.nodeId, c, 'context menu payload names the node');
  assert.deepEqual(ctxInfo.sel, [c], 'right-click selects the node under the pointer');
  await page.key('Escape');

  /* ------------------------------------------------------------ locked */
  await page.eval((bid) => window.APB.app.docops.setLocked(window.APB.app.store, [bid], true), b);
  const cb = await center(b);
  await clickAt(cb);
  assert.deepEqual(await sel(), [b], 'locked node is selectable');
  await frames(page, 2);
  const lockInfo = await page.eval(() => ({
    handles: window.APB.app.canvas.overlay.handlesVisible,
    badge: !!document.querySelector('.apb-overlay .apb-ov-badge:not([display])')
  }));
  assert.equal(lockInfo.handles, false, 'no handles on a locked node');
  assert.ok(lockInfo.badge, 'lock badge drawn');
  await page.drag(cb.x, cb.y, cb.x + 50, cb.y + 30, { steps: 8 });
  bx = await box(b);
  assert.ok(bx.x === 400 && bx.y === 100, 'locked node does not move');
  await page.screenshot('selection');

  /* ------------------------------------------------ 500-node drag perf */
  const perfSetup = await page.eval((sid) => {
    const app = window.APB.app;
    app.store.select([]);
    const specs = [];
    for (let i = 0; i < 500; i++) {
      specs.push({ type: 'shape', x: 600 + (i % 25) * 30, y: 20 + Math.floor(i / 25) * 30, w: 24, h: 24, style: { fill: '#6366f1' } });
    }
    const ids = app.docops.insert(app.store, specs, { parent: sid, select: false });
    app.store.clearHistory();
    return ids;
  }, section);
  await frames(page, 3);
  const measureDrag = async (selectIds, fromId) => {
    await page.eval((ids) => {
      const app = window.APB.app;
      app.store.select(ids);
      const cv = app.canvas;
      cv.interaction.perf.reset();
      const stats = { frames: 0, render: 0, overlay: 0, maxFrame: 0 };
      window.__perfFrame = stats;
      if (!cv.__perfWrapped) {
        cv.__perfWrapped = true;
        const r = cv.renderer;
        const flush = r.flush;
        r.flush = function () {
          const t0 = performance.now();
          const out = flush.apply(this, arguments);
          if (out && window.__perfFrame) window.__perfFrame.render += performance.now() - t0;
          return out;
        };
        const ovl = cv.overlay;
        const refresh = ovl.refresh;
        ovl.refresh = function () {
          const t0 = performance.now();
          const out = refresh.apply(this, arguments);
          const dt = performance.now() - t0;
          if (window.__perfFrame) { window.__perfFrame.overlay += dt; window.__perfFrame.frames++; }
          return out;
        };
      }
    }, selectIds);
    await frames(page, 2);
    await page.eval(() => { const s = window.__perfFrame; s.frames = 0; s.render = 0; s.overlay = 0; });
    const p = await center(fromId);
    await page.drag(p.x, p.y, p.x + 90, p.y + 60, { steps: 30 });
    await frames(page, 2);
    return page.eval(() => ({ move: window.APB.app.canvas.interaction.perf.stats, frame: Object.assign({}, window.__perfFrame) }));
  };
  const one = await measureDrag([perfSetup[0]], perfSetup[0]);
  const all = await measureDrag(perfSetup, perfSetup[0]);
  const fmtStats = (s) => 'pointermove avg ' + s.move.avg.toFixed(2) + ' ms, p95 ' + s.move.p95.toFixed(2) + ' ms, max ' + s.move.max.toFixed(2) +
    ' ms (' + s.move.count + ' moves); per frame render ' + (s.frame.frames ? (s.frame.render / s.frame.frames).toFixed(2) : '0') +
    ' ms + overlay ' + (s.frame.frames ? (s.frame.overlay / s.frame.frames).toFixed(2) : '0') + ' ms (' + s.frame.frames + ' frames)';
  log('500-node drag, 1 selected: ' + fmtStats(one));
  log('500-node drag, 500 selected: ' + fmtStats(all));
  assert.ok(one.move.count > 10 && all.move.count > 10, 'drag gestures ran');
  assert.ok(one.move.avg < 16, 'dragging one node among 500 stays under 16 ms per pointermove');
  assert.ok(all.move.avg < 50, 'dragging 500 nodes stays under 50 ms per pointermove');
  const moved = await page.eval((ids) => window.APB.app.store.doc.nodes[ids[499]].x, perfSetup);
  assert.ok(moved !== 600 + 24 * 30, 'all 500 nodes moved');
}

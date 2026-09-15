// Canvas (B1a): rendering, incremental updates, undo, zoom around the pointer, fit, text editing,
// user CSS scoping and a 500-node render timing.
export const name = 'canvas renders, zooms and edits text';
export const viewport = { width: 1440, height: 900 };

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => { if (--left <= 0) resolve(true); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.waitFor(() => !!(window.APB.app.canvas && document.querySelector('.apb-viewport .apb-artboard')));
  await frames(page, 3);

  /* ---------------------------------------------------------------- DOM */
  const dom = await page.eval(() => {
    const app = window.APB.app;
    const vp = document.querySelector('.apb-viewport');
    const doc = app.store.doc;
    const page0 = doc.pages[0];
    const rootEl = document.querySelector('.apb-artboard > .apb-node');
    const section = doc.nodes[page0.root].children.find((id) => doc.nodes[id].type === 'section');
    const secEl = document.querySelector('[data-node-id="' + section + '"]');
    const ab = document.querySelector('.apb-artboard').getBoundingClientRect();
    return {
      role: vp.getAttribute('role'),
      roledesc: vp.getAttribute('aria-roledescription'),
      tabindex: vp.getAttribute('tabindex'),
      ariaLabel: vp.getAttribute('aria-label'),
      world: !!document.querySelector('.apb-viewport > .apb-world > .apb-artboard'),
      overlay: !!document.querySelector('.apb-viewport > svg.apb-overlay'),
      rulers: document.querySelectorAll('.apb-rulers canvas').length,
      rootId: rootEl && rootEl.getAttribute('data-node-id'),
      pageRoot: page0.root,
      rootClass: rootEl && rootEl.className,
      sectionRendered: !!secEl && secEl.classList.contains('apb-t-section'),
      sectionParentIsRoot: !!secEl && secEl.parentElement === rootEl,
      label: document.querySelector('.apb-artboard-label').textContent,
      artboardWidth: document.querySelector('.apb-artboard').style.width,
      abVisible: ab.width > 50 && ab.height > 50,
      userCss: !!document.getElementById('apb-user-css'),
      zoom: app.canvas.viewport.zoom,
      storeZoom: app.store.view.zoom,
      section
    };
  });
  assert.equal(dom.role, 'application');
  assert.equal(dom.roledesc, 'design canvas');
  assert.equal(dom.tabindex, '0');
  assert.match(dom.ariaLabel, /Home/);
  assert.ok(dom.world, '.apb-world > .apb-artboard');
  assert.ok(dom.overlay, 'svg overlay layer');
  assert.equal(dom.rulers, 2, 'two ruler canvases');
  assert.equal(dom.rootId, dom.pageRoot, 'page root rendered into the artboard');
  assert.match(dom.rootClass, /apb-node apb-t-page/);
  assert.ok(dom.sectionRendered && dom.sectionParentIsRoot, 'section rendered inside the page root');
  assert.equal(dom.label, 'Home · Desktop 1440');
  assert.equal(dom.artboardWidth, '1440px');
  assert.ok(dom.abVisible, 'artboard visible after the initial fit');
  assert.ok(dom.userCss, 'user CSS style element');
  assert.ok(dom.zoom > 0 && dom.zoom <= 1, 'initial fit zoom ' + dom.zoom);
  assert.equal(dom.storeZoom, dom.zoom, 'camera mirrored into store.view');
  const historyAfterBoot = await page.eval(() => window.APB.app.store.history().entries.length);
  assert.equal(historyAfterBoot, 0, 'camera changes are not in history');

  /* --------------------------------------------- insert → DOM in a frame */
  const inserted = await page.eval((sectionId) => {
    const app = window.APB.app;
    const ids = app.docops.insert(app.store, [
      { type: 'text', x: 40, y: 40, w: 300, h: 60, props: { text: 'Hello canvas' } },
      { type: 'shape', x: 400, y: 40, w: 120, h: 80, rotation: 30 }
    ], { parent: sectionId });
    const immediate = !!document.querySelector('[data-node-id="' + ids[0] + '"]');
    return new Promise((resolve) => requestAnimationFrame(() => {
      const t = document.querySelector('[data-node-id="' + ids[0] + '"]');
      const s = document.querySelector('[data-node-id="' + ids[1] + '"]');
      resolve({
        ids, immediate,
        text: t && t.textContent,
        textTag: t && t.localName,
        inSection: !!t && t.parentElement.getAttribute('data-node-id') === sectionId,
        shapeTransform: s && s.style.transform,
        rect: app.canvas.renderer.worldRect(ids[0]),
        shapeRect: app.canvas.renderer.worldRect(ids[1])
      });
    }));
  }, dom.section);
  assert.equal(inserted.text, 'Hello canvas', 'text node rendered within one frame');
  assert.equal(inserted.textTag, 'p');
  assert.ok(inserted.inSection, 'placed into the section slot');
  assert.match(inserted.shapeTransform, /rotate\(30deg\)/);
  assert.ok(Math.abs(inserted.rect.x - 40) < 0.6 && Math.abs(inserted.rect.w - 300) < 0.6 && Math.abs(inserted.rect.h - 60) < 0.6,
    'worldRect matches the model: ' + JSON.stringify(inserted.rect));
  assert.ok(Math.abs(inserted.shapeRect.w - 120) < 0.6 && Math.abs(inserted.shapeRect.rotation - 30) < 1e-6,
    'rotated worldRect is unrotated box + rotation: ' + JSON.stringify(inserted.shapeRect));
  assert.ok(Math.abs(inserted.shapeRect.x + inserted.shapeRect.w / 2 - 460) < 0.6, 'rotated centre x');

  // update → patch in place (same element)
  const patched = await page.eval((id) => {
    const app = window.APB.app;
    const before = document.querySelector('[data-node-id="' + id + '"]');
    app.docops.update(app.store, [id], { 'props.text': 'Changed', 'style.color': '#ff0000' });
    return new Promise((resolve) => requestAnimationFrame(() => {
      const after = document.querySelector('[data-node-id="' + id + '"]');
      resolve({ same: before === after, text: after.textContent, color: getComputedStyle(after).color });
    }));
  }, inserted.ids[0]);
  assert.ok(patched.same, 'element reused when patching');
  assert.equal(patched.text, 'Changed');
  assert.equal(patched.color, 'rgb(255, 0, 0)');

  // hit testing
  const hit = await page.eval((ids) => {
    const app = window.APB.app;
    const r = app.canvas.renderer.worldRect(ids[0]);
    const p = app.canvas.viewport.pageToScreen(r.x + r.w / 2, r.y + r.h / 2);
    return { deep: app.canvas.renderer.nodeAt(p.x, p.y, { deep: true }), sel: app.canvas.renderer.nodeAt(p.x, p.y) };
  }, inserted.ids);
  assert.equal(hit.deep, inserted.ids[0], 'nodeAt finds the text node');
  assert.equal(hit.sel, inserted.ids[0]);

  /* --------------------------------------------------------------- undo */
  const undone = await page.eval((ids) => {
    const app = window.APB.app;
    app.store.undo();
    app.store.undo();
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      a: !!document.querySelector('[data-node-id="' + ids[0] + '"]'),
      b: !!document.querySelector('[data-node-id="' + ids[1] + '"]'),
      model: !!app.store.node(ids[0])
    })));
  }, inserted.ids);
  assert.ok(!undone.a && !undone.b && !undone.model, 'undo removes the inserted nodes from the DOM');

  /* ------------------------------------------------ zoom around a point */
  const vpRect = await page.rect('.apb-viewport');
  const px = Math.round(vpRect.x + vpRect.w * 0.62);
  const py = Math.round(vpRect.y + vpRect.h * 0.41);
  const before = await page.eval((x, y) => {
    const v = window.APB.app.canvas.viewport;
    return { zoom: v.zoom, p: v.screenToPage(x, y) };
  }, px, py);
  await page.mouse('move', px, py);
  await page.wheel(px, py, 0, -200, { modifiers: ['Control'] });
  await frames(page, 2);
  const after = await page.eval((p) => {
    const app = window.APB.app;
    const v = app.canvas.viewport;
    const s = v.pageToScreen(p.x, p.y);
    const ab = document.querySelector('.apb-artboard').getBoundingClientRect();
    return { zoom: v.zoom, s, storeZoom: app.store.view.zoom, abLeft: ab.left, abTop: ab.top, origin: v.pageToScreen(0, 0) };
  }, before.p);
  assert.ok(after.zoom > before.zoom * 1.2, 'ctrl+wheel zoomed in (' + before.zoom + ' → ' + after.zoom + ')');
  assert.ok(Math.abs(after.s.x - px) < 1 && Math.abs(after.s.y - py) < 1, 'page point stays under the cursor: ' + JSON.stringify(after.s));
  assert.ok(Math.abs(after.abLeft - after.origin.x) < 1.5 && Math.abs(after.abTop - after.origin.y) < 1.5, 'DOM transform matches the camera');
  assert.equal(after.storeZoom, after.zoom);

  // plain wheel pans
  const panBefore = await page.eval(() => ({ x: window.APB.app.canvas.viewport.x, y: window.APB.app.canvas.viewport.y }));
  await page.wheel(px, py, 0, 120);
  await frames(page, 1);
  const panAfter = await page.eval(() => ({ x: window.APB.app.canvas.viewport.x, y: window.APB.app.canvas.viewport.y }));
  assert.ok(Math.abs(panAfter.y - (panBefore.y - 120)) < 0.01 && panAfter.x === panBefore.x, 'wheel pans vertically');

  // keyboard zoom command
  await page.eval(() => document.querySelector('.apb-viewport').focus());
  const z0 = await page.eval(() => window.APB.app.canvas.viewport.zoom);
  await page.key('Mod+=');
  await frames(page, 1);
  const z1 = await page.eval(() => window.APB.app.canvas.viewport.zoom);
  assert.ok(z1 > z0, 'Mod+= zooms in');

  /* ---------------------------------------------------------------- fit */
  await page.key('Shift+1');
  await frames(page, 2);
  const fit = await page.eval(() => {
    const vp = document.querySelector('.apb-viewport').getBoundingClientRect();
    const ab = document.querySelector('.apb-artboard').getBoundingClientRect();
    const v = window.APB.app.canvas.viewport;
    return { vp: { l: vp.left, t: vp.top, r: vp.right, b: vp.bottom }, ab: { l: ab.left, t: ab.top, r: ab.right, b: ab.bottom }, zoom: v.zoom, ruler: v.rulerSize };
  });
  assert.ok(fit.ab.l >= fit.vp.l + fit.ruler + 63 && fit.ab.r <= fit.vp.r - 63 && fit.ab.t >= fit.vp.t + fit.ruler + 63 - 0.5 && fit.ab.b <= fit.vp.b - 63 + 0.5,
    'fit keeps a 64px margin: ' + JSON.stringify(fit));
  const fitMargins = [fit.ab.l - fit.vp.l - fit.ruler, fit.vp.r - fit.ab.r, fit.ab.t - fit.vp.t - fit.ruler, fit.vp.b - fit.ab.b];
  assert.ok(Math.min(...fitMargins) < 66, 'fit touches the margin on one axis: ' + fitMargins.join(','));

  /* ---------------------------------------------------------- text edit */
  const textId = await page.eval((sectionId) => {
    const app = window.APB.app;
    return app.docops.insert(app.store, [{ type: 'text', x: 80, y: 120, w: 360, h: 60, props: { text: 'Original' } }], { parent: sectionId })[0];
  }, dom.section);
  await frames(page, 1);
  const histBefore = await page.eval(() => window.APB.app.store.history().entries.length);
  const started = await page.eval((id) => {
    const app = window.APB.app;
    const ok = app.canvas.startTextEdit(id);
    const active = document.activeElement;
    const sel = document.getSelection();
    return {
      ok, editable: active && active.getAttribute('contenteditable'), nodeId: active && active.closest('[data-node-id]').getAttribute('data-node-id'),
      selected: sel.toString(), editing: app.store.view.editingText
    };
  }, textId);
  assert.ok(started.ok, 'text edit started');
  assert.match(String(started.editable), /plaintext-only|true/);
  assert.equal(started.nodeId, textId);
  assert.equal(started.selected, 'Original', 'all text selected on start');
  assert.equal(started.editing, textId, 'view.editingText set');
  await page.type('Edited text');
  await page.key('Escape');
  await frames(page, 2);
  const edited = await page.eval((id) => {
    const app = window.APB.app;
    const h = app.store.history();
    const el = document.querySelector('[data-node-id="' + id + '"]');
    return {
      text: app.store.node(id).props.text, entries: h.entries.length, label: h.entries[h.entries.length - 1].label,
      editing: app.store.view.editingText, domText: el.textContent, ce: el.hasAttribute('contenteditable'), active: app.canvas.textedit.active()
    };
  }, textId);
  assert.equal(edited.text, 'Edited text', 'Escape commits the typed text');
  assert.equal(edited.entries, histBefore + 1, 'exactly one undo entry');
  assert.equal(edited.label, 'Edit text');
  assert.equal(edited.editing, null);
  assert.equal(edited.domText, 'Edited text');
  assert.equal(edited.ce, false, 'contenteditable removed after commit');
  assert.equal(edited.active, null);

  // multi-line: Enter inserts a newline, Mod+Enter commits
  await page.eval((id) => window.APB.app.canvas.startTextEdit(id), textId);
  await page.type('Line one');
  await page.key('Enter');
  await page.type('Line two');
  await page.key('Mod+Enter');
  await frames(page, 1);
  const multi = await page.eval((id) => window.APB.app.store.node(id).props.text, textId);
  assert.equal(multi, 'Line one\nLine two', 'Enter inserts a newline in text nodes');

  // button: Enter commits (single line)
  const btn = await page.eval((sectionId) => {
    const app = window.APB.app;
    return app.docops.insert(app.store, [{ type: 'button', x: 80, y: 220 }], { parent: sectionId })[0];
  }, dom.section);
  await frames(page, 1);
  await page.eval((id) => window.APB.app.canvas.startTextEdit(id), btn);
  await page.type('Buy now');
  await page.key('Enter');
  await frames(page, 1);
  const btnState = await page.eval((id) => ({
    text: window.APB.app.store.node(id).props.text,
    dom: document.querySelector('[data-node-id="' + id + '"]').textContent,
    spans: document.querySelectorAll('[data-node-id="' + id + '"] span').length
  }), btn);
  assert.equal(btnState.text, 'Buy now');
  assert.equal(btnState.dom, 'Buy now');
  assert.equal(btnState.spans, 0, 'temporary editing host removed');

  await page.eval(() => window.APB.app.store.undo());
  await frames(page, 1);
  const undoneText = await page.eval((id) => window.APB.app.store.node(id).props.text, btn);
  assert.equal(undoneText, 'Get started', 'text edit undoes in one step');

  /* ------------------------------------------------- user CSS is scoped */
  const scoped = await page.eval((id) => {
    const app = window.APB.app;
    app.store.transact('CSS', (tx) => tx.setDocField('settings.globalCSS', 'p { text-decoration: underline; } body { letter-spacing: 3px; } div { outline: 3px solid rgb(1, 2, 3); }'));
    return new Promise((resolve) => requestAnimationFrame(() => {
      const el = document.querySelector('[data-node-id="' + id + '"]');
      const label = document.querySelector('.apb-artboard-label');
      const ab = document.querySelector('.apb-artboard');
      resolve({
        p: getComputedStyle(el).textDecorationLine,
        abSpacing: getComputedStyle(ab).letterSpacing,
        labelOutline: getComputedStyle(label).outlineStyle,
        viewportOutline: getComputedStyle(document.querySelector('.apb-viewport')).outlineStyle,
        css: document.getElementById('apb-user-css').textContent
      });
    }));
  }, textId);
  assert.equal(scoped.p, 'underline', 'user CSS applies inside the artboard');
  assert.equal(scoped.abSpacing, '3px', 'body selector maps to the artboard scope');
  assert.notEqual(scoped.labelOutline, 'solid', 'user CSS does not leak into editor UI');
  assert.notEqual(scoped.viewportOutline, 'solid', 'user CSS does not leak into the viewport');

  /* ------------------------------------------------- hidden node preview */
  const hidden = await page.eval((id) => {
    const app = window.APB.app;
    app.docops.setHidden(app.store, [id], true);
    app.store.select([]);
    return new Promise((resolve) => requestAnimationFrame(() => {
      const el = document.querySelector('[data-node-id="' + id + '"]');
      const off = getComputedStyle(el).display;
      app.store.select([id]);
      requestAnimationFrame(() => {
        resolve({ off, on: getComputedStyle(el).display, cls: el.classList.contains('apb-hidden-preview') });
      });
    }));
  }, textId);
  assert.equal(hidden.off, 'none', 'hidden node is not displayed');
  assert.notEqual(hidden.on, 'none', 'selected hidden node is previewed');
  assert.ok(hidden.cls, 'hidden preview class');

  /* ------------------------------------------------ insert at viewport centre */
  const centre = await page.eval(() => {
    const app = window.APB.app;
    app.canvas.viewport.fit();
    const ids = app.canvas.insertAtViewportCenter([{ type: 'shape', w: 100, h: 100 }]);
    const r = app.canvas.renderer.worldRect(ids[0]);
    const c = app.canvas.viewport.contentRect();
    const p = app.canvas.viewport.screenToPage(c.left + c.width / 2, c.top + c.height / 2);
    return { parentType: app.store.doc.nodes[app.store.node(ids[0]).parent].type, cx: r.x + r.w / 2, cy: r.y + r.h / 2, px: p.x, py: p.y, sel: app.store.selection };
  });
  assert.equal(centre.parentType, 'section', 'inserted into the container under the centre');
  assert.ok(Math.abs(centre.cx - centre.px) < 2 && Math.abs(centre.cy - centre.py) < 2, 'centred on the viewport: ' + JSON.stringify(centre));

  /* ---------------------------------------------- 500-node render timing */
  const perf = await page.eval((sectionId) => {
    const app = window.APB.app;
    const specs = [];
    for (let i = 0; i < 500; i++) {
      const kind = i % 3;
      if (kind === 0) specs.push({ type: 'text', x: (i % 25) * 56, y: Math.floor(i / 25) * 30, w: 52, h: 26, props: { text: 'Item ' + i } });
      else if (kind === 1) specs.push({ type: 'shape', x: (i % 25) * 56, y: Math.floor(i / 25) * 30, w: 50, h: 24, style: { fill: '#3b82f6', radius: 4 } });
      else specs.push({ type: 'button', x: (i % 25) * 56, y: Math.floor(i / 25) * 30, w: 52, h: 26, props: { text: 'B' + i } });
    }
    const t0 = performance.now();
    app.docops.insert(app.store, specs, { parent: sectionId, select: false });
    const tInsert = performance.now() - t0;
    const r = app.canvas.renderer;
    const t1 = performance.now();
    r.flush();
    const tIncremental = performance.now() - t1;
    const count = document.querySelectorAll('.apb-artboard .apb-node').length;
    const rebuild = r.renderAll({ rebuild: true });
    const rebuildAgain = r.renderAll({ rebuild: true });
    r.invalidate('all');
    const t2 = performance.now();
    r.flush();
    const repatch = performance.now() - t2;
    const unchanged = r.renderAll();
    return { tInsert, tIncremental, count, rebuild: Math.min(rebuild, rebuildAgain), repatch, unchanged, stats: r.stats() };
  }, dom.section);
  log('500-node render: insert tx ' + perf.tInsert.toFixed(1) + ' ms, incremental flush ' + perf.tIncremental.toFixed(1) +
    ' ms, renderAll rebuild ' + perf.rebuild.toFixed(1) + ' ms, full re-patch ' + perf.repatch.toFixed(1) +
    ' ms, unchanged renderAll ' + perf.unchanged.toFixed(1) + ' ms (' + perf.count + ' node elements)');
  assert.ok(perf.count >= 505, 'all nodes rendered: ' + perf.count);
  assert.ok(perf.rebuild < 150, 'renderAll of 500 nodes under 150 ms (' + perf.rebuild.toFixed(1) + ' ms)');
  assert.ok(perf.repatch < 150, 'full re-patch under 150 ms (' + perf.repatch.toFixed(1) + ' ms)');

  // pan via wheel stays smooth: no errors, rulers still drawn
  await page.wheel(px, py, 40, 40);
  await frames(page, 2);
  await page.screenshot('canvas');
}

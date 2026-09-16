// Design panel (features/inspector.js + features/tokens.js): live editing through docops with one
// undo entry per field burst, multi-selection "Mixed", breakpoint overrides with the dot + reset,
// document colour tokens applied to the remembered selection, and the URL field's javascript: guard.
export const name = 'inspector: live edits, mixed selection, bp overrides, tokens, URL guard';
export const viewport = { width: 1440, height: 900 };
export const timeout = 90000;

/** Set a control's <input>/<textarea>/<select> the way a user would (input → change → blur). */
const setField = (page, id, value) => page.eval((a) => {
  const insp = document.querySelector('.apb-inspector').apbInspector;
  const f = insp.field(a.id);
  if (!f) return 'no-field:' + a.id;
  const sel = 'input, textarea, select';
  const el = f.el.matches(sel) ? f.el : f.el.querySelector(sel);
  if (!el) return 'no-input:' + a.id;
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(a.value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.blur();
  return 'ok';
}, { id, value });

/** Colour fields commit on Enter. */
const setColor = (page, id, value) => page.eval((a) => {
  const f = document.querySelector('.apb-inspector').apbInspector.field(a.id);
  if (!f) return 'no-field:' + a.id;
  const el = f.el.querySelector('input');
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, a.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  el.blur();
  return 'ok';
}, { id, value });

const pickSegment = (page, id, value) => page.eval((a) => {
  const f = document.querySelector('.apb-inspector').apbInspector.field(a.id);
  if (!f) return 'no-field:' + a.id;
  const btn = f.el.querySelector('[data-value="' + a.value + '"]');
  if (!btn) return 'no-option:' + a.value;
  btn.click();
  return 'ok';
}, { id, value });

const historyLen = (page) => page.eval(() => APB.app.store.history().entries.length);
const nodeOf = (page, id) => page.eval((n) => JSON.parse(JSON.stringify(APB.app.store.doc.nodes[n])), id);
const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();

  /* ------------------------------------------------------------------ seed */
  const ids = await page.eval(() => {
    const app = APB.app;
    app.ui.showPanel('design');
    const made = app.docops.insert(app, [{
      type: 'section', name: 'Hero', children: [
        { type: 'text', name: 'Headline', x: 40, y: 40, w: 300, h: 60, props: { text: 'Hello' } },
        { type: 'button', name: 'CTA', x: 40, y: 140, w: 180, h: 48 }
      ]
    }], { select: false });
    const nodes = app.store.doc.nodes;
    const find = (n) => Object.keys(nodes).find((k) => nodes[k].name === n);
    const text = find('Headline');
    app.store.select([text]);
    return { section: made[0], text, button: find('CTA') };
  });
  assert.ok(ids.text && ids.button, 'seeded a text and a button layer');

  await page.waitFor(() => !!document.querySelector('.apb-inspector-section'));
  await frames(page);

  /* ------------------------------------------------- header reflects the node */
  const head = await page.eval(() => ({
    name: document.querySelector('.apb-inspector-name input').value,
    bp: document.querySelector('.apb-inspector-bp').textContent,
    hasType: !!document.querySelector('.apb-inspector-type svg')
  }));
  assert.equal(head.name, 'Headline', 'header shows the layer name');
  assert.equal(head.bp, 'Desktop', 'header shows the active breakpoint');
  assert.ok(head.hasType, 'header shows the element type icon');

  /* ---------------------------------------------------- live edits, one entry */
  let entries = await historyLen(page);

  assert.equal(await setField(page, 'w', '420'), 'ok', 'width field exists');
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).w, 420, 'width written to the document');
  assert.equal(await historyLen(page), entries + 1, 'width edit is one undo entry');
  entries += 1;

  const canvasWidth = await page.eval((id) => {
    const el = APB.app.canvas.renderer.el(id);
    return el ? Math.round(el.getBoundingClientRect().width / APB.app.canvas.viewport.zoom) : 0;
  }, ids.text);
  assert.equal(canvasWidth, 420, 'the canvas node was re-rendered at the new width');

  assert.equal(await pickSegment(page, 'fill-mode-probe', 'solid'), 'no-field:fill-mode-probe', 'unknown fields report themselves');
  await page.eval(() => {
    const seg = Array.from(document.querySelectorAll('.apb-inspector .apb-seg'))
      .find((s) => s.getAttribute('aria-label') === 'Fill type');
    seg.querySelector('[data-value="solid"]').click();
  });
  await frames(page);
  entries = await historyLen(page);

  assert.equal(await setColor(page, 'fill', '#ff0055'), 'ok', 'fill colour field exists');
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).style.fill, '#ff0055', 'fill written to the document');
  assert.equal(await historyLen(page), entries + 1, 'fill edit is one undo entry');
  entries += 1;

  assert.equal(await setField(page, 'content:props.text', 'Hello world'), 'ok', 'text content field exists');
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).props.text, 'Hello world', 'text content written');
  assert.equal(await historyLen(page), entries + 1, 'text edit is one undo entry');
  entries += 1;

  await page.eval(() => {
    const f = document.querySelector('.apb-inspector').apbInspector.field('opacity');
    const el = f.el.querySelector('input');
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0.5');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    APB.app.canvas.el.focus();
  });
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).style.opacity, 0.5, 'opacity written');
  assert.equal(await historyLen(page), entries + 1, 'opacity edit is one undo entry');
  entries += 1;

  /* undo walks back through exactly those entries */
  await page.key('Mod+Z');
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).style.opacity, undefined, 'undo reverts only the opacity edit');
  assert.equal((await nodeOf(page, ids.text)).props.text, 'Hello world', 'the text edit survives that undo');
  await page.key('Mod+Shift+Z');
  await frames(page);
  assert.equal((await nodeOf(page, ids.text)).style.opacity, 0.5, 'redo restores the opacity edit');

  /* ------------------------------------------------------ multi-selection */
  await page.eval((a) => APB.app.store.select([a.text, a.button]), ids);
  await frames(page, 3);

  const mixed = await page.eval(() => {
    const insp = document.querySelector('.apb-inspector').apbInspector;
    const w = insp.field('w').el.querySelector('input');
    const y = insp.field('y').el.querySelector('input');
    return { w: w.placeholder, wValue: w.value, y: y.value, count: insp.selection.length };
  });
  assert.equal(mixed.count, 2, 'two layers selected');
  assert.equal(mixed.w, 'Mixed', 'differing widths show "Mixed"');
  assert.equal(mixed.wValue, '', 'the mixed field shows no value');
  assert.equal(mixed.y, '', 'differing Y also reads as mixed');

  await setField(page, 'w', '250');
  await frames(page);
  const both = await page.eval((a) => [APB.app.store.doc.nodes[a.text].w, APB.app.store.doc.nodes[a.button].w], ids);
  assert.deepEqual(both, [250, 250], 'the edit applied to both selected layers');

  /* -------------------------------------------------- breakpoint overrides */
  await page.eval((a) => {
    APB.app.store.select([a.text]);
    APB.app.store.setView({ bp: 'mobile' });
  }, ids);
  await frames(page, 3);

  const bpHead = await page.eval(() => document.querySelector('.apb-inspector-bp').textContent);
  assert.equal(bpHead, 'Mobile', 'the header badge follows the active breakpoint');

  await setField(page, 'w', '180');
  await frames(page);
  const overridden = await nodeOf(page, ids.text);
  assert.equal(overridden.w, 250, 'the base width is untouched');
  assert.equal(overridden.bp.mobile.w, 180, 'the edit became a mobile override');

  const dot = await page.eval(() => {
    const row = document.querySelector('.apb-inspector').apbInspector.field('w').row;
    const btn = row.querySelector('.apb-override-dot');
    return { marked: row.classList.contains('is-overridden'), visible: !btn.hidden };
  });
  assert.ok(dot.marked && dot.visible, 'the width field shows the override dot');

  const beforeReset = await historyLen(page);
  await page.eval(() => {
    document.querySelector('.apb-inspector').apbInspector.field('w').row.querySelector('.apb-override-dot').click();
  });
  await frames(page, 3);
  const afterReset = await nodeOf(page, ids.text);
  assert.ok(!afterReset.bp || !afterReset.bp.mobile || afterReset.bp.mobile.w === undefined, 'reset removed the mobile override');
  assert.equal(await historyLen(page), beforeReset + 1, 'the reset is its own undo entry');
  const dotGone = await page.eval(() => document.querySelector('.apb-inspector').apbInspector.field('w').row.classList.contains('is-overridden'));
  assert.equal(dotGone, false, 'the override dot is cleared');

  await page.eval(() => APB.app.store.setView({ bp: 'desktop' }));
  await frames(page);

  /* ------------------------------------------------------- document styles */
  await page.eval(() => APB.app.store.select([]));
  await page.waitFor(() => !!document.querySelector('.apb-docstyles'));
  await frames(page, 2);

  const emptyState = await page.eval(() => !!document.querySelector('.apb-inspector .apb-empty-title'));
  assert.ok(emptyState, 'an empty state explains that nothing is selected');

  await page.eval(() => {
    const section = Array.from(document.querySelectorAll('.apb-docstyles-section'))
      .find((s) => s.textContent.indexOf('Colours') === 0 || /Colours/.test(s.querySelector('.apb-section-title').textContent));
    section.querySelector('.apb-section-actions button').click();
  });
  await page.waitFor(() => !!document.querySelector('.apb-token-row'));

  const token = await page.eval(() => {
    const row = document.querySelector('.apb-token-row');
    return { id: row.getAttribute('data-token'), label: row.querySelector('.apb-token-id').textContent };
  });
  assert.ok(token.id, 'a colour token was created');
  assert.equal(token.label, '$' + token.id, 'the row shows the reference syntax');

  // The Apply action targets the layers that were selected last.
  await page.eval(() => {
    const row = document.querySelector('.apb-token-row');
    const btns = Array.from(row.querySelectorAll('button'));
    const apply = btns.find((b) => (b.getAttribute('aria-label') || '') === 'Apply as fill');
    apply.click();
  });
  await frames(page, 2);
  const applied = await nodeOf(page, ids.text);
  assert.equal(applied.style.fill, '$' + token.id, 'the token was applied to the remembered selection');
  const tokenCSS = await page.eval((t) => {
    const el = document.getElementById('apb-doc-tokens') || document.querySelector('style[data-apb-tokens]');
    return (el ? el.textContent : (APB.require('style').tokensCSS(APB.app.store.doc))).indexOf('--t-' + t) !== -1;
  }, token.id);
  assert.ok(tokenCSS, 'the token is emitted as a CSS custom property');

  /* ------------------------------------------- document style CRUD (tokens) */
  const api = await page.eval((a) => {
    const app = APB.app;
    const T = APB.require('tokens');
    const id = T.addColor(app, { name: 'Brand blue', value: '#123456' });
    app.docops.update(app, [a.button], { 'style.fill': '#123456' });
    const replaced = T.replaceEverywhere(app, id);
    T.renameColor(app, id, 'brand');
    const afterRename = app.store.doc.nodes[a.button].style.fill;
    const ts = T.addTextStyle(app, { name: 'Big', style: T.textStyleFromNode(app.store.doc, a.text, 'desktop') });
    T.applyTextStyle(app, [a.text], ts);
    const usedBy = T.usage(app.store.doc, ts, 'text').length;
    T.removeTextStyle(app, ts);
    const inlined = app.store.doc.nodes[a.text].style.fontSize;
    T.removeColor(app, 'brand');
    return { replaced, afterRename, usedBy, inlined, fill: app.store.doc.nodes[a.button].style.fill,
      labels: app.store.history().entries.slice(-6).map((e) => e.label) };
  }, ids);
  assert.ok(api.replaced >= 1, 'replace everywhere rewrote the literal colours');
  assert.equal(api.afterRename, '$brand', 'renaming a token rewrites its references');
  assert.equal(api.usedBy, 1, 'text style usage is counted');
  assert.ok(typeof api.inlined === 'number', 'deleting a text style inlines its declarations');
  assert.equal(api.fill, '#123456', 'deleting a colour token keeps the resolved colour');
  assert.deepEqual(api.labels.slice(-3), ['Apply text style', 'Delete text style', 'Delete colour style'],
    'every document-style edit is one labelled undo entry');

  /* -------------------------------------------------------- URL validation */
  await page.eval((a) => APB.app.store.select([a.button]), ids);
  await frames(page, 3);

  const before = (await nodeOf(page, ids.button)).props.href || '';
  await setField(page, 'content:props.href', 'javascript:alert(1)');
  await frames(page);
  const after = (await nodeOf(page, ids.button)).props.href || '';
  assert.equal(after, before, 'a javascript: URL is never written to the document');
  const invalid = await page.eval(() => {
    const f = document.querySelector('.apb-inspector').apbInspector.field('content:props.href');
    const el = f.el.querySelector('input');
    return { aria: el.getAttribute('aria-invalid'), error: (f.row.textContent || '').indexOf('not allowed') !== -1 };
  });
  assert.equal(invalid.aria, 'true', 'the URL field is marked invalid');
  assert.ok(invalid.error, 'the field explains why the link was rejected');

  await setField(page, 'content:props.href', 'https://example.com/pricing');
  await frames(page);
  assert.equal((await nodeOf(page, ids.button)).props.href, 'https://example.com/pricing', 'a safe URL is accepted');

  /* ------------------------------------------------------------- keyboard */
  const focusBack = await page.eval(() => {
    const el = document.querySelector('.apb-inspector').apbInspector.field('content:props.href').el.querySelector('input');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return document.activeElement === APB.app.canvas.el;
  });
  assert.ok(focusBack, 'Escape returns focus to the canvas');

  await page.screenshot('inspector');
}

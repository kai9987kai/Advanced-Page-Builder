// Animation presets (core/motion.js + the inspector "Animation" section in features/motion.js):
// picking a preset, the field set it reveals, the live Web Animations API canvas preview, and the
// export-time @keyframes/runtime wiring (already covered from the exporters side in
// tests/unit/exporters.test.mjs — this checks the UI that writes node.motion in the first place).
export const name = 'animation presets';
export const viewport = { width: 1440, height: 900 };
export const timeout = 60000;

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.eval(() => APB.app.ui.showPanel('design'));

  const nodeId = await page.eval(() => {
    const app = APB.app;
    const [id] = app.docops.insert(app, [{ type: 'text', props: { text: 'Animate me' } }], { select: true });
    return id;
  });
  await frames(page, 2);

  /* --------------------------------------------------------- seeded immediately */
  const seeded = await page.eval(() => {
    const sections = Array.from(document.querySelectorAll('.apb-inspector-section[data-section^="ext-"]'));
    const motionSection = sections.find((s) => s.textContent.includes('Animation'));
    const select = motionSection && motionSection.querySelector('select');
    return { hasSection: !!motionSection, hasSelect: !!select, value: select && select.value };
  });
  assert.ok(seeded.hasSection, 'the Animation section renders for a selected node');
  assert.ok(seeded.hasSelect, 'the Animation section is seeded on mount, not left empty until some unrelated store event');

  /* ------------------------------------------------------------- pick a preset */
  const afterPreset = await page.eval((id) => new Promise((resolve) => {
    const sections = Array.from(document.querySelectorAll('.apb-inspector-section[data-section^="ext-"]'));
    const motionSection = sections.find((s) => s.textContent.includes('Animation'));
    const select = motionSection.querySelector('select');
    const options = Array.from(select.options);
    const slideUp = options.find((o) => o.textContent === 'Slide up');
    select.value = slideUp.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const app = APB.app;
      const fieldCount = motionSection.querySelectorAll('select, input').length;
      resolve({ motion: app.store.doc.nodes[id].motion, fieldCount });
    }));
  }), nodeId);
  assert.equal(afterPreset.motion.preset, 'slide-up');
  assert.equal(afterPreset.motion.trigger, 'enter', 'defaults to the scroll-into-view trigger');
  assert.ok(afterPreset.fieldCount >= 5, 'picking a preset reveals trigger/duration/delay/easing + the preview button: ' + afterPreset.fieldCount);

  /* ------------------------------------------------------------ edit duration */
  const historyBefore = await page.eval(() => APB.app.store.history().index);
  await page.eval(() => {
    const sections = Array.from(document.querySelectorAll('.apb-inspector-section[data-section^="ext-"]'));
    const motionSection = sections.find((s) => s.textContent.includes('Animation'));
    const durationInput = motionSection.querySelector('input.apb-num-input');
    durationInput.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(durationInput, '900');
    durationInput.dispatchEvent(new Event('input', { bubbles: true }));
    durationInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    durationInput.blur();
  });
  await frames(page, 1);
  const durationSaved = await page.eval((id) => APB.app.store.doc.nodes[id].motion.duration, nodeId);
  assert.equal(durationSaved, 900);
  assert.equal(await page.eval(() => APB.app.store.history().index), historyBefore + 1, 'the edit is one undo entry');

  /* -------------------------------------------------------------- live preview */
  const previewRan = await page.eval((id) => {
    const target = document.querySelector('.apb-viewport [data-node-id="' + id + '"]');
    const before = target.getAnimations ? target.getAnimations().length : -1;
    const sections = Array.from(document.querySelectorAll('.apb-inspector-section[data-section^="ext-"]'));
    const motionSection = sections.find((s) => s.textContent.includes('Animation'));
    const previewBtn = Array.from(motionSection.querySelectorAll('button')).find((b) => b.textContent.includes('Preview'));
    previewBtn.click();
    const after = target.getAnimations ? target.getAnimations().length : -1;
    return { before, after, hasBtn: !!previewBtn };
  }, nodeId);
  assert.ok(previewRan.hasBtn, 'a Preview button is offered once a preset is chosen');
  assert.ok(previewRan.after > previewRan.before, 'clicking Preview starts a Web Animations API animation on the canvas element');

  /* --------------------------------------------------------------- clear it */
  await page.eval(() => {
    const sections = Array.from(document.querySelectorAll('.apb-inspector-section[data-section^="ext-"]'));
    const motionSection = sections.find((s) => s.textContent.includes('Animation'));
    const select = motionSection.querySelector('select');
    select.value = Array.from(select.options).find((o) => o.textContent === 'None').value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await frames(page, 1);
  const cleared = await page.eval((id) => APB.app.store.doc.nodes[id].motion, nodeId);
  assert.equal(cleared, null, '"None" clears node.motion');

  await page.screenshot('motion-panel');
  log('animation preset picking, field reveal, live preview and clearing all verified');
}

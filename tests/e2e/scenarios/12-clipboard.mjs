// Clipboard (B1b-2): services.clipboard + edit.copy/cut/paste/pasteInPlace.
// Copy → paste makes new ids at a cascading offset, cut removes the originals, paste-in-place keeps
// the position, the envelope carries the whole subtree, and plain text / HTML become a text node.
// The async Clipboard API is usually denied on file:// — that is the point: the fallback buffer and
// the DOM `paste` event have to carry the feature on their own.
export const name = 'clipboard copy, cut, paste and paste in place';
export const viewport = { width: 1280, height: 800 };

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => { if (--left <= 0) resolve(true); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.waitFor(() => !!(window.APB.app.services && window.APB.app.services.clipboard), 4000);
  await frames(page, 2);

  // Best effort: with the permission granted the real Clipboard API path runs instead of the buffer.
  let granted = false;
  try {
    await page.cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    granted = true;
  } catch (_) { granted = false; }
  log('clipboard permission granted: ' + granted);

  const setup = await page.eval(() => {
    const app = window.APB.app;
    const doc = app.store.doc;
    const root = doc.nodes[doc.pages[0].root];
    const section = root.children.find((id) => doc.nodes[id].type === 'section');
    const group = app.docops.insert(app.store, [{
      type: 'frame', name: 'Card', x: 80, y: 80, w: 240, h: 160, style: { fill: '#e0f2fe' },
      children: [{ type: 'text', name: 'Label', x: 20, y: 20, w: 180, h: 40, props: { text: 'Hello' } }]
    }], { parent: section, select: true })[0];
    app.store.clearHistory();
    return { section, group, child: app.store.doc.nodes[group].children[0], nodes: Object.keys(app.store.doc.nodes).length };
  });
  const { section, group } = setup;
  assert.ok(setup.child, 'the copied frame has a child');

  const count = () => page.eval(() => Object.keys(window.APB.app.store.doc.nodes).length);
  const node = (id) => page.eval((nid) => {
    const n = window.APB.app.store.doc.nodes[nid];
    return n ? { type: n.type, parent: n.parent, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h, children: (n.children || []).slice() } : null;
  }, id);
  const sel = () => page.eval(() => window.APB.app.store.selection.slice());
  const histIndex = () => page.eval(() => window.APB.app.store.history().index);

  /* ------------------------------------------------------------ envelope */
  const envelope = await page.eval(() => {
    const p = window.APB.app.services.clipboard.payload();
    return { format: p.format, version: p.version, roots: p.roots.slice(), nodes: Object.keys(p.nodes).length };
  });
  assert.equal(envelope.format, 'apb-clipboard', 'envelope format');
  assert.equal(envelope.version, 2, 'envelope version');
  assert.deepEqual(envelope.roots, [group], 'the selection is the root');
  assert.equal(envelope.nodes, 2, 'the subtree (frame + text) travels with it');

  /* -------------------------------------------------------- copy + paste */
  const n0 = await count();
  let h0 = await histIndex();
  await page.eval(() => window.APB.app.services.clipboard.copy());
  await page.waitFor(() => !!window.APB.app.services.clipboard.buffer, 2000);
  const pasted = await page.eval(() => window.APB.app.services.clipboard.paste().then((ids) => ids.slice()));
  assert.equal(pasted.length, 1, 'paste created one root');
  assert.ok(pasted[0] !== group, 'with a new id');
  assert.equal(await count(), n0 + 2, 'the whole subtree was cloned');
  assert.equal(await histIndex(), h0 + 1, 'paste is one history entry');
  const copy1 = await node(pasted[0]);
  const source = await node(group);
  assert.equal(copy1.parent, source.parent, 'pasted next to the original');
  assert.equal(copy1.x, source.x + 16, 'offset by 16 px');
  assert.equal(copy1.y, source.y + 16, 'on both axes');
  assert.equal(copy1.children.length, 1, 'the child came along');
  assert.ok(copy1.children[0] !== setup.child, 'the child has a new id too');
  assert.deepEqual(await sel(), pasted, 'the paste is selected');

  const pasted2 = await page.eval(() => window.APB.app.services.clipboard.paste().then((ids) => ids.slice()));
  const copy2 = await node(pasted2[0]);
  assert.equal(copy2.x, source.x + 32, 'the second paste cascades further');
  assert.equal(copy2.y, source.y + 32, 'on both axes');

  /* ------------------------------------------------------ paste in place */
  const inPlace = await page.eval(() => window.APB.app.services.clipboard.pasteInPlace().then((ids) => ids.slice()));
  const copy3 = await node(inPlace[0]);
  assert.equal(copy3.x, source.x, 'paste in place keeps x');
  assert.equal(copy3.y, source.y, 'and y');
  assert.equal(copy3.parent, source.parent, 'and the original parent');

  /* ------------------------------------------------------------- cut */
  h0 = await histIndex();
  const before = await count();
  await page.eval((id) => {
    window.APB.app.store.select([id]);
    return window.APB.app.services.clipboard.cut();
  }, inPlace[0]);
  await page.waitFor('!window.APB.app.store.doc.nodes[' + JSON.stringify(inPlace[0]) + ']', 2000);
  assert.equal(await count(), before - 2, 'cut removed the node and its child');
  assert.equal(await node(inPlace[0]), null, 'the original is gone');
  const back = await page.eval(() => window.APB.app.services.clipboard.paste().then((ids) => ids.slice()));
  assert.equal(back.length, 1, 'the cut node can be pasted back');
  assert.equal((await node(back[0])).name, 'Card', 'with its name');

  /* --------------------------------------------------- keyboard shortcuts */
  await page.eval((id) => { window.APB.app.store.select([id]); window.APB.app.canvas.el.focus(); }, group);
  const beforeKeys = await count();
  await page.key('Mod+C');
  await frames(page, 2);
  await page.key('Mod+V');

  await page.waitFor('Object.keys(window.APB.app.store.doc.nodes).length > ' + beforeKeys, 3000);
  assert.equal(await count(), beforeKeys + 2, 'Mod+C then Mod+V pastes a copy');
  const keyPaste = (await sel())[0];
  assert.ok(keyPaste && keyPaste !== group, 'the keyboard paste is selected');

  /* --------------------------------------------------------- text / HTML */
  const textIds = await page.eval(() => {
    const cb = window.APB.app.services.clipboard;
    cb.clear();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Pasted from another app');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    window.APB.app.canvas.el.focus();
    document.dispatchEvent(ev);
    return window.APB.app.store.selection.slice();
  });
  const textNode = textIds.length ? await node(textIds[0]) : null;
  assert.ok(textNode && textNode.type === 'text', 'plain text becomes a text node: ' + JSON.stringify(textNode));
  const textProps = await page.eval((id) => window.APB.app.store.doc.nodes[id].props.text, textIds[0]);
  assert.equal(textProps, 'Pasted from another app', 'with the pasted text');

  const htmlIds = await page.eval(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>Imported heading</h2>');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return window.APB.app.store.selection.slice();
  });
  const htmlNode = htmlIds.length ? await node(htmlIds[0]) : null;
  assert.ok(htmlNode && htmlNode.type === 'text', 'HTML falls back to text when no importer is loaded');
  assert.equal(await page.eval((id) => window.APB.app.store.doc.nodes[id].props.text, htmlIds[0]), 'Imported heading', 'tags are stripped');

  /* -------------------------------------------- the DOM copy event path */
  const domCopy = await page.eval((id) => {
    window.APB.app.store.select([id]);
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    const text = dt.getData('text/plain');
    return { prevented: ev.defaultPrevented, text: text.slice(0, 40), html: dt.getData('text/html').indexOf('<') === 0 };
  }, group);
  assert.ok(domCopy.prevented, 'the copy event is handled');
  assert.ok(domCopy.text.indexOf('apb-clipboard') !== -1, 'text/plain carries the envelope: ' + domCopy.text);
  assert.ok(domCopy.html, 'text/html carries the exported markup');

  /* ------------------------------------------------- inputs are untouched */
  const inputSafe = await page.eval(() => {
    const input = document.createElement('input');
    input.value = 'typed';
    document.body.appendChild(input);
    input.focus();
    input.select();
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    const prevented = ev.defaultPrevented;
    const before = Object.keys(window.APB.app.store.doc.nodes).length;
    const pasteEv = new ClipboardEvent('paste', { clipboardData: (() => { const d = new DataTransfer(); d.setData('text/plain', 'plain typing'); return d; })(), bubbles: true, cancelable: true });
    input.dispatchEvent(pasteEv);
    const after = Object.keys(window.APB.app.store.doc.nodes).length;
    input.remove();
    window.APB.app.canvas.el.focus();
    return { prevented, pastePrevented: pasteEv.defaultPrevented, before, after };
  });
  assert.equal(inputSafe.prevented, false, 'copy inside an input is left to the browser');
  assert.equal(inputSafe.pastePrevented, false, 'paste inside an input is left to the browser');
  assert.equal(inputSafe.after, inputSafe.before, 'nothing was inserted into the document');
  await page.screenshot('clipboard');
}

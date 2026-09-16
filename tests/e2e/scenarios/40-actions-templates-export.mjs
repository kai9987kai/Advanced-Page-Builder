// Buttons/checklists as canvas tools, the "Actions" inspector section (features/actions.js) for
// click/change interactions, the template gallery (features/templates.js) and the export/preview
// tools (features/exporters.js, features/preview.js) — see docs/ARCHITECTURE.md "Contract
// additions" 2026-09-16.
export const name = 'actions, templates, export and preview tools';
export const viewport = { width: 1440, height: 900 };
export const timeout = 90000;

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();
  await page.eval(() => APB.app.ui.showPanel('design'));

  /* ---------------------------------------------------------- tools + type */
  const registry = await page.eval(() => {
    const app = APB.app;
    return {
      tools: app.commands.list().filter((c) => c.id.indexOf('tool.') === 0).map((c) => c.id).sort(),
      hasChecklistType: !!app.elements.get('checklist'),
      hasExportCmd: !!app.commands.get('file.exportCode'),
      hasPreviewCmd: !!app.commands.get('view.preview'),
      hasTemplateCmd: !!app.commands.get('insert.template'),
      services: { exporters: !!(app.services && app.services.exporters), preview: !!(app.services && app.services.preview) }
    };
  });
  assert.ok(registry.tools.includes('tool.button') && registry.tools.includes('tool.checklist'), 'button/checklist tools registered');
  assert.ok(registry.hasChecklistType, 'checklist element type registered');
  assert.ok(registry.hasExportCmd && registry.hasPreviewCmd && registry.hasTemplateCmd, 'export/preview/template commands registered');
  assert.ok(registry.services.exporters && registry.services.preview, 'exporters/preview services attached to app.services');

  /* --------------------------------------------------------- draw a button */
  const btnId = await page.eval(() => {
    const app = APB.app;
    app.commands.run('tool.button');
    return app.store.view.tool;
  });
  assert.equal(btnId, 'button', 'tool.button activates the button tool');
  const toScreen = (x, y) => page.eval((px, py) => window.APB.app.canvas.viewport.pageToScreen(px, py), x, y);
  const p = await toScreen(200, 200);
  await page.mouse('move', p.x, p.y);
  await page.mouse('down', p.x, p.y);
  await page.mouse('up', p.x, p.y);
  const button = await page.eval(() => {
    const app = APB.app;
    const id = app.store.selection[0];
    const n = app.store.doc.nodes[id];
    return { id, type: n.type, text: n.props.text, tool: app.store.view.tool };
  });
  assert.equal(button.type, 'button', 'the button tool created a button node');
  assert.equal(button.tool, 'select', 'the tool returns to select afterwards');
  await frames(page, 2);

  /* -------------------------------------------------- Actions section: button */
  const initialActions = await page.eval(() => {
    const sec = document.querySelector('.apb-actions-section');
    return sec ? sec.querySelector('.apb-empty-message')?.textContent || null : 'MISSING';
  });
  assert.match(initialActions || '', /clicked/, 'the Actions section is seeded immediately after selection, no stray store event needed');

  const addedLink = await page.eval(() => new Promise((resolve) => {
    const addBtn = Array.from(document.querySelectorAll('.apb-actions-section .apb-btn')).find((b) => b.textContent.includes('Add action'));
    addBtn.click();
    requestAnimationFrame(() => {
      const item = Array.from(document.querySelectorAll('.apb-menu [role="menuitem"]')).find((b) => b.textContent.includes('Go to URL'));
      item.click();
      requestAnimationFrame(() => {
        const app = APB.app;
        resolve(app.store.doc.nodes[app.store.selection[0]].actions);
      });
    });
  }));
  assert.equal(addedLink.length, 1, 'one action added');
  assert.equal(addedLink[0].trigger, 'click', 'buttons default to the click trigger');
  assert.equal(addedLink[0].type, 'link');
  const buttonActionId = addedLink[0].id;

  const historyBefore = await page.eval(() => APB.app.store.history().index);
  await page.eval(() => {
    const input = document.querySelector('.apb-actions-card input[type="url"], .apb-actions-card input[type="text"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await frames(page, 1);
  const urlSaved = await page.eval(() => {
    const app = APB.app;
    return app.store.doc.nodes[app.store.selection[0]].actions[0].url;
  });
  // The document keeps the raw typed value; sanitize.url() normalization (https://example.com/)
  // happens defensively at export/render time in vdom's decorate(), checked further below.
  assert.equal(urlSaved, 'https://example.com', 'the URL field commits to the document on blur');
  assert.equal(await page.eval(() => APB.app.store.history().index), historyBefore + 1, 'the whole typing burst is one undo entry');

  /* ------------------------------------------------------ checklist + change */
  const checklist = await page.eval(() => {
    const app = APB.app;
    const [id] = app.docops.insert(app, [{ type: 'checklist' }], { select: true });
    const n = app.store.doc.nodes[id];
    return { id, itemCount: n.props.items.length };
  });
  assert.equal(checklist.itemCount, 3, 'checklist defaults to three items');
  await frames(page, 2);
  const checklistState = await page.eval(() => {
    const sec = document.querySelector('.apb-actions-section');
    const rows = document.querySelectorAll('.apb-listedit--checkable .apb-listedit-row').length;
    return { emptyMsg: sec.querySelector('.apb-empty-message')?.textContent || null, checkableRows: rows };
  });
  assert.match(checklistState.emptyMsg || '', /checked or unchecked/, 'checklist Actions section describes the change trigger');
  assert.equal(checklistState.checkableRows, 3, 'the Items field renders one checkable row per item');

  const changeAction = await page.eval(() => new Promise((resolve) => {
    const addBtn = Array.from(document.querySelectorAll('.apb-actions-section .apb-btn')).find((b) => b.textContent.includes('Add action'));
    addBtn.click();
    requestAnimationFrame(() => {
      const item = Array.from(document.querySelectorAll('.apb-menu [role="menuitem"]')).find((b) => b.textContent.includes('Run custom code'));
      item.click();
      requestAnimationFrame(() => {
        const app = APB.app;
        resolve(app.store.doc.nodes[app.store.selection[0]].actions[0]);
      });
    });
  }));
  assert.equal(changeAction.trigger, 'change', 'checklists default new actions to the change trigger');
  assert.equal(changeAction.type, 'code');
  const checklistId = checklist.id;

  /* --------------------------------------------------------------- export */
  const exported = await page.eval((ids) => {
    const app = APB.app;
    const out = app.services.exporters.html(app.store.doc, { pageId: app.store.view.pageId });
    return {
      hasActionsAttr: out.html.includes('data-apb-actions'),
      hasRuntime: out.html.includes('apbRunAction'),
      hasNodeId: out.html.includes('data-node-id="' + ids.btn + '"') && out.html.includes('data-node-id="' + ids.checklist + '"'),
      hasChecklistMarkup: out.html.includes('apb-checklist-input') && out.html.includes('data-item-id'),
      noUnsafeScheme: !out.html.includes('javascript:'),
      normalizedUrl: out.html.includes('https://example.com/')
    };
  }, { btn: button.id, checklist: checklistId });
  assert.ok(exported.hasActionsAttr && exported.hasRuntime && exported.hasNodeId, 'exported HTML carries actions + node ids + the runtime script');
  assert.ok(exported.hasChecklistMarkup, 'checklist items export as real checkboxes with a stable data-item-id');
  assert.ok(exported.noUnsafeScheme, 'no unsafe URL scheme leaks into the export');
  assert.ok(exported.normalizedUrl, 'the raw URL is normalized (sanitize.url) by vdom at render time, not left as typed');

  /* ----------------------------------------------------- export dialog UI */
  const dialogState = await page.eval(() => new Promise((resolve) => {
    APB.app.commands.run('file.exportCode');
    requestAnimationFrame(() => {
      const dlg = document.querySelector('.apb-dialog');
      resolve({
        open: !!dlg,
        hasCode: !!dlg && dlg.querySelector('.apb-export-code')?.textContent.includes('<!doctype html>'),
        hasFormatSelect: !!dlg && !!dlg.querySelector('.apb-export-controls .apb-select')
      });
    });
  }));
  assert.ok(dialogState.open && dialogState.hasCode && dialogState.hasFormatSelect, 'the export dialog renders generated code with format controls');
  await page.eval(() => document.querySelectorAll('.apb-dialog').forEach((d) => d.remove()));

  /* -------------------------------------------------------------- templates */
  const before = Object.keys(await page.eval(() => APB.app.store.doc.nodes)).length;
  const templateResult = await page.eval(() => new Promise((resolve) => {
    APB.app.commands.run('insert.template');
    requestAnimationFrame(() => {
      const dlg = document.querySelector('.apb-dialog');
      const titles = Array.from(dlg.querySelectorAll('.apb-template-card-title')).map((e) => e.textContent);
      const card = Array.from(dlg.querySelectorAll('.apb-template-card')).find((c) => c.textContent.includes('Hero'));
      card.click();
      requestAnimationFrame(() => resolve({ titles, dialogClosed: !document.querySelector('.apb-dialog') }));
    });
  }));
  assert.deepEqual(templateResult.titles, ['Hero', 'Pricing', 'Contact form']);
  assert.ok(templateResult.dialogClosed, 'the gallery closes once a template is inserted');
  const after = Object.keys(await page.eval(() => APB.app.store.doc.nodes)).length;
  assert.ok(after > before, 'template insertion added nodes to the document');

  /* --------------------------------------------------------- preview button */
  await page.eval(() => APB.app.store.select([]));
  const previewNoThrow = await page.eval(() => {
    try { APB.app.commands.run('view.preview'); return 'ok'; } catch (err) { return 'threw: ' + err.message; }
  });
  assert.equal(previewNoThrow, 'ok', 'preview command runs without throwing (window.open outcome is a browser-chrome concern, not asserted here)');

  await page.screenshot('actions-templates-export');
  log('button, checklist, actions, templates, export and preview all verified');
}

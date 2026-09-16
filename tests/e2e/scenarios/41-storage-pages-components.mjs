// Persistence (features/storage.js), import (features/importers.js), the asset library
// (features/assets.js), multi-page management (features/pages.js, docops.js page ops) and
// components (features/components.js) — see docs/ARCHITECTURE.md "Contract additions" 2026-09-16.
export const name = 'storage, import, assets, pages and components';
export const viewport = { width: 1440, height: 900 };
export const timeout = 90000;

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert, log }) {
  await page.ready();

  /* ------------------------------------------------------------- services */
  const registry = await page.eval(() => {
    const app = APB.app;
    return {
      storage: !!(app.services && app.services.storage),
      importers: !!(app.services && app.services.importers),
      assets: !!(app.services && app.services.assets),
      commands: ['file.new', 'file.save', 'file.saveAs', 'file.open', 'file.import', 'pages.add', 'pages.manage', 'component.create', 'component.detach']
        .filter((id) => !app.commands.get(id))
    };
  });
  assert.ok(registry.storage && registry.importers && registry.assets, 'storage/importers/assets services are attached');
  assert.deepEqual(registry.commands, [], 'every new command is registered');

  /* -------------------------------------------------------------- storage */
  const saved = await page.eval(async () => {
    const app = APB.app;
    app.store.transact('Rename project', (tx) => tx.setDocField('name', 'E2E persistence test'));
    const id = await app.services.storage.save();
    const list = await app.services.storage.list();
    return { id, currentId: app.services.storage.currentId(), found: list.some((p) => p.id === id && p.name === 'E2E persistence test') };
  });
  assert.ok(saved.id, 'save() resolves to a project id');
  assert.equal(saved.id, saved.currentId);
  assert.ok(saved.found, 'the saved project shows up in list()');

  const reopened = await page.eval(async (id) => {
    const app = APB.app;
    app.docops.insert(app, [{ type: 'text', props: { text: 'should vanish on reopen' } }], { select: false });
    const before = Object.keys(app.store.doc.nodes).length;
    const ok = await app.services.storage.open(id);
    const after = Object.keys(app.store.doc.nodes).length;
    return { ok, before, after, name: app.store.doc.name };
  }, saved.id);
  assert.ok(reopened.ok, 'open() loads the saved project');
  assert.equal(reopened.name, 'E2E persistence test');
  assert.ok(reopened.after < reopened.before, 'opening replaces the document — the unsaved node from before the save is gone');

  /* ------------------------------------------------------------- importers */
  const pasted = await page.eval(async () => {
    const app = APB.app;
    const pageRoot = app.store.doc.pages.find((p) => p.id === app.store.view.pageId).root;
    const before = Object.keys(app.store.doc.nodes).length;
    const ids = await app.services.importers.fromHTML(
      '<h1>Imported heading</h1><p>Imported <b>paragraph</b>.</p><ul><li>One</li><li>Two</li></ul><img src="https://example.com/pic.png" alt="pic">',
      { parent: pageRoot }
    );
    const types = ids.map((id) => app.store.doc.nodes[id].type);
    return { count: ids.length, types, after: Object.keys(app.store.doc.nodes).length, before };
  });
  assert.ok(pasted.count >= 4, 'fromHTML inserted a node per top-level element: ' + JSON.stringify(pasted.types));
  assert.deepEqual(pasted.types.sort(), ['image', 'list', 'text', 'text'].sort());

  const badImport = await page.eval(async () => {
    const app = APB.app;
    try {
      await app.services.importers.fromFile(new File(['not json'], 'x.json', { type: 'application/json' }));
      return 'did-not-throw';
    } catch (err) {
      return err.message;
    }
  });
  assert.match(badImport, /not valid JSON/);

  /* ---------------------------------------------------------------- assets */
  const asset = await page.eval(async () => {
    const app = APB.app;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAG0lEQVR42mNk+M9QzzCKRsEoGgWjYBSMglEwCgYAJsQD/a0lGJcAAAAASUVORK5CYII=';
    const bin = atob(png);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });
    const id = await app.services.assets.add(file);
    const url = app.services.assets.url(id);
    const list = app.services.assets.list();
    return { id, hasUrl: url.startsWith('data:image/png'), found: list.some((a) => a.id === id), removed: app.services.assets.remove(id) };
  });
  assert.ok(asset.id && asset.hasUrl, 'add() stores a data: URL');
  assert.ok(asset.found, 'the new asset appears in list()');
  assert.ok(asset.removed, 'remove() succeeds');

  /* ---------------------------------------------------------------- pages */
  await page.eval(() => APB.app.ui.showPanel('layers'));
  const pageFlow = await page.eval(() => {
    const app = APB.app;
    const before = app.store.doc.pages.length;
    app.commands.run('pages.add');
    const afterAdd = app.store.doc.pages.length;
    const newId = app.store.view.pageId;
    const dupId = app.docops.duplicatePage(app.store, app.store.doc.pages[0].id);
    const afterDup = app.store.doc.pages.length;
    const slugOk = app.docops.setPageSlug(app.store, newId, 'About Us');
    const seoOk = app.docops.setPageSeo(app.store, newId, { title: 'About', noindex: true });
    return {
      before, afterAdd, afterDup, switchedToNew: newId !== app.store.doc.pages[0].id,
      slugOk, seoOk, slug: app.store.doc.pages.find((p) => p.id === newId).slug,
      noindex: app.store.doc.pages.find((p) => p.id === newId).seo.noindex, dupId
    };
  });
  assert.equal(pageFlow.afterAdd, pageFlow.before + 1, 'pages.add appended a page');
  assert.ok(pageFlow.switchedToNew, 'pages.add switches the active page to the new one');
  assert.equal(pageFlow.afterDup, pageFlow.afterAdd + 1, 'duplicatePage appended another');
  assert.ok(pageFlow.slugOk && pageFlow.seoOk);
  assert.equal(pageFlow.slug, 'about-us');
  assert.equal(pageFlow.noindex, true);

  await frames(page, 2);
  const switcherUi = await page.eval(() => {
    const addBtn = document.querySelector('.apb-layers-head [aria-label="Add page"]');
    const sel = document.querySelector('.apb-layers-page select');
    return { hasAdd: !!addBtn, optionCount: sel ? sel.options.length - 1 : 0 }; // -1 for the hidden "Mixed" placeholder option
  });
  assert.ok(switcherUi.hasAdd, 'the Layers panel head has an Add page button');
  assert.equal(switcherUi.optionCount, pageFlow.afterDup, 'the page switcher lists every page');

  /* ----------------------------------------------------------- components */
  const compFlow = await page.eval(() => {
    const app = APB.app;
    const pageRoot = app.store.doc.pages.find((p) => p.id === app.store.view.pageId).root;
    const [cardId] = app.docops.insert(app, [{
      type: 'frame', name: 'Card', w: 200, h: 120, layout: { mode: 'stack', dir: 'column', gap: 8, pad: [12, 12, 12, 12] },
      children: [{ type: 'text', props: { text: 'Reusable card' } }]
    }], { parent: pageRoot, select: true });
    const beforeComponents = Object.keys(app.store.doc.components || {}).length;
    app.commands.run('component.create');
    const afterCreate = Object.keys(app.store.doc.components || {}).length;
    const instanceId = app.store.selection[0];
    const instanceType = app.store.doc.nodes[instanceId].type;
    const compId = app.store.doc.nodes[instanceId].props.component;

    const secondInstanceId = app.docops.instantiate(app, compId, {});
    const nodesBeforeDetach = Object.keys(app.store.doc.nodes).length;
    app.store.select([secondInstanceId]);
    app.commands.run('component.detach');
    const detachedType = app.store.doc.nodes[app.store.selection[0]] && app.store.doc.nodes[app.store.selection[0]].type;

    return { beforeComponents, afterCreate, instanceType, compId: !!compId, secondInstanceId: !!secondInstanceId, nodesBeforeDetach, detachedType };
  });
  assert.equal(compFlow.afterCreate, compFlow.beforeComponents + 1, 'component.create added one component definition');
  assert.equal(compFlow.instanceType, 'instance', 'the selection became a component instance');
  assert.ok(compFlow.compId, 'the instance references a component id');
  assert.ok(compFlow.secondInstanceId, 'instantiate() placed a second instance');
  assert.equal(compFlow.detachedType, 'frame', 'component.detach turned the instance back into a plain frame');

  await frames(page, 2);
  const panel = await page.eval(() => {
    const tab = Array.from(document.querySelectorAll('.apb-side--left [role="tab"]')).find((t) => t.textContent.includes('Components'));
    if (tab) tab.click();
    return { hasTab: !!tab };
  });
  assert.ok(panel.hasTab, 'a Components tab is registered in the left panel');
  await frames(page, 2);
  const compPanel = await page.eval(() => !!document.querySelector('.apb-component-row'));
  assert.ok(compPanel, 'the Components panel lists the created component');

  await page.screenshot('storage-pages-components');
  log('storage, importers, assets, pages and components all verified');
}

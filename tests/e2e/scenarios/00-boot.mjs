// Boot: the built single-file app loads from file://, creates the app object and reports no errors.
export const name = 'app boots from file:// without errors';

export async function run(page, { assert }) {
  await page.ready();
  const info = await page.eval(() => {
    const app = window.APB.app;
    const doc = app.store.doc;
    return {
      version: window.APB.version,
      format: doc.format,
      docVersion: doc.version,
      pages: doc.pages.length,
      hasRoot: !!doc.nodes[doc.pages[0].root],
      title: document.title,
      modules: window.APB.list().length
    };
  });
  assert.equal(info.format, 'apb');
  assert.equal(info.docVersion, 2);
  assert.ok(info.pages >= 1, 'document has a page');
  assert.ok(info.hasRoot, 'page root node exists');
  assert.match(info.title, /Advanced Page Builder/);
  assert.ok(info.modules >= 10, 'core modules registered');
  await page.screenshot('boot');
}

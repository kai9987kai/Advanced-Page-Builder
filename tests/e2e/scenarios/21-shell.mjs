// Shell: toolbar/panels/status render, tab keyboard navigation, splitters, panel toggles, theme, dialogs (confirm/prompt/Esc),
// toasts, main menu (Edit items), canvas context menu, drawers below 900 px, log ring buffer, error toasts, accessible names.
export const name = 'shell: toolbar, panels, menus, dialogs, toasts, theme';
export const viewport = { width: 1280, height: 800 };
export const timeout = 60000;
export const allowErrors = [/e2e-intentional-error/];

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert }) {
  await page.ready();
  await page.eval(() => APB.require('dialogs').toasts.forEach((t) => t.close()));
  // this scenario asserts the bare shell, so the feature panels registered at boot step aside
  await page.eval(() => { APB.app.ui.unregisterPanel('layers'); APB.app.ui.unregisterPanel('design'); });

  /* ------------------------------------------------------------ structure */
  const base = await page.eval(() => {
    const ui = APB.app.ui;
    const fns = ['registerPanel', 'showPanel', 'registerToolbarItem', 'registerStatusItem', 'registerMenuItem', 'registerInspectorSection',
      'inspectorSections', 'toast', 'confirm', 'prompt', 'dialog', 'menu', 'announce'];
    return {
      missing: fns.filter((f) => typeof ui[f] !== 'function'),
      toolbar: !!document.querySelector('header.apb-toolbar'),
      status: !!document.querySelector('footer.apb-statusbar'),
      hostHasCanvas: !!document.querySelector('.apb-canvas-host .apb-viewport'),
      hostIsUi: ui.canvasHost === document.querySelector('.apb-canvas-host'),
      tools: Array.from(document.querySelectorAll('.apb-tools [data-tool]')).map((b) => b.dataset.tool),
      selectPressed: document.querySelector('.apb-tools [data-tool="select"]').getAttribute('aria-pressed'),
      name: document.querySelector('.apb-project-name').value,
      docName: APB.app.store.doc.name,
      undoDisabled: document.querySelector('.apb-undo-btn').getAttribute('aria-disabled'),
      zoomText: document.querySelector('.apb-zoom-btn .apb-zoom-value').textContent,
      storeZoom: APB.app.store.view.zoom,
      statusText: document.querySelector('.apb-status-selection').textContent,
      theme: document.documentElement.dataset.theme,
      leftHidden: document.querySelector('.apb-side--left').hidden
    };
  });
  assert.deepEqual(base.missing, [], 'app.ui API complete');
  assert.ok(base.toolbar && base.status, 'toolbar and status bar render');
  assert.ok(base.hostHasCanvas && base.hostIsUi, 'canvas mounted into ui.canvasHost');
  assert.deepEqual(base.tools, ['select', 'hand', 'frame', 'section', 'text', 'rect', 'ellipse', 'line', 'image', 'button', 'checklist']);
  assert.equal(base.selectPressed, 'true');
  assert.equal(base.name, base.docName);
  assert.equal(base.undoDisabled, 'true', 'undo disabled with empty history');
  assert.equal(base.zoomText, Math.round(base.storeZoom * 100) + '%');
  assert.equal(base.statusText, 'No selection');
  assert.equal(base.theme, 'system');
  assert.ok(base.leftHidden, 'side panel hidden while it has no panels');

  // tool buttons follow store.view.tool
  await page.click('.apb-tools [data-tool="rect"]');
  await frames(page, 1);
  const tool = await page.eval(() => ({ tool: APB.app.store.view.tool, pressed: document.querySelector('.apb-tools [data-tool="rect"]').getAttribute('aria-pressed') }));
  assert.equal(tool.tool, 'rect');
  assert.equal(tool.pressed, 'true');
  await page.eval(() => APB.app.store.setView({ tool: 'select' }));

  // project name → doc name (undoable)
  await page.click('.apb-project-name');
  await page.key('Mod+A');
  await page.type('Shell test project');
  await page.key('Enter');
  await frames(page, 2);
  const named = await page.eval(() => ({ name: APB.app.store.doc.name, canUndo: APB.app.store.canUndo(), title: document.title,
    undoDisabled: document.querySelector('.apb-undo-btn').getAttribute('aria-disabled') }));
  assert.equal(named.name, 'Shell test project');
  assert.ok(named.canUndo, 'rename is undoable');
  assert.match(named.title, /Shell test project/);
  assert.equal(named.undoDisabled, null, 'undo enabled after a change');

  /* ---------------------------------------------------------------- panels */
  await page.eval(() => {
    const { h } = APB.require('widgets');
    window.__mounts = { a: 0, b: 0, r: 0 };
    const ui = APB.app.ui;
    ui.registerPanel({ id: 'test-a', side: 'left', title: 'Alpha', icon: 'layers', order: 1,
      mount(el) { window.__mounts.a++; el.append(h('button', { type: 'button', class: 'test-a-btn' }, 'Alpha action')); return {}; } });
    ui.registerPanel({ id: 'test-b', side: 'left', title: 'Beta', icon: 'insert', order: 2,
      mount(el) { window.__mounts.b++; el.append(h('p', {}, 'Beta content')); return { update() { window.__mounts.bUpdated = true; } }; } });
    ui.registerPanel({ id: 'test-r', side: 'right', title: 'Design', icon: 'design', badge: () => 3,
      mount(el) { window.__mounts.r++; el.append(h('p', {}, 'Right content')); return {}; } });
    ui.registerToolbarItem({ id: 'test-bp', area: 'center', render: () => h('button', { type: 'button', class: 'test-center-btn' }, 'Desktop') });
    ui.registerToolbarItem({ id: 'test-export', area: 'end', order: 5, render: () => h('button', { type: 'button', class: 'test-end-btn' }, 'Export') });
    ui.registerStatusItem({ id: 'test-status', side: 'end', render: () => h('span', { class: 'test-status' }, 'Saved') });
    ui.registerInspectorSection({ id: 'insp-b', order: 20, title: 'B', applies: () => true, mount: () => ({ update() {} }) });
    ui.registerInspectorSection({ id: 'insp-a', order: 10, title: 'A', applies: () => true, mount: () => ({ update() {} }) });
  });
  await frames(page, 2);
  const panels = await page.eval(() => {
    const tabs = Array.from(document.querySelectorAll('.apb-side--left [role="tab"]'));
    return {
      leftVisible: !document.querySelector('.apb-side--left').hidden,
      rightVisible: !document.querySelector('.apb-side--right').hidden,
      tablist: document.querySelector('.apb-side--left .apb-tabs').getAttribute('role'),
      tabs: tabs.map((t) => ({ id: t.dataset.panel, selected: t.getAttribute('aria-selected'), tabindex: t.getAttribute('tabindex'), controls: t.getAttribute('aria-controls') })),
      panelRole: document.getElementById(tabs[0].getAttribute('aria-controls')).getAttribute('role'),
      mounts: Object.assign({}, window.__mounts),
      badge: document.querySelector('[data-panel="test-r"] .apb-tab-badge').textContent,
      center: !!document.querySelector('.apb-toolbar-center .test-center-btn'),
      end: !!document.querySelector('.apb-toolbar-end .test-end-btn'),
      statusItem: !!document.querySelector('.apb-statusbar .test-status'),
      inspector: APB.app.ui.inspectorSections().map((s) => s.id)
    };
  });
  assert.ok(panels.leftVisible && panels.rightVisible, 'side panels visible once panels are registered');
  assert.equal(panels.tablist, 'tablist');
  assert.deepEqual(panels.tabs.map((t) => t.id), ['test-a', 'test-b']);
  assert.equal(panels.tabs[0].selected, 'true');
  assert.equal(panels.tabs[0].tabindex, '0');
  assert.equal(panels.tabs[1].tabindex, '-1');
  assert.equal(panels.panelRole, 'tabpanel');
  assert.deepEqual([panels.mounts.a, panels.mounts.b, panels.mounts.r], [1, 0, 1], 'only active panels are mounted (lazy)');
  assert.equal(panels.badge, '3');
  assert.ok(panels.center && panels.end && panels.statusItem, 'toolbar/status items placed in their slots');
  assert.deepEqual(panels.inspector, ['insp-a', 'insp-b', 'actions'], 'inspector sections sorted by order');

  // keyboard tab switching
  await page.eval(() => document.querySelector('[role="tab"][data-panel="test-a"]').focus());
  await page.key('ArrowRight');
  const afterRight = await page.eval(() => ({
    selected: document.querySelector('[role="tab"][aria-selected="true"]').dataset.panel,
    focus: document.activeElement.dataset.panel,
    pref: APB.app.store.prefs.leftTab,
    mountedB: window.__mounts.b,
    updated: !!window.__mounts.bUpdated,
    betaVisible: !document.getElementById('apb-tabpanel-test-b').hidden,
    alphaHidden: document.getElementById('apb-tabpanel-test-a').hidden
  }));
  assert.equal(afterRight.selected, 'test-b', 'ArrowRight selects the next tab');
  assert.equal(afterRight.focus, 'test-b');
  assert.equal(afterRight.pref, 'test-b', 'active tab persisted in prefs');
  assert.equal(afterRight.mountedB, 1, 'panel mounted on first activation');
  assert.ok(afterRight.updated && afterRight.betaVisible && afterRight.alphaHidden);
  await page.key('ArrowRight');
  assert.equal(await page.eval(() => document.activeElement.dataset.panel), 'test-a', 'arrow keys wrap around');
  await page.key('End');
  assert.equal(await page.eval(() => APB.app.store.prefs.leftTab), 'test-b');
  await page.key('Home');
  assert.equal(await page.eval(() => APB.app.store.prefs.leftTab), 'test-a');

  // showPanel
  await page.eval(() => APB.app.ui.showPanel('test-b'));
  assert.equal(await page.eval(() => document.querySelector('.apb-side--left [aria-selected="true"]').dataset.panel), 'test-b');

  /* -------------------------------------------------------------- splitter */
  const w0 = await page.eval(() => APB.app.store.prefs.leftWidth);
  await page.eval(() => document.querySelector('.apb-splitter--left').focus());
  await page.key('ArrowRight');
  await frames(page, 1);
  const split = await page.eval(() => ({
    pref: APB.app.store.prefs.leftWidth,
    now: document.querySelector('.apb-splitter--left').getAttribute('aria-valuenow'),
    role: document.querySelector('.apb-splitter--left').getAttribute('role'),
    width: document.querySelector('.apb-side--left').getBoundingClientRect().width
  }));
  assert.equal(split.pref, w0 + 10, 'ArrowRight widens the left panel by 10px');
  assert.equal(split.now, String(w0 + 10));
  assert.equal(split.role, 'separator');
  assert.ok(Math.abs(split.width - (w0 + 10)) < 1.5, 'left panel width follows the pref: ' + split.width);
  await page.key('ArrowLeft', ['Shift']);
  assert.equal(await page.eval(() => APB.app.store.prefs.leftWidth), w0 - 40);
  await page.eval(() => document.querySelector('.apb-splitter--right').focus());
  const r0 = await page.eval(() => APB.app.store.prefs.rightWidth);
  await page.key('ArrowLeft');
  assert.equal(await page.eval(() => APB.app.store.prefs.rightWidth), r0 + 10, 'ArrowLeft widens the right panel');
  // pointer drag + double-click reset
  const sp = await page.rect('.apb-splitter--left');
  const sx = Math.round(sp.x + sp.w / 2);
  const sy = Math.round(sp.y + sp.h / 2);
  await page.drag(sx, sy, sx + 60, sy, { steps: 6 });
  await frames(page, 1);
  const dragged = await page.eval(() => APB.app.store.prefs.leftWidth);
  assert.ok(Math.abs(dragged - (w0 - 40 + 60)) <= 2, 'dragging the splitter resizes: ' + dragged);
  await page.eval(() => document.querySelector('.apb-splitter--left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  assert.equal(await page.eval(() => APB.app.store.prefs.leftWidth), 280, 'double-click resets the width');

  /* ------------------------------------------------------ collapse (Mod+\) */
  await page.eval(() => APB.app.canvas.el.focus());
  await page.key('Mod+\\');
  await frames(page, 1);
  const collapsed = await page.eval(() => ({ l: document.querySelector('.apb-side--left').hidden, r: document.querySelector('.apb-side--right').hidden,
    exp: document.querySelector('.apb-side-toggle--left').getAttribute('aria-expanded') }));
  assert.ok(collapsed.l && collapsed.r, 'Mod+\\ hides both panels');
  assert.equal(collapsed.exp, 'false');
  await page.key('Mod+\\');
  await frames(page, 1);
  assert.ok(await page.eval(() => !document.querySelector('.apb-side--left').hidden && !document.querySelector('.apb-side--right').hidden), 'Mod+\\ shows them again');

  /* --------------------------------------------------------------- selection */
  const nodeId = await page.eval(() => {
    const app = APB.app;
    const [section] = app.docops.insert(app.store, [{ type: 'section' }]);
    const [id] = app.docops.insert(app.store, [{ type: 'shape', x: 40, y: 50, w: 120, h: 80, name: 'Card shape' }], { parent: section });
    app.store.select([id]);
    return id;
  });
  await frames(page, 2);
  const statusSel = await page.eval(() => document.querySelector('.apb-status-selection').textContent);
  assert.ok(nodeId, 'node inserted');
  assert.match(statusSel, /X 40/);
  assert.match(statusSel, /Y 50/);
  assert.match(statusSel, /W 120/);
  assert.match(statusSel, /H 80/);

  /* ------------------------------------------------------------------ theme */
  await page.eval(() => APB.app.commands.run('view.theme.light'));
  await frames(page, 2);
  assert.equal(await page.eval(() => document.documentElement.dataset.theme), 'light');
  await page.screenshot('light');
  await page.eval(() => APB.app.commands.run('view.theme.dark'));
  await frames(page, 2);
  const dark = await page.eval(() => ({ theme: document.documentElement.dataset.theme, pref: APB.app.store.prefs.theme,
    bg: getComputedStyle(document.querySelector('.apb-toolbar')).backgroundColor }));
  assert.equal(dark.theme, 'dark');
  assert.equal(dark.pref, 'dark');
  assert.equal(dark.bg, 'rgb(23, 25, 29)', 'dark tokens applied to the toolbar');
  await page.screenshot('dark');
  await page.click('.apb-status-theme');
  assert.equal(await page.eval(() => document.documentElement.dataset.theme), 'system', 'theme button cycles dark → system');
  await page.eval(() => APB.app.commands.run('view.theme.light'));

  /* ---------------------------------------------------------------- dialogs */
  await page.eval(() => { window.__confirm = null; APB.app.ui.confirm({ title: 'Delete page?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }).then((v) => { window.__confirm = v; }); });
  const confirmState = await page.eval(() => {
    const d = document.querySelector('dialog.apb-dialog[open]');
    return { open: !!d, modal: d && d.matches(':modal'), role: d && d.getAttribute('role'), labelled: d && document.getElementById(d.getAttribute('aria-labelledby')).textContent,
      focusInside: d && d.contains(document.activeElement), focusText: document.activeElement.textContent };
  });
  assert.ok(confirmState.open && confirmState.modal, 'confirm opens a modal <dialog>');
  assert.equal(confirmState.role, 'alertdialog');
  assert.equal(confirmState.labelled, 'Delete page?');
  assert.ok(confirmState.focusInside, 'focus moves into the dialog');
  assert.equal(confirmState.focusText, 'Cancel', 'danger confirm focuses Cancel');
  for (let i = 0; i < 4; i++) await page.key('Tab');
  assert.ok(await page.eval(() => document.querySelector('dialog.apb-dialog[open]').contains(document.activeElement)), 'Tab stays trapped in the dialog');
  await page.click('dialog.apb-dialog[open] .apb-btn--danger');
  await page.waitFor(() => window.__confirm !== null);
  assert.equal(await page.eval(() => window.__confirm), true, 'confirm resolves true on OK');
  assert.equal(await page.eval(() => document.querySelectorAll('dialog.apb-dialog').length), 0, 'dialog removed');

  // Escape closes and restores focus
  await page.eval(() => document.querySelector('.apb-zoom-btn').focus());
  await page.eval(() => { window.__confirm = null; APB.app.ui.confirm({ title: 'Continue?', message: 'Proceed?' }).then((v) => { window.__confirm = v; }); });
  assert.equal(await page.eval(() => document.activeElement.textContent), 'OK', 'non-danger confirm focuses OK');
  await page.key('Escape');
  await page.waitFor(() => window.__confirm !== null);
  const esc = await page.eval(() => ({ v: window.__confirm, open: !!document.querySelector('dialog.apb-dialog'), focus: document.activeElement.classList.contains('apb-zoom-btn') }));
  assert.equal(esc.v, false, 'Esc resolves confirm false');
  assert.ok(!esc.open, 'Esc closes the dialog');
  assert.ok(esc.focus, 'focus returns to the previously focused element');

  // generic dialog + Esc
  await page.eval(() => {
    const { h } = APB.require('widgets');
    window.__closed = undefined;
    const d = APB.app.ui.dialog({ title: 'Settings', content: h('div', {}, h('button', { type: 'button', class: 'test-dlg-btn' }, 'Inner')), actions: [{ label: 'Done', kind: 'primary', run: (close) => close('done') }] });
    d.closed.then((v) => { window.__closed = v === undefined ? 'dismissed' : v; });
  });
  assert.ok(await page.eval(() => document.activeElement.classList.contains('test-dlg-btn')), 'dialog focuses the first focusable in its content');
  await page.screenshot('dialog');
  await page.key('Escape');
  await page.waitFor(() => window.__closed !== undefined);
  assert.equal(await page.eval(() => window.__closed), 'dismissed');
  assert.ok(await page.eval(() => document.activeElement.classList.contains('apb-zoom-btn')), 'focus restored after Esc');

  // prompt with validation
  await page.eval(() => { window.__prompt = undefined; APB.app.ui.prompt({ title: 'Rename', label: 'Name', value: '', validate: (v) => (v.trim() ? null : 'Name is required') }).then((v) => { window.__prompt = v; }); });
  await page.key('Enter');
  const invalid = await page.eval(() => ({ err: document.querySelector('.apb-dialog-error').textContent, open: !!document.querySelector('dialog.apb-dialog[open]') }));
  assert.equal(invalid.err, 'Name is required');
  assert.ok(invalid.open, 'invalid prompt stays open');
  await page.type('Hero');
  await page.key('Enter');
  await page.waitFor(() => window.__prompt !== undefined);
  assert.equal(await page.eval(() => window.__prompt), 'Hero');

  /* ------------------------------------------------------------------ toasts */
  await page.eval(() => { window.__undoToast = 0; APB.app.ui.toast('Layer deleted', { kind: 'success', action: { label: 'Undo', run: () => { window.__undoToast++; } }, timeout: 0 }); });
  const toast = await page.eval(() => {
    const t = document.querySelector('.apb-toast--success');
    return { exists: !!t, text: t && t.querySelector('.apb-toast-message').textContent, role: t && t.getAttribute('role'), live: document.querySelector('.apb-toasts').getAttribute('aria-live'),
      visible: !!(t && t.getBoundingClientRect().height > 0) };
  });
  assert.ok(toast.exists && toast.visible, 'toast appears');
  assert.equal(toast.text, 'Layer deleted');
  assert.equal(toast.role, 'status');
  assert.equal(toast.live, 'polite');
  await page.screenshot('toast');
  await page.click('.apb-toast--success .apb-toast-action');
  assert.equal(await page.eval(() => window.__undoToast), 1, 'toast action runs');
  assert.ok(await page.eval(() => !document.querySelector('.apb-toast--success')), 'toast closes after its action');
  await page.mouse('move', 400, 300); // hovering a toast pauses its timer
  await page.eval(() => APB.app.ui.toast('Short lived', { timeout: 150 }));
  await page.waitFor(() => !Array.from(document.querySelectorAll('.apb-toast')).some((t) => t.textContent.includes('Short lived')), 3000);

  /* --------------------------------------------------------------- app menu */
  await page.eval(() => {
    window.__menuRuns = [];
    APB.app.commands.register({ id: 'test.editThing', title: 'Test command', category: 'Edit', keys: ['Mod+Shift+9'], run: () => window.__menuRuns.push('cmd') });
    APB.app.ui.registerMenuItem({ menu: 'edit', command: 'test.editThing', order: 2 });
    APB.app.ui.registerMenuItem({ menu: 'edit', command: { label: 'Test edit action', run: () => window.__menuRuns.push('plain') }, order: 1 });
    APB.app.ui.registerMenuItem({ menu: 'edit', command: 'does.not.exist', order: 3 });
  });
  await page.click('.apb-appmenu-btn');
  const top = await page.eval(() => {
    const m = document.querySelector('.apb-menu[role="menu"]');
    return { open: !!m, expanded: document.querySelector('.apb-appmenu-btn').getAttribute('aria-expanded'),
      labels: m ? Array.from(m.querySelectorAll('[role^="menuitem"]')).map((i) => i.textContent) : [],
      focusInMenu: !!(m && m.contains(document.activeElement)) };
  });
  assert.ok(top.open, 'main menu opens');
  assert.equal(top.expanded, 'true');
  assert.ok(top.labels.includes('Edit') && top.labels.includes('View'), 'main menu lists Edit and View: ' + top.labels.join(','));
  assert.ok(!top.labels.includes('File'), 'empty menus are omitted');
  assert.ok(top.focusInMenu, 'focus moves into the menu');
  await page.key('e');
  assert.equal(await page.eval(() => document.activeElement.textContent), 'Edit', 'typeahead focuses Edit');
  await page.key('ArrowRight');
  await frames(page, 1);
  const sub = await page.eval(() => {
    const menus = document.querySelectorAll('.apb-menu[role="menu"]');
    const m = menus[menus.length - 1];
    const items = Array.from(m.querySelectorAll('[role^="menuitem"]'));
    return { count: menus.length, labels: items.map((i) => i.querySelector('.apb-menu-label').textContent),
      shortcut: items[1] && items[1].querySelector('.apb-menu-shortcut') && items[1].querySelector('.apb-menu-shortcut').textContent,
      keyshortcuts: items[1] && items[1].getAttribute('aria-keyshortcuts'),
      focus: document.activeElement.textContent };
  });
  assert.equal(sub.count, 2, 'Edit submenu opened');
  // basic-commands (B2b-2) adds its own Edit items with order >= 10 after these two
  assert.deepEqual(sub.labels.slice(0, 2), ['Test edit action', 'Test command'], 'Edit menu lists registered items in order');
  assert.ok(!sub.labels.some((l) => /does\.not\.exist/.test(l)), 'unknown commands skipped');
  assert.ok(sub.shortcut && /9/.test(sub.shortcut), 'command shortcut shown: ' + sub.shortcut);
  assert.match(sub.keyshortcuts || '', /Shift\+9/);
  assert.equal(sub.focus, 'Test edit action');
  await page.screenshot('main-menu');
  await page.key('ArrowDown');
  await page.key('Enter');
  const ran = await page.eval(() => ({ runs: window.__menuRuns.slice(), menus: document.querySelectorAll('.apb-menu').length, focusBtn: document.activeElement.classList.contains('apb-appmenu-btn') }));
  assert.deepEqual(ran.runs, ['cmd'], 'Enter runs the command');
  assert.equal(ran.menus, 0, 'menus close after activation');
  assert.ok(ran.focusBtn, 'focus returns to the menu button');

  // ArrowLeft closes a submenu, Escape closes the root
  await page.key('ArrowDown');
  await page.key('v');
  await page.key('ArrowRight');
  const viewLabels = await page.eval(() => {
    const menus = document.querySelectorAll('.apb-menu[role="menu"]');
    return Array.from(menus[menus.length - 1].querySelectorAll('.apb-menu-label')).map((l) => l.textContent);
  });
  assert.ok(viewLabels.includes('Zoom to fit page') && viewLabels.includes('Dark theme') && viewLabels.includes('Toggle panels'), 'View menu: ' + viewLabels.join(','));
  await page.key('ArrowLeft');
  assert.equal(await page.eval(() => document.querySelectorAll('.apb-menu').length), 1, 'ArrowLeft closes the submenu');
  assert.equal(await page.eval(() => document.activeElement.textContent), 'View');
  await page.key('Escape');
  assert.equal(await page.eval(() => document.querySelectorAll('.apb-menu').length), 0, 'Escape closes the menu');

  // zoom menu runs a view command
  await page.click('.apb-zoom-btn');
  const zoomItems = await page.eval(() => Array.from(document.querySelectorAll('.apb-menu .apb-menu-label')).map((l) => l.textContent));
  assert.ok(zoomItems.includes('Zoom in') && zoomItems.includes('Zoom to fit page'), 'zoom menu items: ' + zoomItems.join(','));
  await page.eval(() => Array.from(document.querySelectorAll('.apb-menu .apb-menu-item')).find((b) => b.textContent === '200%').click());
  await frames(page, 2);
  const z = await page.eval(() => ({ zoom: APB.app.store.view.zoom, text: document.querySelector('.apb-zoom-btn .apb-zoom-value').textContent, status: document.querySelector('.apb-status-zoom .apb-zoom-value').textContent }));
  assert.equal(z.zoom, 2);
  assert.equal(z.text, '200%');
  assert.equal(z.status, '200%');

  /* ------------------------------------------------------------ context menu */
  await page.eval((id) => { APB.app.store.select([]); APB.app.emit('canvas:contextmenu', { clientX: 640, clientY: 400, nodeId: id }); }, nodeId);
  const ctx = await page.eval(() => {
    const m = document.querySelector('.apb-menu[role="menu"]');
    const allowed = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.delete', 'arrange.group', 'arrange.ungroup', 'arrange.wrapStack',
      'arrange.bringForward', 'arrange.sendBackward', 'arrange.bringToFront', 'arrange.sendToBack', 'arrange.lock', 'arrange.hide', 'component.create', 'view.zoomSelection'];
    const items = m ? Array.from(m.querySelectorAll('[role^="menuitem"]')) : [];
    const r = m && m.getBoundingClientRect();
    return {
      open: !!m, commands: items.map((i) => i.dataset.command), expected: allowed.filter((id) => APB.app.commands.get(id)),
      selection: APB.app.store.selection.slice(), near: !!r && Math.abs(r.left - 640) < 4 && Math.abs(r.top - 400) < 4,
      label: m && m.getAttribute('aria-label')
    };
  });
  assert.ok(ctx.open, 'context menu appears');
  assert.deepEqual(ctx.commands, ctx.expected, 'context menu lists exactly the existing commands');
  assert.ok(ctx.commands.includes('view.zoomSelection'));
  assert.deepEqual(ctx.selection, [nodeId], 'context menu target becomes the selection');
  assert.ok(ctx.near, 'context menu placed at the pointer');
  assert.equal(ctx.label, 'Canvas actions');
  await page.screenshot('context-menu');
  // basic-commands (B2b-2) fills in edit/arrange items above it, so focus the zoom item before Enter
  await page.eval(() => document.querySelector('.apb-menu [data-command="view.zoomSelection"]').focus());
  await page.key('Enter');
  await frames(page, 2);
  assert.ok(await page.eval(() => APB.app.store.view.zoom !== 2 && !document.querySelector('.apb-menu')), 'Zoom to selection ran from the context menu');

  /* ------------------------------------------------------- accessible names */
  const unnamed = await page.eval(() => {
    const nameOf = (el) => {
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
      return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
    };
    return Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role^="menuitem"], input:not([type="hidden"]), [role="separator"][tabindex]'))
      .filter((el) => el.getClientRects().length && !el.closest('[hidden]'))
      .filter((el) => {
        if (el.tagName === 'INPUT') return !(el.getAttribute('aria-label') || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label'));
        return !nameOf(el);
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });
  assert.deepEqual(unnamed, [], 'every visible control has an accessible name');

  /* ------------------------------------------------------ drawers < 900px */
  await page.setViewport(820, 700);
  await frames(page, 3);
  const compact = await page.eval(() => ({ compact: document.querySelector('.apb-shell').hasAttribute('data-compact'),
    left: document.querySelector('.apb-side--left').hidden, toggleVisible: !document.querySelector('.apb-side-toggle--left').hidden }));
  assert.ok(compact.compact, 'compact mode below 900px');
  assert.ok(compact.left, 'panels collapse into drawers');
  assert.ok(compact.toggleVisible);
  await page.click('.apb-side-toggle--left');
  await frames(page, 2);
  const drawer = await page.eval(() => {
    const side = document.querySelector('.apb-side--left');
    return { open: !side.hidden, pos: getComputedStyle(side).position, scrim: !document.querySelector('.apb-drawer-scrim').hidden, focus: side.contains(document.activeElement) };
  });
  assert.ok(drawer.open && drawer.pos === 'absolute' && drawer.scrim, 'left drawer opens over the canvas');
  assert.ok(drawer.focus, 'focus moves into the drawer');
  await page.screenshot('compact-drawer');
  await page.key('Escape');
  await frames(page, 1);
  const closedDrawer = await page.eval(() => ({ hidden: document.querySelector('.apb-side--left').hidden, focus: document.activeElement.classList.contains('apb-side-toggle--left') }));
  assert.ok(closedDrawer.hidden && closedDrawer.focus, 'Escape closes the drawer and returns focus');
  await page.setViewport(1280, 800);
  await frames(page, 3);
  assert.ok(await page.eval(() => !document.querySelector('.apb-shell').hasAttribute('data-compact') && !document.querySelector('.apb-side--left').hidden), 'wide layout restored');

  /* ------------------------------------------------------ logs & error toast */
  const logs = await page.eval(() => {
    for (let i = 0; i < 520; i++) APB.app.log('entry ' + i);
    const all = APB.app.logs();
    return { len: all.length, last: all[all.length - 1].message };
  });
  assert.equal(logs.len, 500, 'log ring buffer capped at 500');
  assert.equal(logs.last, 'entry 519');
  await page.eval(() => { setTimeout(() => { throw new Error('e2e-intentional-error'); }, 0); });
  await page.waitFor(() => !!document.querySelector('.apb-toast--error'), 3000);
  const err = await page.eval(() => ({ toast: document.querySelector('.apb-toast--error').textContent, role: document.querySelector('.apb-toast--error').getAttribute('role'),
    logged: APB.app.logs().some((e) => e.level === 'error' && /e2e-intentional-error/.test(e.message)) }));
  assert.match(err.toast, /e2e-intentional-error/);
  assert.equal(err.role, 'alert');
  assert.ok(err.logged, 'uncaught error logged');
}

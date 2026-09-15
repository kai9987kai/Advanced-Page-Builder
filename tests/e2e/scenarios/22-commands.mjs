// Commands (B2b-2): command palette (Mod+K, fuzzy search, recents, prefixes, insert, go to layer), basic edit/arrange
// commands and their document effects, keyboard shortcuts on the canvas vs. text inputs, rename (F2), radial dialog
// (live preview, Cancel reverts, Apply keeps one undo entry), shortcuts dialog (Shift+? / Mod+/ with filter), About, menus.
export const name = 'commands: palette, basic commands, shortcuts, radial dialog';
export const viewport = { width: 1280, height: 800 };
export const timeout = 90000;

const frames = (page, n = 2) => page.eval((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

export async function run(page, { assert }) {
  await page.ready();
  await page.waitFor(() => !!(window.APB.app.canvas && document.querySelector('.apb-viewport .apb-artboard')));
  await page.eval(() => APB.require('dialogs').toasts.forEach((t) => t.close()));

  /* ------------------------------------------------------------ registry */
  const reg = await page.eval(() => {
    const c = APB.app.commands;
    const ids = ['view.palette', 'edit.undo', 'edit.redo', 'edit.delete', 'edit.duplicate', 'edit.rename', 'edit.selectAll',
      'arrange.group', 'arrange.ungroup', 'arrange.wrapStack', 'arrange.wrapFrame', 'arrange.align.left', 'arrange.align.hcenter',
      'arrange.align.right', 'arrange.align.top', 'arrange.align.vcenter', 'arrange.align.bottom', 'arrange.distribute.h',
      'arrange.distribute.v', 'arrange.tidy', 'arrange.radial', 'arrange.matchWidth', 'arrange.matchHeight', 'arrange.bringForward',
      'arrange.sendBackward', 'arrange.bringToFront', 'arrange.sendToBack', 'arrange.lock', 'arrange.hide', 'arrange.rotateLeft',
      'arrange.rotateRight', 'arrange.resetRotation', 'help.shortcuts', 'help.about'];
    return {
      missing: ids.filter((id) => !c.get(id)),
      noIcon: ids.filter((id) => !c.get(id) || !c.get(id).icon || !APB.require('icons').has(c.get(id).icon)),
      paletteKeys: c.keysFor('view.palette'),
      redoKeys: c.keysFor('edit.redo'),
      deleteEnabled: c.enabled('edit.delete'),
      arrangeMenu: APB.app.ui.menuItems('arrange').map((i) => i.label),
      alignSub: (() => {
        const it = APB.app.ui.menuItems('arrange').find((i) => i.label === 'Align');
        const sub = it && (typeof it.submenu === 'function' ? it.submenu() : it.submenu);
        return { disabled: !!(it && it.disabled), labels: (sub || []).map((s) => (s === '-' ? '-' : s.label)) };
      })(),
      editMenu: APB.app.ui.menuItems('edit').map((i) => i.command || i.label),
      helpMenu: APB.app.ui.menuItems('help').map((i) => i.command || i.label)
    };
  });
  assert.deepEqual(reg.missing, [], 'all basic commands registered');
  assert.deepEqual(reg.noIcon, [], 'every command has a known icon');
  assert.deepEqual(reg.paletteKeys, ['Mod+K', 'Mod+Shift+P']);
  assert.deepEqual(reg.redoKeys, ['Mod+Shift+Z', 'Mod+Y']);
  assert.equal(reg.deleteEnabled, false, 'delete disabled without selection');
  for (const label of ['Group', 'Ungroup', 'Align', 'Distribute', 'Order', 'Lock', 'Hide']) assert.ok(reg.arrangeMenu.includes(label), 'arrange menu has ' + label);
  assert.deepEqual(reg.alignSub.labels, ['Align left', 'Align horizontal centers', 'Align right', '-', 'Align top', 'Align vertical centers', 'Align bottom'], 'Align submenu');
  assert.ok(reg.alignSub.disabled, 'Align submenu disabled without selection');
  assert.ok(reg.editMenu.includes('edit.duplicate') && reg.editMenu.includes('edit.undo'), 'edit menu items');
  assert.ok(reg.helpMenu.includes('help.shortcuts') && reg.helpMenu.includes('help.about'), 'help menu items');

  /* ------------------------------------------------------------- setup */
  const setup = await page.eval(() => {
    const app = APB.app;
    const doc = app.store.doc;
    const root = doc.nodes[doc.pages[0].root];
    const section = root.children.find((id) => doc.nodes[id].type === 'section');
    const [a, b] = app.docops.insert(app.store, [
      { type: 'shape', name: 'Alpha', x: 80, y: 60, w: 120, h: 80 },
      { type: 'shape', name: 'Beta', x: 320, y: 180, w: 100, h: 60 }
    ], { parent: section, select: false });
    app.store.clearHistory();
    app.store.select([]);
    const vp = app.canvas.viewport;
    window.__fitCalls = 0;
    const fit = vp.fit;
    vp.fit = function (...args) { window.__fitCalls++; return fit.apply(this, args); };
    return { section, a, b };
  });
  const { section, a, b } = setup;
  await frames(page, 2);

  /* ------------------------------------------------------------- palette */
  await page.eval(() => document.querySelector('.apb-viewport').focus());
  await page.key('Mod+K');
  await frames(page, 1);
  const opened = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-palette');
    const input = dlg && dlg.querySelector('input[role="combobox"]');
    return {
      open: !!(dlg && dlg.open),
      focused: document.activeElement === input,
      controls: input && document.getElementById(input.getAttribute('aria-controls')) ? document.getElementById(input.getAttribute('aria-controls')).getAttribute('role') : null,
      active: input && input.getAttribute('aria-activedescendant'),
      options: dlg ? dlg.querySelectorAll('[role="option"]').length : 0,
      disabledOptions: dlg ? dlg.querySelectorAll('[role="option"][aria-disabled="true"]').length : 0,
      label: dlg && dlg.getAttribute('aria-label')
    };
  });
  assert.ok(opened.open, 'Mod+K opens the palette');
  assert.ok(opened.focused, 'palette input focused');
  assert.equal(opened.controls, 'listbox');
  assert.ok(opened.active, 'an option is active (aria-activedescendant)');
  assert.ok(opened.options > 20, 'lists commands and inserts');
  assert.ok(opened.disabledOptions > 0, 'disabled commands are listed (greyed)');
  assert.equal(opened.label, 'Command palette');

  await page.type('zoom fit');
  await frames(page, 1);
  const zoomFit = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-palette');
    const input = dlg.querySelector('input');
    const active = document.getElementById(input.getAttribute('aria-activedescendant'));
    return { id: active && active.dataset.id, marks: active ? active.querySelectorAll('mark').length : 0 };
  });
  assert.equal(zoomFit.id, 'view.zoomFit', '"zoom fit" ranks Zoom to fit first');
  assert.ok(zoomFit.marks > 0, 'matched characters highlighted');
  await page.screenshot('palette-zoom-fit');
  await page.key('Enter');
  await frames(page, 2);
  const afterRun = await page.eval(() => ({
    open: !!document.querySelector('dialog.apb-palette'),
    fit: window.__fitCalls,
    focus: document.activeElement === document.querySelector('.apb-viewport'),
    recent: APB.app.store.prefs.recentCommands
  }));
  assert.equal(afterRun.open, false, 'palette closes after running');
  assert.equal(afterRun.fit, 1, 'Enter ran view.zoomFit');
  assert.ok(afterRun.focus, 'focus restored to the canvas');
  assert.equal(afterRun.recent[0], 'view.zoomFit', 'recent command remembered');

  // recents first, arrow navigation, Esc closes and restores focus
  await page.key('Mod+Shift+P');
  await frames(page, 1);
  const recentView = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-palette');
    const first = dlg.querySelector('[role="option"]');
    const group = dlg.querySelector('[role="group"]');
    const input = dlg.querySelector('input');
    return { first: first && first.dataset.id, group: group && group.textContent.startsWith('Recently used'), active: input.getAttribute('aria-activedescendant') };
  });
  assert.equal(recentView.first, 'view.zoomFit', 'recent commands listed first');
  assert.ok(recentView.group, 'recent group labelled');
  await page.key('ArrowDown');
  const moved = await page.eval(() => document.querySelector('dialog.apb-palette input').getAttribute('aria-activedescendant'));
  assert.notEqual(moved, recentView.active, 'ArrowDown moves the active option');
  await page.key('Escape');
  await frames(page, 1);
  const escaped = await page.eval(() => ({ open: !!document.querySelector('dialog.apb-palette'), focus: document.activeElement === document.querySelector('.apb-viewport') }));
  assert.equal(escaped.open, false, 'Esc closes the palette');
  assert.ok(escaped.focus, 'Esc restores focus');

  // prefixes + disabled entries
  const searches = await page.eval(() => {
    const p = APB.require('palette');
    const app = APB.app;
    const kinds = (q) => Array.from(new Set(p.search(app, q).map((e) => e.kind)));
    const ungroup = p.search(app, '>ungroup').find((e) => e.id === 'arrange.ungroup');
    return {
      insert: kinds('+text'), layers: kinds('@alpha'), cmds: kinds('>align'),
      layerTop: (p.search(app, '@Alpha')[0] || {}).nodeId,
      ungroupDisabled: !!(ungroup && ungroup.disabled),
      shortcutMatch: (p.search(app, '>' + app.commands.formatKeys('Mod+G'))[0] || {}).id
    };
  });
  assert.deepEqual(searches.insert, ['insert'], '+ prefix = insert entries');
  assert.deepEqual(searches.layers, ['layer'], '@ prefix = layers');
  assert.deepEqual(searches.cmds, ['command'], '> prefix = commands');
  assert.equal(searches.layerTop, a, 'layer search finds Alpha');
  assert.ok(searches.ungroupDisabled, 'inapplicable command marked disabled');
  assert.equal(searches.shortcutMatch, 'arrange.group', 'search by formatted shortcut');

  // disabled entry is not runnable; insert and go-to from the palette
  await page.eval(() => { APB.require('palette').open(APB.app, { query: '>ungroup' }); });
  await page.key('Enter');
  const stillOpen = await page.eval(() => !!document.querySelector('dialog.apb-palette'));
  assert.ok(stillOpen, 'Enter on a disabled command does nothing');
  await page.eval(() => { APB.require('palette').current.setQuery('+Text'); });
  const nodeCount = await page.eval(() => Object.keys(APB.app.store.doc.nodes).length);
  await page.key('Enter');
  await frames(page, 2);
  const inserted = await page.eval(() => {
    const s = APB.app.store;
    const n = s.node(s.selection[0]);
    return { count: Object.keys(s.doc.nodes).length, type: n && n.type };
  });
  assert.equal(inserted.count, nodeCount + 1, 'palette inserted one node');
  assert.equal(inserted.type, 'text', 'inserted node is selected');
  await page.eval(() => { APB.app.store.undo(); });
  await page.key('Mod+K');
  await page.type('@Beta');
  await page.key('Enter');
  const goTo = await page.eval(() => APB.app.store.selection.slice());
  assert.deepEqual(goTo, [b], 'Go to layer selects it');

  /* ------------------------------------------------- commands → document */
  const docFx = await page.eval(({ a, b, section }) => {
    const app = APB.app;
    const s = app.store;
    const c = app.commands;
    const out = {};
    s.select([a, b]);
    const gid = c.run('arrange.group');
    out.groupType = s.node(gid) && s.node(gid).type;
    out.groupKids = s.node(gid) && s.node(gid).children.slice();
    out.aParentIsGroup = s.node(a).parent === gid;
    s.select([gid]);
    c.run('arrange.ungroup');
    out.groupGone = !s.node(gid);
    out.aParent = s.node(a).parent === section;
    s.select([a, b]);
    c.run('arrange.align.left');
    const ea = APB.require('schema').effectiveNode(s.doc, a, s.view.bp);
    const eb = APB.require('schema').effectiveNode(s.doc, b, s.view.bp);
    out.alignedX = [ea.x, eb.x];
    const before = Object.keys(s.doc.nodes).length;
    const dups = c.run('edit.duplicate');
    out.dupCount = Object.keys(s.doc.nodes).length - before;
    out.dupSelected = s.selection.length === 2 && s.selection.every((id) => dups.includes(id));
    c.run('edit.delete');
    out.afterDelete = Object.keys(s.doc.nodes).length - before;
    c.run('edit.undo');
    out.afterUndo = Object.keys(s.doc.nodes).length - before;
    c.run('edit.redo');
    out.afterRedo = Object.keys(s.doc.nodes).length - before;
    s.select([a]);
    c.run('arrange.lock');
    out.locked = !!s.node(a).locked;
    out.lockChecked = c.get('arrange.lock').checked(app);
    out.alignWhenLocked = c.enabled('arrange.align.left');
    out.deleteWhenLocked = c.enabled('edit.delete');
    c.run('arrange.lock');
    out.unlocked = !s.node(a).locked;
    const kids = () => s.node(section).children;
    c.run('arrange.bringToFront');
    out.front = kids()[kids().length - 1] === a;
    out.forwardEnabledAtTop = c.enabled('arrange.bringForward');
    c.run('arrange.sendToBack');
    out.back = kids()[0] === a;
    c.run('arrange.bringForward');
    out.forward = kids()[1] === a;
    c.run('arrange.hide');
    out.hidden = !!APB.require('schema').effectiveNode(s.doc, a, s.view.bp).hidden;
    c.run('arrange.hide');
    out.shown = !APB.require('schema').effectiveNode(s.doc, a, s.view.bp).hidden;
    c.run('arrange.rotateRight');
    out.rot1 = APB.require('schema').effectiveNode(s.doc, a, s.view.bp).rotation;
    c.run('arrange.rotateLeft');
    c.run('arrange.rotateLeft');
    out.rot2 = APB.require('schema').effectiveNode(s.doc, a, s.view.bp).rotation;
    c.run('arrange.resetRotation');
    out.rot3 = APB.require('schema').effectiveNode(s.doc, a, s.view.bp).rotation || 0;
    s.select([a, b]);
    const wid = c.run('arrange.wrapStack');
    out.wrapLayout = s.node(wid) && s.node(wid).layout && s.node(wid).layout.mode;
    c.run('edit.undo');
    out.wrapUndone = !s.node(wid) && s.node(a).parent === section;
    s.select([a, b]);
    c.run('arrange.matchWidth');
    out.widths = [APB.require('schema').effectiveNode(s.doc, a, s.view.bp).w, APB.require('schema').effectiveNode(s.doc, b, s.view.bp).w];
    s.select([]);
    c.run('edit.selectAll');
    out.selectAll = s.selection.slice();
    s.select([]);
    return out;
  }, { a, b, section });
  assert.equal(docFx.groupType, 'group');
  assert.deepEqual(docFx.groupKids, [a, b], 'group contains both nodes');
  assert.ok(docFx.aParentIsGroup);
  assert.ok(docFx.groupGone && docFx.aParent, 'ungroup restores the parent');
  assert.equal(docFx.alignedX[0], docFx.alignedX[1], 'align left lines up x');
  assert.equal(docFx.dupCount, 2, 'duplicate adds two nodes');
  assert.ok(docFx.dupSelected, 'duplicates are selected');
  assert.equal(docFx.afterDelete, 0, 'delete removes the duplicates');
  assert.equal(docFx.afterUndo, 2, 'undo restores them');
  assert.equal(docFx.afterRedo, 0, 'redo deletes again');
  assert.ok(docFx.locked && docFx.lockChecked, 'lock toggles on (checked)');
  assert.equal(docFx.alignWhenLocked, false, 'align disabled for a locked node');
  assert.equal(docFx.deleteWhenLocked, true, 'delete allowed for a locked node');
  assert.ok(docFx.unlocked, 'lock toggles off');
  assert.ok(docFx.front && docFx.back && docFx.forward, 'z-order commands reorder children');
  assert.equal(docFx.forwardEnabledAtTop, false, 'bring forward disabled at the top');
  assert.ok(docFx.hidden && docFx.shown, 'hide toggles');
  assert.equal(docFx.rot1, 15);
  assert.equal(docFx.rot2, -15);
  assert.equal(docFx.rot3, 0);
  assert.equal(docFx.wrapLayout, 'stack', 'wrap in stack creates a stack frame');
  assert.ok(docFx.wrapUndone, 'wrap undone');
  assert.equal(docFx.widths[0], docFx.widths[1], 'match width');
  assert.ok(docFx.selectAll.includes(a) && docFx.selectAll.includes(b), 'select all selects the siblings');

  /* ------------------------------------------- shortcuts: canvas vs inputs */
  const count = () => page.eval(() => Object.keys(APB.app.store.doc.nodes).length);
  await page.eval((id) => { APB.app.store.select([id]); document.querySelector('.apb-viewport').focus(); }, a);
  const c0 = await count();
  await page.key('Mod+D');
  await frames(page, 1);
  const c1 = await count();
  assert.equal(c1, c0 + 1, 'Mod+D duplicates with the canvas focused');
  await page.key('Delete');
  await frames(page, 1);
  assert.equal(await count(), c0, 'Delete removes with the canvas focused');
  await page.eval((id) => {
    APB.app.store.select([id]);
    const input = document.createElement('input');
    input.className = 'e2e-temp-input';
    input.value = 'keep me';
    document.body.appendChild(input);
    input.focus();
  }, a);
  await page.key('Mod+D');
  await page.key('Delete');
  await page.key('Backspace');
  const inInput = await page.eval((id) => {
    const input = document.querySelector('.e2e-temp-input');
    const r = { exists: !!APB.app.store.node(id), count: Object.keys(APB.app.store.doc.nodes).length, value: input.value };
    input.remove();
    return r;
  }, a);
  assert.ok(inInput.exists, 'Delete/Backspace in a text input do not delete nodes');
  assert.equal(inInput.count, c0, 'Mod+D in a text input does not duplicate');

  // keyboard align + undo
  await page.eval(({ a, b }) => { APB.app.store.select([a, b]); document.querySelector('.apb-viewport').focus(); }, { a, b });
  await page.key('Alt+S');
  const bottoms = await page.eval(({ a, b }) => {
    const s = APB.app.store;
    const e = (id) => APB.require('schema').effectiveNode(s.doc, id, s.view.bp);
    return [e(a).y + e(a).h, e(b).y + e(b).h];
  }, { a, b });
  assert.equal(bottoms[0], bottoms[1], 'Alt+S aligns bottoms');
  await page.key('Mod+Z');
  const undone = await page.eval(() => APB.app.store.canRedo());
  assert.ok(undone, 'Mod+Z undoes');

  // F2 rename via prompt
  await page.eval((id) => { APB.app.store.select([id]); document.querySelector('.apb-viewport').focus(); }, a);
  await page.key('F2');
  await page.waitFor(() => !!document.querySelector('dialog.apb-dialog--prompt'));
  await page.key('Mod+A');
  await page.type('Renamed layer');
  await page.key('Enter');
  await page.waitFor(() => !document.querySelector('dialog.apb-dialog--prompt'));
  const renamed = await page.eval((id) => APB.app.store.node(id).name, a);
  assert.equal(renamed, 'Renamed layer', 'F2 renames through the prompt');

  /* ------------------------------------------------------------ radial */
  const radial = await page.eval((section) => {
    const app = APB.app;
    const ids = app.docops.insert(app.store, [0, 1, 2, 3].map((i) => ({ type: 'shape', name: 'R' + i, x: 600 + i * 70, y: 400, w: 40, h: 40 })), { parent: section, select: false });
    app.store.select(ids);
    window.__radialIds = ids;
    const pos = () => ids.map((id) => { const n = app.store.node(id); return [n.x, n.y]; });
    window.__radialPos = pos;
    const before = pos();
    const historyBefore = app.store.history().index;
    app.commands.run('arrange.radial');
    const dlg = document.querySelector('dialog.apb-radial-dialog');
    return { before, historyBefore, open: !!(dlg && dlg.open), preview: pos(), fields: dlg ? dlg.querySelectorAll('input, select').length : 0 };
  }, section);
  assert.ok(radial.open, 'radial dialog opens');
  assert.ok(radial.fields >= 5, 'radius, start, sweep, center and rotate fields');
  assert.notDeepEqual(radial.preview, radial.before, 'live preview moves the items');
  await page.screenshot('radial-dialog');
  await page.eval(() => Array.from(document.querySelectorAll('dialog.apb-radial-dialog button')).find((btn) => btn.textContent.trim() === 'Cancel').click());
  await frames(page, 1);
  const cancelled = await page.eval(() => ({ pos: window.__radialPos(), open: !!document.querySelector('dialog.apb-radial-dialog'), index: APB.app.store.history().index }));
  assert.equal(cancelled.open, false, 'Cancel closes');
  assert.deepEqual(cancelled.pos, radial.before, 'Cancel reverts the preview');
  assert.equal(cancelled.index, radial.historyBefore, 'Cancel leaves no history entry');

  await page.eval(() => { APB.app.commands.run('arrange.radial'); });
  await page.eval(() => {
    const input = document.querySelector('dialog.apb-radial-dialog input');
    input.focus();
    input.select();
  });
  await page.type('150');
  await page.key('Enter');
  await frames(page, 3);
  await page.eval(() => Array.from(document.querySelectorAll('dialog.apb-radial-dialog button')).find((btn) => btn.textContent.trim() === 'Apply').click());
  await frames(page, 1);
  const applied = await page.eval(() => {
    const app = APB.app;
    const ids = window.__radialIds;
    const boxes = ids.map((id) => app.docops.worldBox(app.store.doc, id));
    const cx = boxes.reduce((s, bx) => s + bx.cx, 0) / boxes.length;
    const cy = boxes.reduce((s, bx) => s + bx.cy, 0) / boxes.length;
    const info = app.store.history();
    return {
      open: !!document.querySelector('dialog.apb-radial-dialog'),
      radii: boxes.map((bx) => Math.round(Math.hypot(bx.cx - cx, bx.cy - cy))),
      label: info.entries[info.index - 1].label,
      entries: info.index
    };
  });
  assert.equal(applied.open, false, 'Apply closes');
  assert.equal(applied.label, 'Arrange in circle', 'one radial history entry');
  assert.equal(applied.entries, radial.historyBefore + 1, 'exactly one undo entry');
  applied.radii.forEach((r) => assert.ok(Math.abs(r - 150) <= 2, 'radius applied (' + r + ')'));

  /* ---------------------------------------------------- shortcuts dialog */
  await page.eval(() => { APB.app.store.select([]); document.querySelector('.apb-viewport').focus(); });
  await page.key('Shift+?');
  await page.waitFor(() => !!document.querySelector('dialog.apb-shortcuts-dialog'));
  const sc = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-shortcuts-dialog');
    const rows = dlg.querySelectorAll('tr[data-command]');
    const undo = dlg.querySelector('tr[data-command="edit.undo"] kbd');
    return {
      rows: rows.length,
      commands: APB.app.commands.list().length,
      undoKey: undo && (undo.querySelector('[aria-hidden]') || undo).textContent,
      expected: APB.app.commands.formatKeys('Mod+Z'),
      categories: Array.from(dlg.querySelectorAll('.apb-shortcuts-section h3')).map((h) => h.textContent),
      focus: document.activeElement && document.activeElement.getAttribute('aria-label')
    };
  });
  assert.equal(sc.rows, sc.commands, 'shortcuts dialog lists every registered command');
  assert.equal(sc.undoKey, sc.expected, 'formatted keys shown');
  assert.ok(sc.categories.includes('Edit') && sc.categories.includes('Arrange') && sc.categories.includes('View'), 'grouped by category');
  assert.equal(sc.focus, 'Filter shortcuts', 'filter focused');
  await page.type('group');
  await frames(page, 1);
  const filtered = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-shortcuts-dialog');
    const visible = Array.from(dlg.querySelectorAll('tr[data-command]')).filter((r) => !r.hidden).map((r) => r.dataset.command);
    return { visible, hiddenSections: Array.from(dlg.querySelectorAll('.apb-shortcuts-section')).filter((s) => s.hidden).length };
  });
  assert.ok(filtered.visible.includes('arrange.group') && !filtered.visible.includes('edit.undo'), 'filter narrows rows');
  assert.ok(filtered.hiddenSections > 0, 'empty categories hidden');
  await page.screenshot('shortcuts-dialog');
  await page.key('Escape'); // first Esc clears the filter
  const cleared = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-shortcuts-dialog');
    return { open: !!dlg, hidden: dlg ? dlg.querySelectorAll('tr[data-command][hidden]').length : -1 };
  });
  assert.ok(cleared.open && cleared.hidden === 0, 'Esc in the filter clears it first');
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('dialog.apb-shortcuts-dialog'));
  await page.key('Mod+/');
  await page.waitFor(() => !!document.querySelector('dialog.apb-shortcuts-dialog'));
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('dialog.apb-shortcuts-dialog'));

  /* ---------------------------------------------------------------- about */
  await page.eval(() => { APB.app.commands.run('help.about'); });
  const about = await page.eval(() => {
    const dlg = document.querySelector('dialog.apb-about-dialog');
    return { text: dlg ? dlg.textContent : '', version: APB.app.version };
  });
  assert.match(about.text, /Everything stays in your browser/);
  assert.ok(about.text.includes(about.version), 'version shown');
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('dialog.apb-about-dialog'));

  // palette shortcut is ignored while another dialog is open; accessible names inside dialogs
  await page.eval(() => { APB.app.commands.run('help.shortcuts'); });
  await page.key('Mod+K');
  const blocked = await page.eval(() => !document.querySelector('dialog.apb-palette'));
  assert.ok(blocked, 'palette does not open over a modal dialog');
  const unnamed = await page.eval(() => Array.from(document.querySelectorAll('dialog button, dialog input, dialog select'))
    .filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length) || el.getAttribute('aria-labelledby'))).length);
  assert.equal(unnamed, 0, 'dialog controls have accessible names');
  await page.key('Escape');
}

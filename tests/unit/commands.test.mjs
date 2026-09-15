export default function (APB, t) {
  const { test, assert } = t;
  const commands = APB.require('commands');
  const MAC = { mac: true };
  const WIN = { mac: false };

  /** Minimal KeyboardEvent-like object. */
  function ev(init) {
    const e = Object.assign({
      key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      repeat: false, isComposing: false, defaultPrevented: false, target: null
    }, init);
    e.prevented = 0;
    e.preventDefault = () => { e.prevented++; e.defaultPrevented = true; };
    return e;
  }

  function fakeEl(tagName, extra) {
    return Object.assign({
      nodeType: 1, tagName, isContentEditable: false,
      getAttribute(name) { return (this.attrs || {})[name] ?? null; },
      closest() { return null; }
    }, extra);
  }

  test('parseKey validates modifiers and keys', () => {
    const p = commands.parseKey('Mod+Shift+g');
    assert.deepEqual(Array.from(p.mods), ['mod', 'shift']);
    assert.equal(p.key, 'G');
    assert.equal(commands.parseKey('ctrl+alt+arrowup').key, 'ArrowUp');
    assert.equal(commands.parseKey('Esc').key, 'Escape');
    assert.equal(commands.parseKey('F2').key, 'F2');
    assert.equal(commands.parseKey('Mod++').key, '+');
    assert.equal(commands.parseKey('Mod+[').key, '[');
    assert.equal(commands.parseKey('Shift+?').key, '?');
    assert.throws(() => commands.parseKey('Hyper+K'), /unknown modifier/);
    assert.throws(() => commands.parseKey('Mod+'), /missing key/);
    assert.throws(() => commands.parseKey('Mod+Banana'), /unknown or missing key/);
    assert.throws(() => commands.register({ id: 'x.bad', run() {}, keys: ['Mod+Nope'] }), /unknown/);
  });

  test('Mod maps to Cmd on mac and Ctrl elsewhere', () => {
    const ctrlZ = ev({ key: 'z', code: 'KeyZ', ctrlKey: true });
    const cmdZ = ev({ key: 'z', code: 'KeyZ', metaKey: true });
    assert.equal(commands.matchKey(ctrlZ, 'Mod+Z', WIN), true);
    assert.equal(commands.matchKey(cmdZ, 'Mod+Z', WIN), false);
    assert.equal(commands.matchKey(cmdZ, 'Mod+Z', MAC), true);
    assert.equal(commands.matchKey(ctrlZ, 'Mod+Z', MAC), false);
    assert.equal(commands.matchKey(ctrlZ, 'Ctrl+Z', MAC), true, 'explicit Ctrl stays Ctrl on mac');
    assert.equal(commands.matchKey(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'Mod+Z', WIN), false, 'extra Shift does not match');
    assert.equal(commands.matchKey(ev({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'Mod+Shift+Z', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true }), 'Mod+Z', WIN), false, 'extra Alt does not match');
    assert.equal(commands.matchKey(ev({ key: 'z', code: 'KeyZ' }), 'Z', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'Z', WIN), false);
  });

  test('letters and digits match via event.code (layout and CapsLock independent)', () => {
    assert.equal(commands.matchKey(ev({ key: 'я', code: 'KeyZ', ctrlKey: true }), 'Mod+Z', WIN), true, 'Cyrillic layout');
    assert.equal(commands.matchKey(ev({ key: 'Z', code: 'KeyZ', ctrlKey: true }), 'Mod+Z', WIN), true, 'CapsLock');
    assert.equal(commands.matchKey(ev({ key: 'z', code: 'KeyY', ctrlKey: true }), 'Mod+Z', WIN), false, 'code decides, not key');
    assert.equal(commands.matchKey(ev({ key: 'z', code: '', ctrlKey: true }), 'Mod+Z', WIN), true, 'key fallback without code');
    assert.equal(commands.matchKey(ev({ key: '!', code: 'Digit1', shiftKey: true }), 'Shift+1', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '1', code: 'Numpad1', altKey: true }), 'Alt+1', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '&', code: 'Digit1', altKey: true }), 'Alt+1', WIN), true, 'AZERTY digit row');
    assert.equal(commands.matchKey(ev({ key: '2', code: 'Digit2', altKey: true }), 'Alt+1', WIN), false);
  });

  test('punctuation and named keys', () => {
    assert.equal(commands.matchKey(ev({ key: ']', code: 'BracketRight', metaKey: true }), 'Mod+]', MAC), true);
    assert.equal(commands.matchKey(ev({ key: '[', code: 'BracketLeft', metaKey: true, altKey: true }), 'Mod+Alt+[', MAC), true);
    assert.equal(commands.matchKey(ev({ key: '=', code: 'Equal', ctrlKey: true }), 'Mod+=', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '-', code: 'Minus', ctrlKey: true }), 'Mod+-', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '-', code: 'NumpadSubtract', ctrlKey: true }), 'Mod+-', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '/', code: 'Slash', ctrlKey: true }), 'Mod+/', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '?', code: 'Slash', shiftKey: true }), 'Shift+?', WIN), true);
    assert.equal(commands.matchKey(ev({ key: '?', code: 'Slash', shiftKey: true }), '?', WIN), true, 'Shift is implied for ?');
    assert.equal(commands.matchKey(ev({ key: '\\', code: 'Backslash', ctrlKey: true }), 'Mod+\\', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Delete', code: 'Delete' }), 'Delete', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Backspace', code: 'Backspace' }), 'Backspace', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Escape', code: 'Escape' }), 'Escape', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Enter', code: 'NumpadEnter', ctrlKey: true }), 'Mod+Enter', WIN), true);
    assert.equal(commands.matchKey(ev({ key: ' ', code: 'Space' }), 'Space', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Tab', code: 'Tab', shiftKey: true }), 'Shift+Tab', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'Tab', code: 'Tab', shiftKey: true }), 'Tab', WIN), false);
    assert.equal(commands.matchKey(ev({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }), 'Shift+ArrowUp', WIN), true);
    assert.equal(commands.matchKey(ev({ key: 'F2', code: 'F2' }), 'F2', WIN), true);
    assert.equal(commands.matchKey(null, 'F2', WIN), false);
    assert.equal(commands.matchKey(ev({ key: 'F2' }), 'Nope+F2', WIN), false, 'invalid combos never match');
  });

  test('formatKeys for mac and non-mac', () => {
    assert.equal(commands.formatKeys('Mod+Shift+G', MAC), '⌘⇧G');
    assert.equal(commands.formatKeys('Mod+Shift+G', WIN), 'Ctrl+Shift+G');
    assert.equal(commands.formatKeys('Alt+Shift+H', MAC), '⌥⇧H');
    assert.equal(commands.formatKeys('Alt+Shift+H', WIN), 'Alt+Shift+H');
    assert.equal(commands.formatKeys('Ctrl+Tab', MAC), '⌃⇥');
    assert.equal(commands.formatKeys('Delete', WIN), 'Del');
    assert.equal(commands.formatKeys('Shift+ArrowUp', WIN), 'Shift+↑');
    assert.equal(commands.formatKeys('Mod+\\', WIN), 'Ctrl+\\');
    assert.equal(commands.formatKeys(['Mod+Shift+Z', 'Mod+Y'], WIN), 'Ctrl+Shift+Z / Ctrl+Y');
    assert.equal(commands.formatKeys('', WIN), '');
    assert.equal(commands.formatKeys('Weird+Thing', WIN), 'Weird+Thing', 'unparseable input is returned as-is');
  });

  test('registry: register, run, when, keysFor, errors are reported not thrown', () => {
    const reg = commands.createRegistry();
    const app = { value: 1 };
    reg.setApp(app);
    const calls = [];
    const changes = [];
    reg.on('change', (c) => changes.push(c));
    const off = reg.register({ id: 'test.hello', title: 'Hello', keys: ['Mod+H'], run: (a, args) => { calls.push([a, args]); return 'ok'; } });
    const def = reg.get('test.hello');
    assert.equal(def.category, 'General');
    assert.equal(def.palette, true);
    assert.equal(def.allowInInputs, false);
    assert.equal(def.allowInDialog, false);
    assert.deepEqual(Array.from(reg.keysFor('test.hello')), ['Mod+H']);
    assert.deepEqual(Array.from(reg.keysFor('nope')), []);
    assert.equal(reg.run('test.hello', { x: 1 }), 'ok');
    assert.equal(calls[0][0], app);
    assert.deepEqual(calls[0][1], { x: 1 });

    let enabled = false;
    reg.register({ id: 'test.cond', when: (a) => a === app && enabled, run: () => 'ran' });
    assert.equal(reg.enabled('test.cond'), false);
    assert.equal(reg.run('test.cond'), undefined, 'no-op when `when` is false');
    enabled = true;
    assert.equal(reg.enabled('test.cond'), true);
    assert.equal(reg.run('test.cond'), 'ran');
    assert.equal(reg.enabled('missing'), false);
    assert.deepEqual(reg.list().map((d) => d.id), ['test.hello', 'test.cond']);

    const errors = [];
    reg.on('error', (e) => errors.push(e));
    const consoleError = t.mock.method(console, 'error', () => {});
    const consoleWarn = t.mock.method(console, 'warn', () => {});
    try {
      reg.register({ id: 'test.throws', run: () => { throw new Error('kaput'); } });
      assert.equal(reg.run('test.throws'), undefined);
      reg.register({ id: 'test.whenThrows', when: () => { throw new Error('bad when'); }, run: () => 'x' });
      assert.equal(reg.enabled('test.whenThrows'), false);
      assert.equal(reg.run('unknown.command'), undefined);
    } finally {
      consoleError.mock.restore();
      consoleWarn.mock.restore();
    }
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'test.throws');

    assert.equal(reg.setKeys('test.cond', ['Alt+C']), true);
    assert.deepEqual(Array.from(reg.keysFor('test.cond')), ['Alt+C']);
    off();
    assert.equal(reg.get('test.hello'), null);
    assert.ok(changes.some((c) => c.removed && c.id === 'test.hello'));
  });

  test('dispatcher: editable-target and open-dialog guards, when fallthrough, preventDefault', () => {
    const reg = commands.createRegistry();
    const ran = [];
    reg.register({ id: 'edit.undo', keys: ['Mod+Z'], run: () => ran.push('undo') });
    reg.register({ id: 'edit.delete', keys: ['Delete', 'Backspace'], run: () => ran.push('delete') });
    reg.register({ id: 'palette.open', keys: ['Mod+K'], allowInInputs: true, allowInDialog: true, run: () => ran.push('palette') });
    let canA = false;
    reg.register({ id: 'a', keys: ['Alt+A'], when: () => canA, run: () => ran.push('a') });
    reg.register({ id: 'b', keys: ['Alt+A'], run: () => ran.push('b') });
    reg.register({ id: 'norepeat', keys: ['R'], repeat: false, run: () => ran.push('r') });

    const body = fakeEl('DIV');
    const e1 = ev({ key: 'z', code: 'KeyZ', ctrlKey: true, target: body });
    assert.equal(reg.handleKeydown(e1, WIN), 'edit.undo');
    assert.equal(e1.prevented, 1);

    // Editable targets
    const input = fakeEl('INPUT', { type: 'text' });
    const e2 = ev({ key: 'z', code: 'KeyZ', ctrlKey: true, target: input });
    assert.equal(reg.handleKeydown(e2, WIN), null);
    assert.equal(e2.prevented, 0, 'native input undo keeps working');
    assert.equal(reg.handleKeydown(ev({ key: 'Backspace', code: 'Backspace', target: fakeEl('TEXTAREA') }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'Delete', code: 'Delete', target: fakeEl('DIV', { isContentEditable: true }) }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'k', code: 'KeyK', ctrlKey: true, target: input }), WIN), 'palette.open', 'allowInInputs');
    assert.equal(reg.handleKeydown(ev({ key: 'Delete', code: 'Delete', target: fakeEl('BUTTON') }), WIN), 'edit.delete', 'buttons are not editable');
    assert.equal(reg.handleKeydown(ev({ key: 'Delete', code: 'Delete', target: fakeEl('INPUT', { type: 'button' }) }), WIN), 'edit.delete');
    const textNode = { nodeType: 3, parentElement: input };
    assert.equal(reg.handleKeydown(ev({ key: 'Delete', code: 'Delete', target: textNode }), WIN), null, 'text node inside an input');
    const composed = ev({ key: 'Delete', code: 'Delete', target: body });
    composed.composedPath = () => [input, body];
    assert.equal(reg.handleKeydown(composed, WIN), null, 'composedPath()[0] is the real (shadow) target');

    // Dialog guard
    let dialogOpen = true;
    reg.setDialogCheck(() => dialogOpen);
    assert.equal(reg.handleKeydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, target: body }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'k', code: 'KeyK', ctrlKey: true, target: body }), WIN), 'palette.open', 'allowInDialog');
    dialogOpen = false;
    assert.equal(reg.handleKeydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, target: body }), WIN), 'edit.undo');
    reg.setDialogCheck(() => { throw new Error('broken check'); });
    assert.equal(reg.handleKeydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, target: body }), WIN), 'edit.undo', 'broken check = no dialog');
    reg.setDialogCheck(null);

    // `when` false falls through to the next command with the same key.
    assert.equal(reg.handleKeydown(ev({ key: 'a', code: 'KeyA', altKey: true, target: body }), WIN), 'b');
    canA = true;
    assert.equal(reg.handleKeydown(ev({ key: 'a', code: 'KeyA', altKey: true, target: body }), WIN), 'a');

    // Ignored events
    assert.equal(reg.handleKeydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, defaultPrevented: true, target: body }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, isComposing: true, target: body }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true, target: body }), WIN), null);
    assert.equal(reg.handleKeydown(ev({ key: 'q', code: 'KeyQ', target: body }), WIN), null, 'unbound key');
    assert.equal(reg.handleKeydown(ev({ key: 'r', code: 'KeyR', repeat: true, target: body }), WIN), null, 'repeat: false');
    assert.equal(reg.handleKeydown(ev({ key: 'r', code: 'KeyR', target: body }), WIN), 'norepeat');

    assert.deepEqual(ran, ['undo', 'palette', 'delete', 'delete', 'palette', 'undo', 'undo', 'b', 'a', 'r']);
  });

  test('isEditableTarget classification', () => {
    const is = commands.isEditableTarget;
    assert.equal(is(null), false);
    assert.equal(is(fakeEl('INPUT', { type: 'email' })), true);
    assert.equal(is(fakeEl('INPUT', { type: 'range' })), true, 'sliders keep arrow keys');
    assert.equal(is(fakeEl('INPUT', { type: 'checkbox' })), true, 'checkboxes keep Space');
    assert.equal(is(fakeEl('INPUT', { type: 'submit' })), false);
    assert.equal(is(fakeEl('SELECT')), true);
    assert.equal(is(fakeEl('DIV', { attrs: { role: 'textbox' } })), true);
    assert.equal(is(fakeEl('DIV', { attrs: { role: 'button' } })), false);
    assert.equal(is(fakeEl('SPAN', { closest: (sel) => (sel === '[data-apb-keys="local"]' ? {} : null) })), true, 'opt-out region');
  });

  test('attach installs a keydown listener that can be detached', () => {
    const reg = commands.createRegistry();
    let count = 0;
    reg.register({ id: 'x', keys: ['Escape'], run: () => { count++; } });
    const listeners = new Map();
    const target = {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); }
    };
    const detach = reg.attach(target);
    assert.equal(reg.attach(target), detach, 'attaching twice is idempotent');
    listeners.get('keydown')(ev({ key: 'Escape', code: 'Escape', target: fakeEl('DIV') }));
    assert.equal(count, 1);
    detach();
    assert.equal(listeners.has('keydown'), false);
    assert.equal(typeof reg.attach(null), 'function', 'no target in Node → no-op detach');
  });
}

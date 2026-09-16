export default function (APB, t) {
  const { test, assert } = t;
  const actions = APB.require('actions');
  const schema = APB.require('schema');

  test('TYPES lists every action type with fields and an icon', () => {
    assert.ok(actions.TYPES.length >= 6);
    for (const def of actions.TYPES) {
      assert.equal(typeof def.id, 'string');
      assert.equal(typeof def.label, 'string');
      assert.ok(Array.isArray(def.fields));
    }
    assert.ok(actions.has('link'));
    assert.ok(actions.has('code'));
    assert.ok(!actions.has('nope'));
  });

  test('triggerFor: buttons click, checklists change', () => {
    assert.equal(actions.triggerFor('button'), 'click');
    assert.equal(actions.triggerFor('checklist'), 'change');
    assert.equal(actions.triggerFor('unknown-type'), 'click');
  });

  test('create() seeds an action with sane empty defaults for every field', () => {
    const a = actions.create('link', 'button');
    assert.match(a.id, /^act_/);
    assert.equal(a.trigger, 'click');
    assert.equal(a.type, 'link');
    assert.equal(a.url, '');
    assert.equal(a.newTab, false);

    const c = actions.create('code', 'checklist');
    assert.equal(c.trigger, 'change');
    assert.equal(c.code, '');

    const unknown = actions.create('does-not-exist', 'button');
    assert.equal(unknown.type, actions.TYPES[0].id, 'falls back to the first type');
  });

  test('normalize: drops malformed entries, unknown types and caps the list', () => {
    assert.deepEqual(actions.normalize(null), []);
    assert.deepEqual(actions.normalize('nope'), []);
    const clean = actions.normalize([
      null,
      'nope',
      { type: 'unknown-type' },
      { id: 'act_1', trigger: 'weird', type: 'link', url: 'https://example.com' }
    ]);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].id, 'act_1');
    assert.equal(clean[0].trigger, 'click', 'invalid trigger falls back to click');
    assert.equal(clean[0].url, 'https://example.com/');

    const many = Array.from({ length: actions.MAX_ACTIONS + 10 }, () => ({ type: 'submit' }));
    assert.equal(actions.normalize(many).length, actions.MAX_ACTIONS);
  });

  test('normalize: sanitizes dangerous URLs and class names, caps code length', () => {
    const [link] = actions.normalize([{ type: 'link', url: 'javascript:alert(1)' }]);
    assert.equal(link.url, '', 'javascript: URLs are stripped');

    const [toggleClass] = actions.normalize([{ type: 'toggleClass', className: '<script>evil' }]);
    assert.ok(!toggleClass.className.includes('<'));

    const huge = 'x'.repeat(actions.MAX_CODE + 500);
    const [code] = actions.normalize([{ type: 'code', code: huge }]);
    assert.equal(code.code.length, actions.MAX_CODE);
  });

  test('normalize: a target must exist in the given doc, else it is cleared', () => {
    const doc = schema.createDocument();
    const root = doc.pages[0].root;
    const [withDoc] = actions.normalize([{ type: 'scrollTo', target: 'does-not-exist' }], { doc });
    assert.equal(withDoc.target, '');
    const [validTarget] = actions.normalize([{ type: 'scrollTo', target: root }], { doc });
    assert.equal(validTarget.target, root);
    const [noDoc] = actions.normalize([{ type: 'scrollTo', target: 'anything' }]);
    assert.equal(noDoc.target, 'anything', 'without a doc, target ids pass through unchecked');
  });

  test('describe() summarizes an action for the inspector row', () => {
    assert.match(actions.describe({ type: 'link', url: 'https://x.test' }), /https:\/\/x\.test/);
    assert.match(actions.describe({ type: 'scrollTo', target: '' }), /no target set/);
    assert.equal(actions.describe({ type: 'submit' }), 'Submit the form');
    assert.equal(actions.describe({ type: 'nope' }), 'Unknown action');
  });

  test('runtimeSource() is a self-invoking function that delegates by trigger and action type', () => {
    const src = actions.runtimeSource();
    assert.equal(typeof src, 'string');
    assert.match(src, /apbRunAction/);
    assert.match(src, /data-apb-actions/);
    assert.match(src, /new Function/);
    // Must be syntactically valid JS on its own.
    assert.doesNotThrow(() => new Function(src));
  });
}

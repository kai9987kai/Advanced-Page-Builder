export default function (APB, t) {
  const { test, assert } = t;
  const templates = APB.require('templates');
  const schema = APB.require('schema');
  const storeModule = APB.require('store');
  const docops = APB.require('docops');

  test('list() exposes id/label/description/icon for every template, build() for unknown ids is null', () => {
    const list = templates.list();
    assert.ok(list.length >= 3);
    for (const t of list) {
      assert.equal(typeof t.id, 'string');
      assert.equal(typeof t.label, 'string');
      assert.equal(typeof t.description, 'string');
    }
    assert.deepEqual(list.map((t) => t.id).sort(), ['contact', 'hero', 'pricing']);
    assert.equal(templates.build('nope'), null);
  });

  test('build() returns a fresh, independent spec tree each time (no shared mutable state)', () => {
    const a = templates.build('hero');
    const b = templates.build('hero');
    assert.notEqual(a, b);
    a.name = 'mutated';
    assert.equal(b.name, 'Hero');
  });

  test('every template spec is a valid docops.insert() spec — section root, real element types throughout', () => {
    const store = storeModule.create(schema.createDocument());
    for (const { id } of templates.list()) {
      const spec = templates.build(id);
      assert.equal(spec.type, 'section', id + ' root is a section (so docops.insert needs no parent)');
      const ids = docops.insert(store, [spec], { select: false });
      assert.ok(ids.length === 1, id + ' inserted as one top-level node');
      const v = schema.validateDocument(store.doc);
      assert.ok(v.ok, id + ': ' + v.errors.join('; '));
    }
  });

  test('the pricing template has three plan cards, each with a button', () => {
    const spec = templates.build('pricing');
    assert.equal(spec.children.length, 3);
    for (const card of spec.children) {
      assert.equal(card.type, 'frame');
      assert.ok(card.children.some((c) => c.type === 'button'));
    }
  });
}

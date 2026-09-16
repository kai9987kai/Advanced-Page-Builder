export default function (APB, t) {
  const { test, assert } = t;
  APB.require('element-types-extra'); // registration is a side effect of requiring the module
  const elements = APB.require('elements');
  const schema = APB.require('schema');

  test('checklist: registered with sane defaults and inspector field', () => {
    const def = elements.get('checklist');
    assert.ok(def, 'checklist type is registered');
    assert.equal(def.category, 'text');
    assert.equal(def.container, false);
    assert.deepEqual(def.bpProps, ['items']);
    const node = schema.createNode('checklist');
    assert.equal(node.props.items.length, 3);
    assert.ok(node.props.items.every((it) => typeof it.id === 'string' && typeof it.text === 'string' && typeof it.checked === 'boolean'));
    const field = def.inspector[0].fields.find((f) => f.key === 'props.items');
    assert.ok(field && field.checkable === true, 'the Items field opts into the checkable list editor');
  });

  test('checklist vnode: one <li><input type=checkbox data-item-id> per item, checked reflects state', () => {
    const def = elements.get('checklist');
    const node = schema.createNode('checklist', {
      props: { items: [{ id: 'a', text: 'One', checked: false }, { id: 'b', text: 'Two', checked: true }] }
    });
    const v = def.vnode(node, { mode: 'export' });
    assert.equal(v.tag, 'ul');
    assert.equal(v.children.length, 2);
    const [li1, li2] = v.children;
    const input1 = li1.children[0];
    const input2 = li2.children[0];
    assert.equal(input1.attrs['data-item-id'], 'a');
    assert.equal(input1.attrs.checked, undefined, 'unchecked item has no checked attr');
    assert.equal(input2.attrs['data-item-id'], 'b');
    assert.equal(input2.attrs.checked, true);
    assert.equal(li2.children[1].text, 'Two');
  });

  test('checklist vnode: editor mode marks checkboxes non-tabbable, export mode does not', () => {
    const def = elements.get('checklist');
    const node = schema.createNode('checklist', { props: { items: [{ id: 'a', text: 'One', checked: false }] } });
    const editorInput = def.vnode(node, { mode: 'editor' }).children[0].children[0];
    const exportInput = def.vnode(node, { mode: 'export' }).children[0].children[0];
    assert.equal(editorInput.attrs.tabindex, '-1');
    assert.equal(exportInput.attrs.tabindex, undefined);
  });

  test('checklist vnode: tolerates plain-string / malformed items like the core `list` type', () => {
    const def = elements.get('checklist');
    const node = schema.createNode('checklist', { props: { items: ['just a string', null, { text: 'ok' }] } });
    const v = def.vnode(node, { mode: 'export' });
    assert.equal(v.children.length, 3);
    assert.equal(v.children[0].children[1].text, 'just a string');
    assert.equal(v.children[1].children[1].text, '');
    assert.equal(v.children[2].children[1].text, 'ok');
  });
}

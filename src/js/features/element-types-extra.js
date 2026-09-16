/* @node-testable */
/*
 * element-types-extra — additional element types beyond the core 14 (ARCHITECTURE.md §5.4).
 * Registers into `elements` exactly like `core/element-types.js`; kept as a separate feature so the
 * core set stays closed. Currently: `checklist` (a list of checkable items — see `props.items[].checked`
 * and the "Actions" inspector section in `features/actions.js`, which fires on the `change` trigger).
 */
APB.define('element-types-extra', ['elements', 'util'], function (elements, util) {
  'use strict';

  if (typeof APB !== 'undefined' && APB.has('icons')) {
    APB.require('icons').add('checklist',
      'R2 4 5 5 1|M3.2 6.3l0.8 0.9 1.6-1.9|M10 6.5h11|R2 10.5 5 5 1|M10 13h11|R2 17 5 5 1|M3.2 19.3l0.8 0.9 1.6-1.9|M10 19.5h11');
  }

  const str = (v) => (v === null || v === undefined ? '' : String(v));

  function normalizeItems(items) {
    return (Array.isArray(items) ? items : []).map((it, i) => {
      if (util.isPlainObject(it)) {
        return { id: typeof it.id === 'string' && it.id ? it.id : util.uid('ci'), text: str(it.text), checked: !!it.checked };
      }
      return { id: util.uid('ci'), text: str(it), checked: false };
    });
  }

  elements.register({
    type: 'checklist', label: 'Checklist', icon: 'checklist', category: 'text',
    caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
    bpProps: ['items'],
    defaults: () => ({
      name: 'Checklist', w: 280, h: 140,
      style: { fontSize: 16, lineHeight: 1.5, color: '#111827', padding: [4, 4, 4, 4] },
      props: {
        items: [
          { id: util.uid('ci'), text: 'First task', checked: false },
          { id: util.uid('ci'), text: 'Second task', checked: false },
          { id: util.uid('ci'), text: 'Third task', checked: true }
        ]
      }
    }),
    vnode: (node, ctx) => {
      const items = normalizeItems((node.props || {}).items);
      return {
        tag: 'ul', attrs: { class: 'apb-checklist' }, style: { margin: '0', padding: '0', listStyle: 'none' },
        children: items.map((it) => {
          const inputAttrs = { type: 'checkbox', class: 'apb-checklist-input', 'data-item-id': it.id };
          if (it.checked) inputAttrs.checked = true;
          if (ctx && ctx.mode === 'editor') inputAttrs.tabindex = '-1';
          return {
            tag: 'li', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' },
            children: [
              { tag: 'input', attrs: inputAttrs },
              { tag: 'span', attrs: { class: 'apb-checklist-text' }, text: it.text }
            ]
          };
        })
      };
    },
    inspector: [{
      title: 'Checklist', fields: [
        { key: 'props.items', label: 'Items', type: 'list', checkable: true }
      ]
    }]
  });

  return { registered: true };
});

// Registration is a side effect of the factory running, so require it eagerly at script-load time
// (nothing else needs `element-types-extra`'s return value) rather than waiting for a lazy caller
// that may never come, the way `element-types` piggybacks on `elements`'s own first-use hook.
// Skipped when there's no DOM (the unit-test vm context): tests that need it require it themselves.
if (typeof document !== 'undefined') APB.require('element-types-extra');

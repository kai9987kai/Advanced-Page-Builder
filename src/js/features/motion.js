/*
 * motion (UI) — the inspector "Animation" section for `node.motion` (presets/runtime owned by
 * `core/motion.js`). Applies to any selection (including multiple nodes at once — editing writes
 * the same motion to every selected node, there is no per-node "Mixed" editor here, only a
 * single/shared preview of the first node's settings); a live "Preview" button replays the preset
 * on the selected node(s)' actual canvas elements via the Web Animations API, no export needed to
 * see it. Not `@node-testable` — DOM-only, mirrors `features/actions.js`'s section structure.
 */
(function () {
  'use strict';

  const TRIGGER_OPTIONS = [{ value: 'enter', label: 'On scroll into view' }, { value: 'load', label: 'On page load' }];

  APB.plugin({
    id: 'motionUI',
    order: 43,
    requires: ['motion', 'widgets', 'icons'],

    init(app) {
      const motionMod = APB.require('motion');
      const widgets = APB.require('widgets');
      const { h } = widgets;
      const store = app.store;
      const docops = app.docops;

      if (!app.ui || typeof app.ui.registerInspectorSection !== 'function') return;

      function labeled(label, ctl) {
        return h('div', { class: 'apb-actions-field' }, h('label', { class: 'apb-actions-field-label' }, label), ctl);
      }

      function mount(container) {
        let nodes = [];
        let renderedSig = null;
        const bursts = new Map();
        const el = h('div', { class: 'apb-motion-section' });
        container.appendChild(el);

        function burstKey(field) {
          const ids = nodes.map((n) => n.id).join(',');
          return 'motion:' + field + ':' + ids + '#' + (bursts.get(field) || 0);
        }

        function write(motion, field, commit) {
          const ids = nodes.map((n) => n.id);
          if (!ids.length) return;
          // Optimistic local update: `nodes` holds a snapshot from the last update() call, and
          // docops.update() copy-on-writes a *new* node object into the store, so without this
          // `nodes[i].motion` stays stale until some unrelated store event happens to call
          // update() again — the very bug features/actions.js's mount() note warns about, just on
          // the write side instead of the initial-seed side.
          nodes = nodes.map((n) => Object.assign({}, n, { motion }));
          renderedSig = JSON.stringify(nodes.map((n) => n.motion || null));
          docops.update(app, ids, { motion }, { bp: null, label: 'Set animation', coalesce: burstKey(field || 'preset') });
          if (commit !== false) bursts.set(field || 'preset', (bursts.get(field || 'preset') || 0) + 1);
        }

        function previewAnimation(clean) {
          const frames = motionMod.framesFor(clean.preset);
          if (!frames) return;
          nodes.forEach((n) => {
            const target = document.querySelector('.apb-viewport [data-node-id="' + n.id + '"]');
            if (target && typeof target.animate === 'function') target.animate(frames, { duration: clean.duration, delay: clean.delay, easing: clean.easing, fill: 'both' });
          });
        }

        function render() {
          el.replaceChildren();
          if (!nodes.length) return;
          const first = nodes[0];
          const clean = motionMod.normalize(first.motion);
          const presetOptions = [{ value: '', label: 'None' }].concat(motionMod.list().map((p) => ({ value: p.id, label: p.label })));

          const presetSel = widgets.select({
            ariaLabel: 'Animation preset', options: presetOptions, value: clean ? clean.preset : '',
            onInput: (v) => {
              if (!v) { write(null, 'preset', true); render(); return; }
              const next = motionMod.normalize(Object.assign({}, clean, { preset: v })) || motionMod.normalize({ preset: v });
              write(next, 'preset', true);
              render();
            }
          });
          el.appendChild(labeled('Animation', presetSel));
          if (!clean) return;

          const triggerSel = widgets.select({
            ariaLabel: 'Trigger', options: TRIGGER_OPTIONS, value: clean.trigger,
            onInput: (v) => write(Object.assign({}, clean, { trigger: v }), 'trigger', true)
          });
          const durationField = widgets.numberField({
            ariaLabel: 'Duration (ms)', value: clean.duration, min: 50, max: 10000, step: 50,
            onInput: (v, ctx) => write(Object.assign({}, clean, { duration: v }), 'duration', !ctx || ctx.commit !== false)
          });
          const delayField = widgets.numberField({
            ariaLabel: 'Delay (ms)', value: clean.delay, min: 0, max: 10000, step: 50,
            onInput: (v, ctx) => write(Object.assign({}, clean, { delay: v }), 'delay', !ctx || ctx.commit !== false)
          });
          const easingSel = widgets.select({
            ariaLabel: 'Easing', options: motionMod.EASINGS.map((eName) => ({ value: eName, label: eName })), value: clean.easing,
            onInput: (v) => write(Object.assign({}, clean, { easing: v }), 'easing', true)
          });
          const previewBtn = widgets.button({ label: 'Preview', icon: 'play', size: 'sm', variant: 'subtle', onClick: () => previewAnimation(clean) });

          el.append(labeled('Trigger', triggerSel), labeled('Duration (ms)', durationField), labeled('Delay (ms)', delayField), labeled('Easing', easingSel), previewBtn);
        }

        function update(nextNodes) {
          nodes = nextNodes || [];
          const sig = JSON.stringify(nodes.map((n) => n.motion || null));
          if (sig === renderedSig) return;
          renderedSig = sig;
          render();
        }

        // buildExternal mounts but does not immediately call update() (see features/actions.js's
        // note on this) — seed from the current selection right away.
        update(store.selection.map((id) => store.doc.nodes[id]).filter(Boolean));

        return { el, update, destroy() {} };
      }

      app.ui.registerInspectorSection({
        id: 'motion', title: 'Animation', order: 56,
        applies: (nodes) => nodes.length > 0 && nodes.every((n) => n.type !== 'page'),
        mount
      });
    }
  });
})();

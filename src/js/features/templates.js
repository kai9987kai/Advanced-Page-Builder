/* @node-testable */
/*
 * templates — a small starter-section gallery (ARCHITECTURE.md §8 Insert panel; PLAN C2).
 * `list()`/`build(id)` are pure (node specs only, no store access) so they're unit-testable; the
 * plugin at the bottom wires the gallery dialog, an `insert.template` command and an Insert-menu
 * entry. Every template's root is a `section`, so `docops.insert` with no explicit parent already
 * does the right thing — sections default to the current page root (ARCHITECTURE.md "Contract
 * additions" — A2 `docops`), landing the template at the end of the page exactly like the Section
 * draw tool would.
 */
APB.define('templates', ['util'], function (util) {
  'use strict';

  if (typeof APB !== 'undefined' && APB.has('icons')) {
    APB.require('icons').add('templates', 'R3 3 8 8 1.5|R13 3 8 8 1.5|R3 13 8 8 1.5|R13 13 8 8 1.5');
  }

  const text = (str, style, sizing) => ({ type: 'text', props: { text: str }, style: style || {}, sizing: sizing || { w: 'fill', h: 'hug' } });

  const TEMPLATES = [
    {
      id: 'hero', label: 'Hero', icon: 'section',
      description: 'Centered headline, subtext and a call-to-action button.',
      build: () => ({
        type: 'section', name: 'Hero',
        sizing: { w: 'fill', h: 'hug' },
        layout: { mode: 'stack', dir: 'column', gap: 20, align: 'center', justify: 'center', pad: [96, 48, 96, 48] },
        style: { fill: '#eef2ff' },
        children: [
          text('Build better pages, faster', { fontSize: 44, fontWeight: 800, textAlign: 'center', color: '#0f172a', lineHeight: 1.15 }),
          text('Drag, arrange, style and export a real, dependency-free page — all in the browser.',
            { fontSize: 18, textAlign: 'center', color: '#475569', lineHeight: 1.5 }),
          {
            type: 'button', name: 'CTA', props: { text: 'Get started' },
            style: { fill: '#2563eb', color: '#ffffff', radius: 10, fontWeight: 600 },
            sizing: { w: 'fixed', h: 'fixed' }, w: 176, h: 52
          }
        ]
      })
    },
    {
      id: 'pricing', label: 'Pricing', icon: 'table',
      description: 'Three plan cards side by side, ready to relabel.',
      build: () => {
        const plans = [
          { name: 'Starter', price: '$19', blurb: 'For solo projects and experiments.', accent: '#ffffff', border: '#e2e8f0' },
          { name: 'Pro', price: '$49', blurb: 'For growing teams that ship often.', accent: '#eff6ff', border: '#93c5fd' },
          { name: 'Scale', price: '$99', blurb: 'For advanced, multi-site workflows.', accent: '#ffffff', border: '#e2e8f0' }
        ];
        return {
          type: 'section', name: 'Pricing',
          sizing: { w: 'fill', h: 'hug' },
          layout: { mode: 'stack', dir: 'row', gap: 24, align: 'stretch', justify: 'center', wrap: true, pad: [64, 48, 64, 48] },
          style: { fill: '#ffffff' },
          children: plans.map((p) => ({
            type: 'frame', name: p.name + ' plan',
            sizing: { w: 'fixed', h: 'hug' }, w: 260,
            layout: { mode: 'stack', dir: 'column', gap: 12, align: 'stretch', pad: [28, 24, 28, 24] },
            style: { fill: p.accent, borderColor: p.border, borderWidth: 1, radius: 16, shadow: '0 12px 28px rgba(15,23,42,.08)' },
            children: [
              text(p.name, { fontSize: 15, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }),
              text(p.price + ' /mo', { fontSize: 34, fontWeight: 800, color: '#0f172a' }),
              text(p.blurb, { fontSize: 14, color: '#475569', lineHeight: 1.5 }),
              {
                type: 'button', props: { text: 'Choose ' + p.name },
                style: { fill: '#2563eb', color: '#ffffff', radius: 10, fontWeight: 600 },
                sizing: { w: 'fill', h: 'fixed' }, h: 44
              }
            ]
          }))
        };
      }
    },
    {
      id: 'contact', label: 'Contact form', icon: 'html',
      description: 'A heading plus a real HTML form (name, email, message).',
      build: () => ({
        type: 'section', name: 'Contact',
        sizing: { w: 'fill', h: 'hug' },
        layout: { mode: 'stack', dir: 'column', gap: 20, align: 'center', pad: [72, 48, 72, 48] },
        style: { fill: '#f8fafc' },
        children: [
          text('Get in touch', { fontSize: 32, fontWeight: 800, textAlign: 'center', color: '#0f172a' }),
          text('We usually reply within a business day.', { fontSize: 16, textAlign: 'center', color: '#475569' }),
          {
            type: 'html', name: 'Form',
            sizing: { w: 'fixed', h: 'hug' }, w: 420,
            props: {
              html: '<form style="display:grid;gap:12px;">' +
                '<label style="display:grid;gap:4px;font:600 13px system-ui;color:#334155;">Name' +
                '<input type="text" name="name" placeholder="Your name" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:14px system-ui;"></label>' +
                '<label style="display:grid;gap:4px;font:600 13px system-ui;color:#334155;">Email' +
                '<input type="email" name="email" placeholder="you@example.com" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:14px system-ui;"></label>' +
                '<label style="display:grid;gap:4px;font:600 13px system-ui;color:#334155;">Message' +
                '<textarea name="message" rows="4" placeholder="How can we help?" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:14px system-ui;resize:vertical;"></textarea></label>' +
                '<button type="submit" style="padding:10px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;font:600 14px system-ui;cursor:pointer;">Send message</button>' +
                '</form>'
            }
          }
        ]
      })
    }
  ];

  function list() {
    return TEMPLATES.map((t) => ({ id: t.id, label: t.label, icon: t.icon, description: t.description }));
  }

  function build(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    return t ? util.deepClone(t.build()) : null;
  }

  const api = { list, build };

  if (typeof APB !== 'undefined' && APB.plugin) {
    APB.plugin({
      id: 'templates',
      order: 45,
      requires: ['widgets', 'icons'],
      init(app) {
        const widgets = APB.require('widgets');
        const icons = APB.require('icons');
        const { h } = widgets;

        function insertTemplate(id) {
          const spec = build(id);
          if (!spec) return;
          const docops = app.docops;
          const ids = docops.insert(app, [spec], { label: 'Insert ' + (TEMPLATES.find((t) => t.id === id) || {}).label, select: true });
          if (ids && ids.length && app.canvas && app.canvas.viewport && typeof app.canvas.viewport.zoomToSelection === 'function') {
            app.canvas.viewport.zoomToSelection();
          }
          if (app.ui && app.ui.announce) app.ui.announce('Template inserted');
        }

        function openGallery() {
          if (!app.ui || typeof app.ui.dialog !== 'function') return;
          const dlg = app.ui.dialog({
            title: 'Insert a template', wide: true,
            content: h('div', { class: 'apb-templates-grid' }, list().map((t) => {
              const card = h('button', { type: 'button', class: 'apb-template-card' },
                h('div', { class: 'apb-template-card-thumb' }, icons.get(t.icon, { size: 28 })),
                h('div', { class: 'apb-template-card-title' }, t.label),
                h('div', { class: 'apb-template-card-desc' }, t.description));
              card.addEventListener('click', () => { insertTemplate(t.id); dlg.close(); });
              return card;
            })),
            actions: [{ label: 'Close', kind: 'cancel' }]
          });
        }

        if (app.commands && !app.commands.get('insert.template')) {
          app.commands.register({
            id: 'insert.template', title: 'Insert template…', category: 'Insert', icon: 'templates',
            when: (a) => !!(a.store.doc.pages && a.store.doc.pages.length),
            run: () => openGallery()
          });
        }
        if (typeof app.ui.registerMenuItem === 'function') {
          app.ui.registerMenuItem({ menu: 'insert', command: 'insert.template', order: 10 });
        }
      }
    });
  }

  return api;
});

// The APB.plugin(...) call above only runs once this module is required — force that now (script
// load time, well before app.js's plugin loop) instead of waiting for a lazy caller. Skipped
// without a DOM (the unit-test vm context): pure-function tests require the module themselves and
// never need the plugin side effect.
if (typeof document !== 'undefined') APB.require('templates');

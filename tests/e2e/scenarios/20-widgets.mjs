// Widgets & icons: mounts a gallery of every ui/widgets control outside the app, drives them with the
// keyboard and pointer, checks onInput values + ARIA, verifies token contrast, and screenshots light/dark.
export const name = 'UI kit: icons, widgets, tokens (light/dark)';
export const viewport = { width: 1280, height: 900 };
export const timeout = 60000;

const CANONICAL_ICONS = ('select hand frame section text rect ellipse line image video embed icon button link list table html divider spacer ' +
  'form input checkbox select-box details component instance group page layers insert pages assets design interact audit ai history tokens ' +
  'undo redo zoom-in zoom-out fit preview export upload save open menu more close plus minus trash copy cut paste duplicate lock unlock eye ' +
  'eye-off chevron-down chevron-right chevron-left chevron-up search settings sun moon monitor desktop tablet mobile align-left align-hcenter ' +
  'align-right align-top align-vcenter align-bottom distribute-h distribute-v tidy radial rotate bring-front send-back bring-forward ' +
  'send-backward grid ruler magnet external info warning error success keyboard help command grip text-align-left text-align-center ' +
  'text-align-right text-align-justify bold italic underline strikethrough stack-row stack-column wrap padding gap sizing-fixed sizing-fill ' +
  'sizing-hug border radius shadow opacity blend code image-off star heart check arrow-right arrow-left arrow-up arrow-down mail phone ' +
  'map-pin calendar user users cart globe play pause refresh filter sparkles wand palette droplet type layout-grid').split(' ');

export async function run(page, { assert, sleep }) {
  await page.ready();

  /* ---------------------------------------------------------------- icons */
  const iconInfo = await page.eval((names) => {
    const icons = APB.require('icons');
    const missing = names.filter((n) => !icons.has(n));
    const svg = icons.get('undo', { size: 20 });
    const titled = icons.get('star', { title: 'Favourite' });
    const str = icons.svg('trash', { size: 12 });
    const originalWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    const fb1 = icons.get('definitely-not-an-icon');
    icons.get('definitely-not-an-icon');
    console.warn = originalWarn;
    return {
      missing, count: icons.list().length, tag: svg.tagName, hidden: svg.getAttribute('aria-hidden'), width: svg.getAttribute('width'),
      titledRole: titled.getAttribute('role'), titledText: titled.querySelector('title') && titled.querySelector('title').textContent,
      strOk: /^<svg [^>]*width="12"[^>]*aria-hidden="true"[^>]*>.*<\/svg>$/.test(str), fallback: fb1.getAttribute('data-icon'), warned
    };
  }, CANONICAL_ICONS);
  assert.deepEqual(iconInfo.missing, [], 'every canonical icon exists');
  assert.ok(iconInfo.count >= CANONICAL_ICONS.length, 'icon list covers the canonical names');
  assert.equal(iconInfo.tag.toLowerCase(), 'svg');
  assert.equal(iconInfo.hidden, 'true');
  assert.equal(iconInfo.width, '20');
  assert.equal(iconInfo.titledRole, 'img');
  assert.equal(iconInfo.titledText, 'Favourite');
  assert.ok(iconInfo.strOk, 'icons.svg returns static markup');
  assert.equal(iconInfo.fallback, 'fallback');
  assert.equal(iconInfo.warned, 1, 'unknown icon warns once');

  /* ------------------------------------------------------------ pure helpers */
  const pure = await page.eval(() => {
    const w = APB.require('widgets');
    const g = w.parseGradient('linear-gradient(to right, #ff0000, rgba(0, 0, 255, 0.5) 80%, $primary)');
    return {
      e1: w.evaluate('100/2'), e2: w.evaluate('20+4'), e3: w.evaluate('+=5', 10), e4: w.evaluate('2*(3+4)px'), e5: w.evaluate('abc'),
      e6: w.evaluate('1/0'), e7: w.evaluate('-3 * -2'), grad: g, gradOut: g && w.formatGradient(g),
      hsv: w.rgbToHsv({ r: 255, g: 0, b: 0 }), rgb: w.hsvToRgb({ h: 120, s: 1, v: 1 })
    };
  });
  assert.equal(pure.e1, 50);
  assert.equal(pure.e2, 24);
  assert.equal(pure.e3, 15);
  assert.equal(pure.e4, 14);
  assert.equal(pure.e5, null);
  assert.equal(pure.e6, null);
  assert.equal(pure.e7, 6);
  assert.equal(pure.grad.angle, 90);
  assert.equal(pure.grad.stops.length, 3);
  assert.equal(pure.gradOut, 'linear-gradient(90deg, #ff0000 0%, #0000ff80 80%, $primary 100%)');
  assert.deepEqual(pure.hsv, { h: 0, s: 1, v: 1 });
  assert.deepEqual(pure.rgb, { r: 0, g: 255, b: 0 });

  /* ------------------------------------------------------------ gallery */
  await page.eval(() => {
    const w = APB.require('widgets');
    const icons = APB.require('icons');
    const { h } = w;
    window.__wlog = [];
    const log = (id) => (value, meta) => window.__wlog.push({ id, value, commit: !!(meta && meta.commit) });
    const card = (title, ...children) => h('div', { class: 'wg-card' }, h('h2', { class: 'wg-title' }, title), children);

    const style = h('style', null, [
      '#wg{position:fixed;inset:0;z-index:5000;overflow:auto;padding:20px;background:var(--apb-bg);color:var(--apb-text);font:13px/1.4 var(--apb-font)}',
      '#wg .wg-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:start}',
      '#wg .wg-card{display:grid;gap:8px;padding:12px;border:1px solid var(--apb-border);border-radius:var(--apb-radius-3);background:var(--apb-surface)}',
      '#wg .wg-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--apb-text-muted)}',
      '#wg .wg-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '#wg .wg-icons{display:grid;grid-template-columns:repeat(16,1fr);gap:4px;color:var(--apb-text)}',
      '#wg .wg-icons span{display:flex;align-items:center;justify-content:center;height:26px;border-radius:4px}',
      '#wg .wg-icons span:hover{background:var(--apb-hover)}',
      '#wg .wg-wide{grid-column:span 2}'
    ].join('\n'));

    const iconGrid = h('div', { class: 'wg-icons' }, icons.list().map((n) => w.tooltip(h('span', { tabindex: '0', 'aria-label': n }, icons.get(n, { size: 18 })), { label: n })));

    const section = w.section({ title: 'Layout', actions: [w.iconButton({ icon: 'plus', label: 'Add layout', size: 'sm' })] },
      w.fieldRow({ label: 'Direction', control: w.segmented({ id: 'wg-dir', options: [
        { value: 'row', label: 'Row', icon: 'stack-row' }, { value: 'column', label: 'Column', icon: 'stack-column' }], value: 'column', iconOnly: true }) }),
      w.fieldRow({ label: 'Gap', control: w.numberField({ label: 'Gap', icon: 'gap', value: 16, min: 0, unit: 'px' }), overridden: true,
        onReset: () => window.__wlog.push({ id: 'reset' }) }),
      w.fieldRow({ label: 'Sizing', control: w.segmented({ options: [{ value: 'fixed', label: 'Fixed' }, { value: 'fill', label: 'Fill' }, { value: 'hug', label: 'Hug' }], value: 'fill', size: 'sm' }),
        hint: 'Hug is unavailable in free layouts' }));

    const disabledBtn = w.iconButton({ icon: 'align-left', label: 'Align left', shortcut: 'Alt+A' });
    disabledBtn.apbControl.setDisabled(true, 'Select 2 or more layers');
    const mixedNum = w.numberField({ label: 'H', ariaLabel: 'Height', value: 10 });
    mixedNum.apbControl.setMixed(true);
    const mixedColor = w.colorField({ label: 'Stroke', value: '#000' });
    mixedColor.apbControl.setMixed(true);

    const root = h('div', { id: 'wg', class: 'apb-ui' }, style,
      h('div', { class: 'wg-grid' },
        card('Buttons',
          h('div', { class: 'wg-row' },
            w.button({ label: 'Default' }), w.button({ label: 'Primary', variant: 'primary', icon: 'export' }),
            w.button({ label: 'Ghost', variant: 'ghost' }), w.button({ label: 'Subtle', variant: 'subtle' }),
            w.button({ label: 'Delete', variant: 'danger', icon: 'trash' })),
          h('div', { class: 'wg-row' },
            w.iconButton({ id: 'wg-undo', icon: 'undo', label: 'Undo', shortcut: 'Mod+Z', onClick: log('undo') }),
            w.iconButton({ icon: 'redo', label: 'Redo', shortcut: ['Mod+Shift+Z', 'Mod+Y'] }),
            w.iconButton({ icon: 'magnet', label: 'Snapping', pressed: true }),
            disabledBtn,
            w.button({ label: 'Small', size: 'sm', icon: 'plus' }),
            w.kbd(['Mod+K', 'Mod+Shift+P']),
            w.badge('3', { kind: 'danger' }), w.badge('New', { kind: 'accent' }))),
        card('Numbers',
          w.fieldRow({ label: 'Width', control: w.numberField({ id: 'wg-num', label: 'W', ariaLabel: 'Width', value: 10, min: 0, max: 1000, unit: 'px', onInput: log('num') }) }),
          w.fieldRow({ label: 'Rotation', control: w.numberField({ icon: 'rotate', label: 'Rotation', value: 45, min: 0, max: 360, wrap: true, unit: '°' }) }),
          w.fieldRow({ label: 'Height', control: mixedNum }),
          w.fieldRow({ label: 'Opacity', control: w.slider({ id: 'wg-slider', min: 0, max: 100, value: 80, unit: '%', showValue: true, onInput: log('slider') }) })),
        card('Text',
          w.textField({ icon: 'search', clearable: true, placeholder: 'Search layers', ariaLabel: 'Search layers', value: 'Hero' }),
          w.fieldRow({ label: 'Link', control: w.textField({ id: 'wg-text', value: 'https://example.com', validate: (v) => (/^https?:/.test(v) ? null : 'Enter a web address'), onInput: log('text') }) }),
          w.fieldRow({ label: 'Alt text', layout: 'stacked', control: w.textArea({ value: 'A person using a laptop at a desk', rows: 2 }) }),
          w.fieldRow({ label: 'Tag', control: w.select({ id: 'wg-select', options: [{ value: 'h1', label: 'Heading 1' }, { value: 'h2', label: 'Heading 2' }, { value: 'p', label: 'Paragraph' }], value: 'h2', onInput: log('select') }) })),
        card('Choices',
          w.fieldRow({ label: 'Align', control: w.segmented({ id: 'wg-seg', label: 'Text align', iconOnly: true, value: 'left', onInput: log('seg'), options: [
            { value: 'left', label: 'Left', icon: 'text-align-left' }, { value: 'center', label: 'Center', icon: 'text-align-center' },
            { value: 'right', label: 'Right', icon: 'text-align-right' }, { value: 'justify', label: 'Justify', icon: 'text-align-justify' }] }) }),
          w.toggle({ id: 'wg-toggle', label: 'Clip content', checked: false, onInput: log('toggle') }),
          w.checkbox({ label: 'Lock aspect ratio', checked: true }),
          w.checkbox({ label: 'Mixed selection', checked: false, ref: (el) => el })),
        card('Color',
          w.fieldRow({ label: 'Fill', control: w.colorField({ id: 'wg-color', className: 'wg-color', label: 'Fill', value: '#2160e0', onInput: log('color') }) }),
          w.fieldRow({ label: 'Token', control: w.colorField({ label: 'Text color', swatches: () => [{ label: 'Primary', value: '$primary', color: '#2563eb' }, { label: 'Ink', value: '$ink', color: '#111827' }], value: '$primary' }) }),
          w.fieldRow({ label: 'None', control: w.colorField({ label: 'Background', value: null }) }),
          w.fieldRow({ label: 'Stroke', control: mixedColor })),
        h('div', { class: 'wg-card' }, h('h2', { class: 'wg-title' }, 'Gradient'),
          w.gradientField({ value: 'linear-gradient(135deg, #2160e0 0%, #e0169a 100%)', onInput: log('gradient') })),
        h('div', { class: 'wg-card', style: { padding: '0' } }, section),
        card('Empty state', w.emptyState({ icon: 'layers', title: 'No layers yet', message: 'Insert an element or pick a section template to get started.', action: { label: 'Insert', icon: 'plus' } })),
        h('div', { class: 'wg-card wg-wide' }, h('h2', { class: 'wg-title' }, 'Icons (' + icons.list().length + ')'), iconGrid)));
    document.body.appendChild(root);
    document.querySelector('.apb-ui .apb-checkbox:last-of-type input');
    const cbs = root.querySelectorAll('.apb-checkbox');
    cbs[cbs.length - 1].apbControl.setMixed(true);
  });

  /* ----------------------------------------------------------- ARIA checks */
  const aria = await page.eval(() => {
    const num = document.getElementById('wg-num');
    const seg = document.getElementById('wg-seg');
    const sw = document.getElementById('wg-toggle');
    const undo = document.getElementById('wg-undo');
    const unnamed = Array.from(document.querySelectorAll('#wg button, #wg input, #wg select, #wg textarea, #wg [role="slider"]')).filter((el) => {
      const name = (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') ? 'x' : '') ||
        (el.labels && Array.from(el.labels).map((l) => l.textContent).join('').trim()) || (el.tagName === 'BUTTON' ? el.textContent.trim() : '');
      return !name;
    }).map((el) => el.outerHTML.slice(0, 120));
    return {
      role: num.getAttribute('role'), now: num.getAttribute('aria-valuenow'), min: num.getAttribute('aria-valuemin'), max: num.getAttribute('aria-valuemax'),
      valuetext: num.getAttribute('aria-valuetext'), label: num.labels.length && num.labels[0].textContent,
      segRole: seg.getAttribute('role'), radios: seg.querySelectorAll('[role="radio"]').length, checked: seg.querySelector('[aria-checked="true"]').getAttribute('aria-label'),
      tabbable: seg.querySelectorAll('[tabindex="0"]').length, segLabelled: !!seg.getAttribute('aria-labelledby'),
      swRole: sw.getAttribute('role'), swChecked: sw.getAttribute('aria-checked'),
      undoLabel: undo.getAttribute('aria-label'), undoKeys: undo.getAttribute('aria-keyshortcuts'), undoTitle: undo.getAttribute('title'),
      mixedPlaceholder: document.querySelector('#wg .apb-num.is-mixed input').placeholder,
      disabledAria: document.querySelector('#wg [aria-disabled="true"]') !== null,
      unnamed
    };
  });
  assert.equal(aria.role, 'spinbutton');
  assert.equal(aria.now, '10');
  assert.equal(aria.min, '0');
  assert.equal(aria.max, '1000');
  assert.equal(aria.valuetext, '10 px');
  assert.ok(aria.label, 'number input has a <label>');
  assert.equal(aria.segRole, 'radiogroup');
  assert.equal(aria.radios, 4);
  assert.equal(aria.checked, 'Left');
  assert.equal(aria.tabbable, 1, 'segmented uses a roving tabindex');
  assert.ok(aria.segLabelled, 'fieldRow labels the radiogroup');
  assert.equal(aria.swRole, 'switch');
  assert.equal(aria.swChecked, 'false');
  assert.equal(aria.undoLabel, 'Undo');
  assert.match(aria.undoKeys, /^(Control|Meta)\+Z$/);
  assert.equal(aria.undoTitle, null, 'custom tooltip replaces the native title');
  assert.equal(aria.mixedPlaceholder, 'Mixed');
  assert.ok(aria.disabledAria, 'disabled-with-reason keeps the button focusable');
  assert.deepEqual(aria.unnamed, [], 'every control has an accessible name');

  const lastLog = () => page.eval(() => window.__wlog[window.__wlog.length - 1] || null);
  const logFor = (id) => page.eval((i) => window.__wlog.filter((e) => e.id === i), id);

  /* ----------------------------------------------------------- numberField */
  await page.click('#wg-num');
  await page.key('ArrowUp');
  assert.deepEqual(await lastLog(), { id: 'num', value: 11, commit: true });
  await page.key('Shift+ArrowUp');
  assert.deepEqual(await lastLog(), { id: 'num', value: 21, commit: true });
  await page.key('Alt+ArrowDown');
  assert.deepEqual(await lastLog(), { id: 'num', value: 20.9, commit: true });
  await page.eval(() => document.getElementById('wg-num').select());
  await page.type('100/2');
  await page.key('Enter');
  assert.deepEqual(await lastLog(), { id: 'num', value: 50, commit: true });
  assert.equal(await page.eval(() => document.getElementById('wg-num').getAttribute('aria-valuenow')), '50');
  await page.eval(() => document.getElementById('wg-num').select());
  await page.type('20+4');
  await page.key('Tab');
  assert.deepEqual(await lastLog(), { id: 'num', value: 24, commit: true }, 'blur commits');
  await page.click('#wg-num');
  await page.eval(() => document.getElementById('wg-num').select());
  const before = (await logFor('num')).length;
  await page.type('777');
  await page.key('Escape');
  assert.equal(await page.eval(() => document.getElementById('wg-num').value), '24', 'Escape reverts');
  assert.equal((await logFor('num')).length, before, 'Escape does not emit');
  await page.eval(() => document.getElementById('wg-num').select());
  await page.type('5000');
  await page.key('Enter');
  assert.deepEqual(await lastLog(), { id: 'num', value: 1000, commit: true }, 'clamped to max');
  await page.eval(() => { document.getElementById('wg-num').apbControl.value = 100; });

  // scrub by dragging the label
  const lbl = await page.rect('label[for="wg-num"]');
  const scrubStart = (await logFor('num')).length;
  await page.drag(lbl.cx, lbl.cy, lbl.cx + 40, lbl.cy, { steps: 10 });
  const scrubLog = (await logFor('num')).slice(scrubStart);
  assert.ok(scrubLog.length >= 2, 'scrub emits values');
  assert.ok(scrubLog.some((e) => !e.commit), 'scrub emits live (uncommitted) values');
  const finalScrub = scrubLog[scrubLog.length - 1];
  assert.equal(finalScrub.commit, true, 'scrub commits on release');
  assert.ok(finalScrub.value > 100 && finalScrub.value <= 140, 'scrub increases value (got ' + finalScrub.value + ')');
  assert.notEqual(await page.eval(() => document.activeElement && document.activeElement.id), 'wg-num-label-click', 'label click after scrub suppressed');

  /* ----------------------------------------------------------- segmented */
  await page.click('#wg-seg [aria-label="Left"]');
  await page.key('ArrowRight');
  assert.deepEqual(await lastLog(), { id: 'seg', value: 'center', commit: true });
  await page.key('End');
  assert.deepEqual(await lastLog(), { id: 'seg', value: 'justify', commit: true });
  await page.key('ArrowRight');
  assert.deepEqual(await lastLog(), { id: 'seg', value: 'left', commit: true }, 'arrow keys wrap');
  const segState = await page.eval(() => ({
    checked: document.querySelector('#wg-seg [aria-checked="true"]').getAttribute('aria-label'),
    focused: document.activeElement.getAttribute('aria-label'),
    tabbable: document.querySelector('#wg-seg [tabindex="0"]').getAttribute('aria-label')
  }));
  assert.deepEqual(segState, { checked: 'Left', focused: 'Left', tabbable: 'Left' });

  /* ----------------------------------------------------------- toggle */
  await page.eval(() => document.getElementById('wg-toggle').focus());
  await page.key('Space');
  assert.deepEqual(await lastLog(), { id: 'toggle', value: true, commit: true });
  assert.equal(await page.eval(() => document.getElementById('wg-toggle').getAttribute('aria-checked')), 'true');

  /* ----------------------------------------------------------- slider & select */
  await page.eval(() => document.querySelector('#wg-slider').focus());
  await page.key('ArrowRight');
  const sliderLog = await logFor('slider');
  assert.ok(sliderLog.some((e) => e.value === 81), 'slider arrow key emits');
  assert.equal(await page.eval(() => document.querySelector('#wg-slider').getAttribute('aria-valuetext')), '81 %');
  await page.eval(() => {
    const s = document.getElementById('wg-select');
    s.value = '2';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.deepEqual(await lastLog(), { id: 'select', value: 'p', commit: true });

  /* ----------------------------------------------------------- text validation */
  await page.click('#wg-text');
  await page.eval(() => document.getElementById('wg-text').select());
  await page.type('nope');
  const invalid = await page.eval(() => {
    const t = document.getElementById('wg-text');
    const err = document.getElementById(t.getAttribute('aria-describedby').split(' ').pop());
    return { invalid: t.getAttribute('aria-invalid'), msg: err && err.textContent };
  });
  assert.deepEqual(invalid, { invalid: 'true', msg: 'Enter a web address' });
  await page.key('Escape');
  assert.equal(await page.eval(() => document.getElementById('wg-text').value), 'https://example.com');

  /* ----------------------------------------------------------- colorField */
  await page.click('#wg-color');
  await page.eval(() => document.getElementById('wg-color').select());
  await page.type('#ff0000');
  await page.key('Enter');
  assert.deepEqual(await lastLog(), { id: 'color', value: '#ff0000', commit: true });
  const recent = await page.eval(() => APB.app.store.prefs.recentColors.slice());
  assert.equal(recent[0], '#ff0000', 'committed color stored in prefs.recentColors');
  await page.eval(() => document.getElementById('wg-color').select());
  await page.type('rgb(0 128 0 / 50%)');
  await page.key('Enter');
  assert.deepEqual(await lastLog(), { id: 'color', value: '#00800080', commit: true }, 'rgb() input normalised to hex with alpha');
  await page.eval(() => document.getElementById('wg-color').select());
  await page.type('ff0000');
  await page.key('Enter');
  assert.deepEqual(await lastLog(), { id: 'color', value: '#ff0000', commit: true }, 'bare hex accepted');

  await page.click('.wg-color .apb-color-swatch');
  await page.waitFor(() => !!document.querySelector('.apb-colorpicker'));
  const pop = await page.eval(() => {
    const p = document.querySelector('.apb-popover');
    const btn = document.querySelector('.wg-color .apb-color-swatch');
    return { role: p.getAttribute('role'), label: p.getAttribute('aria-label'), expanded: btn.getAttribute('aria-expanded'),
      focus: document.activeElement.className, topLayer: p.matches(':popover-open') || getComputedStyle(p).position === 'fixed',
      hasRecent: !!p.querySelector('[aria-label="Recent"] .apb-cp-swatch'), pressed: !!p.querySelector('.apb-cp-swatch[aria-pressed="true"]') };
  });
  assert.equal(pop.role, 'dialog');
  assert.equal(pop.label, 'Fill picker');
  assert.equal(pop.expanded, 'true');
  assert.equal(pop.focus, 'apb-cp-sv', 'focus moves into the picker');
  assert.ok(pop.topLayer);
  assert.ok(pop.hasRecent, 'recent colors listed');
  assert.ok(pop.pressed, 'current color marked in swatches');
  await page.key('ArrowDown');
  const svLog = await lastLog();
  assert.equal(svLog.id, 'color');
  assert.equal(svLog.commit, true);
  assert.equal(svLog.value, '#fc0000', 'SV area arrow key lowers brightness');
  await page.key('Shift+ArrowLeft');
  const svLog2 = await lastLog();
  assert.ok(/^#fc[0-9a-f]{4}$/.test(svLog2.value) && svLog2.value !== '#fc0000', 'Shift+ArrowLeft lowers saturation (got ' + svLog2.value + ')');
  await page.screenshot('colorpicker-light');
  await page.key('Escape');
  const closed = await page.eval(() => ({
    open: !!document.querySelector('.apb-colorpicker'),
    focus: document.activeElement.classList.contains('apb-color-swatch'),
    expanded: document.querySelector('.wg-color .apb-color-swatch').getAttribute('aria-expanded'),
    chip: document.querySelector('.wg-color .apb-color-chip-fill').style.background
  }));
  assert.deepEqual({ open: closed.open, focus: closed.focus, expanded: closed.expanded }, { open: false, focus: true, expanded: 'false' });
  assert.ok(closed.chip.startsWith('rgb('), 'chip shows the color');

  // outside click closes without errors
  await page.click('.wg-color .apb-color-swatch');
  await page.waitFor(() => !!document.querySelector('.apb-colorpicker'));
  await page.mouse('move', 1200, 880);
  await page.mouse('down', 1200, 880);
  await page.mouse('up', 1200, 880);
  assert.equal(await page.eval(() => !!document.querySelector('.apb-colorpicker')), false, 'outside click closes the popover');

  /* ----------------------------------------------------------- gradient */
  await page.eval(() => document.querySelector('#wg .apb-gradient-stop').focus());
  await page.key('ArrowRight');
  const gradLog = await lastLog();
  assert.equal(gradLog.id, 'gradient');
  assert.equal(gradLog.value, 'linear-gradient(135deg, #2160e0 1%, #e0169a 100%)');

  /* ----------------------------------------------------------- tooltip */
  const undoRect = await page.rect('#wg-undo');
  await page.mouse('move', undoRect.cx, undoRect.cy);
  await page.waitFor(() => {
    const t = document.querySelector('.apb-tooltip.is-open');
    return t && t.textContent.includes('Undo');
  }, 3000);
  const tipInfo = await page.eval(() => {
    const t = document.querySelector('.apb-tooltip.is-open');
    return { role: t.getAttribute('role'), kbd: t.querySelector('.apb-kbd') && t.querySelector('.apb-kbd').textContent };
  });
  assert.equal(tipInfo.role, 'tooltip');
  assert.ok(/Z/.test(tipInfo.kbd || ''), 'tooltip shows the shortcut');
  await page.screenshot('tooltip');
  await page.mouse('move', 5, 5);
  await page.waitFor(() => !document.querySelector('.apb-tooltip.is-open'), 2000);

  /* ----------------------------------------------------------- section & override */
  const secInfo = await page.eval(() => {
    const t = document.querySelector('#wg .apb-section-toggle');
    t.click();
    const collapsed = { expanded: t.getAttribute('aria-expanded'), hidden: document.getElementById(t.getAttribute('aria-controls')).hidden };
    t.click();
    document.querySelector('#wg .apb-field-row.is-overridden .apb-override-dot').click();
    return { collapsed, expanded: t.getAttribute('aria-expanded'), reset: window.__wlog.some((e) => e.id === 'reset') };
  });
  assert.deepEqual(secInfo, { collapsed: { expanded: 'false', hidden: true }, expanded: 'true', reset: true });

  /* ----------------------------------------------------------- contrast of tokens */
  const contrast = await page.eval(() => {
    const color = APB.require('color');
    const out = {};
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue('--apb-' + n).trim();
      const fails = [];
      const check = (fg, bg, min) => {
        const r = color.contrastRatio(v(fg), v(bg));
        if (!(r >= min)) fails.push(fg + ' on ' + bg + ' = ' + r.toFixed(2));
      };
      for (const bg of ['bg', 'surface', 'surface-2', 'surface-3']) {
        for (const fg of ['text', 'text-muted', 'text-subtle', 'accent-text', 'danger', 'warning', 'success']) check(fg, bg, 4.5);
        for (const fg of ['border-strong', 'focus']) check(fg, bg, 3);
      }
      check('accent-contrast', 'accent', 4.5);
      check('accent-contrast', 'accent-hover', 4.5);
      check('danger-contrast', 'danger-fill', 4.5);
      check('tooltip-text', 'tooltip-bg', 4.5);
      check('accent-text', 'accent-soft', 4.5);
      out[theme] = fails;
    }
    return out;
  });
  assert.deepEqual(contrast, { light: [], dark: [] }, 'token contrast meets WCAG AA');

  /* ----------------------------------------------------------- screenshots */
  await page.eval(() => { document.documentElement.dataset.theme = 'light'; document.getElementById('wg').scrollTop = 0; });
  await sleep(50);
  await page.screenshot('gallery-light');
  await page.eval(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(50);
  await page.screenshot('gallery-dark');
  await page.click('.wg-color .apb-color-swatch');
  await page.waitFor(() => !!document.querySelector('.apb-colorpicker'));
  await page.screenshot('colorpicker-dark');
  await page.key('Escape');
  await page.eval(() => { document.documentElement.dataset.theme = 'system'; document.getElementById('wg').remove(); });
}

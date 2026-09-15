export default function (APB, t) {
  const { test, assert } = t;
  const color = APB.require('color');
  const near = (a, b, eps = 0.01, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ` expected ${b}, got ${a}`);

  test('parse hex 3/4/6/8, rgb(a), hsl(a), named, transparent', () => {
    assert.deepEqual(color.parse('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(color.parse('#2563eb'), { r: 37, g: 99, b: 235, a: 1 });
    assert.deepEqual(color.parse('#0000'), { r: 0, g: 0, b: 0, a: 0 });
    const c8 = color.parse('#ff000080');
    assert.equal(c8.r, 255);
    near(c8.a, 0.502, 0.001);
    assert.deepEqual(color.parse('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
    assert.deepEqual(color.parse('rgba(10,20,30,.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
    assert.deepEqual(color.parse('rgb(10 20 30 / 25%)'), { r: 10, g: 20, b: 30, a: 0.25 });
    assert.deepEqual(color.parse('rgb(100% 0% 0%)'), { r: 255, g: 0, b: 0, a: 1 });
    const hsl = color.parse('hsl(120, 100%, 50%)');
    assert.equal(color.toHex(hsl), '#00ff00');
    assert.equal(color.toHex('hsla(0.5turn 100% 50% / 1)'), '#00ffff');
    assert.equal(color.toHex('RebeccaPurple'), '#663399');
    assert.deepEqual(color.parse('transparent'), { r: 0, g: 0, b: 0, a: 0 });
    assert.equal(color.parse('nope'), null);
    assert.equal(color.parse('#12'), null);
    assert.equal(color.parse('rgb(1,2)'), null);
    assert.equal(color.parse(''), null);
    assert.equal(color.parse(42), null);
    assert.ok(color.isColor('oklch(0.6 0.15 250)'));
  });

  test('format: toHex / toRGBString', () => {
    assert.equal(color.toHex({ r: 37, g: 99, b: 235, a: 0.5 }), '#2563eb');
    assert.equal(color.toHex({ r: 37, g: 99, b: 235, a: 0.5 }, true), '#2563eb80');
    assert.equal(color.toHex('#2563eb', 'auto'), '#2563eb');
    assert.equal(color.toRGBString('#2563eb'), 'rgb(37, 99, 235)');
    assert.equal(color.toRGBString('rgba(1,2,3,0.25)'), 'rgba(1, 2, 3, 0.25)');
    assert.equal(color.toHex('garbage'), '');
  });

  test('HSL and OKLCH round trips', () => {
    for (const hex of ['#2563eb', '#ff6347', '#10b981', '#000000', '#ffffff', '#777777']) {
      const c = color.parse(hex);
      assert.equal(color.toHex(color.hslToRgb(color.rgbToHsl(c))), hex, 'hsl ' + hex);
      assert.equal(color.toHex(color.oklchToRgb(color.rgbToOklch(c))), hex, 'oklch ' + hex);
    }
    const white = color.rgbToOklch({ r: 255, g: 255, b: 255 });
    near(white.l, 1, 0.001);
    near(white.c, 0, 0.001);
    // Out-of-gamut OKLCH is chroma-reduced into sRGB.
    const out = color.oklchToRgb({ l: 0.7, c: 0.5, h: 150 });
    for (const k of ['r', 'g', 'b']) assert.ok(out[k] >= 0 && out[k] <= 255);
  });

  test('WCAG contrast known values', () => {
    near(color.contrastRatio('#777', '#fff'), 4.48, 0.005);
    near(color.contrastRatio('#000', '#fff'), 21, 0.001);
    near(color.contrastRatio('#fff', '#fff'), 1, 0.001);
    near(color.contrastRatio('#595959', '#fff'), 7.0, 0.01);
    near(color.contrastRatio('#999', '#fff'), 2.85, 0.01);
    // translucent foreground is composited over the background
    near(color.contrastRatio('rgba(0,0,0,0.5)', '#fff'), color.contrastRatio('#808080', '#fff'), 0.05);
    near(color.relativeLuminance('#fff'), 1, 1e-9);
  });

  test('isLargeText thresholds', () => {
    assert.equal(color.isLargeText(24, 400), true);
    assert.equal(color.isLargeText(23.9, 400), false);
    assert.equal(color.isLargeText(18.66, 700), true);
    assert.equal(color.isLargeText(18.66, 'bold'), true);
    assert.equal(color.isLargeText(18.66, 600), false);
    assert.equal(color.isLargeText(16, 900), false);
  });

  test('ensureContrast returns passing colors with minimal change', () => {
    assert.equal(color.ensureContrast('#111827', '#ffffff'), '#111827', 'already passing is unchanged');
    const fixed = color.ensureContrast('#9ca3af', '#ffffff', 4.5);
    assert.ok(color.contrastRatio(fixed, '#ffffff') >= 4.5, 'meets target on white: ' + fixed);
    assert.ok(color.contrastRatio(fixed, '#ffffff') < 5.2, 'minimal change: ' + fixed);
    const onDark = color.ensureContrast('#4b5563', '#111827', 4.5);
    assert.ok(color.contrastRatio(onDark, '#111827') >= 4.5, 'meets target on dark: ' + onDark);
    assert.ok(color.rgbToOklch(color.parse(onDark)).l > color.rgbToOklch(color.parse('#4b5563')).l, 'lightened on dark bg');
    const hue = color.rgbToOklch(color.parse('#ef4444')).h;
    const red = color.ensureContrast('#ef4444', '#ffffff', 4.5);
    assert.ok(Math.abs(color.rgbToOklch(color.parse(red)).h - hue) < 8, 'hue preserved');
    const seven = color.ensureContrast('#777777', '#808080', 7);
    assert.ok(color.contrastRatio(seven, '#808080') >= 4.5);
  });

  test('readableOn / mix / shades', () => {
    assert.equal(color.readableOn('#ffffff'), '#000');
    assert.equal(color.readableOn('#111827'), '#fff');
    assert.equal(color.readableOn('#2563eb'), '#fff');
    assert.equal(color.toHex(color.mix('#000000', '#ffffff', 0.5)), '#808080');
    assert.equal(color.toHex(color.mix('#ff0000', '#0000ff', 0)), '#ff0000');
    const s = color.shades('#2563eb');
    assert.deepEqual(Object.keys(s).map(Number), [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
    assert.ok(Object.values(s).includes('#2563eb'), 'base color is one of the stops');
    const ls = Object.values(s).map((hex) => color.rgbToOklch(color.parse(hex)).l);
    for (let i = 1; i < ls.length; i++) assert.ok(ls[i] < ls[i - 1], 'lightness decreases');
    assert.equal(color.shades('bad'), null);
  });

  test('paletteFromImageData finds dominant colors ordered by population', () => {
    const w = 20;
    const h = 20;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      const c = i < 300 ? [220, 38, 38] : i < 380 ? [37, 99, 235] : [250, 250, 250];
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
    const pal = color.paletteFromImageData({ data, width: w, height: h }, 3);
    assert.equal(pal.length, 3);
    assert.equal(pal[0], '#dc2626');
    assert.equal(pal[1], '#2563eb');
    assert.equal(pal[2], '#fafafa');
    assert.deepEqual(color.paletteFromImageData({ data: new Uint8ClampedArray(16) }, 4), [], 'transparent pixels ignored');
  });
}

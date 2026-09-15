/* @node-testable */
/*
 * color — parse/format/convert colors, WCAG contrast, OKLCH adjustments, palettes. Pure.
 * Color objects: { r, g, b, a } with r/g/b in 0–255 (may be fractional) and a in 0–1.
 * See ARCHITECTURE.md §6.3.
 */
APB.define('color', [], function () {
  'use strict';

  const NAMED_SRC =
    'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,' +
    'black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,' +
    'chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,' +
    'darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,' +
    'darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,' +
    'darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,' +
    'darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,' +
    'dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,' +
    'ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,' +
    'honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
    'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
    'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,' +
    'lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,' +
    'lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,' +
    'mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,' +
    'mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,' +
    'midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,' +
    'oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,' +
    'palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,' +
    'pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,' +
    'royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,' +
    'silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,' +
    'steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,' +
    'white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

  const NAMED = new Map(NAMED_SRC.split(',').map((pair) => pair.split(':')));

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp255 = (v) => clamp(v, 0, 255);
  const clamp01 = (v) => clamp(v, 0, 1);

  /* ---------------------------------------------------------------- parse */

  function fromHexString(hex) {
    let h = hex.slice(1);
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1
    };
  }

  function splitArgs(inner) {
    // Supports "a, b, c, d", "a b c / d" and "a b c".
    let alpha = null;
    let body = inner.trim();
    const slash = body.indexOf('/');
    if (slash >= 0) {
      alpha = body.slice(slash + 1).trim();
      body = body.slice(0, slash).trim();
    }
    let parts = body.includes(',') ? body.split(',').map((s) => s.trim()) : body.split(/\s+/);
    parts = parts.filter((s) => s !== '');
    if (alpha === null && parts.length === 4) alpha = parts.pop();
    return { parts, alpha };
  }

  function num(token) {
    if (token === 'none') return 0;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(token)) return NaN;
    return parseFloat(token);
  }

  function parseAlpha(token) {
    if (token === null || token === undefined) return 1;
    const v = num(token);
    if (Number.isNaN(v)) return NaN;
    return clamp01(token.endsWith('%') ? v / 100 : v);
  }

  function parseHue(token) {
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/i.exec(token);
    if (token === 'none') return 0;
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    const unit = (m[2] || 'deg').toLowerCase();
    const deg = unit === 'rad' ? (v * 180) / Math.PI : unit === 'grad' ? v * 0.9 : unit === 'turn' ? v * 360 : v;
    return ((deg % 360) + 360) % 360;
  }

  /** parse(str) → { r, g, b, a } | null. Accepts color objects too. */
  function parse(input) {
    if (input && typeof input === 'object') {
      if (['r', 'g', 'b'].every((k) => typeof input[k] === 'number' && Number.isFinite(input[k]))) {
        return { r: clamp255(input.r), g: clamp255(input.g), b: clamp255(input.b), a: typeof input.a === 'number' ? clamp01(input.a) : 1 };
      }
      return null;
    }
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;
    if (s[0] === '#') return fromHexString(s);
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED.has(s)) return fromHexString('#' + NAMED.get(s));
    const fm = /^([a-z]+)\((.*)\)$/.exec(s);
    if (!fm) return null;
    const fn = fm[1];
    const { parts, alpha } = splitArgs(fm[2]);
    if (parts.length !== 3) return null;
    const a = parseAlpha(alpha);
    if (Number.isNaN(a)) return null;
    if (fn === 'rgb' || fn === 'rgba') {
      const ch = parts.map((p) => {
        const v = num(p);
        return p.endsWith('%') ? (v / 100) * 255 : v;
      });
      if (ch.some((v) => Number.isNaN(v))) return null;
      return { r: clamp255(ch[0]), g: clamp255(ch[1]), b: clamp255(ch[2]), a };
    }
    if (fn === 'hsl' || fn === 'hsla') {
      const h = parseHue(parts[0]);
      const sat = num(parts[1]);
      const light = num(parts[2]);
      if ([h, sat, light].some((v) => Number.isNaN(v))) return null;
      const rgb = hslToRgb({ h, s: clamp(sat, 0, 100), l: clamp(light, 0, 100) });
      return { r: rgb.r, g: rgb.g, b: rgb.b, a };
    }
    if (fn === 'oklch') {
      let l = num(parts[0]);
      let c = num(parts[1]);
      const h = parseHue(parts[2]);
      if ([l, c, h].some((v) => Number.isNaN(v))) return null;
      if (parts[0].endsWith('%')) l /= 100;
      if (parts[1].endsWith('%')) c = (c / 100) * 0.4;
      const rgb = oklchToRgb({ l: clamp01(l), c: Math.max(0, c), h });
      return { r: rgb.r, g: rgb.g, b: rgb.b, a };
    }
    return null;
  }

  function isColor(str) {
    return parse(str) !== null;
  }

  /* --------------------------------------------------------------- format */

  const hex2 = (v) => Math.round(clamp255(v)).toString(16).padStart(2, '0');

  /** toHex(c, withAlpha) — withAlpha: true = always #rrggbbaa, 'auto' = only when a < 1. */
  function toHex(c, withAlpha = false) {
    const col = parse(c);
    if (!col) return '';
    let out = '#' + hex2(col.r) + hex2(col.g) + hex2(col.b);
    if (withAlpha === true || (withAlpha === 'auto' && col.a < 1)) out += hex2(col.a * 255);
    return out;
  }

  function toRGBString(c) {
    const col = parse(c);
    if (!col) return '';
    const r = Math.round(col.r);
    const g = Math.round(col.g);
    const b = Math.round(col.b);
    if (col.a >= 1) return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + Math.round(col.a * 1000) / 1000 + ')';
  }

  /* ---------------------------------------------------------- conversions */

  /** { r, g, b } (0–255) → { h (0–360), s (0–100), l (0–100) }. */
  function rgbToHsl(c) {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    const d = max - min;
    if (d > 1e-9) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    const out = { h, s: s * 100, l: l * 100 };
    if (typeof c.a === 'number') out.a = c.a;
    return out;
  }

  /** { h, s (0–100), l (0–100) } → { r, g, b } (0–255, fractional). */
  function hslToRgb(c) {
    const h = (((c.h % 360) + 360) % 360) / 360;
    const s = clamp(c.s, 0, 100) / 100;
    const l = clamp(c.l, 0, 100) / 100;
    let r;
    let g;
    let b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hue(h + 1 / 3);
      g = hue(h);
      b = hue(h - 1 / 3);
    }
    const out = { r: r * 255, g: g * 255, b: b * 255 };
    if (typeof c.a === 'number') out.a = c.a;
    return out;
  }

  const toLinear = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const fromLinear = (v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return c * 255;
  };

  function rgbToOklab(c) {
    const r = toLinear(c.r);
    const g = toLinear(c.g);
    const b = toLinear(c.b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    };
  }

  /** OKLab → unclamped linear-free sRGB (0–255, may fall outside the gamut). */
  function oklabToRgbRaw(lab) {
    const l = Math.pow(lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
    const m = Math.pow(lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
    const s = Math.pow(lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
    return {
      r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    };
  }

  function oklabToRgb(lab) {
    const lin = oklabToRgbRaw(lab);
    return { r: clamp255(fromLinear(clamp01(lin.r))), g: clamp255(fromLinear(clamp01(lin.g))), b: clamp255(fromLinear(clamp01(lin.b))) };
  }

  /** { r, g, b } → { l (0–1), c (≥0), h (0–360) }. */
  function rgbToOklch(c) {
    const lab = rgbToOklab(c);
    const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
    let h = chroma < 1e-6 ? 0 : (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    if (h < 0) h += 360;
    const out = { l: lab.l, c: chroma, h };
    if (typeof c.a === 'number') out.a = c.a;
    return out;
  }

  function inGamut(lin, eps = 1e-4) {
    return lin.r >= -eps && lin.r <= 1 + eps && lin.g >= -eps && lin.g <= 1 + eps && lin.b >= -eps && lin.b <= 1 + eps;
  }

  /** { l, c, h } → { r, g, b }. Out-of-gamut colors are mapped by reducing chroma (hue & lightness kept). */
  function oklchToRgb(c) {
    const l = clamp01(c.l);
    const hr = ((c.h || 0) * Math.PI) / 180;
    const lab = (chroma) => ({ l, a: chroma * Math.cos(hr), b: chroma * Math.sin(hr) });
    let chroma = Math.max(0, c.c || 0);
    if (!inGamut(oklabToRgbRaw(lab(chroma)))) {
      let lo = 0;
      let hi = chroma;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(oklabToRgbRaw(lab(mid)))) lo = mid; else hi = mid;
      }
      chroma = lo;
    }
    const out = oklabToRgb(lab(chroma));
    if (typeof c.a === 'number') out.a = c.a;
    return out;
  }

  /* ------------------------------------------------------------ utilities */

  /** Linear interpolation in sRGB (premultiplied by alpha). Returns a color object. */
  function mix(a, b, t = 0.5) {
    const ca = parse(a);
    const cb = parse(b);
    if (!ca || !cb) return ca || cb || null;
    const tt = clamp01(t);
    const alpha = ca.a + (cb.a - ca.a) * tt;
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k) => (ca[k] * ca.a + (cb[k] * cb.a - ca[k] * ca.a) * tt) / alpha;
    return { r: clamp255(ch('r')), g: clamp255(ch('g')), b: clamp255(ch('b')), a: alpha };
  }

  function relativeLuminance(c) {
    const col = parse(c);
    if (!col) return 0;
    return 0.2126 * toLinear(col.r) + 0.7152 * toLinear(col.g) + 0.0722 * toLinear(col.b);
  }

  function composite(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  /** WCAG 2.x contrast ratio. Translucent fg is composited over bg; translucent bg over white. */
  function contrastRatio(fg, bg) {
    let b = parse(bg);
    let f = parse(fg);
    if (!f || !b) return 1;
    if (b.a < 1) b = composite(b, { r: 255, g: 255, b: 255, a: 1 });
    if (f.a < 1) f = composite(f, b);
    const l1 = relativeLuminance(f);
    const l2 = relativeLuminance(b);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function isLargeText(fontSizePx, fontWeight) {
    const size = Number(fontSizePx) || 0;
    let weight = fontWeight;
    if (weight === 'bold' || weight === 'bolder') weight = 700;
    else if (weight === 'normal' || weight === undefined || weight === null || weight === '') weight = 400;
    weight = Number(weight) || 400;
    return size >= 24 || (size >= 18.66 && weight >= 700);
  }

  /**
   * ensureContrast(fg, bg, target) → hex. Returns fg unchanged (as hex) when it already passes;
   * otherwise moves OKLCH lightness the minimal amount (trying darker and lighter) to reach target.
   */
  function ensureContrast(fg, bg, target = 4.5) {
    const f = parse(fg);
    let b = parse(bg);
    if (!f) return '';
    if (!b) b = { r: 255, g: 255, b: 255, a: 1 };
    if (b.a < 1) b = composite(b, { r: 255, g: 255, b: 255, a: 1 });
    const fOpaque = f.a < 1 ? composite(f, b) : f;
    if (contrastRatio(fOpaque, b) >= target) return toHex(fOpaque);
    const base = rgbToOklch(fOpaque);
    const at = (l) => oklchToRgb({ l, c: base.c, h: base.h });
    const ratioAt = (l) => contrastRatio(at(l), b);
    const candidates = [];
    // Darker: search l in [0, base.l]; lighter: [base.l, 1]. Contrast grows monotonically away from bg.
    if (ratioAt(0) >= target) {
      let lo = 0;
      let hi = base.l;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (ratioAt(mid) >= target) lo = mid; else hi = mid;
      }
      candidates.push({ l: lo, delta: base.l - lo });
    }
    if (ratioAt(1) >= target) {
      let lo = base.l;
      let hi = 1;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (ratioAt(mid) >= target) hi = mid; else lo = mid;
      }
      candidates.push({ l: hi, delta: hi - base.l });
    }
    if (!candidates.length) {
      return contrastRatio('#000000', b) >= contrastRatio('#ffffff', b) ? '#000000' : '#ffffff';
    }
    candidates.sort((x, y) => x.delta - y.delta);
    // Hex rounding can shave a hair of contrast; nudge until the rounded hex passes.
    const dir = candidates[0].l < base.l ? -1 : 1;
    let l = candidates[0].l;
    let hex = toHex(at(l));
    for (let i = 0; i < 50 && contrastRatio(hex, b) < target; i++) {
      l = clamp01(l + dir * 0.002);
      hex = toHex(at(l));
    }
    return hex;
  }

  function readableOn(bg) {
    return contrastRatio('#000', bg) >= contrastRatio('#fff', bg) ? '#000' : '#fff';
  }

  /** Tailwind-like 50–950 scale keyed by stop, the input color sits at its closest stop. */
  function shades(input) {
    const col = parse(input);
    if (!col) return null;
    const stops = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const lightness = [0.975, 0.94, 0.885, 0.81, 0.715, 0.625, 0.54, 0.46, 0.39, 0.32, 0.25];
    const chromaK = [0.18, 0.32, 0.55, 0.78, 0.94, 1, 0.97, 0.88, 0.76, 0.64, 0.5];
    const base = rgbToOklch(col);
    let nearest = 0;
    lightness.forEach((l, i) => {
      if (Math.abs(l - base.l) < Math.abs(lightness[nearest] - base.l)) nearest = i;
    });
    const out = {};
    stops.forEach((stop, i) => {
      if (i === nearest) { out[stop] = toHex(col); return; }
      const k = chromaK[i] / chromaK[nearest];
      out[stop] = toHex(oklchToRgb({ l: lightness[i], c: base.c * Math.min(1.2, k), h: base.h }));
    });
    return out;
  }

  /**
   * paletteFromImageData(imageData | Uint8(Clamped)Array RGBA, k) → hex[] ordered by population.
   * k-means in OKLab on up to ~5000 sampled opaque pixels; deterministic (seeded).
   */
  function paletteFromImageData(imageData, k = 6) {
    const data = imageData && imageData.data ? imageData.data : imageData;
    if (!data || !data.length) return [];
    const totalPx = Math.floor(data.length / 4);
    const step = Math.max(1, Math.floor(totalPx / 5000));
    const samples = [];
    for (let p = 0; p < totalPx; p += step) {
      const o = p * 4;
      if (data[o + 3] < 128) continue;
      samples.push(rgbToOklab({ r: data[o], g: data[o + 1], b: data[o + 2] }));
    }
    if (!samples.length) return [];
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };
    const dist = (x, y) => (x.l - y.l) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2;
    const kk = Math.max(1, Math.min(k, samples.length));
    // k-means++ initialisation
    const centers = [samples[Math.floor(rand() * samples.length)]];
    const d2 = new Float64Array(samples.length);
    while (centers.length < kk) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        let best = Infinity;
        for (const c of centers) best = Math.min(best, dist(samples[i], c));
        d2[i] = best;
        sum += best;
      }
      if (sum <= 1e-12) break;
      let r = rand() * sum;
      let idx = 0;
      for (; idx < samples.length - 1; idx++) {
        r -= d2[idx];
        if (r <= 0) break;
      }
      centers.push(samples[idx]);
    }
    const assign = new Int32Array(samples.length);
    let counts = [];
    for (let iter = 0; iter < 16; iter++) {
      const sums = centers.map(() => ({ l: 0, a: 0, b: 0, n: 0 }));
      let moved = false;
      for (let i = 0; i < samples.length; i++) {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = dist(samples[i], centers[c]);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (assign[i] !== best) { assign[i] = best; moved = true; }
        const s = sums[best];
        s.l += samples[i].l; s.a += samples[i].a; s.b += samples[i].b; s.n++;
      }
      counts = sums.map((s) => s.n);
      sums.forEach((s, c) => { if (s.n) centers[c] = { l: s.l / s.n, a: s.a / s.n, b: s.b / s.n }; });
      if (!moved && iter > 0) break;
    }
    const seen = new Set();
    return centers
      .map((c, i) => ({ hex: toHex(oklabToRgb(c)), n: counts[i] || 0 }))
      .filter((x) => x.n > 0)
      .sort((x, y) => y.n - x.n)
      .map((x) => x.hex)
      .filter((hex) => (seen.has(hex) ? false : (seen.add(hex), true)));
  }

  return {
    parse, isColor, toHex, toRGBString,
    rgbToHsl, hslToRgb, rgbToOklab, oklabToRgb, rgbToOklch, oklchToRgb,
    mix, relativeLuminance, contrastRatio, isLargeText, ensureContrast,
    paletteFromImageData, shades, readableOn,
    NAMED_COLORS: NAMED
  };
});

# Advanced Page Builder 2 — Architecture & Module Contracts

This document is the **binding contract** between modules. Code must match the names, shapes and
behaviours described here. If an implementation needs something that is not here, add it in a
backwards-compatible way and document it in the "Contract additions" section at the bottom.

---

## 1. Goals and hard constraints

- **Zero runtime dependencies.** Vanilla JS (ES2022), HTML, CSS. No frameworks, no CDNs, no npm deps.
- **Single self-contained file.** `main.html` (build output) must open from `file://` with no network.
- **Dev without a build.** `src/index.html` loads classic `<script src>` / `<link>` files and must also
  work from `file://` (no ES modules — Chromium blocks module scripts on `file://`).
- **Build** = `node tools/build.mjs`: inlines every `<link rel="stylesheet">` and `<script src>` of
  `src/index.html` (in order) into `main.html`. Node ≥ 20, no dependencies.
- **Secure by default.** Every piece of untrusted content (imported files, pasted HTML, AI output,
  URLs, custom CSS) passes through `sanitize`. Never assign untrusted strings to `innerHTML`.
- **Accessible editor.** Keyboard operable, ARIA semantics, visible focus, `prefers-reduced-motion`,
  WCAG 2.2 AA contrast for the UI in light and dark themes.
- **Fast.** 60 fps drag with 500 nodes. Rendering batched per animation frame, incremental DOM updates.
- **Browser targets:** current Chromium, Firefox, Safari (2025+). Feature-detect anything newer and
  provide fallbacks (see `env.features`).

## 2. Repository layout

```
main.html                  BUILD OUTPUT — the app (commit it; users open this file)
index.html                 BUILD OUTPUT — tiny redirect to main.html (for GitHub Pages)
Beta.html                  legacy v1 experiment (untouched)
package.json               scripts only, no dependencies
src/index.html             dev entry + ordered manifest of all CSS/JS files
src/css/*.css              UI styles (prefix every class with apb-)
src/js/core/*.js           pure-ish core (no DOM at define time; most run in Node tests)
src/js/canvas/*.js         canvas: viewport, renderer, overlay, interaction, text editing
src/js/ui/*.js             shell, widgets, dialogs, command palette, icons
src/js/features/*.js       feature plugins (panels, storage, import/export, audit, AI, …)
src/js/app.js              bootstrap
tools/build.mjs            inliner → main.html + index.html
tools/dev-server.mjs       static file server for local testing (port 5173)
tests/run.mjs              unit test runner (node:test) — loads core modules into a vm context
tests/unit/*.test.mjs      unit tests
tests/e2e.mjs              headless Chrome/Edge smoke tests over CDP (zero-dep)
docs/                      ARCHITECTURE.md (this), PLUGINS.md, SHORTCUTS.md
```

## 3. Module system (`src/js/core/apb.js`)

Every JS file is a classic script that registers exactly one module (or one plugin) on the global
`APB` namespace. File order in `src/index.html` does not need to follow dependency order for
`define` (resolution is lazy), but `apb.js` must be first and `app.js` last.

```js
APB.define(name, deps, factory)   // deps: string[]; factory(...depApis) → api (object/function)
APB.require(name)                 // → api; instantiates lazily; throws on missing/circular deps
APB.has(name)                     // → boolean
APB.list()                        // → string[] of defined module names
APB.plugin(def)                   // register a feature plugin: { id, requires?: string[], order?: number, init(app) }
APB.plugins()                     // → plugin defs sorted by (order ?? 100), then registration order
APB.version                       // '2.0.0'
```

- Works in the browser (`window.APB`) and in Node `vm` contexts (`globalThis.APB`).
- Modules in `core/` except `sanitize`, `env` DOM probes must not touch `document`/`window` at factory
  time or in their pure functions. They are unit-tested in Node.
- Plugin `init(app)` runs after the shell and canvas are mounted. A plugin whose `requires` modules
  are missing is skipped with a console warning (the app must still start).

### Module name registry (exact)

| Name | File | Kind |
|---|---|---|
| `env` | core/env.js | feature detection, platform (mac/touch), reduced motion |
| `util` | core/util.js | ids, math, cloning, escaping, timing helpers |
| `events` | core/events.js | `Emitter` class |
| `color` | core/color.js | parse/format/convert colors, contrast, palettes |
| `geometry` | core/geometry.js | rects, rotation, resize math |
| `sanitize` | core/sanitize.js | HTML / URL / CSS sanitizers |
| `schema` | core/schema.js | document & node model, defaults, validation, traversal, breakpoint cascade |
| `store` | core/store.js | document state, transactions, undo/redo, selection, view, prefs |
| `commands` | core/commands.js | command registry + keymap |
| `elements` | core/elements.js | element type registry |
| `element-types` | core/element-types.js | core element type definitions (registers into `elements`) |
| `style` | core/style.js | node → CSS resolution (shared by renderer and exporters) |
| `vdom` | core/vdom.js | VNode → DOM / HTML string, full-tree builder (incl. instance expansion) |
| `snapping` | core/snapping.js | snap engine (pure) |
| `docops` | core/docops.js | high-level document operations |
| `actions` | core/actions.js | click/change node interactions: types, `normalize()`, the exported-page runtime |
| `viewport` | canvas/viewport.js | camera, zoom/pan, rulers |
| `renderer` | canvas/renderer.js | document → editor DOM |
| `overlay` | canvas/overlay.js | selection UI, guides, marquee, measurements |
| `interaction` | canvas/interaction.js | pointer/keyboard tools state machine |
| `textedit` | canvas/textedit.js | inline text editing |
| `canvas` | canvas/canvas.js | mount facade combining the above |
| `icons` | ui/icons.js | SVG icon set |
| `widgets` | ui/widgets.js | DOM helper + form controls |
| `dialogs` | ui/dialogs.js | dialog/confirm/prompt/toast/menu |
| `palette` | ui/palette.js | command palette |
| `shell` | ui/shell.js | app layout, toolbar, panels, status bar |
| `app` | app.js | bootstrap, creates the `app` object |
| feature modules | features/*.js | e.g. `exporters`, `importers`, `templates`, `element-types-extra` + plugins |

## 4. Coding conventions

- `'use strict'`, 2-space indent, semicolons, single quotes, camelCase, no globals except `APB`.
- DOM classes: `apb-` prefix for editor UI. Rendered document nodes: `apb-node`, `data-node-id`.
- CSS custom properties for the UI: `--apb-*`. Design tokens of the user's document: `--t-<id>`.
- Numbers in the model are CSS px (unitless numbers); angles in degrees; opacity 0–1.
- Never `alert/confirm/prompt`. Use `app.ui.toast/confirm/prompt`.
- Every user-visible action is a **command** (so it is in the palette, has a shortcut slot, and can be
  disabled when not applicable).
- Mutations **only** through `store.transact` (directly or via `docops`). Never mutate `store.doc`.

---

## 5. Document model (format `apb`, version 2)

```js
{
  format: 'apb', version: 2,
  id: 'doc_k3j9x0qa', name: 'Untitled site',
  createdAt: '2026-09-15T10:00:00.000Z', updatedAt: '…',
  settings: {
    lang: 'en',
    breakpoints: [                     // first = base (desktop-first cascade)
      { id: 'desktop', label: 'Desktop', width: 1440 },
      { id: 'tablet',  label: 'Tablet',  width: 768, max: 1023 },
      { id: 'mobile',  label: 'Mobile',  width: 390, max: 767 }
    ],
    globalCSS: '',                     // sanitized stylesheet, scoped to the page in the editor
    fonts: [],                         // e.g. [{ family: 'Inter', source: 'system'|'google', weights: [400,700] }]
    favicon: '',                       // asset id or URL
    export: {}                         // last used export options
  },
  tokens: {
    colors: [ { id: 'primary', name: 'Primary', value: '#2563eb' } ],
    text:   [ { id: 'h1', name: 'Heading 1', style: { fontSize: 56, fontWeight: 800, lineHeight: 1.1 } } ]
  },
  assets: { 'as_…': { id, name, kind: 'image'|'video'|'file', mime, src /* data: URL */, w, h, bytes } },
  components: { 'cp_…': { id, name, root: 'n_…' } },
  pages: [ { id: 'pg_…', name: 'Home', slug: 'index', root: 'n_…',
             seo: { title: '', description: '', ogImage: '', canonical: '', noindex: false } } ],
  nodes: { 'n_…': Node, … }            // flat map: all nodes of all pages and component masters
}
```

### 5.1 Node

```js
{
  id: 'n_ab12cd34',
  type: 'text',                 // registered element type
  name: 'Heading',              // layer name
  parent: 'n_…' | null,         // null only for page roots and component master roots
  children: ['n_…'],            // ONLY on container types (order = paint order, last on top)
  x: 0, y: 0, w: 320, h: 64, rotation: 0,   // relative to parent's padding box; ignored in stack parents (except w/h when sizing is fixed)
  locked: false, hidden: false,
  sizing: { w: 'fixed', h: 'fixed' },        // 'fixed' | 'fill' | 'hug'
  layout: null,                 // containers only: { mode: 'free'|'stack', dir: 'column'|'row', gap: 16,
                                //   pad: [top,right,bottom,left], align: 'start'|'center'|'end'|'stretch',
                                //   justify: 'start'|'center'|'end'|'between'|'around', wrap: false }
  style: {},                    // see 5.2 (only whitelisted keys)
  props: {},                    // type-specific content (see element types)
  bp: {},                       // breakpoint overrides: { tablet: Partial, mobile: Partial } (see 5.3)
  states: {},                   // { hover: { style: {} } }
  motion: null,                 // { preset, duration, delay, easing, trigger: 'enter'|'load' }
  attrs: {},                    // { htmlId, className, ariaLabel, role, title }
  css: ''                       // extra CSS declarations for this node (sanitized, no braces)
}
```

- ids: `n_` nodes, `pg_` pages, `cp_` components, `as_` assets, `doc_` documents (8 base36 chars).
- **Page root** type `page`: `layout = { mode: 'stack', dir: 'column', gap: 0, … }`, `props.minHeight`.
  Its width is the active breakpoint width in the editor and `100%` in exports.
- **Section** type `section`: `sizing.w = 'fill'`, default `layout.mode = 'free'`, `h = 640`.
- Free-layout containers cannot `hug` height (UI disables it). `group` bounds are recomputed by
  `docops` to wrap its children.
- Component instances: type `instance`, `props: { component: 'cp_…', overrides: { [masterNodeId]: { props: {…}, style: {…} } } }`.
  Instances have no `children`; the renderer expands the master subtree.

### 5.2 Style keys (whitelist, `schema.STYLE_KEYS`)

| key | type | CSS |
|---|---|---|
| `fill` | color \| gradient string \| `$tokenId` | `background` |
| `fillImage` | `{ asset?: id, src?: url, size: 'cover'\|'contain'\|'auto', position: 'center', repeat: false }` | `background-image/size/position/repeat` |
| `color` | color \| `$tokenId` | `color` |
| `textStyle` | token id | merges `tokens.text[id].style` under the node's own style |
| `fontFamily` `fontWeight` `fontStyle` `textAlign` `textDecoration` `textTransform` | string/number | same name |
| `fontSize` `letterSpacing` | number (px) | px |
| `lineHeight` | number (unitless) | unitless |
| `valign` | `'top'\|'middle'\|'bottom'` | text: flex column + justify-content |
| `padding` | `[t,r,b,l]` (leaf types) | `padding` |
| `borderWidth` | number | `border-width` (+ `border-style: solid` when > 0 and no style) |
| `borderStyle` `borderColor` | string | same |
| `radius` | number \| `[tl,tr,br,bl]` | `border-radius` |
| `shadow` `textShadow` | CSS shadow string (sanitized) | `box-shadow` / `text-shadow` |
| `opacity` | 0–1 | `opacity` |
| `blur` `backdropBlur` | number px | `filter: blur()` / `backdrop-filter: blur()` |
| `blend` | mix-blend-mode keyword | `mix-blend-mode` |
| `overflow` | `'visible'\|'hidden'\|'auto'` | `overflow` |
| `objectFit` `objectPosition` | string | same (images/video) |
| `stroke` `strokeWidth` | color / number | shapes |
| `cursor` | keyword | `cursor` |

A string value `$primary` references token `primary` → CSS `var(--t-primary)`.

### 5.3 Breakpoint cascade

- Keys allowed inside `bp[bpId]`: `x y w h rotation hidden sizing layout style props`
  (`props` overrides limited to text-like content keys declared by the element type as `bpProps`).
- **Effective node** at breakpoint *k* = base ⊕ `bp[b1]` ⊕ … ⊕ `bp[bk]` (in `settings.breakpoints`
  order, skipping the base). Objects (`style`, `layout`, `sizing`, `props`) merge one level deep.
- In the editor, edits made while a non-base breakpoint is active write to `bp[active]`.
- Export: base CSS + `@media (max-width: {max}px)` rules containing only changed declarations.

### 5.4 Element type definition (`elements.register`)

```js
elements.register({
  type: 'button', label: 'Button', icon: 'button', category: 'basic',   // basic|text|media|layout|form|advanced
  container: false,
  accepts: null,                       // containers: (childType) => boolean
  caps: { fill: true, border: true, radius: true, shadow: true, text: true, padding: true, effects: true },
  bpProps: ['text'],                   // props keys that may be overridden per breakpoint
  textEdit: 'text',                    // props key edited inline on double-click, or null
  defaults() { return { name: 'Button', w: 160, h: 48, style: {…}, props: { text: 'Get started', href: '' } }; },
  vnode(node, ctx) { return { tag: node.props.href ? 'a' : 'button', attrs: {…}, text: node.props.text }; },
  inspector: [ { title: 'Content', fields: [ { key: 'props.text', label: 'Label', type: 'text' },
                                           { key: 'props.href', label: 'Link', type: 'url' } ] } ],
  audit(node, ctx) { return []; }      // optional extra checks
});
```

**VNode** (plain objects, shared by editor renderer and exporters):

```js
{ tag: 'a', attrs: { href: 'https://…' }, style: { /* camelCase extra CSS */ },
  text: 'plain text'          // XOR html XOR children
  html: '<b>sanitized</b>',   // must already be sanitized by the type via ctx.sanitizeHTML
  children: [VNode],
  slot: true }                // containers: the element that receives child node elements
```

`ctx` = `{ mode: 'editor'|'export', doc, bp, effective /* node after cascade */, assetURL(id),
           resolveURL(url, kind), sanitizeHTML(html, profile), escape, icon(name) }`.
The renderer/exporter adds `class`, `data-node-id` (editor), and the resolved box/visual CSS to the
**root** VNode of each node. Types never position themselves.

Field `type`s for inspector specs: `text textarea number url select toggle color asset icon list table code`.

---

## 6. Core APIs

### 6.1 `util`
`uid(prefix)`, `clamp(v,min,max)`, `round(v, step=1)`, `lerp`, `deepClone`, `deepEqual`, `deepMerge(a,b)` (1-level for plain objects, arrays replaced),
`getPath(obj, path)`, `setPathImmutable(obj, path, value)` (copy-on-write; `undefined` deletes), `debounce(fn, ms)`, `throttle(fn, ms)`,
`rafBatch(fn)` (coalesce calls to one per frame; Node: microtask), `escapeHTML`, `escapeAttr`, `slugify`, `formatBytes`, `plural(n, word)`,
`isPlainObject`, `pick`, `omit`, `groupBy`, `fuzzyScore(query, text)` (for palette/search), `nextName(base, existingNames)`.

### 6.2 `events`
`new Emitter()` with `on(evt, fn) → off()`, `once`, `off(evt, fn)`, `emit(evt, payload)`. Listener errors are caught and reported via `console.error`, never break emitters.

### 6.3 `color`
`parse(str) → {r,g,b,a} | null` (hex 3/4/6/8, rgb(a), hsl(a), named basics, `transparent`), `toHex(c, withAlpha)`, `toRGBString(c)`,
`rgbToHsl/hslToRgb`, `rgbToOklch/oklchToRgb`, `mix(a,b,t)`, `relativeLuminance(c)`, `contrastRatio(fg, bg)` (WCAG 2.x; composites alpha over bg),
`isLargeText(fontSizePx, fontWeight)` (≥24px, or ≥18.66px and weight ≥700), `ensureContrast(fg, bg, target=4.5) → hex` (adjust OKLCH lightness minimally),
`paletteFromImageData(data, k=6)` (k-means in OKLab), `shades(hex)` (50–950 scale), `readableOn(bg) → '#000'|'#fff'`.

### 6.4 `geometry`
Rect `{x,y,w,h}`. `rotatePoint(p, center, deg)`, `corners(rect, deg)`, `aabb(points|rects)`, `union(rects)`, `intersects(a,b)`, `contains(a,b)`,
`pointInRect(p, rect, deg)`, `center(rect)`, `resize(rect, handle, delta, { rotation, keepAspect, fromCenter, minW=1, minH=1 }) → rect`
(handles: `n s e w ne nw se sw`; the opposite corner/edge stays fixed in world space for rotated rects), `angleFrom(center, point)`,
`snapAngle(deg, step)`, `scaleRectsInBounds(rects, fromBounds, toBounds)`.

### 6.5 `sanitize` (browser; Node fallback = escape-everything)
- `html(str, profile)` — profiles: `inline` (b strong i em u s mark small sub sup code br span a), `rich` (inline + p h1–h6 ul ol li blockquote pre hr figure figcaption table thead tbody tr th td img),
  `html` (rich + div section article header footer nav aside main details summary label button input select option textarea form fieldset legend; plus `style` attribute through `css()`).
  Always removes: `script style iframe object embed link meta base svg math template noscript`, every `on*` attribute, `srcdoc`, `formaction`, `action`,
  `xlink:*`, and URL attributes failing `url()`. Adds `rel="noopener noreferrer"` to `target="_blank"`. Uses the native Sanitizer API
  (`Element.prototype.setHTML` with an explicit config) when available, then **always** runs the allowlist walker (defence in depth). Parsing uses an inert `DOMParser` document.
- `url(str, kind)` — `link`: http(s), mailto, tel, relative, `#hash`; `image`: http(s), relative, `blob:`, `data:image/(png|jpeg|gif|webp|avif|bmp)` (never svg data); `media`: http(s), relative, blob;
  `embed`: https only, host allowlist (youtube.com/youtu.be→youtube-nocookie.com/embed, vimeo→player.vimeo.com, google.com/maps, open.spotify.com/embed, codepen.io, loom.com/embed, figma.com/embed); returns normalized URL or `''`.
- `css(declarations)` — sanitize a declaration list (no braces/`@`/`<`, no `expression(`, `javascript:`, `behavior`, `-moz-binding`, `url()` only via `url(…, 'image')`); max 5 000 chars.
- `stylesheet(css)` — for global CSS: strips `@import`, `@charset`, `</style`, `javascript:`, `expression(`; returns text.
- `id(str)`, `className(str)` — valid tokens only.

### 6.6 `schema`
`VERSION=2`, `STYLE_KEYS`, `BP_KEYS`, `NODE_KEYS`, `createDocument({ name, pageName }) → doc` (one page root + one empty free section 1440×900),
`createNode(type, init) → node` (merges `elements` defaults when the type is registered), `createPage(doc, name) → {page, root}`,
`normalizeDocument(doc) → { doc, warnings }` (repairs parent/children links, removes dangling refs, fills defaults),
`validateDocument(doc) → { ok, errors }`, `effectiveNode(doc, node, bpId)`, `isContainer(type|node)`, `walk(doc, rootId, fn(node, depth))`,
`ancestors(doc, id)`, `descendants(doc, id)`, `pageOf(doc, id) → page`, `rootOf(doc, id)`, `indexInParent(doc, id)`, `bpIndex(doc, bpId)`,
`reid(nodesMap, rootIds) → { nodes, idMap }` (deep re-id for duplicate/paste/component instantiation).

### 6.7 `store`
```js
const store = APB.require('store').create(doc);
store.doc                                  // current immutable doc
store.node(id)                             // shortcut
store.transact(label, (tx) => { … }, { coalesce?: string, select?: string[], silent?: false }) → return value of fn
  tx.get(path)                             // reads the in-transaction state
  tx.set(path, value)                      // copy-on-write; undefined deletes
  tx.createNode(nodeInit, parentId, index?) → id      // uses schema.createNode; appends/inserts into parent.children
  tx.removeNode(id)                         // recursive; also drops from selection
  tx.moveNode(id, parentId, index)
  tx.updateNode(id, patch, { bp? })         // patch keys from NODE_KEYS; style/props/layout/sizing/attrs merge 1 level; bp → writes bp[bp]
  tx.setDocField(path, value)               // settings/tokens/pages/assets/components
store.undo() / store.redo() / store.canUndo() / store.canRedo()
store.history()                            // { entries: [{ label, time }], index }
store.jump(index); store.clearHistory()
store.replaceDoc(doc, { label })           // load/replace (clears history)
store.selection                            // string[]
store.select(ids, mode = 'replace')        // 'replace'|'add'|'toggle'|'remove'
store.view                                 // { pageId, bp, zoom, x, y, tool, context: containerId|null, hover: id|null, editingText: id|null }
store.setView(patch)
store.prefs                                // persisted UI prefs (see 6.7.1)
store.setPrefs(patch)
store.on('change'|'selection'|'view'|'prefs'|'history', fn) → off
```
- `change` payload: `{ label, source: 'user'|'undo'|'redo'|'replace', ops, nodes: Set<id>, structure: boolean, global: boolean }`
  (`structure` = parent/children changed; `global` = settings/tokens/pages/components/assets changed).
- History entry: `{ label, ops: [{path, value}], inverse: [{path, value}], selBefore, selAfter, time, coalesce }`.
  Consecutive transactions with the same `coalesce` key within 1 500 ms merge into one entry. Cap: 500 entries.
- Undo/redo restore `selAfter`/`selBefore`. `updatedAt` is set on every user change (not part of history ops).

#### 6.7.1 Prefs (persisted in `localStorage['apb.v2.prefs']` by the storage plugin; defaults in store)
`{ theme: 'system', snap: { objects: true, grid: false, gridSize: 8, rotationStep: 15, threshold: 6 }, showGrid: false, showRulers: true,
   leftWidth: 280, rightWidth: 300, leftTab: 'layers', rightTab: 'design', recentColors: [], ai: { provider: 'local', model: 'claude-opus-5', effort: 'medium', rememberKey: false } }`

### 6.8 `commands`
```js
commands.register({ id: 'edit.undo', title: 'Undo', category: 'Edit', icon: 'undo', keys: ['Mod+Z'],
                    when: (app) => app.store.canUndo(), run: (app, args) => app.store.undo(),
                    palette: true, allowInInputs: false, allowInDialog: false })
commands.run(id, args) → result | undefined (no-op when `when` is false)
commands.get(id), commands.list(), commands.enabled(id), commands.keysFor(id) → string[]
commands.formatKeys('Mod+Shift+G') → '⌘⇧G' (mac) | 'Ctrl+Shift+G'
commands.attach(target = document)   // installs the keydown dispatcher
```
Key syntax: modifiers `Mod` (Cmd on mac, Ctrl elsewhere), `Ctrl`, `Alt`, `Shift`, then `A–Z`, `0–9`, `ArrowUp`, `Delete`, `Backspace`, `Enter`, `Escape`, `Tab`, `Space`, `[`, `]`, `=`, `-`, `/`, `?`, `\`.
Letters/digits match via `event.code` (layout- and CapsLock-independent). The dispatcher ignores events from editable targets unless `allowInInputs`, and ignores events while a modal dialog is open unless `allowInDialog`.

### 6.9 `style`
```js
style.effective(doc, idOrNode, bpId)                 // = schema.effectiveNode
style.nodeDecls(doc, node, bpId, { mode, parentEff }) → Map<kebab-prop, value>   // box + layout + visual + node.css
style.boxDecls(eff, parentEff, { mode, bp })          // positioning & sizing (see below)
style.layoutDecls(eff)                                // stack → display:flex etc.
style.visualDecls(eff, doc, { mode })                 // from STYLE_KEYS (tokens → var(--t-id); textStyle merged)
style.hoverDecls(eff, doc)                            // from states.hover.style
style.tokensCSS(doc) → ':root{--t-primary:#2563eb;…}'
style.declsToString(map) / style.diffDecls(baseMap, map) → Map of changed/added (removed → 'initial'/'unset' as appropriate)
```
Box rules: free parent → `position:absolute; left; top; width (fill → left:0;width:100%); height (hug → auto)`, `transform: rotate()`.
Stack parent → `position:relative; flex-shrink:0`; fixed → px; fill → main axis `flex:1 1 0; min-width/min-height:0`, cross axis `align-self:stretch`; hug → `auto`.
Page root (editor) → `width: bp.width px; min-height: minHeight px`; (export) → `width:100%; min-height:100vh`.
Hidden → `display:none` (editor shows hidden nodes only when selected via layers, dimmed through a class the renderer adds).

### 6.9.1 `vdom`
```js
vdom.toDOM(vnode, { onElement(el, vnode) }) → Element          // browser only; text via textContent, html via sanitized string only
vdom.toHTML(vnode, { indent = 2, pretty = true }) → string      // escapes text and attribute values; void elements handled
vdom.patch(el, vnode) → Element                                  // updates attrs/style/text in place when tag matches, else replaces
vdom.buildTree(doc, rootId, { bp, mode, classFor(node) → string, withIds, includeHidden, sanitizeHTML, assetURL }) → vnode
  // Recursively: elements.get(type).vnode(node, ctx) + style decls (editor: inline style; export: classFor) + children into slot.
  // Instances expand their component master subtree with overrides applied (ids become `${instanceId}:${masterId}`).
```

### 6.10 `snapping` (pure)
`snapMove({ rect, others: rects[], parent: rect, grid, gridSize, threshold })` → `{ dx, dy, guides: [{ axis:'x'|'y', pos, from, to, kind:'edge'|'center'|'grid'|'parent' }], spacing: [{ axis, a, b, gap }] }`
Snaps left/center/right and top/middle/bottom edges to siblings, parent edges/center, equal gaps between siblings, and grid. `threshold` is in document px (caller divides screen px by zoom).
`snapResize({ rect, handle, others, parent, grid, gridSize, threshold })` → `{ rect, guides }`.

### 6.11 `docops` (all take `app` or `store` as first arg; each is one undoable transaction)
```js
insert(store, specs, { parent, index, at: {x,y}, select = true, label }) → ids   // spec = { type, …node fields, children: [spec] }
remove(store, ids)                         duplicate(store, ids, { offset = 16 }) → ids
move(store, ids, dx, dy, { coalesce })     setBox(store, id, { x,y,w,h,rotation }, { bp, coalesce })
update(store, ids, patch, { bp, coalesce, label })     // generic field/style/props patch
reparent(store, ids, parentId, index)      // keeps visual position (converts coordinates)
group(store, ids) → id                     ungroup(store, id) → ids (applies group offset/rotation/opacity)
wrap(store, ids, { layout }) → id          // wrap in frame (stack or free)
align(store, ids, 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom', { to: 'selection'|'parent' })
distribute(store, ids, 'h'|'v', { mode: 'gap'|'center' })
tidy(store, ids, { gap })                  radial(store, ids, { radius, startAngle, sweep = 360, cx, cy, rotateItems })
matchSize(store, ids, { w, h })            zorder(store, ids, 'forward'|'backward'|'front'|'back')
setLocked(store, ids, bool)                setHidden(store, ids, bool)
fitGroup(store, groupId)                   makeResponsive(store, pageId, bpId)   // heuristic overrides: stack free children by reading order, scale widths
createComponent(store, ids) → componentId  instantiate(store, componentId, { parent, at }) → id   detach(store, instanceId) → ids
```
Locked nodes are skipped by move/align/distribute/resize/tidy/radial/matchSize; delete is allowed.

---

## 7. Canvas contract

```js
const canvas = APB.require('canvas').mount(hostElement, app);
canvas.renderer                // { el(id), worldRect(id) → {x,y,w,h} page coords, nodeAt(clientX, clientY, { deep }) → id|null, renderAll() }
canvas.viewport                // { zoom, x, y, setZoom(z, { clientX, clientY }), zoomIn(), zoomOut(), zoomTo100(), fit(), zoomToSelection(),
                               //   screenToPage(clientX, clientY) → {x,y}, pageToScreen(x,y), scrollToNode(id) }
canvas.overlay.refresh()
canvas.setTool('select'|'hand'|'frame'|'section'|'text'|'rect'|'ellipse'|'line'|'image')
canvas.insertAtViewportCenter(specs) → ids       // used by the Insert panel / palette
canvas.startTextEdit(id)
canvas.destroy()
```
DOM: `host > .apb-viewport[tabindex=0][role=application][aria-roledescription="design canvas"] > (.apb-rulers, .apb-world[style=transform] > .apb-artboard > page root node element, svg.apb-overlay)`.
User global CSS is injected as `<style id="apb-user-css">@scope (.apb-artboard) { … }</style>`.
Content pointer events: `.apb-artboard *{pointer-events:none}` `.apb-artboard .apb-node{pointer-events:auto}`; links/buttons/forms never activate in the editor.

Interaction rules (summary; details in the canvas plan):
- Click selects the deepest node, except nodes inside a `group`/`instance` select the outermost group/instance; double-click enters groups / edits text. `Mod`+click = deep select. Shift+click toggles.
- Drag on an unselected container's empty area = marquee inside that container; drag on a selected node = move. Alt+drag duplicates. Dropping over another container reparents (container highlight).
- Stack parents: drag reorders with an insertion indicator.
- 8 resize handles + rotation zones outside corners; Shift keeps aspect ratio (default for images), Alt resizes from center; multi-selection transforms the bounding box.
- Snapping with guides and spacing labels (`prefs.snap`); holding `Mod` while dragging temporarily disables snapping.
- Wheel pans; `Mod`+wheel / pinch zooms around the pointer; Space/middle-drag pans; touch: one finger = tool, two fingers = pan/zoom.
- Keyboard: arrows nudge 1 px (Shift 10 px, coalesced), Enter selects first child / edits text, Shift+Enter or Esc selects parent, Tab/Shift+Tab cycles siblings.

## 8. Shell contract (`app.ui`)

```js
app.ui.registerPanel({ id, side: 'left'|'right', title, icon, order, badge?: () => string|number,
                       mount(container, app) → { update?(), destroy?() } })
app.ui.showPanel(id)
app.ui.registerToolbarItem({ id, area: 'start'|'center'|'end', order, render(app) → HTMLElement })
app.ui.registerStatusItem({ id, side: 'start'|'end', order, render(app) → HTMLElement })
app.ui.registerMenuItem({ menu: 'file'|'edit'|'view'|'insert'|'arrange'|'help', command: 'id' | { label, run }, order, separatorBefore })
app.ui.registerInspectorSection({ id, order, title, applies(nodes, app) → boolean, mount(container, app) → { update(nodes) } })  // used by the inspector plugin
app.ui.toast(message, { kind: 'info'|'success'|'warn'|'error', action?: { label, run }, timeout = 4000 })
app.ui.confirm({ title, message, confirmLabel = 'OK', danger = false }) → Promise<boolean>
app.ui.prompt({ title, label, value, placeholder, validate }) → Promise<string|null>
app.ui.dialog({ title, content: HTMLElement, actions: [{ label, kind, run(close) }], wide }) → { close(), el }
app.ui.menu(anchorOrEvent, items)          // items: { label, icon, shortcut, disabled, checked, danger, run, submenu, separator }
app.ui.announce(message)                    // aria-live polite
app.ui.canvasHost                           // element the canvas mounts into
```
Layout: toolbar (top) · left panel (Layers | Insert | Pages | Assets) · canvas · right panel (Design | Interact | Audit | AI) · status bar.
Panels are resizable (prefs), collapsible (`Mod+\`), and become drawers under 900 px width.

## 9. The `app` object

```js
app = { version, env, util, store, commands, elements, docops, schema, style, sanitize,
        ui, canvas, services: {}, emitter, on(evt, fn), emit(evt, payload), log(msg, { level, data }), logs() }
```
Events: `ready`, `project:loaded` `{ doc }`, `project:saved` `{ doc }`, `log` `{ entry }`.
Services attached by plugins: `services.storage`, `services.importers`, `services.exporters`, `services.preview`, `services.ai`, `services.audit`, `services.assets`, `services.clipboard`.
`window.APB.app` exposes the app for debugging and e2e tests.

## 10. Persistence

- IndexedDB database `apb` (v1): stores `projects` (key `id`: `{ id, name, updatedAt, thumb, doc }`), `versions` (auto key, index `projectId`), `kv`.
  Fallback: `localStorage` (warn about size). Autosave debounce 800 ms + on `pagehide`/`visibilitychange`.
- Last opened project id: `localStorage['apb.v2.last']`. Prefs: `localStorage['apb.v2.prefs']`.
- v1 data (`ultimateBuilderPlusLayout`, `ultimateBuilderLayout`) is offered for import on first run and never deleted.
- Project files: `<name>.apb.json` (the document as-is).

## 11. Export

`services.exporters`:
```js
html(doc, { pageId, minify=false, inlineAssets=true, includeHidden=false, freeform='scale'|'center', motion=true, sourceComment=true }) → { html, css, files }
site(doc, opts) → files [{ path, data: string|Uint8Array, mime }]   // index.html, <slug>.html, assets/*
zip(files) → Blob                                                    // STORE method + CRC-32, zero-dep
jsx(doc, { pageId }) → string                                        // React component + CSS string
json(doc) → string
```
Generated pages: semantic tags from node props, class-based CSS (`.n-<shortid>`), tokens as custom properties, breakpoint media queries,
hover rules, motion via CSS `@keyframes` + scroll-driven `animation-timeline: view()` with an IntersectionObserver fallback script only when motion is used,
`@media (prefers-reduced-motion: reduce)` disables motion, SEO/OG meta, `lang`, CSP + referrer meta, `loading="lazy"` + width/height on images,
sandboxed `iframe` embeds with `title`, no editor artefacts.

## 12. Testing

- `node tests/run.mjs` — unit tests for `util color geometry schema store commands(elements) style snapping docops exporters(pure parts)`.
- `node tests/e2e.mjs [--browser path]` — builds, launches headless Chrome/Edge with `--remote-debugging-port`, opens `file:///…/main.html`,
  runs scenarios through `window.APB.app`, fails on uncaught errors/console errors, saves screenshots to `tests/artifacts/` (gitignored).

---

## Contract additions

_(Implementers: append dated entries here when you extend a contract.)_

### 2026-09-15 — A2 `snapping` (§6.10)
- Guide geometry: `axis:'x'` = vertical line at x=`pos` spanning y∈[`from`,`to`]; `axis:'y'` = horizontal line. Guides at the same
  position/kind are merged and span the moving rect plus every matched rect (parent guides span the parent).
- Spacing entries: `{ axis, a, b, gap, from, to, pos }` — `a`/`b` are the rects bounding the gap (a before b along `axis`),
  `from`/`to` the gap interval along `axis`, `pos` the cross-axis coordinate for the label.
- Extra options: `objects` (default true; false = grid only, maps to `prefs.snap.objects`), `gridOrigin: {x,y}` (default 0,0),
  `snapResize` also accepts `keepAspect`, `fromCenter`, `minW`, `minH`. Results include `snapped: { x: kind|null, y: kind|null }`.
- `snapping.createIndex({ others, parent })` → pass as `index` (instead of `others`/`parent`) to reuse sorted candidates across drag frames.
- `snapping.snapPoint({ point, others, parent, grid, gridSize, threshold })` → `{ x, y, guides }` for drawing tools.
- Tie-break when candidates are equally close: sibling edge/center > parent > equal spacing > grid.

### 2026-09-15 — A2 `docops` (§6.11)
- Breakpoint default: geometric/visibility writes (`move setBox update align distribute tidy radial matchSize setHidden fitGroup`)
  target `opts.bp` when given, else `store.view.bp` (base bp → base values). Structural ops (`insert remove duplicate reparent group
  ungroup wrap createComponent instantiate detach`) use base values.
- Positional ops skip locked nodes (a node is locked when it or any ancestor has `locked`) and children of stack parents (x/y ignored).
  `update` is not blocked by locks (inspector edits). Moving/resizing children of a `group` refits the group in the same transaction;
  resizing a group scales its children. Removing/reparenting the last child of a group removes the empty group.
- `move(…, dx, dy)` deltas are world (page) px; they are converted into each parent's local frame (rotated parents supported).
- `insert` extra opts: `anchor: 'topleft'|'center'` for `at` (at = union bounds of the top-level specs in parent coordinates).
  Default parent: sections → current page root; others → `view.context`, else the page's first section, else the page root.
- `update` accepts dotted keys (`'style.fill'`, `'props.text'`, deeper paths merge into the current value); `id parent children type` are ignored.
- `ungroup(store, id | ids)` works on any container except `page`/`section`. `wrap` default layout is `'free'`; `layout` may be
  `'free'|'stack'|{ mode, dir, gap, … }` (stack: direction/gap detected when omitted, `sizing: hug`). Wrapper frames/groups get `style: {}`.
- `align(…, { to })` defaults to `'parent'` for a single node, `'selection'` otherwise (locked nodes still count for the bounds).
  `distribute` needs ≥ 3 movable nodes. `tidy(…, { gap = 16, gapX, gapY, columns })`. `matchSize` `w/h: true` = largest selected.
- `radial(…, { radius = max(bounds.w,bounds.h)/2, startAngle = -90, sweep = 360, cx, cy, rotateItems })`: angles clockwise from +x;
  items in the order given; `cx/cy` in the first item's parent coordinates (default selection center); `rotateItems: true|'tangent'`
  → rotation = angle + 90, `'radial'` → rotation = angle. Full circle spacing = sweep/n, partial = sweep/(n−1).
- `makeResponsive(store, pageId, bpId, { pad, gap })` → number of nodes overridden; no-op (0) for the base breakpoint.
  pad = 16 (width < 600 or id `mobile`) else 24; gap 16; fontSize ≥ 40 × 0.7 (mobile) / × 0.85; free containers that shrink are
  scaled uniformly (descendant fonts not below 12px); text-like nodes grow in height; rotated children reset to 0; stack children wider
  than the available width get `w` clamped; row stacks → column on mobile.
- Components: `createComponent(store, ids, { name })` — a single container selection becomes the master root itself (box keys move to
  the instance), otherwise a free `frame` master root wraps the copies. `instantiate(store, id, { parent, at, index, select })` centers in a
  free parent when `at` is omitted. `detach` merges `overrides[masterId]` (`style props layout sizing attrs`, plus `hidden`/`name`) into the
  re-id'd copies and applies the instance's box/style/attrs/motion/bp to the new root; returns `[newRootId]`.
- Helpers: `docops.worldBox(doc, id, { bp })` → `{ cx, cy, w, h, rotation }`, `docops.worldBounds(doc, id, { bp })` → AABB,
  `docops.toLocal(doc, parentId, worldBox)` → `{ x, y, w, h, rotation }`, `docops.topLevel(doc, ids)`, `docops.sortDocOrder(doc, ids)`,
  `docops.isLocked(doc, id)`. Stack children are placed by an approximate flow layout (pad/gap/align/justify/fill) unless the first
  argument is an `app` whose `canvas.renderer.worldRect(id)` is available and the document is unchanged.

### 2026-09-15 — A2 `elements` / `element-types` (§5.4)
- Registry API: `register(def) → frozen normalized def` (throws `TypeError` on invalid defs; an existing type throws unless
  `def.replace === true`), `unregister(type)`, `get(type) → def|null`, `has(type)`, `list({ category, insertable })`, `types()`,
  `canContain(parentType, childType)` (container + `accepts`; `page` never nests), `styleOmit(typeOrDef, eff) → string[]`,
  constants `CATEGORIES`, `DEFAULT_CAPS`, `FIELD_TYPES`.
- Normalized def fields: `type label icon(=type) category(='basic') container accepts(fn|null) caps bpProps(frozen []) textEdit(null)
  defaults vnode inspector audit(fn|null) insertable(=true)`; unknown extra fields are preserved (e.g. `core: true` on core types).
- `DEFAULT_CAPS = { fill, border, radius, shadow: true, text: false, padding: false, effects: true, stroke: false, image: false,
  layout: <container> }`; `def.caps` merges over it.
- Optional `styleOmit: string[] | (eff) => string[]` — STYLE_KEYS the style module must not emit for that node (e.g. SVG shapes paint
  `fill` themselves; groups/spacers/instances have no visual caps).
- Optional `insertable: false` hides a type from insert UIs (`page`, `group`, `instance`).
- Inspector field specs: `{ key, label, type, options?: [{value,label}] | 'components', min, max, step, placeholder, accept, language,
  when?: (node) => boolean }`.
- The core types (`element-types`) are loaded lazily by the registry on the first `get/has/list/types` call, so
  `schema.createNode()` always sees them (no explicit `APB.require('element-types')` needed).
- VNode functions receive the *effective* node as `node` (same object as `ctx.effective`); ctx additionally carries `node` (raw
  node), `breakpoint` (bp object), `cssValue(v)` (token-resolved sanitized CSS value), `virtual` (inside an instance expansion),
  `withIds`, `includeHidden`, `classFor`. In `editor` mode link types emit `data-href` instead of `href`; buttons get `tabindex=-1`.
- `VNode.style` returned by types = type-intrinsic CSS only (resets such as `margin:0`, button centering, SVG `fill`/`stroke`); the
  renderer/exporter merges it into the node's declarations (see `style.nodeDecls({ extra })`); exporters put it into the class rule.
- `image` without a source renders `element-types.PLACEHOLDER_IMAGE` (inline SVG data URI) with `data-placeholder=""`. Its `audit`
  returns `[{ rule: 'img-alt', severity: 'error', message }]` for non-decorative images without alt.
- `text.props` also has `href`, `target` (a link wraps the content in an inner `<a>`); `frame.props.target`; `table.props.caption`.
  bpProps: text `['text','html']`, button `['text']`, list `['items']`, table `['rows','caption']`.
- `element-types` exports `{ TYPES, PLACEHOLDER_IMAGE, TEXT_TAGS, SECTION_TAGS, FRAME_TAGS, SHAPES, shapePoints(shape, props) }`.

### 2026-09-15 — A2 `style` (§6.9)
- Declaration order is deterministic: box → layout → type extras → visual (fixed STYLE_KEYS order) → `node.css` (via `sanitize.css`)
  → `display:none` when hidden (always last, wins over everything).
- `nodeDecls(doc, node, bpId, { mode, parentEff, bp, extra, assetURL, effective, box = true })`: `parentEff` defaults to the effective
  parent (`null` = root); `bp` = breakpoint object (defaults from `bpId`); `extra` = VNode.style (camelCase or kebab keys);
  `effective: true` skips the cascade; `box: false` omits position/size.
- Background uses longhands only (`background-color` for colors, `background-image` for gradients and `fillImage`, layered as
  `url("…"), <gradient>` when both), so breakpoint diffs never reset each other. `fillImage.asset` resolves through
  `opts.assetURL(id)` or `doc.assets[id].src`; every URL passes `sanitize.url(…, 'image')`.
- Tokens: `$id` is replaced anywhere inside color/gradient/shadow strings. Keyword properties use allowlists; free-form values pass
  `style.safeValue` (fast allowlist, else `sanitize.css`). `style.padding` and `valign` apply to leaf nodes only; containers pad
  through `layout.pad` (stack layouts only). Opacity is emitted only when < 1; `backdropBlur` also emits the `-webkit-` prefix.
  `stroke`/`strokeWidth` are painted by the `shape` vnode, not by style. Own style keys win over the `textStyle` token, so applying
  a text style should remove overlapping own keys (e.g. the text default `fontSize: 18`).
- Stack children: `hug` on the cross axis of a parent with `align:'stretch'` → `width|height: fit-content` (auto would stretch).
- `hoverDecls(eff, doc)` also accepts `states.hover.style.transform` (sanitized), prefixed with the node rotation when rotated.
- `tokensCSS(doc)` returns `''` when there are no (valid) color tokens.
- `diffDecls(base, next)` emits removed properties first (`display → revert`, inherited properties → `unset`, others → `initial`),
  then changed/added ones in `next` order.
- Extra helpers: `declsToObject(map, { camel = true })`, `parseDecls(cssText) → Map`, `extraDecls(obj) → Map`, `cssValue(v)`,
  `safeValue(v)`, `resolveTokens(v)`, `px(n)` (0 → `'0'`), `fmt(n)`, `boxValue(v)`, `resolvedStyle(eff, doc)`,
  `breakpoint(doc, bpId) → bp object`, `resetValue(prop)`.
- Exporter `freeform: 'scale'` helpers: `designUnitVars(designWidth, { name = '--u' })` → Map `container-type: inline-size;
  --u: min(1px, calc(100cqw / W))` for the scaling container (unregistered custom properties resolve `cqw` at the use site, i.e.
  against that container); `designUnitDecls(decls, { designWidth, unit = 'var(--u)', centerLeft })` → new Map where px lengths of
  `left top right bottom width height min-/max-width/height font-size letter-spacing gap padding border-width border-radius
  flex-basis` become `calc(N * var(--u))`; with `centerLeft` a px `left` becomes `calc(max(0px, (100cqw - Wpx) / 2) + N * var(--u))`.

### 2026-09-15 — A2 `vdom` (§6.9.1)
- `buildTree(doc, rootId, opts)` options: `bp` (id, default base), `mode` (`'export'` default | `'editor'`), `classFor(effNode)`,
  `withIds` (default: editor), `includeHidden` (hidden nodes rendered with `display:none`), `inlineStyles` (default: editor, or
  export without `classFor`), `sanitizeHTML`, `assetURL` (default: `doc.assets[id].src` sanitized), `resolveURL` (default
  `sanitize.url`), `icon`, `parentEff` (default: effective parent of the root; pass `null` to render a subtree as a standalone
  root), and `onNode({ id, node /* effective */, parentEff, vnode, decls, virtual, bp })`, called for every emitted node (children
  before parents) — exporters collect class CSS from `decls` (this includes the virtual nodes of instance expansions).
- Editor mode adds class `apb-node`; both modes map `attrs.htmlId → id` (`sanitize.id`), `className` (`sanitize.className`),
  `ariaLabel`, `role`, `title`. Inline styles are camelCase objects (custom properties keep their names).
- The element that receives node children keeps `slot: true` in the output (toHTML pretty-prints slot children one per line;
  inline content such as `p > a` is never re-indented).
- Instance expansion: the expanded root takes the **instance id** (and the instance's `name x y w h rotation hidden locked sizing
  parent`, merged `style`/`attrs`, `motion`, `states`, appended `css`) plus the master root's type/layout/visuals and
  `instance: { id, component, master }`; inner nodes get `${instanceId}:${masterId}` (nested: `outer:inner:master`).
  Overrides `{ [masterId]: { props, style, sizing, attrs, layout, hidden, name } }` apply after the breakpoint cascade of the
  master node. Missing or cyclic components render `<div data-component-missing="">`.
- `vdom.instanceVNode(doc, instanceNode, ctx)` → expansion whose root is undecorated and carries only its non-box declarations in
  `style` (used by `instance.vnode`, so the renderer can treat instances like any other type), or `null`.
- `vdom.expandInstance(doc, instance|id, { bp }) → { root, component, nodes: { [id]: effectiveNode } } | null` (one level; nested
  instances stay `instance` nodes).
- `toHTML(vnode | vnode[], { indent, pretty })` safety net: invalid or dangerous tags (`script style base meta link noscript template
  object embed applet frame frameset foreignObject use animate set …`) render as `div` (`g` inside svg); `on*`, `srcdoc` and `is`
  attributes are dropped; URL attributes with `javascript:`/`vbscript:` or non-image `data:` are dropped (`data:image/svg+xml` only
  on `img[src]`); `attrs.style` strings pass `sanitize.css`; `style` object values pass `style.safeValue`; `true` → boolean
  attribute, `false/null/undefined` → omitted, arrays are joined with spaces. `html` is inserted as-is (types must sanitize).
- `toDOM(vnode, { onElement, document, svg })` / `patch(el, vnode, { onElement, keepAttrs })` return `null` without a DOM; they
  always re-sanitize `vnode.html` with `sanitize.html(html, vnode.htmlProfile || 'html')`, apply styles via `style.cssText`, create
  SVG elements in the SVG namespace, and `patch` reuses children keyed by `data-node-id` (unkeyed children by position).
- Also exported: `collectAttrs(vnode, tag)`, `styleString(style)`, `tagName(tag, inSvg)`, `VOID`.

### 2026-09-15 — B2b-1 `dialogs` / `shell` / `app` (§8, §9)
- `dialogs` module (used by the shell for `app.ui`): `dialog confirm prompt toast menu announce closeMenus`, getters `openDialogs menuOpen toasts`.
  `dialog(opts)` extra opts: `dismissible = true`, `initialFocus` (element|selector), `className`, `label`, `onClose(result, reason)`;
  action `{ label, kind: 'primary'|'danger'|'cancel'|'default', value, autofocus, disabled, run(close, api) }` (no `run` → `close(value)`);
  returns `{ el, body, footer, actions, close(result), closed: Promise<result>, isOpen }`. Esc/close button resolve `undefined`.
  `confirm` extra: `cancelLabel` (danger → Cancel focused, role `alertdialog`). `prompt` extra: `message`, `confirmLabel`, `cancelLabel`.
  `toast` returns `{ el, close() }`; `timeout: 0` = sticky; identical messages collapse (×n); hover/focus pauses; errors use `role=alert`.
  `menu(anchor, items, { label, placement, emptyLabel, onClose })` → `{ el, close(), isOpen }`; item extras: `command` (id → `data-command`),
  `submenu` may be a function; `hidden` skips; `'-'` = separator.
- `app.ui` extras: `unregisterPanel(id)`, `panels()`, `activePanel(side)`, `menuItems(menuId)` (resolved items), `openMainMenu()`,
  `inspectorSections()` (sorted by order), `contextMenuItems(payload)`, `closeMenus()`, `togglePanels()`, `togglePanel(side)`,
  `setPanelCollapsed(side, bool)`, `isCompact()`, `el`, `toolbarEl`, `statusEl`, `destroy()`. All `register*` return an unregister function.
  `registerMenuItem` with a string command skips commands that don't exist (checked at open time); `command: { label, run(app), icon,
  shortcut, disabled, checked, danger, submenu }` (`disabled/checked` may be functions of app). Custom menu ids get their own submenu.
- Panels: mounted lazily on first activation while visible; `update()` is called whenever a panel becomes the visible tab
  (panels subscribe to the store themselves for live updates). `badge(app)` is re-evaluated on store change/selection.
- Prefs added: `leftCollapsed`, `rightCollapsed` (booleans). Widths clamp to 200–640. Drawers (< 900 px) are not persisted.
- Commands registered by the shell: `view.togglePanels` (Mod+\), `view.toggleLeftPanel`, `view.toggleRightPanel`, `view.theme.light|dark|system`
  (all with `checked`). Command defs may carry `checked(app)`; menus render them as `menuitemcheckbox`.
- Canvas context menu: `app.emit('canvas:contextmenu', { clientX, clientY, nodeId })` selects `nodeId` if not selected and lists the §8 ids
  that exist; each runs with args `{ source: 'menu', nodeId, clientX, clientY }`. Tool buttons run `tool.<name>` when registered, else `canvas.setTool`.
- Event `ui:inspector-sections` `{ id, removed? }` fires on (un)registerInspectorSection. `app.notifyError(text)` = rate-limited error toast.

### 2026-09-15 — B1b-1 `overlay` / `interaction` (§7) and `store` drafts (§6.7)
- `overlay.create({ app, canvas })` → `{ el, refresh(info), destroy(), set(patch), clear(), layer(name) → <g>, invalidate(), markStale(),
  selectionBounds() → page AABB|null, hitTest(clientX, clientY, { coarse }) → { type: 'handle', handle } | { type: 'rotate', corner } | { type: 'body' } | null,
  cursorFor(hit) → CSS cursor, handlePoints() → client coords { nw n ne e se s sw w, rotate, top, center } | null, screenBox(),
  state, box (page { x, y, w, h, rotation }: single node = its world rect, multi = union AABB), rects, handlesVisible }`.
  Transient `set` keys: `marquee` (page rect), `guides`/`spacing` (snapping result shapes), `rotation: { angle, clientX, clientY }`,
  `hideHandles`, `hideHover`, `hideSelection`, `label` (overrides the "W × H" text). SVG has no pointer events; hit testing is geometric
  (handle hit 16 px, 24 px coarse; rotation zones 20 px beyond each corner plus a knob 22 px above the top edge). Handles are hidden while
  text editing, for locked-only selections and when `view.tool !== 'select'`. The renderer's `onRender` marks overlay geometry stale and
  `canvas.selectionBounds()` reuses it (one measurement pass per frame).
- `interaction` module: `registerTool(name, def)`, `registerGesture(name, factory)` (global) + `create({ app, canvas })` →
  `{ ctx, destroy, cancel(), active, gestureName, registerTool, registerGesture (instance-local), perf: { stats: { count, avg, max, p50, p95 }, reset() } }`.
  Tool def: `down(ctx, pt)` → pending `{ drag(pt) → gesture|null, click(pt), cursor }` or a gesture; optional `dblclick`, `hover(ctx, pt) → { hover, cursor }`,
  `contextmenu(ctx, pt) → handled`. Gesture: `{ name, cursor, move(pt), end(pt), cancel() }`. `pt = { clientX, clientY, page, shift, alt, mod, coarse, pointerType, event }`.
  Built-in gestures `move` ({ ids, start, duplicate }), `resize` ({ handle, start }), `rotate` ({ corner, start }), `marquee` ({ scope, start, base, additive });
  a registered `reorder` gesture ({ ids, start }) is used for stack children when present. `ctx` helpers: `history.mark()/cancel(mark)/finalize(mark, reapply)`,
  `snapConfig(pt)`, `snapTargets(ids)`, `movableIds(ids)`, `boxItem`, `localBox`, `applyBoxes`, `selectTarget(id|null)`, `setCursor`, `setHover`, `announce`,
  `coalesceKey(name)`, `gesture(name, opts)`, `overlay`. Viewport cursor override: CSS custom property `--apb-cursor` on `.apb-viewport[data-tool="select"]`.
- Select tool: handles/rotation zones first; `nodeAt({ deep: Mod })` with the page root treated as background; Shift adds on press / removes on
  click; pressing an unselected container that has children starts a marquee over its direct children (click selects it); pressing inside a
  multi-selection box drags the selection; double-click enters a group (`view.context`) or starts text editing. Resizing a `hug`/`fill` axis
  switches that axis' sizing to `fixed`. Positions are rounded to whole px unless snapped. `canvas:contextmenu` is emitted after selecting the
  node under the pointer. Undo/redo during a gesture ends it without reverting.
- `store` transactions (and undo/redo application) use draft copy-on-write: each object on a written path is copied once per transaction and
  then written in place; nested-transaction savepoints journal in-place writes for exact rollback. Objects returned by `tx.get/tx.node` may
  therefore reflect later writes of the same transaction — snapshot values you need before writing.

### 2026-09-15 — B2b-2 `palette` / `basic-commands` (§6.8, §8)
- `palette` module: `open(app, { query })` → `{ el, input, list, results, active, closed, close(), focus(), setQuery(text), run(index?) }` (re-opening
  refocuses the open one), `close()`, `toggle(app, opts)`, `isOpen`, `current`, `search(app, query)` → ranked entries
  `{ kind: 'command'|'insert'|'layer', id, title, meta, icon, keys, keysText, disabled, score, group?, positions?, type?, nodeId?, name? }`,
  `parseQuery(text)` → `{ mode: 'all'|'commands'|'layers'|'insert', q }`, `recent(app)`, `remember(app, id)`, `PREFIXES`, `MAX_RECENT`, `MAX_RESULTS`.
  Prefixes `>` commands, `@` layers (current page), `+` insert; an empty query lists recents, enabled commands, disabled ones, then inserts
  (layers only with a query or `@`). Commands with `palette: false` are skipped. Palette runs call `commands.run(id, { source: 'palette' })`.
  The palette is a `dialogs.dialog` with class `apb-palette` (input `role=combobox` + `role=listbox`, `aria-activedescendant`).
  `view.palette` (Mod+K, Mod+Shift+P, `allowInInputs`, `palette: false`) is registered by the `palette` plugin in `ui/palette.js`.
- Prefs added: `recentCommands` (string[] ≤ 8, most recent first; palette runs only).
- `basic-commands` plugin (order 30) registers, when not already present: `edit.undo redo delete duplicate rename selectAll`,
  `arrange.group ungroup wrapFrame wrapStack align.{left,hcenter,right,top,vcenter,bottom} distribute.{h,v} tidy radial matchWidth
  matchHeight bringForward sendBackward bringToFront sendToBack lock hide rotateLeft rotateRight resetRotation`, `help.shortcuts help.about`.
  All act on `docops.topLevel(selection)`; `arrange.lock`/`arrange.hide` toggle and expose `checked(app)`. `edit.rename` accepts
  `args.nodeId`; it emits `layers:rename` `{ id }` when that event has listeners, else uses `ui.prompt`. `edit.selectAll` selects the
  siblings of the selection / children of `view.context`, or every unlocked visible element inside the page's sections.
  `arrange.radial` opens a dialog (class `apb-radial-dialog`): each change undoes the previous preview entry and re-applies
  `docops.radial` (explicit `cx/cy` only for "Parent center"); Apply keeps one "Arrange in circle" entry; Cancel/Esc undo it.
  Dialog classes: `apb-shortcuts-dialog` (rows `tr[data-command]`, filter by substring tokens, plus a static "Canvas" gesture section),
  `apb-about-dialog`. Menus: Edit, Arrange (Align/Distribute/Match size/Order/Rotate submenus), Help. Styles for palette and these
  dialogs are injected once as `<style id="apb-palette-style">` / `<style id="apb-basic-commands-style">` (static text).

### 2026-09-16 — B1b-2 drawing tools, reparenting, keyboard model (§7) and `clipboard` (§9)
- `interaction` tools `frame section text rect ellipse line image` (`hand` is handled by `viewport`, which pans on
  `view.tool === 'hand'`). Drag draws (Shift = square, Alt = from the centre, `snapping.snapPoint` guides); a click creates
  the type's default size centred on the pointer; afterwards the tool returns to `select` unless Shift is held. The parent is
  the deepest container under the pointer that `elements.canContain` accepts (fallback: `view.context`, then the page root);
  the `section` tool always appends to the page root at the flow index under the pointer. `text` starts editing immediately,
  `image` opens the hidden file input (`input.apb-canvas-file-input` inside `.apb-viewport`) and fills `props.src`.
- New `interaction` gesture `reorder` ({ ids, start }): stack children show an insertion indicator and commit one
  `docops.reparent` on release. `move` also reparents: hovering another accepting container for 400 ms — immediately once the
  pointer leaves the current parent — highlights it and drops into it on release, keeping the visual position (one undo entry).
  New `ctx` helpers: `dropDetector(ids, { parent, reorder }) → { update(pt, force), result(), accepts(id) }`, `reorderChanges`,
  `isStack`, `flowInfo(parentId, pt, skip)`, `indicatorFor`, `localRect(parentId, pageRect)`, `drawTarget(tool, pt)`,
  `drawSnap(parentId)`, `createNode(tool, rect, target, pt)`, `nodeLabel`, `typeLabel`, `idsLabel`, `announceSelected`,
  `openImagePicker(job)`, `repeat(ms)`. `ctx.history.finalize(mark, reapply, { force })` replays even from a single entry.
  The instance also exposes `openImagePicker(job)` and `keyboard { nudge, enter, parent, sibling, all, none }`.
  **Note for `docops` callers:** `store.doc` is the *pre-transaction* document inside a `store.transact` (only `tx.doc` is
  live), so consecutive `docops` calls that depend on each other must be separate top-level transactions sharing a
  `coalesce` key rather than nested ones.
- `overlay` transient keys added: `highlight` (node id or page rect — drop target), `indicator` (`{ x1, y1, x2, y2 }` page
  coords — stack insertion line), `measure` (`[{ axis, from, to, pos, label }]`, same shape as snapping spacing — Alt-hover
  distances). Classes `apb-ov-highlight`, `apb-ov-indicator`, `apb-ov-measure`, `apb-ov-measure-label`.
- Keyboard (only while `.apb-viewport` itself has focus): arrows nudge 1 px / Shift 10 px coalesced per burst (stack children
  reorder instead), Enter selects the first child or edits text, Shift+Enter/Escape selects the parent (Escape with nothing
  selected blurs the canvas), Tab/Shift+Tab cycle siblings, each announcing `Selected <name>, <type>`. Touch: a 500 ms
  long press emits `canvas:contextmenu` (payload now also carries `pointerType`). Files dropped on the canvas become image
  nodes at the drop point; `.json` goes to `services.importers.fromFile` when present, else a toast.
- Commands registered by `interaction` (only when absent): `tool.select V`, `tool.hand H`, `tool.frame F`, `tool.section S`,
  `tool.text T`, `tool.rect R`, `tool.ellipse O`, `tool.line L`, `tool.image Mod+Shift+K` (category "Tools", `checked` =
  active tool), `view.toggleSnap`, and `select.all Mod+A`, `select.none Escape`, `select.parent Shift+Enter`,
  `select.child Enter`, `select.next Tab`, `select.prev Shift+Tab` (category "Select", enabled only when the canvas is focused,
  so Tab and Escape keep working everywhere else).
- `features/clipboard.js` (plugin `clipboard`, order 20) → `app.services.clipboard`:
  `copy(ids?) → Promise<ids>`, `cut(ids?)`, `paste({ inPlace, parent }) → Promise<ids>`, `pasteInPlace(opts)`,
  `payload(ids?) → envelope|null`, `write(envelope)`, `read()`, `insertPayload(envelope, opts)`, `buffer`, `clear()`,
  `FORMAT`, `CUSTOM_MIME`, `VERSION`. Envelope: `{ format: 'apb-clipboard', version: 2, roots, nodes, assets }` (whole
  subtrees, plus the assets they reference). It is written as `web application/x-apb+json` + `text/plain` (the envelope) +
  `text/html` (`vdom.toHTML` of the selection); an in-memory buffer and the DOM `copy`/`cut`/`paste` events are the fallback
  when the async Clipboard API is unavailable or denied. Pasting: envelopes get new ids and cascade +16 px (paste-in-place
  keeps the position and the original parent), images become `image` nodes (`services.assets.add` when present), HTML goes to
  `services.importers.fromHTML` when present (else its text) and text becomes a `text` node. The target parent is the selected
  container (unless it is part of what is being pasted), then the selection's parent, then `view.context`. Commands
  `edit.copy Mod+C`, `edit.cut Mod+X`, `edit.paste Mod+V`, `edit.pasteInPlace Mod+Shift+V` + Edit menu entries.

### 2026-09-16 — C1a `layers` panel (§8) and `css/panels.css`

- `features/layers.js` (plugin `layers`, order 40) registers the left panel `{ id: 'layers', title: 'Layers',
  icon: 'layers', order: 10 }`. It owns no service; other modules reach it through the store, the `layers:rename`
  event and the DOM hooks below.
- **Row order is document order** (`children[0]` first, i.e. reading / stack-flow order, the reverse of a paint-order
  list): `Mod+ArrowDown` = `docops.zorder(…, 'forward')`, `Mod+ArrowUp` = `'backward'`.
- DOM hooks (stable for tests and for other panels): `.apb-layers` (panel root, carries `apbLayers`),
  `.apb-layers-head` (page switcher, shown only with ≥ 2 pages; `.apb-layers-page` is the `select`),
  `.apb-layers-search input`, `.apb-layers-scroll`, `.apb-layers-tree[role=tree][aria-multiselectable]`,
  rows `.apb-layer[role=treeitem][data-id][aria-level][aria-posinset][aria-setsize]` with
  `.apb-layer-twisty`, `.apb-layer-type`, `.apb-layer-name`, `.apb-layer-badge`, `.apb-layer-eye`,
  `.apb-layer-lock` (`aria-pressed`), the inline editor `.apb-layer-rename` and the drop line
  `.apb-layers-indicator` (plus `.is-drop-inside` on an "inside" target).
- `document.querySelector('.apb-layers').apbLayers` → `{ refresh(), flush(), rename(id), rowIds(), setQuery(text),
  expandAll(), collapseAll(), activeId, virtual, renderedCount }` (mirrors `el.apbControl`; intended for tests and
  sibling panels, not a cross-module contract).
- The page/master root row is a drop target and an expand root but is **not** selectable (clicking it clears the
  selection), so `edit.delete` can never reach a page root from the tree.
- Selection is two-way: click replaces, Shift+click selects the visible range, Mod+click toggles, and
  `store.on('selection')` only repaints the rows that changed (ancestors are expanded and the row is scrolled into
  view when needed). `store.on('change')` schedules one rAF rebuild that is reconciled by node id. Above 200 rows the
  tree renders only the scrolled window and reserves the rest with padding on the tree element.
- `edit.rename` (F2) emits `layers:rename` `{ id }`; this plugin answers it by showing the panel and starting the
  inline editor, and falls back to `ui.prompt` when the panel is unavailable. Renames are one `Rename layer`
  transaction. Row context menus prepend Rename / Expand / Collapse to `ui.contextMenuItems({ nodeId })`.
- Lock and visibility toggles call `docops.setLocked` / `docops.setHidden` for that row only (so hiding follows the
  active breakpoint like every other geometric write).
- `src/css/panels.css` starts with shared panel primitives (`.apb-panel-fill`, `.apb-panel-bar`, `.apb-panel-scroll`)
  and then one section per panel; later panel agents **append** their section instead of editing earlier ones.

### 2026-09-16 — C1b `inspector` (Design panel, §8) and `tokens` (document styles, §5)

- `features/inspector.js` (plugin `inspector`, order 41) registers the right panel
  `{ id: 'design', title: 'Design', icon: 'design', order: 10 }`. It owns no service. With a
  selection it is the node inspector; with an empty selection it renders the document styles UI of
  the `tokens` module underneath a `widgets.emptyState`.
- **Writing model.** Every control writes live through `docops.update` with
  `coalesce: 'inspector:<fieldId>:<ids>#<burst>'`, where `<burst>` increases each time a control
  reports `{ commit: true }`. One drag / typing burst is therefore one undo entry, and the next
  burst is a new one even inside the store's 1500 ms coalesce window. Fields whose key cannot
  cascade (`attrs.*`, `css`, `name`, and `props.*` keys the type does not list in `bpProps`) are
  written with `{ bp: null }` so they never become a breakpoint override the cascade would drop.
- **Breakpoint overrides.** Values are read through `schema.effectiveNode(doc, node, view.bp)`.
  Away from the base breakpoint a field whose `bp[active][top][sub]` exists is marked
  `is-overridden` and its `fieldRow` reset button deletes exactly that entry (pruning the empty
  `bp[active]` bag) in a `Reset <field>` transaction. The header also carries
  "Reset all `<bp>` overrides" whenever the selection has any.
- **Sizing rules the UI enforces** (matching §5 and `style.boxDecls`): `fill` needs a parent,
  `hug` needs a stack parent, and a container whose own `layout.mode` is `free` cannot hug height.
  X/Y are disabled inside stack parents, W/H while that axis is not `fixed`.
- **Sections**, in order: Position & size, Layout, Content (one section per `def.inspector` group,
  only when the selection is one type; every `FIELD_TYPE` is supported, `url` refuses anything
  `sanitize.url` rejects and never writes it, `code` sanitizes on commit), Typography, Fill
  (None / Solid / Gradient / Image — the editor below the type switch is the only part that
  re-renders), Border, Effects, Component overrides (type `instance`: the master's text/alt/href
  fields, each with its own override dot and reset), Attributes, Custom CSS, then every
  `ui.registerInspectorSection` entry whose `applies(nodes, app)` passes (this is where the motion
  plugin's section lands). Collapse state per section id lives in `prefs.inspector.sections`.
- **Refresh.** `store.on('change'|'selection')` schedule one rAF pass that pushes new values into
  the existing controls; the DOM is rebuilt only when a signature over (bp, component, and per node
  id/type/container/locked/layout mode+dir/stack-parent/component/`when()` results) changes, never
  while the focus is inside the control being updated, and focus is restored to the same field id
  after a rebuild. Escape inside the panel returns focus to `app.canvas.el`.
- DOM hooks: `.apb-inspector` (carries `apbInspector`), `.apb-inspector-head`,
  `.apb-inspector-title`, `.apb-inspector-type`, `.apb-inspector-name`, `.apb-inspector-bp`,
  `.apb-inspector-tools`, `.apb-inspector-body`, `.apb-inspector-section[data-section]`,
  `.apb-inspector-docstyles`; new controls `.apb-sides` (+ `.apb-sides-grid`, `.apb-sides-link`),
  `.apb-aligngrid` (+ `.apb-aligngrid-cell`), `.apb-listedit`, `.apb-tableedit`, `.apb-iconpick`,
  `.apb-assetfield`, `.apb-field-grid`. Each of those exposes the usual `el.apbControl`
  (`value`, `setMixed`, `setDisabled`, `focus`), so they behave like `widgets` controls.
  `document.querySelector('.apb-inspector').apbInspector` → `{ refresh(), fieldIds(),
  field(id) → { el, row, api, nodes }, docStyles, selection }` (for tests and sibling panels).
- `features/tokens.js` defines the module **`tokens`** — the only writer of `doc.tokens` and
  `doc.settings.fonts`:
  `colors(doc) texts(doc) fonts(doc) colorToken(doc,id) textToken(doc,id) fontOptions(doc)
  makeId(name, taken) usage(doc, id, 'color'|'text') → nodeIds
  addColor(app,{name,value}) setColor(app,id,{name,value}) renameColor(app,id,nextId)
  removeColor(app,id,{inline=true}) replaceEverywhere(app,id) → count applyColor(app,ids,ref,key)
  addTextStyle(app,{name,style}) setTextStyle(app,id,{name,style}) renameTextStyle
  removeTextStyle applyTextStyle(app,ids,id) textStyleFromNode(doc,node,bp)
  addFont(app,family,'system'|'google') removeFont(app,family)
  pageBackground(app) setPageBackground(app,value) currentPageRoot(app)
  mount(container, app, { targets() → nodeIds }) → { update(), refresh(), el, destroy() }`
  plus the constants `TOKEN_ID_RE TEXT_STYLE_KEYS COLOR_STYLE_KEYS SYSTEM_STACKS`.
  Renaming a token id rewrites every `$id` reference (styles, breakpoint overrides and
  `states.*.style`) in the same transaction; deleting a colour inlines its literal value into the
  nodes that used it and deleting a text style copies its declarations onto them, so the document
  never keeps a dangling reference. Nothing is fetched from the network — a Google font is recorded
  by family name only (`{ family, source, weights: [400, 700] }`) for the exporter to link.
  DOM hooks: `.apb-docstyles`, `.apb-docstyles-section`, `.apb-token-row[data-token]`
  (`.apb-token-swatch`, `.apb-token-name`, `.apb-token-value`, `.apb-token-usage`,
  `.apb-token-id`), `.apb-font-row`, `.apb-font-add`.
  `mount`'s `targets()` supplies the layers its "Apply" actions write to; the Design panel passes
  the selection it remembers, because this view is only shown when nothing is selected.
- Prefs added: `inspector: { sections: { [sectionId]: collapsed } }`.
- `src/css/panels.css` gained the `inspector` + `doc styles` sections at the end of the file.

### 2026-09-16 — C2/C3 `actions`, `checklist`, `templates`, `exporters`, `preview`
Interactivity, a starter-section gallery, and the export/preview tools, filling in the `checklist`,
`templates`, `element-types-extra`, `exporters` and `preview` slots ahead of their originally
planned order. `services.exporters`/`services.preview` (§9) are real now.

- **`node.actions`** (new node key, §5.1): `[{ id, trigger: 'click'|'change', type, ...type fields }]`.
  Added to `schema.NODE_KEYS` (required — `docops.update`/`store.updateNode` silently drop, then
  throw on, any key not listed there) but *not* `BP_KEYS`, so — like `motion`/`attrs`/`css` — it
  never becomes a breakpoint override; writers should still pass `{ bp: null }` for clarity.
  `schema.baseNode` defaults it to `[]`; `normalizeNodeFields` keeps only plain objects with a
  string `type`, deferring real validation to `actions.normalize()`.
- **`core/actions.js`** (pure, deps `util sanitize`): `TYPES` (`link scrollTo toggle show hide
  toggleClass submit code`, each `{ id, label, icon, fields: [{ key, label, kind, placeholder? }] }`,
  `kind` one of `url toggle target text code`) · `has(type)` · `fieldsFor(type)` ·
  `triggerFor(nodeType)` (`button→click`, `checklist→change`, default `click`) ·
  `create(type, nodeType)` → new action with empty-but-typed fields · `normalize(list, { doc,
  sanitizeUrl })` → clean array (drops unknown types, re-sanitizes `url` via `sanitize.url(…,
  'link')`, clamps `code` to `MAX_CODE` (20 000) and the list to `MAX_ACTIONS` (40), drops a
  `target` that isn't a real id in `doc.nodes` when `doc` is given) · `describe(action)` → one-line
  summary for a collapsed row · `runtimeSource()` → the trusted `<script>` body (see below).
- **`vdom` decorate()** (now depends on `actions` too) sets `data-apb-actions="<json>"` on a node's
  root element whenever `eff.actions` is non-empty, in *every* mode — inert in the editor (nothing
  listens), consumed by the runtime in export/preview. It always re-runs `actions.normalize(eff
  .actions, { doc: env.doc })` first, so this is the one choke point that guarantees a safe/sane
  payload regardless of how the document reached this state (typed in the UI, pasted, imported).
- **Runtime** (`actions.runtimeSource()`, appended by `exporters.html()`/`preview.js` as a hand-written
  trusted `<script>` string — vdom's own tag whitelist bans `<script>`, so this never goes through
  the node tree): one delegated listener per `(element, trigger)`, reading `data-apb-actions`.
  `link` navigates (`newTab` → `window.open(…, 'noopener')`); `scrollTo/toggle/show/hide` resolve
  `[data-node-id="target"]` (`toggle` flips current `display`); `toggleClass` needs `target` +
  `className`; `submit` calls `el.closest('form').requestSubmit()`; `code` runs
  `new Function('event','el','document','window', a.code)` with `this`/`el` = the action's own
  element — the same trust boundary as `node.css` / `settings.globalCSS`: the *site owner's* code,
  never executed in the editor, only in the page they export or preview.
- **`features/actions.js`** (plugin `actionsUI`, order 42; not `@node-testable`, DOM-only): the
  inspector "Actions" section via `ui.registerInspectorSection` — single-selection only, `applies`
  when the one selected node is `button` or `checklist`. `mount(container)` seeds itself from
  `store.selection` immediately (**`buildExternal` does not call `update()` right after `mount()`**
  — it only arrives on the next unrelated store `change`/`selection` event via `syncAll()`; every
  external inspector section must self-seed or it renders empty until something else happens to
  refresh the panel). Field controls are generated from `actions.TYPES[].fields` (`url→text[type=url]`,
  `toggle→widgets.toggle`, `target→widgets.select` populated from the current page's node tree,
  `code→widgets.textArea({monospace:true})`); writes go through `docops.update(app, [id], {actions},
  {bp:null, coalesce:'actions:<nodeId>:<fieldKey>#<burst>'})`, one burst per field so a typing/drag
  session collapses to one undo entry (same pattern as `features/inspector.js`'s `burstKey`).
  DOM: `.apb-actions-section`, `.apb-actions-card`, `.apb-actions-field[--toggle|--code]`.
- **`checklist` element type** (`features/element-types-extra.js`, plugin-free module — the file is
  `@node-testable` and self-requires at the bottom so registration isn't left to a lazy caller that
  may never come): category `text`, `bpProps: ['items']`, `props.items: [{ id, text, checked }]`
  (3 seeded by default). Renders `<ul class="apb-checklist"><li><input type=checkbox
  class="apb-checklist-input" data-item-id data-apb-actions-on-root><span
  class="apb-checklist-text">`; editor mode adds `tabindex=-1` to the checkboxes (no `data-href`-style
  trick needed — nothing else intercepts checkbox clicks, so this is purely a keyboard-nav nicety).
  A checked checkbox's native `change` event bubbles to the `<ul>` root, which is what the actions
  runtime listens on; the handler's `event.target.dataset.itemId`/`.checked` identify which item
  changed. Inspector: one `{ key: 'props.items', type: 'list', checkable: true }` field (see next
  point). Icon `checklist` self-registered via `icons.add` (idempotent).
- **`listEditor` (the `list` FIELD_TYPE control, `features/inspector.js`)** gained `o.checkable`:
  items become `{ id, text, checked }` objects with a `widgets.toggle` per row instead of plain
  strings; a field spec opts in with `checkable: true` (only `checklist` uses it so far). Plain
  (non-checkable) behaviour is unchanged — this was an additive, backward-compatible change.
- **Canvas tools**: `button` (`B`) and `checklist` (`C`) added to `interaction.js`'s `DRAW_TOOLS` /
  `TOOL_KEYS` (default sizes 160×48 / 280×140, otherwise fully generic — no `edit`/`pick`/`root`/
  `flat` flags, so click-to-place and drag-to-size just work through the existing machinery),
  `canvas.js`'s `TOOLS` array and `shell.js`'s `TOOL_LABELS` map (the only *hardcoded* one — toolbar
  buttons, `Insert` menu registration and `services.*` wiring are all extensible from outside shell.js).
- **`features/templates.js`** (`@node-testable`; module `templates` + plugin `templates`, order 45):
  `list() → [{ id, label, icon, description }]`, `build(id) → spec|null` (deep-cloned, so callers can
  mutate freely) for `hero`, `pricing`, `contact`. Every template's root is a `section` — per the A2
  `docops` contract, `insert()` with no explicit `parent` already resolves sections to the current
  page root, so `templates.js` never needs to know about pages/positioning. Built with the *stack*
  layout model (`layout:{mode:'stack',…}`, `sizing.w:'fill'`/`'hug'`), not raw absolute x/y — this is
  the deliberate improvement over free-canvas page-builder templates: they reflow instead of clipping.
  `contact` embeds a real `<form>` via the `html` element type (`sanitize.html`'s `'html'` profile
  whitelists `form input textarea label button` — confirmed, not assumed). UI: `insert.template`
  command opens an `app.ui.dialog` grid of `.apb-template-card` buttons; picking one calls
  `docops.insert` and zooms the canvas to the new selection. Auto-added to the `Insert` menu via
  `ui.registerMenuItem({ menu: 'insert', command: 'insert.template' })` — `shell.js` already treats
  `insert` as a first-class menu (`MENUS`), so nothing there needed to change. Icon `templates`
  self-registered via `icons.add`.
- **`features/exporters.js`** (`@node-testable`; module `exporters` + plugin `exporters`, order 60)
  implements `services.exporters` (§11) as pure string-building functions (`html site zip json jsx`),
  runnable in Node with no DOM:
  - `html(doc, { pageId, minify, inlineAssets=true, includeHidden=false, sourceComment=true }) →
    { html, css, files }`. Renders the base breakpoint once via `vdom.buildTree(…, { mode:'export',
    classFor: id => 'n-'+shortid, onNode })` for the markup, collecting each node's `decls` (Map)
    keyed by its class; re-renders once per *other* breakpoint (`includeHidden:true` on these passes
    specifically, so a node that's only hidden at that breakpoint still yields a `display:none` diff
    instead of silently vanishing from the CSS) and emits `style.diffDecls(base, thatBp)` inside
    `@media (max-width:<bp.max>px)`. Also collects `style.hoverDecls` once (hover isn't
    breakpoint-cascaded) and `style.tokensCSS` + sanitized `settings.globalCSS`. `motion`/`freeform`
    opts from the original §11 contract are accepted but not yet implemented (no scale/center
    freeform wrapper, no motion keyframes — `node.motion` has no writer anywhere yet either); real
    work landed on `inlineAssets` (data: URLs, already the default via `doc.assets[id].src`) and
    `inlineAssets:false` (extracts each `data:` asset to `assets/<name>-<n>.<ext>` via `atob`,
    returned in `files`). `withIds` (`data-node-id`) and the actions `<script>` are included only
    when `docHasActions(doc)` — a whole-document scan, not scoped to the exported page/its component
    instances, trading a little export-size precision for a lot less code — is true. Emits a CSP
    meta tag (`script-src 'self' 'unsafe-inline'` only when actions are present, so pages without
    them stay stricter) and a `referrer` meta; SEO from `page.seo`. `exporters.html.snippet` gotcha
    for anyone adding more hand-written trusted markup here: writing `'<!--'` and `'<script'` as
    literal source in a file that itself gets inlined into `main.html`'s own `<script>` tag trips
    `tools/build.mjs`'s script-safety scan — split them (`'<' + '!--'`) the way this file already
    does for its `sourceComment` line.
  - `site(doc, opts) → files` loops `doc.pages`, naming `index` → `index.html` else `<slug>.html`,
    de-duping shared asset files across pages.
  - `zip(files) → Blob`: zero-dependency STORE-method ZIP (no compression) with a table-based CRC-32;
    hand-rolled local file header (30 B) / central directory record (46 B) / EOCD (22 B) per the ZIP
    spec. **`Blob` had to be added to `tests/run.mjs`'s vm sandbox globals** — it's a stable Node ≥18
    global (this project requires ≥20) but not part of bare ECMAScript, so `vm.createContext` doesn't
    provide it automatically the way it does `Date`/`JSON`/etc.
  - `json(doc)` → `JSON.stringify(doc, null, 2)` (the `.apb.json` project format, verbatim).
  - `jsx(doc, { pageId }) → string`: a lower-fidelity, best-effort implementation relative to the
    others (not part of the original ask) — walks the base-breakpoint tree with `inlineStyles: true`
    (no class/media-query machinery reused) and serializes directly to JSX (`class→className`,
    `style` object → `style={{...}}`, `html` → `dangerouslySetInnerHTML`). No breakpoint or hover
    support yet.
  - UI: `file.exportCode` command (`Mod+E`) + toolbar button (`area:'end'`, after `preview`) open an
    `app.ui.dialog` with page/format/minify/inline-assets controls, a live `<pre class="apb-export-code">`
    preview, Copy (clipboard API) and Download (Blob + synthetic `<a download>`, or `zip()` when
    `inlineAssets` is off and there are files to bundle) actions.
  - **Module-loading gotcha (cost real debugging time — read this before adding another such file):**
    a file that's only `APB.define(name, deps, factory)` never runs its factory — and therefore never
    runs any `elements.register`/`icons.add`/`APB.plugin` side effect inside it — until *something*
    calls `APB.require(name)`. `element-types.js`'s core types work around this because `elements.js`
    hardcodes a first-use `APB.require('element-types')`; nothing does that for feature modules. Fix:
    end the file with `if (typeof document !== 'undefined') APB.require('<name>');` — eager in the
    real app (script tags run before `app.js`'s `start()`, so this beats `shell.mount()` and the
    plugin-init loop), a no-op in the unit-test vm sandbox (no `document`) where each test file's
    `loadAPB()` gets a fresh module registry anyway and requires what it needs itself. Applies to
    `exporters.js`, `templates.js` and `element-types-extra.js` — all three were silently inert
    (plugin never registered, type never appears in `elements.get`) without this line.
- **`features/preview.js`** (plugin `preview`, order 61; not `@node-testable`): `services.preview =
  { open({ pageId }) }` — calls `services.exporters.html(doc, { pageId, sourceComment:false })`,
  wraps the result in a `blob:` URL and `window.open`s it in a new tab (deliberately **not**
  `'noopener'`: the target is a same-session blob we just created, not an external/untrusted URL, and
  omitting it is what lets the return value double as popup-blocked detection — `window.open(...,
  'noopener')` returns `null` on success too, so it can't tell "blocked" from "opened"). Not a live
  preview — each click re-renders current state into a disposable static tab. `view.preview` command
  (`Alt+P`) + toolbar button (`area:'end'`, order 20, first of the two).
- Testing: `tests/run.mjs`'s vm sandbox gained `Blob` (see `zip()` above).
  `tests/unit/{actions,exporters,element-types-extra,templates}.test.mjs` added.
  `tests/e2e/scenarios/40-actions-templates-export.mjs` added; `13-canvas-tools.mjs` and
  `21-shell.mjs` updated for the two new tool ids and the inspector-sections list now always
  including `actions` (previously assumed no plugin pre-registers a real section).

# Tests

Zero-dependency test tooling. Requires Node ≥ 20 (for the e2e harness: Chrome, Chromium or Edge).

```bash
node tests/run.mjs            # unit tests (all)
node tests/run.mjs store      # unit tests whose file name contains "store"
node tests/e2e.mjs            # build + headless browser smoke tests
node tests/e2e.mjs canvas     # only scenarios whose file name contains "canvas"
node tests/e2e.mjs --headed   # watch the browser
```

## Unit tests (`tests/unit/*.test.mjs`)

`tests/run.mjs` loads every file under `src/js/core/` plus any file whose **first line** is
`/* @node-testable */` (in `src/index.html` manifest order, stubs skipped) into a fresh `vm`
context per test file, then calls the test file's default export:

```js
export default function (APB, t) {
  const util = APB.require('util');
  t.test('clamp', () => {
    t.assert.equal(util.clamp(5, 0, 3), 3);
  });
}
```

`t` provides `test, it, describe, before, after, beforeEach, afterEach, mock` from `node:test`,
a realm-safe `assert` (deep comparisons work across the vm boundary), `loadAPB({ globals })`
to create an extra isolated context, and `plain(value)`.
Register tests synchronously (the default export must not be async).

## End-to-end tests (`tests/e2e/scenarios/*.mjs`)

Scenarios run in filename order, each in a fresh browser context (isolated storage) with the
app loaded from `file:///…/main.html`. A scenario fails if it throws or if the page reports
uncaught exceptions or console errors (unless listed in `export const allowErrors = [/regex/]`).

```js
export const name = 'what this checks';
export const viewport = { width: 1280, height: 800 }; // optional
export async function run(page, { assert, sleep, log }) {
  await page.ready();                                   // waits for APB.app.ready
  const count = await page.eval(() => Object.keys(APB.app.store.doc.nodes).length);
  await page.click('.apb-some-button');
  await page.drag(400, 300, 520, 360, { modifiers: ['Shift'] });
  await page.key('Mod+Z');
  await page.screenshot('after-undo');                  // tests/artifacts/<scenario>-after-undo.png
}
```

Page API: `goto(url?)`, `reload()`, `eval(exprOrFn, ...args)`, `waitFor(exprOrFn, timeout)`,
`ready()`, `rect(selector)`, `mouse(type, x, y, opts)`, `click(selector, opts)`,
`drag(x1, y1, x2, y2, { steps, modifiers })`, `wheel(x, y, dx, dy, { modifiers })`,
`key(combo, modifiers, { repeat })`, `type(text)`, `setFiles(selector, files)`,
`setViewport(w, h)`, `screenshot(name)`, `assertNoErrors(allow)`.

Screenshots and failure captures go to `tests/artifacts/` (git-ignored).

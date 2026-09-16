#!/usr/bin/env node
// Advanced Page Builder — unit test runner (zero dependencies, node:test).
//
// Loads the core JS files listed in src/index.html into a fresh `vm` context (one per test file),
// then imports every tests/unit/*.test.mjs and calls its default export:
//
//   export default function (APB, t) { t.test('name', () => { t.assert.equal(…); }); }
//
// Usage: node tests/run.mjs [filter…]   e.g. `node tests/run.mjs store schema`
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { describe, it, test, before, after, beforeEach, afterEach, mock } from 'node:test';
import { parseManifest, isStub, ROOT, ENTRY } from '../tools/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_DIR = join(HERE, 'unit');
const NODE_TESTABLE = '/* @node-testable */';

/** Core files (+ any file whose first line is the @node-testable marker) in manifest order. */
export function testableFiles() {
  const html = readFileSync(ENTRY, 'utf8');
  return parseManifest(html)
    .filter((it) => it.kind === 'js' && !it.remote && existsSync(it.path))
    .map((it) => ({ href: it.href, path: it.path, code: readFileSync(it.path, 'utf8').replace(/^\ufeff/, '') }))
    .filter((f) => !isStub(f.code))
    .filter((f) => f.href.startsWith('js/core/') || f.code.split(/\r?\n/, 1)[0].includes(NODE_TESTABLE));
}

let cachedFiles = null;

/**
 * Values created inside the vm context have that realm's prototypes, which makes
 * assert.deepStrictEqual fail against literals from this realm. plain() re-creates a value in
 * this realm (structuredClone); the assert passed to tests applies it to deep comparisons.
 */
export function plain(value) {
  try { return structuredClone(value); } catch { return value; }
}

function realmSafeAssert(...args) { return assert(...args); }
Object.assign(realmSafeAssert, assert, {
  deepEqual: (a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg),
  deepStrictEqual: (a, b, msg) => assert.deepStrictEqual(plain(a), plain(b), msg),
  notDeepEqual: (a, b, msg) => assert.notDeepStrictEqual(plain(a), plain(b), msg),
  notDeepStrictEqual: (a, b, msg) => assert.notDeepStrictEqual(plain(a), plain(b), msg)
});

/**
 * loadAPB({ globals }) → APB from a brand-new vm context with the testable files evaluated.
 * `globals` lets a test inject extra globals (e.g. a fake navigator) before modules load.
 */
export function loadAPB(options = {}) {
  cachedFiles = cachedFiles || testableFiles();
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    structuredClone, performance,
    URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Blob,
    ...(options.globals || {})
  };
  const context = vm.createContext(sandbox, { name: 'apb-unit' });
  for (const f of cachedFiles) {
    vm.runInContext(f.code, context, { filename: f.path });
  }
  if (!context.APB) throw new Error('src/js/core/apb.js did not define APB');
  return context.APB;
}

async function main() {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let files;
  try {
    files = testableFiles();
    loadAPB(); // fail fast on syntax errors / define() errors
  } catch (err) {
    console.error('Failed to load core modules:\n', err);
    process.exit(1);
  }

  const toolkit = { test, it, describe, before, after, beforeEach, afterEach, mock, assert: realmSafeAssert, loadAPB, plain };

  if (!filters.length || filters.includes('modules')) {
    describe('modules', () => {
      const APB = loadAPB();
      it('loads ' + files.length + ' testable files', () => assert.ok(files.length > 0));
      for (const name of APB.list()) {
        it('instantiates "' + name + '" without a DOM', () => {
          assert.doesNotThrow(() => APB.require(name));
        });
      }
    });
  }

  const testFiles = existsSync(UNIT_DIR)
    ? readdirSync(UNIT_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
    : [];
  const selected = testFiles.filter((f) => !filters.length || filters.some((q) => f.includes(q)));
  if (filters.length && !selected.length && !filters.includes('modules')) {
    console.error('No unit test files match: ' + filters.join(', '));
    process.exit(1);
  }

  for (const file of selected) {
    const full = join(UNIT_DIR, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      describe(file, () => { it('imports', () => { throw err; }); });
      continue;
    }
    if (typeof mod.default !== 'function') {
      describe(file, () => { it('exports a default function (APB, t)', () => assert.fail('missing default export')); });
      continue;
    }
    describe(basename(file, '.test.mjs'), () => {
      const APB = loadAPB();
      const result = mod.default(APB, toolkit);
      if (result && typeof result.then === 'function') {
        throw new Error(relative(ROOT, full) + ': default export must register tests synchronously');
      }
    });
  }
}

main();

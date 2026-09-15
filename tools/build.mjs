#!/usr/bin/env node
// Advanced Page Builder — build: inline every stylesheet and script of src/index.html (in order)
// into a single self-contained main.html, and write index.html (redirect for GitHub Pages).
// Zero dependencies. Usage: node tools/build.mjs [--check] [--quiet]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(ROOT, 'src');
export const ENTRY = join(SRC_DIR, 'index.html');

const LINK_RE = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi;
const SCRIPT_RE = /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script\s*>/gi;
const HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;
const VERSION_MARKER = '<!-- build:version -->';
const REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Ordered manifest of { kind: 'css'|'js', href, path, tag } from the dev entry HTML. */
export function parseManifest(html) {
  const items = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(html))) {
    const href = (HREF_RE.exec(m[0]) || [])[1];
    if (href) items.push({ kind: 'css', href, index: m.index, tag: m[0] });
  }
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    items.push({ kind: 'js', href: m[2], index: m.index, tag: m[0] });
  }
  items.sort((a, b) => a.index - b.index);
  return items.map((it) => ({ ...it, remote: REMOTE_RE.test(it.href), path: REMOTE_RE.test(it.href) ? null : join(SRC_DIR, it.href) }));
}

/** true when a source file is only a placeholder stub comment. */
export function isStub(text) {
  return /^\s*\/\*\s*stub\b[\s\S]*?\*\/\s*$/.test(text);
}

function readText(path) {
  return readFileSync(path, 'utf8').replace(/^\ufeff/, '');
}

function escapeScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

/** `<!--` inside an inline script can switch the HTML tokenizer into an escaped state. */
function scriptWarnings(href, code) {
  return /<!--/.test(code) && /<script/i.test(code)
    ? ['src/' + href + ': contains "<!--" and "<script" — write them as \'<\' + \'!--\' to keep the inline script safe']
    : [];
}

function escapeStyle(css) {
  return css.replace(/<\/style/gi, '<\\/style');
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(2) + ' MB' : (bytes / 1024).toFixed(1) + ' KB';
}

/** Remove inline <script>/<style> bodies so checks only look at real markup. */
function stripInlineBodies(html) {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, '$1$2');
}

export function checkNoRemote(html, label) {
  const problems = [];
  const markup = stripInlineBodies(html);
  const tagRe = /<(script|link)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(markup))) {
    const attr = /\b(?:src|href)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]*)/i.exec(m[0]);
    if (attr) problems.push(label + ': remote resource in <' + m[1].toLowerCase() + '>: ' + attr[1]);
  }
  return problems;
}

function redirectPage(version) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Advanced Page Builder</title>
<meta name="description" content="Advanced Page Builder ${version} — a zero-dependency visual web page builder in a single HTML file. Everything runs in your browser.">
<meta http-equiv="refresh" content="0; url=main.html">
<link rel="canonical" href="main.html">
<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:2rem;max-width:40rem}a{color:#1d4ed8}@media (prefers-color-scheme:dark){body{background:#111827;color:#f3f4f6}a{color:#93c5fd}}</style>
</head>
<body>
<h1>Advanced Page Builder</h1>
<p>A zero-dependency visual web page builder that runs entirely in your browser — no account, no upload.</p>
<p><a href="main.html">Open the builder</a></p>
</body>
</html>
`;
}

export function build(options = {}) {
  const log = options.quiet ? () => {} : (...a) => console.log(...a);
  const pkg = JSON.parse(readText(join(ROOT, 'package.json')));
  const version = pkg.version || '0.0.0';
  if (!existsSync(ENTRY)) throw new Error('Missing entry file ' + relative(ROOT, ENTRY));
  let html = readText(ENTRY);
  const manifest = parseManifest(html);
  const missing = manifest.filter((it) => !it.remote && !existsSync(it.path));
  if (missing.length) {
    const err = new Error('Missing files referenced by src/index.html:\n' + missing.map((it) => '  - src/' + it.href).join('\n'));
    err.code = 'MISSING';
    throw err;
  }

  const date = new Date().toISOString();
  html = html
    .replace(VERSION_MARKER, () => `<meta name="generator" content="Advanced Page Builder ${version}">\n<!-- Advanced Page Builder v${version} · built ${date} · single-file build of src/index.html -->`)
    .replace(/\n?<!-- Manifest:[^>]*-->\n?/, '\n');
  const manifestItems = parseManifest(html);

  // Assemble by slicing the entry HTML at tag positions (never search inside inlined content).
  const rows = [];
  const warnings = [];
  const out = [];
  let total = 0;
  let cursor = 0;
  for (const it of manifestItems) {
    out.push(html.slice(cursor, it.index));
    cursor = it.index + it.tag.length;
    if (it.remote) {
      rows.push([it.href, 'remote (left as-is)']);
      out.push(it.tag);
      continue;
    }
    const content = readText(it.path);
    const bytes = Buffer.byteLength(content);
    total += bytes;
    rows.push([it.href, formatSize(bytes) + (isStub(content) ? '  (stub)' : '')]);
    if (it.kind === 'css') {
      out.push(`<style data-src="${it.href}">\n${escapeStyle(content.trimEnd())}\n</style>`);
    } else {
      warnings.push(...scriptWarnings(it.href, content));
      out.push(`<script data-src="${it.href}">\n${escapeScript(content.trimEnd())}\n</script>`);
    }
  }
  out.push(html.slice(cursor));
  html = out.join('');

  const mainPath = join(ROOT, 'main.html');
  const indexPath = join(ROOT, 'index.html');
  const indexHtml = redirectPage(version);

  if (options.check) {
    const problems = checkNoRemote(html, 'main.html').concat(checkNoRemote(indexHtml, 'index.html'));
    if (problems.length) {
      const err = new Error('Build check failed:\n' + problems.map((p) => '  - ' + p).join('\n'));
      err.code = 'CHECK';
      throw err;
    }
  }

  writeFileSync(mainPath, html);
  writeFileSync(indexPath, indexHtml);

  if (!options.quiet) {
    const width = Math.max(...rows.map((r) => r[0].length), 10);
    log('Advanced Page Builder v' + version + ' build');
    for (const [name, size] of rows) log('  ' + name.padEnd(width) + '  ' + size);
    log('  ' + '-'.repeat(width + 12));
    log('  ' + 'sources'.padEnd(width) + '  ' + formatSize(total) + ' in ' + manifest.length + ' files');
    log('  ' + 'main.html'.padEnd(width) + '  ' + formatSize(Buffer.byteLength(html)));
    log('  ' + 'index.html'.padEnd(width) + '  ' + formatSize(Buffer.byteLength(indexHtml)));
    if (options.check) log('  check: no remote script/link resources');
  }
  for (const w of warnings) console.warn('warning: ' + w);
  return { main: mainPath, index: indexPath, bytes: Buffer.byteLength(html), files: manifest.length };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  try {
    build({ check: args.has('--check'), quiet: args.has('--quiet') });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

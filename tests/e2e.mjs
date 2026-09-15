#!/usr/bin/env node
// Advanced Page Builder — end-to-end smoke tests (zero dependencies).
//
// Builds main.html, launches headless Chrome/Edge with a throw-away profile and the DevTools
// protocol, then runs every scenario in tests/e2e/scenarios/*.mjs (filename order) against
// file:///…/main.html. Each scenario gets a fresh browser context (isolated storage) and page.
// A scenario fails when it throws or when the page reports uncaught exceptions / console errors.
//
// Usage: node tests/e2e.mjs [filter…] [--browser <path>] [--headed] [--no-build] [--timeout <ms>]
//                           [--keep-profile] [--list]
// Env:   CHROME_PATH (browser executable), APB_E2E_TIMEOUT (global timeout in ms, default 60000)
// See tests/README.md for the scenario API.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build, ROOT } from '../tools/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, 'e2e', 'scenarios');
const ARTIFACTS_DIR = join(HERE, 'artifacts');
const APP_URL = pathToFileURL(join(ROOT, 'main.html')).href;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const opts = { filters: [], browser: '', headed: false, build: true, keepProfile: false, list: false,
    timeout: Number(process.env.APB_E2E_TIMEOUT) || 60000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--browser') opts.browser = value() || '';
    else if (flag === '--headed') opts.headed = true;
    else if (flag === '--no-build') opts.build = false;
    else if (flag === '--keep-profile') opts.keepProfile = true;
    else if (flag === '--list') opts.list = true;
    else if (flag === '--timeout') opts.timeout = Number(value()) || opts.timeout;
    else if (flag === '--help' || flag === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a);
    else opts.filters.push(a);
  }
  return opts;
}

function findBrowser(explicit) {
  const env = process.env;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error('--browser not found: ' + explicit);
    return explicit;
  }
  if (env.CHROME_PATH) {
    if (!existsSync(env.CHROME_PATH)) throw new Error('CHROME_PATH not found: ' + env.CHROME_PATH);
    return env.CHROME_PATH;
  }
  const candidates = [];
  if (IS_WIN) {
    const pf = env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    candidates.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(local, 'Chromium', 'Application', 'chrome.exe'));
  } else if (IS_MAC) {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      candidates.push(
        join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
    }
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable');
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error('No Chrome/Edge/Chromium found. Pass --browser <path> or set CHROME_PATH.\nLooked in:\n  ' + candidates.join('\n  '));
  }
  return found;
}

/* ------------------------------------------------------------- browser */

class Browser {
  constructor(exe, opts) {
    this.exe = exe;
    this.opts = opts;
    this.proc = null;
    this.profile = '';
    this.stderr = '';
    this.wsURL = '';
    this.exited = false;
  }

  launch() {
    this.profile = mkdtempSync(join(tmpdir(), 'apb-e2e-'));
    const args = [
      ...(this.opts.headed ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--user-data-dir=' + this.profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-breakpad',
      '--disable-client-side-phishing-detection', '--disable-popup-blocking', '--metrics-recording-only',
      '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,DialMediaRouteProvider',
      '--password-store=basic', '--use-mock-keychain', '--mute-audio',
      '--window-size=' + DEFAULT_VIEWPORT.width + ',' + DEFAULT_VIEWPORT.height,
      'about:blank'
    ];
    this.proc = spawn(this.exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(this.stderr);
      if (m && !this.wsURL) this.wsURL = m[1];
    });
    this.proc.on('exit', () => { this.exited = true; });
    this.proc.on('error', (err) => { this.exited = true; this.stderr += '\n' + err.message; });
  }

  /** Resolve the browser WebSocket endpoint (stderr line or DevToolsActivePort file), with retries. */
  async endpoint(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    const portFile = join(this.profile, 'DevToolsActivePort');
    while (Date.now() < deadline) {
      if (this.exited) throw new Error('Browser exited during startup.\n' + this.stderr.trim());
      if (this.wsURL) return this.wsURL;
      if (existsSync(portFile)) {
        try {
          const [port, path] = readFileSync(portFile, 'utf8').split(/\r?\n/);
          if (port && path) return 'ws://127.0.0.1:' + port.trim() + path.trim();
        } catch { /* file being written, retry */ }
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for the DevTools endpoint.\n' + this.stderr.trim());
  }

  async connect() {
    let lastError;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const url = await this.endpoint();
      try {
        return await CDP.connect(url, 5000);
      } catch (err) {
        lastError = err;
        if (this.exited) break;
        await sleep(Math.min(1000, 100 * attempt));
      }
    }
    throw new Error('Could not connect to the DevTools endpoint: ' + (lastError && lastError.message));
  }

  /** Synchronous and idempotent: safe to call from process 'exit'. */
  kill() {
    const p = this.proc;
    if (p && !this.exited && p.pid) {
      try {
        if (IS_WIN) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
        else p.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    this.exited = true;
  }

  removeProfile() {
    if (!this.profile || this.opts.keepProfile) return;
    try { rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* locked files: leave for the OS */ }
    this.profile = '';
  }

  async close(cdp) {
    if (cdp && !cdp.closed) {
      try { await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch { /* connection may drop */ }
      cdp.close();
    }
    if (this.proc && !this.exited) {
      await Promise.race([new Promise((r) => this.proc.once('exit', r)), sleep(3000)]);
    }
    this.kill();
    this.removeProfile();
  }
}

/* ----------------------------------------------------------------- CDP */

class CDP {
  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('Global WebSocket is unavailable: Node.js 22+ is required for e2e tests'));
        return;
      }
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('WebSocket connect timeout')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDP(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket error connecting to ' + url)); }, { once: true });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(p.method + ': ' + msg.error.message + (msg.error.data ? ' (' + msg.error.data + ')' : '')));
        else p.resolve(msg.result || {});
      } else if (msg.method) {
        for (const fn of Array.from(this.listeners)) {
          try { fn(msg); } catch (err) { console.error('CDP listener error:', err); }
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(p.method + ': DevTools connection closed')); }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(method + ': DevTools connection closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ': no response within ' + timeoutMs + ' ms'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------------- page */

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MODIFIER_KEYS = {
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 }
};
const NAMED_KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 }, Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }, Insert: { code: 'Insert', vk: 45 }
};
const KEY_ALIASES = { esc: 'Escape', del: 'Delete', return: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space' };
const PUNCTUATION = {
  '[': ['BracketLeft', 219, '{'], ']': ['BracketRight', 221, '}'], '=': ['Equal', 187, '+'], '-': ['Minus', 189, '_'],
  '/': ['Slash', 191, '?'], '\\': ['Backslash', 220, '|'], ';': ['Semicolon', 186, ':'], "'": ['Quote', 222, '"'],
  ',': ['Comma', 188, '<'], '.': ['Period', 190, '>'], '`': ['Backquote', 192, '~']
};
const SHIFTED_PUNCTUATION = { '?': '/', '+': '=', '{': '[', '}': ']', '_': '-', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '~': '`' };
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** 'Mod+Shift+Z' | ('z', ['Mod', 'Shift']) → { mods: Set<'Alt'|'Control'|'Meta'|'Shift'>, key } */
function parseCombo(combo, modifiers) {
  let parts;
  const src = String(combo);
  if (src.length > 1 && src.endsWith('++')) parts = src.slice(0, -2).split('+').concat('+');
  else if (src === '+') parts = ['+'];
  else parts = src.split('+');
  const extra = Array.isArray(modifiers) ? modifiers : typeof modifiers === 'string' && modifiers ? modifiers.split('+') : [];
  const mods = new Set();
  for (const m of parts.slice(0, -1).concat(extra)) {
    const l = m.trim().toLowerCase();
    if (l === 'mod') mods.add(IS_MAC ? 'Meta' : 'Control');
    else if (l === 'ctrl' || l === 'control') mods.add('Control');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else if (l === 'meta' || l === 'cmd' || l === 'command') mods.add('Meta');
    else if (l) throw new Error('page.key: unknown modifier "' + m + '"');
  }
  return { mods, key: parts[parts.length - 1] };
}

function keyDefinition(rawKey, mods) {
  let name = KEY_ALIASES[rawKey.toLowerCase()] || rawKey;
  if (SHIFTED_PUNCTUATION[name]) { mods.add('Shift'); name = SHIFTED_PUNCTUATION[name]; }
  const shift = mods.has('Shift');
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase();
    const ch = shift ? upper : upper.toLowerCase();
    return { key: ch, code: 'Key' + upper, vk: upper.charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(name)) {
    const ch = shift ? SHIFTED_DIGITS[Number(name)] : name;
    return { key: ch, code: 'Digit' + name, vk: 48 + Number(name), text: ch };
  }
  if (PUNCTUATION[name]) {
    const [code, vk, shifted] = PUNCTUATION[name];
    const ch = shift ? shifted : name;
    return { key: ch, code, vk, text: ch };
  }
  const named = Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (named) return Object.assign({ key: named }, NAMED_KEYS[named]);
  const fn = /^F([1-9]|1[0-2])$/i.exec(name);
  if (fn) return { key: 'F' + fn[1], code: 'F' + fn[1], vk: 111 + Number(fn[1]) };
  throw new Error('page.key: unsupported key "' + rawKey + '"');
}

function describeException(details) {
  if (!details) return 'Unknown error';
  const ex = details.exception;
  const text = (ex && (ex.description || (ex.value !== undefined ? String(ex.value) : ''))) || details.text || 'Error';
  const where = details.url ? ' (' + details.url.split('/').pop() + ':' + ((details.lineNumber || 0) + 1) + ':' + ((details.columnNumber || 0) + 1) + ')' : '';
  return text + where;
}

function remoteArg(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return arg.value;
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.description) return arg.description;
  if (arg.preview && arg.preview.properties) return '{' + arg.preview.properties.map((p) => p.name + ': ' + p.value).join(', ') + '}';
  return arg.type;
}

class Page {
  constructor(cdp, sessionId, targetId, scenarioSlug) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.slug = scenarioSlug;
    this.url = APP_URL;
    this.errors = [];
    this.logs = [];
    this.mouseButtons = 0;
    this.lastMouse = { x: 0, y: 0 };
    this.off = cdp.on((msg) => { if (msg.sessionId === sessionId) this.onEvent(msg); });
  }

  onEvent({ method, params }) {
    if (method === 'Runtime.exceptionThrown') {
      this.errors.push('Uncaught ' + describeException(params.exceptionDetails));
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = params.args.map(remoteArg).join(' ');
      this.logs.push('[console.' + params.type + '] ' + text);
      if (params.type === 'error' || params.type === 'assert') this.errors.push('console.' + params.type + ': ' + text);
    } else if (method === 'Log.entryAdded') {
      const e = params.entry;
      this.logs.push('[' + e.source + ':' + e.level + '] ' + e.text);
      if (e.level === 'error') this.errors.push(e.source + ' error: ' + e.text + (e.url ? ' (' + e.url + ')' : ''));
    } else if (method === 'Page.javascriptDialogOpening') {
      this.errors.push('Native ' + params.type + '() dialog opened: "' + params.message + '" (use app.ui dialogs instead)');
      this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    } else if (method === 'Inspector.targetCrashed') {
      this.errors.push('Renderer crashed');
    }
  }

  send(method, params = {}, timeoutMs) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  async init(viewport) {
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('Inspector.enable').catch(() => {})
    ]);
    await this.setViewport(viewport.width, viewport.height);
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    await this.send('Page.bringToFront').catch(() => {});
  }

  waitForEvent(method, timeoutMs = 15000) {
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.cdp.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === method) { clearTimeout(timer); off(); resolve(msg.params); }
      });
      timer = setTimeout(() => { off(); reject(new Error('Timed out waiting for ' + method)); }, timeoutMs);
    });
    promise.cancel = () => { clearTimeout(timer); off(); };
    promise.catch(() => {});
    return promise;
  }

  /** Navigate (default: the built app) and wait for the load event. */
  async goto(url = APP_URL, { timeout = 15000 } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', timeout);
    let res;
    try {
      res = await this.send('Page.navigate', { url });
    } catch (err) { loaded.cancel(); throw err; }
    if (res.errorText) { loaded.cancel(); throw new Error('Navigation to ' + url + ' failed: ' + res.errorText); }
    await loaded;
    this.url = url;
  }

  async reload({ timeout = 15000 } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', timeout);
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  /** Evaluate an expression string or a function (called with JSON-serialisable args). Promises are awaited. */
  async eval(exprOrFn, ...args) {
    const expression = typeof exprOrFn === 'function'
      ? '(' + exprOrFn.toString() + ')(...' + JSON.stringify(args) + ')'
      : String(exprOrFn);
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page.eval threw: ' + describeException(r.exceptionDetails));
    return r.result ? r.result.value : undefined;
  }

  /** Poll until the expression/function returns a truthy value; returns that value. */
  async waitFor(exprOrFn, timeout = 5000, interval = 50) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    for (;;) {
      try {
        const v = await this.eval(exprOrFn);
        if (v) return v;
        lastError = null;
      } catch (err) { lastError = err; }
      if (Date.now() >= deadline) {
        const what = typeof exprOrFn === 'function' ? exprOrFn.toString().slice(0, 160) : String(exprOrFn);
        throw new Error('page.waitFor timed out after ' + timeout + ' ms: ' + what + (lastError ? '\n  last error: ' + lastError.message : ''));
      }
      await sleep(interval);
    }
  }

  /** Wait until the app finished booting (APB.app.ready). */
  ready(timeout = 10000) {
    return this.waitFor('!!(window.APB && window.APB.app && window.APB.app.ready)', timeout);
  }

  async rect(selector) {
    return this.eval((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }, selector);
  }

  async mouse(type, x, y, { button = 'left', modifiers, clickCount = 1, buttons } = {}) {
    const mods = modifiers === undefined ? 0 : typeof modifiers === 'number' ? modifiers : this.modifierBits(parseCombo('x', modifiers).mods);
    const map = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
    const cdpType = map[type] || type;
    if (cdpType === 'mousePressed') this.mouseButtons |= button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    const params = { type: cdpType, x, y, modifiers: mods, button: cdpType === 'mouseMoved' && !this.mouseButtons ? 'none' : button,
      buttons: buttons !== undefined ? buttons : this.mouseButtons, clickCount: cdpType === 'mouseMoved' ? 0 : clickCount, pointerType: 'mouse' };
    if (cdpType === 'mouseReleased') this.mouseButtons = 0;
    this.lastMouse = { x, y };
    await this.send('Input.dispatchMouseEvent', params);
  }

  /** Click the centre of the first element matching selector (scrolled into view). */
  async click(selector, { button = 'left', modifiers, clickCount = 1 } = {}) {
    const box = await this.eval((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, selector);
    if (!box) throw new Error('page.click: no element matches ' + selector);
    if (!box.w || !box.h) throw new Error('page.click: element has no size: ' + selector);
    await this.mouse('move', box.x, box.y, { modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.mouse('down', box.x, box.y, { button, modifiers, clickCount: i });
      await this.mouse('up', box.x, box.y, { button, modifiers, clickCount: i });
    }
    return box;
  }

  /** Press-move-release from (x1, y1) to (x2, y2) in viewport coordinates. */
  async drag(x1, y1, x2, y2, { steps = 12, modifiers, button = 'left', stepDelay = 0 } = {}) {
    await this.mouse('move', x1, y1, { modifiers });
    await this.mouse('down', x1, y1, { button, modifiers });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.mouse('move', x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, { button, modifiers });
      if (stepDelay) await sleep(stepDelay);
    }
    await this.mouse('up', x2, y2, { button, modifiers });
  }

  async wheel(x, y, deltaX, deltaY, { modifiers } = {}) {
    const mods = modifiers === undefined ? 0 : this.modifierBits(parseCombo('x', modifiers).mods);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: mods, pointerType: 'mouse' });
  }

  modifierBits(mods) {
    let bits = 0;
    for (const m of mods) bits |= MODIFIER_BITS[m];
    return bits;
  }

  /**
   * Press a key: page.key('Mod+Shift+Z'), page.key('z', ['Mod', 'Shift']), page.key('Enter').
   * Mod = Meta on macOS, Control elsewhere. Events carry realistic key/code/keyCode values.
   */
  async key(combo, modifiers, { repeat = 1 } = {}) {
    const { mods, key } = parseCombo(combo, modifiers);
    const def = keyDefinition(key, mods);
    const bits = this.modifierBits(mods);
    const order = ['Control', 'Alt', 'Meta', 'Shift'].filter((m) => mods.has(m));
    let held = 0;
    for (const m of order) {
      held |= MODIFIER_BITS[m];
      const mk = MODIFIER_KEYS[m];
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk, modifiers: held });
    }
    const typesText = def.text && !(bits & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt));
    for (let i = 0; i < repeat; i++) {
      await this.send('Input.dispatchKeyEvent', {
        type: typesText ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.vk,
        nativeVirtualKeyCode: def.vk, modifiers: bits, autoRepeat: i > 0, text: typesText ? def.text : undefined,
        unmodifiedText: typesText ? def.text : undefined
      });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: bits });
    for (const m of order.reverse()) {
      held &= ~MODIFIER_BITS[m];
      const mk = MODIFIER_KEYS[m];
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk, modifiers: held });
    }
  }

  /** Insert text into the focused element (like typing, without per-key events). */
  async type(text) {
    await this.send('Input.insertText', { text: String(text) });
  }

  /** Set files on an <input type=file> matching selector (paths are local files). */
  async setFiles(selector, files) {
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error('page.setFiles: no element matches ' + selector);
    await this.send('DOM.setFileInputFiles', { nodeId, files: files.map(String) });
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  }

  /** Save a PNG to tests/artifacts/<scenario>-<name>.png and return its path. */
  async screenshot(name = 'shot') {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const safe = String(name).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'shot';
    const file = join(ARTIFACTS_DIR, this.slug + '-' + safe + '.png');
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  sleep(ms) { return sleep(ms); }

  clearErrors() { this.errors.length = 0; }

  /** Throw now if the page reported errors (optionally ignoring some patterns). */
  assertNoErrors(allow = []) {
    const errs = this.unexpectedErrors(allow);
    if (errs.length) throw new Error('Page reported errors:\n  ' + errs.join('\n  '));
  }

  unexpectedErrors(allow = []) {
    const patterns = (Array.isArray(allow) ? allow : [allow]).filter(Boolean);
    return this.errors.filter((e) => !patterns.some((p) => (p instanceof RegExp ? p.test(e) : e.includes(String(p)))));
  }

  dispose() { this.off(); }
}

/* -------------------------------------------------------------- runner */

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + ' ms')), ms); })
  ]).finally(() => clearTimeout(timer));
}

function formatMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}

function loadScenarioFiles(filters) {
  if (!existsSync(SCENARIO_DIR)) return [];
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .filter((f) => !filters.length || filters.some((q) => f.includes(q)));
}

async function runScenario(cdp, file) {
  const slug = basename(file, '.mjs');
  const started = Date.now();
  const mod = await import(pathToFileURL(join(SCENARIO_DIR, file)).href);
  const title = slug + (mod.name ? ': ' + mod.name : '');
  if (typeof mod.run !== 'function') return { title, ok: false, ms: 0, error: new Error('scenario must export async function run(page, ctx)') };

  let contextId;
  let targetId;
  let page;
  try {
    try {
      ({ browserContextId: contextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
    } catch { contextId = undefined; /* fall back to the default context */ }
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }));
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    page = new Page(cdp, sessionId, targetId, slug);
    await page.init(Object.assign({}, DEFAULT_VIEWPORT, mod.viewport || {}));
    if (contextId) await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: contextId }).catch(() => {});
    if (mod.autoLoad !== false) await page.goto(APP_URL);
    const ctx = { assert, appURL: APP_URL, root: ROOT, artifactsDir: ARTIFACTS_DIR, sleep, log: (...a) => console.log('      ' + a.join(' ')) };
    await withTimeout(Promise.resolve().then(() => mod.run(page, ctx)), mod.timeout || 30000, 'scenario');
    await sleep(100); // let late async errors surface
    page.assertNoErrors(mod.allowErrors);
    return { title, ok: true, ms: Date.now() - started };
  } catch (error) {
    let shot = '';
    if (page) { try { shot = await withTimeout(page.screenshot('failure'), 5000, 'screenshot'); } catch { /* ignore */ } }
    return { title, ok: false, ms: Date.now() - started, error, shot, logs: page ? page.logs.slice(-15) : [], errors: page ? page.errors.slice() : [] };
  } finally {
    if (page) page.dispose();
    if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 5000).catch(() => {});
    if (contextId) await cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }, undefined, 5000).catch(() => {});
  }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  if (opts.help) {
    console.log('Usage: node tests/e2e.mjs [filter…] [--browser <path>] [--headed] [--no-build] [--timeout <ms>] [--keep-profile] [--list]');
    return 0;
  }
  const files = loadScenarioFiles(opts.filters);
  if (opts.list) { files.forEach((f) => console.log(f)); return 0; }
  if (!files.length) { console.error('No e2e scenarios match' + (opts.filters.length ? ': ' + opts.filters.join(', ') : '')); return 1; }

  if (opts.build) {
    try { build({ quiet: true }); } catch (err) { console.error('Build failed: ' + err.message); return 1; }
  } else if (!existsSync(join(ROOT, 'main.html'))) {
    console.error('main.html is missing (run without --no-build)'); return 1;
  }

  const exe = findBrowser(opts.browser);
  const browser = new Browser(exe, opts);
  let cdp = null;
  let finished = false;
  const onExit = () => { if (!finished) { browser.kill(); browser.removeProfile(); } };
  process.on('exit', onExit);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { console.error('\nInterrupted'); process.exit(130); });
  const globalTimer = setTimeout(() => {
    console.error('\nE2E global timeout (' + opts.timeout + ' ms) exceeded — killing the browser. Raise it with --timeout <ms> or APB_E2E_TIMEOUT.');
    process.exit(1); // 'exit' handler kills the browser and removes the profile
  }, opts.timeout);

  const started = Date.now();
  const results = [];
  try {
    browser.launch();
    cdp = await browser.connect();
    const version = await cdp.send('Browser.getVersion').catch(() => ({ product: basename(exe) }));
    console.log('Advanced Page Builder e2e — ' + version.product + (opts.headed ? '' : ' (headless)'));
    console.log('  ' + APP_URL);
    for (const file of files) {
      const res = await runScenario(cdp, file);
      results.push(res);
      console.log('  ' + (res.ok ? '\u2714' : '\u2716') + ' ' + res.title + ' (' + formatMs(res.ms) + ')');
      if (!res.ok) {
        console.log('      ' + String((res.error && res.error.stack) || res.error).split('\n').join('\n      '));
        if (res.errors && res.errors.length) console.log('      page errors:\n        ' + res.errors.join('\n        '));
        if (res.logs && res.logs.length) console.log('      last page logs:\n        ' + res.logs.join('\n        '));
        if (res.shot) console.log('      screenshot: ' + res.shot);
      }
    }
  } catch (err) {
    console.error('E2E harness error: ' + (err && err.stack || err));
    results.push({ ok: false, title: 'harness', error: err });
  } finally {
    clearTimeout(globalTimer);
    await browser.close(cdp);
    finished = true;
  }
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  console.log((failed ? '\u2716 ' : '\u2714 ') + passed + ' passed, ' + failed + ' failed (' + formatMs(Date.now() - started) + ')');
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { debounceViewResize, terminalSize } from '../web/terminal-helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flush = () => new Promise((resolve) => setImmediate(resolve));

class MockElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName;
    this.id = id;
    this.children = [];
    this.parent = null;
    this.style = {};
    this.className = '';
    this.hidden = false;
    this.title = '';
    this._textContent = '';
    this.innerHTML = '';
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    };
  }
  set textContent(value) {
    this._textContent = String(value);
    if (value === '') this.children = [];
  }
  get textContent() { return this._textContent; }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

const mockView = () => {
  const listeners = new Map();
  return {
    attachment: null,
    destroyed: false,
    observe: false,
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    emit(type, detail) {
      for (const listener of listeners.get(type) || []) listener(detail);
    },
  };
};

test('terminalSize uses only real positive renderer dimensions', () => {
  assert.deepEqual(terminalSize({ terminal: { cols: 137, rows: 41 } }), { cols: 137, rows: 41 });
  assert.equal(terminalSize(null), null);
  assert.equal(terminalSize({}), null);
  assert.equal(terminalSize({ terminal: { cols: 0, rows: 41 } }), null);
  assert.equal(terminalSize({ terminal: { cols: 137.5, rows: 41 } }), null);
});

test('resize bursts send only the latest size after 200 ms of stability', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = mockView();
  const sent = [];
  const attachment = {
    open: true,
    resize(cols, rows) { sent.push({ cols, rows }); return true; },
  };
  const stop = debounceViewResize(view);
  view.attachment = attachment;
  view.emit('status', { state: 'attached' });

  attachment.resize(100, 30);
  t.mock.timers.tick(80);
  attachment.resize(110, 32);
  t.mock.timers.tick(80);
  attachment.resize(137, 41);
  t.mock.timers.tick(199);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, [{ cols: 137, rows: 41 }]);

  attachment.resize(120, 36);
  view.emit('status', { state: 'reconnecting' });
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, [{ cols: 137, rows: 41 }], 'reconnect cancelled the stale resize');

  const replacement = { open: true, resize(cols, rows) { sent.push({ cols, rows }); return true; } };
  view.attachment = replacement;
  view.emit('status', { state: 'attached' });
  replacement.resize(121, 37);
  view.destroyed = true;
  view.emit('status', { state: 'destroyed' });
  t.mock.timers.tick(1000);
  assert.deepEqual(sent, [{ cols: 137, rows: 41 }], 'destroy cancelled the pending resize');
  stop();
});

test('clicking New passes the active renderer dimensions to terminal.run', async () => {
  const ids = [
    'sidebar', 'conn-state', 'term-list', 'term-title', 'term-container',
    'mode-badge', 'btn-new', 'btn-kill', 'btn-observe',
  ];
  const elements = new Map(ids.map((id) => [id, new MockElement('div', id)]));
  const document = {
    body: new MockElement('body'),
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => elements.get(id),
  };
  const connections = [];

  class MockConnection {
    constructor() {
      this.listeners = new Map();
      this.calls = [];
      connections.push(this);
    }
    on(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      return () => this.listeners.get(type)?.delete(listener);
    }
    emit(type, detail) {
      for (const listener of this.listeners.get(type) || []) listener(detail);
    }
    connect() {
      queueMicrotask(() => {
        const terminals = [{ address: 't1', name: 'existing terminal', state: 'live' }];
        this.emit('terminals', { terminals });
        this.emit('status', { state: 'ready', attempt: 1 });
        this.emit('ready', { terminals });
      });
      return Promise.resolve(true);
    }
    async rpc(method, params) {
      this.calls.push({ method, params });
      if (method === 'terminal.run') return { address: 't2', name: 'new terminal', state: 'live' };
      return {};
    }
    destroy() {}
  }

  class MockView {
    constructor() {
      this.listeners = new Map();
      this.terminal = { cols: 137, rows: 41 };
      this.destroyed = false;
      this.observe = false;
      this.attachment = null;
    }
    on(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      return () => this.listeners.get(type)?.delete(listener);
    }
    emit(type, detail) {
      for (const listener of this.listeners.get(type) || []) listener(detail);
    }
    mount(wrapper) { this.wrapper = wrapper; }
    async attach(address, { observe }) {
      this.address = address;
      this.observe = observe;
      this.attachment = { open: true, resize() { return true; } };
      this.emit('status', { state: 'attached' });
      return this;
    }
    focus() {}
    destroy() { this.destroyed = true; }
  }

  const context = vm.createContext({
    window: { __TOKEN__: 'rw-token', __RO_TOKEN__: '' },
    document,
    location: { protocol: 'http:', host: '127.0.0.1:8787' },
    HerdConnection: MockConnection,
    HerdView: MockView,
    debounceViewResize,
    terminalSize,
    fetch: async () => ({ ok: true, json: async () => ({ cores: ['default'] }) }),
    requestAnimationFrame: (callback) => { callback(); return 1; },
    setInterval: () => 1,
    setTimeout,
    clearTimeout,
    console,
    URL,
    encodeURIComponent,
  });
  let source = await readFile(path.join(root, 'web', 'app.js'), 'utf8');
  source = source.replace("import { HerdConnection, HerdView } from 'herdview';", '');
  source = source.replace("import { debounceViewResize, terminalSize } from './terminal-helpers.js';", '');
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, context);
  await flush();
  await flush();

  await elements.get('btn-new').onclick();
  const run = connections[0].calls.find((call) => call.method === 'terminal.run');
  assert.ok(run, 'terminal.run was called');
  assert.equal(run.params.size.cols, 137);
  assert.equal(run.params.size.rows, 41);
  assert.deepEqual(Object.keys(run.params), ['size']);
});

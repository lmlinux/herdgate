import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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

test('clicking a cached core cancels a slow attach without misrouting kill', async () => {
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
  const slowAttaches = [];

  class MockConnection {
    constructor({ url }) {
      this.core = new URL(url).searchParams.get('core');
      this.listeners = new Map();
      this.calls = [];
      this.state = 'idle';
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
        const address = this.core === 'alpha' ? 'tA' : 'tB';
        const terminals = [{ address, name: `${this.core} terminal`, state: 'live' }];
        this.emit('terminals', { terminals });
        this.state = 'ready';
        this.emit('status', { state: 'ready', attempt: 1 });
        this.emit('ready', { terminals });
      });
      return Promise.resolve(true);
    }
    async rpc(method, params) {
      this.calls.push({ method, params });
      return {};
    }
    destroy() { this.state = 'destroyed'; }
  }

  class MockView {
    constructor(connection) {
      this.connection = connection;
      this.listeners = new Map();
      this.destroyed = false;
      this.observe = false;
      this.address = null;
    }
    on(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    mount(wrapper) { this.wrapper = wrapper; }
    attach(address, { observe }) {
      this.address = address;
      this.observe = observe;
      if (this.connection.core === 'beta') {
        return new Promise((resolve) => slowAttaches.push({ view: this, resolve: () => resolve(this) }));
      }
      return Promise.resolve(this);
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
    fetch: async () => ({ ok: true, json: async () => ({ cores: ['alpha', 'beta'] }) }),
    requestAnimationFrame: (callback) => { callback(); return 1; },
    setInterval: () => 1,
    console,
    URL,
    encodeURIComponent,
  });
  let source = await readFile(path.join(root, 'web', 'app.js'), 'utf8');
  source = source.replace("import { HerdConnection, HerdView } from 'herdview';", '');
  source = source.replace("import { debounceViewResize, terminalSize } from './terminal-helpers.js';", '');
  context.debounceViewResize = () => {};
  context.terminalSize = () => null;
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, context);
  await flush();
  await flush();

  const rows = () => elements.get('term-list').children.filter((row) => row.className.includes('term-item'));
  const alphaRow = rows().find((row) => row.title.startsWith('alpha:tA'));
  const betaRow = rows().find((row) => row.title.startsWith('beta:tB'));
  assert.ok(alphaRow && betaRow, 'both core rows rendered');

  const betaAttach = betaRow.onclick();
  assert.equal(slowAttaches.length, 1, 'beta attach is pending');
  await alphaRow.onclick();
  assert.equal(slowAttaches[0].view.destroyed, true, 'cached click cancelled the pending beta view');
  slowAttaches[0].resolve();
  await betaAttach;
  await flush();

  assert.match(elements.get('term-title').textContent, /^alpha:tA/);
  const visibleViews = elements.get('term-container').children
    .filter((child) => child.className === 'view-slot' && child.style.display !== 'none');
  assert.equal(visibleViews.length, 1, 'late beta completion did not replace the cached alpha view');

  await elements.get('btn-kill').onclick();
  const alpha = connections.find((connection) => connection.core === 'alpha');
  const beta = connections.find((connection) => connection.core === 'beta');
  const kills = alpha.calls.filter((call) => call.method === 'terminal.kill');
  assert.equal(kills.length, 1);
  assert.equal(kills[0].params.terminal, 'tA');
  assert.equal(beta.calls.some((call) => call.method === 'terminal.kill'), false);
});

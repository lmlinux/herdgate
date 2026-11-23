/**
 * herdgate frontend — one herdview connection per local herdr-core
 *
 * HerdConnection owns each core's WS lifecycle, terminal list and event stream.
 * HerdView owns a terminal pane on that same connection. Composite
 * [core, address] keys keep equal addresses on different cores independent.
 */

import { HerdConnection, HerdView } from 'herdview';

const TOKEN = window.__TOKEN__;
const IS_RO = !!window.__RO_TOKEN__ && window.__RO_TOKEN__ === TOKEN;
const CORE_REFRESH_MS = 5000;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const setConn = (text, cls = '') => {
  const el = $('conn-state');
  el.textContent = text;
  el.className = 'side-foot ' + cls;
};
const keyFor = (core, address) => JSON.stringify([core, address]);
const displayTitle = (core, address, name = '') => `${core}:${address}${name ? ` · ${name}` : ''}`;

// ---------------------------------------------------------------- sidebar toggle

const toggleBtn = document.createElement('button');
toggleBtn.id = 'btn-toggle-sidebar';
toggleBtn.textContent = '◀';
toggleBtn.style.cssText = 'position:fixed;left:var(--sidebar-width);top:50%;transform:translateY(-50%);z-index:10;background:var(--panel);border:1px solid var(--line);border-left:0;border-radius:0 6px 6px 0;color:var(--dim);cursor:pointer;padding:12px 6px;font-size:12px;transition:left 0.2s';
toggleBtn.onclick = () => {
  const sb = $('sidebar');
  sb.classList.toggle('collapsed');
  const collapsed = sb.classList.contains('collapsed');
  toggleBtn.textContent = collapsed ? '▶' : '◀';
  toggleBtn.style.left = collapsed ? '0px' : 'var(--sidebar-width)';
};
document.body.append(toggleBtn);

// ---------------------------------------------------------------- core state

const connections = new Map(); // core -> { connection, state }
const terms = new Map(); // JSON [core, address] -> terminal record + core/key
let discoveredCores = [];
let initialAttachDone = false;

let currentView = null;
let currentKey = '';
let currentCore = '';
let observePref = IS_RO;

function updateConnSummary() {
  const total = discoveredCores.length;
  const ready = [...connections.values()].filter((entry) => entry.state === 'ready').length;
  if (!total) setConn('no herdr-core sockets · retrying…');
  else setConn(`${ready}/${total} core(s) ready · ${terms.size} terminal(s)`, ready === total ? 'ok' : ready ? '' : 'bad');
  $('conn-state').title = [...connections]
    .map(([core, entry]) => `${core}: ${entry.state}`)
    .join('\n');
  $('btn-new').title = `New terminal on ${coreForNew() || 'the first available core'}`;
}

function replaceCoreTerminals(core, terminals) {
  for (const [key, terminal] of terms) {
    if (terminal.core === core) terms.delete(key);
  }
  for (const terminal of terminals) {
    if (!terminal?.address) continue;
    const key = keyFor(core, terminal.address);
    terms.set(key, { ...terminal, core, key });
  }
  updateConnSummary();
  scheduleRender();
}

function maybeAutoAttach() {
  if (initialAttachDone || currentKey) return;
  const live = [...terms.values()]
    .filter((terminal) => terminal.state !== 'finished')
    .sort((a, b) => a.core.localeCompare(b.core)
      || (a.created_ms || 0) - (b.created_ms || 0)
      || a.address.localeCompare(b.address));
  if (live.length) attachTo(live[0].key);
}

function connectCore(core) {
  if (connections.has(core)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = new HerdConnection({
    url: `${scheme}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}&core=${encodeURIComponent(core)}`,
    reconnect: true,
    reconnectDelay: 1000,
    maxReconnectDelay: 10000,
  });
  const entry = { connection, state: 'idle' };
  connections.set(core, entry);

  connection.on('status', (status) => {
    entry.state = status.state;
    updateConnSummary();
    if (status.state === 'ready') maybeAutoAttach();
  });
  connection.on('terminals', ({ terminals }) => replaceCoreTerminals(core, terminals));
  connection.on('ready', () => maybeAutoAttach());
  connection.on('error', ({ error }) => console.error(`[${core}]`, error));
  connection.connect().catch((error) => {
    console.error(`[${core}] connect failed`, error);
    updateConnSummary();
  });
  updateConnSummary();
}

function removeCore(core) {
  const entry = connections.get(core);
  if (!entry) return;
  entry.connection.destroy();
  connections.delete(core);
  for (const [key, terminal] of terms) {
    if (terminal.core === core) terms.delete(key);
  }
  if (pendingEntry?.core === core) {
    ++attachGen;
    destroyCurrentView();
  }
  for (const viewEntry of [...viewsByKey.values()]) {
    if (viewEntry.core === core) evictView(viewEntry);
  }
  if (currentCore === core) {
    currentView = null;
    currentKey = '';
    currentCore = '';
    setTitle(`${core} · disconnected`);
  }
  updateConnSummary();
  scheduleRender();
}

let refreshingCores = false;
async function refreshCores() {
  if (refreshingCores) return;
  refreshingCores = true;
  try {
    const response = await fetch(`/api/cores?token=${encodeURIComponent(TOKEN)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`core discovery returned HTTP ${response.status}`);
    const payload = await response.json();
    const names = [...new Set((payload.cores || []).filter((name) => typeof name === 'string' && name))];
    discoveredCores = names;
    for (const core of names) connectCore(core);
    for (const core of [...connections.keys()]) {
      if (!names.includes(core)) removeCore(core);
    }
    updateConnSummary();
  } catch (error) {
    console.error('core discovery:', error);
    setConn('core discovery failed · retrying…', 'bad');
  } finally {
    refreshingCores = false;
  }
}

// ---------------------------------------------------------------- sidebar

let renderQueued = false;
const scheduleRender = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
};

let showHistory = false;
const historyToggle = document.createElement('button');
historyToggle.className = 'side-action';
historyToggle.type = 'button';
historyToggle.textContent = 'show history';
historyToggle.setAttribute('aria-pressed', 'false');
historyToggle.onclick = () => {
  showHistory = !showHistory;
  historyToggle.textContent = showHistory ? 'hide history' : 'show history';
  historyToggle.setAttribute('aria-pressed', String(showHistory));
  renderList();
};
const sidebarFoot = document.createElement('div');
sidebarFoot.className = 'side-footer';
sidebarFoot.append($('conn-state'));
sidebarFoot.append(historyToggle);
$('sidebar').append(sidebarFoot);
const clearBtn = document.createElement('button');
clearBtn.id = 'btn-clear-finished';
clearBtn.type = 'button';
clearBtn.textContent = 'clear finished';
clearBtn.className = 'side-action';
clearBtn.onclick = async () => {
  const finished = [...terms.values()].filter((terminal) => terminal.state === 'finished');
  for (const terminal of finished) {
    try {
      await connections.get(terminal.core)?.connection.rpc('terminal.rm', { terminal: terminal.address });
    } catch (error) {
      console.error(error);
    }
  }
  scheduleRender();
};
sidebarFoot.append(clearBtn);

const span = (text, cls) => {
  const element = document.createElement('span');
  element.className = cls || '';
  element.textContent = text;
  return element;
};

function statusOf(terminal) {
  if (terminal.state === 'finished') return 'finished';
  return terminal.status?.state || terminal.status || 'idle';
}

// Persistent keyed rows avoid replacing a clicked node during active updates.
const liByKey = new Map();

function rowSig(terminal, on) {
  return [
    terminal.core,
    terminal.name,
    terminal.title,
    (terminal.argv && terminal.argv[0]) || terminal.agent || '',
    terminal.state,
    terminal.status?.msg || terminal.status,
    terminal.foreground?.name,
    terminal.cwd,
    on ? 1 : 0,
    terminal.state === 'finished' ? 1 : 0,
  ].join('\u0001');
}

function renderList() {
  const ul = $('term-list');
  const arr = [...terms.values()]
    .filter((terminal) => showHistory || terminal.state !== 'finished')
    .sort((a, b) => a.core.localeCompare(b.core)
      || (a.created_ms || 0) - (b.created_ms || 0)
      || a.address.localeCompare(b.address));
  ul.textContent = '';
  if (!arr.length) {
    ul.innerHTML = `<li class="empty">(${terms.size ? 'no active terminals' : 'no terminals yet'})</li>`;
    liByKey.clear();
    return;
  }
  const seen = new Set();
  for (const terminal of arr) {
    const key = terminal.key;
    seen.add(key);
    const on = currentKey === key;
    const sig = rowSig(terminal, on);
    let li = liByKey.get(key);
    if (li && li._sig === sig) {
      ul.appendChild(li);
      continue;
    }
    if (!li) {
      li = document.createElement('li');
      li.className = 'term-item';
      li.onclick = () => attachTo(key);
    }
    li.className = `term-item${on ? ' on' : ''}${terminal.state === 'finished' ? ' finished dim' : ''}`;
    li.title = `${displayTitle(terminal.core, terminal.address, terminal.name)} · ${terminal.cwd || ''}`;
    li.textContent = '';

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const argv0 = (terminal.argv && terminal.argv[0] && terminal.argv[0].split('/').pop()) || terminal.agent || '';
    const label = terminal.name || terminal.title || argv0 || '';
    row1.append(
      span(terminal.core, 'core-badge'),
      span(terminal.address, 'addr'),
      span(label, 'nm'),
      span('', `dot ${statusOf(terminal)}`),
    );

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const bits = [];
    if (terminal.status?.msg) bits.push(String(terminal.status.msg).slice(0, 40));
    if (terminal.foreground?.name) bits.push(terminal.foreground.name);
    if (terminal.cwd) bits.push(terminal.cwd);
    row2.textContent = bits.join(' · ');

    li.append(row1, row2);
    li._sig = sig;
    liByKey.set(key, li);
    ul.appendChild(li);
  }
  for (const key of [...liByKey.keys()]) {
    if (!seen.has(key)) liByKey.delete(key);
  }
}

// ---------------------------------------------------------------- terminal views

function setTitle(text) {
  $('term-title').textContent = text;
}

function setModeBadge(observe) {
  if (IS_RO) return;
  $('mode-badge').hidden = !observe;
}

// One live HerdView per [core, address], bound to the correct core connection.
const viewsByKey = new Map();
const VIEW_CACHE_MAX = 6;
let attachGen = 0;
let pendingEntry = null;

function evictView(entry) {
  if (!entry) return;
  viewsByKey.delete(entry.key);
  try { entry.view.destroy(); } catch {}
  entry.wrapper.remove();
}

function showEntry(entry) {
  for (const other of viewsByKey.values()) other.wrapper.style.display = 'none';
  entry.wrapper.style.display = '';
}

function destroyCurrentView() {
  if (pendingEntry) {
    try { pendingEntry.view.destroy(); } catch {}
    pendingEntry.wrapper.remove();
    pendingEntry = null;
  }
  currentView = null;
}

async function attachTo(key, { observe = observePref } = {}) {
  const terminal = terms.get(key);
  if (!terminal) return;
  initialAttachDone = true;
  const { core, address } = terminal;
  if (currentView && currentKey === key) return;
  currentKey = key;
  currentCore = core;

  const cached = viewsByKey.get(key);
  if (cached && !cached.view.destroyed) {
    // A slow attach on another core may still be pending. Cancel it before
    // showing this cached view, or its late completion could steal currentView
    // while currentCore stays here and misroute kill/observe actions.
    ++attachGen;
    destroyCurrentView();
    showEntry(cached);
    currentView = cached.view;
    setModeBadge(cached.view.observe);
    setTitle(displayTitle(core, address, cached.title || terminal.name));
    scheduleRender();
    return;
  }
  if (cached) evictView(cached);

  const coreEntry = connections.get(core);
  if (!coreEntry) {
    setTitle(displayTitle(core, address, 'core unavailable'));
    return;
  }

  const gen = ++attachGen;
  destroyCurrentView();
  setTitle(`${displayTitle(core, address)} · attaching…`);
  scheduleRender();

  const wrapper = document.createElement('div');
  wrapper.className = 'view-slot';
  $('term-container').appendChild(wrapper);
  const entry = { key, core, address, wrapper, title: '' };
  pendingEntry = entry;

  const view = new HerdView(coreEntry.connection, {
    history: 500,
    autoFocus: !observe,
    terminalOptions: {
      fontFamily: '"Maple Mono NF CN", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "NSimSun", ui-monospace, monospace',
      fontSize: 13,
    },
  });
  entry.view = view;
  view.mount(wrapper);

  view.on('status', (status) => {
    if (currentView === view) scheduleRender();
    if (status.state === 'closed') {
      const cachedEntry = viewsByKey.get(key);
      if (cachedEntry === entry) {
        evictView(entry);
        if (currentView === view) currentView = null;
      }
    }
  });
  view.on('title', ({ title }) => {
    entry.title = title || entry.title;
    if (currentView === view && title) setTitle(displayTitle(core, address, title));
  });

  try {
    await view.attach(address, { observe });
  } catch (error) {
    view.destroy();
    wrapper.remove();
    if (gen === attachGen) setTitle(displayTitle(core, address, `attach failed: ${error.message}`));
    if (pendingEntry === entry) pendingEntry = null;
    return;
  }
  if (gen !== attachGen) {
    view.destroy();
    wrapper.remove();
    if (pendingEntry === entry) pendingEntry = null;
    return;
  }
  if (pendingEntry === entry) pendingEntry = null;

  viewsByKey.set(key, entry);
  while (viewsByKey.size > VIEW_CACHE_MAX) {
    const oldest = viewsByKey.entries().next().value;
    if (oldest && oldest[1] !== entry) evictView(oldest[1]);
    else break;
  }

  showEntry(entry);
  currentView = view;
  setModeBadge(observe);
  setTitle(displayTitle(core, address, terminal.name));
  if (!observe) view.focus();
  scheduleRender();
}

if (IS_RO) {
  $('btn-new').style.display = 'none';
  $('btn-kill').style.display = 'none';
  $('btn-observe').style.display = 'none';
  clearBtn.style.display = 'none';
  $('mode-badge').hidden = false;
  $('mode-badge').textContent = '👁 read-only';
}

// ---------------------------------------------------------------- toolbar

function coreForNew() {
  if (currentCore && connections.has(currentCore)) return currentCore;
  if (discoveredCores.includes('default')) return 'default';
  return discoveredCores.find((core) => connections.get(core)?.state === 'ready') || discoveredCores[0] || '';
}

$('btn-observe').onclick = () => {
  observePref = !observePref;
  $('btn-observe').classList.toggle('on', observePref);
  if (currentKey) {
    const key = currentKey;
    const entry = viewsByKey.get(key);
    if (entry) evictView(entry);
    currentView = null;
    attachTo(key, { observe: observePref });
  }
};

$('btn-new').onclick = async () => {
  const core = coreForNew();
  const coreEntry = connections.get(core);
  if (!coreEntry) {
    setTitle('create failed: no herdr-core is available');
    return;
  }
  try {
    const record = await coreEntry.connection.rpc('terminal.run', { size: { cols: 110, rows: 32 } });
    if (record?.address) {
      const key = keyFor(core, record.address);
      terms.set(key, { ...record, core, key });
      scheduleRender();
      attachTo(key);
    }
  } catch (error) {
    console.error('btn-new:', error);
    setTitle(`${core} · create failed: ${error.message}`);
  }
};

$('btn-kill').onclick = async () => {
  if (!currentView || !currentCore) return;
  const core = currentCore;
  try {
    await connections.get(core)?.connection.rpc('terminal.kill', { terminal: currentView.address });
  } catch (error) {
    console.error('btn-kill:', error);
    setTitle(`${core} · kill failed: ${error.message}`);
  }
};

// ---------------------------------------------------------------- init

$('term-container').innerHTML = '<div class="hint">Pick a terminal on the left to attach, or click "+ New" for a shell.</div>';
await refreshCores();
setInterval(refreshCores, CORE_REFRESH_MS);

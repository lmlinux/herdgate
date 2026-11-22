/**
 * herdgate frontend — using herdview's HerdConnection + HerdView
 *
 * HerdConnection: WS lifecycle, auth, auto-reconnect, terminal list, event stream
 * HerdView: one terminal pane (mount, attach, observe, input, resize, focus, events)
 *
 * This file only handles the UI shell: sidebar, toolbar, container.
 * All protocol complexity lives in herdview.
 */

import { HerdConnection, HerdView } from 'herdview';

const TOKEN = window.__TOKEN__;
const IS_RO = !!window.__RO_TOKEN__ && window.__RO_TOKEN__ === TOKEN;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const setConn = (text, cls = '') => {
  const el = $('conn-state');
  el.textContent = text;
  el.className = 'side-foot ' + cls;
};

// ---------------------------------------------------------------- sidebar toggle
const toggleBtn = document.createElement('button');
toggleBtn.id = 'btn-toggle-sidebar';
toggleBtn.textContent = '◀';
toggleBtn.style.cssText = 'position:fixed;left:280px;top:50%;transform:translateY(-50%);z-index:10;background:var(--panel);border:1px solid var(--line);border-left:0;border-radius:0 6px 6px 0;color:var(--dim);cursor:pointer;padding:12px 6px;font-size:12px;transition:left 0.2s';
toggleBtn.onclick = () => {
  const sb = $('sidebar');
  sb.classList.toggle('collapsed');
  const collapsed = sb.classList.contains('collapsed');
  toggleBtn.textContent = collapsed ? '▶' : '◀';
  toggleBtn.style.left = collapsed ? '0px' : '280px';
};
document.body.append(toggleBtn);

// ---------------------------------------------------------------- connection

const connection = new HerdConnection({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`,
  reconnect: true,
  reconnectDelay: 1000,
  maxReconnectDelay: 10000,
});

connection.on('status', (s) => {
  if (s.state === 'connected') setConn('connected, subscribing…');
  else if (s.state === 'disconnected') setConn('disconnected — reconnecting…', 'bad');
  else if (s.state === 'reconnecting') setConn(`reconnecting… (attempt ${s.attempt || '?'})`, 'bad');
});

connection.on('terminals', ({ terminals }) => {
  terms.clear();
  for (const t of terminals) terms.set(t.address, t);
  setConn(`ready · ${terms.size} terminal(s)`, 'ok');
  scheduleRender();
});

// ---------------------------------------------------------------- sidebar

const terms = new Map();

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
  const finished = [...terms.values()].filter((t) => t.state === 'finished');
  for (const t of finished) {
    try { await connection.rpc('terminal.rm', { terminal: t.address }); } catch (e) { console.error(e); }
  }
  scheduleRender();
};
sidebarFoot.append(clearBtn);

const span = (text, cls) => {
  const s = document.createElement('span');
  s.className = cls || '';
  s.textContent = text;
  return s;
};

function statusOf(t) {
  if (t.state === 'finished') return 'finished';
  return t.status?.state || 'idle';
}

function renderList() {
  const ul = $('term-list');
  ul.innerHTML = '';
  const arr = [...terms.values()]
    .filter((t) => showHistory || t.state !== 'finished')
    .sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0));
  if (!arr.length) {
    ul.innerHTML = `<li class="empty">(${terms.size ? 'no active terminals' : 'no terminals yet'})</li>`;
    return;
  }
  for (const t of arr) {
    const li = document.createElement('li');
    li.className =
      'term-item' +
      (currentView && currentView.address === t.address ? ' on' : '') +
      (t.state === 'finished' ? ' finished dim' : '');
    li.title = `${t.address}${t.name ? ' · ' + t.name : ''} · ${t.cwd || ''}`;

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const argv0 = (t.argv && t.argv[0] && t.argv[0].split('/').pop()) || '';
    const label = t.name || t.title || argv0 || '';
    row1.append(span(t.address, 'addr'), span(label, 'nm'), span('', 'dot ' + statusOf(t)));

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const bits = [];
    if (t.status?.msg) bits.push(String(t.status.msg).slice(0, 40));
    if (t.foreground?.name) bits.push(t.foreground.name);
    if (t.cwd) bits.push(t.cwd);
    row2.textContent = bits.join(' · ');

    li.append(row1, row2);
    li.onclick = () => attachTo(t.address);
    ul.append(li);
  }
}

// ---------------------------------------------------------------- terminal view

let currentView = null;
let observePref = IS_RO; // read-only token forces observe

const termBox = $('term-container');

function setTitle(text) {
  $('term-title').textContent = text;
}

function destroyCurrentView() {
  if (currentView) {
    currentView.destroy();
    currentView = null;
  }
  termBox.innerHTML = '';
}

async function attachTo(addr, { observe = observePref } = {}) {
  destroyCurrentView();
  setTitle(`${addr} · attaching…`);

  const view = new HerdView(connection, {
    history: 500,
    autoFocus: !observe,
    terminalOptions: {
      fontFamily: '"Maple Mono NF CN", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "NSimSun", ui-monospace, monospace',
      fontSize: 13,
    },
  });
  view.mount(termBox);

  view.on('status', (s) => {
    if (currentView === view) scheduleRender();
  });
  view.on('title', ({ title }) => {
    if (currentView === view && title) setTitle(`${view.address} · ${title}`);
  });
  view.on('closed', (reason) => {
    if (currentView === view) {
      const why = reason?.reason
        ? `ended (${reason.reason}${reason.exit_code != null ? ', exit ' + reason.exit_code : ''})`
        : 'stream closed';
      setTitle(`${view.address} · ${why}`);
      currentView = null;
      scheduleRender();
    }
  });

  try {
    await view.attach(addr, { observe });
  } catch (e) {
    view.destroy();
    setTitle(`${addr} · attach failed: ${e.message}`);
    return;
  }

  currentView = view;
  $('mode-badge').hidden = !observe;
  setTitle(`${addr}${terms.get(addr)?.name ? ' · ' + terms.get(addr).name : ''}`);
  if (!observe) view.focus();
  scheduleRender();
}

if (IS_RO) {
  $('btn-new').style.display = 'none';
  $('btn-kill').style.display = 'none';
  // observe is locked on for read-only — the toggle must not offer a way out
  $('btn-observe').style.display = 'none';
  // clear-finished calls terminal.rm, which the gateway blocks for read-only
  $('btn-clear-finished').style.display = 'none';
  $('mode-badge').hidden = false;
  $('mode-badge').textContent = '👁 read-only';
}

// ---------------------------------------------------------------- toolbar

$('btn-observe').onclick = () => {
  observePref = !observePref;
  $('btn-observe').classList.toggle('on', observePref);
  if (currentView) attachTo(currentView.address, { observe: observePref });
};

$('btn-new').onclick = async () => {
  try {
    const rec = await connection.rpc('terminal.run', { size: { cols: 110, rows: 32 } });
    if (rec?.address) {
      terms.set(rec.address, rec);
      scheduleRender();
      attachTo(rec.address);
    }
  } catch (e) {
    console.error('btn-new:', e);
    setTitle(`create failed: ${e.message}`);
  }
};

$('btn-kill').onclick = async () => {
  if (!currentView) return;
  try {
    await connection.rpc('terminal.kill', { terminal: currentView.address });
  } catch (e) {
    console.error('btn-kill:', e);
    setTitle(`kill failed: ${e.message}`);
  }
};

// ---------------------------------------------------------------- init

(async () => {
  try {
    await connection.connect();
  } catch (e) {
    setConn(`connection failed: ${e.message}`, 'bad');
    return;
  }

  const live = [...terms.values()]
    .sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0))
    .find((t) => t.state !== 'finished');
  if (live) await attachTo(live.address);
  else termBox.innerHTML = '<div class="hint">Pick a terminal on the left to attach, or click "+ New" for a shell.</div>';
})();

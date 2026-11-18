import { HerdConnection, HerdView } from '../herdview/index.js';

const $ = (id) => document.getElementById(id);
const setConn = (text, cls = '') => {
  const element = $('conn-state');
  element.textContent = text;
  element.className = 'side-foot ' + cls;
};
const setTitle = (text) => {
  $('term-title').textContent = text;
};
const span = (text, cls) => {
  const element = document.createElement('span');
  element.className = cls || '';
  element.textContent = text;
  return element;
};
const statusOf = (terminal) => terminal.state === 'finished'
  ? 'finished'
  : terminal.status?.state || 'idle';

const connection = new HerdConnection({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  token: window.__TOKEN__,
});
const termBox = $('term-container');
const view = new HerdView(connection, {
  terminalOptions: {
    fontSize: 14,
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    cursorBlink: true,
    scrollback: 10000,
    theme: {
      background: '#1a1b26',
      foreground: '#a9b1d6',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
    },
  },
  history: 500,
}).mount(termBox);

let currentAddress = null;
let observePref = false;
let nameSeq = 0;
let renderQueued = false;

const scheduleRender = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
};

function renderList() {
  const list = $('term-list');
  if (connection.state === 'ready') setConn(`ready · ${connection.terminals.length} terminal(s)`, 'ok');
  list.innerHTML = '';
  const terminals = [...connection.terminals].sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0));
  if (!terminals.length) {
    list.innerHTML = '<li class="empty">(no terminals yet)</li>';
    return;
  }
  for (const terminal of terminals) {
    const item = document.createElement('li');
    item.className = 'term-item' +
      (currentAddress === terminal.address ? ' on' : '') +
      (terminal.state === 'finished' ? ' finished' : '');
    item.title = `${terminal.address}${terminal.name ? ' · ' + terminal.name : ''} · ${terminal.cwd || ''}`;

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const argv0 = terminal.argv?.[0]?.split('/').pop() || '';
    const label = terminal.name || terminal.title || argv0 || '';
    row1.append(
      span(terminal.address, 'addr'),
      span(label, 'nm'),
      span('', 'dot ' + statusOf(terminal)),
    );

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const bits = [];
    if (terminal.status?.msg) bits.push(String(terminal.status.msg).slice(0, 40));
    if (terminal.foreground?.name) bits.push(terminal.foreground.name);
    if (terminal.cwd) bits.push(terminal.cwd);
    row2.textContent = bits.join(' · ');
    item.append(row1, row2);
    item.onclick = () => attachTo(terminal.address);
    list.append(item);
  }
}

async function attachTo(address, { observe = observePref } = {}) {
  try {
    await view.attach(address, { observe });
  } catch {}
}

connection.on('status', ({ state, reason }) => {
  if (state === 'connecting') setConn('connecting…');
  else if (state === 'connected') setConn('connected, subscribing…');
  else if (state === 'ready') setConn(`ready · ${connection.terminals.length} terminal(s)`, 'ok');
  else if (state === 'reconnecting') setConn(`disconnected${reason ? ': ' + reason : ''} · reconnecting…`, 'bad');
  else if (state === 'disconnected') setConn(`disconnected${reason ? ': ' + reason : ''}`, 'bad');
});
connection.on('error', () => setConn('connection error', 'bad'));
connection.on('terminals', scheduleRender);

view.on('status', ({ state, address, observe, terminal, reason, error }) => {
  if (state === 'attaching') {
    currentAddress = null;
    $('mode-badge').hidden = !observe;
    setTitle(`${address} · attaching…`);
  } else if (state === 'attached') {
    currentAddress = address;
    $('mode-badge').hidden = !observe;
    setTitle(`${address}${terminal?.name ? ' · ' + terminal.name : ''}`);
  } else if (state === 'reconnecting') {
    currentAddress = null;
    setTitle(`${address} · reconnecting…`);
  } else if (state === 'closed') {
    currentAddress = null;
    const why = reason?.reason
      ? `ended (${reason.reason}${reason.exit_code != null ? ', exit ' + reason.exit_code : ''})`
      : 'stream closed';
    setTitle(`${address} · ${why}`);
  } else if (state === 'error') {
    currentAddress = null;
    setTitle(`${address} · attach failed: ${error.message}`);
  }
  scheduleRender();
});
view.on('title', ({ title }) => {
  if (currentAddress) setTitle(`${currentAddress} · ${title}`);
});
view.on('error', ({ error }) => setTitle(`attach failed: ${error.message}`));

$('btn-observe').onclick = () => {
  observePref = !observePref;
  $('btn-observe').classList.toggle('on', observePref);
  if (currentAddress) attachTo(currentAddress, { observe: observePref });
};

$('btn-new').onclick = async () => {
  const name = 'web-' + ++nameSeq;
  try {
    const terminal = await connection.rpc('terminal.run', { name, size: { cols: 110, rows: 32 } });
    if (terminal?.address) {
      scheduleRender();
      attachTo(terminal.address);
    }
  } catch (error) {
    setTitle(`create failed: ${error.message}`);
  }
};

$('btn-kill').onclick = async () => {
  if (!currentAddress) return;
  try {
    await connection.rpc('terminal.kill', { terminal: currentAddress });
  } catch (error) {
    setTitle(`kill failed: ${error.message}`);
  }
};

(async () => {
  try {
    await connection.connect();
    const live = [...connection.terminals]
      .sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0))
      .find((terminal) => terminal.state !== 'finished');
    if (live) await attachTo(live.address);
    else termBox.innerHTML = '<div class="hint">Pick a terminal on the left to attach, or click "+ New" for a shell.</div>';
  } catch (error) {
    setConn(`subscribe failed: ${error.message}`, 'bad');
  }
})();

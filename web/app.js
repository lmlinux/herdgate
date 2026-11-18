/**
 * herdr-web frontend
 *
 * The browser speaks herdr-core's framed protocol directly (the gateway only
 * authenticates and passes bytes through):
 *   - text WS messages = JSON-RPC requests (gateway wraps them as channel 0
 *     DATA frames)
 *   - binary WS messages = hc frames (DATA/CREDIT/RESIZE/FOCUS/CLOSE of the
 *     attach stream)
 * The sidebar is driven by terminal.list + the events.subscribe stream; the
 * main pane renders the attach stream with ghostty-web (first paint plus
 * incremental bytes). Every DATA frame is credited right after being
 * consumed — herdr-core's backpressure semantics hold end to end.
 */

import { init, Terminal, FitAddon } from '/vendor/ghostty-web.js';
import { createJsonLineParser } from '/json-lines.js';

const TOKEN = window.__TOKEN__;
const enc = new TextEncoder();
const dec = new TextDecoder();

// hc frame kinds
const KDATA = 0, KCREDIT = 1, KCLOSE = 2, KRESIZE = 3, KFOCUS = 4;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const setConn = (text, cls = '') => {
  const el = $('conn-state');
  el.textContent = text;
  el.className = 'side-foot ' + cls;
};

function frameBytes(channel, kind, payload) {
  const p = payload == null ? new Uint8Array(0) : payload;
  const out = new Uint8Array(9 + p.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, channel, true);
  dv.setUint8(4, kind);
  dv.setUint32(5, p.byteLength, true);
  out.set(p, 9);
  return out;
}
const sendFrame = (ch, kind, payload) => {
  if (ws.readyState === 1) ws.send(frameBytes(ch, kind, payload));
};
const creditBytes = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const resizeBytes = (cols, rows) => {
  const b = new Uint8Array(4);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, cols, true);
  dv.setUint16(1, rows, true);
  return b;
};

// ---------------------------------------------------------------- WebSocket

const ws = new WebSocket(
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`,
);
ws.binaryType = 'arraybuffer';

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
const roles = new Map();   // channel -> {type:'events'} | {type:'attach', addr, observe}
const terms = new Map();   // address -> Terminal record
const jsonParsers = new Map(); // channel -> incremental JSON-lines parser
let resolveGatewayReady;
const gatewayReady = new Promise((resolve) => { resolveGatewayReady = resolve; });
let gatewayIsReady = false;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 20000);
  });
}

ws.onopen = () => setConn('connected, subscribing…');
ws.onerror = () => setConn('connection error', 'bad');
ws.onclose = (e) => {
  setConn(`disconnected${e.reason ? ': ' + e.reason : ''}`, 'bad');
  resolveGatewayReady(false);
  for (const [, p] of pending) p.reject(new Error('connection closed'));
  pending.clear();
};

function handleJsonLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  } else if (msg.method) {
    handleNotification(msg);
  }
}

ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    // gateway control messages
    try {
      const c = JSON.parse(ev.data);
      if (c.type === 'gateway' && c.event === 'ready') {
        gatewayIsReady = true;
        setConn('ready');
        resolveGatewayReady(true);
      }
    } catch {}
    return;
  }

  const buf = new Uint8Array(ev.data);
  if (buf.length < 9) return;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const channel = dv.getUint32(0, true);
  const kind = dv.getUint8(4);
  const len = dv.getUint32(5, true);
  if (9 + len !== buf.length) return; // incomplete/malformed frame
  const payload = buf.subarray(9);

  const role = roles.get(channel);
  if (role && role.type === 'attach') {
    if (kind === KDATA) {
      if (cur && cur.channel === channel && cur.term) {
        cur.term.write(payload); // feed ghostty-web (the WASM parser takes incremental bytes)
        sendFrame(channel, KCREDIT, creditBytes(payload.byteLength)); // backpressure: return credit as we consume
      }
    } else if (kind === KCLOSE) {
      onStreamClosed(channel, payload);
    }
    // RESIZE frames only arrive for observers that opted into
    // resize_notifications; this MVP does not
    return;
  }

  if (kind !== KDATA) return;
  // channel 0 (RPC replies) and the events channel: JSON lines
  let parse = jsonParsers.get(channel);
  if (!parse) {
    parse = createJsonLineParser(handleJsonLine);
    jsonParsers.set(channel, parse);
  }
  parse(payload);
  sendFrame(channel, KCREDIT, creditBytes(payload.byteLength)); // the event stream needs credit too
};

// ---------------------------------------------------------------- event stream

function handleNotification(msg) {
  switch (msg.method) {
    case 'event':
      applyEvent(msg.params);
      break;
    case 'missed': // this subscriber fell behind: the params are a fresh snapshot — replace wholesale
      terms.clear();
      for (const t of msg.params.terminals || []) terms.set(t.address, t);
      scheduleRender();
      break;
    case 'heartbeat':
      break;
  }
}

function applyEvent(p) {
  const t = terms.get(p.terminal);
  const d = p.data || {};
  switch (p.type) {
    case 'created':
    case 'restarted':
      terms.set(p.terminal, d);
      break;
    case 'removed':
      terms.delete(p.terminal);
      break;
    case 'labels':
      if (t) {
        t.labels = d.labels;
        if (d.record) terms.set(p.terminal, d.record);
      }
      break;
    case 'finished':
      if (t) Object.assign(t, d, { state: 'finished' });
      break;
    case 'lost':
      if (t) Object.assign(t, d);
      break;
    case 'keep':
      if (t) t.keep = d.keep;
      break;
    case 'status':
      if (t) {
        t.status = d.status;
        t.records = d.records;
        t.reported = d.reported;
      }
      break;
    case 'turn':
      if (t) t.turn = d.turn;
      break;
    case 'title':
      if (t) t.title = d.title;
      break;
    case 'size':
      if (t) {
        t.cols = d.cols;
        t.rows = d.rows;
      }
      break;
    case 'foreground':
      if (t) t.foreground = d;
      break;
  }
  scheduleRender();
}

// ---------------------------------------------------------------- sidebar rendering

let renderQueued = false;
const scheduleRender = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
};

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
  if (gatewayIsReady && ws.readyState === 1) setConn(`ready · ${terms.size} terminal(s)`, 'ok');
  ul.innerHTML = '';
  const arr = [...terms.values()].sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0));
  if (!arr.length) {
    ul.innerHTML = '<li class="empty">(no terminals yet)</li>';
    return;
  }
  for (const t of arr) {
    const li = document.createElement('li');
    li.className =
      'term-item' +
      (cur && cur.addr === t.address ? ' on' : '') +
      (t.state === 'finished' ? ' finished' : '');
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

// ---------------------------------------------------------------- attach

let cur = null; // {channel, addr, term, fit, observe}
let observePref = false;
let nameSeq = 0;
let attachSeq = 0;

const termBox = $('term-container');

function setTitle(text) {
  $('term-title').textContent = text;
}

function detachCurrent() {
  if (!cur) return;
  const { channel, term, fit } = cur;
  roles.delete(channel);
  sendFrame(channel, KCLOSE, new Uint8Array(0)); // detach politely
  try {
    fit?.dispose();
    term?.dispose();
  } catch {}
  cur = null;
}

async function attachTo(addr, { observe = observePref } = {}) {
  const seq = ++attachSeq;
  detachCurrent();
  termBox.innerHTML = '';
  setTitle(`${addr} · attaching…`);

  const term = new Terminal({
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
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termBox);
  try {
    fit.fit();
    fit.observeResize(); // container size changes → auto cols/rows → onResize → RESIZE frame
  } catch {}

  term.onData((d) => {
    if (cur && cur.term === term && !cur.observe) {
      sendFrame(cur.channel, KDATA, enc.encode(d));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (cur && cur.term === term && !cur.observe) {
      sendFrame(cur.channel, KRESIZE, resizeBytes(cols, rows));
    }
  });
  term.onTitleChange?.((t) => {
    if (cur && cur.term === term && t) setTitle(`${cur.addr} · ${t}`);
  });

  let res;
  try {
    res = await rpc('terminal.attach', {
      terminal: addr,
      cols: term.cols || 100,
      rows: term.rows || 30,
      history: 500,
      observe,
    });
  } catch (e) {
    fit.dispose();
    term.dispose();
    if (seq === attachSeq) setTitle(`${addr} · attach failed: ${e.message}`);
    return;
  }

  if (seq !== attachSeq) {
    sendFrame(res.channel, KCLOSE, new Uint8Array(0));
    fit.dispose();
    term.dispose();
    return;
  }
  cur = { type: 'attach', channel: res.channel, addr, term, fit, observe };
  roles.set(res.channel, cur);
  if (res.terminal) {
    terms.set(res.terminal.address, res.terminal);
    scheduleRender();
  }
  $('mode-badge').hidden = !observe;
  setTitle(`${addr}${res.terminal?.name ? ' · ' + res.terminal.name : ''}`);
  if (!observe) {
    sendFrame(res.channel, KFOCUS, new Uint8Array([1]));
    term.focus();
  }
  scheduleRender();
}

function onStreamClosed(channel, payload) {
  let reason = '';
  try {
    reason = JSON.parse(dec.decode(payload));
  } catch {}
  const who = roles.get(channel);
  roles.delete(channel);
  if (cur && cur.channel === channel) {
    const why = reason?.reason
      ? `ended (${reason.reason}${reason.exit_code != null ? ', exit ' + reason.exit_code : ''})`
      : 'stream closed';
    setTitle(`${cur.addr} · ${why}`);
    cur = null;
    scheduleRender();
  } else if (who) {
    console.log('stream closed', channel, reason);
  }
}

// window focus → FOCUS frames (only a viewer may report focus)
window.addEventListener('focus', () => {
  if (cur && !cur.observe) sendFrame(cur.channel, KFOCUS, new Uint8Array([1]));
});
window.addEventListener('blur', () => {
  if (cur && !cur.observe) sendFrame(cur.channel, KFOCUS, new Uint8Array([0]));
});

// ---------------------------------------------------------------- toolbar

$('btn-observe').onclick = () => {
  observePref = !observePref;
  $('btn-observe').classList.toggle('on', observePref);
  if (cur) attachTo(cur.addr, { observe: observePref });
};

$('btn-new').onclick = async () => {
  const name = 'web-' + ++nameSeq;
  try {
    const rec = await rpc('terminal.run', { name, size: { cols: 110, rows: 32 } });
    if (rec?.address) {
      terms.set(rec.address, rec);
      scheduleRender();
      attachTo(rec.address);
    }
  } catch (e) {
    setTitle(`create failed: ${e.message}`);
  }
};

$('btn-kill').onclick = async () => {
  if (!cur) return;
  try {
    await rpc('terminal.kill', { terminal: cur.addr });
  } catch (e) {
    setTitle(`kill failed: ${e.message}`);
  }
};

// ---------------------------------------------------------------- startup

(async () => {
  try {
    await init(); // load the ghostty WASM (same-origin static asset)
  } catch (e) {
    setConn('WASM load failed', 'bad');
    console.error(e);
    return;
  }

  try {
    if (!gatewayIsReady && !(await gatewayReady)) throw new Error('gateway disconnected before ready');
    const sub = await rpc('events.subscribe', {});
    if (sub.channel != null) roles.set(sub.channel, { type: 'events' });
    for (const t of sub.terminals || []) terms.set(t.address, t);
    setConn(`ready · ${terms.size} terminal(s)`, 'ok');
    scheduleRender();

    const live = [...terms.values()]
      .sort((a, b) => (a.created_ms || 0) - (b.created_ms || 0))
      .find((t) => t.state !== 'finished');
    if (live) await attachTo(live.address);
    else termBox.innerHTML = '<div class="hint">Pick a terminal on the left to attach, or click "+ New" for a shell.</div>';
  } catch (e) {
    setConn(`subscribe failed: ${e.message}`, 'bad');
  }
})();

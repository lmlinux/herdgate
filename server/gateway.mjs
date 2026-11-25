#!/usr/bin/env node
/**
 * herdgate gateway — the bridge between the browser and herdr-core
 *
 * Deliberately minimal:
 *   1. Serves the static frontend (with a same-origin WebSocket token)
 *   2. WebSocket auth (token + same-origin Origin check)
 *   3. One `hc connect` child process per browser/core WebSocket connection:
 *        - discovery: public <name>.sock endpoints in the user's runtime dir
 *        - selection: /ws?core=<name> appends --session <name> to HC_CONNECT
 *        - handshake: plain JSON line hello{framed:true} → binary frames after
 *        - browser binary messages = hc frames, written to the child's stdin as-is
 *        - browser text messages   = JSON-RPC requests, wrapped as channel 0 DATA frames
 *        - child stdout is reassembled into complete frames and forwarded verbatim
 *      The gateway never parses or rewrites business semantics (CREDIT/RESIZE
 *      frames flow browser ↔ core directly), so herdr-core's flow control
 *      (backpressure) semantics hold end to end.
 *
 * By default the gateway discovers every local core and runs one child per
 * selected core. Explicit HC_CONNECT="ssh box hc connect" always retains the
 * original single-upstream behavior and cannot be combined with HC_CORES.
 *
 * Security: loopback bind by default; a non-loopback bind requires an explicit
 * HERDR_WEB_TOKEN — put TLS / a reverse proxy in front yourself.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createCoreRefresher, defaultSocketDir, parseCoreList } from './cores.mjs';

if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
  process.stdout.write(`Usage: herdgate [--help]

Options:
  -h, --help       Show this help and exit

Environment variables:
  PORT             HTTP/WebSocket port (default: 8787)
  HOST             Bind address (default: 127.0.0.1)
  HC_CONNECT       Command used to connect to one herdr-core (default: hc connect)
                   Explicitly setting this forces single-core mode; cannot combine with HC_CORES
  HC_CORES         Comma-separated core names; uses hc connect --session NAME per connection
  HC_SOCKET_DIR    Core socket directory (default: $XDG_RUNTIME_DIR/herdr-core)
  HERDR_WEB_TOKEN  Browser/WebSocket token (required for a non-loopback HOST)
`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');

// ---------------------------------------------------------------- config

const intEnv = (name, dflt) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : dflt;
};

const PORT = intEnv('PORT', 8787);
const HOST = process.env.HOST || '127.0.0.1';
const HC_CONNECT = process.env.HC_CONNECT || 'hc connect';
const HC_SOCKET_DIR = process.env.HC_SOCKET_DIR || defaultSocketDir();
const configuredCores = parseCoreList(process.env.HC_CORES || '');
// Explicit HC_CONNECT is always the backwards-compatible single-upstream mode
// (including ssh). Named multi-core sessions use the default hc connect command.
if (process.env.HC_CONNECT && configuredCores.length) {
  console.error('HC_CONNECT forces single-core mode and cannot be combined with HC_CORES; use HC_CORES with the default hc connect command.');
  process.exit(1);
}
const singleCore = Boolean(process.env.HC_CONNECT);
let availableCores = singleCore ? ['default'] : [...configuredCores];
const refreshDiscoveredCores = createCoreRefresher(HC_SOCKET_DIR);

async function refreshCores() {
  if (!singleCore && configuredCores.length === 0) {
    availableCores = await refreshDiscoveredCores();
  }
  return availableCores;
}

await refreshCores();
const discoveryTimer = setInterval(() => {
  refreshCores().catch((error) => console.error(`[discovery] ${error.message}`));
}, 5000);
discoveryTimer.unref();

function selectCore(requested) {
  if (singleCore) {
    return !requested || requested === 'default' ? { label: 'default', session: '' } : null;
  }
  if (requested) {
    return availableCores.includes(requested) ? { label: requested, session: requested } : null;
  }
  // A client that predates ?core= retains hc connect's own default behavior.
  // The current browser always supplies an explicit discovered core name.
  const label = availableCores.includes('default') ? 'default' : availableCores[0] || 'default';
  return { label, session: availableCores.length ? label : '' };
}

const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
const configuredToken = process.env.HERDR_WEB_TOKEN || '';
const TOKEN = configuredToken || randomBytes(24).toString('base64url');
const pageNeedsToken = Boolean(configuredToken) || !isLoopback(HOST);
const tokenMatches = (candidate) => {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(TOKEN);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
};
const validHost = (req) => {
  if (!isLoopback(HOST)) return true;
  try {
    const hostname = new URL(`http://${req.headers.host || ''}`).hostname.replace(/^\[|\]$/g, '');
    return isLoopback(hostname);
  } catch {
    return false;
  }
};
if (!isLoopback(HOST)) {
  if (!configuredToken) {
    console.error('HOST is not loopback; set HERDR_WEB_TOKEN to an explicit secret before starting.');
    process.exit(1);
  }
  console.warn(`[warn] HOST=${HOST} is not loopback: use TLS and a trusted access-controlled network or reverse proxy.`);
}

// ------------------------------------------------- locate ghostty-web assets

let ghosttyRoot;
try {
  // ./ghostty-vt.wasm is in the exports map, so it always resolves; use it
  // to derive the package root
  ghosttyRoot = path.dirname(require.resolve('ghostty-web/ghostty-vt.wasm'));
} catch {
  console.error('ghostty-web package not found; run: npm install');
  process.exit(1);
}
const DIST_JS = path.join(ghosttyRoot, 'dist', 'ghostty-web.js');
const WASM = path.join(ghosttyRoot, 'ghostty-vt.wasm');
for (const f of [DIST_JS, WASM]) {
  if (!existsSync(f)) {
    console.error(`ghostty-web asset missing: ${f}`);
    process.exit(1);
  }
}

// ------------------------------------------------------------- frame codec

const KDATA = 0;
const KAUTO = 6;
const HDR = 9; // [channel u32 LE][kind u8][len u32 LE]
const MAX_PAYLOAD = 16 * 1024 * 1024; // protocol limit; oversized frames kill the link

function encodeFrame(channel, kind, payload) {
  const head = Buffer.alloc(HDR);
  head.writeUInt32LE(channel, 0);
  head.writeUInt8(kind, 4);
  head.writeUInt32LE(payload.length, 5);
  return Buffer.concat([head, payload]);
}

/** Reassembles arbitrary stdout chunks into complete frames
 *  (WS messages have boundaries; hc frames do not). */
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= HDR) {
      const len = this.buf.readUInt32LE(5);
      if (len > MAX_PAYLOAD) throw new Error(`oversized frame ${len}`);
      if (this.buf.length < HDR + len) break;
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf.readUInt8(4);
      const payload = this.buf.subarray(HDR, HDR + len);
      this.buf = this.buf.subarray(HDR + len);
      frames.push({ channel, kind, payload });
    }
    return frames;
  }
}

// ------------------------------------------------------------- static files

function loadStatic() {
  // index.html stays a raw template: the token is injected per-visit (see the
  // GET handler), so the browser can authenticate its WebSocket connections.
  const html = readFileSync(path.join(WEB_ROOT, 'index.html'), 'utf8');
  return new Map([
    ['/', { body: Buffer.from(html, 'utf8'), type: 'text/html; charset=utf-8', template: true }],
    ['/app.js', { body: readFileSync(path.join(WEB_ROOT, 'app.js')), type: 'text/javascript; charset=utf-8' }],
    ['/terminal-helpers.js', { body: readFileSync(path.join(WEB_ROOT, 'terminal-helpers.js')), type: 'text/javascript; charset=utf-8' }],
    ['/app.css', { body: readFileSync(path.join(WEB_ROOT, 'app.css')), type: 'text/css; charset=utf-8' }],
    // bundled dual-width terminal font (webfonts, ~6MB per weight)
    ...(['MapleMono-NF-CN-Regular.woff2', 'MapleMono-NF-CN-Bold.woff2'].map((f) => [
      `/fonts/${f}`,
      { body: readFileSync(path.join(WEB_ROOT, 'fonts', f)), type: 'font/woff2', cache: 'public, max-age=604800' },
    ])),
    ['/fonts/MapleMono-LICENSE.txt', { body: readFileSync(path.join(WEB_ROOT, 'fonts', 'MapleMono-LICENSE.txt')), type: 'text/plain; charset=utf-8' }],
    // web/json-lines.js was removed (app.js imports from herdview now);
    // herdview's json-lines is served at /vendor/json-lines.js below
    // herdview: serve from a sibling directory (dev) or node_modules (npm);
    // skip if neither exists (CI checkout has no sibling)
    ...((() => {
      const herdviewRoot = [
        path.join(__dirname, '..', '..', 'herdview'),
        path.join(__dirname, '..', 'node_modules', 'herdview'),
      ].find((d) => existsSync(path.join(d, 'index.js')));
      if (!herdviewRoot) return [];
      return [
        ['/vendor/herdview.js', { body: readFileSync(path.join(herdviewRoot, 'index.js')), type: 'text/javascript; charset=utf-8' }],
        // herdview's ./json-lines.js relative import resolves to /vendor/json-lines.js
        ['/vendor/json-lines.js', { body: readFileSync(path.join(herdviewRoot, 'json-lines.js')), type: 'text/javascript; charset=utf-8' }],
      ];
    })()),
    ['/vendor/ghostty-web.js', { body: readFileSync(DIST_JS), type: 'text/javascript; charset=utf-8' }],
    // the vite build of ghostty-web.js imports this stub from its own directory
    ['/vendor/__vite-browser-external-2447137e.js', {
      body: readFileSync(path.join(ghosttyRoot, 'dist', '__vite-browser-external-2447137e.js')),
      type: 'text/javascript; charset=utf-8',
    }],
    // the module lives at /vendor/ghostty-web.js, so init() resolves
    // '../ghostty-vt.wasm' to /ghostty-vt.wasm
    ['/ghostty-vt.wasm', { body: readFileSync(WASM), type: 'application/wasm' }],
    ['/vendor/ghostty-vt.wasm', { body: readFileSync(WASM), type: 'application/wasm' }],
  ]);
}

const STATIC = loadStatic();

// ------------------------------------------------------------- HTTP + WS

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/cores') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
      res.end('method not allowed');
      return;
    }
    if (!validHost(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('invalid host');
      return;
    }
    if (!tokenMatches(u.searchParams.get('token'))) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('unauthorized');
      return;
    }
    try {
      const cores = await refreshCores();
      const body = JSON.stringify({ cores });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    } catch (error) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`discovery failed: ${error.message}`);
    }
    return;
  }
  const hit = STATIC.get(u.pathname);
  if (!hit || req.method !== 'GET') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  if (!validHost(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('invalid host');
    return;
  }
  const authenticated = u.pathname === '/' && tokenMatches(u.searchParams.get('token'));
  if (u.pathname === '/' && pageNeedsToken && !authenticated) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('unauthorized: append ?token=HERDR_WEB_TOKEN');
    return;
  }
  let body = hit.body;
  if (hit.template) {
    body = Buffer.from(
      hit.body.toString('utf8').replace('__HERDR_WEB_TOKEN__', TOKEN),
      'utf8',
    );
  }
  res.writeHead(200, {
    'content-type': hit.type,
    'cache-control': hit.cache || 'no-store',
    'content-length': body.length,
  });
  res.end(body);
});

const wss = new WebSocketServer({ noServer: true });

function refuse(socket, code, why) {
  socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return refuse(socket, 400, 'Bad Request');
  }
  if (u.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
  if (!validHost(req)) return refuse(socket, 403, 'Invalid Host');
  if (!tokenMatches(u.searchParams.get('token'))) return refuse(socket, 401, 'Unauthorized');
  const selectedCore = selectCore(u.searchParams.get('core') || '');
  if (!selectedCore) return refuse(socket, 404, 'Unknown Core');
  const origin = req.headers.origin; // browsers always send it; non-browser clients may not
  if (origin) {
    try {
      if (new URL(origin).host !== (req.headers.host || '')) {
        return refuse(socket, 403, 'Cross-Origin');
      }
    } catch {
      return refuse(socket, 403, 'Bad Origin');
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, selectedCore));
});

/** Handshake with hc connect: send a plain hello{framed:true} line,
 *  read one reply line, then switch to binary frames. */
function handshake(child, cb) {
  let acc = Buffer.alloc(0);
  let done = false;
  const finish = (err, leftover) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.stdout.off('data', onData);
    child.off('exit', onExit);
    cb(err, leftover);
  };
  const onData = (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const nl = acc.indexOf(0x0a);
    if (nl === -1) {
      if (acc.length > 1024 * 1024) finish(new Error('hello reply is too large'));
      return;
    }
    const line = acc.subarray(0, nl).toString('utf8');
    const leftover = acc.subarray(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return finish(new Error('hello reply is not JSON'));
    }
    if (msg.error) return finish(new Error(`core refused: ${JSON.stringify(msg.error)}`));
    finish(null, leftover);
  };
  const onExit = () => finish(new Error('core exited during handshake'));
  const timer = setTimeout(() => finish(new Error('core handshake timed out')), 10000);
  child.stdout.on('data', onData);
  child.once('exit', onExit);
  try {
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true } }) + '\n',
    );
  } catch (e) {
    finish(e);
  }
}

let connSeq = 0;

wss.on('connection', (ws, selectedCore = { label: 'default', session: '' }) => {
  const id = ++connSeq;
  const argv = HC_CONNECT.split(/\s+/).filter(Boolean);
  if (selectedCore.session) argv.push('--session', selectedCore.session);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    ws.close(1011, `spawn failed: ${e.message}`);
    return;
  }
  let alive = true;
  let coreReady = false;
  const log = (...a) => console.log(`[conn ${id}]`, ...a);
  log(`core ${selectedCore.label}: ${HC_CONNECT} (pid ${child.pid})`);

  ws.on('close', () => {
    alive = false;
    try {
      child.kill('SIGTERM');
    } catch {}
    log('browser disconnected, core connection closed');
  });
  ws.on('error', () => {});
  child.on('exit', (code, sig) => {
    if (alive) {
      alive = false;
      try {
        ws.close(1011, `core connection exited (${code ?? sig})`);
      } catch {}
    }
    log(`core exited (${code ?? sig})`);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => process.stderr.write(`[conn ${id} hc] ${d}`));
  child.stdin.on('error', (e) => log('core stdin error', e.message));
  child.on('error', (e) => {
    log('child error', e.message);
    if (alive) {
      alive = false;
      try {
        ws.close(1011, `core connection failed: ${e.message}`);
      } catch {}
    }
  });

  handshake(child, (err, leftover) => {
    if (!alive) return;
    if (err) {
      alive = false;
      log('handshake failed:', err.message);
      try {
        ws.close(1011, String(err.message));
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
      return;
    }
    const reader = new FrameReader();
    const deliver = (chunk) => {
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (e) {
        log('frame parse error:', e.message, '— disconnecting');
        try {
          ws.close(1011, 'bad frame');
        } catch {}
        try {
          child.kill('SIGTERM');
        } catch {}
        return;
      }
      for (const f of frames) {
        if (ws.readyState === 1) ws.send(encodeFrame(f.channel, f.kind, f.payload));
      }
    };
    if (leftover && leftover.length) deliver(leftover);
    child.stdout.on('data', deliver);
    coreReady = true;
    log('framed mode established');
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'gateway', event: 'ready' }));
  });

  ws.on('message', (data, isBinary) => {
    if (!alive || !coreReady || child.stdin.destroyed) return;
    if (isBinary) {
      // an hc frame from the browser: length-check, then pass through as-is
      if (data.length < HDR || data.length > HDR + MAX_PAYLOAD) return;
      const len = data.readUInt32LE(5);
      if (HDR + len !== data.length) return;
      child.stdin.write(data);
    } else {
      // text = JSON-RPC request → wrapped as a channel 0 DATA frame
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg.method !== 'string' || msg.id == null) return;
      child.stdin.write(encodeFrame(0, KDATA, Buffer.from(JSON.stringify(msg) + '\n', 'utf8')));
    }
  });
});

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${PORT} in use; try PORT=${PORT + 1}`);
  } else {
    console.error(`gateway listen failed: ${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`herdgate gateway listening: http://${HOST}:${PORT}/`);
  console.log(`  HC_CONNECT = ${HC_CONNECT}`);
  if (singleCore) console.log('  core mode = single (explicit HC_CONNECT)');
  else if (configuredCores.length) console.log(`  cores = ${configuredCores.join(', ')}`);
  else console.log(`  discovering core API sockets in ${HC_SOCKET_DIR} (every 5s)`);
  if (pageNeedsToken) console.log('  open /?token=HERDR_WEB_TOKEN (the configured secret is not logged)');
  else console.log(`  local per-run WebSocket token: ${TOKEN}`);
});

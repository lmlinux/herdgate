import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gateway = path.join(root, 'server', 'gateway.mjs');
const fakeCore = path.join(root, 'test', 'fixtures', 'fake-core.mjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = async () => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

const waitFor = async (predicate, message, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
};

const startGateway = async (t, extraEnv = {}) => {
  const port = await freePort();
  const child = spawn(process.execPath, [gateway], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      HC_CONNECT: `${process.execPath} ${fakeCore}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  await waitFor(() => output.includes('gateway listening'), `gateway did not start: ${output}`);
  const configuredToken = extraEnv.HERDR_WEB_TOKEN;
  const query = configuredToken ? `?token=${encodeURIComponent(configuredToken)}` : '';
  const response = await fetch(`http://127.0.0.1:${port}/${query}`);
  assert.equal(response.status, 200, output);
  const html = await response.text();
  const token = html.match(/window\.__TOKEN__ = "([^"]+)"/)?.[1];
  assert.ok(token, 'page contains its WebSocket token');
  return { child, port, token, output: () => output };
};

const openSocket = (port, token, options = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, options);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});

const nextMessage = (ws, predicate, timeout = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    ws.off('message', onMessage);
    reject(new Error('timed out waiting for WebSocket message'));
  }, timeout);
  const onMessage = (data, isBinary) => {
    const value = isBinary ? decodeFrame(data) : JSON.parse(data.toString('utf8'));
    if (!predicate(value, isBinary)) return;
    clearTimeout(timer);
    ws.off('message', onMessage);
    resolve(value);
  };
  ws.on('message', onMessage);
});

const decodeFrame = (data) => ({
  channel: data.readUInt32LE(0),
  kind: data.readUInt8(4),
  payload: data.subarray(9),
});

const encodeFrame = (channel, kind, payload = Buffer.alloc(0)) => {
  const frame = Buffer.alloc(9 + payload.length);
  frame.writeUInt32LE(channel, 0);
  frame.writeUInt8(kind, 4);
  frame.writeUInt32LE(payload.length, 5);
  payload.copy(frame, 9);
  return frame;
};

const waitReady = (ws) => nextMessage(ws, (message) => message.event === 'ready');
const closeSocket = (ws) => new Promise((resolve) => {
  ws.once('close', resolve);
  ws.close();
});

const rejectedUpgrade = (url, options = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, options);
  ws.once('unexpected-response', (_request, response) => {
    response.resume();
    resolve(response.statusCode);
  });
  ws.once('open', () => reject(new Error('WebSocket unexpectedly connected')));
  ws.once('error', () => {});
});

const hostRequest = (port, host) => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on('error', reject);
});

test('local HTTP, WebSocket token, Origin and Host checks', { timeout: 10000 }, async (t) => {
  const { port, token } = await startGateway(t);
  assert.equal(await rejectedUpgrade(`ws://127.0.0.1:${port}/ws`), 401);
  assert.equal(await rejectedUpgrade(`ws://127.0.0.1:${port}/ws?token=wrong`), 401);
  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${port}/ws?token=${token}`, { origin: 'https://evil.example' }),
    403,
  );
  assert.equal(await hostRequest(port, 'evil.example'), 403);
  assert.equal(await hostRequest(port, 'localhost'), 200);
  const ws = await openSocket(port, token, { origin: `http://127.0.0.1:${port}` });
  await waitReady(ws);
  await closeSocket(ws);
});

test('configured secret protects the token-bearing page', { timeout: 10000 }, async (t) => {
  const secret = 'test-secret-that-is-not-logged';
  const { port, output } = await startGateway(t, { HERDR_WEB_TOKEN: secret });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/?token=wrong`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/?token=${secret}`)).status, 200);
  assert.equal(output().includes(secret), false);
});

test('read-only token yields a read-only page and socket', { timeout: 10000 }, async (t) => {
  const rw = 'test-rw-secret-that-is-not-logged';
  const ro = 'test-ro-secret-that-is-not-logged';
  const { port } = await startGateway(t, { HERDR_WEB_TOKEN: rw, HERDR_WEB_RO_TOKEN: ro });
  const rwHtml = await (await fetch(`http://127.0.0.1:${port}/?token=${rw}`)).text();
  assert.match(rwHtml, new RegExp(`window\\.__TOKEN__ = "${rw}"`));
  const roHtml = await (await fetch(`http://127.0.0.1:${port}/?token=${ro}`)).text();
  // the RO page embeds the RO token, never the full one: the frontend uses the
  // embedded token to detect read-only mode and to open the WebSocket
  assert.match(roHtml, new RegExp(`window\\.__TOKEN__ = "${ro}"`));
  assert.doesNotMatch(roHtml, new RegExp(rw));
  const ws = await openSocket(port, ro, { origin: `http://127.0.0.1:${port}` });
  await waitReady(ws);
  await closeSocket(ws);
});

test('read-only connections are enforced at the protocol level', { timeout: 10000 }, async (t) => {
  const rw = 'test-rw-secret-that-is-not-logged';
  const ro = 'test-ro-secret-that-is-not-logged';
  const logFile = path.join(os.tmpdir(), `herdgate-ro-${process.pid}-${Date.now()}.log`);
  const { port } = await startGateway(t, {
    HERDR_WEB_TOKEN: rw,
    HERDR_WEB_RO_TOKEN: ro,
    FAKE_LOG_FILE: logFile,
  });

  const ws = await openSocket(port, ro, { origin: `http://127.0.0.1:${port}` });
  await waitReady(ws);

  // a write RPC is refused with a JSON-RPC error, never forwarded to the core
  const blocked = nextMessage(ws, (m) => m && m.id === 101);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'terminal.run', params: {} }));
  assert.match((await blocked).error.message, /read-only/);

  // terminal.attach is forwarded with observe forced on — even if the client
  // explicitly asks for a writable attachment (responses arrive as channel-0 frames)
  const attached = nextMessage(ws, (m) => m.channel === 0 && m.payload.toString().includes('"id":102'));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'terminal.attach', params: { terminal: 't1', observe: false } }));
  assert.equal(JSON.parse((await attached).payload.toString('utf8')).result.observe, true);

  // binary input (DATA) and resize frames are dropped; CREDIT passes through
  ws.send(encodeFrame(5, 0, Buffer.from('rm -rf /')));
  ws.send(encodeFrame(5, 1, Buffer.from('credit')));
  ws.send(encodeFrame(5, 3, Buffer.from('resize')));
  await closeSocket(ws);
  await delay(300);

  const log = await readFile(logFile, 'utf8');
  assert.doesNotMatch(log, /terminal\.run/, 'blocked RPC reached the core');
  assert.match(log, /terminal\.attach/, 'allowed RPC did not reach the core');
  assert.doesNotMatch(log, /rm -rf/, 'input frame reached the core');
  assert.match(log, /^5 1 /m, 'CREDIT frame was dropped');
  assert.doesNotMatch(log, /^5 3 /m, 'resize frame reached the core');

  // full-access connections are unaffected: run, input and resize all pass
  const wsRw = await openSocket(port, rw, { origin: `http://127.0.0.1:${port}` });
  await waitReady(wsRw);
  const ran = nextMessage(wsRw, (m) => m.channel === 0 && m.payload.toString().includes('"id":201'));
  wsRw.send(JSON.stringify({ jsonrpc: '2.0', id: 201, method: 'terminal.run', params: {} }));
  assert.ok(JSON.parse((await ran).payload.toString('utf8')).result.address);
  wsRw.send(encodeFrame(5, 0, Buffer.from('input-ok')));
  wsRw.send(encodeFrame(5, 3, Buffer.from('resize-ok')));
  await closeSocket(wsRw);
  await delay(300);
  const log2 = await readFile(logFile, 'utf8');
  assert.match(log2, /terminal\.run/);
  assert.match(log2, /input-ok/);
  assert.match(log2, /resize-ok/);
  await rm(logFile);
});

test('non-loopback bind requires an explicit secret', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [gateway], {
    cwd: root,
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), HERDR_WEB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (data) => { output += data; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /HERDR_WEB_TOKEN/);
});

test('--help and -h print usage without starting the gateway', async () => {
  for (const flag of ['--help', '-h']) {
    const child = spawn(process.execPath, [gateway, flag], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '8795',
        HC_CONNECT: 'hc connect --session fixtest',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Usage: herdgate/);
    for (const name of ['PORT', 'HOST', 'HC_CONNECT', 'HERDR_WEB_TOKEN']) {
      assert.match(stdout, new RegExp(`^\\s*${name}\\s+\\S`, 'm'));
    }
    assert.doesNotMatch(stdout, /gateway listening/);
    assert.equal(stderr, '');
  }
});

test('an occupied port produces a one-line actionable error', async (t) => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(8795, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));

  const child = spawn(process.execPath, [gateway], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '8795',
      HC_CONNECT: 'hc connect --session fixtest',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1, stderr);
  assert.equal(stdout, '');
  assert.equal(stderr, 'port 8795 in use; try PORT=8796\n');
});

test('RPC sent during a slow handshake never reaches the core', { timeout: 10000 }, async (t) => {
  const earlyFile = path.join(os.tmpdir(), `herdgate-early-${process.pid}-${Date.now()}`);
  const { port, token } = await startGateway(t, {
    FAKE_HANDSHAKE_DELAY: '300',
    FAKE_EARLY_FILE: earlyFile,
  });
  const ws = await openSocket(port, token);
  const ready = waitReady(ws);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.echo', params: { early: true } }));
  await ready;
  await delay(50);
  assert.equal(existsSync(earlyFile), false, 'core received framed bytes before its hello reply');
  const response = nextMessage(ws, (message) => message.channel === 0 && message.payload.toString().includes('"id":2'));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'test.echo', params: { early: false } }));
  assert.match((await response).payload.toString('utf8'), /"early":false/);
  await closeSocket(ws);
});

test('gateway reassembles fragmented core frames', { timeout: 10000 }, async (t) => {
  const { port, token } = await startGateway(t);
  const ws = await openSocket(port, token);
  await waitReady(ws);
  const fragmented = nextMessage(ws, (message) => message.channel === 9);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.frame', params: {} }));
  const frame = await fragmented;
  assert.equal(frame.kind, 0);
  assert.equal(frame.payload.toString('utf8'), 'fragmented-frame');
  await closeSocket(ws);
});

test('missing hc executable closes the browser connection', { timeout: 10000 }, async (t) => {
  const { port, token } = await startGateway(t, { HC_CONNECT: '/definitely/missing/herdr-core' });
  const ws = await openSocket(port, token);
  const closed = await new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  assert.equal(closed.code, 1011);
  assert.match(closed.reason, /core connection failed/);
});

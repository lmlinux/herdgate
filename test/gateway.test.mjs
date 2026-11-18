import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

test('RPC sent during a slow handshake never reaches the core', { timeout: 10000 }, async (t) => {
  const earlyFile = path.join(os.tmpdir(), `herdr-web-early-${process.pid}-${Date.now()}`);
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

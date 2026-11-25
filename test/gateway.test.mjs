import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
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

const fakeHcPath = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'herdgate-fake-hc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, 'hc'),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCore}" "$@"\n`,
    { mode: 0o755 },
  );
  return `${directory}${path.delimiter}${process.env.PATH}`;
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

const openCoreSocket = (port, token, core, options = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}&core=${encodeURIComponent(core)}`, options);
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
const rpc = async (ws, id, method, params = {}) => {
  const reply = nextMessage(ws, (message) => message.channel === 0 && message.payload.toString().includes(`"id":${id}`));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const frame = await reply;
  return JSON.parse(frame.payload.toString('utf8'));
};
const closeSocket = (ws) => new Promise((resolve) => {
  ws.once('close', resolve);
  ws.close();
});

const readCoreLog = async (logFile) => {
  try {
    return await readFile(logFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
};

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

test('loopback pages inject a fresh random token for each gateway run', { timeout: 10000 }, async (t) => {
  const noConfiguredToken = { HERDR_WEB_TOKEN: '' };
  const first = await startGateway(t, noConfiguredToken);
  const second = await startGateway(t, noConfiguredToken);
  assert.match(first.token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(second.token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.token, second.token);

  const firstHtml = await (await fetch(`http://127.0.0.1:${first.port}/`)).text();
  const secondHtml = await (await fetch(`http://127.0.0.1:${second.port}/`)).text();
  assert.ok(firstHtml.includes(`window.__TOKEN__ = "${first.token}"`));
  assert.ok(secondHtml.includes(`window.__TOKEN__ = "${second.token}"`));
  assert.ok(!firstHtml.includes(second.token));
  assert.ok(!secondHtml.includes(first.token));
  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${second.port}/ws?token=${first.token}`),
    401,
    'a token from an earlier gateway run authenticated against a new run',
  );

  for (const current of [first, second]) {
    const ws = await openSocket(current.port, current.token);
    await waitReady(ws);
    await closeSocket(ws);
  }
});

test('full-access connections pass RPC, input and resize', { timeout: 10000 }, async (t) => {
  const secret = 'test-full-access-secret-that-is-not-logged';
  const logFile = path.join(os.tmpdir(), `herdgate-rw-${process.pid}-${Date.now()}.log`);
  t.after(() => rm(logFile, { force: true }));
  const { port } = await startGateway(t, {
    HERDR_WEB_TOKEN: secret,
    FAKE_LOG_FILE: logFile,
  });

  const ws = await openSocket(port, secret, { origin: `http://127.0.0.1:${port}` });
  await waitReady(ws);

  const attached = await rpc(ws, 200, 'terminal.attach', { terminal: 't1' });
  assert.equal(attached.result.channel, 5);
  const ran = await rpc(ws, 201, 'terminal.run', {});
  assert.ok(ran.result.address);

  ws.send(encodeFrame(5, 0, Buffer.from('input-ok')));
  ws.send(encodeFrame(5, 3, Buffer.from('resize-ok')));
  ws.send(encodeFrame(5, 1, Buffer.from('full-access-drained')));
  await waitFor(
    async () => (await readCoreLog(logFile)).includes('full-access-drained'),
    'core did not consume the full-access frames',
  );
  const log = await readCoreLog(logFile);
  assert.match(log, /terminal\.attach/);
  assert.match(log, /terminal\.run/);
  assert.match(log, /input-ok/);
  assert.match(log, /resize-ok/);
  await closeSocket(ws);
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

test('explicit HC_CONNECT rejects multi-core HC_CORES configuration', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [gateway], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      HC_CONNECT: `${process.execPath} ${fakeCore}`,
      HC_CORES: 'alpha,beta',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /HC_CONNECT forces single-core mode and cannot be combined with HC_CORES/);
  assert.doesNotMatch(output, /gateway listening/);
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

test('configured cores route lists, attachments and frames independently', { timeout: 10000 }, async (t) => {
  const logFile = path.join(os.tmpdir(), `herdgate-multicore-${process.pid}-${Date.now()}.log`);
  t.after(() => rm(logFile, { force: true }));
  const { port, token } = await startGateway(t, {
    HC_CONNECT: '',
    HC_CORES: 'alpha,beta',
    PATH: await fakeHcPath(t),
    FAKE_LOG_FILE: logFile,
  });

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/cores`)).status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/api/cores?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cores: ['alpha', 'beta'] });
  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${port}/ws?token=${token}&core=not-configured`),
    404,
  );

  const alpha = await openCoreSocket(port, token, 'alpha');
  const beta = await openCoreSocket(port, token, 'beta');
  await Promise.all([waitReady(alpha), waitReady(beta)]);

  for (const [ws, core, id] of [[alpha, 'alpha', 11], [beta, 'beta', 21]]) {
    const listed = await rpc(ws, id, 'terminal.list', { all: true });
    assert.equal(listed.result.terminals[0].address, 't1', 'both fixtures deliberately reuse t1');
    assert.equal(listed.result.terminals[0].core, core);
    const attached = await rpc(ws, id + 1, 'terminal.attach', { terminal: 't1' });
    assert.equal(attached.result.core, core);
    assert.equal(attached.result.channel, 5);
  }

  alpha.send(encodeFrame(5, 0, Buffer.from('input-for-alpha')));
  beta.send(encodeFrame(5, 0, Buffer.from('input-for-beta')));
  alpha.send(encodeFrame(5, 1, Buffer.from('alpha-drained')));
  beta.send(encodeFrame(5, 1, Buffer.from('beta-drained')));
  await waitFor(async () => {
    const log = await readCoreLog(logFile);
    return log.includes('alpha-drained') && log.includes('beta-drained');
  }, 'both cores did not consume their frames');
  const log = await readCoreLog(logFile);
  assert.match(log, /^5 0 input-for-alpha core=alpha$/m);
  assert.match(log, /^5 0 input-for-beta core=beta$/m);
  assert.doesNotMatch(log, /input-for-alpha core=beta|input-for-beta core=alpha/);

  await Promise.all([closeSocket(alpha), closeSocket(beta)]);
});

test('socket discovery filters holders and joins later cores without restart', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'herdgate-discovery-'));
  const listeners = [];
  const listenSocket = (name) => new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(path.join(directory, name), () => {
      listeners.push(listener);
      resolve();
    });
  });
  t.after(async () => {
    await Promise.all(listeners.map((listener) => new Promise((resolve) => listener.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  });
  await listenSocket('alpha.sock');
  await listenSocket('alpha.holder.deadbeef.sock');
  await writeFile(path.join(directory, 'ordinary-file.sock'), 'not a socket');
  await writeFile(
    path.join(directory, 'hc'),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeCore}" "$@"\n`,
    { mode: 0o755 },
  );

  const { port, token } = await startGateway(t, {
    HC_CONNECT: '',
    HC_SOCKET_DIR: directory,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
  });
  const listCores = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/cores?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    return (await response.json()).cores;
  };
  assert.deepEqual(await listCores(), ['alpha']);

  const alpha = await openCoreSocket(port, token, 'alpha');
  await waitReady(alpha);
  assert.equal((await rpc(alpha, 1, 'test.echo', { source: 'alpha' })).result.core, 'alpha');
  await listenSocket('zeta.sock');
  assert.deepEqual(await listCores(), ['alpha', 'zeta']);
  const zeta = await openCoreSocket(port, token, 'zeta');
  await waitReady(zeta);
  assert.equal((await rpc(zeta, 1, 'test.echo', { source: 'zeta' })).result.core, 'zeta');
  assert.equal(alpha.readyState, WebSocket.OPEN, 'adding a core disturbed the existing connection');
  await Promise.all([closeSocket(alpha), closeSocket(zeta)]);
});

import { appendFileSync } from 'node:fs';

const handshakeDelay = Number.parseInt(process.env.FAKE_HANDSHAKE_DELAY || '0', 10);
const earlyFile = process.env.FAKE_EARLY_FILE;
let phase = 'hello';
let pending = Buffer.alloc(0);

const encodeFrame = (channel, kind, payload) => {
  const frame = Buffer.alloc(9 + payload.length);
  frame.writeUInt32LE(channel, 0);
  frame.writeUInt8(kind, 4);
  frame.writeUInt32LE(payload.length, 5);
  payload.copy(frame, 9);
  return frame;
};

const sendJson = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  if (process.env.FAKE_SPLIT_JSON === '1') {
    for (let offset = 0; offset < payload.length; offset += 3) {
      process.stdout.write(encodeFrame(0, 0, payload.subarray(offset, offset + 3)));
    }
  } else {
    process.stdout.write(encodeFrame(0, 0, payload));
  }
};

const sendFragmentedFrame = () => {
  const frame = encodeFrame(9, 0, Buffer.from('fragmented-frame'));
  process.stdout.write(frame.subarray(0, 2));
  setTimeout(() => process.stdout.write(frame.subarray(2, 11)), 10);
  setTimeout(() => process.stdout.write(frame.subarray(11)), 20);
};

const handleRequest = (request) => {
  if (request.method === 'events.subscribe') {
    sendJson({ jsonrpc: '2.0', id: request.id, result: { channel: 7, terminals: [] } });
  } else if (request.method === 'test.echo') {
    sendJson({ jsonrpc: '2.0', id: request.id, result: { echo: request.params } });
  } else if (request.method === 'test.frame') {
    sendJson({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
    sendFragmentedFrame();
  }
};

const consumeFrames = () => {
  while (pending.length >= 9) {
    const length = pending.readUInt32LE(5);
    if (pending.length < 9 + length) return;
    const channel = pending.readUInt32LE(0);
    const kind = pending.readUInt8(4);
    const payload = pending.subarray(9, 9 + length);
    pending = pending.subarray(9 + length);
    if (channel !== 0 || kind !== 0) continue;
    for (const line of payload.toString('utf8').split('\n')) {
      if (line.trim()) handleRequest(JSON.parse(line));
    }
  }
};

const recordEarly = (data) => {
  if (earlyFile && data.length) appendFileSync(earlyFile, data);
};

process.stdin.on('data', (chunk) => {
  if (phase === 'delay') {
    recordEarly(chunk);
    return;
  }
  pending = Buffer.concat([pending, chunk]);
  if (phase === 'framed') {
    consumeFrames();
    return;
  }

  const newline = pending.indexOf(0x0a);
  if (newline === -1) return;
  const hello = JSON.parse(pending.subarray(0, newline).toString('utf8'));
  const leftover = pending.subarray(newline + 1);
  pending = Buffer.alloc(0);
  recordEarly(leftover);
  phase = 'delay';
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: hello.id, result: { framed: true } }) + '\n');
    phase = 'framed';
  }, handshakeDelay);
});

process.stdin.on('end', () => process.exit(0));

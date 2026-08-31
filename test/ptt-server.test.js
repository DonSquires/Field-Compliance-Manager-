const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const WebSocket = require('ws');
const { createPttServer, verifySessionToken } = require('../ptt-server');

const base64Url = (value) => Buffer.from(value).toString('base64url');
const sign = (claims, secret) => {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  return `${header}.${payload}.${crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
};

test('PTT sessions are signed, short-lived, and bound to one organization channel', () => {
  const now = Date.UTC(2026, 7, 31);
  const token = sign({ v: 1, sub: 'officer-1', organizationId: 'org-a', channelId: 'channel-a', exp: Math.floor(now / 1000) + 60 }, 'session-secret');
  assert.deepEqual(verifySessionToken(token, 'session-secret', now), {
    v: 1, sub: 'officer-1', organizationId: 'org-a', channelId: 'channel-a', exp: Math.floor(now / 1000) + 60,
  });
  assert.equal(verifySessionToken(token, 'wrong-secret', now), null);
  assert.equal(verifySessionToken(sign({ v: 1, sub: 'officer-1', organizationId: 'org-a', channelId: 'channel-a', exp: Math.floor(now / 1000) - 1 }, 'session-secret'), 'session-secret', now), null);
});

test('PTT server requires a signed session and only signals members of the authenticated room', async () => {
  const now = Date.now();
  const instance = createPttServer({ sessionSecret: 'session-secret', relayToken: 'relay-secret' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const { port } = instance.server.address();
  const url = `ws://127.0.0.1:${port}`;
  const messages = [];
  const connect = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.once('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'authed') resolve({ ws, clientId: message.clientId });
      else reject(new Error(`Expected PTT authentication, received ${message.type}`));
    });
  });
  const first = await connect(sign({ v: 1, sub: 'officer-1', organizationId: 'org-a', channelId: 'channel-a', exp: Math.floor(now / 1000) + 60 }, 'session-secret'));
  const second = await connect(sign({ v: 1, sub: 'officer-2', organizationId: 'org-a', channelId: 'channel-a', exp: Math.floor(now / 1000) + 60 }, 'session-secret'));
  const outsider = await connect(sign({ v: 1, sub: 'officer-3', organizationId: 'org-b', channelId: 'channel-a', exp: Math.floor(now / 1000) + 60 }, 'session-secret'));
  second.ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  for (const socket of [first.ws, second.ws, outsider.ws]) socket.send(JSON.stringify({ type: 'join' }));
  await new Promise(resolve => setTimeout(resolve, 25));
  first.ws.send(JSON.stringify({ type: 'signal', to: outsider.clientId, data: { type: 'offer' } }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(messages.some(message => message.type === 'signal'), false);
  for (const socket of [first.ws, second.ws, outsider.ws]) socket.close();
  await instance.close();
});
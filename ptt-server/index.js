const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');

const SESSION_TTL_MS = 10_000;
const MAX_TRANSCRIPT_LENGTH = 2_000;

function base64UrlDecode(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64');
}

function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret) return null;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const received = base64UrlDecode(signature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  try {
    const claims = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    if (!claims || claims.v !== 1 || typeof claims.sub !== 'string' || typeof claims.organizationId !== 'string' || typeof claims.channelId !== 'string') return null;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

function createPttServer({ sessionSecret, relayToken, now = () => Date.now() }) {
  if (!sessionSecret) throw new Error('PTT_SESSION_SECRET environment variable is required');
  if (!relayToken) throw new Error('PTT_RELAY_TOKEN environment variable is required');

  const clients = new Map();
  const rooms = new Map();
  const errors = [];
  let totalToday = 0;

  const recordError = (code) => {
    errors.unshift({ code, at: new Date(now()).toISOString() });
    errors.splice(30);
  };

  const roomKey = (claims) => `${claims.organizationId}:${claims.channelId}`;
  const roomMembers = (room) => [...room.members.values()].map(({ clientId, displayName, userId }) => ({ clientId, displayName, userId }));
  const send = (client, body) => {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(body));
  };
  const broadcast = (room, body) => room.members.forEach((member) => send(member, body));
  const publishState = (room) => broadcast(room, { type: 'channel_state', members: roomMembers(room), floorHolder: room.floorHolder });

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://ptt.local').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'fcm-ptt', active: clients.size, rooms: rooms.size }));
      return;
    }

    const authorized = req.headers.authorization === `Bearer ${relayToken}`;
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }));
      return;
    }

    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/connections') return json({ active: clients.size, totalToday });
    if (path === '/rooms') return json({ rooms: [...rooms.values()].map((room) => ({ channelId: room.channelId, organizationId: room.organizationId, active: room.members.size, floorHolder: room.floorHolder })) });
    if (path === '/turn/status') return json({ reachable: false, udp: false, tcp: false, tls: false, reason: 'TURN is not configured' });
    if (path === '/recent-errors') return json({ errors });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
  });

  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws) => {
    let client = null;
    const authTimer = setTimeout(() => {
      if (!client) ws.close(4001, 'Authentication required');
    }, SESSION_TTL_MS);

    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { recordError('INVALID_MESSAGE'); return; }
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'auth') {
        if (client) return;
        const claims = verifySessionToken(message.token, sessionSecret, now());
        if (!claims) {
          recordError('INVALID_SESSION');
          send({ ws }, { type: 'error', code: 'INVALID_SESSION' });
          ws.close(4003, 'Invalid session');
          return;
        }
        clearTimeout(authTimer);
        const clientId = crypto.randomUUID();
        client = {
          clientId,
          ws,
          userId: claims.sub,
          displayName: typeof claims.displayName === 'string' ? claims.displayName.slice(0, 120) : 'Officer',
          organizationId: claims.organizationId,
          channelId: claims.channelId,
        };
        clients.set(clientId, client);
        totalToday += 1;
        send(client, { type: 'authed', clientId, channelId: client.channelId });
        return;
      }

      if (!client) return;
      const key = `${client.organizationId}:${client.channelId}`;
      const room = rooms.get(key);

      if (message.type === 'join') {
        const nextRoom = room || { organizationId: client.organizationId, channelId: client.channelId, members: new Map(), floorHolder: null };
        nextRoom.members.set(client.clientId, client);
        rooms.set(key, nextRoom);
        publishState(nextRoom);
        return;
      }
      if (!room || !room.members.has(client.clientId)) return;

      if (message.type === 'floor_request') {
        if (!room.floorHolder) {
          room.floorHolder = client.clientId;
          broadcast(room, { type: 'floor_granted', clientId: client.clientId });
        } else {
          send(client, { type: 'floor_denied', clientId: room.floorHolder });
        }
        return;
      }
      if (message.type === 'floor_release' && room.floorHolder === client.clientId) {
        room.floorHolder = null;
        broadcast(room, { type: 'floor_released', clientId: client.clientId });
        return;
      }
      if (message.type === 'signal' && typeof message.to === 'string' && room.members.has(message.to)) {
        send(room.members.get(message.to), { type: 'signal', from: client.clientId, data: message.data });
        return;
      }
      if (message.type === 'transcript' && room.floorHolder === client.clientId && typeof message.text === 'string') {
        const text = message.text.trim().slice(0, MAX_TRANSCRIPT_LENGTH);
        if (text) broadcast(room, { type: 'transcript_received', from: client.clientId, displayName: client.displayName, text, receivedAt: new Date(now()).toISOString() });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!client) return;
      clients.delete(client.clientId);
      const room = rooms.get(`${client.organizationId}:${client.channelId}`);
      if (!room) return;
      room.members.delete(client.clientId);
      if (room.floorHolder === client.clientId) room.floorHolder = null;
      if (!room.members.size) rooms.delete(`${client.organizationId}:${client.channelId}`);
      else publishState(room);
    });
  });

  return { server, wss, close: () => new Promise((resolve) => wss.close(() => server.close(resolve))) };
}

if (require.main === module) {
  const instance = createPttServer({ sessionSecret: process.env.PTT_SESSION_SECRET, relayToken: process.env.PTT_RELAY_TOKEN });
  const port = Number(process.env.PORT || 4000);
  instance.server.listen(port, () => console.log(`PTT server listening on port ${port}`));
}

module.exports = { createPttServer, verifySessionToken };
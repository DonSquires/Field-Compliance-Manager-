const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const PTT_SECRET = process.env.PTT_SECRET;

if (!PTT_SECRET) {
  console.error('PTT_SECRET environment variable is required');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ptt-server', timestamp: new Date().toISOString() }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FCM PTT Server\n');
});

const wss = new WebSocket.Server({ server });

const clients = new Map();
const channels = new Map();

wss.on('connection', (ws) => {
  let clientId = null;
  let currentChannel = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'auth':
          if (msg.token !== PTT_SECRET) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close();
            return;
          }
          clientId = crypto.randomUUID();
          clients.set(clientId, {
            ws,
            officerId: msg.officerId,
            displayName: msg.displayName,
            organizationId: msg.organizationId,
          });
          ws.send(JSON.stringify({ type: 'authed', clientId }));
          break;

        case 'join':
          if (!clientId) return;
          currentChannel = msg.channel;
          if (!channels.has(currentChannel)) {
            channels.set(currentChannel, { members: new Map(), floorHolder: null });
          }
          const channel = channels.get(currentChannel);
          const client = clients.get(clientId);
          channel.members.set(clientId, {
            clientId,
            officerId: client.officerId,
            displayName: client.displayName,
          });

          // Notify all members
          const members = Array.from(channel.members.values());
          for (const [cid] of channel.members) {
            const c = clients.get(cid);
            if (c) {
              c.ws.send(JSON.stringify({
                type: 'channel_state',
                members,
                floorHolder: channel.floorHolder,
              }));
            }
          }
          break;

        case 'floor_request':
          if (!clientId || !currentChannel) return;
          const ch = channels.get(currentChannel);
          if (!ch) return;

          if (!ch.floorHolder) {
            ch.floorHolder = clientId;
            for (const [cid] of ch.members) {
              const c = clients.get(cid);
              if (c) {
                c.ws.send(JSON.stringify({
                  type: 'floor_granted',
                  clientId,
                }));
              }
            }
          } else {
            ws.send(JSON.stringify({ type: 'floor_denied' }));
          }
          break;

        case 'floor_release':
          if (!clientId || !currentChannel) return;
          const ch2 = channels.get(currentChannel);
          if (!ch2 || ch2.floorHolder !== clientId) return;

          ch2.floorHolder = null;
          for (const [cid] of ch2.members) {
            const c = clients.get(cid);
            if (c) {
              c.ws.send(JSON.stringify({
                type: 'floor_released',
                next: null,
              }));
            }
          }
          break;

        case 'signal':
          if (!clientId) return;
          const target = clients.get(msg.to);
          if (target) {
            target.ws.send(JSON.stringify({
              type: 'signal',
              from: clientId,
              data: msg.data,
            }));
          }
          break;

        case 'transcript':
          if (!clientId || !currentChannel) return;
          const ch3 = channels.get(currentChannel);
          if (!ch3) return;
          const sender = clients.get(clientId);

          for (const [cid] of ch3.members) {
            if (cid === clientId) continue;
            const c = clients.get(cid);
            if (c) {
              c.ws.send(JSON.stringify({
                type: 'transcript_received',
                from: clientId,
                displayName: sender.displayName,
                text: msg.text,
                receivedAt: new Date().toISOString(),
              }));
            }
          }
          break;
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  ws.on('close', () => {
    if (clientId) {
      clients.delete(clientId);
      if (currentChannel) {
        const ch = channels.get(currentChannel);
        if (ch) {
          ch.members.delete(clientId);
          if (ch.floorHolder === clientId) {
            ch.floorHolder = null;
          }

          const members = Array.from(ch.members.values());
          for (const [cid] of ch.members) {
            const c = clients.get(cid);
            if (c) {
              c.ws.send(JSON.stringify({
                type: 'member_left',
                clientId,
              }));
              c.ws.send(JSON.stringify({
                type: 'channel_state',
                members,
                floorHolder: ch.floorHolder,
              }));
            }
          }
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`PTT server listening on port ${PORT}`);
});

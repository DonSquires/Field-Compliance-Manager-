import assert from 'node:assert/strict';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { buildAlertMimeContent, buildEnquiryAlert } from '../supabase/functions/website-enquiry/notify.mjs';

Deno.test('the SMTP client sends both safe alternatives and both recipients on the wire', async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  if (!('port' in address)) {
    listener.close();
    throw new Error('Expected a TCP listener');
  }
  const server = (async () => {
    const conn = await listener.accept();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(4096);
    const recipients: string[] = [];
    const unexpected: string[] = [];
    const dataLines: string[] = [];
    let pending = '';
    let inData = false;
    let completed = false;
    try {
      await conn.write(encoder.encode('220 localhost ESMTP\r\n'));
      for (;;) {
        const count = await conn.read(buffer);
        if (count === null) break;
        pending += decoder.decode(buffer.subarray(0, count), { stream: true });
        let end: number;
        while ((end = pending.indexOf('\r\n')) !== -1) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (inData && line !== '.') {
            dataLines.push(line);
          } else if (inData) {
            inData = false;
            completed = true;
            await conn.write(encoder.encode('250 accepted\r\n'));
          } else if (line === '') {
            continue;
          } else if (/^(EHLO|NOOP|MAIL FROM:|RCPT TO:)/i.test(line)) {
            if (/^RCPT TO:/i.test(line)) recipients.push(line);
            await conn.write(encoder.encode('250 ok\r\n'));
          } else if (line === 'DATA') {
            inData = true;
            await conn.write(encoder.encode('354 send data\r\n'));
          } else {
            unexpected.push(line);
            await conn.write(encoder.encode('250 ok\r\n'));
          }
        }
      }
      return { data: dataLines.join('\r\n'), recipients, unexpected, completed };
    } finally {
      conn.close();
    }
  })();

  const alert = buildEnquiryAlert({
    reference: 'ENQ-1A2B3C',
    receivedAt: new Date('2026-11-02T01:00:00Z'),
    reviewUrl: 'https://fcmanager.co.nz',
    enquiry: {
      name: 'Synthetic <visitor>',
      email: 'visitor@example.com',
      phone: null,
      organisation: null,
      location: null,
      services: ['raptor'],
      message: `First line\n.\n${'x'.repeat(73)}.\nQUIT\nLast line`,
      preferred_contact: 'email',
      privacy_ack: true,
      source_page: '/contact',
    },
  });
  // The unencrypted connection is restricted to this synthetic loopback server.
  const client = new SMTPClient({
    connection: { hostname: '127.0.0.1', port: address.port, tls: false },
    debug: { allowUnsecure: true, noStartTLS: true },
  });

  try {
    try {
      await client.send({
        from: 'sender@example.com',
        to: ['admin@example.com', 'other@example.com'],
        replyTo: alert.replyTo ?? undefined,
        subject: alert.subject,
        mimeContent: buildAlertMimeContent(alert),
      });
    } finally {
      await client.close();
    }
    const { data, recipients, unexpected, completed } = await server;
    assert.equal(completed, true);
    assert.deepEqual(unexpected, []);
    assert.equal(recipients.length, 2);
    assert.match(recipients[0], /<admin@example\.com>/);
    assert.match(recipients[1], /<other@example\.com>/);
    assert.match(data, /Reply-To:.*visitor@example\.com/);
    assert.match(data, /Content-Type: multipart\/alternative/);
    assert.ok(data.indexOf('Content-Type: text/plain') < data.indexOf('Content-Type: text/html'));

    for (const [mime, expected] of [['plain', alert.text], ['html', alert.html]]) {
      const part = data.match(new RegExp(
        `Content-Type: text/${mime}; charset="utf-8"\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--message`,
      ));
      assert.ok(part, `${mime} part is present and base64 encoded`);
      const encoded = part[1].replace(/\s/g, '');
      assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/);
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      assert.equal(new TextDecoder().decode(bytes), expected.replace(/\r?\n/g, '\r\n'));
    }
  } finally {
    listener.close();
  }
});

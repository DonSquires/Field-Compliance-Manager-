const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const load = () => import('../supabase/functions/_shared/report-delivery.mjs');
const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(width = 10, height = 10) {
  const bytes = new Uint8Array(32);
  bytes.set(PNG_SIGNATURE);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
const ok = (bytes, headers = {}) => async () => new Response(bytes, { status: 200, headers });

test('report email subject is printable ASCII so the SMTP header block stays intact', async () => {
  const { reportEmailSubject, emailSafeHeaderText } = await load();
  const subject = reportEmailSubject({ title: 'OneFortyOne — Café “Patrol” report…', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
  assert.equal(subject, 'OneFortyOne - Cafe "Patrol" report... - 2026-10-01 to 2026-10-31');
  assert.match(subject, /^[\x20-\x7E]+$/);
  assert.equal(reportEmailSubject({ title: '', periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 'Report Pack - 2026-10-01 to 2026-10-31');
  assert.equal(emailSafeHeaderText('=?utf-8?Q?x?='), 'utf-8?Q?x?=');
  assert.equal(emailSafeHeaderText('Line\r\nBreak'), 'Line Break');
});

test('report attachment filename is a MIME token so unquoted headers keep it whole', async () => {
  const { reportPdfFilename } = await load();
  assert.equal(reportPdfFilename({ title: 'TPFL / OFO: Māori “Report” — Oct', periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 'TPFL-OFO-Maori-Report-Oct_2026-10-01_to_2026-10-31.pdf');
  assert.equal(reportPdfFilename({ title: null, periodStart: 'a', periodEnd: 'b' }), 'Report-Pack_a_to_b.pdf');
  assert.match(reportPdfFilename({ title: 'x'.repeat(300) + ' (draft); "q"', periodStart: '2026-10-01', periodEnd: '2026-10-31' }), /^[A-Za-z0-9._-]+$/);
});

test('email bodies are base64 so no SMTP line can start with a dot', async () => {
  const { reportEmailMimeContent } = await load();
  const url = 'https://x.supabase.co/storage/v1/object/sign/a.pdf?token=eyJ.' + 'a'.repeat(70) + '.sig';
  const html = `<p>Summary — “quoted”\n.\n.leading dot</p><p><a href="${url}">download it here</a></p>`;
  const parts = reportEmailMimeContent(html);
  assert.deepEqual(parts.map((part) => [part.mimeType, part.transferEncoding]), [
    ['text/plain; charset="utf-8"', 'base64'],
    ['text/html; charset="utf-8"', 'base64'],
  ]);
  for (const part of parts) {
    for (const line of part.content.split('\r\n')) {
      assert.ok(line.length <= 76);
      assert.match(line, /^[A-Za-z0-9+/=]+$/);
    }
  }
  const decode = (part) => Buffer.from(part.content.replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(decode(parts[1]), html);
  assert.match(decode(parts[0]), /download it here \(https:\/\/x\.supabase\.co\/storage\/v1\/object\/sign\/a\.pdf\?token=/);
  assert.doesNotMatch(decode(parts[0]), /<p>|<a /);
});

test('logo URL must be public https', async () => {
  const { reportLogoUrl } = await load();
  assert.equal(reportLogoUrl('https://www.fcmanager.co.nz/assets/email/logo.png'), 'https://www.fcmanager.co.nz/assets/email/logo.png');
  for (const bad of ['http://example.com/logo.png', 'javascript:alert(1)', 'https://localhost/logo.png', 'https://127.0.0.1/logo.png',
    'https://[::1]/logo.png', 'https://metadata.internal/logo.png', 'https://user:pw@example.com/logo.png', 'https://intranet/logo.png']) {
    assert.equal(reportLogoUrl(bad), null, bad);
  }
});

test('report logo loads only safe PNG/JPEG within limits and never blocks rendering', async () => {
  const { loadReportLogo, MAX_LOGO_BYTES } = await load();
  const small = png();
  assert.deepEqual(await loadReportLogo('https://example.com/logo.png', ok(small)), { bytes: small, kind: 'png' });
  assert.equal((await loadReportLogo('https://example.com/logo.jpg', ok(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])))).kind, 'jpg');
  assert.equal(await loadReportLogo('https://example.com/logo.svg', ok(new TextEncoder().encode('<svg/>'))), null);
  assert.equal(await loadReportLogo('https://example.com/huge.png', ok(png(50000, 50000))), null);
  assert.equal(await loadReportLogo('https://example.com/big.png', ok(small, { 'content-length': String(MAX_LOGO_BYTES + 1) })), null);

  let pulled = 0;
  const endless = async () => new Response(new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(256 * 1024)); },
  }));
  assert.equal(await loadReportLogo('https://example.com/stream.png', endless), null);
  assert.ok(pulled <= 10, `stopped reading after the cap (${pulled} chunks)`);

  assert.equal(await loadReportLogo('https://example.com/missing.png', async () => new Response('no', { status: 404 })), null);
  assert.equal(await loadReportLogo('https://example.com/down.png', async () => { throw new Error('offline'); }), null);
  // AbortSignal.timeout's timer is unref'd in Node; a real fetch keeps the loop alive, so this stub must too.
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  const started = Date.now();
  assert.equal(await loadReportLogo('https://example.com/slow.png', hanging, { timeoutMs: 50 }), null);
  assert.ok(Date.now() - started < 2000);

  let called = false;
  assert.equal(await loadReportLogo(null, async () => { called = true; return new Response(small); }), null);
  assert.equal(called, false);
});

test('logo redirects are followed only to public https destinations', async () => {
  const { loadReportLogo } = await load();
  const small = png();
  const redirectingTo = (location) => async (url) => url === 'https://example.com/logo.png'
    ? new Response(null, { status: 302, headers: { location } })
    : new Response(small, { status: 200 });
  assert.equal((await loadReportLogo('https://example.com/logo.png', redirectingTo('https://cdn.example.com/logo.png'))).kind, 'png');
  assert.equal(await loadReportLogo('https://example.com/logo.png', redirectingTo('http://cdn.example.com/logo.png')), null);
  assert.equal(await loadReportLogo('https://example.com/logo.png', redirectingTo('https://169.254.169.254/latest')), null);
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/again.png' } });
  assert.equal(await loadReportLogo('https://example.com/logo.png', loop), null);
});

test('PDF attachment fetch is capped and failure-tolerant', async () => {
  const { fetchCappedBytes } = await load();
  const pdf = new TextEncoder().encode('%PDF-1.7');
  assert.deepEqual(await fetchCappedBytes('https://x/a.pdf', { maxBytes: 100, fetcher: ok(pdf) }), pdf);
  assert.equal(await fetchCappedBytes('https://x/a.pdf', { maxBytes: 4, fetcher: ok(pdf) }), null);
  assert.equal(await fetchCappedBytes('https://x/a.pdf', { maxBytes: 100, fetcher: async () => new Response('', { status: 500 }) }), null);
  assert.equal(await fetchCappedBytes('https://x/a.pdf', { maxBytes: 100, fetcher: async () => { throw new Error('reset'); } }), null);
});

test('send-report-pack attaches the reviewed PDF without risking the stored PDF', () => {
  const send = read('supabase/functions/send-report-pack/index.ts');
  assert.match(send, /subject: reportEmailSubject\(/);
  assert.doesNotMatch(send, /subject: `[^`]*—/);
  assert.match(send, /mimeContent: reportEmailMimeContent\(summaryHtml\(pack, pdfUrl, pdfBytes !== null\)\)/);
  assert.doesNotMatch(send, /\bhtml: summaryHtml/);
  assert.match(send, /attachments: pdfBytes\s*\?\s*\[\{ filename: reportPdfFilename\([^)]*\), content: pdfBytes, encoding: 'binary', contentType: 'application\/pdf' \}\]/);
  assert.match(send, /const pdfBytes = await loadReportAttachment\(pdfUrl\);\s*await sendEmail\(pack, claim\.recipient, pdfUrl, pdfBytes\);/);
  assert.match(send, /fetchCappedBytes\(pdfUrl, \{ maxBytes: MAX_PDF_ATTACHMENT_BYTES/);
  assert.match(send, /provider:organization_id\(name, logo_url\)/);
});

test('report PDF header draws the provider organisation logo', () => {
  const pdf = read('supabase/functions/generate-report-pack-pdf/index.ts');
  assert.match(pdf, /provider:organization_id\(name,logo_url\)/);
  assert.match(pdf, /logo: await loadReportLogo\(providerLogoUrl\(pack\.provider\)\)/);
  assert.match(pdf, /page\.drawImage\(logoImage/);
});

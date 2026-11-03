const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const load = () => import('../supabase/functions/_shared/report-delivery.mjs');
const read = (file) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

test('report email subject is printable ASCII so the SMTP header block stays intact', async () => {
  const { reportEmailSubject, emailSafeHeaderText } = await load();
  const subject = reportEmailSubject({ title: 'OneFortyOne — Café “Patrol” report…', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
  assert.equal(subject, 'OneFortyOne - Cafe "Patrol" report... - 2026-10-01 to 2026-10-31');
  assert.match(subject, /^[\x20-\x7E]+$/);
  assert.equal(reportEmailSubject({ title: '', periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 'Report Pack - 2026-10-01 to 2026-10-31');
  assert.equal(emailSafeHeaderText('=?utf-8?Q?x?='), 'utf-8?Q?x?=');
  assert.equal(emailSafeHeaderText('Line\r\nBreak'), 'Line Break');
});

test('report attachment filename is filesystem- and header-safe', async () => {
  const { reportPdfFilename } = await load();
  assert.equal(reportPdfFilename({ title: 'TPFL / OFO: Māori “Report”', periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 'TPFL OFO Maori Report 2026-10-01 to 2026-10-31.pdf');
  assert.equal(reportPdfFilename({ title: null, periodStart: 'a', periodEnd: 'b' }), 'Report Pack a to b.pdf');
});

test('report logo loads only https PNG/JPEG within limits and never blocks rendering', async () => {
  const { loadReportLogo, reportLogoUrl } = await load();
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const ok = (bytes, headers = {}) => async () => new Response(bytes, { status: 200, headers });
  assert.equal(reportLogoUrl('http://example.com/logo.png'), null);
  assert.equal(reportLogoUrl('javascript:alert(1)'), null);
  assert.deepEqual(await loadReportLogo('https://example.com/logo.png', ok(png)), { bytes: png, kind: 'png' });
  assert.equal((await loadReportLogo('https://example.com/logo.jpg', ok(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])))).kind, 'jpg');
  assert.equal(await loadReportLogo('https://example.com/logo.svg', ok(new TextEncoder().encode('<svg/>'))), null);
  assert.equal(await loadReportLogo('https://example.com/big.png', ok(png, { 'content-length': String(3 * 1024 * 1024) })), null);
  assert.equal(await loadReportLogo('https://example.com/missing.png', async () => new Response('no', { status: 404 })), null);
  assert.equal(await loadReportLogo('https://example.com/down.png', async () => { throw new Error('offline'); }), null);
  let called = false;
  assert.equal(await loadReportLogo(null, async () => { called = true; return new Response(png); }), null);
  assert.equal(called, false);
});

test('send-report-pack attaches the reviewed PDF and keeps an ASCII subject', () => {
  const send = read('supabase/functions/send-report-pack/index.ts');
  assert.match(send, /subject: reportEmailSubject\(/);
  assert.doesNotMatch(send, /subject: `[^`]*—/);
  assert.match(send, /storage\.from\('bob-uploads'\)\.download\(pdfPath\)/);
  assert.match(send, /contentType: 'application\/pdf'/);
  assert.match(send, /MAX_PDF_ATTACHMENT_BYTES/);
  assert.match(send, /provider:organization_id\(name, logo_url\)/);
});

test('report PDF header draws the provider organisation logo', () => {
  const pdf = read('supabase/functions/generate-report-pack-pdf/index.ts');
  assert.match(pdf, /provider:organization_id\(name,logo_url\)/);
  assert.match(pdf, /logo: await loadReportLogo\(providerLogoUrl\(pack\.provider\)\)/);
  assert.match(pdf, /page\.drawImage\(logoImage/);
});

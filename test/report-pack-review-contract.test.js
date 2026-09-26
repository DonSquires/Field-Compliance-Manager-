const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const send = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/send-report-pack/index.ts'), 'utf8');
const pdf = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'), 'utf8');
const client = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ClientPortalPage.tsx'), 'utf8');
const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260927010000_govern_custom_report_builder.sql'), 'utf8');

test('email delivery requires reviewed publication and refuses portal-delivered packs', () => {
  assert.match(send, /pack\.status !== 'generated' \|\| !pack\.published_at/);
  assert.match(send, /pack\.delivery_channel === 'portal'/);
  assert.match(send, /live portal reporting/);
  assert.match(migration, /monthly_report_pack_sent/);
  assert.match(send, /function escapeHtml/);
  assert.match(migration, /Recipient must match the active primary client contact/);
  assert.match(migration, /delivery_recipient = v_recipient/);
  assert.match(migration, /'recipient', v_recipient/);
  assert.match(send, /p_delivery_attempt_id: deliveryAttemptId/);
  assert.match(send, /rpc\('claim_report_pack_email_delivery'/);
  assert.match(send, /rpc\('finalize_report_pack_email_delivery'/);
  assert.match(send, /pack\.pdf_source_updated_at !== pack\.updated_at/);
  assert.match(send, /Generate the reviewed PDF before sending this report/);
  assert.match(send, /createSignedUrl\(pdfPath, 7 \* 24 \* 60 \* 60\)/);
  assert.match(send, /const claim = await claimEmailDelivery[\s\S]+const pdfUrl = await createReportDownloadUrl/);
  assert.doesNotMatch(send, /from\('monthly_report_packs'\)\.update/);
});

test('PDF previews include editorial content and cannot overwrite an issued artifact', () => {
  assert.match(pdf, /pack\.editorial \?\? \{\}/);
  assert.match(pdf, /Executive summary/);
  assert.match(pdf, /Source-derived metrics/);
  assert.match(pdf, /report-packs\/\$\{pack\.id\}\/\$\{checksum\}\.pdf/);
  assert.match(migration, /v_pack\.status not in \('draft', 'generated'\)/);
  assert.doesNotMatch(pdf, /\['generated', 'sent'\]/);
  assert.match(pdf, /registerFontkit\(fontkit\)/);
  assert.match(pdf, /noto-sans-latin-ext-400-normal\.woff/);
  assert.match(pdf, /p_expected_updated_at: pack\.updated_at/);
  assert.match(pdf, /rpc\('record_report_pack_pdf'/);
  assert.match(pdf, /remove\(\[path\]\)/);
  assert.match(pdf, /remove\(\[pack\.pdf_path\]\)/);
  assert.match(pdf, /widthOfTextAtSize/);
  assert.doesNotMatch(pdf, /truncateCodePoints/);
});

test('client portal reads reviewed editorial content from published report packs', () => {
  assert.match(client, /status, editorial, generated_at, updated_at, published_at, delivery_channel/);
  assert.match(client, /report\.editorial\?\.title/);
  assert.match(client, /report\.editorial\?\.executive_summary/);
  assert.match(client, /Available live/);
});
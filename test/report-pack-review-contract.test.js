const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const send = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/send-report-pack/index.ts'), 'utf8');
const pdf = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'), 'utf8');
const client = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/ClientPortalPage.tsx'), 'utf8');

test('email delivery requires reviewed publication and refuses portal-delivered packs', () => {
  assert.match(send, /pack\.status !== 'generated' \|\| !pack\.published_at/);
  assert.match(send, /pack\.delivery_channel === 'portal'/);
  assert.match(send, /live portal reporting/);
  assert.match(send, /monthly_report_pack_sent/);
  assert.match(send, /function escapeHtml/);
});

test('PDF previews include editorial content and cannot overwrite an issued artifact', () => {
  assert.match(pdf, /pack\.editorial \?\? \{\}/);
  assert.match(pdf, /Executive summary/);
  assert.match(pdf, /Source-derived metrics/);
  assert.match(pdf, /report-packs\/\$\{pack\.id\}\/\$\{checksum\}\.pdf/);
  assert.match(pdf, /\.in\('status', \['draft', 'generated'\]\)/);
  assert.doesNotMatch(pdf, /\['generated', 'sent'\]/);
});

test('client portal reads reviewed editorial content from published report packs', () => {
  assert.match(client, /status, editorial, generated_at, published_at, delivery_channel/);
  assert.match(client, /report\.editorial\?\.title/);
  assert.match(client, /report\.editorial\?\.executive_summary/);
  assert.match(client, /Available live/);
});
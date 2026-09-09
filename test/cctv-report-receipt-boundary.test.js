const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260909040000_cctv_report_receipts.sql'), 'utf8');

test('CCTV reports are issued as immutable, tenant-scoped hashed receipts', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.cctv_report_receipts/);
  assert.match(migration, /payload jsonb NOT NULL/);
  assert.match(migration, /sha256 text NOT NULL CHECK \(sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /issue_cctv_report_receipt/);
  assert.match(migration, /digest\(convert_to\(payload_text, 'UTF8'\), 'sha256'\)/);
  assert.match(migration, /cctv_report_receipt_issued/);
  assert.match(migration, /p_job_id[\s\S]*p_evidence_id[\s\S]*p_organization_id/);
});

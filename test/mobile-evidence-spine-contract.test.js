const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerEvidence.ts'), 'utf8');
const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260903160000_unified_evidence_media_spine.sql'),
  'utf8'
);

test('mobile evidence uses governed register_evidence_media_item RPC', () => {
  assert.match(source, /rpc\('register_evidence_media_item'/);
  assert.match(source, /p_module_key: moduleKey/);
  assert.match(source, /p_sha256_hash: sha256Hash/);
  assert.match(source, /Evidence media registration was not confirmed/);
});

test('mobile evidence supports court-ready sealing via seal_court_ready_evidence RPC', () => {
  assert.match(source, /rpc\('seal_court_ready_evidence'/);
  assert.match(source, /p_evidence_id: evidenceId/);
  assert.match(source, /Court-ready evidence sealing was not confirmed/);
});

test('migration defines court-ready lock, sha256_hash, retention_days, and audit log', () => {
  assert.match(migration, /create or replace function public\.register_evidence_media_item/);
  assert.match(migration, /create or replace function public\.seal_court_ready_evidence/);
  assert.match(migration, /sha256_hash text/);
  assert.match(migration, /retention_days integer/);
  assert.match(migration, /is_court_ready boolean/);
  assert.match(migration, /evidence_media_registered/);
  assert.match(migration, /evidence_media_sealed/);
});

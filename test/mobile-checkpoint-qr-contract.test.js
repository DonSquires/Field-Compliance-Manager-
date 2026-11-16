const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerCheckpointScanner.tsx'), 'utf8');

test('mobile QR checkpoint scan resolves through the officer operating shift', () => {
  assert.match(source, /CameraView/);
  assert.match(source, /barcodeTypes: \['qr'\]/);
  assert.match(source, /supabase\.rpc\('resolve_officer_checkpoint_qr', \{ p_shift_id: shiftId, p_qr_code: rawCode \}\)/);
  assert.doesNotMatch(source, /from\('patrol_checkpoints'\)/, 'profile-branch RLS must not decide which checkpoint a shift can scan');
});

test('mobile checkpoint evidence verifies GPS and records canonical attendance', () => {
  assert.match(source, /Location\.getCurrentPositionAsync/);
  assert.match(source, /GPS accuracy is too poor/);
  assert.match(source, /outside the checkpoint radius/);
  assert.match(source, /supabase\.rpc\('record_officer_checkpoint_visit', pending\.args\)/);
  assert.match(source, /p_checkpoint_id: checkpoint\.id/);
  assert.doesNotMatch(source, /from\('patrols'\)/);
  assert.doesNotMatch(source, /from\('patrol_checkpoint_visits'\)/);
});

test('mobile checkpoint retries resend the frozen payload after a lost response', () => {
  assert.match(source, /prior\.rawCode === rawCode && prior\.args\.p_shift_id === shiftId \? prior : await capture\(rawCode\)/);
  assert.match(source, /if \(isServerRejection\(visitError\)\) pendingRef\.current = null;/);
});
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const safety = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerSafety.ts'), 'utf8');
const bar = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBar.tsx'), 'utf8');

test('mobile welfare writes go through governed RPCs and check every response', () => {
  assert.match(safety, /supabase\.rpc\('record_officer_welfare_checkin'/);
  assert.match(safety, /supabase\.rpc\('raise_officer_sos'/);
  assert.match(safety, /p_client_request_id: crypto\.randomUUID\(\)/);
  assert.doesNotMatch(safety, /from\('welfare_checks'\)/);
  assert.doesNotMatch(safety, /from\('officer_welfare_settings'\)/);
  assert.doesNotMatch(safety, /from\('welfare_alerts'\)/);
  assert.match(safety, /if \(error\) throw error/);
});

test('mobile safety bar confirms SOS and never presents failed writes as confirmed', () => {
  assert.match(bar, /Alert\.alert\('Trigger SOS\?'/);
  assert.match(bar, /'SOS not confirmed'/);
  assert.match(bar, /'Check-in not confirmed'/);
  assert.match(bar, /'SOS confirmed\. Supervisors have been alerted\.'/);
});
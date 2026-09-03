const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const safety = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerSafety.ts'), 'utf8');
const bar = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerSafetyBar.tsx'), 'utf8');

test('mobile welfare writes use canonical tables and check every response', () => {
  assert.match(safety, /from\('welfare_checks'\)\.insert/);
  assert.match(safety, /from\('officer_welfare_settings'\)\.upsert/);
  assert.match(safety, /from\('welfare_alerts'\)\.insert/);
  assert.match(safety, /if \(checkInError\) throw checkInError/);
  assert.match(safety, /if \(settingsError\) throw settingsError/);
  assert.match(safety, /if \(error\) throw error/);
});

test('mobile safety bar confirms SOS and never presents failed writes as confirmed', () => {
  assert.match(bar, /Alert\.alert\('Trigger SOS\?'/);
  assert.match(bar, /'SOS not confirmed'/);
  assert.match(bar, /'Check-in not confirmed'/);
  assert.match(bar, /'SOS confirmed\. Supervisors have been alerted\.'/);
});
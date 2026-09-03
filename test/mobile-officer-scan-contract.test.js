const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerScan.ts'), 'utf8');

test('mobile scan submits evidence only through the governed scan edge function', () => {
  assert.match(source, /functions\.invoke<OfficerScanResult>\('process-officer-scan'/);
  assert.doesNotMatch(source, /\.from\('observations'\)\.insert/);
  assert.doesNotMatch(source, /\.from\('parking_chalk_records'\)\.insert/);
});

test('mobile scan queue preserves capture time and retry provenance', () => {
  assert.match(source, /captured_at: string/);
  assert.match(source, /offline_queued: true/);
  assert.match(source, /synced_at: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /AsyncStorage\.setItem\(QUEUE_KEY/);
  assert.match(source, /export function isNetworkFailure/);
  assert.match(source, /export async function removeQueuedOfficerScan/);
});
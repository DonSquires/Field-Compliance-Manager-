const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/OfficerCredentialsPanel.tsx'), 'utf8');

test('mobile credentials remain a self-scoped read-only view', () => {
  assert.match(source, /from\('staff_credentials'\)\.select/);
  assert.match(source, /\.eq\('staff_id', officerId\)/);
  assert.doesNotMatch(source, /\.insert\(/);
  assert.doesNotMatch(source, /\.update\(/);
});

test('mobile credentials visibly distinguish verification and expiry risk', () => {
  assert.match(source, /days <= 30/);
  assert.match(source, /Verified/);
  assert.match(source, /Unverified/);
  assert.match(source, /Expired/);
});
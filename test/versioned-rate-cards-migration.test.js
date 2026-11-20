'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('rate-card foundation migration and read-only discrepancy report files are present', () => {
  const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations'))
    .filter(file => /^\d{14}_rate_card_foundation\.sql$/.test(file));
  assert.equal(migrations.length, 1, 'Expected exactly one CLI-named rate-card foundation migration');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'rate-card-discrepancy-report.sql')),
    'Expected the independent pre-migration discrepancy report');
});

if (process.env.BOB_TEST_POSTGRES === '1') require('./versioned-rate-cards-postgres.test');

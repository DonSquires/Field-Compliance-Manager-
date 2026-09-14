const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260914001000_report_pack_exclusive_date_window.sql'),
  'utf8',
);
const declarative = fs.readFileSync(
  path.resolve(__dirname, '../supabase/schemas/public/functions/generate_due_report_packs.sql'),
  'utf8',
);

test('report-pack RPC uses an exclusive next-day timestamp boundary', () => {
  for (const source of [migration, declarative]) {
    assert.match(source, /interval '1 day'\);/);
    assert.doesNotMatch(source, /interval '1 second'/);
    assert.match(source, /started_at >= v_start_ts and started_at < v_end_ts/);
    assert.match(source, /created_at >= v_start_ts and created_at < v_end_ts/);
    assert.doesNotMatch(source, /created_at >= v_start_ts and created_at <= v_end_ts/);
  }
});
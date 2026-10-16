'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '../scripts/edge-boot-check.mjs');
const hasDeno = spawnSync('deno', ['--version']).status === 0;

// A module-level error ships as a live BOOT_ERROR that fails every request before any handler runs.
test('every Supabase Edge Function module boots', { skip: !hasDeno && 'deno is not installed', timeout: 600000 }, () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 590000 });
  assert.equal(result.status, 0, `edge functions failed to boot:\n${result.stderr}`);
  assert.match(result.stdout, /^ok {3}onspace-ai-chat$/m);
  assert.match(result.stdout, /^ok {3}bob-builder-control-room$/m);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rankCandidates } = require('../services/fcm-api/src/bob/modelRouter');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20261114120000_vibe_small_local_model_quality.sql');

// Seed rows as the live catalogue held them when VB-15 routed qwen3:8b ahead of capable models.
const PROVIDER_DEFAULTS = [
  { provider: 'gpu_workstation', model_name: '*', privacy_class: 'local', cost_tier: 0, base_quality: 0.55, task_quality: { author: 0.5, light: 0.6, analysis: 0.55, conversation: 0.6 }, active: true },
  { provider: 'ollama_cloud', model_name: '*', privacy_class: 'external', cost_tier: 1, base_quality: 0.65, task_quality: { author: 0.65, analysis: 0.65 }, active: true },
  { provider: 'anthropic', model_name: '*', privacy_class: 'external', cost_tier: 3, base_quality: 0.85, task_quality: { author: 0.88 }, active: true },
];

function migrationRows(sql) {
  const rows = [];
  const tuple = /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*([\d.]+),\s*'(\{[^']*\})'::jsonb,\s*(true|false)/g;
  for (const m of sql.matchAll(tuple)) {
    rows.push({ provider: m[1], model_name: m[2], privacy_class: m[3], cost_tier: Number(m[4]), base_quality: Number(m[5]), task_quality: JSON.parse(m[6]), active: m[7] === 'true' });
  }
  return rows;
}

test('small local models rank below capable providers for Vibe code changes once catalogued per model', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /on conflict \(provider, model_name\) do nothing/i, 'additive seed must not overwrite an operator-tuned row');
  const rows = migrationRows(sql);
  assert.deepEqual(rows.map(row => `${row.provider}/${row.model_name}`).sort(), ['gpu_workstation/qwen2.5-coder:7b', 'gpu_workstation/qwen3:8b']);

  const candidates = [
    { provider: 'gpu_workstation', model: 'qwen3:8b' },
    { provider: 'gpu_workstation', model: 'qwen2.5-coder:7b' },
    { provider: 'ollama_cloud', model: 'qwen3-coder:480b' },
    { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  ];
  for (const taskClass of ['general', 'author']) {
    const ranked = rankCandidates({ candidates, catalog: PROVIDER_DEFAULTS.concat(rows), taskClasses: [{ match_kind: 'workload_kind', match_value: 'code_change', task_class: taskClass }], workloadKind: 'code_change', surface: 'vibe' });
    const order = ranked.ordered.map(entry => entry.provider);
    assert.deepEqual(order.slice(-2), ['gpu_workstation', 'gpu_workstation'], `${taskClass}: ${JSON.stringify(ranked.ordered.map(e => [e.model, e.score]))}`);
  }
});

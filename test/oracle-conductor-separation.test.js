const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const oracle = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/conductor-oracle.ts'), 'utf8');
const welfare = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts'), 'utf8');

test('generic Oracle describes truth without tool selection or enforcement', () => {
  assert.ok(oracle.includes('buildOracleTurnTruthState'));
  assert.ok(oracle.includes('explicit_hold'));
  assert.ok(oracle.includes('effect_class'));
  assert.ok(oracle.includes('turn_scope'));
  assert.ok(oracle.includes('proof_grade'));
  assert.ok(!oracle.includes('isToolEffectPermitted'));
  assert.ok(!oracle.includes('dispatchTool'));
  assert.ok(!oracle.includes('conductorSafetyPrecedence'));
});

test('welfare is a domain extension of the generic Oracle', () => {
  assert.ok(welfare.includes("from './conductor-oracle.ts'"));
  assert.ok(welfare.includes('buildGenericOracleTurnTruthState'));
  assert.ok(welfare.includes('welfare: input.welfare_context'));
});

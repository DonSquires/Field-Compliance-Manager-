const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const chat = read('supabase/functions/onspace-ai-chat/index.ts');
const caddie = read('supabase/functions/onspace-ai-chat/caddie.ts');
const executor = read('supabase/functions/bob-proposal-execute/index.ts');
const producer = read('supabase/functions/bob-propose-compliance-record/index.ts');
const migration = read('supabase/migrations/20261016120000_bob_compliance_record_proposals.sql');
const planPrompt = read('services/fcm-api/src/bob/planPrompt.js');

test('Bob discovers the compliance-register tool from its catalogue purpose', () => {
  assert.match(caddie, /propose_compliance_record: \{/);
  assert.match(caddie, /propose_compliance_record: 'bob-propose-compliance-record'/);
  assert.match(caddie, /H&S and compliance profile/);
  assert.match(caddie, /effect_class: 'draft_governed_write'/);
  assert.match(chat, /t\.tool === 'propose_compliance_record' && caps\.canPromote/);
  assert.match(chat, /case 'propose_compliance_record':\s*return execProposeComplianceRecord/);
  assert.match(chat, /callFn\('bob-propose-compliance-record', authHeader/);
  assert.match(chat, /ATLAS CALLS:[^\n]*bob-propose-compliance-record/);
});

test('compliance-register proposals are write-capable and governed', () => {
  const lock = chat.slice(chat.indexOf('function isGovernanceLocked'), chat.indexOf('function handleHelpStatus'));
  assert.match(lock, /'propose_compliance_record'/);
  const writeSet = chat.slice(chat.indexOf('const WRITE_CAPABLE_TOOLS'), chat.indexOf(']);', chat.indexOf('const WRITE_CAPABLE_TOOLS')));
  assert.match(writeSet, /'propose_compliance_record'/);
});

test('producer files pending actions only, with explicit org scope and provenance', () => {
  assert.match(producer, /action_type: 'create_org_compliance_record'/);
  assert.match(producer, /status: 'pending'/);
  assert.match(producer, /rpc\('is_admin_for_org'/);
  assert.match(producer, /explicit organization UUID/);
  assert.match(producer, /needs source_as_of/);
  assert.match(producer, /idempotency_key: idempotencyKey/);
  assert.doesNotMatch(producer, /from\('organization_compliance_records'\)\.(insert|update|upsert)/);
});

test('executor applies approved actions through the service-only RPC', () => {
  assert.match(executor, /'create_org_compliance_record'/);
  assert.match(executor, /rpc\('apply_bob_compliance_record_proposal', \{ p_action_id: action\.id \}\)/);
  assert.match(migration, /action_type <> 'create_org_compliance_record' OR v_action\.status <> 'approved'/);
  assert.match(migration, /v_actor\.role NOT IN \('grand_master', 'master'\)/);
  assert.match(migration, /can_approve_action\(v_action\.approved_by, v_org_id\)/);
  assert.match(migration, /client_request_id = v_action\.id/);
  assert.match(migration, /'bob_compliance_record_proposal_applied'/);
  assert.doesNotMatch(migration, /verification_status\s*=\s*'verified'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.apply_bob_compliance_record_proposal\(uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.apply_bob_compliance_record_proposal\(uuid\) TO service_role;/);
});

test('planner treats update requests as governed filing, not prose', () => {
  assert.match(planPrompt, /OUTCOME OVER WORDING/);
  assert.match(planPrompt, /reason from purposes, not keywords/);
  assert.doesNotMatch(planPrompt, /UPDATE MEANS FILE|asks to update, apply, add/);
  assert.doesNotMatch(planPrompt, /H&S|health and safety/i);
});

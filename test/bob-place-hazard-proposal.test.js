const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const chat = read('supabase/functions/onspace-ai-chat/index.ts');
const caddie = read('supabase/functions/onspace-ai-chat/caddie.ts');
const executor = read('supabase/functions/bob-proposal-execute/index.ts');
const producer = read('supabase/functions/bob-propose-place-hazards/index.ts');
const source = read('supabase/functions/place-hazard-source/index.ts');
const migration = read('supabase/migrations/20261018090000_place_hazard_register_briefings.sql');
const planPrompt = read('services/fcm-api/src/bob/planPrompt.js');

test('Bob discovers the place-hazard tool from its catalogue purpose, not keyword routing', () => {
  assert.match(caddie, /propose_place_hazards: \{/);
  assert.match(caddie, /propose_place_hazards: 'bob-propose-place-hazards'/);
  assert.match(chat, /t\.tool === 'propose_place_hazards' && caps\.canPromote/);
  assert.match(chat, /case 'propose_place_hazards':\s*return execProposePlaceHazards/);
  assert.match(chat, /callFn\('bob-propose-place-hazards', authHeader/);
  assert.match(chat, /ATLAS CALLS:[^\n]*bob-propose-place-hazards/);
  assert.doesNotMatch(planPrompt, /H&S|health and safety|place_hazard/i);
});

test('place-hazard proposals are write-capable and governance-locked', () => {
  const lock = chat.slice(chat.indexOf('function isGovernanceLocked'), chat.indexOf('function handleHelpStatus'));
  assert.match(lock, /'propose_place_hazards'/);
  const writeSet = chat.slice(chat.indexOf('const WRITE_CAPABLE_TOOLS'), chat.indexOf(']);', chat.indexOf('const WRITE_CAPABLE_TOOLS')));
  assert.match(writeSet, /'propose_place_hazards'/);
});

test('producer files pending, idempotent actions only and never writes the register', () => {
  assert.match(producer, /action_type: 'create_place_hazard'/);
  assert.match(producer, /status: 'pending'/);
  assert.match(producer, /rpc\('is_admin_for_org'/);
  assert.match(producer, /rpc\('can_manage_place_hazards'/);
  assert.match(producer, /idempotency_key: idempotencyKey/);
  assert.doesNotMatch(producer, /from\('place_hazards'\)\s*\.(insert|update|upsert|delete)/);
});

test('executor applies approved actions through the service-only RPC', () => {
  assert.match(executor, /'create_place_hazard'/);
  assert.match(executor, /rpc\('apply_bob_place_hazard_proposal', \{ p_action_id: action\.id \}\)/);
  assert.match(migration, /action_type <> 'create_place_hazard' OR v_action\.status <> 'approved'/);
  assert.match(migration, /can_approve_action\(v_action\.approved_by, v_org\)/);
  assert.match(migration, /'bob_place_hazard_proposal_applied'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.apply_bob_place_hazard_proposal\(uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.apply_bob_place_hazard_proposal\(uuid\) TO service_role;/);
});

test('register is read-only to clients; officers write only through governed RPCs', () => {
  assert.match(migration, /GRANT SELECT ON public\.place_hazards TO authenticated;/);
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*ON public\.place_hazards TO authenticated/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /HINT = 'briefing_changed'/);
  for (const fn of ['get_shift_safety_briefing', 'acknowledge_safety_briefing', 'report_place_hazard', 'manage_place_hazard', 'get_place_hazard_register', 'get_place_hazard_source']) {
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`));
  }
});

test('source documents are signed only after the caller-scoped RPC authorises them', () => {
  assert.match(source, /rpc\('get_place_hazard_source'/);
  assert.match(source, /createSignedUrl/);
  assert.match(source, /bob-uploads/);
});

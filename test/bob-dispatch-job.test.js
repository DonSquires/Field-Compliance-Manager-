const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../supabase/functions/_shared/dispatch-job-resolve.mjs');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const agreements = [
  { id: 'a-gibbons', name: 'Gibbons Property Managment services', client_name: 'Gibbons Property Managment' },
  { id: 'a-ofo', name: 'Forest security', client_name: 'OneFortyOne New Zealand' },
];
const places = [
  { id: 'z-burger', kind: 'zone', name: 'Burger N Beast Richmond', agreement_id: 'a-gibbons' },
  { id: 'z-mall', kind: 'zone', name: 'Richmond Mall', agreement_id: 'a-gibbons' },
  { id: 'z-smiths', kind: 'zone', name: 'Smiths', agreement_id: 'a-ofo' },
];

test('a place name alone resolves its agreement when it is unique', async () => {
  const { resolveDispatchPlace } = await load();
  const result = resolveDispatchPlace({ agreements, places, placeQuery: 'burger n beast' });
  assert.equal(result.status, 'ok');
  assert.equal(result.agreement.id, 'a-gibbons');
  assert.equal(result.place.id, 'z-burger');
});

test('the client name selects the agreement, misspelt or not', async () => {
  const { resolveDispatchPlace } = await load();
  const result = resolveDispatchPlace({ agreements, places, agreementQuery: 'Gibbons', placeQuery: 'Burger N Beast Richmond' });
  assert.equal(result.status, 'ok');
  assert.equal(result.place.id, 'z-burger');
});

test('ambiguous places are returned for a question, not guessed', async () => {
  const { resolveDispatchPlace } = await load();
  const result = resolveDispatchPlace({ agreements, places, agreementQuery: 'Gibbons', placeQuery: 'Richmond' });
  assert.equal(result.status, 'place_ambiguous');
  assert.deepEqual(result.options.map((place) => place.id).sort(), ['z-burger', 'z-mall']);
});

test('an unknown agreement or place never falls through to a write', async () => {
  const { resolveDispatchPlace } = await load();
  assert.equal(resolveDispatchPlace({ agreements, places, agreementQuery: 'Nobody Ltd', placeQuery: 'Smiths' }).status, 'agreement_not_found');
  assert.equal(resolveDispatchPlace({ agreements, places, agreementQuery: 'Gibbons', placeQuery: 'Smiths' }).status, 'place_not_found');
  assert.equal(resolveDispatchPlace({ agreements, places, agreementQuery: 'Gibbons' }).status, 'place_required');
});

test('officer names match exactly before partially', async () => {
  const { matchByName } = await load();
  const officers = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Don Squires' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Don Squires Field' },
  ];
  assert.equal(matchByName(officers, 'Don Squires Field').match.name, 'Don Squires Field');
  assert.equal(matchByName(officers, 'don squires').match.name, 'Don Squires');
  assert.equal(matchByName(officers, 'squires').status, 'many');
  assert.equal(matchByName(officers, '22222222-2222-4222-8222-222222222222').match.name, 'Don Squires Field');
});

test('job type, priority and response target come from plain words', async () => {
  const { normalizeJobType, normalizePriority, resolveSlaMinutes } = await load();
  assert.equal(normalizeJobType('Patrol Support'), 'patrol_support');
  assert.equal(normalizeJobType('noise complaint'), 'noise_control');
  assert.equal(normalizeJobType(''), 'patrol_support');
  assert.equal(normalizeJobType('bake a cake'), null);
  assert.equal(normalizePriority('ASAP'), 'urgent');
  assert.equal(normalizePriority(undefined), 'normal');
  assert.equal(normalizePriority('sideways'), null);
  assert.equal(resolveSlaMinutes(undefined, 'high'), 30);
  assert.equal(resolveSlaMinutes(45, 'high'), 45);
  assert.equal(resolveSlaMinutes(5000, 'high'), null);
});

test('Bob dispatch_job is a gated, audited write through create_and_assign_dispatch_job', () => {
  const chat = read('supabase/functions/onspace-ai-chat/index.ts');
  const caddie = read('supabase/functions/onspace-ai-chat/caddie.ts');
  const migration = read('supabase/migrations/20261106110000_create_and_assign_dispatch_job.sql');
  assert.match(chat, /case 'dispatch_job':/);
  assert.match(chat, /callerClient\.rpc\('create_and_assign_dispatch_job'/);
  assert.match(chat, /if \(canPromote\) allowedTools\.push\('dispatch_job'\)/);
  assert.match(caddie, /dispatch_job: \{[\s\S]*?effect_class: 'direct_world_change'/);
  assert.match(caddie, /dispatch_job: 'onspace-ai-chat'/);
  assert.match(migration, /is_admin_for_org\(v_agreement\.provider_organization_id\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_and_assign_dispatch_job[^;]+FROM PUBLIC, anon;/);
  assert.match(migration, /'dispatch_job_created_and_assigned'/);
});

test('bob-query-records reaches client organisations served by the caller', () => {
  const source = read('supabase/functions/bob-query-records/index.ts');
  assert.match(source, /get_descendant_organizations/);
  assert.match(source, /request\.in\('id', await reachableOrgIds\(\)\)/);
  assert.doesNotMatch(source, /if \(!unrestricted\) request = request\.eq\('id', scopedOrgId\)/);
});

'use strict';
// In-app Bob updates people, vehicles and reports from facts he is given: preview first, then the caller's
// own next-turn yes applies it as the caller through existing audited RPCs. Synthetic data only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const chat = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');
const planner = require('../services/fcm-api/src/bob/planPrompt.js');
const load = () => import('../supabase/functions/_shared/record-updates.mjs');

const ORG = '0a000000-0000-4000-8000-000000000001';
const VEH = '0b000000-0000-4000-8000-000000000002';
const PERSON = '0c000000-0000-4000-8000-000000000003';
const CANON = '0d000000-0000-4000-8000-000000000004';
const OBS = '0e000000-0000-4000-8000-000000000005';
const PLAN = '0f000000-0000-4000-8000-000000000006';
const MSG = '10000000-0000-4000-8000-000000000007';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SUMMARY = 'Council email about vehicle TST123';
const KEY = 'test-only-record-update-signing-key-0123456789abcdef';
const migration = fs.readFileSync('supabase/migrations/20261101180000_manage_identity_vehicle_preserve_notes.sql', 'utf8');

function fakeRpc(handlers) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected RPC ${name}`);
    return handler(args);
  };
  return { rpc, calls, names: () => calls.map((c) => c.name) };
}
const ok = (data) => () => ({ data, error: null });
const fail = (message) => () => ({ data: null, error: { message } });
const exactMatch = (id, name) => ({ person_record_id: id, display_name: name, match_basis: 'name_exact', score: 0.97 });

test('validation applies safe defaults and holds anything without a governed path', async () => {
  const { validateRecordUpdatePlan, normalisePlate, RECORD_UPDATE_MAX_OPERATIONS } = await load();
  assert.equal(normalisePlate(' tst-123 '), 'TST123');
  assert.equal(normalisePlate('ABCDEFGHIJK'), null);
  assert.equal(validateRecordUpdatePlan({ operations: [] }).ok, false);
  assert.equal(validateRecordUpdatePlan({ operations: Array(RECORD_UPDATE_MAX_OPERATIONS + 1).fill({ kind: 'unsupported' }) }).ok, false);

  const { ok: valid, plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'vehicle_person_link', plate: 'tst 123', person: 'Alex Example' },
      { kind: 'person_alias', person: { name: 'Alex Example' }, alias: 'AJ' },
      { kind: 'safety_warning', target: { type: 'vehicle', plate: 'TST123' }, note: 'Dog in the vehicle' },
      { kind: 'record_note', record_kind: 'observation', record_id: OBS, body: 'Council confirmed the owner.' },
      { kind: 'vehicle_person_link', plate: 'TST123', person: 'Alex Example', source: 'nzta_mvr' },
      { kind: 'vehicle_details', plate: 'TST123', fields: { year: 1700 } },
      { kind: 'vehicle_details', plate: 'TST123', fields: { wof_expiry: '31/12/2026' } },
      { kind: 'safety_warning', target: { type: 'site', site_id: 'not-a-uuid' }, note: 'Locked gate' },
      { kind: 'unsupported', statement: 'Change the infringement fee', reason: 'Fees are set by bylaw.' },
      { kind: 'delete_person', statement: 'Delete Alex' },
    ],
  });
  assert.equal(valid, true);
  assert.deepEqual(plan.operations.map((op) => op.kind), ['vehicle_person_link', 'person_alias', 'safety_warning', 'record_note']);
  const [link, alias, warning, note] = plan.operations;
  assert.equal(link.plate, 'TST123');
  assert.equal(link.relationship, 'associated_person');
  assert.equal(link.source, 'other');
  assert.equal(link.basis, SUMMARY);
  assert.equal(alias.alias_kind, 'aka');
  assert.equal(warning.hazard_class, 'other');
  assert.equal(warning.alert_level, 'medium');
  assert.equal(note.entry_kind, 'note');
  assert.deepEqual(plan.held.map((h) => h.index), [4, 5, 6, 7, 8, 9]);
  assert.match(plan.held[0].reason, /NZTA register is only loaded through its governed import/);
  assert.match(plan.held[1].reason, /year is not a valid vehicle year/);
  assert.match(plan.held[2].reason, /wof_expiry must be a date/);
  assert.match(plan.held[3].reason, /record id/);
  assert.equal(plan.held[4].reason, 'Fees are set by bylaw.');
  assert.match(plan.held[5].reason, /no governed way .* "delete_person"/);
});

test('an unknown plate and new person become register, create-by-link, alias and warnings without UUIDs in labels', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, renderRecordUpdatePreview } = await load();
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'vehicle_details', plate: 'TST123', fields: { make: 'Toyota', colour: 'Blue' } },
      { kind: 'vehicle_person_link', plate: 'TST123', person: 'Alex Example', relationship: 'owner', source: 'owner_declared' },
      { kind: 'person_alias', person: 'Alex Example', alias: 'AJ', alias_kind: 'nickname' },
      { kind: 'safety_warning', target: { type: 'person', name: 'Alex Example' }, hazard_class: 'violence_or_aggression', alert_level: 'high', note: 'Raised voice at last visit' },
      { kind: 'safety_warning', target: { type: 'vehicle', plate: 'TST123' }, hazard_class: 'dangerous_dog', note: 'Dog in the vehicle' },
    ],
  });
  const db = fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: ok([]) });
  const { steps, held } = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(held, []);
  assert.deepEqual(steps.map((s) => s.kind), ['register_vehicle', 'vehicle_person_link', 'person_alias', 'safety_warning', 'safety_warning']);
  assert.deepEqual(steps[0].fields, { make: 'Toyota', colour: 'Blue' });
  assert.match(steps[0].label, /not yet on record/);
  assert.equal(steps[1].creates_person, true);
  assert.equal(steps[1].person_record_id, null);
  assert.match(steps[1].label, /new person record/);
  assert.match(steps[1].label, /replaces any current owner link/);
  assert.match(steps[2].label, /created above/);
  assert.equal(steps[3].entity_id, null);
  assert.equal(steps[3].entity_type, 'person');
  assert.equal(steps[4].entity_type, 'vehicle');
  for (const step of steps) assert.doesNotMatch(step.label, UUID_RE);
  assert.deepEqual([...new Set(db.names())].sort(), ['find_person_matches', 'search_vehicle_registrations']);
  assert.deepEqual(db.calls.find((c) => c.name === 'search_vehicle_registrations').args, { p_pattern: 'TST123', p_limit: 5 });
  assert.deepEqual(db.calls.find((c) => c.name === 'find_person_matches').args, { p_organization_id: ORG, p_name: 'Alex Example', p_limit: 8 });

  const preview = renderRecordUpdatePreview({ steps, held });
  assert.match(preview, /^Preview — I will make these 5 changes as you/);
  assert.match(preview, /Nothing has been written yet\. Reply \*\*yes\*\* to apply these as you, or \*\*no\*\* to discard/);
  assert.match(preview, /visible to every organisation; the note stays in yours/);
});

test('existing records bind exactly; ambiguity, missing identity and search denial are held, not guessed', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, renderRecordUpdatePreview } = await load();
  const operations = [
    { kind: 'vehicle_details', plate: 'TST123', fields: { colour: 'Red' } },
    { kind: 'safety_warning', target: { type: 'person', name: 'Alex Example' }, note: 'Known to carry tools' },
    { kind: 'vehicle_person_link', plate: 'TST123', person: 'Sam Sample' },
    { kind: 'person_alias', person: 'Jo Nobody', alias: 'JN' },
  ];
  const { plan } = validateRecordUpdatePlan({ source_summary: SUMMARY, operations });
  const db = fakeRpc({
    search_vehicle_registrations: ok([{ id: VEH, plate_number: 'TST123' }]),
    find_person_matches: ({ p_name }) => ({
      data: p_name === 'Alex Example' ? [exactMatch(PERSON, 'Alex Example')]
        : p_name === 'Sam Sample' ? [exactMatch(PERSON, 'Sam Sample'), exactMatch(CANON, 'Sam Sample')] : [],
      error: null,
    }),
    get_identity_registry: ok({ people: [{ person_record_id: PERSON, canonical_person_id: CANON }] }),
  });
  const { steps, held } = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(steps.map((s) => s.kind), ['update_vehicle_details', 'safety_warning']);
  assert.equal(steps[0].vehicle_id, VEH);
  assert.match(steps[0].label, /shared vehicle profile/);
  assert.equal(steps[1].entity_id, CANON);
  assert.match(steps[1].label, /Alex Example/);
  assert.deepEqual(held.map((h) => h.index), [2, 3]);
  assert.match(held[0].reason, /2 people match "Sam Sample"/);
  assert.match(held[1].reason, /no one to add "JN" to yet/);
  assert.match(renderRecordUpdatePreview({ steps, held }), /Not included \(nothing will be written for these\):/);

  const denied = fakeRpc({
    search_vehicle_registrations: ok([{ id: null, plate_number: 'TST123' }]),
    find_person_matches: fail('permission denied (42501)'),
  });
  const second = await resolveRecordUpdatePlan({
    rpc: denied.rpc, organizationId: ORG,
    plan: validateRecordUpdatePlan({ operations: [operations[0], operations[2]] }).plan,
  });
  assert.deepEqual(second.steps.map((s) => s.kind), ['register_vehicle']);
  assert.match(second.steps[0].label, /seen in observations but not yet registered/);
  assert.match(second.held[0].reason, /do not have person-search access/);

  const unconfirmed = fakeRpc({
    find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]),
    get_identity_registry: fail('Organisation administrator access required'),
  });
  const third = await resolveRecordUpdatePlan({ rpc: unconfirmed.rpc, organizationId: ORG, plan: validateRecordUpdatePlan({ operations: [operations[1]] }).plan });
  assert.deepEqual(third.steps, []);
  assert.match(third.held[0].reason, /could not confirm the platform identity/);
  assert.match(renderRecordUpdatePreview(third), /^I could not turn any of that into a change I can make safely/);

  const noOrg = await resolveRecordUpdatePlan({ rpc: () => { throw new Error('no lookups without an org'); }, organizationId: null, plan });
  assert.deepEqual(noOrg.steps, []);
  assert.equal(noOrg.held.length, operations.length);
});

async function newRecordPlan(mod) {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan } = mod;
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'vehicle_details', plate: 'TST123', fields: { make: 'Toyota' } },
      { kind: 'vehicle_person_link', plate: 'TST123', person: 'Alex Example', relationship: 'driver' },
      { kind: 'person_alias', person: 'Alex Example', alias: 'AJ' },
      { kind: 'safety_warning', target: { type: 'person', name: 'Alex Example' }, hazard_class: 'violence_or_aggression', note: 'Raised voice at last visit' },
      { kind: 'safety_warning', target: { type: 'vehicle', plate: 'TST123' }, hazard_class: 'dangerous_dog', note: 'Dog in the vehicle' },
    ],
  });
  const db = fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: ok([]) });
  const { steps, held } = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  return { plan_id: PLAN, source_summary: SUMMARY, steps, held };
}

test('a confirmed plan applies in order through the audited RPCs, carrying created ids forward', async () => {
  const mod = await load();
  const pending = await newRecordPlan(mod);
  const db = fakeRpc({
    search_vehicle_registrations: ok([]),
    manage_identity_vehicle: ok({ vehicle_id: VEH, plate_number: 'TST123' }),
    record_vehicle_person: ok({ link_id: OBS, person_record_id: PERSON, canonical_person_id: CANON, relationship: 'driver' }),
    add_person_alias: ok(null),
    get_safety_warnings: ok([{ hazard_class: 'dangerous_dog', is_own_organization: false }]),
    raise_entity_flag: ok({ id: OBS }),
  });
  const { outcome, receipts } = await mod.applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending });
  assert.equal(outcome, 'applied');
  assert.deepEqual(receipts.map((r) => r.status), ['applied', 'applied', 'applied', 'applied', 'applied']);
  assert.deepEqual(db.names(), [
    'search_vehicle_registrations', 'manage_identity_vehicle', 'record_vehicle_person', 'add_person_alias',
    'get_safety_warnings', 'raise_entity_flag', 'get_safety_warnings', 'raise_entity_flag',
  ]);
  const args = (name, n = 0) => db.calls.filter((c) => c.name === name)[n].args;
  assert.deepEqual(args('manage_identity_vehicle'), {
    p_organization_id: ORG, p_vehicle_id: null, p_plate: 'TST123', p_fields: { make: 'Toyota' },
    p_reason: `Bob chat (confirmed by user): ${SUMMARY}`,
  });
  assert.equal('notes' in args('manage_identity_vehicle').p_fields, false);
  assert.deepEqual(args('record_vehicle_person'), {
    p_organization_id: ORG, p_canonical_vehicle_id: VEH, p_person_record_id: null,
    p_person_fields: { display_name: 'Alex Example' }, p_relationship: 'driver', p_source: 'other',
    p_basis: SUMMARY, p_observation_id: null,
  });
  assert.deepEqual(args('add_person_alias'), { p_person_record_id: PERSON, p_alias: 'AJ', p_alias_kind: 'aka', p_notes: null });
  const personFlag = args('raise_entity_flag', 0);
  const vehicleFlag = args('raise_entity_flag', 1);
  assert.deepEqual({ ...personFlag, p_client_request_id: undefined }, {
    p_client_request_id: undefined, p_entity_type: 'person', p_entity_id: CANON, p_flag_type: 'safety_warning',
    p_alert_level: 'medium', p_reason: 'Raised voice at last visit', p_hazard_class: 'violence_or_aggression',
  });
  assert.equal(vehicleFlag.p_entity_id, VEH);
  assert.equal(vehicleFlag.p_entity_type, 'vehicle');
  assert.equal(personFlag.p_client_request_id, await mod.deterministicUuid(`${PLAN}:3`));
  assert.equal(vehicleFlag.p_client_request_id, await mod.deterministicUuid(`${PLAN}:4`));
  assert.notEqual(personFlag.p_client_request_id, vehicleFlag.p_client_request_id);
  assert.match(mod.renderRecordUpdateReceipts({ receipts, held: [] }), /^I made 5 changes as you\. Here is exactly what happened:/);
});

test('a failed re-check never registers blind, and dependent steps are skipped truthfully', async () => {
  const mod = await load();
  const pending = await newRecordPlan(mod);
  const db = fakeRpc({
    search_vehicle_registrations: fail('statement timeout'),
    find_person_matches: ok([]),
  });
  const { outcome, receipts } = await mod.applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending });
  assert.equal(outcome, 'failed');
  assert.deepEqual(receipts.map((r) => r.status), ['failed', 'skipped_dependency', 'skipped_dependency', 'skipped_dependency', 'skipped_dependency']);
  assert.match(receipts[0].detail, /Could not re-check TST123 before registering/);
  assert.deepEqual(db.names(), ['search_vehicle_registrations']);
  const rendered = mod.renderRecordUpdateReceipts({ receipts, held: [{ index: 9, statement: 'fee', reason: 'Fees are set by bylaw.' }] });
  assert.match(rendered, /^Nothing was written\. Here is exactly what happened:/);
  assert.match(rendered, /Not done — Register vehicle TST123/);
  assert.match(rendered, /Not attempted — Link/);
  assert.match(rendered, /Still not recorded .*\n- fee: Fees are set by bylaw\./);
});

test('existing facts are reported as already present, and database refusals are reported without leaking names', async () => {
  const mod = await load();
  const pending = {
    plan_id: PLAN, source_summary: SUMMARY, held: [],
    steps: [
      { kind: 'register_vehicle', label: 'Register vehicle TST123', plate: 'TST123', fields: { colour: 'Blue' } },
      { kind: 'vehicle_person_link', label: 'Link Alex Example', plate: 'TST123', vehicle_id: null, person_ref: 'name:alex example', person_record_id: null, display_name: 'Alex Example', relationship: 'associated_person', source: 'other', basis: SUMMARY },
      { kind: 'person_alias', label: 'Record "AJ"', person_ref: 'name:sam', person_record_id: PERSON, alias: 'AJ', alias_kind: 'aka' },
      { kind: 'safety_warning', label: 'Raise warning', entity_type: 'vehicle', entity_id: VEH, hazard_class: 'dangerous_dog', alert_level: 'low', note: 'Dog in the vehicle' },
      { kind: 'record_note', label: 'Add a note', record_kind: 'observation', record_id: OBS, entry_kind: 'note', body: 'Council confirmed the owner.' },
      { kind: 'record_note', label: 'Add a second note', record_kind: 'location_event', record_id: OBS, entry_kind: 'follow_up_requested', body: 'Call back on Monday.' },
    ],
  };
  const db = fakeRpc({
    search_vehicle_registrations: ok([{ id: VEH, plate_number: 'TST123' }]),
    update_vehicle_profile_details: ok({ vehicle_id: VEH, changed: false }),
    record_vehicle_person: fail('POSSIBLE_DUPLICATE: Alex Example (born 1990) already exists'),
    add_person_alias: fail('This person already has that name recorded'),
    get_safety_warnings: ok([{ hazard_class: 'dangerous_dog', is_own_organization: true, alert_level: 'low', reason: ' Dog in the vehicle ' }]),
    list_record_updates: ({ p_record_kind }) => ({ data: p_record_kind === 'observation' ? [{ entry_kind: 'note', body: '  Council confirmed the owner. ' }] : [], error: null }),
    add_record_update: ok(OBS),
  });
  const { outcome, receipts } = await mod.applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending });
  assert.deepEqual(receipts.map((r) => r.status), ['already_present', 'failed', 'already_present', 'already_present', 'already_present', 'applied']);
  assert.equal(outcome, 'partially_applied');
  assert.doesNotMatch(receipts[1].detail, /Alex|1990/);
  assert.match(receipts[1].detail, /similar person may already be recorded/);
  assert.equal(db.names().includes('raise_entity_flag'), false);
  assert.deepEqual(db.calls.find((c) => c.name === 'update_vehicle_profile_details').args, {
    p_organization_id: ORG, p_vehicle_id: VEH, p_fields: { colour: 'Blue' }, p_reason: `Bob chat (confirmed by user): ${SUMMARY}`,
  });
  assert.deepEqual(db.calls.find((c) => c.name === 'add_record_update').args, {
    p_record_kind: 'location_event', p_record_id: OBS, p_entry_kind: 'follow_up_requested', p_body: 'Call back on Monday.',
  });

  const throwing = await mod.applyRecordUpdatePlan({
    rpc: async () => { throw new Error('network down'); }, organizationId: ORG,
    pending: { plan_id: PLAN, steps: [pending.steps[4]] },
  });
  assert.equal(throwing.outcome, 'failed');
  assert.equal(throwing.receipts[0].detail, 'network down');
});

test('a changed warning level or reason, or a different entry kind, is added rather than reported as present', async () => {
  const mod = await load();
  const warning = (alertLevel, note) => ({ kind: 'safety_warning', label: 'Raise warning', entity_type: 'vehicle', entity_id: VEH, hazard_class: 'dangerous_dog', alert_level: alertLevel, note });
  const followUp = { kind: 'record_note', label: 'Ask for follow-up', record_kind: 'observation', record_id: OBS, entry_kind: 'follow_up_requested', body: 'Council confirmed the owner.' };
  const db = fakeRpc({
    get_safety_warnings: ok([
      { hazard_class: 'dangerous_dog', is_own_organization: true, alert_level: 'low', reason: 'Dog in the vehicle' },
      { hazard_class: 'dangerous_dog', is_own_organization: false, alert_level: 'high', reason: null },
    ]),
    raise_entity_flag: ok({ id: OBS }),
    list_record_updates: ok([{ entry_kind: 'note', body: 'Council confirmed the owner.' }]),
    add_record_update: ok(OBS),
  });
  const { outcome, receipts } = await mod.applyRecordUpdatePlan({
    rpc: db.rpc, organizationId: ORG,
    pending: { plan_id: PLAN, steps: [warning('high', 'Dog in the vehicle'), warning('low', 'Two dogs, one loose'), followUp] },
  });
  assert.equal(outcome, 'applied');
  assert.deepEqual(receipts.map((r) => r.status), ['applied', 'applied', 'applied']);
  assert.match(receipts[0].detail, /already had a low warning of this kind here; this one was added alongside it, and the earlier one stays active/);
  assert.match(receipts[1].detail, /already had a low warning/);
  assert.equal(receipts[2].detail, undefined);
  assert.deepEqual(db.names(), ['get_safety_warnings', 'raise_entity_flag', 'get_safety_warnings', 'raise_entity_flag', 'list_record_updates', 'add_record_update']);
});

test('person-creating links resolve before facts about that person, whatever order they were given in', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan } = await load();
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'safety_warning', target: { type: 'person', name: 'Alex Example' }, note: 'Raised voice at last visit' },
      { kind: 'person_alias', person: 'Alex Example', alias: 'AJ' },
      { kind: 'vehicle_person_link', plate: 'TST123', person: 'Alex Example' },
      { kind: 'vehicle_details', plate: 'TST123', fields: { colour: 'Blue' } },
    ],
  });
  const db = fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: ok([]) });
  const { steps, held } = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(held, []);
  assert.deepEqual(steps.map((s) => s.kind), ['register_vehicle', 'vehicle_person_link', 'person_alias', 'safety_warning']);
  assert.deepEqual(steps.map((s) => s.op_index), [3, 2, 1, 0]);
  assert.match(steps[2].label, /created above/);
});

test('a confirmed plan stops at its time budget and reports the rest as not attempted', async () => {
  const mod = await load();
  const steps = ['First', 'Second', 'Third'].map((label) => ({ kind: 'record_note', label, record_kind: 'observation', record_id: OBS, entry_kind: 'note', body: label }));
  const db = fakeRpc({ list_record_updates: ok([]), add_record_update: ok(OBS) });
  const { outcome, receipts } = await mod.applyRecordUpdatePlan({
    rpc: db.rpc, organizationId: ORG, pending: { plan_id: PLAN, steps },
    deadlineAt: 1_000, now: () => (db.names().includes('add_record_update') ? 2_000 : 0),
  });
  assert.equal(outcome, 'partially_applied');
  assert.deepEqual(receipts.map((r) => r.status), ['applied', 'not_attempted', 'not_attempted']);
  assert.deepEqual(db.names(), ['list_record_updates', 'add_record_update']);
  const rendered = mod.renderRecordUpdateReceipts({ receipts, held: [] });
  assert.match(rendered, /^I made 1 change as you/);
  assert.match(rendered, /2\. Stopped \(time limit\) — Second \(Stopped before this step .* preview only what is still missing\.\)/);
  assert.ok(mod.RECORD_UPDATE_APPLY_BUDGET_MS < 150_000);
});

test('only a short, unhedged reply confirms; questions and amendments go back to the planner', async () => {
  const { recordUpdateDecision } = await load();
  for (const message of ['yes', 'Yes.', 'yes please', 'Yep, go ahead', 'ok', 'Okay!', 'apply them', 'Bob, yes do it', 'confirm', "yes that's right", 'sure thanks', 'yeah looks good', 'go ahead and apply them']) {
    assert.equal(recordUpdateDecision(message), 'confirm', message);
  }
  for (const message of ['no', 'No thanks', 'nope', 'cancel', 'don\u2019t', "don't apply them", 'leave it', 'forget it', 'discard them', 'not now, bob']) {
    assert.equal(recordUpdateDecision(message), 'decline', message);
  }
  for (const message of ['', 'yes but change the colour to red', 'ok what does that mean?', 'yes?', 'yes the colour is red', 'no, the colour is red',
    'yesterday he moved the van', 'apply the changes later', 'yes only the first one', 'yes and also add the dog', `yes ${'please '.repeat(20)}`]) {
    assert.equal(recordUpdateDecision(message), null, message);
  }
});

test('a stored preview is trusted only for its own user, conversation and organisation within its lifetime', async () => {
  const { isTrustedPendingRecordUpdates, RECORD_UPDATE_TTL_MS, deterministicUuid } = await load();
  const now = Date.parse('2026-10-21T00:30:00Z');
  const stored = {
    plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', organization_id: ORG,
    created_at: '2026-10-21T00:20:00Z', steps: [{ kind: 'record_note', label: 'Add a note' }],
  };
  const context = { userId: 'user-a', conversationId: 'thread-a', organizationId: ORG, now };
  assert.equal(isTrustedPendingRecordUpdates(stored, context), true);
  for (const [field, value] of [['user_id', 'user-b'], ['conversation_id', 'thread-b'], ['organization_id', VEH], ['plan_id', 'plan'],
    ['created_at', new Date(now - RECORD_UPDATE_TTL_MS - 1).toISOString()], ['created_at', new Date(now + 120_000).toISOString()],
    ['steps', []], ['steps', [{ kind: 'generic_write', label: 'x' }]], ['steps', [{ kind: 'record_note' }]]]) {
    assert.equal(isTrustedPendingRecordUpdates({ ...stored, [field]: value }, context), false, field);
  }
  assert.equal(isTrustedPendingRecordUpdates(stored, { ...context, userId: undefined }), false);
  assert.equal(isTrustedPendingRecordUpdates(null, context), false);

  const first = await deterministicUuid('seed');
  assert.equal(first, await deterministicUuid('seed'));
  assert.notEqual(first, await deterministicUuid('seed2'));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

const setSource = (name) => {
  const start = chat.indexOf(`const ${name} = new Set([`);
  assert.ok(start >= 0, name);
  return chat.slice(start, chat.indexOf(']);', start));
};

test('update_records is a gated, write-capable conductor tool that never continues the read loop or unlocks generic_write', () => {
  const entry = caddie.slice(caddie.indexOf('  update_records: {'), caddie.indexOf('  laptop_shell: {'));
  assert.match(entry, /effect_class: 'direct_world_change'/);
  assert.match(entry, /governance: 'WRITE-direct after the caller confirms an in-chat preview; caller JWT; existing audited RPCs only/);
  assert.match(caddie, /if \(tool === 'update_records'\) return caps\.canCompareData;/);
  assert.match(caddie, /update_records: 'onspace-ai-chat',/);
  assert.match(setSource('WRITE_CAPABLE_TOOLS'), /'update_records'/);
  assert.doesNotMatch(setSource('LOOP_CONTINUABLE_READ_TOOLS'), /update_records/);
  assert.doesNotMatch(setSource('BUILDER_LANE_TOOLS'), /update_records/);
  const lock = chat.slice(chat.indexOf('function isGovernanceLocked('), chat.indexOf('function handleHelpStatus('));
  assert.doesNotMatch(lock, /update_records/);
  assert.match(lock, /'generic_write'/);
  assert.match(chat, /if \(canCompareData\) allowedTools\.push\('update_records'\);/);
  assert.match(chat, /t\.tool === 'update_records' && caps\.canCompareData \|\|/);
  assert.match(chat.slice(chat.indexOf('const validRoutes'), chat.indexOf('const validRoutes') + 4000), /'update_records'/);
});

const stripTypeAnnotations = (source) => source
  .replace(/([A-Za-z_$][\w$]*)\s*:\s*(?:string\|string\[\]|string\[\]|string|number|boolean|unknown|any|JsonRecord|DbClient|Caps|ToolResult|Array<[^>]+>|Record<[^>]+>)(?:\s*\|\s*null)?(?=\s*(?:,|\)|=>))/g, '$1')
  .replace(/:\s*(?:string\|string\[\]|string\[\]|string|number|boolean|unknown|any|JsonRecord|DbClient|Caps|ToolResult|Array<[^>]+>|Record<[^>]+>)(?:\s*\|\s*null)?/g, '');
const historySource = chat.slice(chat.indexOf('async function loadHistory('), chat.indexOf('// Bob\'s per-user memory', chat.indexOf('async function loadHistory(')));
const loadHistory = vm.runInNewContext(`${stripTypeAnnotations(historySource)}\nloadHistory`);
// Minimal bob_messages fake: the history read, and the read-then-conditional-update claim of a preview row.
function fakeTranscript(rows = []) {
  const from = (table) => {
    assert.equal(table, 'bob_messages');
    const filters = [];
    let patch = null;
    const column = (row, col) => {
      if (col === 'metadata->>outcome') return row.metadata?.outcome;
      if (col === 'metadata->pending_record_updates->>plan_id') return row.metadata?.pending_record_updates?.plan_id;
      return row[col];
    };
    const matches = () => rows.filter((row) => filters.every(([col, val]) => column(row, col) === val));
    const query = {
      select() {
        if (!patch) return query;
        const hit = matches();
        for (const row of hit) row.metadata = patch.metadata;
        return Promise.resolve({ data: hit.map((row) => ({ id: row.id })), error: null });
      },
      update(next) { patch = next; return query; },
      eq(col, val) { filters.push([col, val]); return query; },
      order() { return query; },
      async limit() { return { data: matches().slice().reverse(), error: null }; },
      async maybeSingle() { const [row] = matches(); return { data: row ? { metadata: row.metadata } : null, error: null }; },
    };
    return query;
  };
  return { rows, from };
}

async function recover(chronological) {
  const supabase = { from: (table) => {
    assert.equal(table, 'bob_messages');
    return { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: chronological.slice().reverse() }; } };
  } };
  return loadHistory(supabase, 'thread-a');
}

const caseStart = chat.indexOf("        // update_records: in-app Bob's governed write path");
const dispatchCase = stripTypeAnnotations(chat.slice(caseStart, chat.indexOf("        case 'cancel_builder_job':", caseStart)));
const hookStart = chat.indexOf('    // A record-update preview is applied only here');
const hook = stripTypeAnnotations(chat.slice(hookStart, chat.indexOf("    if (pending?.kind === 'builder_cancellation_pending'", hookStart)));
assert.ok(caseStart > 0 && hookStart > 0);
assert.doesNotMatch(dispatchCase, /applyRecordUpdatePlan/);
assert.match(hook, /callerClient\.rpc\(name, args\)/);
assert.match(hook, /isTrustedPendingRecordUpdates\(stored, \{ userId: user\.id, conversationId, organizationId: orgId \}\)/);
assert.match(hook, /claimRecordUpdatePreview\(\{\s*db: admin, messageId: pending\?\.message_id/);
assert.match(hook, /verifyPendingRecordUpdates\(RECORD_UPDATE_SIGNING_KEY, stored\)/);
assert.ok(hook.indexOf("cancelAtBoundary('applying record updates')") < hook.indexOf('claimRecordUpdatePreview('));
assert.ok(hook.indexOf('verifyPendingRecordUpdates(') < hook.indexOf('claimRecordUpdatePreview('));
assert.match(dispatchCase, /signPendingRecordUpdates\(RECORD_UPDATE_SIGNING_KEY, \{/);
assert.match(chat, /const RECORD_UPDATE_SIGNING_KEY = SUPABASE_SERVICE_KEY;/);
assert.ok(hook.indexOf('claimRecordUpdatePreview(') < hook.indexOf("recordUpdatesChoice === 'decline'"));
assert.ok(hook.indexOf('claimRecordUpdatePreview(') < hook.indexOf('applyRecordUpdatePlan('));

async function signedNotePlan(extra = {}) {
  const { signPendingRecordUpdates } = await load();
  return signPendingRecordUpdates(KEY, {
    plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', organization_id: ORG, created_at: new Date().toISOString(),
    source_summary: SUMMARY, held: [], steps: [{ kind: 'record_note', label: 'Add a note', record_kind: 'observation', record_id: OBS, entry_kind: 'note', body: 'x' }],
    ...extra,
  });
}

async function makeFlow(env) {
  const mod = await load();
  return vm.runInNewContext(`(env) => {
    const { caps, user, conversationId, orgId, callerClient, persist, admin, startTime, respond, buildStructuredResponse, isToolEffectPermitted,
      validateRecordUpdatePlan, amendRecordUpdatePlan, recordUpdateSources, resolveRecordUpdatePlan, renderRecordUpdatePreview, recordUpdateDecision, isTrustedPendingRecordUpdates,
      signPendingRecordUpdates, verifyPendingRecordUpdates, RECORD_UPDATE_SIGNING_KEY, cancelAtBoundary,
      claimRecordUpdatePreview, applyRecordUpdatePlan, renderRecordUpdateReceipts } = env;
    const dispatchTool = async (tool, toolArgs, pending = null) => {
      switch (tool) {
        ${dispatchCase}
        default: throw new Error('Unexpected tool');
      }
    };
    const confirm = async (pending, message) => {
      ${hook}
      return null;
    };
    return { dispatchTool, confirm };
  }`, { crypto: globalThis.crypto })({ ...mod, ...env });
}

function chatEnv(handlers, rows = []) {
  const db = fakeRpc(handlers);
  const saved = [];
  const transcript = fakeTranscript(rows);
  return {
    db, saved, transcript,
    env: {
      caps: { canCompareData: true }, user: { id: 'user-a' }, conversationId: 'thread-a', orgId: ORG, admin: transcript, startTime: 0,
      RECORD_UPDATE_SIGNING_KEY: KEY, cancelAtBoundary: async () => null,
      callerClient: { rpc: db.rpc },
      persist: async (_admin, _org, _conversation, turns) => { saved.push(turns); },
      respond: (result) => result,
      buildStructuredResponse: (result) => result,
      isToolEffectPermitted: (tool, caps) => tool === 'update_records' && caps.canCompareData === true,
    },
  };
}

test('preview, recovery and the next-turn yes apply as the caller; the preview turn itself writes nothing', async () => {
  const { db, saved, env, transcript } = chatEnv({
    search_vehicle_registrations: ok([]),
    find_person_matches: ok([]),
    manage_identity_vehicle: ok({ vehicle_id: VEH }),
    record_vehicle_person: ok({ person_record_id: PERSON, canonical_person_id: CANON }),
  });
  const flow = await makeFlow(env);
  const preview = await flow.dispatchTool('update_records', {
    source_summary: SUMMARY,
    operations: [{ kind: 'vehicle_person_link', plate: 'TST123', person: 'Alex Example', relationship: 'owner' }],
  });
  assert.equal(preview.meta.outcome, 'proposed');
  assert.match(preview.reply, /Nothing has been written yet/);
  assert.deepEqual(db.names(), ['search_vehicle_registrations', 'find_person_matches']);
  const stored = preview.meta.pending_record_updates;
  assert.equal(stored.user_id, 'user-a');
  assert.equal(stored.conversation_id, 'thread-a');
  assert.equal(stored.organization_id, ORG);
  assert.deepEqual(stored.steps.map((s) => s.kind), ['register_vehicle', 'vehicle_person_link']);

  transcript.rows.push(
    { id: PERSON, conversation_id: 'thread-a', role: 'user', content: 'Update the records from this email', metadata: null },
    { id: MSG, conversation_id: 'thread-a', role: 'assistant', content: preview.reply, metadata: preview.meta },
  );
  const { pending } = await loadHistory(transcript, 'thread-a');
  assert.equal(pending.kind, 'record_updates_pending');
  assert.equal(pending.message_id, MSG);
  assert.equal((await flow.confirm(pending, 'change the colour to red instead')), null);
  const result = await flow.confirm(pending, 'yes please');
  assert.equal(result.meta.outcome, 'applied');
  assert.equal(result.meta.planned_tool, 'update_records');
  assert.equal(result.meta.record_updates_applied_plan_id, stored.plan_id);
  assert.match(result.reply, /^I made 2 changes as you/);
  assert.deepEqual(db.names().slice(2), ['search_vehicle_registrations', 'manage_identity_vehicle', 'record_vehicle_person']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].content, 'yes please');
  assert.equal(saved[0][1].metadata.outcome, 'applied');
  assert.equal(transcript.rows[1].metadata.outcome, 'confirmed');
  assert.match(transcript.rows[1].metadata.record_updates_answered_at, /^\d{4}-/);
  assert.equal(transcript.rows[1].metadata.pending_record_updates.plan_id, stored.plan_id);

  const again = await flow.confirm(pending, 'yes');
  assert.equal(again.meta.outcome, 'already_answered');
  assert.match(again.reply, /already been answered .* nothing more was written/);
  assert.equal(db.names().length, 5);
});

test('a decline, a foreign or expired preview, or a caller without the capability writes nothing', async () => {
  const stored = await signedNotePlan();
  const pending = { kind: 'record_updates_pending', record_updates: stored, message_id: MSG };
  const previewRows = () => [{ id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: stored } }];
  const noWrites = () => { throw new Error('No RPC may run'); };
  const cases = [
    ['no thanks', {}, 'declined', /^Discarded\. Nothing was written\./],
    ['yes', { user: { id: 'user-b' } }, 'unconfirmed', /Nothing was written/],
    ['yes', { conversationId: 'thread-b' }, 'unconfirmed', /Nothing was written/],
    ['yes', { orgId: VEH }, 'unconfirmed', /Nothing was written/],
    ['yes', { caps: { canCompareData: false } }, 'unconfirmed', /Nothing was written/],
  ];
  for (const [message, override, outcome, reply] of cases) {
    const { saved, env, transcript } = chatEnv({ list_record_updates: noWrites, add_record_update: noWrites }, previewRows());
    const flow = await makeFlow({ ...env, ...override });
    const result = await flow.confirm(pending, message);
    assert.equal(result.meta.outcome, outcome, `${message} ${JSON.stringify(override)}`);
    assert.match(result.reply, reply);
    assert.equal(saved[0][1].metadata.outcome, outcome);
    // Only the caller's own decline answers the preview; a refused reply leaves it for its owner.
    assert.equal(transcript.rows[0].metadata.outcome, outcome === 'declined' ? 'declined' : 'proposed');
  }
  for (const [label, rowsFor, pendingFor] of [
    ['no row id', previewRows, { ...pending, message_id: null }],
    ['already declined', () => [{ ...previewRows()[0], metadata: { outcome: 'declined', pending_record_updates: stored } }], pending],
    ['another plan in that row', () => [{ ...previewRows()[0], metadata: { outcome: 'proposed', pending_record_updates: { ...stored, plan_id: VEH } } }], pending],
    ['another conversation\'s row', () => [{ ...previewRows()[0], conversation_id: 'thread-b' }], pending],
  ]) {
    const { env } = chatEnv({ list_record_updates: noWrites, add_record_update: noWrites }, rowsFor());
    const result = await (await makeFlow(env)).confirm(pendingFor, 'yes');
    assert.equal(result.meta.outcome, label === 'no row id' ? 'unconfirmed' : 'already_answered', label);
    assert.match(result.reply, /nothing more was written|Nothing was written/, label);
  }
  const expired = { ...pending, record_updates: await signedNotePlan({ created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString() }) };
  const { env } = chatEnv({});
  assert.equal((await (await makeFlow(env)).confirm(expired, 'yes')).meta.outcome, 'unconfirmed');
  assert.equal(await (await makeFlow(env)).confirm({ kind: 'builder_cancellation_pending' }, 'yes'), null);
});

test('two overlapping yes replies apply the preview once; the other is told nothing more was written', async () => {
  const stored = await signedNotePlan();
  const pending = { kind: 'record_updates_pending', record_updates: stored, message_id: MSG };
  const { db, env, transcript } = chatEnv(
    { list_record_updates: ok([]), add_record_update: ok(OBS) },
    [{ id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: stored } }],
  );
  const flow = await makeFlow(env);
  const results = await Promise.all([flow.confirm(pending, 'yes'), flow.confirm(pending, 'yes please'), flow.confirm(pending, 'no')]);
  // Signature checks use real Web Crypto, so any reply may claim first; exactly one answer wins either way.
  const outcomes = results.map((r) => r.meta.outcome);
  const winners = outcomes.filter((o) => o !== 'already_answered');
  assert.equal(winners.length, 1, outcomes.join(','));
  if (winners[0] === 'applied') {
    assert.deepEqual(db.names(), ['list_record_updates', 'add_record_update']);
    assert.equal(transcript.rows[0].metadata.outcome, 'confirmed');
  } else {
    assert.equal(winners[0], 'declined');
    assert.equal(db.calls.length, 0);
    assert.equal(transcript.rows[0].metadata.outcome, 'declined');
  }
});

test('a preview is confirmable only as the very next assistant turn and only when well formed', async () => {
  const meta = (extra = {}) => ({ tool: 'update_records', outcome: 'proposed', pending_record_updates: { plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', steps: [{ kind: 'record_note', label: 'x' }] }, ...extra });
  const userRow = { role: 'user', content: 'update it' };
  const previewRow = (metadata) => ({ role: 'assistant', content: 'Preview', metadata });
  assert.equal((await recover([userRow, previewRow(meta())])).pending.kind, 'record_updates_pending');
  assert.notEqual((await recover([userRow, previewRow(meta()), userRow, { role: 'assistant', content: 'Other answer', metadata: {} }])).pending?.kind, 'record_updates_pending');
  assert.notEqual((await recover([userRow, previewRow(meta({ outcome: 'applied' }))])).pending?.kind, 'record_updates_pending');
  assert.notEqual((await recover([userRow, previewRow(meta({ pending_record_updates: { plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', steps: [] } }))])).pending?.kind, 'record_updates_pending');
});

test('the planner is told the preview is waiting, how to amend it, and to stop claiming it has no write path', () => {
  const prompt = planner.buildPlannerPrompt({
    message: 'make the colour red instead',
    tools: [{ tool: 'update_records', purpose: 'Update people, vehicles and reports' }],
    pending: { kind: 'record_updates_pending', record_updates: { steps: [{}, {}] } },
  });
  assert.match(prompt, /IN-FLIGHT PLAN: the previous turn PREVIEWED 2 record changes \(update_records\)/);
  assert.match(prompt, /select update_records again with ONLY the new or corrected operations: the executor merges them into the waiting preview/);
  assert.match(prompt, /remove: \[the preview item numbers/);
  assert.match(prompt, /replace_all: true only when the user wants to start over/);
  assert.doesNotMatch(prompt, /COMPLETE amended operations list/);
  assert.match(prompt, /your reply closes this preview: nothing from it was written/);
  assert.doesNotMatch(prompt, /still waiting for yes or no/);
  assert.match(prompt, /FACTS ABOUT PEOPLE, VEHICLES AND REPORTS: .*select update_records/);
  assert.match(prompt, /A person to create or describe is kind=person_details \(their role or organisation.*goes in fields\.category/);
  assert.match(prompt, /A name someone gave or used is kind=person_alias on that one person/);
  assert.match(prompt, /never say you have no way to update these records/);
  assert.match(prompt, /never claim a record changed without an update_records receipt/);
  assert.doesNotMatch(prompt, UUID_RE);
});

test('only a plan this server signed, carried by exactly one transcript row, can be applied', async () => {
  const mod = await load();
  const stored = await signedNotePlan();
  // jsonb reorders keys and drops undefined members; the signature must survive that round trip.
  const roundTripped = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries({ ...stored, dropped: undefined }).reverse())));
  assert.equal(await mod.verifyPendingRecordUpdates(KEY, roundTripped), true);
  assert.equal(await mod.verifyPendingRecordUpdates('a-different-server-key-0123456789abcdef', stored), false);
  assert.equal(await mod.verifyPendingRecordUpdates('', stored), false);
  await assert.rejects(mod.signPendingRecordUpdates('short', { plan_id: PLAN }), /not configured/);

  const { signature: _drop, ...unsigned } = stored;
  const forgedForOther = { ...(await signedNotePlan({ user_id: 'user-b' })), user_id: 'user-a' };
  const noWrites = () => { throw new Error('No RPC may run'); };
  for (const [label, forged] of [
    ['unsigned', unsigned],
    ['tampered step', { ...stored, steps: [{ ...stored.steps[0], body: 'a different note' }] }],
    ['re-addressed to another user', forgedForOther],
  ]) {
    const { saved, env, transcript } = chatEnv({ list_record_updates: noWrites, add_record_update: noWrites },
      [{ id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: forged } }]);
    const result = await (await makeFlow(env)).confirm({ kind: 'record_updates_pending', record_updates: forged, message_id: MSG }, 'yes');
    assert.equal(result.meta.outcome, 'unconfirmed', label);
    assert.match(result.reply, /cannot be verified as one I made/);
    assert.equal(saved[0][1].metadata.outcome, 'unconfirmed');
    assert.equal(transcript.rows[0].metadata.outcome, 'proposed', label);
  }

  // A member re-inserting an earlier signed preview (even one already answered) cannot get it applied.
  const COPY = '11000000-0000-4000-8000-000000000008';
  for (const originalOutcome of ['declined', 'proposed']) {
    const { db, env, transcript } = chatEnv({ list_record_updates: noWrites, add_record_update: noWrites }, [
      { id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: originalOutcome, pending_record_updates: stored } },
      { id: COPY, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: stored } },
    ]);
    const result = await (await makeFlow(env)).confirm({ kind: 'record_updates_pending', record_updates: stored, message_id: COPY }, 'yes');
    assert.equal(result.meta.outcome, 'already_answered', originalOutcome);
    assert.equal(db.calls.length, 0);
    assert.equal(transcript.rows[1].metadata.outcome, 'proposed');
  }
});

test('a cancelled turn stops before the preview is answered or anything is written', async () => {
  const stored = await signedNotePlan();
  const noWrites = () => { throw new Error('No RPC may run'); };
  const { db, saved, env, transcript } = chatEnv({ list_record_updates: noWrites, add_record_update: noWrites },
    [{ id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: stored } }]);
  const boundaries = [];
  const cancelled = { cancelled: true };
  const flow = await makeFlow({ ...env, cancelAtBoundary: async (boundary) => { boundaries.push(boundary); return cancelled; } });
  assert.equal(await flow.confirm({ kind: 'record_updates_pending', record_updates: stored, message_id: MSG }, 'yes'), cancelled);
  assert.deepEqual(boundaries, ['applying record updates']);
  assert.equal(db.calls.length, 0);
  assert.equal(saved.length, 0);
  assert.equal(transcript.rows[0].metadata.outcome, 'proposed');
});

test('a planner-supplied person record id is confirmed by the caller\'s own search and shown with its stored name', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan } = await load();
  const plan = validateRecordUpdatePlan({ source_summary: SUMMARY, operations: [
    { kind: 'person_alias', person: { person_record_id: PERSON, name: 'Alex Example' }, alias: 'AJ' },
  ] }).plan;
  const stored = fakeRpc({ find_person_matches: ok([{ person_record_id: PERSON, display_name: 'Alexandra Example', match_basis: 'alias_exact', score: 0.9 }]) });
  const bound = await resolveRecordUpdatePlan({ rpc: stored.rpc, organizationId: ORG, plan });
  assert.deepEqual(stored.calls[0].args, { p_organization_id: ORG, p_name: 'Alex Example', p_limit: 8 });
  assert.equal(bound.steps[0].person_record_id, PERSON);
  assert.match(bound.steps[0].label, /for Alexandra Example \(existing person record\)$/);

  const other = fakeRpc({ find_person_matches: ok([exactMatch(CANON, 'Alex Example')]) });
  const mismatch = await resolveRecordUpdatePlan({ rpc: other.rpc, organizationId: ORG, plan });
  assert.equal(mismatch.steps.length, 0);
  assert.match(mismatch.held[0].reason, /does not match "Alex Example" in your organisation/);

  const idOnly = validateRecordUpdatePlan({ operations: [{ kind: 'person_alias', person: { person_record_id: PERSON }, alias: 'AJ' }] }).plan;
  const none = fakeRpc({});
  const unnamed = await resolveRecordUpdatePlan({ rpc: none.rpc, organizationId: ORG, plan: idOnly });
  assert.equal(none.calls.length, 0);
  assert.match(unnamed.held[0].reason, /Tell me the person's name as recorded/);
});

test('names that differ beyond case and spacing are looked up separately', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan } = await load();
  const plan = validateRecordUpdatePlan({ operations: [
    { kind: 'person_alias', person: 'Māia Smith', alias: 'M' },
    { kind: 'person_alias', person: 'Maia Smith', alias: 'Mai' },
    { kind: 'person_alias', person: 'MAIA  smith', alias: 'Ms' },
  ] }).plan;
  const db = fakeRpc({ find_person_matches: ({ p_name }) => ({ data: [exactMatch(p_name === 'Māia Smith' ? PERSON : CANON, p_name)], error: null }) });
  const resolved = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(db.calls.map((c) => c.args.p_name), ['Māia Smith', 'Maia Smith']);
  assert.deepEqual(resolved.steps.map((s) => s.person_record_id), [PERSON, CANON, CANON]);
});

test('the preview shows every value in full, exactly as long as it will be written', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, renderRecordUpdatePreview } = await load();
  const body = `Follow-up from the council: ${'checked the site again and nothing was found '.repeat(60)}end of note`.trim();
  const note = `Dog at the gate ${'is unrestrained and has charged staff before '.repeat(20)}`.trim();
  const alias = `A ${'very '.repeat(21)}long alias`;
  assert.ok(body.length > 2000 && body.length <= 4000 && note.length > 800 && note.length <= 1000 && alias.length > 100 && alias.length <= 120);
  const plan = validateRecordUpdatePlan({ operations: [
    { kind: 'record_note', record_kind: 'observation', record_id: OBS, body },
    { kind: 'safety_warning', target: { type: 'vehicle', plate: 'TST123' }, hazard_class: 'dangerous_dog', note },
    { kind: 'person_alias', person: 'Alex Example', alias },
  ] }).plan;
  const db = fakeRpc({ search_vehicle_registrations: ok([{ id: VEH, plate_number: 'TST123' }]), find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]) });
  const preview = renderRecordUpdatePreview(await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan }));
  assert.ok(preview.includes(`"${body}"`));
  assert.ok(preview.includes(`"${note}"`));
  assert.ok(preview.includes(`"${alias}"`));
  assert.doesNotMatch(preview, /…/);
});

test('a follow-up repeats only when it matches the latest follow-up; notes repeat only on an exact entry', async () => {
  const { isRepeatRecordUpdate, applyRecordUpdatePlan } = await load();
  const rows = [
    { entry_kind: 'note', body: 'Checked again', created_at: '2026-10-01T00:00:00Z' },
    { entry_kind: 'follow_up_resolved', body: 'Owner moved it', created_at: '2026-10-03T00:00:00Z' },
    { entry_kind: 'follow_up_requested', body: 'Check again', created_at: '2026-10-02T00:00:00Z' },
  ];
  const step = (entry_kind, body) => ({ entry_kind, body });
  assert.equal(isRepeatRecordUpdate(rows, step('follow_up_requested', 'Check again')), false);
  assert.equal(isRepeatRecordUpdate(rows, step('follow_up_resolved', 'Owner moved it')), true);
  assert.equal(isRepeatRecordUpdate(rows, step('follow_up_resolved', 'Different outcome')), false);
  assert.equal(isRepeatRecordUpdate(rows, step('note', 'Checked again')), true);
  assert.equal(isRepeatRecordUpdate(rows, step('hs_concern', 'Checked again')), false);
  assert.equal(isRepeatRecordUpdate([], step('follow_up_requested', 'Check again')), false);

  const db = fakeRpc({ list_record_updates: ok(rows), add_record_update: ok(OBS) });
  const applied = await applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending: {
    plan_id: PLAN, source_summary: SUMMARY,
    steps: [{ kind: 'record_note', label: 'Re-open follow-up', record_kind: 'observation', record_id: OBS, entry_kind: 'follow_up_requested', body: 'Check again' }],
  } });
  assert.equal(applied.outcome, 'applied');
  assert.deepEqual(db.names(), ['list_record_updates', 'add_record_update']);
});

test('registering a vehicle cannot erase a note: chat never sends notes and the register now keeps omitted notes', async () => {
  const { validateRecordUpdatePlan } = await load();
  const plan = validateRecordUpdatePlan({ operations: [{ kind: 'vehicle_details', plate: 'TST123', fields: { make: 'Toyota', notes: 'overwrite me' } }] }).plan;
  assert.deepEqual(plan.operations[0].fields, { make: 'Toyota' });

  const schema = fs.readFileSync('supabase/schema.sql', 'utf8');
  const start = schema.indexOf('CREATE OR REPLACE FUNCTION "public"."manage_identity_vehicle"');
  const live = schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
  const migrated = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'), migration.indexOf('$function$;') + '$function$;'.length);
  const before = "    org_notes = CASE WHEN v_note IS NULL THEN org_notes - p_organization_id::text\n";
  const after = "    org_notes = CASE WHEN NOT coalesce(p_fields ? 'notes', false) THEN org_notes\n      WHEN v_note IS NULL THEN org_notes - p_organization_id::text\n";
  assert.ok(live.includes(before) || live.includes(after));
  // Identical to the live catalog definition apart from the omitted-notes rule.
  assert.equal(migrated, live.replace(before, after));
  assert.match(migration, /COMMENT ON FUNCTION public\.manage_identity_vehicle\(uuid, uuid, text, jsonb, text\) IS/);
  assert.doesNotMatch(migration, /\b(GRANT|REVOKE)\b/);
});

// ── Person records and preview amendments (owner transcript 2026-11: officials could not be created, and an
// amendment discarded the eight changes already previewed). Every name and plate below is synthetic.
const PERSON2 = '11000000-0000-4000-8000-000000000008';
const { runDeterministicChecks } = require('../services/fcm-api/src/bob/verify');
const personIds = { 'Riley Sample': '12000000-0000-4000-8000-000000000009', 'Jordan Placeholder': '13000000-0000-4000-8000-00000000000a', 'Drew Sample': '14000000-0000-4000-8000-00000000000b' };
const createdPerson = (args) => ({ data: { outcome: 'created', person_record_id: personIds[args.p_fields.display_name] ?? PERSON2, canonical_person_id: CANON, display_name: args.p_fields.display_name }, error: null });

test('person details are validated: a name is required and contact details must be well formed', async () => {
  const { validateRecordUpdatePlan } = await load();
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'person_details', person: { name: 'Riley Sample' }, fields: { category: 'Compliance officer, Example Council', email: 'riley@example.test', phone: '+64 21 000 0000', notes: 'Met on site', date_of_birth: '1980-02-03', address: 'ignored' } },
      { kind: 'person_details', person: { name: 'Jordan Placeholder' }, fields: { email: 'not-an-email' } },
      { kind: 'person_details', person: {}, fields: { category: 'Visitor' } },
      { kind: 'person_details', person: 'Sam Future', fields: { date_of_birth: '2999-01-01' } },
      { kind: 'person_details', person: 'Ari Plain', fields: { category: 'c'.repeat(121) } },
      { kind: 'person_details', person: 'Kit Short', fields: { phone: '12-34' } },
    ],
  });
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0].fields, { category: 'Compliance officer, Example Council', notes: 'Met on site', email: 'riley@example.test', phone: '+64 21 000 0000', date_of_birth: '1980-02-03' });
  assert.equal(plan.operations[0].confirm_new_person, false);
  assert.deepEqual(plan.held.map((h) => h.index), [1, 2, 3, 4, 5]);
  assert.match(plan.held[0].reason, /email is not a valid address/);
  assert.match(plan.held[1].reason, /Give the person's name/);
  assert.match(plan.held[2].reason, /date_of_birth must be a past date/);
  assert.match(plan.held[3].reason, /category is longer than 120 characters/);
  assert.match(plan.held[4].reason, /phone is not a valid number/);
});

test('people resolve to create or update steps; near matches and their dependants wait for the user', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, renderRecordUpdatePreview } = await load();
  // The register's own scores (_match_person_records): exact name 0.85, spelling or surname variant 0.72, similar
  // names 0.40 + 0.40 x similarity, so at most 0.80. Every candidate it returns that is not exact holds a create.
  const matches = {
    'Known Person': [exactMatch(PERSON, 'Known Person')],
    'Other Known': [exactMatch(CANON, 'Other Known')],
    'Kim Near': [{ person_record_id: PERSON2, display_name: 'Kimberly Near', match_basis: 'name_variant', score: 0.72 }],
    'Lee Distant': [{ person_record_id: PERSON2, display_name: 'Leo Distant', match_basis: 'name_similar', score: 0.8 }],
    'Sam Close': [{ person_record_id: CANON, display_name: 'Samuel Close', match_basis: 'name_variant', score: 0.72 }],
  };
  const db = fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: (args) => ({ data: matches[args.p_name] ?? [], error: null }), get_identity_registry: ok({ people: [] }) });
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'person_alias', person: 'Riley Sample', alias: 'R. Sample', alias_kind: 'aka' },
      { kind: 'vehicle_person_link', plate: 'TST201', person: 'Riley Sample' },
      { kind: 'person_details', person: 'Riley Sample', fields: { category: 'Compliance officer, Example Council' } },
      { kind: 'person_details', person: 'Riley Sample', fields: { phone: '021 000 0000' } },
      { kind: 'person_details', person: 'Known Person', fields: { notes: 'Seen at the gate' } },
      { kind: 'person_details', person: 'Other Known' },
      { kind: 'person_details', person: 'Kim Near', fields: { category: 'Visitor' } },
      { kind: 'vehicle_person_link', plate: 'TST202', person: 'Kim Near' },
      { kind: 'safety_warning', target: { type: 'person', name: 'Kim Near' }, note: 'Raised voice at the gate' },
      { kind: 'person_details', person: 'Lee Distant', fields: { category: 'Contractor' } },
      { kind: 'safety_warning', target: { type: 'person', name: 'Riley Sample' }, note: 'Asked us to call ahead' },
      { kind: 'vehicle_person_link', plate: 'TST203', person: 'Sam Close' },
    ],
  });
  const { steps, held } = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(steps.map((s) => s.kind), ['create_person', 'update_person_details', 'register_vehicle', 'vehicle_person_link', 'person_alias', 'safety_warning']);
  // The same person named twice becomes one create step carrying every detail, and it remembers both items.
  assert.deepEqual(steps[0].fields, { category: 'Compliance officer, Example Council', phone: '021 000 0000' });
  assert.deepEqual(steps[0].op_indexes, [2, 3]);
  assert.equal(steps[0].display_name, 'Riley Sample');
  assert.equal(steps[0].distinct_from, undefined);
  assert.equal(steps[0].source_summary, SUMMARY);
  assert.match(steps[0].label, /^Create a person record for Riley Sample in your organisation's identity register with category Compliance officer, Example Council, phone 021 000 0000 \(identity-register administrators only\)$/);
  assert.equal(steps[1].person_record_id, PERSON);
  assert.match(steps[1].label, /^Update Known Person \(existing person record\) with notes Seen at the gate; other details on the record stay as they are/);
  // A link, alias and warning about the person created above use that record.
  assert.equal(steps[3].person_from_create, true);
  assert.equal(steps[3].creates_person, false);
  assert.match(steps[3].label, /^Link Riley Sample \(created above\) to vehicle TST201/);
  assert.match(steps[4].label, /for Riley Sample \(created above\)$/);
  assert.equal(steps[5].person_ref, steps[0].person_ref);
  assert.deepEqual(held.map((h) => h.index), [5, 6, 7, 8, 9, 11]);
  assert.match(held[0].reason, /"Other Known" is already recorded and no new details were given/);
  assert.match(held[1].reason, /A similar person is already recorded \("Kimberly Near"\)\. Tell me if "Kim Near" is one of them, or confirm they are a different person/);
  assert.match(held[2].reason, /Waiting for you to confirm who "Kim Near" is/);
  assert.match(held[3].reason, /Waiting for you to confirm who "Kim Near" is/);
  assert.match(held[4].reason, /A similar person is already recorded \("Leo Distant"\)/);
  // A link that would itself create the person waits too, and registers nothing meanwhile.
  assert.match(held[5].reason, /A similar person is already recorded \("Samuel Close"\)\. Tell me if "Sam Close" is one of them/);
  assert.ok(!steps.some((s) => s.plate === 'TST203' || s.plate === 'TST202'));
  for (const step of steps) assert.doesNotMatch(step.label, UUID_RE);
  assert.ok(!db.names().some((name) => /manage_|record_identity|record_vehicle_person|add_person_alias|raise_entity_flag/.test(name)));
  assert.ok(db.calls.filter((c) => c.name === 'find_person_matches').every((c) => !('p_date_of_birth' in c.args)));

  const confirmed = validateRecordUpdatePlan({ operations: [{ kind: 'person_details', person: 'Kim Near', fields: { category: 'Visitor' }, confirm_new_person: true }] }).plan;
  const again = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan: confirmed });
  assert.deepEqual(again.steps.map((s) => s.kind), ['create_person']);
  assert.deepEqual(again.steps[0].distinct_from, [PERSON2]);
  assert.match(again.steps[0].label, /with category Visitor — you confirmed this is a different person from the similar record already on file \(identity-register administrators only\)$/);
  assert.deepEqual(again.held, []);
  assert.match(renderRecordUpdatePreview(again), /^Preview — I will make this change as you/);
});

test('a date of birth tells namesakes apart; confirm_new_person separates someone with the same name', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan } = await load();
  const plan = (fields, extra = {}) => validateRecordUpdatePlan({ source_summary: SUMMARY, operations: [{ kind: 'person_details', person: 'Alex Example', fields, ...extra }] }).plan;
  const registry = (dates) => ok({ people: Object.entries(dates).map(([id, date_of_birth]) => ({ person_record_id: id, display_name: 'Alex Example', date_of_birth })) });
  const resolve = (handlers, p) => {
    const db = fakeRpc(handlers);
    return resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan: p }).then((result) => ({ ...result, db }));
  };

  // The register already flags the record whose stored date matches (score 0.97, basis +date_of_birth).
  const flagged = await resolve({ find_person_matches: ok([{ ...exactMatch(PERSON, 'Alex Example'), match_basis: 'name_exact+date_of_birth' }]) }, plan({ date_of_birth: '1990-01-01', notes: 'Seen' }));
  assert.deepEqual(flagged.steps.map((s) => [s.kind, s.person_record_id]), [['update_person_details', PERSON]]);
  assert.deepEqual(flagged.db.calls[0].args, { p_organization_id: ORG, p_name: 'Alex Example', p_limit: 8, p_date_of_birth: '1990-01-01' });
  assert.ok(!flagged.db.names().includes('get_identity_registry'));

  // Someone recorded with a different date of birth is a different person: a separate record is created.
  const different = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]), get_identity_registry: registry({ [PERSON]: '1985-05-05' }) }, plan({ date_of_birth: '1990-01-01' }));
  assert.deepEqual(different.steps.map((s) => s.kind), ['create_person']);
  assert.deepEqual(different.steps[0].distinct_from, [PERSON]);
  assert.match(different.steps[0].label, /— someone with this name is already recorded with a different date of birth, so this is a separate record \(identity-register administrators only\)$/);

  // Someone recorded without one may be this person, so the details go to that record.
  const undated = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example'), exactMatch(PERSON2, 'Alex Example')]), get_identity_registry: registry({ [PERSON]: '1985-05-05', [PERSON2]: null }) }, plan({ date_of_birth: '1990-01-01' }));
  assert.deepEqual(undated.steps.map((s) => [s.kind, s.person_record_id]), [['update_person_details', PERSON2]]);
  // The date may be held on the platform identity rather than the profile, so the register's date counts too.
  const canonicalDate = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example'), exactMatch(PERSON2, 'Alex Example')]), get_identity_registry: registry({ [PERSON]: '1990-01-01', [PERSON2]: null }) }, plan({ date_of_birth: '1990-01-01' }));
  assert.deepEqual(canonicalDate.steps.map((s) => s.person_record_id), [PERSON]);
  const twoUndated = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example'), exactMatch(PERSON2, 'Alex Example')]), get_identity_registry: registry({ [PERSON]: null, [PERSON2]: null }) }, plan({ date_of_birth: '1990-01-01' }));
  assert.match(twoUndated.held[0].reason, /2 people match "Alex Example"/);
  const unreadable = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]), get_identity_registry: fail('Identity registry administrator access required') }, plan({ date_of_birth: '1990-01-01' }));
  assert.deepEqual(unreadable.steps, []);
  assert.match(unreadable.held[0].reason, /Only identity-register administrators can compare dates of birth/);
  const missing = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]), get_identity_registry: registry({}) }, plan({ date_of_birth: '1990-01-01' }));
  assert.match(missing.held[0].reason, /could not read the recorded date of birth/);

  // Without a date, one exact match is that person; confirm_new_person says they are someone else.
  const same = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]) }, plan({ notes: 'Seen' }));
  assert.deepEqual(same.steps.map((s) => s.kind), ['update_person_details']);
  const separate = await resolve({ find_person_matches: ok([exactMatch(PERSON, 'Alex Example')]) }, plan({ notes: 'Seen' }, { confirm_new_person: true }));
  assert.deepEqual(separate.steps.map((s) => [s.kind, s.distinct_from]), [['create_person', [PERSON]]]);
  assert.match(separate.steps[0].label, /you confirmed this is a different person/);
});

test('creating a person is one serialised register call, then carries the new record into links, names and warnings', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, applyRecordUpdatePlan } = await load();
  const { plan } = validateRecordUpdatePlan({
    source_summary: SUMMARY,
    operations: [
      { kind: 'person_details', person: 'Riley Sample', fields: { category: 'Compliance officer, Example Council' } },
      { kind: 'vehicle_person_link', plate: 'TST201', person: 'Riley Sample', source: 'officer_observed' },
      { kind: 'person_alias', person: 'Riley Sample', alias: 'R. Sample' },
      { kind: 'safety_warning', target: { type: 'person', name: 'Riley Sample' }, note: 'Asked us to call ahead' },
    ],
  });
  const preview = await resolveRecordUpdatePlan({ rpc: fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: ok([]) }).rpc, organizationId: ORG, plan });
  const pending = { plan_id: PLAN, source_summary: SUMMARY, steps: preview.steps };

  const db = fakeRpc({
    record_identity_person_details: createdPerson, search_vehicle_registrations: ok([]),
    manage_identity_vehicle: ok({ vehicle_id: VEH }), record_vehicle_person: ok({ person_record_id: personIds['Riley Sample'], canonical_person_id: CANON }),
    add_person_alias: ok({}), get_safety_warnings: ok([]), raise_entity_flag: ok({}),
  });
  const applied = await applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending });
  assert.equal(applied.outcome, 'applied');
  assert.deepEqual(applied.receipts.map((r) => r.status), ['applied', 'applied', 'applied', 'applied', 'applied']);
  // No separate re-check: the database call itself takes the per-name lock and looks for the person again.
  assert.deepEqual(db.names(), ['record_identity_person_details', 'search_vehicle_registrations', 'manage_identity_vehicle', 'record_vehicle_person', 'add_person_alias', 'get_safety_warnings', 'raise_entity_flag']);
  assert.deepEqual(db.calls[0].args, {
    p_organization_id: ORG, p_person_record_id: null, p_action: 'create',
    p_fields: { category: 'Compliance officer, Example Council', display_name: 'Riley Sample' },
    p_distinct_from: [], p_reason: `Bob chat (confirmed by user): ${SUMMARY}`,
  });
  const link = db.calls.find((c) => c.name === 'record_vehicle_person').args;
  assert.equal(link.p_person_record_id, personIds['Riley Sample']);
  assert.equal(link.p_person_fields, null);
  assert.equal(db.calls.find((c) => c.name === 'add_person_alias').args.p_person_record_id, personIds['Riley Sample']);
  assert.equal(db.calls.find((c) => c.name === 'raise_entity_flag').args.p_entity_id, CANON);

  // A namesake the user said is someone else is passed through, so the database will not hand that record back.
  const separate = fakeRpc({ record_identity_person_details: createdPerson });
  await applyRecordUpdatePlan({ rpc: separate.rpc, organizationId: ORG, pending: { plan_id: PLAN, steps: [{ ...preview.steps[0], distinct_from: [PERSON, 'not-a-uuid'] }] } });
  assert.deepEqual(separate.calls[0].args.p_distinct_from, [PERSON]);

  // Someone recorded the person after the preview: the database returns them, and the dependants use that record.
  const raced = fakeRpc({
    record_identity_person_details: ok({ outcome: 'existing', person_record_id: PERSON, canonical_person_id: CANON, display_name: 'Riley Sample' }),
    search_vehicle_registrations: ok([]), manage_identity_vehicle: ok({ vehicle_id: VEH }), record_vehicle_person: ok({ person_record_id: PERSON, canonical_person_id: CANON }),
    add_person_alias: ok({}), get_safety_warnings: ok([]), raise_entity_flag: ok({}),
  });
  const racedResult = await applyRecordUpdatePlan({ rpc: raced.rpc, organizationId: ORG, pending });
  assert.equal(racedResult.receipts[0].status, 'already_present');
  assert.match(racedResult.receipts[0].detail, /no second record was made and their details were not changed/);
  assert.equal(raced.names().filter((name) => name === 'record_identity_person_details').length, 1);
  assert.equal(raced.calls.find((c) => c.name === 'record_vehicle_person').args.p_person_record_id, PERSON);
  assert.equal(raced.calls.find((c) => c.name === 'add_person_alias').args.p_person_record_id, PERSON);
  assert.equal(raced.calls.find((c) => c.name === 'raise_entity_flag').args.p_entity_id, CANON);

  const crowded = fakeRpc({ record_identity_person_details: fail('AMBIGUOUS_PERSON: 2 people named Riley Sample'), search_vehicle_registrations: ok([]), manage_identity_vehicle: ok({ vehicle_id: VEH }) });
  const crowdedResult = await applyRecordUpdatePlan({ rpc: crowded.rpc, organizationId: ORG, pending });
  assert.match(crowdedResult.receipts[0].detail, /More than one person with this name is now recorded, so I did not create another/);
  assert.ok(!crowded.names().includes('record_vehicle_person'));

  // A caller without identity-register administrator rights: reported, and nothing is attached to a person who does not exist.
  const denied = fakeRpc({
    record_identity_person_details: fail('Identity registry administrator access required'),
    search_vehicle_registrations: ok([]), manage_identity_vehicle: ok({ vehicle_id: VEH }),
  });
  const deniedResult = await applyRecordUpdatePlan({ rpc: denied.rpc, organizationId: ORG, pending });
  assert.deepEqual(deniedResult.receipts.map((r) => r.status), ['failed', 'applied', 'skipped_dependency', 'skipped_dependency', 'skipped_dependency']);
  assert.match(deniedResult.receipts[0].detail, /Identity registry administrator access required/);
  assert.ok(!denied.names().includes('record_vehicle_person'));
});

test('updating a person sends only the new details, never the name, and reports details already present', async () => {
  const { applyRecordUpdatePlan } = await load();
  const step = { kind: 'update_person_details', label: 'Update', person_ref: 'name:knownperson', person_record_id: PERSON, display_name: 'Known Person', fields: { category: 'Visitor', phone: '021 000 0000' } };
  const db = fakeRpc({ record_identity_person_details: ok({ outcome: 'updated', person_record_id: PERSON, canonical_person_id: CANON }) });
  const applied = await applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending: { plan_id: PLAN, source_summary: SUMMARY, steps: [step] } });
  assert.equal(applied.receipts[0].status, 'applied');
  assert.deepEqual(db.names(), ['record_identity_person_details']);
  assert.deepEqual(db.calls[0].args, {
    p_organization_id: ORG, p_person_record_id: PERSON, p_action: 'update',
    p_fields: { category: 'Visitor', phone: '021 000 0000' }, p_distinct_from: [], p_reason: `Bob chat (confirmed by user): ${SUMMARY}`,
  });

  const same = fakeRpc({ record_identity_person_details: ok({ outcome: 'unchanged', person_record_id: PERSON, canonical_person_id: CANON }) });
  const present = await applyRecordUpdatePlan({ rpc: same.rpc, organizationId: ORG, pending: { plan_id: PLAN, steps: [step] } });
  assert.equal(present.receipts[0].status, 'already_present');
  assert.match(present.receipts[0].detail, /These details are already on the person record/);

  const merged = fakeRpc({ record_identity_person_details: fail('This person has been merged into another record') });
  const refused = await applyRecordUpdatePlan({ rpc: merged.rpc, organizationId: ORG, pending: { plan_id: PLAN, steps: [step] } });
  assert.equal(refused.receipts[0].status, 'failed');
  assert.match(refused.receipts[0].detail, /merged into another record since the preview, so nothing was changed/);

  const gone = fakeRpc({ record_identity_person_details: fail('Person record not found in this organization') });
  const missing = await applyRecordUpdatePlan({ rpc: gone.rpc, organizationId: ORG, pending: { plan_id: PLAN, steps: [step] } });
  assert.equal(missing.receipts[0].status, 'failed');
  assert.match(missing.receipts[0].detail, /Person record not found in this organization/);
});

test('an amendment merges into the waiting plan: same items replace, details merge, numbered items drop', async () => {
  const { validateRecordUpdatePlan, recordUpdateSources, amendRecordUpdatePlan } = await load();
  const raw = [
    { kind: 'vehicle_details', plate: 'TST301', fields: { colour: 'Silver' } },
    { kind: 'vehicle_details', plate: 'TST302', fields: { body_type: 'Truck' } },
    { kind: 'person_alias', person: 'Drew Sample', alias: 'Pat Alias' },
    { kind: 'unsupported', statement: 'Meeting note for the site visit', reason: 'No target report record id was given.' },
    { kind: 'role_assignment', statement: 'Store Riley Sample as a compliance officer' },
  ];
  const first = validateRecordUpdatePlan({ source_summary: SUMMARY, operations: raw }).plan;
  const sources = recordUpdateSources(first, raw);
  assert.equal(sources.length, 5);
  assert.deepEqual(sources[3], { kind: 'unsupported', statement: 'Meeting note for the site visit', reason: 'No target report record id was given.', original_kind: 'unsupported' });
  assert.equal(sources[4].original_kind, 'role_assignment');
  const prior = {
    source_summary: SUMMARY, source_operations: sources,
    steps: [{ op_index: 0, label: 'Register vehicle TST301' }, { op_index: 1, label: 'Register vehicle TST302' }],
    held: [{ index: 2, statement: 'person alias', reason: 'No existing person matches "Drew Sample"' }, { index: 3, statement: 'Meeting note for the site visit', reason: 'No target report record id was given.' }],
  };

  const amended = amendRecordUpdatePlan(prior, {
    source_summary: 'Corrections from the user',
    operations: [
      { kind: 'vehicle_details', plate: 'tst 301', fields: { make: 'Toyota' } },
      { kind: 'person_details', person: 'Drew Sample' },
      { kind: 'person_details', person: 'Riley Sample', fields: { category: 'Compliance officer, Example Council' } },
    ],
    remove: [2, 'meeting note'],
  });
  assert.equal(amended.ok, true);
  assert.equal(amended.amended, true);
  assert.equal(amended.plan.source_summary, 'Corrections from the user');
  assert.deepEqual(amended.plan.operations.map((op) => [op.index, op.kind]), [[0, 'vehicle_details'], [1, 'person_alias'], [3, 'person_details'], [4, 'person_details']]);
  assert.deepEqual(amended.plan.operations[0].fields, { colour: 'Silver', make: 'Toyota' });
  // The held role item is superseded only by an operation of its own kind; person_details is not role_assignment.
  assert.deepEqual(amended.plan.held.map((h) => [h.index, h.original_kind]), [[2, 'role_assignment']]);

  // A held item is superseded only by a valid operation of its kind about the same person or vehicle.
  const badRaw = [
    { kind: 'person_details', person: 'Jordan Placeholder', fields: { email: 'not-an-email' } },
    { kind: 'person_details', person: 'Kim Near', fields: { phone: '12' } },
  ];
  const badPlan = validateRecordUpdatePlan({ operations: badRaw }).plan;
  const badPrior = { source_operations: recordUpdateSources(badPlan, badRaw), steps: [], held: badPlan.held };
  const fixed = amendRecordUpdatePlan(badPrior, { operations: [{ kind: 'person_details', person: 'jordan  placeholder', fields: { email: 'jordan@example.test' } }] });
  assert.deepEqual(fixed.plan.held.map((h) => h.reason), ['Kim Near: phone is not a valid number.']);
  assert.deepEqual(fixed.plan.operations.map((op) => op.person.name), ['jordan placeholder']);
  const again = amendRecordUpdatePlan({ ...badPrior, source_operations: recordUpdateSources(fixed.plan, []) }, { operations: [{ kind: 'person_details', person: 'Kim Near', fields: { phone: '021 000 0000' } }] });
  assert.deepEqual(again.plan.held, []);
  assert.equal(again.plan.operations.length, 2);

  const kept = amendRecordUpdatePlan(prior, { operations: [{ kind: 'vehicle_details', plate: 'TST302', fields: { colour: 'White' } }] });
  assert.deepEqual(kept.plan.held.map((h) => h.statement), ['Meeting note for the site visit', 'Store Riley Sample as a compliance officer']);
  assert.deepEqual(kept.plan.operations.find((op) => op.plate === 'TST302').fields, { body_type: 'Truck', colour: 'White' });

  assert.match(amendRecordUpdatePlan(prior, { remove: [9] }).error, /I could not find "9" in the preview, so I have not changed it/);
  assert.match(amendRecordUpdatePlan(prior, { remove: ['a vehicle that is not there'] }).error, /I could not find/);
  assert.match(amendRecordUpdatePlan(prior, {}).error, /Tell me what to change in the preview/);
  const many = Array.from({ length: 21 }, (_, i) => ({ kind: 'vehicle_details', plate: `TSX${100 + i}`, fields: { colour: 'Red' } }));
  assert.match(amendRecordUpdatePlan(prior, { operations: many }).error, /more than 25 updates/);
});

test('amendments keep every held request and supersede a held item only for the same subject', async () => {
  const { validateRecordUpdatePlan, recordUpdateSources, amendRecordUpdatePlan } = await load();
  const SITE_A = '15000000-0000-4000-8000-00000000000c';
  const SITE_B = '16000000-0000-4000-8000-00000000000d';
  const raw = [
    { kind: 'person_details', person: 'Jordan Placeholder', fields: { email: 'not-an-email' } },
    { kind: 'safety_warning', target: { type: 'site', site_id: SITE_A }, hazard_class: 'not_a_class', note: 'Dog on site' },
    { kind: 'record_note', record_kind: 'observation', body: 'Gate left open' },
  ];
  const plan = validateRecordUpdatePlan({ source_summary: SUMMARY, operations: raw }).plan;
  const prior = { source_summary: SUMMARY, source_operations: recordUpdateSources(plan, raw), steps: [], held: plan.held };
  assert.deepEqual(prior.source_operations.map((s) => s.subject), ['name:jordan placeholder', `site:${SITE_A}`, undefined]);

  // Held items share the default statement (their kind); each is still listed, and none overwrites another.
  const both = amendRecordUpdatePlan(prior, { operations: [
    { kind: 'person_details', person: 'Kim Near', fields: { phone: '12' } },
    { kind: 'person_details', person: 'Lee Distant', fields: { email: 'nope' } },
  ] });
  assert.deepEqual(both.plan.held.map((h) => h.subject ?? null), ['name:jordan placeholder', `site:${SITE_A}`, null, 'name:kim near', 'name:lee distant']);
  assert.deepEqual(both.plan.held.map((h) => h.index), [0, 1, 2, 3, 4]);
  // Only the very same held line sent again is not listed twice.
  const repeat = amendRecordUpdatePlan(prior, { operations: [{ kind: 'person_details', person: 'Jordan Placeholder', fields: { email: 'not-an-email' } }] });
  assert.equal(repeat.plan.held.length, 3);

  // A valid warning for another site leaves the held one; a valid warning for the same site replaces it.
  const warning = (siteId) => ({ kind: 'safety_warning', target: { type: 'site', site_id: siteId }, hazard_class: 'dangerous_dog', note: 'Dog on site' });
  assert.ok(amendRecordUpdatePlan(prior, { operations: [warning(SITE_B)] }).plan.held.some((h) => h.subject === `site:${SITE_A}`));
  const sameSite = amendRecordUpdatePlan(prior, { operations: [warning(SITE_A)] });
  assert.ok(!sameSite.plan.held.some((h) => h.subject === `site:${SITE_A}`));
  assert.equal(sameSite.plan.operations.length, 1);
  // A held note with no record named is never replaced by a note on some other record; the user drops it.
  const otherNote = amendRecordUpdatePlan(prior, { operations: [{ kind: 'record_note', record_kind: 'observation', record_id: OBS, body: 'Gate left open' }] });
  assert.ok(otherNote.plan.held.some((h) => h.original_kind === 'record_note'));
  const dropped = amendRecordUpdatePlan(prior, { remove: ['Tell me which report record this note belongs to (its record id)'] });
  assert.ok(!dropped.plan.held.some((h) => h.original_kind === 'record_note'));
});

test('removal drops exactly the item the user names, and corrections move every item about a name or plate', async () => {
  const { validateRecordUpdatePlan, resolveRecordUpdatePlan, recordUpdateSources, amendRecordUpdatePlan, renderRecordUpdatePreview } = await load();
  const raw = [
    { kind: 'person_details', person: 'Riley Sampel', fields: { category: 'Compliance officer' } },
    { kind: 'person_details', person: 'Riley Sampel', fields: { phone: '021 000 0000' } },
    { kind: 'vehicle_details', plate: 'TST601', fields: { colour: 'Red' } },
    { kind: 'vehicle_details', plate: 'TST602', fields: { colour: 'Blue' } },
    { kind: 'vehicle_person_link', plate: 'TST602', person: 'Riley Sampel' },
    { kind: 'person_alias', person: 'Riley Sampel', alias: 'R. Sample' },
    { kind: 'unsupported', statement: 'Meeting note for the site visit', reason: 'No target report record id was given.' },
  ];
  const plan = validateRecordUpdatePlan({ source_summary: SUMMARY, operations: raw }).plan;
  const db = fakeRpc({ search_vehicle_registrations: ok([]), find_person_matches: ok([]) });
  const resolved = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan });
  assert.deepEqual(resolved.steps.map((s) => s.kind), ['create_person', 'register_vehicle', 'register_vehicle', 'vehicle_person_link', 'person_alias']);
  const prior = { source_summary: SUMMARY, source_operations: recordUpdateSources(plan, raw), steps: resolved.steps, held: resolved.held };
  const preview = renderRecordUpdatePreview(resolved);

  // The numbered person item was built from two detail items; dropping it drops both, so it cannot come back.
  const noPerson = amendRecordUpdatePlan(prior, { remove: [1] });
  assert.ok(!noPerson.plan.operations.some((op) => op.kind === 'person_details'));
  assert.equal(noPerson.plan.operations.length, 4);
  // Wording that fits several lines is refused rather than dropping all of them.
  assert.match(amendRecordUpdatePlan(prior, { remove: ['register vehicle'] }).error, /"register vehicle" matches more than one item in the preview, so I have not changed it/);
  assert.match(amendRecordUpdatePlan(prior, { remove: ['TS'] }).error, /I could not find "TS"/);
  // A line copied whole from the preview, with its number or bullet, names that one item.
  const stepLine = preview.split('\n').find((line) => line.startsWith('2. '));
  assert.match(stepLine, /TST601/);
  const noFirstVehicle = amendRecordUpdatePlan(prior, { remove: [stepLine] });
  assert.ok(!noFirstVehicle.plan.operations.some((op) => op.plate === 'TST601'));
  assert.ok(noFirstVehicle.plan.operations.some((op) => op.plate === 'TST602'));
  const heldLine = preview.split('\n').find((line) => line.startsWith('- Meeting note'));
  assert.equal(heldLine, '- Meeting note for the site visit: No target report record id was given.');
  assert.deepEqual(amendRecordUpdatePlan(prior, { remove: [heldLine] }).plan.held, []);

  // A corrected name or plate moves every item about it, so the earlier spelling is not also created.
  const corrected = amendRecordUpdatePlan(prior, { corrections: [{ kind: 'person', from: 'riley  sampel', to: 'Riley Sample' }, { kind: 'plate', from: 'tst 602', to: 'TST620' }] });
  assert.equal(corrected.ok, true);
  const names = corrected.plan.operations.map((op) => op.person?.name).filter(Boolean);
  assert.deepEqual([...new Set(names)], ['Riley Sample']);
  assert.deepEqual(corrected.plan.operations.map((op) => op.plate).filter(Boolean), ['TST601', 'TST620', 'TST620']);
  const again = await resolveRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, plan: corrected.plan });
  assert.deepEqual(again.steps.filter((s) => s.kind === 'create_person').map((s) => [s.display_name, s.fields]), [['Riley Sample', { category: 'Compliance officer', phone: '021 000 0000' }]]);
  assert.ok(!again.steps.some((s) => /Sampel|TST602/.test(s.label)));
  assert.match(amendRecordUpdatePlan(prior, { corrections: [{ from: 'Nobody Here', to: 'Someone' }] }).error, /I could not find "Nobody Here" in the preview, so I have not changed it/);
  assert.match(amendRecordUpdatePlan(prior, { corrections: [{ kind: 'plate', from: 'TST601' }] }).error, /A plate correction needs the plate as previewed and the corrected plate/);
});

test('the chat transcript case: an amendment keeps the previewed changes, adds people and resolves the waiting name', async () => {
  const handlers = {
    search_vehicle_registrations: ok([]), find_person_matches: ok([]), record_identity_person_details: createdPerson,
    manage_identity_vehicle: ok({ vehicle_id: VEH }), record_vehicle_person: ok({ person_record_id: PERSON, canonical_person_id: CANON }),
    add_person_alias: ok({}), get_safety_warnings: ok([]), raise_entity_flag: ok({}),
  };
  const { db, env, transcript } = chatEnv(handlers);
  const flow = await makeFlow(env);
  const first = await flow.dispatchTool('update_records', {
    source_summary: 'Council email about the site',
    operations: [
      { kind: 'vehicle_details', plate: 'TST101', fields: { colour: 'silver', body_type: 'SUV' } },
      { kind: 'vehicle_details', plate: 'TST102', fields: { body_type: 'truck' } },
      { kind: 'vehicle_person_link', plate: 'TST101', person: 'Casey Testperson' },
      { kind: 'person_alias', person: 'Drew Sample', alias: 'Pat Alias' },
      { kind: 'safety_warning', target: { type: 'person', name: 'Casey Testperson' }, hazard_class: 'violence_or_aggression', note: 'Safety risk noted at the site' },
      { kind: 'unsupported', statement: 'Meeting note for the site visit', reason: 'No target report record id was given.' },
    ],
  });
  assert.equal(first.meta.outcome, 'proposed');
  assert.match(first.reply, /^Preview — I will make these 4 changes/);
  assert.match(first.reply, /no one to add "Pat Alias" to yet\. Ask me to create their person record as well/);
  const firstPlan = first.meta.pending_record_updates;
  assert.equal(firstPlan.source_operations.length, 6);
  transcript.rows.push(
    { id: PERSON, conversation_id: 'thread-a', role: 'user', content: 'update the records from this email', metadata: null },
    { id: MSG, conversation_id: 'thread-a', role: 'assistant', content: first.reply, metadata: first.meta },
  );
  const waiting = (await loadHistory(transcript, 'thread-a')).pending;
  const amendment = 'no, we want to create the person records: Riley Sample is a compliance officer with Example Council and Jordan Placeholder is a sergeant with Example Police. Create Drew Sample too.';
  assert.equal(await flow.confirm(waiting, amendment), null);

  const second = await flow.dispatchTool('update_records', {
    source_summary: 'Corrections in chat',
    operations: [
      { kind: 'person_details', person: 'Riley Sample', fields: { category: 'Compliance officer, Example Council' } },
      { kind: 'person_details', person: 'Jordan Placeholder', fields: { category: 'Sergeant, Example Police' } },
      { kind: 'person_details', person: 'Drew Sample' },
    ],
  }, waiting);
  assert.equal(second.meta.outcome, 'proposed');
  assert.equal(second.meta.amended_from_plan_id, firstPlan.plan_id);
  assert.match(second.reply, /^Updated preview \(your changes are included; it replaces the earlier one\) — I will make these 8 changes as you/);
  const amendedPlan = second.meta.pending_record_updates;
  assert.notEqual(amendedPlan.plan_id, firstPlan.plan_id);
  assert.deepEqual(amendedPlan.steps.map((s) => s.kind), ['create_person', 'create_person', 'create_person', 'register_vehicle', 'register_vehicle', 'vehicle_person_link', 'person_alias', 'safety_warning']);
  assert.match(amendedPlan.steps[6].label, /Record "Pat Alias" as another name for Drew Sample \(created above\)/);
  assert.deepEqual(amendedPlan.held.map((h) => h.statement), ['Meeting note for the site visit']);
  assert.equal(amendedPlan.source_operations.length, 9);
  assert.ok(!db.names().some((name) => /^manage_|record_identity|record_vehicle_person|add_person_alias|raise_entity_flag/.test(name)));
  // The preview it replaces is retired, so a copy of that earlier preview can no longer be confirmed.
  assert.equal(transcript.rows.find((row) => row.id === MSG).metadata.outcome, 'amended');
  const stale = await flow.confirm(waiting, 'yes');
  assert.equal(stale.meta.outcome, 'already_answered');
  assert.ok(!db.names().some((name) => /^manage_|record_identity/.test(name)));

  transcript.rows.push(
    { id: PERSON2, conversation_id: 'thread-a', role: 'user', content: amendment, metadata: null },
    { id: VEH, conversation_id: 'thread-a', role: 'assistant', content: second.reply, metadata: second.meta },
  );
  const latest = (await loadHistory(transcript, 'thread-a')).pending;
  assert.equal(latest.message_id, VEH);
  const result = await flow.confirm(latest, 'yes');
  assert.equal(result.meta.outcome, 'applied');
  assert.deepEqual(result.meta.receipts.map((r) => r.status), Array(8).fill('applied'));
  const creates = db.calls.filter((c) => c.name === 'record_identity_person_details').map((c) => c.args.p_fields);
  assert.deepEqual(creates, [
    { category: 'Compliance officer, Example Council', display_name: 'Riley Sample' },
    { category: 'Sergeant, Example Police', display_name: 'Jordan Placeholder' },
    { display_name: 'Drew Sample' },
  ]);
  assert.equal(db.calls.find((c) => c.name === 'add_person_alias').args.p_person_record_id, personIds['Drew Sample']);
  assert.equal(db.calls.filter((c) => c.name === 'manage_identity_vehicle').length, 2);
  // Each write is audited with the words of the request that asked for it, not only the latest message.
  assert.ok(db.calls.filter((c) => c.name === 'record_identity_person_details').every((c) => c.args.p_reason === 'Bob chat (confirmed by user): Corrections in chat'));
  assert.ok(db.calls.filter((c) => c.name === 'manage_identity_vehicle').every((c) => c.args.p_reason === 'Bob chat (confirmed by user): Council email about the site'));
});

test('a rejected amendment leaves the waiting preview confirmable; replace_all and unsigned previews start fresh', async () => {
  const { verifyPendingRecordUpdates } = await load();
  const handlers = { search_vehicle_registrations: ok([]), find_person_matches: ok([]), manage_identity_vehicle: ok({ vehicle_id: VEH }) };
  const { db, env, transcript } = chatEnv(handlers);
  const flow = await makeFlow(env);
  const outcomeOf = (id) => transcript.rows.find((row) => row.id === id).metadata.outcome;
  const first = await flow.dispatchTool('update_records', {
    source_summary: SUMMARY,
    operations: [
      { kind: 'vehicle_details', plate: 'TST401', fields: { colour: 'Red' } },
      { kind: 'unsupported', statement: 'Meeting note for the site visit', reason: 'No target report record id was given.' },
    ],
  });
  transcript.rows.push({ id: MSG, conversation_id: 'thread-a', role: 'assistant', content: first.reply, metadata: first.meta });
  const waiting = (await loadHistory(transcript, 'thread-a')).pending;
  const firstPlan = first.meta.pending_record_updates;

  const rejected = await flow.dispatchTool('update_records', { remove: [7] }, waiting);
  assert.equal(rejected.meta.outcome, 'proposed');
  assert.equal(rejected.meta.amendment_rejected_for_plan_id, firstPlan.plan_id);
  assert.match(rejected.reply, /I could not find "7" in the preview, so I have not changed it/);
  assert.match(rejected.reply, /The earlier preview still stands unchanged\. Reply \*\*yes\*\* to apply it as shown/);
  const carried = rejected.meta.pending_record_updates;
  assert.notEqual(carried.plan_id, firstPlan.plan_id);
  assert.equal(carried.created_at, firstPlan.created_at);
  // Kept exactly: the steps, the held items and the sources a later amendment rebuilds from.
  assert.deepEqual(carried.steps, firstPlan.steps);
  assert.deepEqual(carried.held, firstPlan.held);
  assert.equal(carried.held.length, 1);
  assert.deepEqual(carried.source_operations, firstPlan.source_operations);
  assert.equal(await verifyPendingRecordUpdates(KEY, carried), true);
  // The re-issued preview retired the one it carries forward, so only one of the two can ever be confirmed.
  assert.equal(outcomeOf(MSG), 'amended');
  assert.equal((await flow.dispatchTool('update_records', { remove: [1] }, waiting)).meta.outcome, 'already_answered');
  transcript.rows.push({ id: PERSON, conversation_id: 'thread-a', role: 'assistant', content: rejected.reply, metadata: rejected.meta });
  const stillWaiting = (await loadHistory(transcript, 'thread-a')).pending;
  assert.equal(stillWaiting.message_id, PERSON);
  const applied = await flow.confirm(stillWaiting, 'yes');
  assert.equal(applied.meta.outcome, 'applied');
  assert.equal(db.calls.filter((c) => c.name === 'manage_identity_vehicle').length, 1);

  const restart = await flow.dispatchTool('update_records', { replace_all: true, operations: [{ kind: 'vehicle_details', plate: 'TST402', fields: { colour: 'Blue' } }] }, waiting);
  assert.match(restart.reply, /^Preview — I will make this change/);
  assert.equal(restart.meta.amended_from_plan_id, undefined);
  assert.deepEqual(restart.meta.pending_record_updates.steps.map((s) => s.plate), ['TST402']);

  const { source_operations: _dropped, ...unsignedLegacy } = firstPlan;
  const unsigned = await flow.dispatchTool('update_records', { operations: [{ kind: 'vehicle_details', plate: 'TST403', fields: { colour: 'Green' } }] }, { ...waiting, record_updates: unsignedLegacy });
  assert.match(unsigned.reply, /^Preview — /);
  assert.deepEqual(unsigned.meta.pending_record_updates.steps.map((s) => s.plate), ['TST403']);

  // Removing everything discards the waiting preview, and retires it so it cannot be confirmed afterwards.
  const fresh = await flow.dispatchTool('update_records', { source_summary: SUMMARY, operations: [{ kind: 'vehicle_details', plate: 'TST404', fields: { colour: 'Red' } }] });
  transcript.rows.push({ id: OBS, conversation_id: 'thread-a', role: 'assistant', content: fresh.reply, metadata: fresh.meta });
  const removedAll = await flow.dispatchTool('update_records', { remove: [1] }, (await loadHistory(transcript, 'thread-a')).pending);
  assert.equal(removedAll.meta.outcome, 'nothing_to_apply');
  assert.match(removedAll.reply, /nothing left that I can write safely, so the earlier preview is discarded/);
  assert.equal(outcomeOf(OBS), 'amended');
});

test('a signed preview without sources is re-issued unchanged, and a copied preview cannot carry a successor', async () => {
  const { signPendingRecordUpdates } = await load();
  const { db, env, transcript } = chatEnv({ search_vehicle_registrations: ok([]), manage_identity_vehicle: ok({ vehicle_id: VEH }) });
  const flow = await makeFlow(env);
  const first = await flow.dispatchTool('update_records', { source_summary: SUMMARY, operations: [{ kind: 'vehicle_details', plate: 'TST501', fields: { colour: 'Red' } }] });
  const { source_operations: _sources, signature: _signature, ...older } = first.meta.pending_record_updates;
  const legacy = await signPendingRecordUpdates(KEY, older);
  transcript.rows.push({ id: MSG, conversation_id: 'thread-a', role: 'assistant', content: first.reply, metadata: { ...first.meta, pending_record_updates: legacy } });
  const waiting = (await loadHistory(transcript, 'thread-a')).pending;
  const reissued = await flow.dispatchTool('update_records', { operations: [{ kind: 'vehicle_details', plate: 'TST502', fields: { colour: 'Blue' } }] }, waiting);
  assert.equal(reissued.meta.outcome, 'proposed');
  assert.equal(reissued.meta.legacy_preview_reissued_for_plan_id, legacy.plan_id);
  assert.match(reissued.reply, /^That preview was made before I could change a preview in place, so I cannot amend it/);
  assert.deepEqual(reissued.meta.pending_record_updates.steps, legacy.steps);
  assert.equal(reissued.meta.pending_record_updates.source_operations, undefined);
  assert.equal(transcript.rows.find((row) => row.id === MSG).metadata.outcome, 'amended');

  // The same signed preview copied into a later row: the plan id is ambiguous, so neither row can be carried forward.
  const second = await flow.dispatchTool('update_records', { source_summary: SUMMARY, operations: [{ kind: 'vehicle_details', plate: 'TST503', fields: { colour: 'Red' } }] });
  transcript.rows.push(
    { id: OBS, conversation_id: 'thread-a', role: 'assistant', content: second.reply, metadata: second.meta },
    { id: PERSON, conversation_id: 'thread-a', role: 'assistant', content: second.reply, metadata: structuredClone(second.meta) },
  );
  const copied = (await loadHistory(transcript, 'thread-a')).pending;
  assert.equal(copied.message_id, PERSON);
  const refused = await flow.dispatchTool('update_records', { operations: [{ kind: 'vehicle_details', plate: 'TST504', fields: { colour: 'Blue' } }] }, copied);
  assert.equal(refused.meta.outcome, 'already_answered');
  assert.equal(refused.meta.pending_record_updates, undefined);
  assert.ok(!db.names().includes('manage_identity_vehicle'));
});

test('the verifier blocks a prose refusal or summary when the user asked for record changes and update_records is available', () => {
  const tools = [{ tool: 'update_records' }];
  const answer = (reply) => ({ action: 'answer', reply, questions: [], args: {} });
  const flagged = (decision, message, toolList = tools) => runDeterministicChecks(decision, { message, tools: toolList })
    .some((issue) => issue.code === 'record_update_tool_skipped' && issue.severity === 'block');
  const summary = 'What the email supports for a clean update note:\n- Vehicle record: TST101, silver SUV.';
  assert.equal(flagged(answer(summary), 'update vehcile and people records with the below detials From: Example Council'), true);
  assert.equal(flagged(answer(summary), 'update canonical records and reports with these details'), true);
  assert.equal(flagged(answer('Noted.'), 'no, we want to create the person record, Riley Sample is a compliance officer'), true);
  assert.equal(flagged(answer('I can\u2019t write those record updates from this chat because there isn\u2019t a vehicle/person record update path available here.'), 'Here is the council email about the site and vehicle TST101'), true);
  assert.equal(flagged(answer(summary), 'update vehicle records with the details below', []), false);
  assert.equal(flagged(answer('Yes, two vehicles were registered.'), 'did you update the vehicle records?'), false);
  assert.equal(flagged(answer('I can\u2019t change the roster from here.'), 'change the roster so people start at 8am'), false);
  assert.equal(flagged(answer('Here is the updated training summary.'), 'update the training records summary for the team'), false);
  assert.equal(flagged({ action: 'use_tool', tool: 'update_records', reply: '', questions: [], args: { operations: [] } }, 'update vehicle records'), false);
  // The block must tell the repair pass to select the tool, or it can answer in prose again.
  const [block] = runDeterministicChecks(answer(summary), { message: 'update vehicle records with these details', tools })
    .filter((issue) => issue.code === 'record_update_tool_skipped');
  assert.match(block.note, /select update_records now with every fact as an operation/);
  assert.match(block.note, /writes nothing until the user says yes/);
  // A short question about what Bob can do is not a request; a polite request that supplies details is.
  assert.equal(flagged(answer('Yes. Tell me the details and I will preview the change.'), 'Can you update vehicle records?'), false);
  assert.equal(flagged(answer('Yes, I can link people to vehicles.'), 'Is there a way to add a person to the vehicle register?'), false);
  assert.equal(flagged(answer(summary), 'Can you add these details to the vehicle record: TST101 is silver?'), true);
  // The instruction often comes after a long pasted email; the end of the message counts too.
  const email = ['From: Example Council', 'Subject: Site visit', '', ...Array(12).fill('The officer attended the site and spoke with the occupants about the gate.'), 'Vehicle TST101 was parked by the gate.'].join('\n');
  assert.ok(email.length > 600);
  assert.equal(flagged(answer(summary), `${email}\n\nPlease update the vehicle and people records with the above.`), true);
  assert.equal(flagged(answer('Yes, two vehicles were registered.'), `${email}\n\nDid you update the vehicle records?`), false);
});

test('the tool catalogue and doctrine describe person records and amendments', () => {
  assert.match(caddie, /kind: \\"person_details\\", person: \{ name \} \| \{ person_record_id, name \}, fields: \{ category\?/);
  assert.match(caddie, /remove\?: \[preview item numbers, or wording copied from exactly one preview line, including a \\"Not included\\" line\]/);
  assert.match(caddie, /corrections\?: \[\{ kind: \\"person\\"\|\\"plate\\", from: /);
  assert.match(caddie, /creating or editing a person record needs identity-register administrator rights/);
  const doctrine = fs.readFileSync('docs/canon/BOB_DOCTRINE.md', 'utf8');
  assert.match(doctrine, /`record_identity_person_details`, which the database limits to\s+identity-register administrators/);
  assert.match(doctrine, /A follow-up message while a preview\s+waits amends that\s+preview rather than replacing it/);
  assert.match(doctrine, /Editing a person changes details only, under\s+the row lock: the name is never sent/);
  assert.match(doctrine, /the waiting preview is retired in\s+its one transcript row while it is still unanswered/);
});

test('a person interaction on a job is previewed, anchored and applied idempotently as the caller', async () => {
  const mod = await load();
  const JOB = '11000000-0000-4000-8000-000000000008';
  const { plan } = mod.validateRecordUpdatePlan({
    source_summary: 'Gibbons callout outcome',
    operations: [
      { kind: 'person_interaction', person: 'Unknown male', interaction_type: 'trespass_notice_served', notes: 'Trespass notice served under the covered area.', dispatch_job_id: JOB },
      { kind: 'person_interaction', person: 'Alex Example', interaction_type: 'trespass_notice_served', notes: 'No job given.' },
      { kind: 'person_interaction', person: 'Alex Example', interaction_type: 'arrested', notes: 'Wrong type.', dispatch_job_id: JOB },
    ],
  });
  assert.deepEqual(plan.operations.map((op) => op.index), [0]);
  assert.match(plan.held[0].reason, /which dispatch job or shift/);
  assert.match(plan.held[1].reason, /Choose what happened/);

  // An officer cannot search people: the name still goes to the RPC, which matches it privately.
  const officer = fakeRpc({ find_person_matches: fail('permission denied (42501)') });
  const { steps, held } = await mod.resolveRecordUpdatePlan({ rpc: officer.rpc, organizationId: ORG, plan });
  assert.deepEqual(held.map((h) => h.index), [1, 2]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].new_person_name, 'Unknown male');
  assert.equal(steps[0].person_record_id, undefined);
  assert.match(steps[0].label, /trespass notice served for Unknown male \(matched privately/);
  assert.doesNotMatch(steps[0].label, UUID_RE);

  const pending = { plan_id: PLAN, source_summary: 'Gibbons callout outcome', steps };
  const db = fakeRpc({ record_person_interaction: ok({ interaction_id: OBS, person_record_id: PERSON, outcome: 'recorded' }) });
  const first = await mod.applyRecordUpdatePlan({ rpc: db.rpc, organizationId: ORG, pending });
  assert.equal(first.outcome, 'applied');
  assert.deepEqual(db.calls[0].args, {
    p_client_request_id: await mod.deterministicUuid(`${PLAN}:0`), p_organization_id: ORG,
    p_interaction_type: 'trespass_notice_served', p_notes: 'Trespass notice served under the covered area.',
    p_person_record_id: null, p_new_person_name: 'Unknown male', p_dispatch_job_id: JOB, p_shift_id: null,
    p_interacted_at: null, p_source: 'bob',
  });
  const retry = fakeRpc({ record_person_interaction: ok({ interaction_id: OBS, person_record_id: PERSON, outcome: 'already_recorded' }) });
  assert.equal((await mod.applyRecordUpdatePlan({ rpc: retry.rpc, organizationId: ORG, pending })).receipts[0].status, 'already_present');
  assert.equal(mod.isTrustedPendingRecordUpdates({ ...pending, user_id: 'u', conversation_id: 'c', organization_id: ORG, created_at: new Date().toISOString() },
    { userId: 'u', conversationId: 'c', organizationId: ORG }), true);

  // An administrator who can search binds the existing person by id.
  const admin = fakeRpc({ find_person_matches: ok([exactMatch(PERSON, 'Unknown male')]) });
  const bound = await mod.resolveRecordUpdatePlan({ rpc: admin.rpc, organizationId: ORG, plan });
  assert.equal(bound.steps[0].person_record_id, PERSON);
  assert.equal(bound.steps[0].new_person_name, undefined);
  assert.match(caddie, /kind: \\"person_interaction\\"/);
});
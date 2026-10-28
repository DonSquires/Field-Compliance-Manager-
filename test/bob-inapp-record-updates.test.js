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
    const matches = () => rows.filter((row) => filters.every(([col, val]) => (col === 'metadata->>outcome' ? row.metadata?.outcome : row[col]) === val));
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
      async limit() { return { data: matches().slice().reverse() }; },
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
assert.ok(hook.indexOf('claimRecordUpdatePreview(') < hook.indexOf("recordUpdatesChoice === 'decline'"));
assert.ok(hook.indexOf('claimRecordUpdatePreview(') < hook.indexOf('applyRecordUpdatePlan('));

async function makeFlow(env) {
  const mod = await load();
  return vm.runInNewContext(`(env) => {
    const { caps, user, conversationId, orgId, callerClient, persist, admin, startTime, respond, buildStructuredResponse, isToolEffectPermitted,
      validateRecordUpdatePlan, resolveRecordUpdatePlan, renderRecordUpdatePreview, recordUpdateDecision, isTrustedPendingRecordUpdates,
      claimRecordUpdatePreview, applyRecordUpdatePlan, renderRecordUpdateReceipts } = env;
    const dispatchTool = async (tool, toolArgs) => {
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
  const stored = {
    plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', organization_id: ORG, created_at: new Date().toISOString(),
    source_summary: SUMMARY, held: [], steps: [{ kind: 'record_note', label: 'Add a note', record_kind: 'observation', record_id: OBS, entry_kind: 'note', body: 'x' }],
  };
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
  const expired = { ...pending, record_updates: { ...stored, created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString() } };
  const { env } = chatEnv({});
  assert.equal((await (await makeFlow(env)).confirm(expired, 'yes')).meta.outcome, 'unconfirmed');
  assert.equal(await (await makeFlow(env)).confirm({ kind: 'builder_cancellation_pending' }, 'yes'), null);
});

test('two overlapping yes replies apply the preview once; the other is told nothing more was written', async () => {
  const stored = {
    plan_id: PLAN, user_id: 'user-a', conversation_id: 'thread-a', organization_id: ORG, created_at: new Date().toISOString(),
    source_summary: SUMMARY, held: [], steps: [{ kind: 'record_note', label: 'Add a note', record_kind: 'observation', record_id: OBS, entry_kind: 'note', body: 'x' }],
  };
  const pending = { kind: 'record_updates_pending', record_updates: stored, message_id: MSG };
  const { db, env, transcript } = chatEnv(
    { list_record_updates: ok([]), add_record_update: ok(OBS) },
    [{ id: MSG, conversation_id: 'thread-a', role: 'assistant', metadata: { outcome: 'proposed', pending_record_updates: stored } }],
  );
  const flow = await makeFlow(env);
  const results = await Promise.all([flow.confirm(pending, 'yes'), flow.confirm(pending, 'yes please'), flow.confirm(pending, 'no')]);
  assert.deepEqual(results.map((r) => r.meta.outcome).sort(), ['already_answered', 'already_answered', 'applied']);
  assert.deepEqual(db.names(), ['list_record_updates', 'add_record_update']);
  assert.equal(transcript.rows[0].metadata.outcome, 'confirmed');
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
  assert.match(prompt, /COMPLETE amended operations list/);
  assert.match(prompt, /FACTS ABOUT PEOPLE, VEHICLES AND REPORTS: .*select update_records/);
  assert.match(prompt, /never say you have no way to update these records/);
  assert.match(prompt, /never claim a record changed without an update_records receipt/);
  assert.doesNotMatch(prompt, UUID_RE);
});

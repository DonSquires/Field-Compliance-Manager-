const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const load = () => import('../supabase/functions/_shared/report-incident-triage.mjs');

const report = {
  version: 2,
  totals: { entries: 6, places: 2 },
  labels: { category: { patrol_visit: 'Patrols and site checks', maintenance: 'Maintenance and repairs' }, module: { noise: 'Noise' } },
};
const lines = {
  version: 2,
  lines: [
    { d: '2026-10-01', t: '07:00', p: 'Smiths', k: 'event', c: 'patrol_visit' },
    { d: '2026-10-02', t: '08:00', p: 'Smiths', k: 'event', c: 'patrol_visit', n: 'Chain on the gate cut; log winched aside.', ac: 'New lock fitted.' },
    { d: '2026-10-02', t: '08:00', p: 'Smiths', k: 'event', c: 'patrol_visit', n: 'Chain on the gate cut; log winched aside.', ac: 'New lock fitted.', ph: 2 },
    { d: '2026-10-03', p: 'Kings Ridge', k: 'incident', it: 'theft', n: 'Diesel taken.' },
    { d: '2026-10-04', k: 'observation', mo: 'noise', ti: 'Loud music', n: 'x'.repeat(900) },
    { d: 'not a date', p: 'Smiths', k: 'event', c: 'maintenance', n: 'Undated note.' },
  ],
};

test('Bob reads written, non-routine entries once each, never recorded incidents or routine patrols', async () => {
  const { triageCandidates } = await load();
  const { activityLineKey } = await import('../supabase/functions/_shared/report-activity-sections.mjs');
  assert.deepEqual(triageCandidates({}, lines), []);
  const candidates = triageCandidates({ activityReport: report }, lines);
  assert.deepEqual(candidates.map((candidate) => candidate.date), ['2026-10-02', '2026-10-04']);
  assert.equal(candidates[0].key, activityLineKey(lines.lines[1]));
  assert.deepEqual(candidates[0].prompt, {
    date: '2026-10-02', time: '08:00', place: 'Smiths', kind: 'Patrols and site checks',
    note: 'Chain on the gate cut; log winched aside.', action: 'New lock fitted.',
  });
  assert.equal(candidates[0].excerpt, 'Chain on the gate cut; log winched aside. | Action: New lock fitted.');
  assert.equal(candidates[1].place, 'Not location-specific');
  assert.equal(candidates[1].prompt.kind, 'Noise observation');
  assert.ok(candidates[1].prompt.note.length <= 600);
  assert.ok(candidates[1].excerpt.length <= 1000);
});

test('the prompt is judgement guided by cards and reviewer decisions, not a keyword list', async () => {
  const { TRIAGE_INSTRUCTIONS, INCIDENT_TYPES, triageSystemPrompt, triageBatchMessage } = await load();
  assert.match(TRIAGE_INSTRUCTIONS, /Do not match keywords/);
  assert.match(TRIAGE_INSTRUCTIONS, /Never name or describe a person/);
  assert.ok(INCIDENT_TYPES.includes('trespass') && INCIDENT_TYPES.includes('other'));
  const prompt = triageSystemPrompt(
    [{ title: 'Perimeter compromise', content: 'Forced or bypassed barriers are incidents.' }, { title: '', content: '' }],
    [
      { excerpt: 'Gate open, closed and locked.', decision: 'not_incident', decision_note: 'Routine for this client.' },
      { excerpt: 'Fuel missing from tank.', decision: 'incident', incident_type: 'theft' },
      { excerpt: 'Never decided.', decision: 'unreviewed' },
    ],
  );
  assert.match(prompt, /### Perimeter compromise\nForced or bypassed barriers are incidents\./);
  assert.match(prompt, /"Gate open, closed and locked\." -> not an incident\n/);
  assert.doesNotMatch(prompt, /Routine for this client|reviewer note/, 'provider-only reviewer notes never reach the model');
  assert.match(prompt, /"Fuel missing from tank\." -> incident \(theft\)/);
  assert.doesNotMatch(prompt, /Never decided/);
  assert.equal(triageSystemPrompt([], []), TRIAGE_INSTRUCTIONS);
  assert.match(triageBatchMessage([{ prompt: { date: '2026-10-02' } }]), /\[\{"i":0,"date":"2026-10-02"\}\]/);
});

test('review examples use only oracle-checked wording from this report, not stored excerpts', async () => {
  const { checkedTriageExamples, triageSystemPrompt } = await load();
  const { activityLineKey } = await import('../supabase/functions/_shared/report-activity-sections.mjs');
  const { PRIVACY_VERSION } = await import('../supabase/functions/_shared/report-privacy-oracle.mjs');
  const original = { d: '2026-10-02', p: 'Smiths', k: 'event', c: 'maintenance', n: 'Alice Example bypassed the gate.' };
  const unchecked = { d: '2026-10-03', p: 'Smiths', k: 'event', c: 'maintenance', n: 'Another Person forced a lock.' };
  const checked = { ...original, n: '[name withheld] bypassed the gate.', pv: PRIVACY_VERSION, lk: activityLineKey(original) };
  const decisions = [
    { line_key: activityLineKey(original), decision: 'incident', incident_type: 'trespass', decided_at: '2026-10-05T00:00:00Z', excerpt: original.n },
    { line_key: activityLineKey(unchecked), decision: 'incident', incident_type: 'trespass', decided_at: '2026-10-06T00:00:00Z', excerpt: unchecked.n },
    { line_key: 'v1:00000000000000', decision: 'not_incident', excerpt: 'A historical unchecked example.' },
  ];
  const examples = checkedTriageExamples({ activityReport: report }, { version: 2, lines: [checked, unchecked] }, decisions);
  assert.deepEqual(examples, [{ excerpt: '[name withheld] bypassed the gate.', decision: 'incident', incident_type: 'trespass' }]);
  const prompt = triageSystemPrompt([], examples);
  assert.match(prompt, /\[name withheld\] bypassed the gate/);
  assert.doesNotMatch(prompt, /Alice Example|Another Person|historical unchecked/);
});

test('flags are validated: entry numbers in range, allowed types, clamped confidence', async () => {
  const { parseTriageFlags } = await load();
  const flags = parseTriageFlags('<think>hmm {"flags":[]}</think>Here: {"flags":[{"i":0,"type":"Trespass","reason":"Barrier bypassed.","confidence":1.7},{"i":"1","type":"made_up","reason":"Odd.","confidence":"high"},{"i":5,"type":"theft"},{"i":-1}]}', 2);
  assert.deepEqual([...flags.entries()], [
    [0, { type: 'trespass', reason: 'Barrier bypassed.', confidence: 1 }],
    [1, { type: 'other', reason: 'Odd.', confidence: null }],
  ]);
  assert.equal(parseTriageFlags('{"flags":[]}', 3).size, 0);
  assert.throws(() => parseTriageFlags('No incidents found.', 3), /did not return JSON/);
  assert.throws(() => parseTriageFlags('{"flags": [}', 3), /malformed JSON/);
  assert.throws(() => parseTriageFlags('{"items":[]}', 3), /no flags list/);
});

test('triage storage is server-only and decisions are custodian-gated, audited and draft-only', () => {
  const sql = read('supabase/migrations/20261105100000_report_incident_triage.sql');
  assert.match(sql, /alter table public\.report_incident_triage enable row level security;/);
  assert.match(sql, /revoke all on table public\.report_incident_triage from public, anon, authenticated;/);
  assert.match(sql, /unique \(service_agreement_id, line_key\)/);
  for (const signature of ['list_report_incident_triage\\(uuid\\)', 'set_report_incident_triage\\(uuid, text, text, text, text\\)']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature} from public, anon, authenticated, service_role;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature} to authenticated;`));
  }
  assert.match(sql, /revoke all on function public\.report_pack_trend_context\(uuid\) from public, anon, authenticated, service_role;\s*grant execute on function public\.report_pack_trend_context\(uuid\) to service_role;/);
  assert.equal((sql.match(/security definer\s+set search_path to 'pg_catalog'/g) ?? []).length, 3);
  assert.equal((sql.match(/is_report_provider_custodian_for_org/g) ?? []).length, 2);
  assert.match(sql, /That entry has not been checked by Bob for this report/);
  assert.match(sql, /insert into public\.audit_log/);
  assert.match(sql, /insert into public\.bob_knowledge_cards[\s\S]*'report_incident_triage'/);

  const edge = read('supabase/functions/flag-report-potential-incidents/index.ts');
  assert.match(edge, /is_report_provider_custodian_for_org/);
  assert.match(edge, /'grand_master', 'master', 'admin', 'admin_officer'/);
  assert.match(edge, /report_potential_incidents_flagged/);
  assert.match(edge, /triageSystemPrompt/);
  assert.doesNotMatch(edge, /decision:\s*'incident'/, 'Bob never records a decision');
  assert.doesNotMatch(edge, /decision_note/, 'reviewer notes are not read for prompts');
  assert.match(edge, /checkedTriageExamples\(pack\.data, pack\.activity_lines, existingResult\.data\)/, 'worked examples use the checked report snapshot');
  assert.doesNotMatch(edge, /select\('excerpt,decision,incident_type'\)/, 'unverified historical excerpts are not read for prompts');
  assert.match(edge, /readPackTriage/, 'triage reads page past the 1,000-row cap');
  assert.match(sql, /set pdf_source_updated_at = null/, 'a changed decision makes generated PDFs stale');
  const reclassify = read('supabase/migrations/20261105120000_report_triage_reclassify_after_send.sql');
  assert.doesNotMatch(reclassify, /cannot be changed/, 'new evidence can change a decision after the report was sent');
  assert.match(reclassify, /cardinality\(v_sent_packs\) > 0 and v_changes and length\(coalesce\(v_note, ''\)\) < 10/, 'a reclassification after delivery needs a reason');
  assert.match(reclassify, /'after_delivery', cardinality\(v_sent_packs\) > 0,\s*'sent_pack_ids', to_jsonb\(v_sent_packs\)/);
  assert.match(reclassify, /and pack\.status in \('draft', 'generated'\)/, 'sent packs are never changed');
  assert.match(reclassify, /'in_sent_report', exists \(/);
  assert.match(reclassify, /revoke all on function public\.set_report_incident_triage\(uuid, text, text, text, text\) from public, anon, authenticated, service_role;\s*grant execute on function public\.set_report_incident_triage\(uuid, text, text, text, text\) to authenticated;/);
  assert.match(reclassify, /if not public\.is_report_provider_custodian_for_org\(v_pack\.organization_id\)/);

  const view = read('apps/web/src/components/ReportActivityReview.tsx');
  const bob = read('apps/web/src/lib/reportBob.ts');
  assert.match(view, /runIncidentScan\(packId/);
  assert.match(bob, /functions\.invoke\('flag-report-potential-incidents'/);
  assert.match(view, /rpc\('set_report_incident_triage'/);
  assert.match(view, /rpc\('list_report_incident_triage'/);
  const hub = read('apps/web/src/pages/ReportsHubPage.tsx');
  const scan = hub.indexOf('await runIncidentScan(pack.id)');
  const render = hub.indexOf("'generate-report-pack-pdf'");
  assert.ok(scan >= 0 && render > scan, 'Generate preview has Bob check for potential incidents before rendering');
});

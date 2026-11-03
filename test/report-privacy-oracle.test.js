const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const load = () => import('../supabase/functions/_shared/report-privacy-oracle.mjs');
const sections = () => import('../supabase/functions/_shared/report-activity-sections.mjs');

const document = () => ({
  lines: [
    { d: '2026-10-03', p: 'Smiths (OneFortyOne)', k: 'event', c: 'observation', n: 'Jordan Nelson seen at the Smiths gate with a white Ford Ranger FSM780. Call 021 555 0101.' },
    { d: '2026-10-04', p: 'Denckers (OneFortyOne)', k: 'event', c: 'patrol_visit' },
    { d: '2026-10-05', p: 'Donald Creek (OneFortyOne)', k: 'event', c: 'observation', n: 'Jordan Nelson seen at the Smiths gate with a white Ford Ranger FSM780. Call 021 555 0101.' },
    { d: '2026-10-06', p: 'Norris (OneFortyOne)', k: 'event', c: 'maintenance', ti: 'Lock replaced', ac: 'Battery swapped at Norris gate.' },
  ],
});

test('identical wording is read once and only lines with client-facing text are candidates', async () => {
  const { privacyCandidates } = await load();
  const candidates = privacyCandidates(document());
  assert.deepEqual(candidates.map((candidate) => candidate.indexes), [[0, 2], [3]]);
  assert.deepEqual(candidates[1].fields, { ti: 'Lock replaced', ac: 'Battery swapped at Norris gate.' });
});

test('places, the client and the provider are protected, with and without their organisation suffix', async () => {
  const { protectedTerms, privacySystemPrompt } = await load();
  const terms = protectedTerms(document(), ['OneFortyOne New Zealand', 'R&M Security']);
  for (const term of ['Smiths', 'Smiths (OneFortyOne)', 'Donald Creek', 'OneFortyOne New Zealand', 'R&M Security']) assert.ok(terms.includes(term), term);
  assert.match(privacySystemPrompt(terms), /never private individuals: .*Donald Creek/);
});

test('findings are withheld as whole words; plates, places and organisations stay', async () => {
  const { withholdFindings, NAME_WITHHELD, DETAILS_WITHHELD } = await load();
  const terms = ['Smiths', 'Donald Creek', 'OneFortyOne'];
  const value = 'Jordan Nelson seen at the Smiths gate with a white Ford Ranger FSM780. Call 021 555 0101. Nelsonville road clear.';
  const result = withholdFindings(value, { names: ['Jordan', 'Nelson', 'Smiths'], details: ['021 555 0101'] }, terms);
  assert.equal(result, `${NAME_WITHHELD} seen at the Smiths gate with a white Ford Ranger FSM780. Call ${DETAILS_WITHHELD}. Nelsonville road clear.`);
  assert.equal(withholdFindings('Spoke to donald about the gate at Donald Creek.', { names: ['Donald'] }, terms), `Spoke to ${NAME_WITHHELD} about the gate at ${NAME_WITHHELD} Creek.`,
    'a surname that is only part of a block name is still withheld');
  assert.equal(withholdFindings('', { names: ['A B'] }), '');
});

test("Bob's answer must be the requested JSON; entries outside the batch are ignored", async () => {
  const { parsePrivacyFindings } = await load();
  const findings = parsePrivacyFindings('<think>x</think>```json\n{"entries":[{"i":0,"names":["Jordan Nelson"],"details":[]},{"i":"1","names":[],"details":["021 555 0101"]},{"i":7,"names":["Out"]},{"i":2,"names":[]}]}\n```', 3);
  assert.deepEqual([...findings.entries()], [[0, { names: ['Jordan Nelson'], details: [] }], [1, { names: [], details: ['021 555 0101'] }]]);
  assert.throws(() => parsePrivacyFindings('No names here.', 2), /did not return JSON/);
  assert.throws(() => parsePrivacyFindings('{"entries": [}', 2), /malformed JSON/);
  assert.throws(() => parsePrivacyFindings('{"found": []}', 2), /no entries list/);
});

test('reworded lines keep their review key, every checked line is marked, and the pack clears only when wording matches', async () => {
  const { applyPrivacyFindings, privacyStatus, privacyHoldReason, editorialDigest, PRIVACY_VERSION, NAME_WITHHELD } = await load();
  const { activityLineKey } = await sections();
  const before = document();
  const originalKey = activityLineKey(before.lines[0]);
  const checked = [
    { indexes: [0, 2], findings: { names: ['Jordan Nelson'], details: [] } },
    { indexes: [3], findings: null },
  ];
  const { activityLines, reworded } = applyPrivacyFindings(before, checked, ['Smiths']);
  assert.equal(reworded, 2);
  const lines = activityLines.lines;
  assert.match(lines[0].n, new RegExp(`^\\${NAME_WITHHELD} seen at the Smiths gate`));
  assert.equal(lines[0].lk, originalKey);
  assert.equal(activityLineKey(lines[0]), originalKey, 'triage decisions stay attached after rewording');
  assert.equal(lines[3].pv, PRIVACY_VERSION);
  assert.equal(lines[3].lk, undefined);
  assert.equal(before.lines[0].n.startsWith('Jordan'), true, 'the input is not mutated');

  const editorial = { title: 'October report', executive_summary: 'Summary.' };
  assert.deepEqual(privacyStatus(document(), editorial), { pendingLines: 3, editorialChecked: false, cleared: false });
  const checkedPack = { report_kind: 'monthly', activity_lines: { ...activityLines, privacy: { editorial_digest: editorialDigest(editorial) } }, editorial };
  assert.equal(privacyHoldReason(checkedPack), '');
  assert.match(privacyHoldReason({ ...checkedPack, editorial: { ...editorial, executive_summary: 'Edited after the check.' } }), /wording has changed since it was last checked/);
  assert.match(privacyHoldReason({ report_kind: 'monthly', activity_lines: document(), editorial }), /3 entries have not been checked/);
  assert.equal(privacyHoldReason({ report_kind: 'custom', activity_lines: document(), editorial }), '');
  assert.equal(editorialDigest({ title: ' October report ', executive_summary: 'Summary.', client_notes: null }), editorialDigest(editorial), 'trimmed and empty fields do not need a fresh check');
});

test('the PDF and the email refuse wording the oracle has not cleared, and the web runs the oracle before Bob reads and before publishing', () => {
  for (const file of ['supabase/functions/generate-report-pack-pdf/index.ts', 'supabase/functions/send-report-pack/index.ts']) {
    const source = read(file);
    assert.match(source, /import \{ privacyHoldReason \} from '..\/_shared\/report-privacy-oracle.mjs';/, file);
    assert.match(source, /const privacyHold = privacyHoldReason\(pack\);\s*if \(privacyHold\) throw new RequestError\(privacyHold, 409\);/, file);
  }
  const edge = read('supabase/functions/check-report-privacy/index.ts');
  assert.match(edge, /is_report_provider_custodian_for_org/);
  assert.match(edge, /\.in\('status', \['draft', 'generated'\]\)\s*\.eq\('updated_at', pack\.updated_at\)/);
  assert.match(edge, /action: 'report_privacy_checked'/);
  assert.doesNotMatch(edge, /metadata: \{[^}]*names/, 'the audit receipt never stores the withheld words');

  const hub = read('apps/web/src/pages/ReportsHubPage.tsx');
  const order = ['runPrivacyCheck(pack.id)', 'runIncidentScan(pack.id)', 'draftSummaryIfEmpty(pack.id)', 'const recheck = await runPrivacyCheck(pack.id)', "invoke('generate-report-pack-pdf'"].map((needle) => hub.indexOf(needle));
  assert.ok(order.every((index) => index > 0), 'every step is present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'privacy check, incident scan, summary draft, privacy check, render');

  const panel = read('apps/web/src/components/ReportPackReviewPanel.tsx');
  assert.match(panel, /if \(action === 'publish' && pack\.report_kind === 'monthly'\) \{\s*const privacy = await runPrivacyCheck\(pack\.id, \{ editorial: wording \}\);/);
  assert.match(panel, /p_executive_summary: wording\.executive_summary/);
  assert.match(panel, /p_expected_updated_at: expectedUpdatedAt/);
});

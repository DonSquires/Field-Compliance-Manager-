const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const load = () => import('../supabase/functions/_shared/report-executive-summary.mjs');

const report = {
  version: 2,
  totals: { entries: 6, places: 2, patrolVisits: 3, cameraActivations: 1, photos: 2 },
  categories: [{ code: 'patrol_visit', entries: 3 }, { code: 'camera_activation', entries: 1 }],
  pestControl: { entries: 1, bySpecies: [{ code: 'possum', culls: 2 }, { code: 'goat', culls: 1 }] },
  maintenance: { entries: 1 },
  incidents: { total: 1, bySeverity: [{ code: 'high', entries: 1 }] },
  observations: { total: 1 },
  hunterReturns: { returns: 4, animals: 9, bySpecies: [{ species: 'Possum', animals: 7 }] },
  labels: { category: { patrol_visit: 'Patrols and site checks', camera_activation: 'CCTV activity' } },
};
const lines = {
  version: 2,
  lines: [
    { d: '2026-10-01', p: 'Smiths', k: 'event', c: 'patrol_visit' },
    { d: '2026-10-02', p: 'Smiths', k: 'event', c: 'patrol_visit', n: 'Lock would not open despite full battery.', ac: 'Chain cut and temporary lock fitted.' },
    { d: '2026-10-03', p: 'Smiths', k: 'incident', it: 'theft', sev: 'high', st: 'in_review', n: 'Diesel taken from the tank.' },
    { d: '2026-10-04', p: 'Kings Ridge', k: 'event', c: 'camera_activation', n: 'x'.repeat(900) },
    { d: '2026-10-05', p: 'Kings Ridge', k: 'observation', c: 'unclassified', n: 'Roadblock log winched aside.' },
  ],
};
const context = { clientName: 'Forest Co', agreementName: 'Security', period: '2026-10-01 to 2026-10-31' };

test('the brief carries the frozen figures and the non-routine entries only', async () => {
  const { executiveSummaryBrief } = await load();
  assert.equal(executiveSummaryBrief({}, lines, context), null);
  const brief = executiveSummaryBrief({ activityReport: report }, lines, context);
  assert.equal(brief.client, 'Forest Co');
  assert.equal(brief.period, '2026-10-01 to 2026-10-31');
  assert.deepEqual({ ...brief.figures, activityTypes: undefined, incidentsBySeverity: undefined, hunterAnimalsBySpecies: undefined }, {
    locationsWithActivity: 2, entriesRecorded: 6, patrolsAndSiteChecks: 3, cctvActivations: 1, pestControlEntries: 1, pestCulls: 3,
    maintenanceEntries: 1, incidents: 1, observations: 1, photos: 2, hunterReturns: 4, hunterAnimals: 9,
    activityTypes: undefined, incidentsBySeverity: undefined, hunterAnimalsBySpecies: undefined,
  });
  assert.deepEqual(brief.figures.incidentsBySeverity, [{ severity: 'High', count: 1 }]);
  assert.deepEqual(brief.figures.activityTypes[0], { type: 'Patrols and site checks', entries: 3 });
  assert.deepEqual(brief.entries.map((entry) => entry.date), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.deepEqual(brief.entries[0], { date: '2026-10-02', location: 'Smiths', type: 'Patrols and site checks', detail: 'Lock would not open despite full battery.', action: 'Chain cut and temporary lock fitted.' });
  assert.equal(brief.entries[1].severity, 'High');
  assert.ok(brief.entries[2].detail.length <= 600);
  assert.equal(brief.entriesNotIncluded, 0);
});

test('when entries exceed the limit, incidents are kept ahead of routine notes', async () => {
  const { executiveSummaryBrief, BRIEF_ENTRY_LIMIT } = await load();
  const many = { version: 2, lines: [
    ...Array.from({ length: BRIEF_ENTRY_LIMIT + 5 }, (_, index) => ({ d: '2026-10-01', p: 'A', k: 'event', c: 'maintenance', n: `Note ${index}` })),
    { d: '2026-10-30', p: 'B', k: 'incident', it: 'trespass', n: 'Late incident.' },
  ] };
  const brief = executiveSummaryBrief({ activityReport: report }, many, context);
  assert.equal(brief.entries.length, BRIEF_ENTRY_LIMIT);
  assert.equal(brief.entries.at(-1).detail, 'Late incident.');
  assert.equal(brief.entriesNotIncluded, 6);
});

test('the instructions require two plain paragraphs, no storytelling and no named people', async () => {
  const { EXECUTIVE_SUMMARY_INSTRUCTIONS } = await load();
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /exactly two paragraphs/i);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Do not tell a story/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Never name or describe an identifiable person/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Use only facts in the brief/);
});

test('model output is cleaned to two plain paragraphs within the review limit', async () => {
  const { cleanExecutiveSummary, EXECUTIVE_SUMMARY_MAX_CHARS } = await load();
  assert.equal(
    cleanExecutiveSummary('<think>plan</think>## Executive Summary\n\n**Operations** covered 2 sites.\n\n- Diesel was stolen.\n- A lock failed.\n\nRepairs are booked.'),
    'Operations covered 2 sites.\n\nDiesel was stolen. A lock failed. Repairs are booked.',
  );
  const long = cleanExecutiveSummary(`${'One sentence here. '.repeat(400)}\n\nTail.`);
  assert.ok(long.length <= EXECUTIVE_SUMMARY_MAX_CHARS);
  assert.match(long, /\.$/);
  assert.equal(cleanExecutiveSummary(null), '');
});

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PARAGRAPHS = 'During the period 3 patrols and site checks were completed across 2 locations.\n\nDiesel was taken at Smiths and a lock failed.';

test('Ollama Cloud drafts first; OpenAI is used only when it fails', async () => {
  const { draftExecutiveSummary } = await load();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (url.includes('ollama')) return reply({ error: 'down' }, 503);
    return reply({ choices: [{ message: { content: PARAGRAPHS } }] });
  };
  const env = { OLLAMA_API_TOKEN: 'o-token', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5-mini' };
  const draft = await draftExecutiveSummary({ brief: { figures: {} }, env, fetchImpl });
  assert.deepEqual(draft, { summary: PARAGRAPHS, provider: 'openai', model: 'gpt-5-mini' });
  assert.equal(calls[0].url, 'https://ollama.com/api/chat');
  assert.equal(calls[0].body.model, 'gpt-oss:120b');
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].auth, 'Bearer o-token');
  assert.equal(calls[1].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal('temperature' in calls[1].body, false);
  assert.match(calls[1].body.messages[1].content, /Report brief \(JSON\)/);

  const ollama = await draftExecutiveSummary({ brief: {}, env, fetchImpl: async () => reply({ message: { content: PARAGRAPHS } }) });
  assert.equal(ollama.provider, 'ollama_cloud');

  await assert.rejects(draftExecutiveSummary({ brief: {}, env: {}, fetchImpl }), /No drafting model is configured/);
  await assert.rejects(draftExecutiveSummary({ brief: {}, env, fetchImpl: async () => reply({ message: { content: 'Too short.' }, choices: [] }) }), /ollama_cloud: empty draft; openai: empty draft/);
});

test('the edge function and review panel keep drafting governed and unsaved until review', () => {
  const edge = read('supabase/functions/draft-report-executive-summary/index.ts');
  assert.match(edge, /is_report_provider_custodian_for_org/);
  assert.match(edge, /'grand_master', 'master', 'admin', 'admin_officer'/);
  assert.match(edge, /Sent report packs cannot be changed/);
  assert.match(edge, /monthly_report_pack_summary_drafted/);
  assert.doesNotMatch(edge, /\.update\(|\.rpc\('review_monthly_report_pack'/);
  const panel = read('apps/web/src/components/ReportPackReviewPanel.tsx');
  assert.match(panel, /functions\.invoke\('draft-report-executive-summary'/);
  assert.match(panel, /Redraft with Bob/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /it is not saved until you save the draft or publish/);
});

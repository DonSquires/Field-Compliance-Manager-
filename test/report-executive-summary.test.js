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
const context = { clientName: 'Forest Co', agreementName: 'Security', period: '2026-10-01 to 2026-10-31', periodStart: '2026-10-01' };

test('the brief carries this month, the reviewer decisions and the non-routine entries only', async () => {
  const { executiveSummaryBrief } = await load();
  const { activityLineKey } = await import('../supabase/functions/_shared/report-activity-sections.mjs');
  assert.equal(executiveSummaryBrief({}, lines, context), null);
  const triage = [
    { line_key: activityLineKey(lines.lines[1]), bob_flagged: true, bob_incident_type: 'lock_failure', decision: 'incident', incident_type: 'lock_failure' },
    { line_key: activityLineKey(lines.lines[4]), bob_flagged: true, bob_incident_type: 'trespass', decision: 'unreviewed' },
  ];
  const brief = executiveSummaryBrief({ activityReport: report }, lines, { ...context, triage });
  assert.equal(brief.client, 'Forest Co');
  assert.equal(brief.period, '2026-10-01 to 2026-10-31');
  assert.equal(brief.month, 'October 2026');
  assert.equal(brief.figures, undefined);
  assert.deepEqual(brief.thisMonth.cullsAndSightingsBySpecies.map((row) => row.culls), [2, 1]);
  assert.deepEqual(brief.thisMonth.hunterReportedAnimalsBySpecies, [{ species: 'Possum', animals: 7 }]);
  assert.equal(brief.thisMonth.confirmedIncidentsByType.length, 1);
  assert.equal(brief.thisMonth.byWeek[0].incidents, 2);
  assert.equal(brief.thisMonth.byWeek[0].potentialIncidents, 1);
  assert.deepEqual(brief.previousMonths, []);
  assert.deepEqual(brief.entries.map((entry) => entry.date), ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(brief.entries[0].location, 'Smiths');
  assert.equal(brief.entries[0].action, 'Chain cut and temporary lock fitted.');
  assert.match(brief.entries[0].review, /^Confirmed incident on review/);
  assert.match(brief.entries[3].review, /not yet reviewed/);
  assert.equal(brief.entries[1].severity, 'High');
  assert.ok(brief.entries[2].detail.length <= 600);
  assert.equal(brief.entriesNotIncluded, 0);
  assert.equal(brief.entriesNotItemised, 0);
  assert.equal(executiveSummaryBrief({ activityReport: report }, { ...lines, notItemised: 12 }, context).entriesNotItemised, 12);
});

test('prior months without recorded activity are marked as not comparable', async () => {
  const { priorMonthFigures } = await load();
  assert.deepEqual(priorMonthFigures({ months: [
    { month: '2026-08-01', report: { version: 2, totals: { entries: 0 } } },
    { month: '2026-09-01', report: { ...report, totals: { ...report.totals, entries: 4 } }, confirmedIncidents: [{ type: 'theft', count: 2 }] },
  ] }).map((month) => [month.month, month.comparable, month.confirmedIncidentsByType?.[0]?.count]), [
    ['August 2026', false, undefined],
    ['September 2026', true, 2],
  ]);
  assert.deepEqual(priorMonthFigures(null), []);
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

test('the instructions ask for a two-paragraph executive summary of occurrences and trends, without volumes, copying or names', async () => {
  const { EXECUTIVE_SUMMARY_INSTRUCTIONS } = await load();
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /expert corporate security analyst/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /\*\*Executive Summary: <month and year from the brief>\*\*\n\n<paragraph 1>\n\n<paragraph 2>/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Paragraph 1, significant occurrences[\s\S]*commercial theft[\s\S]*perimeter compromise[\s\S]*lock and hardware failures[\s\S]*surveillance tampering/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Paragraph 2, trends[\s\S]*previous two months[\s\S]*pest control[\s\S]*previous two months/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Write a summary, not a copy/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /no bullets/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Do not restate volume statistics/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /never name, initial or otherwise identify a private individual/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /\[name withheld\][\s\S]*must not be reconstructed/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /Use only facts in the brief/);
  assert.match(EXECUTIVE_SUMMARY_INSTRUCTIONS, /entriesNotItemised is above zero[\s\S]*itemised entries only/);
});

test('model output keeps headers, bullets and bold, without reasoning or other markdown', async () => {
  const { cleanExecutiveSummary, finaliseExecutiveSummary, EXECUTIVE_SUMMARY_MAX_CHARS } = await load();
  assert.equal(
    cleanExecutiveSummary('<think>plan</think>```markdown\n## Significant Issues\n\n- **Smiths:** diesel `taken`.\n1. A lock failed.\n\n\n\nRepairs are booked.```'),
    '**Significant Issues**\n\n* **Smiths:** diesel taken.\n* A lock failed.\n\nRepairs are booked.',
  );
  assert.equal(finaliseExecutiveSummary('* A point.', { month: 'October 2026' }), '**Executive Summary: October 2026**\n\n* A point.');
  assert.equal(finaliseExecutiveSummary('**Executive Summary: May**\n\n* A point.', { month: 'October 2026' }), '**Executive Summary: May**\n\n* A point.');
  const long = cleanExecutiveSummary(`${'* One bullet point here.\n'.repeat(400)}`);
  assert.ok(long.length <= EXECUTIVE_SUMMARY_MAX_CHARS);
  assert.match(long, /here\.$/);
  assert.equal(cleanExecutiveSummary(null), '');
});

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PARAGRAPHS = '**Executive Summary: October 2026**\n\nThe period was marked by targeted commercial theft at **Smiths** and repeated electronic lock failures that left perimeter gates exposed.\n\nIncidents concentrated in the second half of the month, above the previous two months, while goat culls fell against September.';

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

  const secondProvider = await draftExecutiveSummary({
    brief: {},
    env,
    fetchImpl: async (url) => url.includes('ollama')
      ? reply({ message: { content: 'One long paragraph with enough detail to exceed the minimum length check. It still needs to be rejected.' } })
      : reply({ choices: [{ message: { content: PARAGRAPHS } }] }),
  });
  assert.equal(secondProvider.provider, 'openai');

  await assert.rejects(draftExecutiveSummary({ brief: {}, env: {}, fetchImpl }), /No drafting model is configured/);
  await assert.rejects(draftExecutiveSummary({ brief: {}, env, fetchImpl: async () => reply({ message: { content: 'Too short.' }, choices: [] }) }), /ollama_cloud: empty draft; openai: empty draft/);
  await assert.rejects(draftExecutiveSummary({
    brief: {},
    env,
    fetchImpl: async (url) => url.includes('ollama')
      ? reply({ message: { content: 'One long paragraph with enough detail to exceed the minimum length check. It still needs to be rejected.' } })
      : reply({ choices: [{ message: { content: 'Another single paragraph. It also exceeds the minimum length check and should be rejected.' } }] }),
  }), /model did not return exactly two paragraphs/);
  await assert.rejects(draftExecutiveSummary({
    brief: {},
    env,
    fetchImpl: async () => reply({ message: { content: `${PARAGRAPHS}\n\nA third paragraph adds closing remarks that the executive summary format does not allow.` }, choices: [{ message: { content: `${PARAGRAPHS}\n\nAnother third paragraph.` } }] }),
  }), /ollama_cloud: model did not return exactly two paragraphs; openai: model did not return exactly two paragraphs/);
  const copied = 'Diesel tank found drained overnight and the padlock on the yard gate had been cut through';
  await assert.rejects(draftExecutiveSummary({
    brief: { entries: [{ date: '2026-10-03', location: 'Smiths', detail: `${copied}.` }] },
    env,
    fetchImpl: async () => reply({ message: { content: `**Executive Summary: October 2026**\n\nAt **Smiths**, ${copied.toLowerCase()}, indicating targeted theft.\n\nIncidents rose against the previous two months while goat culls fell against September.` }, choices: [] }),
  }), /model copied a log entry instead of summarising/);
  const own = await draftExecutiveSummary({
    brief: { entries: [{ date: '2026-10-03', location: 'Smiths', detail: `${copied}.` }] },
    env,
    fetchImpl: async () => reply({ message: { content: PARAGRAPHS } }),
  });
  assert.equal(own.summary, PARAGRAPHS, 'a summary in its own words is accepted');
  await assert.rejects(draftExecutiveSummary({
    brief: {},
    env,
    fetchImpl: async () => reply({ message: { content: '**Executive Summary: October 2026**\n\n* Diesel was taken at Smiths and a lock failed at Denckers this month.\n* Incidents rose against the previous two months across the forest blocks.' }, choices: [{ message: { content: '* Diesel was taken at Smiths and a lock failed at Denckers this month.\n\n* Incidents rose against the previous two months across the forest blocks.' } }] }),
  }), /bullet points instead of two paragraphs/);
});

test('the edge function and review panel keep drafting governed; only an empty draft summary is filled', () => {
  const edge = read('supabase/functions/draft-report-executive-summary/index.ts');
  assert.match(edge, /is_report_provider_custodian_for_org/);
  assert.match(edge, /'grand_master', 'master', 'admin', 'admin_officer'/);
  assert.match(edge, /Sent report packs cannot be changed/);
  assert.match(edge, /monthly_report_pack_summary_drafted/);
  assert.match(edge, /monthly_report_pack_summary_draft_saved/);
  assert.match(edge, /if \(auditError\) throw new RequestError/);
  assert.doesNotMatch(edge, /\.rpc\('review_monthly_report_pack'/);
  assert.equal((edge.match(/\.update\(/g) ?? []).length, 1, 'the only write is the save-if-empty draft');
  assert.match(edge, /saveIfEmpty && \(pack\.status !== 'draft' \|\| hasSummary\)/, 'never overwrites a summary or touches a published pack');
  assert.match(edge, /\.eq\('status', 'draft'\)\s*\.eq\('updated_at', pack\.updated_at\)/, 'the save is optimistic and draft-only');
  const bob = read('apps/web/src/lib/reportBob.ts');
  assert.match(bob, /functions\.invoke\('draft-report-executive-summary', \{ body: \{ pack_id: packId, save_if_empty: true \} \}\)/);
  const hub = read('apps/web/src/pages/ReportsHubPage.tsx');
  assert.match(hub, /if \(pack\.status === 'draft'\) \{[\s\S]*draftSummaryIfEmpty\(pack\.id\)/);
  const panel = read('apps/web/src/components/ReportPackReviewPanel.tsx');
  assert.match(panel, /functions\.invoke\('draft-report-executive-summary'/);
  assert.match(panel, /Redraft with Bob/);
  assert.match(panel, /window\.confirm/);
  assert.match(panel, /it is not saved until you save the draft or publish/);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const load = () => import('../supabase/functions/_shared/report-activity-sections.mjs');

const report = {
  version: 2,
  basis: 'Activity recorded at the locations covered by this agreement.',
  totals: { entries: 9, events: 6, observations: 1, workOrders: 1, incidents: 1, patrolVisits: 4, cameraActivations: 1, withNotes: 4, places: 2, photos: 4 },
  categories: [
    { code: 'incident', entries: 1, photos: 1 },
    { code: 'patrol_visit', entries: 4, photos: 1 },
    { code: 'pest_control', entries: 2, photos: 1 },
    { code: 'maintenance', entries: 1, photos: 0 },
    { code: 'unclassified', entries: 1, photos: 1 },
  ],
  byPlace: [
    { place: 'Alpha Reserve', entries: 8, photos: 4, categories: { patrol_visit: 4, pest_control: 2, incident: 1, unclassified: 1 } },
    { place: 'Not location-specific', entries: 1, photos: 0, categories: { maintenance: 1 } },
  ],
  pestControl: {
    entries: 2,
    bySpecies: [{ code: 'possum', culls: 1, sightings: 0, other: 0, total: 1 }, { code: 'feral_goat', culls: 0, sightings: 1, other: 0, total: 1 }],
    byActivity: [{ code: 'cull', entries: 1 }],
    byEquipment: [{ code: 'bait_station', entries: 1 }],
    ammunition: [{ calibre: '.22', entries: 1, rounds: 3 }, { calibre: 'unspecified', entries: 1, rounds: null }],
  },
  maintenance: { entries: 1, bySubject: [{ code: 'gate', entries: 1 }], workOrders: { completed: 0, open: 1 } },
  manufacture: { entries: 0, bySubject: [], workOrders: { completed: 0, open: 0 } },
  observations: { total: 1, withPhoto: 1, photos: 1, byModule: [{ module: 'unknown', entries: 1, withPhoto: 1, photos: 1 }] },
  incidents: { total: 1, investigations: 1, withMedia: 1, bySeverity: [{ code: 'high', entries: 1 }], byStatus: [{ code: 'in_review', entries: 1 }] },
  labels: {
    category: { incident: 'Incidents', patrol_visit: 'Patrols and site checks', pest_control: 'Pest control', maintenance: 'Maintenance and repairs', unclassified: 'Other site activity' },
    activity: { cull: 'Cull' }, species: { possum: 'Possum' }, subject: { gate: 'Gate' }, equipment: {}, material: { ammunition: 'Ammunition' },
  },
  accountedFor: { eventsInScope: 8, mirrorEventsExcluded: 1, activityEvents: 7, entries: 11, reported: 9, operationalWithheld: 2, withheldTravelAdmin: 1, withheldShiftMarkers: 1, itemised: 8, notItemised: 1, unclassified: 1, reconciled: true },
};

const photo = (name) => ({ b: 'bob-uploads', p: `org/o/rm/photos/${name}.png` });
const lines = {
  version: 2,
  lines: [
    { d: '2026-10-01', t: '09:15', p: 'Alpha Reserve', k: 'event', c: 'pest_control', a: 'cull', sp: 'possum', j: 'J-1001', ti: 'Pest', n: 'Possum dispatched near the toilet block.', ph: 1, pr: [photo('a')], m: [{ t: 'ammunition', cal: '.22', q: 3 }] },
    { d: '2026-10-02', t: '22:40', p: 'Alpha Reserve', k: 'incident', c: 'incident', it: 'cctv_bookmark', sev: 'high', st: 'in_review', n: 'Vehicle entered overnight and damaged the gate.', inv: 'INV-2026-0042', ivs: 'active', ph: 1, pr: [photo('b')], vid: 1 },
    { d: '2026-10-03', t: '07:00', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit' },
    { d: '2026-10-05', t: '07:05', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit' },
    { d: '2026-10-05', t: '18:30', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit', ti: 'Patrol', n: 'Gate found open; closed and locked.', ac: 'Gate found open; closed and locked.', ph: 2, pr: [photo('c'), { b: 'bob-uploads', p: 'https://example.test/x.png' }] },
    { d: '2026-10-06', t: '12:00', p: 'Alpha Reserve', k: 'event', c: 'patrol_visit', ti: 'Check', n: 'Freedom campers spoken to and moved on.' },
    { d: '2026-10-07', t: '10:10', p: 'Alpha Reserve', k: 'observation', c: 'unclassified', mo: 'unknown', n: 'Rubbish dumped by the bins.', ph: 1, pr: [photo('d')] },
    { d: '2026-10-15', k: 'work_order', c: 'maintenance', ti: 'Replace gate latch', ws: 'in_progress', j: 'WO-1' },
  ],
  notItemised: 1,
};

const tables = (blocks) => blocks.filter((block) => block.kind === 'table');
const allText = (blocks) => JSON.stringify(blocks);
const FORBIDDEN = /\bkm\b|kilomet|travel|\bhours?\b|reconcil|import|mirror|snapshot|spreadsheet|ledger|withheld|unclassified|patrol_visit|work_order|cctv_bookmark|in_review/i;

test('packs without a v2 client activity report keep the legacy layout', async () => {
  const { monthlyActivityBlocks, siteLogBlocks, activityEmailSummary, readActivityLines } = await load();
  for (const data of [{}, null, { activityReport: { ...report, version: 1 } }, { activityReport: { version: 2 } }]) {
    assert.equal(monthlyActivityBlocks(data, lines), null);
    assert.deepEqual(siteLogBlocks(data, lines), []);
    assert.equal(activityEmailSummary(data), null);
  }
  assert.deepEqual(readActivityLines({ ...lines, version: 1 }), { lines: [], notItemised: 0 });
});

test('client summary sections use plain language and carry no operational or system detail', async () => {
  const { monthlyActivityBlocks } = await load();
  const blocks = monthlyActivityBlocks({ activityReport: report }, lines);
  const titles = blocks.filter((block) => block.kind === 'section').map((block) => block.title);
  assert.deepEqual(titles, ['Summary', 'At a Glance', 'Of Note', 'Activity Overview', 'Activity by Location', 'Pest Control', 'Maintenance and Repairs', 'Manufacture and Fabrication', 'Observations']);
  for (const block of tables(blocks)) {
    assert.equal(block.columns.reduce((sum, column) => sum + column.width, 0), 487, `${block.columns[0].label} spans the page`);
    for (const row of block.rows) assert.equal(row.length, block.columns.length);
  }
  const metrics = blocks.find((block) => block.kind === 'metrics');
  assert.deepEqual(metrics.items.map((item) => item.label), ['Locations with activity', 'Entries recorded', 'Incidents', 'Observations', 'Patrols', 'CCTV activity', 'Photos', 'Pest culls recorded']);
  assert.equal(metrics.items.find((item) => item.label === 'Pest culls recorded').value, '1');
  const charts = blocks.find((block) => block.kind === 'charts');
  assert.deepEqual(charts.charts.map((chart) => chart.title), ['Activity type highlights', 'Top locations', 'Pest culls by species']);
  assert.deepEqual(charts.charts[0].items[0], { label: 'Patrols and site checks', value: 4 });
  assert.deepEqual(charts.charts[1].items[0], { label: 'Alpha Reserve', value: 8 });
  assert.deepEqual(charts.charts[2].items[0], { label: 'Possum', value: 1 });
  assert.ok(blocks.indexOf(charts) < blocks.findIndex((block) => block.kind === 'section' && block.title === 'Activity Overview'));
  const withHunters = monthlyActivityBlocks({ activityReport: {
    ...report,
    hunterReturns: { animals: 15, bySpecies: [{ species: 'Possum', animals: 12 }, { species: 'Goat', animals: 3 }] },
  } }, lines);
  assert.deepEqual(withHunters.find((block) => block.kind === 'charts').charts.at(-1), {
    title: 'Hunter animals by species',
    items: [{ label: 'Possum', value: 12 }, { label: 'Goat', value: 3 }],
  });

  const text = allText(blocks);
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, /accountedFor|eventsInScope|Not yet classified/);
  assert.match(text, /"Patrols and site checks","4","1"/);
  assert.match(text, /"Alpha Reserve","8","4","Patrols and site checks 4, Pest control 2, Incidents 1"/);
  assert.match(text, /"Feral goat","0","1","0","1"/);
  assert.match(text, /"Calibre not recorded","1","Not recorded"/);
  assert.match(text, /Workshop jobs: 0 completed, 1 scheduled or in progress\./);
  assert.match(text, /No manufacture or fabrication work was recorded/);
  assert.match(text, /"General","1","1","1"/);
  assert.doesNotMatch(text, /\b1 pest-control entries\b|\b1 incidents were\b/);
});

test('incidents are itemised with investigation reference and status, never investigation detail', async () => {
  const { monthlyActivityBlocks } = await load();
  const blocks = monthlyActivityBlocks({ activityReport: report }, lines);
  const text = allText(blocks);
  assert.match(text, /1 incident was recorded at your locations; 1 investigation is linked; 1 with photo or video evidence\./);
  assert.match(text, /Severity: High 1   \|   Status: Under review 1/);
  const incidents = blocks.filter((block) => block.kind === 'entry' && block.tone === 'incident');
  assert.equal(incidents.length, 1);
  const [incident] = incidents;
  assert.equal(incident.tone, 'incident');
  assert.equal(incident.title, 'CCTV review');
  assert.equal(incident.when, 'Fri 2 Oct 2026 · 22:40');
  assert.deepEqual(incident.tags, ['Alpha Reserve', 'High severity', 'Under review']);
  assert.deepEqual(incident.lines, [
    { text: 'Vehicle entered overnight and damaged the gate.' },
    { label: 'Investigation', text: 'INV-2026-0042 · Active' },
    { label: 'Video', text: '1 video clip held on file' },
  ]);
  assert.deepEqual(incident.photos, [photo('b')]);

  const quiet = monthlyActivityBlocks({ activityReport: { ...report, incidents: { total: 0, investigations: 0, withMedia: 0, bySeverity: [], byStatus: [] } } }, lines);
  assert.match(allText(quiet), /No incidents were recorded at your locations during the period\./);
  const unlisted = monthlyActivityBlocks({ activityReport: { ...report, incidents: { ...report.incidents, total: 3 } } }, lines);
  assert.match(allText(unlisted), /2 further incidents are held on file\./);
});

test('the summary leads with the reviewer text, the period in figures and selected photos, then what is of note', async () => {
  const { monthlyActivityBlocks, summaryParagraphs, OF_NOTE_LIMIT } = await load();
  const blocks = monthlyActivityBlocks({ activityReport: report }, lines, { summary: 'A quiet month overall.', highlights: '  ' });
  const sectionAt = (title) => blocks.findIndex((block) => block.kind === 'section' && block.title === title);
  const summary = blocks.slice(sectionAt('Summary') + 1, sectionAt('At a Glance'));
  assert.deepEqual(summary.filter((block) => block.kind === 'text').map((block) => block.text), [
    'A quiet month overall.',
    '9 entries were recorded across 2 locations during the period. The most active location was Alpha Reserve with 8 entries.',
    'Work included 4 patrols and site checks, 1 CCTV activation, 1 pest cull and 1 maintenance entry.',
    '1 incident was recorded, 1 of high or critical severity. 1 observation was logged, 1 with photos. The entries that stand out are listed under Of Note.',
    'Selected photos from the period. Each is shown again with its entry.',
  ]);
  const gallery = summary.find((block) => block.kind === 'gallery');
  assert.deepEqual(gallery.photos.map((photo) => [photo.ref.p.split('/').at(-1), photo.caption]), [
    ['b.png', '2 Oct · Alpha Reserve · CCTV review'],
    ['d.png', '7 Oct · Alpha Reserve · Other site activity'],
    ['a.png', '1 Oct · Alpha Reserve · Pest control'],
    ['c.png', '5 Oct · Alpha Reserve · Patrols and site checks'],
  ]);

  const ofNote = blocks.slice(sectionAt('Of Note') + 1, sectionAt('Activity Overview'));
  assert.deepEqual(ofNote.filter((block) => block.kind === 'subsection').map((block) => [block.title, block.detail]), [
    ['Incidents and investigations', '1 incident'],
    ['Observations, CCTV and photographed work', '3 entries'],
  ]);
  const notable = ofNote.filter((block) => block.kind === 'entry' && block.tone === 'default');
  assert.deepEqual(notable.map((entry) => entry.when), ['Thu 1 Oct 2026 · 09:15', 'Mon 5 Oct 2026 · 18:30', 'Wed 7 Oct 2026 · 10:10']);
  assert.ok(notable.every((entry) => entry.tags[0] === 'Alpha Reserve'));
  assert.doesNotMatch(allText(blocks), FORBIDDEN);

  const many = { version: 2, notItemised: 0, lines: Array.from({ length: OF_NOTE_LIMIT + 3 }, (_, index) => ({ d: '2026-10-09', t: `${String(index).padStart(2, '0')}:00`, p: 'Beta Forest', k: 'observation', c: 'unclassified', n: `Seen ${index}` })) };
  const capped = monthlyActivityBlocks({ activityReport: report }, many);
  assert.equal(capped.filter((block) => block.kind === 'entry').length, OF_NOTE_LIMIT);
  assert.match(allText(capped), /3 further entries are in the site log\./);

  const privileged = { ...lines, lines: lines.lines.map((line) => (line.pr ? { ...line, pr: [{ b: 'bob-uploads', p: 'org/o/rm/photos/NZTA_camera.png' }] } : line)) };
  const hidden = monthlyActivityBlocks({ activityReport: report }, privileged);
  assert.equal(hidden.some((block) => block.kind === 'gallery'), false);
  assert.doesNotMatch(allText(hidden), /NZTA/);

  assert.deepEqual(summaryParagraphs({ ...report, totals: { ...report.totals, entries: 0 } }, []), ['Nothing was recorded at your locations during the period.']);
  assert.deepEqual(summaryParagraphs({ ...report, totals: { ...report.totals, entries: 0 }, hunterReturns: { returns: 2, animals: 5, bySpecies: [] } }, []), [
    'Nothing was recorded at your locations during the period.',
    'Permit holders submitted 2 hunter returns reporting 5 animals.',
  ]);
  const burst = { version: 2, notItemised: 0, lines: [{ d: '2026-10-03', t: '08:00', p: 'Beta Forest', k: 'observation', c: 'unclassified', n: 'Dumped rubbish', ph: 8, pr: Array.from({ length: 8 }, (_, index) => ({ b: 'scans', p: `org/burst/${index}.jpg` })) }] };
  const burstGallery = monthlyActivityBlocks({ activityReport: report }, burst).find((block) => block.kind === 'gallery');
  assert.equal(burstGallery.photos.length, 6);
  const noLines = monthlyActivityBlocks({ activityReport: report }, null);
  assert.match(allText(noLines), /Itemised entries are not available for this report\./);
});

test('the site log groups entries by location with comments, actions and photos, and folds routine patrols', async () => {
  const { siteLogBlocks, isRoutineLine } = await load();
  const blocks = siteLogBlocks({ activityReport: report }, lines);
  assert.doesNotMatch(allText(blocks), FORBIDDEN);
  assert.deepEqual(blocks.filter((block) => block.kind === 'subsection').map((block) => [block.title, block.detail]), [
    ['Alpha Reserve', '6 entries'],
    ['Not location-specific', '1 entry'],
  ]);
  const entries = blocks.filter((block) => block.kind === 'entry');
  assert.equal(entries.length, 5, 'the incident and two routine patrols are not repeated as entries');
  assert.ok(entries.every((entry) => entry.tone === 'default'));

  const [pest, gate, campers, rubbish, workOrder] = entries;
  assert.equal(pest.when, 'Thu 1 Oct 2026 · 09:15');
  assert.equal(pest.title, 'Cull · Possum');
  assert.deepEqual(pest.tags, ['Pest control', 'Ref J-1001'], 'a short label that repeats the category is not tagged');
  assert.deepEqual(pest.lines, [{ text: 'Possum dispatched near the toilet block.' }, { label: 'Used', text: 'Ammunition .22 × 3' }]);
  assert.deepEqual(pest.photos, [photo('a')]);

  assert.deepEqual(gate.lines, [{ text: 'Gate found open; closed and locked.' }], 'an action that repeats the comment is not printed twice');
  assert.deepEqual(gate.photos, [photo('c')], 'external links are never fetched into the report');
  assert.equal(gate.photoCount, 2);
  assert.deepEqual(campers.tags, ['Patrols and site checks', 'Check']);
  assert.deepEqual(rubbish.tags, ['Other site activity', 'General observation']);
  assert.equal(workOrder.title, 'Replace gate latch');
  assert.deepEqual(workOrder.tags, ['Maintenance and repairs', 'In progress', 'Ref WO-1']);

  const routine = blocks.find((block) => block.kind === 'text' && /routine patrols/.test(block.text));
  assert.equal(routine.text, '2 routine patrols with nothing further to report (3, 5 Oct).');
  assert.match(allText(blocks), /A further 1 entry from this period is included in the totals above and held on file\./);
  assert.equal(isRoutineLine(lines.lines[2]), true);
  assert.equal(isRoutineLine(lines.lines[5]), false);

  assert.match(allText(siteLogBlocks({ activityReport: report }, null)), /The itemised site log is not available for this report\./);
  const empty = { ...report, totals: { ...report.totals, entries: 0 } };
  assert.match(allText(siteLogBlocks({ activityReport: empty }, { version: 2, lines: [], notItemised: 0 })), /Nothing was recorded at your locations during the period\./);
});

test('the client email summary is a headline and entries by type of activity', async () => {
  const { activityEmailSummary } = await load();
  const email = activityEmailSummary({ activityReport: report });
  assert.equal(email.headline, '9 entries recorded across 2 locations, including 1 incident, 1 observation and 4 photos.');
  assert.deepEqual(email.categories[1], ['Patrols and site checks', '4']);
  assert.ok(email.categories.every((row) => row.length === 2));
  assert.doesNotMatch(JSON.stringify(email), FORBIDDEN);
  const single = { ...report, totals: { ...report.totals, entries: 1, places: 1, incidents: 0, observations: 0, photos: 1 } };
  assert.equal(activityEmailSummary({ activityReport: single }).headline, '1 entry recorded across 1 location, including 0 incidents, 0 observations and 1 photo.');
});

test('PDF, send gate and every web surface agree on the current renderer version', () => {
  const version = (source, pattern) => source.match(pattern)?.[1];
  const pdf = version(read('supabase/functions/generate-report-pack-pdf/index.ts'), /const rendererVersion = '([^']+)'/);
  const send = version(read('supabase/functions/send-report-pack/index.ts'), /const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  const web = version(read('apps/web/src/lib/reportPackRenderer.ts'), /export const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  assert.equal(pdf, 'fcm-report-pack-pdf-lib-a4-v15');
  assert.equal(send, pdf);
  assert.equal(web, pdf);
  for (const surface of ['apps/web/src/pages/ReportsHubPage.tsx', 'apps/web/src/pages/ClientPortalPage.tsx', 'apps/web/src/components/CrmAccountWorkspace.tsx']) {
    const source = read(surface);
    assert.doesNotMatch(source, /fcm-report-pack-pdf-lib-a4-v\d+/, `${surface} must use the shared renderer constant`);
    assert.match(source, /from '\.\.\/lib\/reportPackRenderer'/);
  }
});

test('monthly PDF and email read the itemised lines only for the pack they render', () => {
  const pdf = read('supabase/functions/generate-report-pack-pdf/index.ts');
  assert.match(pdf, /select\('id,organization_id,[^']*activity_lines[^']*'\)\.eq\('id', packId\)\.single\(\)/);
  assert.match(pdf, /monthlyActivityBlocks\(snapshot, activityLines, \{ summary: editorial\.executive_summary, highlights: editorial\.client_notes \}\)/);
  assert.match(pdf, /siteLogBlocks\(snapshot, activityLines\)/);
  const send = read('supabase/functions/send-report-pack/index.ts');
  assert.match(send, /activityEmailSummary\(d\)/);
  const monthlyEmail = send.slice(send.indexOf('function monthlySummaryHtml'), send.indexOf('function summaryHtml'));
  assert.doesNotMatch(monthlyEmail, /patrolTravelKm|Hours|reconcile/);
  for (const listSurface of ['apps/web/src/pages/ReportsHubPage.tsx', 'apps/web/src/pages/ClientPortalPage.tsx', 'apps/web/src/components/CrmAccountWorkspace.tsx']) {
    assert.doesNotMatch(read(listSurface), /\.select\('[^']*activity_lines/, `${listSurface} list query must not carry itemised lines`);
  }
});

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

test('the compact client report keeps incidents, reviews, work and pest figures, without day-to-day tables', async () => {
  const { monthlyActivityBlocks } = await load();
  const blocks = monthlyActivityBlocks({ activityReport: report }, lines);
  const titles = blocks.filter((block) => block.kind === 'section').map((block) => block.title);
  assert.deepEqual(titles, ['At a Glance', 'Incidents and Investigations', 'Observations', 'Maintenance and Repairs', 'Pest Control']);
  assert.equal(blocks.some((block) => block.kind === 'gallery'), false, 'photos stay with their entries, never in a gallery at the top');
  for (const block of tables(blocks)) {
    assert.equal(block.columns.reduce((sum, column) => sum + column.width, 0), 487, `${block.columns[0].label} spans the page`);
    for (const row of block.rows) assert.equal(row.length, block.columns.length);
  }
  const metrics = blocks.find((block) => block.kind === 'metrics');
  assert.deepEqual(metrics.items.map((item) => item.label), ['Locations with activity', 'Entries recorded', 'Incidents', 'Observations', 'Patrols', 'Photos', 'Pest culls recorded']);
  assert.equal(metrics.items.find((item) => item.label === 'Observations').value, '2', 'camera card reviews count as observations');
  assert.equal(metrics.items.find((item) => item.label === 'Pest culls recorded').value, '1');
  const charts = blocks.find((block) => block.kind === 'charts');
  assert.deepEqual(charts.charts.map((chart) => chart.title), ['Activity type highlights', 'Top locations', 'Pest culls by species']);
  assert.deepEqual(charts.charts[0].items[0], { label: 'Patrols and site checks', value: 4 });
  assert.deepEqual(charts.charts[1].items[0], { label: 'Alpha Reserve', value: 8 });
  assert.deepEqual(charts.charts[2].items[0], { label: 'Possum', value: 1 });
  assert.ok(blocks.indexOf(charts) < blocks.findIndex((block) => block.kind === 'section' && block.title === 'Incidents and Investigations'));
  const areas = Array.from({ length: 14 }, (_, index) => ({ area: `Area ${index + 1}`, returns: 2, kill: 1, nil: 1, animals: index }));
  const withHunters = monthlyActivityBlocks({ activityReport: {
    ...report,
    hunterReturns: { returns: 28, killReturns: 14, nilReturns: 14, animals: 15, bySpecies: [{ species: 'Possum', animals: 12 }, { species: 'Goat', animals: 3 }], byArea: areas },
  } }, lines);
  assert.deepEqual(withHunters.find((block) => block.kind === 'charts').charts.at(-1), {
    title: 'Hunter animals by species',
    items: [{ label: 'Possum', value: 12 }, { label: 'Goat', value: 3 }],
  });
  const areaTable = tables(withHunters).find((block) => block.columns[0].label === 'Hunting area');
  assert.deepEqual(areaTable.rows.map((row) => row[0]), ['Area 14', 'Area 13', 'Area 12', 'Area 11', 'Area 10', 'Area 9', 'Area 8', 'Area 7', 'Area 6', 'Area 5']);
  assert.match(allText(withHunters), /Top 10 of 14 hunting areas by animals reported\./);

  const text = allText(blocks);
  assert.doesNotMatch(text, FORBIDDEN);
  assert.doesNotMatch(text, /accountedFor|eventsInScope|Not yet classified/);
  assert.match(text, /"Feral goat","0","1","0","1"/);
  assert.doesNotMatch(text, /Activity by Location|Activity Overview|Main activity|Calibre|Bait station|Manufacture|Observation type/);
  assert.match(text, /2 routine patrols and checks recorded a status only \(for example secure or working\) and are not itemised in this report\./);
  assert.match(text, /Workshop jobs: 0 completed, 1 scheduled or in progress\./);
  const at = (title) => blocks.findIndex((block) => block.kind === 'section' && block.title === title);
  const work = blocks.slice(at('Maintenance and Repairs') + 1, at('Pest Control')).filter((block) => block.kind === 'entry');
  assert.deepEqual(work.map((entry) => entry.title), ['Replace gate latch'], 'maintenance is itemised, not just counted');
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

test('the executive summary is the reviewer text as headings, bullets and paragraphs, then highlights, with no photo gallery', async () => {
  const { monthlyActivityBlocks } = await load();
  const sectionAt = (blocks, title) => blocks.findIndex((block) => block.kind === 'section' && block.title === title);
  const opening = (blocks) => blocks.slice(0, sectionAt(blocks, 'At a Glance'));
  const runsText = (block) => block.runs.map((run) => run.text).join('');

  const written = monthlyActivityBlocks({ activityReport: report }, lines, {
    summary: '**Executive Summary: October 2026**\n\n**Significant Security Breaches & Critical Infrastructure Issues**\n* **Perimeter Compromise & Trespass:** a gate at **Alpha Reserve** was damaged.\n\nRepairs are booked.',
    highlights: 'Gate repair is booked.',
  });
  const head = opening(written);
  assert.equal(head[0].title, 'Executive Summary');
  const rich = head.filter((block) => block.kind === 'rich');
  assert.deepEqual(rich.map((block) => [block.style, runsText(block)]), [
    ['heading', 'Significant Security Breaches & Critical Infrastructure Issues'],
    ['bullet', 'Perimeter Compromise & Trespass: a gate at Alpha Reserve was damaged.'],
    ['paragraph', 'Repairs are booked.'],
    ['paragraph', 'Gate repair is booked.'],
  ]);
  assert.deepEqual(rich[1].runs.filter((run) => run.bold).map((run) => run.text), ['Perimeter Compromise & Trespass:', 'Alpha Reserve']);
  assert.equal(written.some((block) => block.kind === 'gallery'), false);

  const blocks = monthlyActivityBlocks({ activityReport: report }, lines, { summary: '   ', highlights: '  ' });
  assert.deepEqual(opening(blocks), [], 'nothing precedes At a Glance when no summary is written');
  assert.doesNotMatch(allText(blocks), /Of Note|of note|Selected Photos/);
  const incidents = blocks.slice(sectionAt(blocks, 'Incidents and Investigations') + 1, sectionAt(blocks, 'Observations'));
  assert.deepEqual(incidents.filter((block) => block.kind === 'entry').map((entry) => [entry.tone, entry.tags[0]]), [['incident', 'Alpha Reserve']]);
  assert.deepEqual(incidents.find((block) => block.kind === 'entry').photos, [photo('b')], 'the photo is shown with its incident');
  assert.ok(sectionAt(blocks, 'At a Glance') < sectionAt(blocks, 'Incidents and Investigations'));
  assert.doesNotMatch(allText(blocks), FORBIDDEN);

  const privileged = { ...lines, lines: lines.lines.map((line) => (line.pr ? { ...line, pr: [{ b: 'bob-uploads', p: 'org/o/rm/photos/NZTA_camera.png' }] } : line)) };
  const hidden = monthlyActivityBlocks({ activityReport: report }, privileged);
  assert.doesNotMatch(allText(hidden), /NZTA/);
});

test('line keys are stable content hashes and confirmed entries move from the site log to Incidents', async () => {
  const { activityLineKey, applyIncidentTriage, isIncidentLine, monthlyActivityBlocks, siteLogBlocks } = await load();
  assert.equal(activityLineKey({ d: '2026-10-14', t: '09:30', p: 'Smiths', k: 'event', c: 'patrol_visit', ti: '', n: 'Gate chain cut, log winched aside', ac: 'Reported' }), 'v1:0fe9500921b782');
  assert.equal(activityLineKey({}), 'v1:15202279b28c9e');
  assert.equal(activityLineKey({ d: ' 2026-10-14 ', n: 'x', ph: 3 }), activityLineKey({ d: '2026-10-14', n: 'x' }), 'whitespace and photo counts do not change the key');
  assert.equal(activityLineKey({ n: 'x', d: '2026-10-14', vid: 1, pr: [{ b: 'scans', p: 'a.jpg' }] }), activityLineKey({ d: '2026-10-14', n: 'x' }), 'field order and media do not change the key');
  assert.notEqual(activityLineKey({ d: '2026-10-14', c: 'pest_control', sp: 'goat' }), activityLineKey({ d: '2026-10-14', c: 'pest_control', sp: 'pig' }), 'every content field distinguishes entries');
  assert.notEqual(activityLineKey(lines.lines[5]), activityLineKey(lines.lines[4]));

  const campers = lines.lines[5];
  assert.equal(applyIncidentTriage(lines, []), lines);
  assert.equal(applyIncidentTriage(lines, [{ line_key: activityLineKey(campers), decision: 'not_incident' }]), lines);
  const triaged = applyIncidentTriage(lines, [
    { line_key: activityLineKey(campers), decision: 'incident', incident_type: 'trespass' },
    { line_key: activityLineKey(lines.lines[1]), decision: 'incident', incident_type: 'theft' },
  ]);
  assert.equal(triaged.lines[5].tri, 'trespass');
  assert.equal(triaged.lines[1].tri, undefined, 'recorded incidents keep their own type');
  assert.equal(isIncidentLine(triaged.lines[5]), true);
  assert.equal(isIncidentLine(lines.lines[5]), false);

  const blocks = monthlyActivityBlocks({ activityReport: report }, triaged);
  const sectionAt = (title) => blocks.findIndex((block) => block.kind === 'section' && block.title === title);
  const incidentEntries = blocks.slice(sectionAt('Incidents and Investigations') + 1, sectionAt('Observations')).filter((block) => block.kind === 'entry');
  assert.equal(incidentEntries.length, 2);
  assert.match(allText(incidentEntries), /Freedom campers spoken to and moved on\./);
  assert.match(allText(incidentEntries), /Trespass/);
  assert.equal(blocks.find((block) => block.kind === 'metrics').items.find((item) => item.label === 'Incidents').value, '2');
  assert.doesNotMatch(allText(siteLogBlocks({ activityReport: report }, triaged)), /Freedom campers/);
});
test('the site log groups entries by location with comments, actions and photos, and leaves routine checks to the summary', async () => {
  const { siteLogBlocks, isRoutineLine, isRoutineCheck } = await load();
  const blocks = siteLogBlocks({ activityReport: report }, lines);
  assert.doesNotMatch(allText(blocks), FORBIDDEN);
  assert.deepEqual(blocks.filter((block) => block.kind === 'subsection').map((block) => [block.title, block.detail]), [
    ['Alpha Reserve', '3 entries'],
    ['Not location-specific', '1 entry'],
  ]);
  const entries = blocks.filter((block) => block.kind === 'entry');
  assert.equal(entries.length, 4, 'the incident, the observation and two routine patrols are not listed');
  assert.ok(entries.every((entry) => entry.tone === 'default'));

  const [pest, gate, campers, workOrder] = entries;
  assert.equal(pest.when, 'Thu 1 Oct 2026 · 09:15');
  assert.equal(pest.title, 'Cull · Possum');
  assert.deepEqual(pest.tags, ['Pest control', 'Ref J-1001'], 'a short label that repeats the category is not tagged');
  assert.deepEqual(pest.lines, [{ text: 'Possum dispatched near the toilet block.' }, { label: 'Used', text: 'Ammunition .22 × 3' }]);
  assert.deepEqual(pest.photos, [photo('a')]);

  assert.deepEqual(gate.lines, [{ text: 'Gate found open; closed and locked.' }], 'an action that repeats the comment is not printed twice');
  assert.deepEqual(gate.photos, [photo('c')], 'external links are never fetched into the report');
  assert.equal(gate.photoCount, 2);
  assert.deepEqual(campers.tags, ['Patrols and site checks', 'Check']);
  assert.equal(workOrder.title, 'Replace gate latch');
  assert.deepEqual(workOrder.tags, ['Maintenance and repairs', 'In progress', 'Ref WO-1']);

  assert.doesNotMatch(allText(blocks), /routine patrol/);
  assert.match(allText(blocks), /routine checks are summarised under Routine Checks/);
  assert.match(allText(blocks), /A further 1 entry from this period is included in the totals above and held on file\./);
  assert.equal(isRoutineLine(lines.lines[2]), true);
  assert.equal(isRoutineLine(lines.lines[5]), false);
  assert.equal(isRoutineCheck(lines.lines[2]), true);
  assert.equal(isRoutineCheck(lines.lines[4]), false, 'an action or photo keeps a check listed');
  assert.equal(isRoutineCheck(lines.lines[5]), false, 'a written description keeps a check listed');

  assert.match(allText(siteLogBlocks({ activityReport: report }, null)), /The itemised site log is not available for this report\./);
  const empty = { ...report, totals: { ...report.totals, entries: 0 } };
  assert.match(allText(siteLogBlocks({ activityReport: empty }, { version: 2, lines: [], notItemised: 0 })), /Nothing was recorded at your locations during the period\./);
});

test('short status-only gate, lock and patrol checks are summarised under Routine Checks with their results', async () => {
  const { monthlyActivityBlocks, siteLogBlocks, isRoutineCheck, routineCheckRows } = await load();
  const labelled = { ...report, labels: { ...report.labels, category: { ...report.labels.category, inspection: 'Inspections' }, subject: { gate: 'Gate', electronic_lock: 'Electronic lock' } } };
  const check = (d, p, s, n, extra = {}) => ({ d, t: '08:00', p, k: 'event', c: 'inspection', a: 'inspection', s, n, ...extra });
  const checks = {
    version: 2,
    notItemised: 0,
    lines: [
      check('2026-10-01', 'Alpha Reserve', 'gate', 'Secure'),
      check('2026-10-02', 'Alpha Reserve', 'gate', 'Secure.'),
      check('2026-10-02', 'Beta Forest', 'gate', 'secure'),
      check('2026-10-03', 'Beta Forest', 'gate', 'Live'),
      check('2026-10-03', 'Beta Forest', 'gate', 'Provide access - no lock'),
      check('2026-10-04', 'Beta Forest', 'gate', 'Closed but not locked.'),
      check('2026-10-04', 'Beta Forest', 'gate', 'Nil vehicles.'),
      check('2026-10-04', 'Beta Forest', 'gate', ''),
      check('2026-10-05', 'Beta Forest', 'electronic_lock', 'Working'),
      check('2026-10-06', 'Beta Forest', 'gate', 'Gate closed but large log beside gate freshly pulled out'),
      check('2026-10-06', 'Beta Forest', 'electronic_lock', 'Working', { ac: 'Battery replaced' }),
      check('2026-10-07', 'Beta Forest', 'gate', 'Secure', { tri: 'trespass' }),
    ],
  };
  assert.deepEqual(checks.lines.map(isRoutineCheck), [true, true, true, true, true, true, true, true, true, false, false, false]);
  const label = (dim, value) => labelled.labels[dim]?.[value] || String(value);
  assert.deepEqual(routineCheckRows(checks.lines, label), [
    { check: 'Inspections · Gate', checks: 8, places: 2, results: 'Secure 3 · Closed but not locked 1 · Live 1 · Nil vehicles 1 · other 2' },
    { check: 'Inspections · Electronic lock', checks: 1, places: 1, results: 'Working 1' },
  ]);

  const blocks = monthlyActivityBlocks({ activityReport: labelled }, checks);
  assert.equal(blocks.some((block) => block.kind === 'section' && block.title === 'Routine Checks'), false, 'the client report gives routine checks one line');
  assert.ok(blocks.some((block) => block.kind === 'text' && /^9 routine patrols and checks recorded a status only/.test(block.text)));

  const log = siteLogBlocks({ activityReport: labelled }, checks);
  const logged = log.filter((block) => block.kind === 'entry');
  assert.equal(logged.length, 2, 'only the described log and the battery action are listed; the confirmed incident has its own section');
  assert.match(allText(logged), /freshly pulled out/);
  assert.match(allText(logged), /Battery replaced/);
  assert.deepEqual(log.filter((block) => block.kind === 'subsection').map((block) => block.title), ['Beta Forest'], 'a location with only routine checks has no site log heading');
});

test('card reviews are observations listed with their photos, and administration is left out of the report', async () => {
  const { monthlyActivityBlocks, siteLogBlocks, reviewSectionCode, readActivityLines, isAdministrationLine } = await load();
  const labelled = { ...report, labels: { ...report.labels, category: { ...report.labels.category, camera_activation: 'CCTV and camera activity', administration: 'Administration and review' } } };
  const desk = {
    version: 2,
    notItemised: 0,
    lines: [
      ...lines.lines,
      { d: '2026-10-08', t: '00:00', p: 'General / All Forests (Admin, HQ, Travel)', k: 'event', c: 'administration', n: 'Monthly hunter permits reconciled with the client.' },
      { d: '2026-10-09', t: '14:20', p: 'Serpentine', k: 'event', c: 'camera_activation', ti: 'Card review', n: 'Camera activation gate. A ute passes the gate at 02:14.', ph: 1, pr: [photo('e')] },
      { d: '2026-10-10', t: '15:00', p: 'Serpentine', k: 'event', c: 'camera_activation', tri: 'theft', n: 'Card shows the fuel tank being drained.' },
      { d: '2026-10-11', t: '16:22', p: 'Inwoods', k: 'event', c: 'other_work', ti: 'Card review', n: 'Replace card' },
    ],
  };
  assert.equal(isAdministrationLine(desk.lines[8]), true);
  assert.equal(isAdministrationLine({ ...desk.lines[8], tri: 'theft' }), false, 'an entry confirmed as an incident is always reported');
  assert.equal(readActivityLines(desk).lines.length, desk.lines.length - 1, 'administration entries are never read into the report');
  assert.equal(reviewSectionCode(desk.lines[6]), 'observation');
  assert.equal(reviewSectionCode(desk.lines[9]), 'observation');
  assert.equal(reviewSectionCode(desk.lines[11]), 'observation', 'every card review is an observation, whatever its comment');
  assert.equal(reviewSectionCode(desk.lines[10]), '', 'a confirmed incident stays with the incidents');

  const blocks = monthlyActivityBlocks({ activityReport: labelled }, desk);
  const titles = blocks.filter((block) => block.kind === 'section').map((block) => block.title);
  const at = (title) => titles.indexOf(title);
  assert.ok(at('Incidents and Investigations') < at('Observations'));
  assert.ok(at('Observations') < at('Maintenance and Repairs'));
  assert.equal(titles.some((title) => /CCTV|Administration/.test(title)), false);
  const sectionEntries = (title) => {
    const start = blocks.findIndex((block) => block.kind === 'section' && block.title === title);
    const end = blocks.findIndex((block, index) => index > start && block.kind === 'section');
    return blocks.slice(start + 1, end).filter((block) => block.kind === 'entry');
  };
  const observed = sectionEntries('Observations');
  assert.deepEqual(observed.map((entry) => entry.tags[0]), ['Alpha Reserve', 'Serpentine', 'Inwoods']);
  assert.deepEqual(observed[1].photos, [photo('e')], 'the card review photo stays with its entry');
  assert.doesNotMatch(allText(blocks), /hunter permits|All Forests/);

  const log = allText(siteLogBlocks({ activityReport: labelled }, desk));
  assert.doesNotMatch(log, /hunter permits|ute passes|fuel tank|Replace card/);
  assert.match(log, /listed in their own sections above/);
  const quiet = { ...lines, lines: lines.lines.filter((line) => line.k !== 'observation') };
  assert.equal(monthlyActivityBlocks({ activityReport: report }, quiet).some((block) => block.kind === 'section' && block.title === 'Observations'), false, 'the section appears only when there are entries');

  const older = { ...report, categories: [...report.categories, { code: 'administration', entries: 3, photos: 0 }] };
  const olderBlocks = monthlyActivityBlocks({ activityReport: older }, desk);
  assert.equal(olderBlocks.find((block) => block.kind === 'metrics').items.find((item) => item.label === 'Entries recorded').value, '6', 'administration in an older pack is not counted');
  assert.doesNotMatch(allText(olderBlocks.filter((block) => block.kind === 'charts')), /Administration/);
});

test('the client email summary is a headline and entries by type of activity', async () => {
  const { activityEmailSummary } = await load();
  const email = activityEmailSummary({ activityReport: report });
  assert.equal(email.headline, '9 entries recorded across 2 locations, including 1 incident, 2 observations and 4 photos.', 'camera card reviews count as observations');
  assert.deepEqual(email.categories[1], ['Patrols and site checks', '4']);
  assert.ok(email.categories.every((row) => row.length === 2));
  assert.doesNotMatch(JSON.stringify(email), FORBIDDEN);
  const single = { ...report, totals: { ...report.totals, entries: 1, places: 1, incidents: 0, observations: 0, cameraActivations: 0, photos: 1 } };
  assert.equal(activityEmailSummary({ activityReport: single }).headline, '1 entry recorded across 1 location, including 0 incidents, 0 observations and 1 photo.');
  assert.match(activityEmailSummary({ activityReport: report }, { confirmedIncidents: 2 }).headline, /including 3 incidents,/, 'entries confirmed on review count as incidents');
  const older = activityEmailSummary({ activityReport: { ...report, categories: [...report.categories, { code: 'administration', entries: 3, photos: 0 }] } });
  assert.match(older.headline, /^6 entries recorded/, 'administration in an older pack is not counted');
  assert.equal(older.categories.some((row) => /Administration/i.test(row[0])), false);
});

test('confirmed entries are counted once and the summary title is not repeated under the section heading', async () => {
  const { activityLineKey, applyIncidentTriage, confirmedIncidentCount, executiveSummaryMarkup, summaryMarkup } = await load();
  const gate = lines.lines.find((line) => line.k !== 'incident');
  const recorded = lines.lines.find((line) => line.k === 'incident');
  const triaged = applyIncidentTriage(lines, [
    { line_key: activityLineKey(gate), decision: 'incident', incident_type: 'trespass' },
    { line_key: activityLineKey(recorded), decision: 'incident', incident_type: 'theft' },
  ]);
  assert.equal(confirmedIncidentCount(triaged), 1, 'recorded incidents are already in the totals');
  assert.equal(confirmedIncidentCount(lines), 0);
  const summary = '**Executive Summary: October 2026**\n\n**Significant Issues**\n* Gate forced.';
  assert.deepEqual(executiveSummaryMarkup(summary), summaryMarkup(summary).slice(1));
  assert.deepEqual(executiveSummaryMarkup('**Significant Issues**\n* Gate forced.'), summaryMarkup('**Significant Issues**\n* Gate forced.'));
});

test('PDF, send gate and every web surface agree on the current renderer version', () => {
  const version = (source, pattern) => source.match(pattern)?.[1];
  const pdf = version(read('supabase/functions/generate-report-pack-pdf/index.ts'), /const rendererVersion = '([^']+)'/);
  const send = version(read('supabase/functions/send-report-pack/index.ts'), /const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  const web = version(read('apps/web/src/lib/reportPackRenderer.ts'), /export const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  assert.equal(pdf, 'fcm-report-pack-pdf-lib-a4-v20');
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
  assert.match(pdf, /notableEventBlocks\(snapshot, activityLines\)/);
  const send = read('supabase/functions/send-report-pack/index.ts');
  assert.match(send, /activityEmailSummary\(d, \{ confirmedIncidents: pack\.confirmed_incidents \?\? 0 \}\)/);
  assert.match(send, /confirmedIncidentCount\(applyIncidentTriage\(emailPack\.activity_lines, confirmed\)\)/);
  assert.match(send, /\['Executive summary', editorial\.executive_summary, executiveSummaryMarkup\]/);
  const monthlyEmail = send.slice(send.indexOf('function monthlySummaryHtml'), send.indexOf('function summaryHtml'));
  assert.doesNotMatch(monthlyEmail, /patrolTravelKm|Hours|reconcile/);
  for (const listSurface of ['apps/web/src/pages/ReportsHubPage.tsx', 'apps/web/src/pages/ClientPortalPage.tsx', 'apps/web/src/components/CrmAccountWorkspace.tsx']) {
    assert.doesNotMatch(read(listSurface), /\.select\('[^']*activity_lines/, `${listSurface} list query must not carry itemised lines`);
  }
});

test('notable site events list only described entries not reported elsewhere, by location', async () => {
  const { notableEventBlocks, isNotableEvent } = await load();
  const blocks = notableEventBlocks({ activityReport: report }, lines);
  assert.equal(blocks[0].title, 'Notable Site Events');
  assert.deepEqual(blocks.filter((block) => block.kind === 'subsection').map((block) => [block.title, block.detail]), [['Alpha Reserve', '2 entries']]);
  assert.deepEqual(lines.lines.map(isNotableEvent), [false, false, false, false, true, true, false, false], 'pest control, incidents, observations, routine patrols and maintenance are reported in their own sections');
  assert.match(allText(blocks), /Freedom campers spoken to and moved on\./);
  assert.doesNotMatch(allText(blocks), FORBIDDEN);
  assert.deepEqual(notableEventBlocks({ activityReport: report }, { version: 2, lines: [lines.lines[2]], notItemised: 0 }), [], 'nothing notable, no section');
  assert.deepEqual(notableEventBlocks({}, lines), []);
});

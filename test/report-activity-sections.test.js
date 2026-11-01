const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const load = () => import('../supabase/functions/_shared/report-activity-sections.mjs');

const report = {
  version: 1,
  basis: 'Recorded activity entries at the places covered by this agreement.',
  totals: { entries: 5, events: 3, observations: 1, workOrders: 1, patrolVisits: 3, cameraActivations: 0, unattributedEntries: 0, places: 2, travelKm: 12.5, hours: 3.5, photos: 2 },
  categories: [
    { code: 'pest_control', entries: 2, km: 12.5, hours: 1.5, photos: 1 },
    { code: 'maintenance', entries: 2, km: 0, hours: 2, photos: 0 },
    { code: 'unclassified', entries: 1, km: 0, hours: 0, photos: 1 },
  ],
  serviceLines: [{ code: 'none', entries: 5 }],
  byPlace: [
    { place: 'Alpha Reserve', entries: 4, km: 12.5, hours: 1.5, photos: 2, categories: { pest_control: 2, maintenance: 1, unclassified: 1 } },
    { place: 'Not place-specific', entries: 1, km: 0, hours: 2, photos: 0, categories: { maintenance: 1 } },
  ],
  pestControl: {
    entries: 2, km: 12.5, hours: 1.5,
    bySpecies: [{ code: 'possum', culls: 1, sightings: 0, other: 0, total: 1 }, { code: 'feral_goat', culls: 0, sightings: 1, other: 0, total: 1 }],
    byActivity: [{ code: 'cull', entries: 1, hours: 1.5 }],
    byEquipment: [{ code: 'bait_station', entries: 1 }],
    ammunition: [{ calibre: '.22', entries: 1, rounds: 3 }, { calibre: 'unspecified', entries: 1, rounds: null }],
  },
  maintenance: { entries: 2, km: 0, hours: 2, bySubject: [{ code: 'gate', entries: 2, hours: 2 }], workOrders: { completed: 1, open: 0 } },
  manufacture: { entries: 0, km: 0, hours: 0, bySubject: [], workOrders: { completed: 0, open: 0 } },
  observations: { total: 1, withPhoto: 1, photos: 1, eventPhotos: 1, byModule: [{ module: 'unknown', entries: 1, withPhoto: 1, photos: 1 }] },
  labels: { category: { pest_control: 'Pest control', maintenance: 'Maintenance and repairs', unclassified: 'Not yet classified' }, activity: { cull: 'Cull' }, species: { possum: 'Possum' }, subject: { gate: 'Gate' }, equipment: {}, material: { ammunition: 'Ammunition' }, serviceLine: {} },
  accountedFor: { eventsInScope: 4, mirrorEventsExcluded: 1, activityEvents: 3, observationsInScope: 1, workOrdersInScope: 1, entries: 5, itemised: 2, notItemised: 3, unclassified: 1, reconciled: true },
};
const lines = {
  version: 1,
  lines: [
    { d: '2026-10-01', p: 'Alpha Reserve', k: 'event', c: 'pest_control', a: 'cull', sp: 'possum', j: 'J-1001', km: 12.5, h: 1.5, ph: 1, m: [{ t: 'ammunition', cal: '.22', q: 3 }] },
    { d: '2026-10-15', k: 'work_order', c: 'maintenance', a: 'maintenance', j: 'WO-1', ws: 'in_progress' },
  ],
  notItemised: 3,
};
const tables = (blocks) => blocks.filter((block) => block.kind === 'table');
const allText = (blocks) => JSON.stringify(blocks);

test('legacy monthly packs keep the legacy layout', async () => {
  const { monthlyActivityBlocks, itemisedActivityBlocks, activityAccountingStatement, activityEmailSummary } = await load();
  for (const data of [{}, null, { activityReport: { ...report, version: 2 } }, { activityReport: { version: 1 } }]) {
    assert.equal(monthlyActivityBlocks(data), null);
    assert.deepEqual(itemisedActivityBlocks(data, lines), []);
    assert.deepEqual(activityAccountingStatement(data), []);
    assert.equal(activityEmailSummary(data), null);
  }
});

test('summary sections present every category with catalogue labels and readable fallbacks', async () => {
  const { monthlyActivityBlocks } = await load();
  const blocks = monthlyActivityBlocks({ activityReport: report });
  const titles = blocks.filter((block) => block.kind === 'section').map((block) => block.title);
  assert.deepEqual(titles, ['Activity Summary', 'Activity by Category', 'Activity by Place', 'Pest Control', 'Maintenance and Repairs', 'Manufacture and Fabrication', 'Observations and Photos']);
  for (const block of tables(blocks)) {
    assert.equal(block.columns.reduce((sum, column) => sum + column.width, 0), 487, `${block.columns[0].label} spans the page`);
    for (const row of block.rows) assert.equal(row.length, block.columns.length);
  }
  const text = allText(blocks);
  assert.match(text, /"Recorded travel \(km\)","12\.5"/);
  assert.match(text, /"Pest control","2","1\.5","12\.5","1"/);
  assert.match(text, /Pest control 2, Maintenance and repairs 1, Not yet classified 1/);
  assert.match(text, /"Feral goat","0","1","0","1"/);
  assert.match(text, /"Calibre not recorded","1","Not recorded"/);
  assert.match(text, /No manufacture or fabrication work was recorded/);
  assert.match(text, /workshop work orders: 1 completed, 0 in progress or approved/);
  assert.match(text, /"Not specified","1","1","1"/);
});

test('accounting statement and itemised appendix disclose exclusions and the line limit', async () => {
  const { activityAccountingStatement, itemisedActivityBlocks, activityEmailSummary, monthlyActivityBlocks } = await load();
  const statement = activityAccountingStatement({ activityReport: report }).join(' ');
  assert.match(statement, /5 recorded entries are reported: 3 patrol-log entries, 1 observation and 1 workshop work order\./);
  assert.match(statement, /1 automatic patrol-log copy of an observation was excluded/);
  assert.match(statement, /2 entries are itemised in the appendix; 3 further entries/);
  assert.match(statement, /totals agree/);
  assert.match(activityAccountingStatement({ activityReport: { ...report, accountedFor: { ...report.accountedFor, reconciled: false } } }).join(' '), /did not agree/);

  const appendix = itemisedActivityBlocks({ activityReport: report }, lines);
  const [table] = tables(appendix);
  assert.deepEqual(table.rows[0], ['01/10/2026', 'Alpha Reserve', 'Pest control', 'Cull · Possum · Ammunition .22 × 3 · 1 photo', 'J-1001', '1.5', '12.5']);
  assert.deepEqual(table.rows[1], ['15/10/2026', 'Not place-specific', 'Maintenance and repairs', 'Work order in progress · Maintenance', 'WO-1', '', '']);
  assert.match(allText(appendix), /3 further entries are included in the totals above but are not itemised/);
  assert.match(allText(itemisedActivityBlocks({ activityReport: report }, null)), /Itemised lines are not available/);

  const email = activityEmailSummary({ activityReport: report });
  assert.equal(email.headline, '5 recorded activity entries across 2 places · 3.5 hours · 12.5 km · 2 photos.');
  assert.deepEqual(email.categories[0], ['Pest control', '2', '1.5']);

  const single = {
    ...report,
    totals: { ...report.totals, entries: 1, places: 1, photos: 1 },
    accountedFor: { ...report.accountedFor, entries: 1, activityEvents: 1, observationsInScope: 0, workOrdersInScope: 0, mirrorEventsExcluded: 2, unclassified: 1, itemised: 1, notItemised: 0 },
  };
  const singleStatement = activityAccountingStatement({ activityReport: single }).join(' ');
  assert.match(singleStatement, /1 recorded entry is reported: 1 patrol-log entry, 0 observations and 0 workshop work orders\./);
  assert.match(singleStatement, /2 automatic patrol-log copies of observations were excluded/);
  assert.match(singleStatement, /1 entry has no work type recorded and is shown/);
  assert.match(singleStatement, /The 1 entry is itemised in the appendix\./);
  assert.equal(activityEmailSummary({ activityReport: single }).headline, '1 recorded activity entry across 1 place · 3.5 hours · 12.5 km · 1 photo.');
  assert.doesNotMatch(allText(monthlyActivityBlocks({ activityReport: { ...report, pestControl: { ...report.pestControl, entries: 1 } } })), /\b1 pest-control entries\b/);
});

test('PDF, send gate and every web surface agree on the current renderer version', () => {
  const version = (source, pattern) => source.match(pattern)?.[1];
  const pdf = version(read('supabase/functions/generate-report-pack-pdf/index.ts'), /const rendererVersion = '([^']+)'/);
  const send = version(read('supabase/functions/send-report-pack/index.ts'), /const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  const web = version(read('apps/web/src/lib/reportPackRenderer.ts'), /export const CURRENT_REPORT_PDF_RENDERER = '([^']+)'/);
  assert.ok(pdf);
  assert.equal(send, pdf);
  assert.equal(web, pdf);
  for (const surface of ['apps/web/src/pages/ReportsHubPage.tsx', 'apps/web/src/pages/ClientPortalPage.tsx', 'apps/web/src/components/CrmAccountWorkspace.tsx']) {
    const source = read(surface);
    assert.doesNotMatch(source, /fcm-report-pack-pdf-lib-a4-v\d+/, `${surface} must use the shared renderer constant`);
    assert.match(source, /from '\.\.\/lib\/reportPackRenderer'/);
  }
});

test('monthly PDF loads the itemised lines only for the pack it renders', () => {
  const pdf = read('supabase/functions/generate-report-pack-pdf/index.ts');
  assert.match(pdf, /select\('id,organization_id,[^']*activity_lines[^']*'\)\.eq\('id', packId\)\.single\(\)/);
  assert.match(pdf, /monthlyActivityBlocks\(snapshot\)/);
  assert.match(pdf, /itemisedActivityBlocks\(snapshot, activityLines\)/);
  assert.match(read('supabase/functions/send-report-pack/index.ts'), /activityEmailSummary\(d\)/);
  for (const listSurface of ['apps/web/src/pages/ReportsHubPage.tsx', 'apps/web/src/pages/ClientPortalPage.tsx', 'apps/web/src/components/CrmAccountWorkspace.tsx']) {
    assert.doesNotMatch(read(listSurface), /\.select\('[^']*activity_lines/, `${listSurface} list query must not carry itemised lines`);
  }
});

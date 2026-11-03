const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'),
  'utf8',
);

test('report-pack PDFs keep snapshot provenance in document metadata, not on client pages', () => {
  assert.match(source, /pdf\.setProducer\(rendererVersion\)/);
  assert.match(source, /`report-pack:\$\{packId\}`/);
  assert.match(source, /`snapshot-generated:\$\{snapshotGeneratedAt \?\? 'not-recorded'\}`/);
  assert.match(source, /`renderer:\$\{rendererVersion\}`/);
  assert.match(source, /generated_at/);
  assert.match(source, /p_renderer_version: rendererVersion/);
  for (const technical of [/Report pack ID:/, /Source snapshot generated:/, /Renderer: \$\{rendererVersion\}/, /governed FCM report-pack snapshot/]) {
    assert.doesNotMatch(source, technical, 'client pages carry no system provenance');
  }
});

test('monthly PDFs render agreement-scoped client sections without provider-wide or operational totals', () => {
  assert.match(source, /'fcm-report-pack-pdf-lib-a4-v16'/);
  assert.match(source, /else if \(block\.kind === 'charts'\) drawCharts\(block\)/);
  assert.match(source, /else if \(block\.kind === 'gallery'\) drawGallery\(block\)/);
  assert.match(source, /embedPdfNotoFonts\(pdf\)/);
  assert.doesNotMatch(source, /noto-sans-[^'" ]+\.woff/);
  assert.doesNotMatch(source, /pdf\.embedFont\(/);
  assert.match(source, /pdf\.setTitle\(reportTitle\)/);
  assert.match(source, /editorial\.title\.trim\(\)/);
  assert.match(source, /templateTitle = typeof template\?\.name === 'string'/);
  assert.match(source, /\$\{templateTitle\} - \$\{period\}/);
  assert.match(source, /monthlyActivityBlocks\(snapshot, activityLines, \{ summary: editorial\.executive_summary, highlights: editorial\.client_notes \}\)/);
  assert.match(source, /siteLogBlocks\(snapshot, activityLines\)/);
  assert.match(source, /Patrol and Activity Summary/);
  assert.match(source, /Site Coverage/);
  assert.match(source, /Service Level Performance/);
  assert.match(source, /sla\.some\(\(\[, value\]\) => \(value \?\? 0\) > 0\)/, 'the service-level table is drawn only when there is something to report');
  const monthlyRenderer = source.slice(source.indexOf('const drawMonthlySections'), source.indexOf('const drawCover'));
  assert.ok(monthlyRenderer.length > 200);
  assert.doesNotMatch(monthlyRenderer, /incidentsTotal|breachAlerts|checkpointVisits/);
  assert.doesNotMatch(monthlyRenderer, /patrolTravelKm|travelKm|hours/i, 'travel and hours never reach the client PDF');
});

test('report photos are embedded from site-photo buckets only, within fixed limits', () => {
  const photos = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/report-photos.ts'), 'utf8');
  assert.match(photos, /REPORT_PHOTO_BUCKETS: readonly string\[\] = \['bob-uploads', 'scans'\]/);
  assert.match(photos, /REPORT_PHOTO_BUCKETS\.includes\(bucket\)/, 'a snapshot bucket hint cannot widen storage access');
  assert.match(photos, /ref\.p\.includes\('\.\.'\)/);
  assert.match(photos, /data\.size > MAX_SOURCE_BYTES/);
  assert.match(photos, /CONVERT_BUDGET_MS/);
  assert.match(source, /PHOTOS_PER_ENTRY = 3/);
  assert.match(source, /MAX_REPORT_PHOTOS = \d+/);
  assert.match(source, /loadPhotos: \(refs\) => loadReportPhotos\(admin, refs\)/);
  assert.match(source, /held on file/);
});

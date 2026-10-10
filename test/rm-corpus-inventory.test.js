const test = require('node:test');
const assert = require('node:assert/strict');

test('R&M corpus classification keeps sensitive and unsupported files out of automatic promotion', async () => {
  const { classifyFile } = await import('../scripts/rm-corpus-inventory.mjs');

  assert.deepEqual(classifyFile('Staff Details/Officer COA.pdf', 100).domain, 'people');
  assert.deepEqual(classifyFile('Staff Details/Officer COA.pdf', 100).sensitivity, 'restricted');
  assert.deepEqual(classifyFile('Invoice Spreadsheets/Client.xlsx', 100).domain, 'finance');
  assert.deepEqual(classifyFile('Quotes/Client Quote.docx', 100).domain, 'proposals');
  assert.deepEqual(classifyFile('Photos/camera.dav', 100).ingestion_class, 'quarantine');
  assert.deepEqual(classifyFile('Photos/camera.dav', 100).capability, 'gap');
  assert.deepEqual(classifyFile('Health and Safety/policy.download', 100).capability, 'exclude');
  assert.deepEqual(classifyFile('Branding/R&M/Logo.png', 100).capability, 'supported');
  assert.deepEqual(classifyFile('Patrol Log Entries/patrol.xlsx', 100).capability, 'partial');
  assert.deepEqual(classifyFile('empty.pdf', 0).ingestion_class, 'exclude');
});

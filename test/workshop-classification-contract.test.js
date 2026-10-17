const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const page = readFileSync(resolve(__dirname, '../apps/web/src/pages/WorkshopPage.tsx'), 'utf8');
const types = readFileSync(resolve(__dirname, '../apps/web/src/lib/workshop.ts'), 'utf8');

test('maintenance work orders use the organization work catalog', () => {
  assert.match(page, /from\('reference_codes'\)/);
  assert.match(page, /\.eq\('organization_id', organizationId\)/);
  assert.match(page, /\.in\('code_type', \['work_subject', 'work_activity'\]\)/);
  assert.match(page, /\.eq\('is_active', true\)/);
  assert.match(page, /option\.code_type === 'work_subject'/);
  assert.match(page, /option\.code_type === 'work_activity'/);
});

test('maintenance creation requires and submits both classifications', () => {
  assert.match(page, /id="wo-subject" required/);
  assert.match(page, /id="wo-activity" required/);
  assert.match(page, /p_work_subject_code_id: orderForm\.kind === 'maintenance'/);
  assert.match(page, /p_work_activity_code_id: orderForm\.kind === 'maintenance'/);
  assert.match(page, /No active work subjects are configured for this organisation/);
  assert.match(page, /No active work activities are configured for this organisation/);
});

test('work order summaries expose the persisted classification receipt', () => {
  assert.match(types, /work_subject_code_id: string \| null/);
  assert.match(types, /work_subject_name: string \| null/);
  assert.match(types, /work_activity_code_id: string \| null/);
  assert.match(types, /work_activity_name: string \| null/);
  assert.match(page, /selected\.work_subject_name \?\? 'Subject not classified'/);
  assert.match(page, /selected\.work_activity_name \?\? 'Activity not classified'/);
});

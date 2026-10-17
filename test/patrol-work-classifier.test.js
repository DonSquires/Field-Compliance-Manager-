const assert = require('node:assert/strict');
const test = require('node:test');

const classifier = import('../scripts/patrol-work-classifier.mjs');

const rule = (id, targetCodeType, targetCode, priority, conditions, workOrderCandidate = false) => ({
  id,
  target_code_id: `${id}-catalog`,
  target_code_type: targetCodeType,
  target_code: targetCode,
  target_external_refs: { work_order_candidate: workOrderCandidate },
  priority,
  conditions,
  active: true,
});

const rules = [
  rule('subject-electronic', 'work_subject', 'electronic_lock', 10, [{ field: 'subject', operator: 'in', values: ['E-Lock', 'digital lock'] }]),
  rule('subject-physical', 'work_subject', 'physical_lock', 20, [{ field: 'subject', operator: 'in', values: ['Lock', 'Locks', 'combination lock'] }]),
  rule('subject-gate', 'work_subject', 'gate', 30, [{ field: 'subject', operator: 'exact', value: 'Gate' }]),
  rule('subject-camera', 'work_subject', 'camera', 30, [{ field: 'subject', operator: 'exact', value: 'Camera' }]),
  rule('subject-general', 'work_subject', 'general', 30, [{ field: 'subject', operator: 'exact', value: 'General' }]),
  rule('activity-check-repair', 'work_activity', 'maintenance', 10, [{ field: 'issue', operator: 'exact', value: 'Check' }, { field: 'description', operator: 'regex', value: '\\b(unable|broken|replace|cutting)\\b' }], true),
  rule('activity-install', 'work_activity', 'installation', 20, [{ field: 'issue', operator: 'in', values: ['Installation', 'Install'] }], true),
  rule('activity-maintenance', 'work_activity', 'maintenance', 20, [{ field: 'issue', operator: 'in', values: ['Maintenance', 'Repair'] }], true),
  rule('activity-check', 'work_activity', 'inspection', 50, [{ field: 'issue', operator: 'in', values: ['Check', 'Inspection'] }]),
  rule('activity-securing', 'work_activity', 'securing', 50, [{ field: 'issue', operator: 'in', values: ['Closed', 'Secure'] }]),
  rule('activity-materials', 'work_activity', 'materials', 50, [{ field: 'issue', operator: 'exact', value: 'Materials' }]),
  rule('activity-travel', 'work_activity', 'travel', 50, [{ field: 'issue', operator: 'exact', value: 'Travel' }]),
  rule('activity-admin', 'work_activity', 'administration', 50, [{ field: 'issue', operator: 'exact', value: 'Admin' }]),
];

test('keeps electronic and physical locks as different work subjects', async () => {
  const { classifyPatrolWork } = await classifier;
  assert.equal(classifyPatrolWork({ subject: 'E-Lock', issue: 'Check', description: 'Working' }, rules).work_subject_code, 'electronic_lock');
  assert.equal(classifyPatrolWork({ subject: 'Lock', issue: 'Installation', description: '' }, rules).work_subject_code, 'physical_lock');
  assert.equal(classifyPatrolWork({ subject: 'Locks', issue: 'Materials', description: '' }, rules).work_subject_code, 'physical_lock');
});

test('infers job activity from the issue and description under their headers', async () => {
  const { classifyPatrolWork } = await classifier;
  const maintenance = classifyPatrolWork({ subject: 'Camera', issue: 'Maintenance', description: '' }, rules);
  assert.equal(maintenance.work_subject_code, 'camera');
  assert.equal(maintenance.work_activity_code, 'maintenance');
  assert.equal(maintenance.work_order_candidate, true);
  const repair = classifyPatrolWork({ subject: 'E-Lock', issue: 'Check', description: 'Unable to open lock. Start cutting it with dremel.' }, rules);
  assert.equal(repair.work_subject_code, 'electronic_lock');
  assert.equal(repair.work_activity_code, 'maintenance');
  assert.equal(repair.work_order_candidate, true);
  assert.equal(classifyPatrolWork({ subject: 'E-Lock', issue: 'Check', description: 'Working' }, rules).work_activity_code, 'inspection');
});

test('does not turn routine patrol or support rows into maintenance work orders', async () => {
  const { classifyPatrolWork } = await classifier;
  for (const row of [
    { subject: 'Gate', issue: 'Closed', description: 'Secure' },
    { subject: 'General', issue: 'Materials', description: 'Purchased Dremel blades' },
    { subject: 'General', issue: 'Travel', description: '' },
    { subject: 'General', issue: 'Admin', description: 'Start' },
  ]) assert.equal(classifyPatrolWork(row, rules).work_order_candidate, false);
});

test('has no built-in taxonomy and fails closed until catalog rules are supplied', async () => {
  const { classifyPatrolWork } = await classifier;
  assert.throws(() => classifyPatrolWork({ subject: 'E-Lock', issue: 'Maintenance', description: '' }), /loaded from the work catalog/);
  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../scripts/patrol-work-classifier.mjs'), 'utf8');
  assert.doesNotMatch(source, /PATROL_WORK_SUBJECTS|PATROL_WORK_ACTIVITIES/);
  assert.doesNotMatch(source, /physical_lock|electronic_lock|installation|maintenance/);
});

test('surfaces malformed catalog regular expressions instead of silently skipping them', async () => {
  const { classifyPatrolWork } = await classifier;
  const invalidRules = [rule('invalid-regex', 'work_activity', 'maintenance', 1, [{ field: 'description', operator: 'regex', value: '[' }])];
  assert.throws(() => classifyPatrolWork({ subject: '', issue: '', description: 'evidence' }, invalidRules), /regular expression|unterminated|invalid/i);
});

test('surfaces unsupported catalog conditions', async () => {
  const { classifyPatrolWork } = await classifier;
  const invalidRules = [rule('invalid-operator', 'work_activity', 'maintenance', 1, [{ field: 'description', operator: 'approximately', value: 'repair' }])];
  assert.throws(() => classifyPatrolWork({ subject: '', issue: '', description: 'repair' }, invalidRules), /Unsupported classification operator/);
});
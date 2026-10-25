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

function seededRmRules() {
  const fs = require('node:fs');
  const path = require('node:path');
  const seeded = new Map();
  for (const file of ['20260927170000_workshop_work_classification.sql', '20261024224750_rm_pest_control_vocabulary.sql', '20261024233829_rm_charge_code_catalog.sql']) {
    const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', file), 'utf8');
    const block = sql.match(/WITH rule_seed\([^)]*\) AS \(\s*VALUES([\s\S]*?)\r?\n\)\r?\nINSERT INTO public\.import_value_classification_rules/);
    assert.ok(block, `${file} has a rule_seed block`);
    for (const [, code, type, target, priority, json] of block[1].matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)', (\d+), '(.*?)'::jsonb\)/g)) {
      seeded.set(code, rule(code, type, target, Number(priority), JSON.parse(json.replace(/''/g, "'"))));
    }
  }
  return [...seeded.values()];
}

test('classifies R&M pest-control rows from the shipped catalog rules', async () => {
  const { classifyPatrolWork } = await classifier;
  const shipped = seededRmRules();
  const pick = (row) => {
    const result = classifyPatrolWork({ description: '', ...row }, shipped);
    return [result.work_subject_code, result.work_activity_code, result.biosecurity_species_code ?? null];
  };
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Check' }), ['pest_device', 'inspection', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Rebait' }), ['pest_device', 'rebait', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Prefeed' }), ['pest_device', 'prefeed', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Reset' }), ['pest_device', 'device_reset', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Unset' }), ['pest_device', 'device_unset', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Uninstall' }), ['pest_device', 'uninstall', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Inactive' }), ['pest_device', 'device_inactive', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Access Blocked' }), ['pest_device', 'access_blocked', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Area maintenance' }), ['pest_device', 'maintenance', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Possum' }), ['animal', 'cull', 'possum']);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Other' }), ['animal', 'cull', 'other']);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Seen', issue: 'Cat' }), ['animal', 'sighting', 'cat']);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Shot', issue: 'Stoat / Ferrit' }), ['animal', 'cull', 'stoat_ferret']);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Patrol', issue: 'Travel' }), ['animal', 'travel', null]);
  assert.deepEqual(pick({ source: 'PEST CONTROL', subject: 'Animal Patrol', issue: 'Patrol' }), ['animal', 'pest_patrol', null]);
});

test('keeps non-pest R&M rows on their existing classification', async () => {
  const { classifyPatrolWork } = await classifier;
  const shipped = seededRmRules();
  const security = classifyPatrolWork({ source: 'SECURITY', subject: 'Equipment', issue: 'Check', description: '' }, shipped);
  assert.equal(security.work_subject_code, 'other');
  assert.equal(security.work_activity_code, 'inspection');
  assert.equal('biosecurity_species_code' in security, false);
  const lock = classifyPatrolWork({ source: 'SECURITY', subject: 'E-Lock', issue: 'Check', description: 'Working' }, shipped);
  assert.deepEqual([lock.work_subject_code, lock.work_activity_code], ['electronic_lock', 'inspection']);
  assert.equal('biosecurity_species_code' in lock, false);
});

test('separates camera removal, uninstall, and gate or sign engineering from gate state reports', async () => {
  const { classifyPatrolWork } = await classifier;
  const shipped = seededRmRules();
  const pick = (row) => {
    const result = classifyPatrolWork({ description: '', ...row }, shipped);
    return [result.work_subject_code, result.work_activity_code];
  };
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Camera', issue: 'Uninstall' }), ['camera', 'removal']);
  assert.equal(pick({ source: 'SECURITY', subject: 'Camera', issue: 'Removal' })[1], 'removal');
  assert.equal(pick({ source: 'SECURITY', subject: 'General', issue: 'Removal' })[1], 'removal');
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'E-Lock', issue: 'Remove' }), ['electronic_lock', 'uninstall']);
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Lock', issue: 'E-Lock maintenance' }), ['electronic_lock', 'maintenance']);
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Gate', issue: 'Installation' }), ['gate', 'maintenance']);
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Gates', issue: 'Remove' }), ['gate', 'maintenance']);
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Sign', issue: 'Remove' }), ['sign', 'maintenance']);
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Sign', issue: 'Manufacture' }), ['sign', 'manufacture']);
  for (const issue of ['Open', 'Closed', 'Live', 'Dead', 'Insecure', 'Closed via camera']) {
    assert.deepEqual(pick({ source: 'SECURITY', subject: 'Gate', issue }), ['gate', 'inspection'], issue);
  }
  assert.deepEqual(pick({ source: 'SECURITY', subject: 'Gate', issue: 'Check', description: 'Gate broken, unable to close' }), ['gate', 'maintenance']);
});

test('records equipment type and ammunition as separate dimensions', async () => {
  const { classifyPatrolWork } = await classifier;
  const shipped = seededRmRules();
  const camera = classifyPatrolWork({ source: 'SECURITY', subject: 'Camera', issue: 'Installation', description: '' }, shipped);
  assert.equal(camera.equipment_type_code, 'camera');
  const cones = classifyPatrolWork({ source: 'SECURITY', subject: 'General', issue: 'Other', description: 'Placed road cones at the gate' }, shipped);
  assert.equal(cones.equipment_type_code, 'road_cones');
  const trap = classifyPatrolWork({ source: 'PEST CONTROL', subject: 'Equipment', issue: 'Reset', description: '' }, shipped);
  assert.equal(trap.equipment_type_code, 'trap');
  const ammo = classifyPatrolWork({ source: 'PEST CONTROL', subject: 'Animal Cull', issue: 'Pig', description: 'Shot 2 pigs. 7 x 7mm @ $3.51' }, shipped);
  assert.deepEqual([ammo.biosecurity_species_code, ammo.material_type_code], ['pig', 'ammunition']);
  const plain = classifyPatrolWork({ source: 'SECURITY', subject: 'Gate', issue: 'Closed', description: '' }, shipped);
  assert.equal('equipment_type_code' in plain, false);
  assert.equal('material_type_code' in plain, false);
});
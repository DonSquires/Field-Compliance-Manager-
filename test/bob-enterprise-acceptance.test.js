'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('Bob enterprise acceptance covers every requested system and passes the plate guard', () => {
  const result = spawnSync(process.execPath, ['scripts/bob-enterprise-acceptance.mjs', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.plate_regression.passed, true);
  assert.equal(report.plate_regression.expected, 'JJJ739');
  assert.equal(report.plate_regression.resolved, 'JJJ739');
  assert.equal(report.plate_regression.rejected_candidate, '11739');
  assert.equal(report.plate_regression.rejected_valid_shape, false);
  assert.equal(report.plate_regression.guarded_text, 'Plate: JJJ739');
  assert.equal(report.plate_regression.guarded_entity, 'JJJ739');
  assert.equal(report.summary.missing_files, 0);

  const ids = new Set(report.domains.map((domain) => domain.id));
  for (const required of [
    'governance',
    'document_identity',
    'cctv_perception',
    'parking_freedom_camping',
    'access_control',
    'environmental',
    'desktop_v2',
    'builder_self_heal',
    'experience',
    'exercise_calibration',
  ]) assert.equal(ids.has(required), true, `missing enterprise domain ${required}`);
});

test('strict enterprise acceptance fails while declared architecture gaps remain', () => {
  const result = spawnSync(process.execPath, ['scripts/bob-enterprise-acceptance.mjs', '--strict'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stdout, /\[GAP\] Access-control recognition and entitlement/);
  assert.match(result.stdout, /\[GAP\] Invocation evidence and model calibration/);
});

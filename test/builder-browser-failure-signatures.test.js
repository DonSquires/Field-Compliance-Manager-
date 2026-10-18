const assert = require('node:assert/strict');
const test = require('node:test');
const { browserFailureSignatures, sameBrowserFailures } = require('../frontend-worker');
const { classifyVerificationFailure } = require('../builder-verification-outcome');

function report(title = 'button works', message = 'Expected visible; received hidden', status = 'unexpected') {
  return { errors: [], suites: [{ title: 'flow', specs: [{ file: 'e2e/example.spec.ts', title, tests: [{
    projectName: 'desktop-chromium', status, results: [{ errors: [{ message }] }]
  }] }] }] };
}

test('baseline requires matching browser test identity AND failure signature, not two nonzero exits', () => {
  const failure = browserFailureSignatures(report());
  assert.equal(sameBrowserFailures(failure, browserFailureSignatures(report())), true);
  assert.equal(sameBrowserFailures(failure, browserFailureSignatures(report('different test'))), false);
  assert.equal(sameBrowserFailures(failure, browserFailureSignatures(report('button works', 'different assertion'))), false);
  assert.equal(sameBrowserFailures(failure, browserFailureSignatures({ suites: [], errors: [] })), false);
  assert.equal(sameBrowserFailures(failure, null), false);
  assert.equal(sameBrowserFailures(failure, browserFailureSignatures({ ...report(), errors: [{ message: 'setup failed' }] })), false);
  const resource = browserFailureSignatures(report('button works', 'net::ERR_INSUFFICIENT_RESOURCES'));
  assert.equal(sameBrowserFailures(resource, resource), false);
});

test('matching durations normalize, flaky final passes do not count, and infrastructure takes precedence', () => {
  assert.equal(sameBrowserFailures(browserFailureSignatures(report('x', 'Timeout 5000ms')),
    browserFailureSignatures(report('x', 'Timeout 6000ms'))), true);
  assert.deepEqual(browserFailureSignatures(report('x', 'failure on earlier retry', 'flaky')).failures, []);
  assert.equal(classifyVerificationFailure({
    baseline_failure: true, baseline: { proven_same_failure: true },
    commands: [{ status: 1, stdout: 'Failed to load resource: net::ERR_INSUFFICIENT_RESOURCES' }]
  }).infrastructure, true);
  assert.equal(classifyVerificationFailure({ baseline_failure: true }).baseline, false, 'legacy claim without matching evidence is not proof');
});

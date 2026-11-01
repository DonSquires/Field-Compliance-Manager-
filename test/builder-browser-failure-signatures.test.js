const assert = require('node:assert/strict');
const test = require('node:test');
const { browserFailureSignatures, introducedBrowserFailures, sameBrowserFailures } = require('../frontend-worker');
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

test('only a test that does not fail at baseline is attributed to the patch, and only on complete non-infrastructure evidence', () => {
  const both = (patchedTitle, baselineTitle) => ({ errors: [], suites: [{ title: 'flow', specs: [
    { file: 'e2e/example.spec.ts', title: patchedTitle, tests: [{ projectName: 'desktop-chromium', status: 'unexpected', results: [{ errors: [{ message: 'Timeout waiting for panel' }] }] }] },
    { file: 'e2e/example.spec.ts', title: baselineTitle, tests: [{ projectName: 'desktop-chromium', status: 'unexpected', results: [{ errors: [{ message: 'reload lost the receipt' }] }] }] }
  ] }] });
  const baseline = browserFailureSignatures(report('reload keeps receipt', 'reload lost the receipt'));
  assert.deepEqual(introducedBrowserFailures(browserFailureSignatures(both('new panel test', 'reload keeps receipt')), baseline),
    ['e2e/example.spec.ts::desktop-chromium::new panel test'], 'baseline failures that persist are not the author\'s');
  assert.deepEqual(introducedBrowserFailures(browserFailureSignatures(report('reload keeps receipt', 'a different reason')), baseline), [],
    'the same test failing differently stays unresolved');
  assert.deepEqual(introducedBrowserFailures(browserFailureSignatures(report('new panel test')), { complete: false, failures: [] }), []);
  assert.deepEqual(introducedBrowserFailures(browserFailureSignatures(report('new panel test')), null), []);
  assert.deepEqual(introducedBrowserFailures(browserFailureSignatures(report('new panel test', 'net::ERR_INSUFFICIENT_RESOURCES')), baseline), []);
  const verification = { succeeded: false, baseline_failure: false, commands: [{ command: 'npm run test:e2e', status: 1, stdout: '1 failed' }],
    baseline: { also_fails: true, proven_same_failure: false, new_failures: ['e2e/example.spec.ts::desktop-chromium::new panel test'] } };
  assert.deepEqual(classifyVerificationFailure(verification), { infrastructure: false, baseline: false, reason: null }, 'an attributed failure is an engineering failure for the author');
});

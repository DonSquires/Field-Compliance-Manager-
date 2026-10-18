import {
  classifyByRules,
  classifyRepairRisk,
  deriveRoute,
  screenStopLines,
  validateAndRedactEnvelope,
} from './triage-logic.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

Deno.test('high-confidence render failures are routine repairs', () => {
  const envelope = {
    before: { page: '/admin/reports', module: 'web_runtime' },
    during: { error: { kind: 'render_failure', message: 'Failed to fetch dynamically imported module' } },
    expected: { user_intent: 'Open reports', expected_outcome: 'Reports load' },
  };
  const route = deriveRoute(null, 'bug', 0.9);
  assertEquals(route, 'dispatch_flow');
  assertEquals(classifyRepairRisk(envelope, null, 'bug', 0.9, route), 'routine');
});

Deno.test('consequential, redesign, and uncertain faults never auto-start', () => {
  const protectedEnvelope = {
    before: { page: '/admin/access-control' },
    during: { error: { kind: 'exception', message: 'permission rule failed' } },
    expected: { user_intent: 'Update identity access', expected_outcome: 'Access changes' },
  };
  assertEquals(classifyRepairRisk(protectedEnvelope, null, 'bug', 0.9, 'dispatch_flow'), 'protected');

  const redesignEnvelope = {
    before: { page: '/admin/reports' },
    during: { error: { kind: 'render_failure', message: 'redesign this page' } },
    expected: { user_intent: 'Redesign reports', expected_outcome: 'New workflow' },
  };
  assertEquals(classifyRepairRisk(redesignEnvelope, null, 'bug', 0.9, 'dispatch_flow'), 'significant');
  assertEquals(classifyRepairRisk(redesignEnvelope, null, 'bug', 0.7, 'self_heal_apparatus'), 'unknown');
  assertEquals(classifyRepairRisk(redesignEnvelope, 'stop_line:privacy', 'bug', 0.99, 'grand_master_bell'), 'protected');
});

Deno.test('a person\'s change request is a ux_gap that always waits for a reviewer', () => {
  const { envelope, redaction } = validateAndRedactEnvelope({
    schema_version: '1',
    before: { page: '/admin/roster', module: 'roster', view_title: 'Roster board', view_headings: ['Roster', 'Unfilled shifts'], viewport: 'desktop', form_values: 'leak' },
    during: { user_report: { kind: 'workflow_snag', current_behavior: 'I scroll to find unfilled shifts', desired_behavior: 'Pin unfilled shifts at the top', business_reason: 'Faster cover', extra: 'drop me' } },
    expected: { user_intent: 'Fill shifts faster', expected_outcome: 'Unfilled shifts visible first' },
  });
  assertEquals((envelope.before as Record<string, unknown>).form_values, undefined);
  assertEquals(((envelope.during as Record<string, Record<string, unknown>>).user_report).extra, undefined);
  assertEquals(redaction.dropped_fields, 2);
  assertEquals(screenStopLines(envelope).hit, null);
  const verdict = classifyByRules(envelope)!;
  assertEquals(verdict.triage, 'ux_gap');
  const route = deriveRoute(null, verdict.triage, verdict.confidence);
  assertEquals(route, 'self_heal_apparatus');
  assertEquals(classifyRepairRisk(envelope, null, verdict.triage, verdict.confidence, route), 'significant');
});

Deno.test('change requests touching consequential surfaces are protected, and unknown kinds are dropped', () => {
  const { envelope } = validateAndRedactEnvelope({
    schema_version: '1',
    before: { page: '/admin/people-hr' },
    during: { user_report: { kind: 'change_request', desired_behavior: 'Show payroll totals to officers' } },
  });
  assertEquals(classifyRepairRisk(envelope, null, 'ux_gap', 0.9, 'self_heal_apparatus'), 'protected');
  const unsafe = validateAndRedactEnvelope({ schema_version: '1', during: { user_report: { kind: 'run_sql', desired_behavior: 'x' } } }).envelope;
  assertEquals((unsafe.during as Record<string, unknown>).user_report, undefined);
  const safety = validateAndRedactEnvelope({ schema_version: '1', before: { page: '/admin/sites' }, during: { user_report: { kind: 'workflow_snag', desired_behavior: 'Officer injury reports need a faster path' } } }).envelope;
  assertEquals(screenStopLines(safety).hit, 'stop_line:safety');
});

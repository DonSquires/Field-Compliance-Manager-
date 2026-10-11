import {
  classifyRepairRisk,
  deriveRoute,
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

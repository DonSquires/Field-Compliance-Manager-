import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'src/pages/ApprovalsActivityPage.tsx');
const source = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../src/pages/ApprovalsActivityPage.tsx'), 'utf8');

describe('Approvals activity job plans', () => {
  it('loads durable whole-plan records and their ordered steps', () => {
    expect(source).toContain("from('bob_job_plans')");
    expect(source).toContain("from('bob_job_plan_steps')");
    expect(source).toContain("in('status', ['proposed', 'executing', 'needs_review'])");
  });

  it('uses the dedicated governed plan decision endpoint with required reasoning', () => {
    expect(source).toContain("functions.invoke('bob-job-plan-approve'");
    expect(source).toContain('plan_id: selectedPlanId');
    expect(source).toContain('reasoning: reasoning.trim()');
    expect(source).toContain("planDecision === 'approve' ? 'Approve plan' : 'Reject plan'");
  });
});

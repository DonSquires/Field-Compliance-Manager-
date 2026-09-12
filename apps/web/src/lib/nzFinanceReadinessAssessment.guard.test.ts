import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912133000_nz_finance_readiness_assessment.sql'), 'utf8');

describe('NZ finance readiness assessment', () => {
  it('measures all six official finance references without claiming compliance', () => {
    for (const source of ['ird-gst-overview', 'ird-gst-records', 'ird-employers', 'ird-provisional-tax', 'ird-payroll', 'xrb-nz-accounting-standards']) {
      expect(migration).toContain(`'${source}'`);
    }
    expect(migration).toContain("status IN ('ready','partial','gap','not_assessed')");
    expect(migration).toContain('overall_score');
  });

  it('records Bob capabilities separately from human or provider responsibilities', () => {
    expect(migration).toContain('bob_can_do');
    expect(migration).toContain('human_or_provider_needed');
    expect(migration).toContain('payday-file generation, submission, response, or correction workflow');
    expect(migration).toContain('general-ledger journals, statutory statements');
  });

  it('uses an organization-scoped, repeatable, audited assessment path', () => {
    expect(migration).toContain('assess_bob_nz_finance_readiness()');
    expect(migration).toContain('org_access_allowed(organization_id)');
    expect(migration).toContain('ON CONFLICT (organization_id, source_key) DO UPDATE');
    expect(migration).toContain('measured_at timestamptz');
  });
});

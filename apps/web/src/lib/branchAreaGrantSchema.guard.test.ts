import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005700_grant_branch_area_access.sql'), 'utf8');

describe('branch area grant issuance', () => {
  it('permits local operating authorities but excludes payroll and formal discipline', () => {
    expect(migration).toContain("'timesheet_local_review'");
    expect(migration).toContain("'hr_case_local_investigate'");
    expect(migration).not.toContain('payroll_finalize_corporate');
    expect(migration).not.toContain('hr_formal_discipline_corporate');
  });

  it('requires manager scope, active branch staff assignment, and an audit reason', () => {
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage');
    expect(migration).toContain("assignment.status='active'");
    expect(migration).toContain("'A change reason is required'");
    expect(migration).toContain("'branch_area_grant_created'");
  });
});
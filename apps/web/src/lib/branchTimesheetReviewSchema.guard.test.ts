import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005500_branch_timesheet_review.sql'), 'utf8');

describe('branch timesheet review', () => {
  it('requires branch review before corporate payroll approval', () => {
    expect(migration).toContain("'branch_checked'");
    expect(migration).toContain('review_branch_timesheet');
    expect(migration).toContain("v_sheet.status<>'branch_checked'");
    expect(migration).toContain("'Corporate payroll approval required'");
  });

  it('records the acting branch and requires an authorized manager', () => {
    expect(migration).toContain('branch_reviewed_organization_id');
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage');
    expect(migration).toContain("'timesheet_returned_for_correction'");
  });
});
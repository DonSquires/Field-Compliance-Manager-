import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005600_branch_leave_review.sql'), 'utf8');

describe('branch leave review', () => {
  it('requires branch review before roster-affecting corporate leave approval', () => {
    expect(migration).toContain("'branch_checked'");
    expect(migration).toContain('review_branch_leave_request');
    expect(migration).toContain("'Corporate leave approval required'");
    expect(migration).toContain("'A different corporate reviewer must approve this leave request'");
  });

  it('keeps local review branch-scoped and records it for audit', () => {
    expect(migration).toContain('get_branch_leave_queue');
    expect(migration).toContain('branch_reviewed_organization_id');
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage');
  });
});
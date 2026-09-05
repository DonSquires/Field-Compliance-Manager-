import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260905005800_enforce_branch_workforce_authority.sql'), 'utf8');

describe('branch workforce authority enforcement', () => {
  it('accepts either a branch manager or an active delegated functional grant', () => {
    expect(migration).toContain('staff_branch_authorisation_manager_can_manage');
    expect(migration).toContain('resolve_access_grants');
    expect(migration).toContain("assignment.status='active'");
  });

  it('binds leave and timesheet review to their respective local authorities', () => {
    expect(migration).toContain("'timesheet_local_review'");
    expect(migration).toContain("'leave_branch_approve'");
  });

  it('uses the same delegated authorities to scope branch queues', () => {
    expect(migration).toContain('get_branch_timesheet_queue');
    expect(migration).toContain('get_branch_leave_queue');
  });
});
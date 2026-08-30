import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830092000_dispatch_resource_lifecycle.sql'), 'utf8');

describe('dispatch resource lifecycle schema', () => {
  it('locks available resources and validates the rostered officer during assignment', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain("v_resource.status <> 'available'");
    expect(migration).toContain('v_shift.officer_user_id <> v_resource.assigned_officer_id');
    expect(migration).toContain("set status = 'busy'");
  });

  it('race-checks lifecycle transitions and releases terminal resources', () => {
    expect(migration).toContain('v_job.status <> p_expected_status');
    expect(migration).toContain('Invalid dispatch transition');
    expect(migration).toContain("p_next_status in ('completed', 'cancelled')");
    expect(migration).toContain("set status = 'available'");
    expect(migration).toContain('Outcome notes are required for terminal dispatch transitions');
  });

  it('authorizes only org admins or the officer assigned to the resource', () => {
    expect(migration).toContain('public.is_admin_for_org(v_job.organization_id)');
    expect(migration).toContain('dr.assigned_officer_id = auth.uid()');
  });
});
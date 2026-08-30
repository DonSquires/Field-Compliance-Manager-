import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830123000_claim_shift_coverage.sql'), 'utf8');

describe('shift coverage claim lifecycle', () => {
  it('derives claimant identity and requires an active officer profile', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain("role in ('officer', 'admin_officer')");
    expect(migration).not.toContain('p_officer_id');
  });
  it('locks and race-checks the open request in the officer organization', () => {
    expect(migration).toContain('for update');
    expect(migration).toContain('v_request.status <> p_expected_status');
    expect(migration).toContain('v_request.organization_id <> v_profile.organization_id');
  });
  it('records the self-owned claim and audit event atomically', () => {
    expect(migration).toContain('claimed_by = v_user_id');
    expect(migration).toContain("'shift_coverage_claimed'");
  });
});
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260830137000_govern_staff_readiness.sql'), 'utf8');
const startDateReadinessSql = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261010110000_require_staff_start_date_for_readiness.sql'), 'utf8');
const schema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');

describe('governed staff readiness', () => {
  it('derives hard blockers from identity, employment, and field credentials', () => {
    expect(sql).toContain("up.deactivated_at is not null");
    expect(startDateReadinessSql).toContain("WHEN sp.start_date IS NULL THEN 'missing_start_date'");
    expect(startDateReadinessSql).toContain("THEN 'Employment start date is not set'");
    expect(sql).toContain("sp.end_date is not null and sp.end_date<current_date");
    expect(sql).toContain('No verified current credential');
  });

  it('keeps training as advisory until role requirements exist', () => {
    expect(sql).toContain('public.staff_training_records');
    expect(sql).toContain("then 'attention' else 'clear'");
    expect(sql).not.toContain("'Training is required'");
  });

  it('race-checks, requires notes, and audits readiness changes', () => {
    expect(sql).toContain('v_staff.work_ready<>p_expected_work_ready');
    expect(sql).toContain('Readiness review notes are required');
    expect(sql).toContain("'staff_work_ready_enabled'");
    expect(sql).toContain("'staff_work_ready_disabled'");
  });

  it('closes direct authenticated profile writes', () => {
    expect(sql).toContain('drop policy if exists staff_profiles_update');
    expect(sql).toContain('revoke insert,update,delete on public.staff_profiles');
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION "public"\."get_staff_readiness_assessment"/);
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION "public"\."set_staff_work_readiness"/);
  });
});
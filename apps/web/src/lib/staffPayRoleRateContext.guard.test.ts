import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20260905001000_staff_pay_role_rate_context.sql'),
  'utf8',
);

describe('staff pay-role rate context', () => {
  it('keeps payroll role separate from application access role', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS role_code text');
    expect(migration).toContain("code.code_type = 'role_code'");
    expect(migration).toContain('Pay role code must be an active organization role code');
  });

  it('assigns pay roles only through an authorized, optimistic-concurrency RPC', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.set_staff_pay_role_code');
    expect(migration).toContain('for update;');
    expect(migration).toContain("if not public.is_admin_for_org(v_staff.organization_id) then");
    expect(migration).toContain('if v_staff.role_code is distinct from');
    expect(migration).toContain("'staff_pay_role_set'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.set_staff_pay_role_code');
  });

  it('uses assigned staff role context in actual dispatch pay and roster forecasting', () => {
    expect(migration).toContain('select staff.role_code into v_role_code from public.staff_profiles staff');
    expect(migration).toContain('null, v_role_code, v_distance, p_day_category, \'hourly\'');
    expect(migration).toContain('null, v_role_code, v_distance, p_day_category, \'per_km\'');
    expect(migration).toContain('left join public.staff_profiles staff on staff.id = s.staff_id');
    expect(migration).toContain('staff.role_code, null, null, \'hourly\') pay on true');
  });

  it('preserves the staff role code on unresolved evidence and in audit provenance', () => {
    expect(migration).toContain("'UNRESOLVED'");
    expect(migration).toContain('v_distance_reason, v_role_code, v_job.job_type');
    expect(migration).toContain("'role_code', v_role_code");
  });
});

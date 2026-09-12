import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912130000_finance_actual_labour_costs.sql'), 'utf8');

describe('finance actual labour costs', () => {
  it('links approved timesheets to finance service costs with a unique posting', () => {
    expect(migration).toContain('finance_labour_cost_postings');
    expect(migration).toContain('timesheet_id uuid NOT NULL UNIQUE REFERENCES public.timesheets');
    expect(migration).toContain('finance_service_cost_id uuid NOT NULL UNIQUE REFERENCES public.finance_service_costs');
    expect(migration).toContain("source_document_type, source_reference");
  });

  it('resolves and snapshots the applicable staff pay rate', () => {
    expect(migration).toContain("r.rule_kind = 'pay'");
    expect(migration).toContain("r.rate_type = 'hourly'");
    expect(migration).toContain('r.role_code = v_staff.role_code');
    expect(migration).toContain("rate_status IN ('resolved','unresolved')");
    expect(migration).toContain("'rate_rule_id', v_rate.rate_rule_id");
  });

  it('requires approved timesheets, open periods, tenant ownership, and audit logging', () => {
    expect(migration).toContain("v_sheet.status NOT IN ('approved','paid')");
    expect(migration).toContain("v_period.status IN ('closed','archived')");
    expect(migration).toContain('Only approved or paid timesheets can be posted');
    expect(migration).toContain('post_finance_timesheet_labour_cost');
    expect(migration).toContain('finance_timesheet_labour_cost_posted');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.post_finance_timesheet_labour_cost');
  });
});

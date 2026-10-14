import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912130000_finance_actual_labour_costs.sql'), 'utf8');
const hardening = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261014191830_harden_finance_timesheet_labour_cost.sql'), 'utf8');
const liveSchema = readFileSync(resolve(process.cwd(), '../../supabase/schema.sql'), 'utf8');
const workspace = readFileSync(resolve(process.cwd(), 'src/components/FinanceLabourCostWorkspace.tsx'), 'utf8');
const moneyPage = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');

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

  it('binds posting to the timesheet shift contract and accounting period', () => {
    expect(hardening).toContain("pg_advisory_xact_lock(hashtextextended('finance-timesheet-cost:'");
    expect(hardening).toContain('Shift agreement links do not identify the same agreement');
    expect(hardening).toContain('Service agreement does not match the timesheet shift');
    expect(hardening).toContain("agreement_type = 'operational'");
    expect(hardening).toContain("invitation_status = 'accepted'");
    expect(hardening).toContain('period_start <= v_sheet.period_start');
    expect(hardening).toContain('period_end >= v_sheet.period_end');
    expect(hardening).toContain('Work unit does not match the timesheet shift');
    expect(hardening).toContain('Cost centre is not active in organization');
    expect(liveSchema).toContain('Service agreement does not match the timesheet shift');
    expect(liveSchema).toContain('P&L period must be open and contain the timesheet work period');
    expect(liveSchema).toMatch(/REVOKE ALL ON FUNCTION "public"\."post_finance_timesheet_labour_cost".*FROM PUBLIC, "anon"/);
  });

  it('offers only governed, rate-resolved posting from the finance workspace', () => {
    expect(workspace).toContain("from('timesheets')");
    expect(workspace).toContain("from('finance_labour_cost_postings')");
    expect(workspace).toContain("from('rate_rules')");
    expect(workspace).toContain("supabase.rpc('post_finance_timesheet_labour_cost'");
    expect(workspace).toContain('!selected.rate || !periodId');
    expect(workspace).not.toMatch(/from\('(finance_service_costs|finance_labour_cost_postings)'\)[\s\S]{0,500}\.(insert|update|upsert|delete)\(/);
    expect(moneyPage).toContain('<FinanceLabourCostWorkspace />');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const migration = read('../../supabase/migrations/20261018085158_govern_pay_codes_training_and_skills.sql');
const ratesPage = read('src/pages/RateRulesPage.tsx');
const hrPage = read('src/pages/RosterHRPage.tsx');
const financeWorkspace = read('src/components/FinanceLabourCostWorkspace.tsx');

describe('pay, training, and skills operational workflow', () => {
  it('governs organization pay codes and backfills existing pay-rule codes', () => {
    expect(migration).toContain("code_type,\n  code,\n  name");
    expect(migration).toContain("'pay_item'");
    expect(migration).toContain('ON CONFLICT (organization_id, code_type, code) DO NOTHING');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.manage_pay_code');
    expect(migration).toContain("'pay_code_created'");
    expect(migration).toContain("'pay_code_deactivated'");
    expect(migration).toContain('Deactivate or move every active pay rule using this pay code first');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.manage_pay_code');
  });

  it('requires a governed active pay code on each staff pay rule', () => {
    expect(migration).toContain("code.code_type = 'pay_item'");
    expect(migration).toContain('Choose an active payroll pay code before saving a pay rule');
    expect(migration).toContain("'pay_code', v_rule.pay_code");
    expect(ratesPage).toContain("supabase.rpc('manage_pay_code'");
    expect(ratesPage).toContain('Payroll pay code');
    expect(ratesPage).toContain("form.kind === 'pay' && !form.payCode");
  });

  it('reports the cross-screen payroll setup state for the selected operating branch', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_payroll_setup_readiness');
    expect(migration).toContain("'unassigned_staff_count'");
    expect(migration).toContain("'rules_without_active_pay_code'");
    expect(migration).toContain("'specific_rule_count'");
    expect(migration).toContain("'fallback_rule_count'");
    expect(ratesPage).toContain("supabase.rpc('get_payroll_setup_readiness'");
    expect(ratesPage).toContain('Roles, pay codes, and branch rules');
  });

  it('records immutable, idempotent training evidence and preserves renewals', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS client_request_id uuid');
    expect(migration).toContain('supersedes_training_record_id uuid');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.record_staff_training');
    expect(migration).toContain('Training expiry cannot precede completion');
    expect(migration).toContain("'staff_training_renewed'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_staff_training');
    expect(hrPage).toContain("supabase.rpc('record_staff_training'");
    expect(hrPage).toContain('The previous training evidence remains unchanged for audit.');
  });

  it('updates canonical staff skills without creating repeat assignments', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtextextended(p_staff_id::text || ':' || p_skill_id::text");
    expect(migration).toContain("'roster_staff_skill_updated'");
    expect(migration).toContain("p_proficiency_level NOT IN ('basic', 'competent', 'proficient', 'expert')");
    expect(hrPage).toContain("supabase.rpc('assign_roster_skill_to_staff'");
    expect(hrPage).toContain('Qualified work-unit assignments will remain blocked');
  });

  it('uses the selected branch for finance while preserving server-owned posting', () => {
    expect(financeWorkspace).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(financeWorkspace).toContain("select('id,amount,pay_code,role_code");
    expect(financeWorkspace).toContain("supabase.rpc('post_finance_timesheet_labour_cost'");
    expect(financeWorkspace).toContain('Open pay and charge rules');
    expect(financeWorkspace).not.toMatch(/from\('(finance_service_costs|finance_labour_cost_postings)'\)[\s\S]{0,500}\.(insert|update|upsert|delete)\(/);
  });
});

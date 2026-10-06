import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const local = resolve(process.cwd(), 'supabase/migrations/20260904210000_govern_rate_rules.sql');
const sql = readFileSync(existsSync(local) ? local : resolve(process.cwd(), '../../supabase/migrations/20260904210000_govern_rate_rules.sql'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/RateRulesPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const payrollWorkflow = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261006084652_payroll_role_code_lifecycle_and_rate_rules.sql'), 'utf8');

describe('governed rate rule management', () => {
  it('replaces direct browser writes with one audited expected-state RPC', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS rate_rules_write');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.rate_rules');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.manage_rate_rule');
    expect(sql).toContain('Rate rule changed since it was opened');
    expect(sql).toContain("'rate_rule_managed'");
  });
  it('exposes create, update, and activate/deactivate only through the governed RPC', () => {
    expect(page).toContain("supabase.rpc('manage_operating_branch_rate_rule'");
    expect(page).toContain("p_action: 'update'");
    expect(page).toContain('p_expected_updated_at: editingRule.updated_at');
    expect(page).toContain('Edit rule');
    expect(page).toContain("supabase.rpc('resolve_dispatch_job_pay_lines'");
    expect(page).toContain('Finished jobs that still need a pay or charge rule');
    expect(page).not.toContain(".from('rate_rules').insert");
    expect(page).not.toContain(".from('rate_rules').update");
  });
  it('is routed through the admin finance navigation', () => {
    expect(shell).toContain("'rate-rules'");
    expect(shell).toContain('RateRulesPage');
  });

  it('creates and retires payroll codes through an audited organization-admin RPC', () => {
    expect(payrollWorkflow).toContain('CREATE OR REPLACE FUNCTION public.manage_pay_role_code');
    expect(payrollWorkflow).toContain("profile.role IN ('grand_master', 'master', 'admin')");
    expect(payrollWorkflow).toContain("'pay_role_code_created'");
    expect(payrollWorkflow).toContain("'pay_role_code_deactivated'");
    expect(payrollWorkflow).toContain('Remove this payroll role from all staff before deactivating it');
    expect(payrollWorkflow).toContain('REVOKE ALL ON FUNCTION public.manage_pay_role_code');
  });

  it('persists role-specific branch pay rules and validates active payroll codes', () => {
    expect(payrollWorkflow).toContain('p_role_code text DEFAULT NULL');
    expect(payrollWorkflow).toContain('role_code = CASE WHEN v_rule_kind');
    expect(payrollWorkflow).toContain('v_role_code,');
    expect(payrollWorkflow).toContain('Pay role code must be active in your payroll organisation');
    expect(payrollWorkflow).toContain("'role_code', v_rule.role_code");
  });
});

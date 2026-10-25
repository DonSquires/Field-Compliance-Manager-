import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(resolve(process.cwd(), 'src/components/FinancePeriodBillingBasisPanel.tsx'), 'utf8');
const dashboard = readFileSync(resolve(process.cwd(), 'src/components/FinanceOperationsDashboard.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261025120000_finance_period_billing_basis.sql'), 'utf8');

describe('finance period Contract and Extra split', () => {
  it('reads the split through the read-only period RPC and never writes finance rows', () => {
    expect(panel).toContain("supabase.rpc('get_finance_pl_period_billing_basis', { p_pl_period_id: periodId })");
    expect(panel).not.toMatch(/\.from\(/);
    expect(migration).toContain('RETURNS jsonb');
    expect(migration).toMatch(/get_finance_pl_period_billing_basis[\s\S]*STABLE[\s\S]*Active finance administrator required/);
    expect(migration).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+public\.finance_service_costs/i);
  });

  it('keeps one classification rule for the agreement tab and the finance period', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.classify_patrol_cost_row_billing_basis');
    expect(migration.match(/public\.classify_patrol_cost_row_billing_basis\(v_/g)?.length).toBe(2);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.classify_patrol_cost_row_billing_basis(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('shows every state and explains what needs a decision', () => {
    for (const text of [
      'Choose a money check period to see the Contract and Extra split.',
      'Loading the Contract and Extra split',
      'Contract and Extra split unavailable',
      'No service cost has been recorded in this period yet.',
      'Not classified',
      'Needs a Contract or Extra decision',
      'The workbook TYPE was used',
      'no agreement price recorded',
      'not invoiced revenue',
      'Contract and Extra by agreement',
    ]) expect(panel).toContain(text);
    expect(panel).toContain('role="alert"');
    expect(panel).toContain('aria-busy="true"');
    expect(panel).toContain('aria-expanded={showAll}');
  });

  it('is rendered in the finance dashboard for the selected period, including the compact overview', () => {
    expect(dashboard).toContain("import { FinancePeriodBillingBasisPanel } from './FinancePeriodBillingBasisPanel';");
    expect(dashboard).toContain('<FinancePeriodBillingBasisPanel periodId={period?.id ?? null} />');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync(resolve(process.cwd(), 'src/components/FinanceBudgetWorkspace.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceMoneyPage.tsx'), 'utf8');
const rollMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261013200051_make_cost_centre_rolls_idempotent.sql'), 'utf8');

describe('finance budget workspace', () => {
  it('wires the governed budget lifecycle into the finance money page', () => {
    expect(page).toContain('<FinanceBudgetWorkspace />');
    expect(workspace).toContain("supabase.rpc('create_finance_budget'");
    expect(workspace).toContain("supabase.rpc('add_finance_budget_line'");
    expect(workspace).toContain("supabase.rpc('approve_finance_budget'");
    expect(workspace).toContain("supabase.rpc('calculate_finance_budget_variance'");
    expect(workspace).toContain("supabase.rpc('calculate_cost_centre_roll'");
  });

  it('shows persisted budgets and requires explicit approval confirmation', () => {
    expect(workspace).toContain("from('finance_budgets')");
    expect(workspace).toContain("from('finance_budget_lines')");
    expect(workspace).toContain("from('finance_pl_periods')");
    expect(workspace).toContain('confirmApproval');
    expect(workspace).toContain('Approval locks this draft');
    expect(workspace).toContain('Existing variance and cost-centre roll rows are updated rather than duplicated.');
  });

  it('makes repeated cost-centre calculations atomic and replay-safe', () => {
    expect(rollMigration).toContain('UNIQUE (organization_id, pl_period_id, cost_centre_id)');
    expect(rollMigration).toContain('ON CONFLICT (organization_id, pl_period_id, cost_centre_id)');
    expect(rollMigration).toContain('DO UPDATE SET');
  });
});

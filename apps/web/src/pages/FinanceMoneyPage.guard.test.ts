import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const page = read('src/pages/FinanceMoneyPage.tsx');
const css = read('src/pages/FinanceHome.css');
const control = read('src/components/FinanceControlPanel.tsx');
const labour = read('src/components/FinanceLabourCostWorkspace.tsx');
const budgets = read('src/components/FinanceBudgetWorkspace.tsx');

describe('finance command workbench', () => {
  it('renders only the selected workflow and one live accounting-period summary', () => {
    for (const workflow of ['overview', 'invoices', 'reconciliation', 'labour', 'budgets', 'guide']) {
      expect(page).toContain(`workflow === '${workflow}' &&`);
    }
    expect(page).toContain('aria-label="Active accounting period"');
    expect(page).toContain("supabase.rpc('get_finance_pl_period_summary', { p_pl_period_id: periodId })");
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(page).toContain('<dt>Net</dt>');
    expect(page).toContain('<dt>Earned</dt>');
    expect(page).toContain('<dt>Costs</dt>');
    expect(page).toContain("setSummary(null)");
  });

  it('keeps accounting controls in sync without conflating tax and fiscal years', () => {
    expect(page).toContain('<FinanceBudgetWorkspace activePeriodId={periodId}');
    expect(page).toContain('<FinanceLabourCostWorkspace activePeriodId={periodId}');
    expect(control).toContain("Tax filing dates are independent of the active accounting period.");
    expect(control).toContain("p_tax_period_id: taxPeriodId");
    expect(budgets).toContain('Budget fiscal years remain independent.');
    expect(budgets).toContain('p_fiscal_year: fiscalYear');
    expect(labour).toContain('!availablePeriods.some((period) => period.id === periodId)');
    expect(control).toContain("setUnitCost(selection.unitCost === null ? ''");
    expect(control).toContain('Enter a valid quantity and evidenced unit cost.');
  });

  it('contains the desktop viewport and gives mobile controls touch targets and explicit contrast', () => {
    expect(css).toContain('grid-template-columns: 280px minmax(0, 1fr)');
    expect(css).toContain('flex: 0 0 40px');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('.finance-control-centre .btn.btn-primary { color: #fff; background: #1e40af; border-color: #475569; }');
    expect(css).toContain('.finance-control-centre .btn.btn-secondary { color: #f8fafc; background: #1e293b; border-color: #475569; }');
    expect(css).toContain('aria-current="page"');
  });
});

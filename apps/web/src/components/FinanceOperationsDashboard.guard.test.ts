import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceOperationsDashboard.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/FinanceBureauPage.tsx'), 'utf8');

describe('Finance operations dashboard', () => {
  it('reads the finance control surfaces through tenant-scoped Supabase queries', () => {
    for (const table of ['finance_pl_periods', 'finance_pl_snapshots', 'finance_tax_periods', 'finance_budget_variances', 'payment_receipts']) {
      expect(component).toContain(`from('${table}')`);
      expect(component).toContain(".eq('organization_id', profile.organizationId)");
    }
    expect(component).not.toMatch(/\.from\(['"]finance_[^'"].*['"]\)\.insert/);
  });

  it('exposes P&L, GST, budget, and reconciliation signals with safe states', () => {
    expect(component).toContain('What is happening with my money?');
    expect(component).toContain('Money left after costs');
    expect(component).toContain('Tax money to plan for');
    expect(component).toContain('Payments to sort');
    expect(component).toContain('Finance dashboard unavailable');
    expect(component).toContain('No money check configured');
  });

  it('is integrated into the existing Finance Bureau page', () => {
    expect(page).toContain("import { FinanceOperationsDashboard } from '../components/FinanceOperationsDashboard';");
    expect(page).toContain('<FinanceOperationsDashboard />');
  });
});

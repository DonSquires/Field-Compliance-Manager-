import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(resolve(process.cwd(), 'src/components/FinanceCostingPanel.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260911110000_finance_cost_model_foundation.sql'), 'utf8');

describe('finance costing panel', () => {
  it('collects original cost facts and uses the governed server calculator', () => {
    for (const label of ['Gear purchase cost', 'Expected resale value', 'How many months it will be used', 'Fuel and running cost/km', 'Holiday/leave allowance %']) expect(panel).toContain(label);
    expect(panel).toContain("supabase.rpc('calculate_finance_quote_cost'");
    expect(panel).toContain('Calculate job cost');
  });

  it('exposes calculated cost and margin outputs', () => {
    for (const output of ['Real cost', 'Price to customer', 'Left after costs', 'Gear cost per year']) expect(panel).toContain(output);
    expect(migration).toContain("'depreciation_annual'");
    expect(migration).toContain("'approval_required', true");
  });

  it('uses the cited three-month fuel median only as an explicit internal-cost suggestion', () => {
    for (const label of ['Fuel use (L/100km)', 'Other running cost/km', 'Use suggested internal cost']) expect(panel).toContain(label);
    expect(panel).toContain("supabase.rpc('get_median_fuel_price'");
    expect(panel).toContain('p_months: 3');
    expect(panel).toContain('does not change the IRD $1.04/km customer charge');
  });
});

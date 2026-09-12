import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912121000_finance_variance_and_profitability.sql'), 'utf8');

describe('finance variance and profitability analytics', () => {
  it('models service profitability, cost centre rolls, and variance exceptions', () => {
    for (const table of ['finance_service_profitability', 'finance_cost_centre_rolls', 'finance_variance_exceptions']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain('labour_variance_pct numeric(5,2)');
    expect(migration).toContain('vehicle_variance_pct numeric(5,2)');
    expect(migration).toContain('margin_impact_pct numeric(5,2)');
  });

  it('captures estimated vs actual cost by category (labour, vehicle, materials, overhead)', () => {
    expect(migration).toContain('estimated_labour');
    expect(migration).toContain('actual_labour');
    expect(migration).toContain('estimated_vehicle');
    expect(migration).toContain('actual_vehicle');
    expect(migration).toContain('estimated_overhead');
    expect(migration).toContain('actual_overhead');
    expect(migration).toContain('actual_margin_pct numeric(5,2)');
  });

  it('calculates profitability snapshots and cost centre rolls as admin-only operations', () => {
    expect(migration).toContain('calculate_service_profitability_snapshot(p_pl_period_id uuid)');
    expect(migration).toContain('calculate_cost_centre_roll(p_pl_period_id uuid)');
    expect(migration).toContain('FULL JOIN actual_costs');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.calculate_service_profitability_snapshot');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.calculate_cost_centre_roll');
  });

  it('governs variance exceptions with severity levels (info, warning, critical)', () => {
    expect(migration).toContain("exception_type text NOT NULL CHECK (exception_type IN ('unfavourable_variance','favourable_variance','missing_cost','missing_revenue','policy_violation'))");
    expect(migration).toContain("severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical'))");
  });
});

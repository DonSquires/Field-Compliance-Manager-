import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912125000_finance_budgets_and_forecast_controls.sql'), 'utf8');

describe('finance budgets and forecast controls', () => {
  it('models versioned budgets, budget lines, and persisted variances', () => {
    for (const table of ['finance_budgets', 'finance_budget_lines', 'finance_budget_variances']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain("status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','locked','superseded'))");
    expect(migration).toContain('supersedes_id uuid REFERENCES public.finance_budgets');
    expect(migration).toContain("status text NOT NULL CHECK (status IN ('on_track','watch','over_budget','no_budget'))");
  });

  it('supports cost-centre and service-level budget attribution', () => {
    expect(migration).toContain('cost_centre_id uuid REFERENCES public.cost_centres');
    expect(migration).toContain('service_agreement_id uuid REFERENCES public.service_agreements');
    expect(migration).toContain('finance_service_costs');
    expect(migration).toContain('FULL JOIN');
  });

  it('requires governed approval and protects closed periods', () => {
    expect(migration).toContain('create_finance_budget');
    expect(migration).toContain('add_finance_budget_line');
    expect(migration).toContain('approve_finance_budget');
    expect(migration).toContain("v_period.status IN ('closed','archived')");
    expect(migration).toContain('Budget requires at least one line');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.approve_finance_budget');
  });
});

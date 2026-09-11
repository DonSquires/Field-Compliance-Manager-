import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260911110000_finance_cost_model_foundation.sql'), 'utf8');

describe('finance cost model foundation', () => {
  it('stores versioned assumptions and asset depreciation schedules', () => {
    for (const table of ['finance_cost_categories', 'finance_cost_assumptions', 'finance_asset_cost_profiles', 'finance_asset_depreciation_schedules']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain('depreciation_method');
    expect(migration).toContain('residual_value <= acquisition_cost + setup_cost');
    expect(migration).toContain('UNIQUE (organization_id, asset_id, version)');
  });

  it('keeps finance reads tenant-scoped and writes service-governed', () => {
    expect(migration).toContain('public.org_access_allowed(organization_id)');
    expect(migration).toContain('GRANT SELECT ON TABLE public.finance_cost_categories');
    expect(migration).toContain('GRANT ALL ON TABLE public.finance_cost_categories');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.calculate_finance_quote_cost(jsonb) FROM PUBLIC, anon');
  });

  it('calculates loaded labour, vehicle travel, overhead, charge, and margin on the server', () => {
    expect(migration).toContain('calculate_finance_quote_cost(p_inputs jsonb)');
    expect(migration).toContain("'loaded_labour'");
    expect(migration).toContain("'vehicle_travel'");
    expect(migration).toContain("'allocated_overhead'");
    expect(migration).toContain("'gross_margin_pct'");
    expect(migration).toContain("'approval_required', true");
  });
});

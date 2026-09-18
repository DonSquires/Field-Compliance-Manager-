import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'apps/web/src')) ? resolve(process.cwd(), 'apps/web') : process.cwd();
const repoRoot = existsSync(resolve(process.cwd(), 'supabase/migrations')) ? process.cwd() : resolve(process.cwd(), '../..');
const panel = readFileSync(resolve(root, 'src/components/FuelPriceMedianPanel.tsx'), 'utf8');
const rateRules = readFileSync(resolve(root, 'src/pages/RateRulesPage.tsx'), 'utf8');
const migration = readFileSync(resolve(repoRoot, 'supabase/migrations/20260917070000_fuel_price_observations_median.sql'), 'utf8');

describe('website-backed fuel price median', () => {
  it('keeps a cited website observation and calculates a trailing three-month median', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.fuel_price_observations');
    for (const column of ['source_name', 'source_url', 'source_published_at', 'source_hash', 'observed_on', 'price_per_litre']) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_median_fuel_price(');
    expect(migration).toContain('percentile_cont(0.5) within group (order by r.price_per_litre)');
    expect(panel).toContain("p_months: 3");
    expect(panel).toContain("'record_fuel_price_observation'");
    expect(panel).toContain("'record_approved_fuel_price_observation'");
  });

  it('is scoped to the operating organisation and does not silently change the IRD per-km rule', () => {
    expect(rateRules).toContain('<FuelPriceMedianPanel organizationId={operatingOrganizationId ?? profile?.organizationId ?? null} />');
    expect(panel).toContain(".eq('organization_id', organizationId)");
    expect(migration).toContain('it never overwrites the IRD kilometre-rate charge rule');
    expect(panel).toContain('does not automatically change the IRD $1.04/km customer charge');
  });

  it('requires a source and records through the governed RPC rather than directly writing the table', () => {
    expect(migration).toContain("raise exception 'Source name and URL are required'");
    expect(migration).toContain("raise exception 'Active organisation administrator required'");
    expect(panel).not.toContain("from('fuel_price_observations').insert");
    expect(panel).toContain('Source URL');
    expect(panel).toContain('This records the citation with the price');
    expect(panel).toContain("supabase.rpc('manage_fuel_price_source'");
  });
});

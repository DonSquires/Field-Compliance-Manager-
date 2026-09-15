import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemToSelection, rateToSelection } from '../lib/priceList';

const picker = readFileSync(resolve(process.cwd(), 'src/components/PriceListPicker.tsx'), 'utf8');
const priceBook = readFileSync(resolve(process.cwd(), 'src/components/PriceBookPanel.tsx'), 'utf8');
const crm = readFileSync(resolve(process.cwd(), 'src/pages/CRMPage.tsx'), 'utf8');
const control = readFileSync(resolve(process.cwd(), 'src/components/FinanceControlPanel.tsx'), 'utf8');
const rateRules = readFileSync(resolve(process.cwd(), 'src/pages/RateRulesPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260915140000_price_book_and_job_completion_financials.sql'), 'utf8');

describe('price list, price book, and live job financials', () => {
  it('reads the price list from rate_rules and the finance_price_book view only', () => {
    expect(picker).toContain("supabase.from('rate_rules')");
    expect(picker).toContain("supabase.from('finance_price_book')");
    expect(picker).not.toMatch(/\.rpc\(|\.insert\(|\.update\(/);
  });

  it('turns a rate or an item into a ready-to-use line without inventing a cost', () => {
    const rate = rateToSelection({ id: 'r1', organization_id: 'o', name: 'Patrolling (per hour)', rate_type: 'hourly', amount: 54.1, service_type: 'patrol', rule_kind: 'billing' }, [
      { id: 'p1', organization_id: 'o', name: 'Officer pay', rate_type: 'hourly', amount: 30, service_type: 'patrol', rule_kind: 'pay' },
    ]);
    expect(rate).toMatchObject({ kind: 'labour', costType: 'labour', unit: 'hour', unitCharge: 54.1, unitCost: 30 });
    const travel = rateToSelection({ id: 'r2', organization_id: 'o', name: 'Travel (per km)', rate_type: 'per_km', amount: 1.04, service_type: null, rule_kind: 'billing' }, []);
    expect(travel).toMatchObject({ kind: 'travel', costType: 'vehicle', unit: 'km', unitCharge: 1.04, unitCost: null });
    const item = itemToSelection({ item_id: 'i1', organization_id: 'o', sku: '33014', name: '4MP camera', item_type: 'equipment_component', unit_of_measure: 'ea', unit_cost: 139, unit_price: 180.7 });
    expect(item).toMatchObject({ kind: 'equipment', costType: 'equipment', description: '33014 · 4MP camera', unitCharge: 180.7, unitCost: 139 });
    const material = itemToSelection({ item_id: 'i2', organization_id: 'o', sku: 'POSTCRETE-BAG', name: 'Post crete bag', item_type: 'material', unit_of_measure: 'ea', unit_cost: null, unit_price: 15.6 });
    expect(material).toMatchObject({ kind: 'materials', costType: 'materials', unitCost: null });
  });

  it('quotes and job costs pick from the price list and accept materials/equipment kinds', () => {
    expect(crm).toContain('<PriceListPicker');
    expect(crm).toContain('<option value="materials">Materials</option>');
    expect(crm).toContain('<option value="equipment">Equipment</option>');
    expect(migration).toContain("if p_kind not in('labour','travel','overhead','module','custom','materials','equipment')");
    expect(control).toContain('<PriceListPicker id="job-cost-price-list"');
    expect(control).toContain('setCostType(selection.costType)');
  });

  it('price book writes only through manage_finance_item and shows cost, price, and derived margin', () => {
    expect(priceBook).toContain("supabase.from('finance_price_book')");
    expect(priceBook).toContain("supabase.rpc('manage_finance_item'");
    expect(priceBook).not.toMatch(/from\(['"]finance_item_(catalog|cost_versions|price_versions)['"]\)[\s\S]{0,200}\.(insert|update|delete)\(/);
    expect(priceBook).toContain('<th>Costs you</th><th>You charge</th><th>Margin</th>');
    expect(migration).toContain('CREATE OR REPLACE VIEW public.finance_price_book WITH (security_invoker = true)');
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.manage_finance_item_internal");
  });

  it('job completion writes pay and charge lines and never blocks on pricing', () => {
    expect(migration).toContain('perform public.resolve_dispatch_job_financials_internal(auth.uid(), gen_random_uuid(), p_job_id, null);');
    expect(migration).toContain("'dispatch_financials_auto_resolution_failed'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.dispatch_job_charge_lines');
    expect(migration).toContain("else dispatch_jobs.completed_at end");
    expect(rateRules).toContain("supabase.from('dispatch_job_charge_lines')");
    expect(rateRules).toContain('Finished jobs that still need a pay or charge rule');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260911111000_finance_inventory_and_materials.sql'), 'utf8');

describe('finance inventory and materials foundation', () => {
  it('models catalog, cost versions, stock, movements, service use, and asset links', () => {
    for (const table of ['finance_item_catalog', 'finance_item_cost_versions', 'finance_inventory_locations', 'finance_inventory_balances', 'finance_inventory_transactions', 'finance_service_item_consumption', 'finance_asset_item_links']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    for (const itemType of ['part', 'material', 'consumable', 'fuel', 'ppe']) expect(migration).toContain(`'${itemType}'`);
    expect(migration).toContain('item_cost_versions');
    expect(migration).toContain('asset_id uuid REFERENCES public.assets');
  });

  it('protects movements with organization scope, idempotency, and balance checks', () => {
    expect(migration).toContain('UNIQUE (organization_id, idempotency_key)');
    expect(migration).toContain('Insufficient available inventory');
    expect(migration).toContain('finance_inventory_transaction_recorded');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_finance_inventory_transaction');
    expect(migration).toContain('public.org_access_allowed(organization_id)');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912124000_finance_rpc_schema_compatibility.sql'), 'utf8');

describe('finance RPC schema compatibility', () => {
  it('uses canonical invoice totals when closing periods and generating statements', () => {
    expect(migration).toContain('SUM(total_amount)');
    expect(migration).not.toContain('invoice_amount');
    expect(migration).toContain('v_snapshot.total_revenue');
  });

  it('uses the canonical cost-centre code and name columns', () => {
    expect(migration).toContain('cc.code');
    expect(migration).toContain('cc.name');
    expect(migration).not.toContain('cc.cost_centre_code');
    expect(migration).not.toContain('cc.cost_centre_name');
  });
});

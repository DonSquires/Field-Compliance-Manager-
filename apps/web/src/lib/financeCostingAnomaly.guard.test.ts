import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912150000_fix_finance_costing_null_allocation.sql'), 'utf8');

describe('finance costing allocation guard', () => {
  it('fails clearly instead of returning null totals when depreciation lacks an allocation driver', () => {
    expect(migration).toContain("Vehicle productive hours are required to allocate asset depreciation");
    expect(migration).toContain('IF v_depreciation > 0 AND v_vehicle_hours <= 0');
  });
});
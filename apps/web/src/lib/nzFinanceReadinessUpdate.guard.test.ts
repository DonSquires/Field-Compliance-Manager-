import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912134100_update_nz_finance_readiness_after_gap_closure.sql'), 'utf8');

describe('NZ finance readiness after gap closure', () => {
  it('moves provisional tax and payday filing from gap to partial', () => {
    expect(migration).toContain("status = 'partial', score = 45");
    expect(migration).toContain("status = 'partial', score = 40");
    expect(migration).toContain("WHERE source_key = 'ird-provisional-tax'");
    expect(migration).toContain("WHERE source_key = 'ird-payroll'");
  });

  it('keeps direct IRD filing and payment outside the platform', () => {
    expect(migration).toContain('not an IRD calculation or payment instruction');
    expect(migration).toContain('Direct IRD payday-file submission');
    expect(migration).toContain('approved payroll system/provider');
  });
});

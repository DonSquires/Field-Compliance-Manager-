import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912132200_verify_bob_nz_finance_sources.sql'), 'utf8');

describe('verified Bob NZ finance sources', () => {
  it('records the corrected live IRD URLs and retrieval date', () => {
    expect(migration).toContain('https://www.ird.govt.nz/managing-my-tax/record-keeping');
    expect(migration).toContain('https://www.ird.govt.nz/income-tax/provisional-tax');
    expect(migration).toContain("DATE '2026-09-12'");
    expect(migration).toContain("status = 'active'");
  });

  it('keeps a bounded review window', () => {
    expect(migration).toContain("review_due_on = DATE '2026-10-12'");
    expect(migration).toContain("DATE '2026-12-11'");
    expect(migration).toContain("CASE WHEN topic = 'accounting_standards'");
  });
});

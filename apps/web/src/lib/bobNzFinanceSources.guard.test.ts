import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912132000_bob_nz_finance_sources.sql'), 'utf8');

describe('Bob NZ finance source register', () => {
  it('registers authoritative NZ finance sources by topic', () => {
    expect(migration).toContain('bob_nz_finance_sources');
    for (const topic of ['gst', 'employers', 'provisional_tax', 'record_keeping', 'accounting_standards', 'payroll']) {
      expect(migration).toContain(`'${topic}'`);
    }
    expect(migration).toContain('Inland Revenue New Zealand');
    expect(migration).toContain('External Reporting Board New Zealand');
  });

  it('fails closed until sources are verified and exposes review dates', () => {
    expect(migration).toContain("status text NOT NULL DEFAULT 'verify_before_relying'");
    expect(migration).toContain('last_verified_on date');
    expect(migration).toContain('review_due_on date');
    expect(migration).toContain('get_bob_nz_finance_sources');
    expect(migration).toContain('ON CONFLICT (source_key) DO UPDATE');
  });
});

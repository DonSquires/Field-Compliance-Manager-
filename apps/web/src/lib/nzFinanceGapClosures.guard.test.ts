import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912134000_nz_payday_and_provisional_tax_plans.sql'), 'utf8');

describe('NZ finance gap closures', () => {
  it('creates a payroll-provider handoff package without claiming IRD submission', () => {
    expect(migration).toContain('finance_payday_filing_packages');
    expect(migration).toContain('prepare_nz_payday_filing_package');
    expect(migration).toContain("'handoff_only', true");
    expect(migration).toContain("'submission_supported', false");
    expect(migration).toContain('Import into an approved NZ payroll provider');
  });

  it('creates provisional-tax scenarios with source verification and explicit assumptions', () => {
    expect(migration).toContain('finance_provisional_tax_plans');
    expect(migration).toContain('prepare_provisional_tax_scenario');
    expect(migration).toContain("status = 'active' AND last_verified_on IS NOT NULL");
    expect(migration).toContain("'not_an_ird_calculation', true");
    expect(migration).toContain("'not_a_payment_instruction', true");
  });

  it('keeps both gap closures tenant-scoped and governed', () => {
    expect(migration).toContain('is_admin_for_org(v_org)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_nz_payday_filing_package');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_provisional_tax_scenario');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912140000_ird_tax_identity_setup.sql'), 'utf8');
const component = readFileSync(resolve(process.cwd(), 'src/components/FinanceConnectionWizard.tsx'), 'utf8');

describe('IRD tax identity setup', () => {
  it('stores the organisation IRD and GST profile through a governed RPC', () => {
    expect(migration).toContain('finance_tax_identity');
    expect(migration).toContain('save_finance_tax_identity');
    expect(migration).toContain('ird_number');
    expect(migration).toContain('gst_filing_frequency');
    expect(migration).toContain('ird_last_four');
  });

  it('keeps IRD details separate from login and submission', () => {
    expect(component).toContain('Organisation IRD number');
    expect(component).toContain('It does not sign in to myIR or submit anything.');
    expect(component).toContain('Save IRD details');
    expect(migration).toContain("setup_status IN ('owner_review','accountant_review','ready_for_provider','active')");
  });
});

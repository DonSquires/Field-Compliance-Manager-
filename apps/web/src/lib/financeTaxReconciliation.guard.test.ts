import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912123000_finance_tax_and_reconciliation_controls.sql'), 'utf8');

describe('finance tax and reconciliation controls', () => {
  it('extends the canonical invoice line table and uses canonical invoice totals', () => {
    expect(migration).toContain('ALTER TABLE public.invoice_line_items');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS service_cost_id');
    expect(migration).toContain('UPDATE public.invoice_line_items');
    expect(migration).toContain('v_invoice.total_amount');
    expect(migration).not.toContain('v_invoice.invoice_amount');
  });

  it('models GST periods, tax transactions, bank statements, and statement lines', () => {
    for (const table of ['finance_tax_periods', 'finance_tax_transactions', 'finance_bank_statements', 'finance_bank_statement_lines']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain("tax_direction text NOT NULL CHECK (tax_direction IN ('output','input','adjustment'))");
    expect(migration).toContain("reconciliation_status text NOT NULL DEFAULT 'unmatched'");
  });

  it('keeps tax preparation and bank matching governed and auditable', () => {
    expect(migration).toContain('prepare_finance_tax_period');
    expect(migration).toContain('match_finance_bank_statement_line');
    expect(migration).toContain('Statement amount does not match payment receipt');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_finance_tax_period');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.match_finance_bank_statement_line');
    expect(migration).toContain('public.org_access_allowed(organization_id)');
  });
});

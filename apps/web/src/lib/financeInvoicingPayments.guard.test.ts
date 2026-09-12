import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912122000_finance_invoicing_and_payments.sql'), 'utf8');

describe('finance invoicing and payments', () => {
  it('models invoice line items, adjustments, payments, and bank accounts', () => {
    for (const table of ['invoice_line_items', 'invoice_adjustments', 'payment_receipts', 'bank_accounts']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(migration).toContain('quote_id uuid REFERENCES public.quotes');
    expect(migration).toContain('service_cost_id uuid REFERENCES public.finance_service_costs');
    expect(migration).toContain('gross_margin_pct numeric(5,2)');
  });

  it('links invoice line items to quotes and actual service costs', () => {
    expect(migration).toContain("item_type text NOT NULL CHECK (item_type IN ('labour','vehicle','materials','equipment','overhead','depreciation','other','credit','discount','tax'))");
    expect(migration).toContain('quote_cost_item_id uuid');
    expect(migration).toContain('service_cost_id uuid');
    expect(migration).toContain('internal_cost_amount numeric(14,2)');
  });

  it('records adjustments and payment receipts with reconciliation status', () => {
    expect(migration).toContain("adjustment_type text NOT NULL CHECK (adjustment_type IN ('credit','refund','discount','writeoff','rounding'))");
    expect(migration).toContain("reconciliation_status text NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending','matched','unmatched','disputed'))");
    expect(migration).toContain('bank_statement_reference text');
  });

  it('governs payment recording and P&L statement generation as service-only functions', () => {
    expect(migration).toContain('record_payment_receipt');
    expect(migration).toContain('generate_pl_financial_statement');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_payment_receipt');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.generate_pl_financial_statement');
  });
});

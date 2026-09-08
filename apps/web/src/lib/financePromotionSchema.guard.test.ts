import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260908102000_document_promotion_proposals.sql'), 'utf8');

describe('finance promotion execution boundary', () => {
  it('requires approved finance proposals and explicit reconciled totals', () => {
    expect(migration).toContain('apply_finance_reconciliation_proposal');
    expect(migration).toContain("v_proposal.target_type <> 'finance_reconciliation' OR v_proposal.status <> 'approved'");
    expect(migration).toContain('p_total_amount <> p_subtotal + p_gst_amount');
    expect(migration).toContain('Active client organisation is required');
  });

  it('creates only draft invoices with source provenance and idempotency', () => {
    expect(migration).toContain("'draft'");
    expect(migration).toContain('Created from document promotion proposal');
    expect(migration).toContain('v_proposal.applied_target_id IS NOT NULL');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_finance_reconciliation_proposal');
  });
});
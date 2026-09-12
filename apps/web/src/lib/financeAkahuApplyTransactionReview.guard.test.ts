import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912148000_akahu_apply_transaction_review.sql'), 'utf8');
const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-transaction-review/index.ts'), 'utf8');

describe('Akahu Apply transaction review', () => {
  it('keeps reviewed transactions tenant-scoped and idempotent', () => {
    expect(migration).toContain('finance_akahu_apply_transaction_reviews');
    expect(migration).toContain('UNIQUE (report_id, external_transaction_id)');
    expect(migration).toContain("review_status text NOT NULL DEFAULT 'pending'");
    expect(edge).toContain(".eq('organization_id', profile.organization_id)");
  });

  it('records explicit decisions without silently promoting finance data', () => {
    expect(edge).not.toContain("Deno.env.get('AKAHU_APPLY_API_KEY')");
    expect(edge).toContain("decision === 'reject' ? 'rejected'");
    expect(edge).toContain('promotion_required: true');
    expect(edge).toContain('finance_akahu_apply_transactions_approved');
    expect(edge).toContain('finance_akahu_apply_transactions_rejected');
    expect(edge).toContain('reviews: reviews ?? []');
    expect(edge).not.toContain('match_finance_external_bank_transaction');
  });
});

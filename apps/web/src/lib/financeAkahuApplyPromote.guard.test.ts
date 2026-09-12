import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const edge = readFileSync(resolve(process.cwd(), '../../supabase/functions/finance-akahu-apply-promote/index.ts'), 'utf8');

describe('Akahu Apply promotion', () => {
  it('requires an organisation-owned connected bank destination', () => {
    expect(edge).toContain(".eq('organization_id', profile.organization_id)");
    expect(edge).toContain("connection.provider_type !== 'bank'");
    expect(edge).toContain("['connected', 'needs_review'].includes(connection.status)");
    expect(edge).toContain('Only approved Apply review rows can be promoted');
  });

  it('promotes idempotently into the canonical review queue', () => {
    expect(edge).not.toContain("Deno.env.get('AKAHU_APPLY_API_KEY')");
    expect(edge).toContain('akahu_apply:${review.report_id}:${review.external_transaction_id}');
    expect(edge).toContain("onConflict: 'connection_request_id,external_transaction_id'");
    expect(edge).toContain("reconciliation_status: 'review'");
    expect(edge).toContain('payment_matching_required: true');
    expect(edge).toContain('finance_akahu_apply_transactions_promoted');
  });
});

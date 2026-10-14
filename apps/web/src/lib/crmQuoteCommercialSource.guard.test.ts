import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../supabase/migrations/20261014214350_harden_crm_quote_commercial_source.sql',
  ),
  'utf8',
);

describe('governed CRM quote commercial provenance', () => {
  it('serializes changes against the expected draft quote state', () => {
    expect(migration).toContain('WHERE id = p_quote_id');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('v_quote.status <> p_expected_status');
    expect(migration).toContain("v_quote.status <> 'draft'");
    expect(migration).toContain('public.is_admin_for_org(v_quote.provider_org_id)');
  });

  it('accepts only commercial sources owned by the quote provider and client', () => {
    expect(migration).toContain('tender.organization_id = v_quote.provider_org_id');
    expect(migration).toContain('tender.client_organization_id = v_quote.client_org_id');
    expect(migration).toContain("tender.status IN ('in_review', 'submitted', 'awarded')");
    expect(migration).toContain('schedule.provider_organization_id = v_quote.provider_org_id');
    expect(migration).toContain("schedule.status = 'active'");
    expect(migration).toContain('schedule.effective_from <= current_date');
  });

  it('makes retries safe and records before-and-after provenance', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_quote_commercial_source_request',
    );
    expect(migration).toContain(
      "a.metadata->>'client_request_id' = p_client_request_id::text",
    );
    expect(migration).toContain("'previous_tender_id', v_previous_tender_id");
    expect(migration).toContain("'tender_id', p_tender_id");
    expect(migration).toContain(
      "'previous_discount_schedule_id', v_previous_discount_schedule_id",
    );
    expect(migration).toContain("'discount_schedule_id', p_discount_schedule_id");
  });

  it('keeps the security-definer endpoint least-privileged', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.manage_crm_quote_commercial_source',
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('TO authenticated, service_role');
  });
});

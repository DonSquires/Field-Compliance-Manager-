import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../supabase/migrations/20261014210041_harden_and_wire_crm_quote_line_updates.sql',
  ),
  'utf8',
);

describe('governed CRM quote-line correction', () => {
  it('serializes corrections against the current draft quote state', () => {
    expect(migration).toContain('WHERE q.id = p_quote_id');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('v_quote.status <> p_expected_status');
    expect(migration).toContain("v_quote.status <> 'draft'");
    expect(migration).toContain('public.is_admin_for_org(v_quote.provider_org_id)');
  });

  it('makes retries safe without changing the original line identity', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_quote_line_update_request',
    );
    expect(migration).toContain("a.action = 'crm_quote_line_updated'");
    expect(migration).toContain(
      "a.metadata->>'client_request_id' = p_client_request_id::text",
    );
    expect(migration).toContain('v_quote.total_charge,');
    expect(migration).toContain('false;');
    expect(migration).toContain('WHERE id = v_line.id');
  });

  it('recalculates totals and records before-and-after commercial evidence', () => {
    expect(migration).toContain('sum(l.quantity * l.unit_cost)');
    expect(migration).toContain('sum(l.quantity * l.unit_charge)');
    expect(migration).toContain("'previous_description', v_line.description");
    expect(migration).toContain("'previous_quantity', v_line.quantity");
    expect(migration).toContain("'previous_unit_cost', v_line.unit_cost");
    expect(migration).toContain("'previous_unit_charge', v_line.unit_charge");
    expect(migration).toContain("'crm_quote_line_updated'");
  });

  it('keeps the security-definer endpoint least-privileged', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.update_crm_quote_line',
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('TO authenticated, service_role');
  });
});

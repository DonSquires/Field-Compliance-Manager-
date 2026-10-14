import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../supabase/migrations/20261014220716_harden_and_wire_crm_agreement_obligations.sql',
  ),
  'utf8',
);
const setupDialog = readFileSync(
  resolve(process.cwd(), 'src/components/CrmAgreementSetupDialog.tsx'),
  'utf8',
);
const panel = readFileSync(
  resolve(process.cwd(), 'src/components/CrmAgreementObligationsPanel.tsx'),
  'utf8',
);

describe('governed CRM agreement obligations', () => {
  it('serializes commands on an accepted operational agreement', () => {
    expect(migration).toContain('WHERE sa.id = p_agreement_id');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('public.is_admin_for_org(v_agreement.provider_organization_id)');
    expect(migration).toContain("v_agreement.agreement_type <> 'operational'");
    expect(migration).toContain("v_agreement.invitation_status <> 'accepted'");
  });

  it('makes retries safe before optimistic concurrency checks', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_crm_agreement_obligation_request',
    );
    expect(migration).toContain(
      "a.metadata->>'client_request_id' = p_client_request_id::text",
    );
    expect(migration.indexOf("a.metadata->>'client_request_id'")).toBeLessThan(
      migration.indexOf('v_obligation.updated_at IS DISTINCT FROM p_expected_updated_at'),
    );
    expect(migration).toContain("'previous', v_previous");
    expect(migration).toContain("'result', jsonb_build_object(");
  });

  it('validates covered Sites, evidence types, and explicit patrol cadence', () => {
    expect(migration).toContain("sal.status = 'active'");
    expect(migration).toContain("'photo', 'gps_track', 'report', 'signature', 'timestamp', 'other'");
    expect(migration).toContain("p_obligation_type = 'patrol_frequency'");
    expect(migration).toContain("'shift', 'day', 'week', 'month'");
    expect(migration).toContain("'Frequency rule is only valid for patrol frequency obligations'");
  });

  it('keeps the security-definer endpoint least-privileged', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.manage_crm_agreement_obligation',
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('TO authenticated, service_role');
  });

  it('places the workflow inside agreement setup with explicit automation boundaries', () => {
    expect(setupDialog).toContain('CrmAgreementObligationsPanel');
    expect(setupDialog).toContain("view === 'obligations'");
    expect(panel).toMatch(/supabase\.rpc\(['"]manage_crm_agreement_obligation['"]/);
    expect(panel).toContain('requestId.current');
    expect(panel).toContain('They do not create shifts, patrol stops, reports, notifications, or officer post orders by themselves.');
    expect(panel).toContain('It does not create roster work or patrol stops.');
    expect(panel).toContain('Confirm deactivate');
    expect(panel).not.toMatch(/\.from\(['"]agreement_obligations['"]\)\.(insert|update|delete)/);
  });
});

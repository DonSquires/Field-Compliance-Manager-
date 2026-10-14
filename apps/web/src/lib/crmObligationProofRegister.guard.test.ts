import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    '../../supabase/migrations/20261014231948_wire_obligation_proof_register.sql',
  ),
  'utf8',
);
const accessMigration = readFileSync(
  resolve(
    process.cwd(),
    '../../supabase/migrations/20261014233936_tighten_obligation_proof_register_access.sql',
  ),
  'utf8',
);
const panel = readFileSync(
  resolve(process.cwd(), 'src/components/CrmAgreementObligationsPanel.tsx'),
  'utf8',
);

describe('governed obligation proof register', () => {
  it('limits evidence to an accepted contract, its covered Site, and completed work', () => {
    expect(migration).toContain('public.is_admin_for_org(v_agreement.provider_organization_id)');
    expect(migration).toContain("v_agreement.agreement_type <> 'operational'");
    expect(migration).toContain("v_agreement.invitation_status <> 'accepted'");
    expect(migration).toContain('sal.service_agreement_id = v_agreement.id');
    expect(migration).toContain("ss.status = 'completed'");
    expect(migration).toContain('ss.site_id = v_obligation.site_id');
    expect(migration).toContain('FOR UPDATE OF ss');
  });

  it('does not mislabel isolated coordinates as a GPS track', () => {
    expect(migration).toContain("v_obligation.proof_artifact_type = 'gps_track'");
    expect(migration).toContain('ogl.shift_id = s.id');
    expect(migration).toContain('ogl.recorded_at BETWEEN ss.actual_arrived_at AND ss.actual_departed_at');
    expect(migration).toContain('v_gps_point_count < 2');
    expect(migration).toContain('A GPS track requires at least two shift-linked points');
  });

  it('preserves replay and correction history', () => {
    expect(migration).toContain('idx_obligation_proof_artifacts_request');
    expect(migration).toContain('idx_obligation_proof_artifacts_active_source');
    expect(migration).toContain('idx_audit_crm_obligation_proof_request');
    expect(migration.indexOf("al.metadata->>'client_request_id'")).toBeLessThan(
      migration.indexOf('v_artifact.updated_at IS DISTINCT FROM p_expected_updated_at'),
    );
    expect(migration).toContain("status = 'withdrawn'");
    expect(migration).toContain("'previous_status', 'active'");
    expect(migration).toContain("'withdrawal_reason', v_artifact.withdrawal_reason");
  });

  it('removes direct browser mutation and grants only governed RPC execution', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.obligation_proof_artifacts FROM anon, authenticated',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.manage_crm_obligation_proof',
    );
    expect(migration).toContain('TO authenticated, service_role');
    expect(accessMigration).toContain('idx_obligation_proof_artifacts_created_by');
    expect(accessMigration).toContain('idx_obligation_proof_artifacts_withdrawn_by');
    expect(accessMigration).toContain(
      'DROP POLICY IF EXISTS obligation_proof_artifacts_insert',
    );
    expect(accessMigration).toContain(
      'DROP POLICY IF EXISTS obligation_proof_artifacts_select',
    );
    expect(accessMigration).toContain(
      'DROP POLICY IF EXISTS obligation_proof_artifacts_update',
    );
    expect(panel).toMatch(/supabase\.rpc\(['"]get_crm_obligation_proof_register['"]/);
    expect(panel).toMatch(/supabase\.rpc\(['"]manage_crm_obligation_proof['"]/);
    expect(panel).not.toMatch(
      /\.from\(['"]obligation_proof_artifacts['"]\)\.(insert|update|delete)/,
    );
  });

  it('keeps unsupported and legacy evidence states visible', () => {
    expect(panel).toContain('Evidence type not configured');
    expect(panel).toContain('Configuration required');
    expect(panel).toContain('Source workflow unavailable');
    expect(panel).toContain('The requirement remains unproven');
    expect(panel).toContain('No unlinked completed work currently satisfies');
    expect(panel).toContain('Confirm withdrawal');
  });
});

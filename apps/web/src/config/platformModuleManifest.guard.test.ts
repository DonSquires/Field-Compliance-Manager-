import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const catalog = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260913110000_modular_platform_catalog.sql'), 'utf8');
const invites = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260913111000_client_capability_share_invites.sql'), 'utf8');
const manifest = readFileSync(resolve(process.cwd(), 'src/config/platformModuleManifest.ts'), 'utf8');

describe('modular platform subscription contract', () => {
  it('backfills platform modules without changing existing org behaviour', () => {
    expect(catalog).toContain("('crm', 0, 0, 0, 'monthly', 'NZD', true)");
    expect(catalog).toContain("('finance', 0, 0, 0, 'monthly', 'NZD', true)");
    expect(catalog).toContain("WHERE o.organization_type IN ('service_provider', 'branch')");
  });

  it('enforces the finance-depends-on-rostering edge at the entitlement boundary', () => {
    expect(catalog).toContain("VALUES ('finance', 'rostering', 'Finance cost capture is derived from shifts and roster_work_units");
    expect(catalog).toContain('tg_enforce_module_dependencies');
  });

  it('manifest marks finance non-standalone and everything else standalone', () => {
    expect(manifest).toContain("key: 'finance'");
    expect(manifest).toContain('standaloneSellable: false');
    expect(manifest).toContain("dependsOn: ['rostering']");
  });
});

describe('client capability share invites (replaces all-or-nothing agreement acceptance)', () => {
  it('adds a scoped invite kind independent of the agreement accept flow', () => {
    expect(invites).toContain("CHECK (invite_kind IN ('agreement_onboarding', 'reporting_share', 'finance_share'))");
    expect(invites).toContain('invite_client_capability_share');
    expect(invites).toContain('accept_client_capability_share');
  });

  it('widens invoicing and reporting gates instead of removing agreement acceptance', () => {
    expect(invites).toContain("v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_finance_enabled");
    expect(invites).toContain("v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_reports_enabled");
  });
});

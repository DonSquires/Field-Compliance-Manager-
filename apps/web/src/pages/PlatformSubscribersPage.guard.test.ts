import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/PlatformSubscribersPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260915150000_owner_console_and_default_guard_pay.sql'), 'utf8');
const singleProviderMigration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20261102140000_rm_verified_only_operational_custody_consolidation.sql'), 'utf8');
const deactivateFunction = readFileSync(resolve(process.cwd(), '../../supabase/functions/deactivate-user/index.ts'), 'utf8');

describe('owner console (platform subscribers)', () => {
  it('is a platform-only page reachable from the Platform navigation group', () => {
    expect(shell).toContain("'platform-subscribers'");
    expect(shell).toContain("{ id: 'platform-subscribers', label: 'Subscribers'");
    expect(shell).toMatch(/PLATFORM_ONLY_PAGES = new Set<AdminPage>\(\[[^\]]*'platform-subscribers'/);
    expect(page).toContain("profile?.role === 'grand_master'");
    expect(page).toContain('Only the platform owner can manage subscribers.');
  });

  it('reads aggregates only and writes only through governed paths', () => {
    expect(page).toContain("supabase.rpc('platform_list_subscribers')");
    expect(page).toContain("supabase.rpc('platform_set_subscriber_status'");
    expect(page).toContain("supabase.functions.invoke('invite-org'");
    expect(page).not.toContain('platform_provision_subscriber');
    expect(page).not.toContain('New subscriber');
    // The owner never reads a subscriber's records from this page.
    expect(page).not.toMatch(/from\('(shifts|dispatch_jobs|client_sites|rate_rules|quotes|invoices|finance_[a-z_]+|user_profiles)'\)/);
    expect(page).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.(update|insert)\(/);
    expect(migration).toContain("where public.is_grand_master()");
    expect(migration).toContain("(select max(au.last_sign_in_at) from public.user_profiles u join auth.users au on au.id = u.id where u.organization_id = o.id)");
    expect(singleProviderMigration).toContain('REVOKE ALL ON FUNCTION public.platform_provision_subscriber');
    expect(singleProviderMigration).toContain("AND assessment.entity_id = t.biosecurity_assessment_id");
    expect(singleProviderMigration).toContain("AND t.status <> 'sent'");
    expect(singleProviderMigration).not.toContain("assessment.entity_id = t.assessment_id");
    expect(singleProviderMigration).toContain("private.rm_tenancy_tree_contains(p_provider_id)");
    expect(singleProviderMigration).toContain("provider.organization_type IN ('service_provider', 'branch', 'contractor')");
    expect(singleProviderMigration).toContain("t.review_state = 'verified'");
    expect(singleProviderMigration).toContain("SELECT 'observation_person_mentions'");
    expect(singleProviderMigration).toContain('CREATE TEMP TABLE fcm_retained_user_organizations');
    expect(singleProviderMigration).toContain('Active user profiles remain outside the approved R&M/Iron Eagle account set');
    expect(singleProviderMigration).toContain('Unprofiled Auth accounts require explicit reconciliation');
    expect(singleProviderMigration).toContain('CREATE OR REPLACE FUNCTION public.is_enforcement_operator_for_org(target_org_id uuid)');
    expect(singleProviderMigration).toContain('AND p.deactivated_at IS NULL');
    expect(singleProviderMigration).toContain('CREATE OR REPLACE FUNCTION public.set_user_deactivation(');
    expect(singleProviderMigration).toContain('PERFORM public.log_user_management_action(');
    expect(deactivateFunction).toContain("rpc('set_user_deactivation'");
    expect(deactivateFunction).not.toMatch(/\.from\(['"]user_profiles['"]\)\.update/);
    expect(singleProviderMigration).not.toContain('Convert LINZ/NMDHB access to the client role model');
    const sourceOrganizationSetup = singleProviderMigration.match(/INSERT INTO pg_temp\.fcm_source_organizations \(organization_id\)[\s\S]*?CREATE TEMP TABLE fcm_archived_organizations/);
    expect(sourceOrganizationSetup?.[0]).toMatch(/SELECT sa\.provider_organization_id\s+FROM pg_temp\.fcm_verified_agreements v\s+JOIN public\.service_agreements sa ON sa\.id = v\.agreement_id/);
    const archivedOrganizationSetup = singleProviderMigration.match(/INSERT INTO pg_temp\.fcm_archived_organizations \(organization_id\)[\s\S]*?INSERT INTO private\.org_consolidation_transfers/);
    expect(archivedOrganizationSetup).not.toBeNull();
    expect(archivedOrganizationSetup?.[0] ?? '').not.toContain('fcm_verified_agreements');
    expect(singleProviderMigration).not.toContain("SELECT 'person_interactions'");
    expect(singleProviderMigration).not.toContain("SELECT 'person_vehicle_links'");
    expect(singleProviderMigration).toContain('CREATE OR REPLACE FUNCTION public.propagate_group_charge_catalog_to_child()');
    expect(singleProviderMigration).toContain("current_setting('app.rm_custody_transfer', true) = '20261102140000'");
  });

  it('suspend and cancel require a reason and move lines, modules, and status together', () => {
    expect(page).toContain("disabled={saving || !statusReason.trim()}");
    expect(migration).toContain("raise exception 'A reason is required to suspend or cancel a subscriber'");
    expect(migration).toContain("update public.organization_modules set enabled = false where organization_id = v_org.id and module_key = v_key;");
    expect(migration).toContain("'platform_subscriber_reinstated'");
  });

  it('recovery is chosen automatically when every user is deactivated; no password ever passes through', () => {
    expect(page).toContain("const mode = inviteFor.active_user_count === 0 && inviteFor.user_count > 0 ? 'recovery' : 'invite';");
    expect(page).not.toMatch(/type="password"|password:|preauthenticated/);
  });

  it('seeds the owner-approved default guard pay as a wildcard rule that specific rules beat', () => {
    expect(migration).toContain("'Guard (default pay, per hour)', 'hourly', 30.00, 'GUARD-HOURLY', date '2025-04-01', -10");
  });
});

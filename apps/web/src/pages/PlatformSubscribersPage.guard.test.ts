import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/PlatformSubscribersPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260915150000_owner_console_and_default_guard_pay.sql'), 'utf8');

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
    expect(page).toContain("supabase.rpc('platform_provision_subscriber'");
    expect(page).toContain("supabase.rpc('platform_set_subscriber_status'");
    expect(page).toContain("supabase.functions.invoke('invite-org'");
    // The owner never reads a subscriber's records from this page.
    expect(page).not.toMatch(/from\('(shifts|dispatch_jobs|client_sites|rate_rules|quotes|invoices|finance_[a-z_]+|user_profiles)'\)/);
    expect(page).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.(update|insert)\(/);
    expect(migration).toContain("where public.is_grand_master()");
    expect(migration).toContain("(select max(au.last_sign_in_at) from public.user_profiles u join auth.users au on au.id = u.id where u.organization_id = o.id)");
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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'src/pages/ModuleSubscriptionsPage.tsx'), 'utf8');
const migration = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260913120200_self_serve_module_subscription.sql'), 'utf8');

describe('self-serve module subscription contract', () => {
  it('wires the subscriptions page into AdminShell navigation and routing', () => {
    expect(shell).toContain("'module-subscriptions'");
    expect(shell).toContain('ModuleSubscriptionsPage');
  });

  it('toggles modules via the org-agnostic governed RPC, not a direct table write', () => {
    expect(page).toContain("supabase.rpc('set_organization_module_subscription'");
    expect(page).not.toMatch(/\.from\('organization_modules'\)\.(insert|update|upsert)/);
  });

  it('fails closed when organization scope is unavailable', () => {
    expect(page).toContain('if (!orgId) {');
    expect(page).toContain("setError('Organisation access could not be confirmed. Module subscriptions are unavailable.');");
    expect(page).toContain('setLoading(false);');
  });

  it('the RPC authorizes by org admin only, independent of organization_type', () => {
    expect(migration).toContain('is_admin_for_org(p_organization_id)');
    expect(migration).not.toContain("organization_type='branch'");
  });
});

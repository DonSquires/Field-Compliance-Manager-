import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/OrganizationSetupPage.tsx'), 'utf8');

describe('governed organization profile setup', () => {
  it('saves the provider profile through the expected-state RPC', () => {
    expect(source).toContain("supabase.rpc('update_operating_branch_profile'");
    expect(source).toContain('p_expected_updated_at: org.updated_at');
    expect(source).not.toMatch(/\.from\(['"]organizations['"]\)[\s\S]{0,200}\.update\(/);
  });

  it('uses selected operating branch RPCs for operational module and geofence settings', () => {
    expect(source).toContain('operatingOrganizationId ?? profile?.organizationId');
    expect(source).toContain("supabase.rpc('set_operating_branch_module'");
    expect(source).toContain("supabase.rpc('manage_operating_branch_geofence_config'");
    expect(source).not.toMatch(/from\(['"]organization_modules['"]\)[\s\S]{0,200}\.(update|insert|delete)/);
    expect(source).not.toMatch(/from\(['"]org_geofence_config['"]\)[\s\S]{0,200}\.(update|insert|delete)/);
  });
});

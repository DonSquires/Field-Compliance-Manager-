import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014200126_retire_superseded_organization_profile_update.sql'),
  'utf8',
);
const operatingAuthority = readFileSync(
  resolve(root, 'supabase/migrations/20260915130000_provider_home_context_and_branches.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const setupPage = readFileSync(
  resolve(root, 'apps/web/src/pages/OrganizationSetupPage.tsx'),
  'utf8',
);
const fixtures = readFileSync(resolve(root, 'apps/web/e2e/fixtures.ts'), 'utf8');

describe('superseded organization profile update retirement', () => {
  it('removes the home-organization-only update authority', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.update_organization_profile(',
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."update_organization_profile"/,
    );
    expect(databaseTypes).not.toMatch(/\n      update_organization_profile:/);
    expect(fixtures).not.toContain("table === 'update_organization_profile'");
  });

  it('keeps the selected operating organization as the only UI authority', () => {
    expect(operatingAuthority).toContain(
      'CREATE OR REPLACE FUNCTION "public"."update_operating_branch_profile"',
    );
    expect(operatingAuthority).toContain(
      "organization_type in ('owner','service_provider','branch')",
    );
    expect(operatingAuthority).toContain(
      'user_can_operate_organization(p_operating_organization_id)',
    );
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."update_operating_branch_profile"/,
    );
    expect(databaseTypes).toMatch(/\n      update_operating_branch_profile:/);
    expect(setupPage).toContain("supabase.rpc('update_operating_branch_profile'");
    expect(setupPage).toContain('p_operating_organization_id: org.id');
    expect(fixtures).toContain("table === 'update_operating_branch_profile'");
  });

  it('preserves expected-state validation and audit evidence', () => {
    expect(operatingAuthority).toContain(
      'if v_branch.updated_at<>p_expected_updated_at',
    );
    expect(operatingAuthority).toContain("'operating_branch_profile_updated'");
    expect(setupPage).toContain('p_expected_updated_at: org.updated_at');
  });
});

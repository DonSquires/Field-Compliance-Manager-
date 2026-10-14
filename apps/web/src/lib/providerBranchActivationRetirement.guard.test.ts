import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014195243_retire_superseded_provider_branch_activation.sql'),
  'utf8',
);
const branchAuthority = readFileSync(
  resolve(root, 'supabase/migrations/20260915130000_provider_home_context_and_branches.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const setupPage = readFileSync(
  resolve(root, 'apps/web/src/pages/OrganizationSetupPage.tsx'),
  'utf8',
);

describe('superseded provider branch activation retirement', () => {
  it('retires the unreachable prospect activation authority', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.activate_provider_branch(uuid, timestamptz);',
    );
    expect(databaseTypes).not.toMatch(/\n      activate_provider_branch:/);
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."activate_provider_branch"/,
    );
  });

  it('keeps branch creation immediate, retry-safe and governed', () => {
    expect(branchAuthority).toContain('CREATE OR REPLACE FUNCTION public.create_provider_branch');
    expect(branchAuthority).toContain('if p_client_request_id is null');
    expect(branchAuthority).toContain("values (v_name, 'branch', v_parent.id, true, 'active'");
    expect(branchAuthority).toContain("where pm.organization_id = v_parent.id and pm.enabled");
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_provider_branch"/,
    );
    expect(databaseTypes).toMatch(/\n      create_provider_branch:/);
    expect(setupPage).toContain("supabase.rpc('create_provider_branch'");
    expect(setupPage).toContain('p_client_request_id: branchRequestId');
  });

  it('preserves the governed archive path and truthful UI refresh', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."archive_provider_branch"/,
    );
    expect(setupPage).toContain("supabase.rpc('archive_provider_branch'");
    expect(setupPage).toContain('await refreshOperatingOrganizations();');
    expect(setupPage).toContain('A new branch starts with the same modules as the organisation.');
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014201521_retire_direct_boundary_writers.sql'),
  'utf8',
);
const governedWorkflow = readFileSync(
  resolve(root, 'supabase/migrations/20260914004000_geofence_workbench_boundary_proposals.sql'),
  'utf8',
);
const setterSecurity = readFileSync(
  resolve(root, 'supabase/migrations/20261014201909_restrict_low_level_boundary_setters.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const houseMap = readFileSync(
  resolve(root, 'apps/web/src/components/LocationHouseMap.tsx'),
  'utf8',
);

describe('direct boundary writer retirement', () => {
  it('removes both direct geometry mutation authorities', () => {
    expect(retirement).toContain('DROP FUNCTION IF EXISTS public.save_site_boundary(');
    expect(retirement).toContain('DROP FUNCTION IF EXISTS public.save_zone_boundary(');
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."save_(site|zone)_boundary"/,
    );
    expect(databaseTypes).not.toMatch(/\n      save_(site|zone)_boundary:/);
  });

  it('removes stale declarative remnants that could misstate authority', () => {
    expect(
      existsSync(resolve(root, 'supabase/schemas/public/functions/save_site_boundary.sql')),
    ).toBe(false);
    expect(
      existsSync(resolve(root, 'supabase/schemas/public/functions/save_zone_boundary.sql')),
    ).toBe(false);
  });

  it('keeps proposal, acceptance and verification as the human workflow', () => {
    expect(governedWorkflow).toContain(
      'CREATE OR REPLACE FUNCTION public.propose_boundary(',
    );
    expect(governedWorkflow).toContain(
      'CREATE OR REPLACE FUNCTION public.accept_boundary_proposal(',
    );
    expect(governedWorkflow).toContain(
      'PERFORM public.verify_boundary(v_p.entity_type, v_p.entity_id);',
    );
    expect(houseMap).toContain("supabase.rpc('propose_boundary'");
    expect(houseMap).toContain("supabase.rpc('accept_boundary_proposal'");
  });

  it('keeps direct low-level geometry setters service-only', () => {
    expect(setterSecurity).toContain(
      'REVOKE ALL ON FUNCTION public.set_site_geometry',
    );
    expect(setterSecurity).toContain(
      'REVOKE ALL ON FUNCTION public.set_zone_geometry',
    );
    expect(setterSecurity).toContain('FROM PUBLIC, anon, authenticated;');
    expect(setterSecurity).toContain('TO service_role;');
    expect(schema).not.toMatch(
      /GRANT EXECUTE ON FUNCTION "public"\."set_(site|zone)_geometry".* TO (PUBLIC|"anon"|"authenticated");/,
    );
  });
});

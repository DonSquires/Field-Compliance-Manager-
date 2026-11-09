import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const retirement = readFileSync(
  resolve(root, 'supabase/migrations/20261014203653_retire_superseded_crm_boundary_review.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const houseMap = readFileSync(
  resolve(root, 'apps/web/src/components/LocationHouseMap.tsx'),
  'utf8',
);
const adminShell = readFileSync(resolve(root, 'apps/web/src/shells/AdminShell.tsx'), 'utf8');

describe('superseded CRM boundary review retirement', () => {
  it('removes the CRM-only queue and direct boundary mutator', () => {
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.manage_crm_site_boundary(',
    );
    expect(retirement).toContain(
      'DROP FUNCTION IF EXISTS public.get_crm_site_boundary_queue();',
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."manage_crm_site_boundary"/,
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."get_crm_site_boundary_queue"/,
    );
    expect(databaseTypes).not.toMatch(/\n      manage_crm_site_boundary:/);
    expect(databaseTypes).not.toMatch(/\n      get_crm_site_boundary_queue:/);
  });

  it('keeps the unified review data contract while retiring the standalone route', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."get_geofence_review_queue"/,
    );
    expect(databaseTypes).toMatch(/\n      get_geofence_review_queue:/);
    expect(adminShell).toMatch(/case 'sites':\s*return <LocationsPage \/>;/);
    expect(adminShell).not.toContain('SiteBoundaryReviewPage');
  });

  it('keeps House boundary proposals on the governed decision path', () => {
    expect(houseMap).toContain("supabase.rpc('propose_boundary'");
    expect(houseMap).toContain("supabase.rpc('accept_boundary_proposal'");
    expect(houseMap).toContain("supabase.rpc('verify_boundary'");
    expect(houseMap).not.toContain("supabase.rpc('manage_crm_site_boundary'");
  });
});

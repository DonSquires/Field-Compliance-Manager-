import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = existsSync(resolve(process.cwd(), 'apps/web/src/pages/ObservationSearchPage.tsx'))
  ? resolve(process.cwd(), 'apps/web/src/pages/ObservationSearchPage.tsx')
  : resolve(process.cwd(), 'src/pages/ObservationSearchPage.tsx');
const migrationPath = existsSync(resolve(process.cwd(), 'supabase/migrations/20260908120000_observation_links_and_global_search.sql'))
  ? resolve(process.cwd(), 'supabase/migrations/20260908120000_observation_links_and_global_search.sql')
  : resolve(process.cwd(), '../../supabase/migrations/20260908120000_observation_links_and_global_search.sql');
const rlsFixPath = existsSync(resolve(process.cwd(), 'supabase/migrations/20260922070000_fix_search_observations_vehicle_rls.sql'))
  ? resolve(process.cwd(), 'supabase/migrations/20260922070000_fix_search_observations_vehicle_rls.sql')
  : resolve(process.cwd(), '../../supabase/migrations/20260922070000_fix_search_observations_vehicle_rls.sql');

const source = readFileSync(sourcePath, 'utf8');
const searchMigration = readFileSync(migrationPath, 'utf8');
const rlsFixMigration = readFileSync(rlsFixPath, 'utf8');

describe('Observation Search canonical entity contract', () => {
  it('exposes every governed search_observations filter', () => {
    for (const parameter of ['p_site_id', 'p_zone_id', 'p_location_id', 'p_vehicle_id', 'p_person_id', 'p_incident_id', 'p_poi', 'p_loi']) {
      expect(source).toContain(`${parameter}:`);
    }
  });

  it('loads canonical places and entities for authorised organisation context', () => {
    for (const table of ['client_sites', 'location_zones', 'locations', 'canonical_vehicle_public', 'person_records', 'incidents']) {
      expect(source).toContain(`from('${table}')`);
    }
    // The plate registry table itself is Bob-only; pages read the projection.
    expect(source).not.toContain("from('canonical_vehicles')");
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
  });

  it('keeps investigation context visible in the result model', () => {
    for (const field of ['location_name', 'incident_label', 'poi', 'loi', 'vehicle_label', 'person_label']) {
      expect(source).toContain(`${field}:`);
    }
  });

  it('joins the redacted vehicle projection inside search_observations, not the RLS-locked base table', () => {
    // canonical_vehicles carries only a bob_full_read RLS policy and search_observations is plain
    // SQL (not SECURITY DEFINER), so joining the base table directly silently returns nothing for
    // every real user - vehicle make/model would never populate and vehicle text search would
    // never match.
    expect(rlsFixMigration).toContain('LEFT JOIN public.canonical_vehicle_public cv ON cv.id = o.canonical_vehicle_id');
    expect(rlsFixMigration).not.toContain('LEFT JOIN public.canonical_vehicles cv');
  });

  it('does not reset the search box on every keystroke', () => {
    // A prior bug listed `search` in the URL-sync effect's own dependency array, so typing a
    // character re-triggered the effect and immediately reverted it back to the URL's value.
    expect(source).not.toMatch(/\[searchParams,\s*search\]/);
    expect(source).toContain('setSearch((current) => (routedSearch !== current ? routedSearch : current))');
  });

  it('preserves PostgreSQL wildcard patterns entered by investigators', () => {
    expect(source).toContain('Use % as a wildcard anywhere');
    expect(searchMigration).toContain("ILIKE '%' || trim(p_search) || '%'");
    expect(searchMigration).not.toContain('replace(p_search');
    expect(searchMigration).not.toContain('regexp_replace(p_search');
  });
});

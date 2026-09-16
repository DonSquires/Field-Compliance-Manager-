import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = existsSync(resolve(process.cwd(), 'apps/web/src/pages/ObservationSearchPage.tsx'))
  ? resolve(process.cwd(), 'apps/web/src/pages/ObservationSearchPage.tsx')
  : resolve(process.cwd(), 'src/pages/ObservationSearchPage.tsx');
const migrationPath = existsSync(resolve(process.cwd(), 'supabase/migrations/20260908120000_observation_links_and_global_search.sql'))
  ? resolve(process.cwd(), 'supabase/migrations/20260908120000_observation_links_and_global_search.sql')
  : resolve(process.cwd(), '../../supabase/migrations/20260908120000_observation_links_and_global_search.sql');

const source = readFileSync(sourcePath, 'utf8');
const searchMigration = readFileSync(migrationPath, 'utf8');

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

  it('preserves PostgreSQL wildcard patterns entered by investigators', () => {
    expect(source).toContain('Use % as a wildcard anywhere');
    expect(searchMigration).toContain("ILIKE '%' || trim(p_search) || '%'");
    expect(searchMigration).not.toContain('replace(p_search');
    expect(searchMigration).not.toContain('regexp_replace(p_search');
  });
});

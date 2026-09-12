import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/ObservationSearchPage.tsx'), 'utf8');

describe('Observation Search canonical entity contract', () => {
  it('exposes every governed search_observations filter', () => {
    for (const parameter of ['p_site_id', 'p_zone_id', 'p_location_id', 'p_vehicle_id', 'p_person_id', 'p_incident_id', 'p_poi', 'p_loi']) {
      expect(source).toContain(`${parameter}:`);
    }
  });

  it('loads canonical places and entities for authorised organisation context', () => {
    for (const table of ['client_sites', 'location_zones', 'locations', 'canonical_vehicles', 'person_records', 'incidents']) {
      expect(source).toContain(`from('${table}')`);
    }
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
  });

  it('keeps investigation context visible in the result model', () => {
    for (const field of ['location_name', 'incident_label', 'poi', 'loi', 'vehicle_label', 'person_label']) {
      expect(source).toContain(`${field}:`);
    }
  });
});

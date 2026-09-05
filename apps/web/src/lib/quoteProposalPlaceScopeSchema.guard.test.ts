import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(import.meta.dirname, '../../../../supabase/migrations/20260905007000_scope_proposed_places.sql'), 'utf8');

describe('proposed-place delivery scopes', () => {
  it('requires exactly one live Site, live Zone, or draft proposed place', () => {
    expect(migration).toContain('ADD COLUMN proposed_place_id');
    expect(migration).toContain('num_nonnulls(site_id,zone_id,proposed_place_id)=1');
    expect(migration).toContain('Proposed place does not belong to this quote and module');
  });

  it('resolves converted draft places before creating live services and schedules', () => {
    expect(migration).toContain('place.converted_site_id');
    expect(migration).toContain('place.converted_zone_id');
    expect(migration).toContain('Proposed place was not converted during quote acceptance');
    expect(migration).toContain('service_agreement_delivery_schedules');
  });
});
import { describe, expect, it } from 'vitest';
import { buildPlaceOptions } from './PlaceFacetPicker';

describe('PlaceFacetPicker options', () => {
  it('lists site and zone facets as mutually exclusive place selections', () => {
    const options = buildPlaceOptions(
      [
        { id: 'house-1', name: 'Harbour House', address: '1 Wharf Road' },
        { id: 'house-2', name: 'Area Only', address: null },
      ],
      [{ id: 'site-1', name: 'Gatehouse', address: null, location_id: 'house-1' }],
      [{ id: 'zone-1', name: 'Eastern patrol area', location_id: 'house-1', module_key: 'site_guard', zone_type: 'patrol_route' }],
    );

    expect(options.map((option) => option.key)).toEqual(['place:house-2', 'zone:zone-1', 'site:site-1']);
    expect(options.find((option) => option.key === 'site:site-1')).toMatchObject({ locationId: 'house-1', siteId: 'site-1', zoneId: null });
    expect(options.find((option) => option.key === 'zone:zone-1')).toMatchObject({ locationId: 'house-1', siteId: null, zoneId: 'zone-1' });
  });

  it('does not offer orphan facets without their canonical house context', () => {
    expect(buildPlaceOptions([], [{ id: 'site-1', name: 'Orphan', address: null, location_id: 'missing' }], [])).toEqual([]);
  });
});
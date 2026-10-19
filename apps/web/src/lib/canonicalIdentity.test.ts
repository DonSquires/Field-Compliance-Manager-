import { describe, expect, it } from 'vitest';
import {
  buildCanonicalOrganizationKey,
  buildCanonicalPlaceKey,
  buildCanonicalPersonKey,
  buildCanonicalVehicleKey,
  buildCanonicalScvKey,
  canonicalEntityKey,
  dedupeByPlate,
  normalizePlateNumber,
  vehicleHistoryOrFilter,
} from './canonicalIdentity';

describe('canonical identity helpers', () => {
  it('normalizes plate numbers to a stable global key', () => {
    expect(normalizePlateNumber(' ab-123 ')).toBe('AB123');
    expect(buildCanonicalVehicleKey('ab-123')).toBe('vehicle:AB123');
    expect(buildCanonicalScvKey('ab-123')).toBe('scv:AB123');
  });

  it('creates stable identity keys for organization, place, and person records', () => {
    expect(buildCanonicalOrganizationKey('  Metro Security  ')).toBe('organization:Metro Security');
    expect(buildCanonicalPlaceKey('site', 'site-001')).toBe('site:site-001');
    expect(buildCanonicalPersonKey('person-011')).toBe('person:person-011');
  });

  it('resolves a canonical entity key through the shared platform contract', () => {
    expect(canonicalEntityKey('organization', 'Metro Security')).toBe('organization:Metro Security');
    expect(canonicalEntityKey('place', 'north-site')).toBe('location:north-site');
    expect(canonicalEntityKey('vehicle', ' ab-123 ')).toBe('vehicle:AB123');
  });

  it('deduplicates plates across repeated values and whitespace', () => {
    expect(dedupeByPlate(['ab-123', ' AB123 ', 'ab-123', null])).toEqual(['AB123']);
  });

  it('builds a history filter that prefers the canonical vehicle link and falls back to plate', () => {
    expect(vehicleHistoryOrFilter(' ab-123 ', 'veh-uuid')).toBe('canonical_vehicle_id.eq.veh-uuid,plate_number_upper.eq.AB123');
    expect(vehicleHistoryOrFilter('ab-123', null)).toBe('plate_number_upper.eq.AB123');
    expect(() => vehicleHistoryOrFilter('  --  ', 'veh-uuid')).toThrow('A vehicle plate is required');
  });
});

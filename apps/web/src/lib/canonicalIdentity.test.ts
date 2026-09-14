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
});

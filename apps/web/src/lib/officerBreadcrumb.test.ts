import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

import { BREADCRUMB_INTERVAL_MS, buildOfficerBreadcrumb, isBreadcrumbDue } from './officerBreadcrumb';

describe('officer breadcrumb capture', () => {
  it('preserves device capture metadata and converts speed to kilometres per hour', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'f1ef946c-d0e5-4c31-bda3-f7ddb70eac35' });
    const position = {
      timestamp: Date.parse('2026-08-30T10:15:00.000Z'),
      coords: {
        latitude: -41.2865,
        longitude: 174.7762,
        accuracy: 6,
        altitude: null,
        altitudeAccuracy: null,
        heading: 182,
        speed: 10,
        toJSON: () => ({}),
      },
      toJSON: () => ({}),
    } satisfies GeolocationPosition;

    expect(buildOfficerBreadcrumb(position, 'shift-1')).toEqual({
      clientEventId: 'f1ef946c-d0e5-4c31-bda3-f7ddb70eac35',
      recordedAt: '2026-08-30T10:15:00.000Z',
      latitude: -41.2865,
      longitude: 174.7762,
      accuracyMeters: 6,
      heading: 182,
      speedKmh: 36,
      activityType: 'gps_update',
      shiftId: 'shift-1',
    });
    vi.unstubAllGlobals();
  });

  it('captures immediately and then at the evidence heartbeat interval', () => {
    expect(isBreadcrumbDue(null, 1_000)).toBe(true);
    expect(isBreadcrumbDue(1_000, 1_000 + BREADCRUMB_INTERVAL_MS - 1)).toBe(false);
    expect(isBreadcrumbDue(1_000, 1_000 + BREADCRUMB_INTERVAL_MS)).toBe(true);
  });
});
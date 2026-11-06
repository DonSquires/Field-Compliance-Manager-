import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

import { BREADCRUMB_INTERVAL_MS, buildOfficerBreadcrumb, canRecordOfficerBreadcrumbs, isBreadcrumbDue, isPermanentBreadcrumbRejection } from './officerBreadcrumb';

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
      physicalAddress: null,
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

  it('records only for roles the breadcrumb RPC accepts', () => {
    expect(canRecordOfficerBreadcrumbs('officer')).toBe(true);
    expect(canRecordOfficerBreadcrumbs('admin_officer')).toBe(true);
    expect(canRecordOfficerBreadcrumbs('scan_operator')).toBe(true);
    expect(canRecordOfficerBreadcrumbs('grand_master')).toBe(false);
    expect(canRecordOfficerBreadcrumbs('admin')).toBe(false);
    expect(canRecordOfficerBreadcrumbs(undefined)).toBe(false);
  });

  it('treats database validation rejections as permanent and network failures as retryable', () => {
    expect(isPermanentBreadcrumbRejection({ code: 'P0001', message: 'recorded_at is outside the accepted capture window' })).toBe(true);
    expect(isPermanentBreadcrumbRejection(new TypeError('Failed to fetch'))).toBe(false);
    expect(isPermanentBreadcrumbRejection({ code: '57014', message: 'statement timeout' })).toBe(false);
  });
});
import { describe, expect, it } from 'vitest';
import { deriveOfficerPinStatus } from './officerPinStatus';

describe('deriveOfficerPinStatus', () => {
  it('shows alerting when a real welfare alert is active, even with fresh GPS', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: 1_000, safetyStatus: 'alerting' }),
    ).toBe('alerting');
  });

  it('shows alerting even when GPS is stale — an emergency does not get demoted to offline', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: 10 * 60 * 60 * 1000, safetyStatus: 'alerting' }),
    ).toBe('alerting');
  });

  it('shows unknown when welfare status has not loaded — never defaults to ok', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: 1_000, safetyStatus: null }),
    ).toBe('unknown');
  });

  it('shows offline when GPS is stale beyond the threshold, even if welfare status is ok', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: 2 * 60 * 60 * 1000, safetyStatus: 'ok' }),
    ).toBe('offline');
  });

  it('shows offline when there is no GPS fix at all', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: null, safetyStatus: 'ok' }),
    ).toBe('offline');
  });

  it('passes through due/overdue/ok when GPS is fresh — this is the gap the original page had', () => {
    expect(deriveOfficerPinStatus({ gpsAgeMs: 1_000, safetyStatus: 'due' })).toBe('due');
    expect(deriveOfficerPinStatus({ gpsAgeMs: 1_000, safetyStatus: 'overdue' })).toBe('overdue');
    expect(deriveOfficerPinStatus({ gpsAgeMs: 1_000, safetyStatus: 'ok' })).toBe('ok');
  });

  it('respects a custom staleness threshold', () => {
    expect(
      deriveOfficerPinStatus({ gpsAgeMs: 5 * 60 * 1000, safetyStatus: 'ok', gpsStaleThresholdMs: 60_000 }),
    ).toBe('offline');
  });
});

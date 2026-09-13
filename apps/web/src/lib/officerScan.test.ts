import { describe, expect, it, vi } from 'vitest';
import { buildOfficerScanPayload, canSubmitOfficerScan, isNetworkFailure, normalizePlate } from './officerScan';

describe('officer scan contract', () => {
  it('normalizes a manual plate and builds the edge-function payload', () => {
    expect(normalizePlate(' abc-123 ')).toBe('ABC123');
    expect(buildOfficerScanPayload({
      plateNumber: ' abc-123 ',
      latitude: -41.2865,
      longitude: 174.7762,
      zoneId: 'zone-1',
      capturedAt: '2026-08-30T04:30:00.000Z',
    })).toEqual({
      plate_number: 'ABC123',
      gps_lat: -41.2865,
      gps_lng: 174.7762,
      zone_id: 'zone-1',
      module_key: 'freedom_camping',
      captured_at: '2026-08-30T04:30:00.000Z',
    });
  });

  it('allows image-only capture for server-side ALPR', () => {
    const payload = buildOfficerScanPayload({
      imageBase64: 'encoded-image',
      latitude: -41.2865,
      longitude: 174.7762,
    });
    expect(payload.plate_number).toBeUndefined();
    expect(canSubmitOfficerScan(payload)).toBe(true);
  });

  it('normalizes the manual plate fallback while preserving photo evidence', () => {
    const payload = buildOfficerScanPayload({ plateNumber: ' ab-123 ', imageBase64: 'encoded-image', zoneId: 'zone-1' });
    expect(payload.plate_number).toBe('AB123');
    expect(payload.image_base64).toBe('encoded-image');
    expect(canSubmitOfficerScan(payload)).toBe(true);
  });

  it('preserves a client request id for offline retries', () => {
    expect(buildOfficerScanPayload({ clientRequestId: 'scan-request-1' }).client_request_id).toBe('scan-request-1');
  });

  it('requires evidence and either GPS or a selected zone', () => {
    expect(canSubmitOfficerScan(buildOfficerScanPayload({}))).toBe(false);
    expect(canSubmitOfficerScan(buildOfficerScanPayload({ imageBase64: 'encoded-image' }))).toBe(false);
    expect(canSubmitOfficerScan(buildOfficerScanPayload({ plateNumber: 'ABC123', zoneId: 'zone-1' }))).toBe(true);
  });

  it('supports the server-owned parking scan branch when explicitly selected', () => {
    expect(buildOfficerScanPayload({
      plateNumber: 'PARK123',
      zoneId: 'parking-zone',
      moduleKey: 'parking_enforcement',
    }).module_key).toBe('parking_enforcement');
  });

  it('queues fetch failures but not server validation errors', () => {
    vi.stubGlobal('navigator', { onLine: true });
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
    const functionsFetchError = new Error('Edge function request failed');
    functionsFetchError.name = 'FunctionsFetchError';
    expect(isNetworkFailure(functionsFetchError)).toBe(true);
    expect(isNetworkFailure(new Error('plate_number is required'))).toBe(false);
    vi.unstubAllGlobals();
  });
});
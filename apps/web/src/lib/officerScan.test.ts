import { describe, expect, it, vi } from 'vitest';
import { buildOfficerScanPayload, canSubmitOfficerScan, describeOfficerScanError, getOfficerScanRecoveryContext, isNetworkFailure, normalizePlate, shouldDropQueuedOfficerScan } from './officerScan';

describe('officer scan contract', () => {
  it('requires manual plate confirmation only for a saved-capture recovery', () => {
    const saved = buildOfficerScanPayload({ imageBase64: 'photo', zoneId: 'original-zone' });
    expect(canSubmitOfficerScan(saved)).toBe(true);
    const recovery = buildOfficerScanPayload({ imageBase64: 'photo', zoneId: 'original-zone', recoveryOriginalContext: getOfficerScanRecoveryContext(saved) });
    expect(canSubmitOfficerScan(recovery)).toBe(false);
    expect(canSubmitOfficerScan({ ...recovery, plate_number: 'SYN123' })).toBe(true);
  });
  it('retains the original capture context across recovery attempts without duplicating the image', () => {
    const saved = buildOfficerScanPayload({ clientRequestId: 'original-request', imageBase64: 'original-photo', plateNumber: 'OLD123', zoneId: 'original-zone', capturedAt: '2026-11-10T07:00:00Z' });
    const original = getOfficerScanRecoveryContext(saved);
    expect(original).not.toHaveProperty('image_base64');
    const resumed = buildOfficerScanPayload({ clientRequestId: 'original-request', imageBase64: 'original-photo', plateNumber: 'NEW123', zoneId: 'corrected-zone', recoveryOriginalContext: original });
    expect(getOfficerScanRecoveryContext(resumed)).toEqual(original);
    expect(resumed.recovery_original_context?.zone_id).toBe('original-zone');
    expect(resumed.recovery_original_context?.captured_at).toBe(saved.captured_at);
  });
  it('surfaces the edge response without replacing it with the generic SDK error', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: Response.json({ code: 'plate_confirmation_required', error: 'Keep this photo and confirm the plate manually.' }, { status: 400 }),
    });
    expect(await describeOfficerScanError(error)).toBe('Keep this photo and confirm the plate manually.');
    expect(await error.context.json()).toMatchObject({ code: 'plate_confirmation_required' });
  });
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
      location_source: 'manual_zone',
    });
  });

  it('allows image-only capture for server-side ALPR', () => {
    const payload = buildOfficerScanPayload({
      imageBase64: 'encoded-image',
      latitude: -41.2865,
      longitude: 174.7762,
      locationSource: 'device_gps',
    });
    expect(payload.plate_number).toBeUndefined();
    expect(canSubmitOfficerScan(payload)).toBe(true);
  });

  it('does not treat an address candidate as a selected place or device GPS', () => {
    const payload = buildOfficerScanPayload({
      imageBase64: 'encoded-image',
      latitude: -41.2865,
      longitude: 174.7762,
      locationSource: 'address_candidate',
    });
    expect(canSubmitOfficerScan(payload)).toBe(false);
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

  it('bounds offline queue retries at five attempts', () => {
    const scan = { id: 'scan-1', capturedAt: '2026-08-30T04:30:00.000Z', attempts: 4, body: buildOfficerScanPayload({ imageBase64: 'encoded-image', zoneId: 'zone-1' }) };
    expect(shouldDropQueuedOfficerScan(scan)).toBe(true);
    expect(shouldDropQueuedOfficerScan({ ...scan, attempts: 3 })).toBe(false);
  });

  it('classifies terminal server errors as non-network failures', () => {
    expect(isNetworkFailure(new Error('plate_number is required'))).toBe(false);
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
  });
});
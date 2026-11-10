export type ScanComplianceStatus = 'compliant' | 'at_risk' | 'breach' | 'breach_exempt' | 'unknown';
export type ScanModuleKey = 'freedom_camping' | 'parking_enforcement';

export interface OfficerScanPayload {
  operating_organization_id?: string;
  location_id?: string;
  client_site_id?: string;
  service_agreement_id?: string;
  location_source?: 'device_gps' | 'address_candidate' | 'manual_zone' | 'unavailable';
  plate_number?: string;
  image_base64?: string;
  gps_lat: number | null;
  gps_lng: number | null;
  zone_id?: string;
  module_key: ScanModuleKey;
  captured_at: string;
  client_request_id?: string;
  offline_queued?: boolean;
  synced_at?: string;
  recovery_original_context?: OfficerScanRecoveryContext;
}

export type OfficerScanRecoveryContext = Pick<OfficerScanPayload,
  'client_request_id' | 'captured_at' | 'module_key' | 'gps_lat' | 'gps_lng' | 'plate_number'
  | 'zone_id' | 'location_source' | 'operating_organization_id' | 'location_id' | 'client_site_id' | 'service_agreement_id'>;

export function getOfficerScanRecoveryContext(body: OfficerScanPayload): OfficerScanRecoveryContext {
  return body.recovery_original_context ?? {
    client_request_id: body.client_request_id, captured_at: body.captured_at, module_key: body.module_key,
    gps_lat: body.gps_lat, gps_lng: body.gps_lng, plate_number: body.plate_number, zone_id: body.zone_id,
    location_source: body.location_source, operating_organization_id: body.operating_organization_id,
    location_id: body.location_id, client_site_id: body.client_site_id, service_agreement_id: body.service_agreement_id,
  };
}

export interface ScanSafetyWarningSummary {
  id: string;
  hazard_class: string;
  alert_level: string;
  raised_at: string;
  organization_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_own_organization: boolean;
}

export interface OfficerScanResult {
  plate_number: string;
  plate_source: 'alpr' | 'manual';
  compliance_status: ScanComplianceStatus;
  is_compliant: boolean;
  compliance_reason: string | null;
  nights_this_zone: number;
  nights_this_month: number;
  limit_consecutive: number | null;
  limit_monthly: number | null;
  is_scv: boolean;
  /** Platform-wide H&S warnings on the plate, redacted (get_safety_warnings). */
  safety_warnings?: ScanSafetyWarningSummary[] | null;
  enforcement_exempt?: boolean;
  exemption_reason?: string | null;
  zone_id: string | null;
  zone_name: string | null;
  on_site: boolean | null;
  in_operating_bounds: boolean | null;
  out_of_bounds_district: string | null;
  effective_rules?: Record<string, unknown> | null;
  zone_closed?: boolean;
  zone_closure?: { closure_type: string; reason: string | null; effective_from: string; effective_to: string | null } | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_colour: string | null;
  observation_id: string;
  breach_alert_id: string | null;
  scan_window: string | null;
  overnight_verification_status: string | null;
  requires_morning_verification: boolean;
  breach_write_error?: string;
}

export interface QueuedOfficerScan {
  id: string;
  ownerId?: string;
  capturedAt: string;
  attempts: number;
  status?: 'pending' | 'needs_review';
  lastError?: string;
  body: OfficerScanPayload;
}

const DB_NAME = 'fcm-field-operations';
const DB_VERSION = 1;
const SCAN_STORE = 'officer-scan-queue';
export const MAX_UPLOAD_ATTEMPTS = 5;

import { normalizePlateNumber } from './canonicalIdentity';

export function normalizePlate(value: string): string {
  return normalizePlateNumber(value).slice(0, 10);
}

export function buildOfficerScanPayload(input: {
  plateNumber?: string;
  imageBase64?: string;
  latitude?: number | null;
  longitude?: number | null;
  zoneId?: string;
  capturedAt?: string;
  moduleKey?: ScanModuleKey;
  clientRequestId?: string;
  operatingOrganizationId?: string | null;
  locationId?: string | null;
  clientSiteId?: string | null;
  serviceAgreementId?: string | null;
  locationSource?: OfficerScanPayload['location_source'];
  recoveryOriginalContext?: OfficerScanRecoveryContext;
}): OfficerScanPayload {
  const plateNumber = normalizePlate(input.plateNumber ?? '');
  return {
    ...(input.operatingOrganizationId ? { operating_organization_id: input.operatingOrganizationId } : {}),
    ...(input.locationId ? { location_id: input.locationId } : {}),
    ...(input.clientSiteId ? { client_site_id: input.clientSiteId } : {}),
    ...(input.serviceAgreementId ? { service_agreement_id: input.serviceAgreementId } : {}),
    ...(plateNumber ? { plate_number: plateNumber } : {}),
    ...(input.imageBase64 ? { image_base64: input.imageBase64 } : {}),
    gps_lat: input.latitude ?? null,
    gps_lng: input.longitude ?? null,
    ...(input.zoneId ? { zone_id: input.zoneId } : {}),
    module_key: input.moduleKey ?? 'freedom_camping',
    captured_at: input.capturedAt ?? new Date().toISOString(),
    location_source: input.locationSource ?? (input.zoneId ? 'manual_zone' : 'unavailable'),
    ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
    ...(input.recoveryOriginalContext ? { recovery_original_context: input.recoveryOriginalContext } : {}),
  };
}

export function canSubmitOfficerScan(payload: OfficerScanPayload): boolean {
  if (payload.recovery_original_context && !payload.plate_number) return false;
  const hasEvidence = Boolean(payload.plate_number || payload.image_base64);
  const hasLocation = Boolean(
    payload.zone_id || (payload.location_source === 'device_gps' && payload.gps_lat !== null && payload.gps_lng !== null),
  );
  return hasEvidence && hasLocation;
}

export function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  return name === 'FunctionsFetchError' || /failed to fetch|network|load failed|fetch/i.test(message);
}

export async function describeOfficerScanError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json() as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) return body.error.slice(0, 500);
    } catch {
      return 'The scan service rejected the request without a readable error. Keep the saved capture for review.';
    }
  }
  return error instanceof Error ? error.message : 'The scan could not be processed.';
}

export async function imageFileToBase64(file: File, maxDimension = 1600): Promise<string> {
  const source = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    source.close();
    throw new Error('Image processing is unavailable on this device.');
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export function getCurrentPosition(timeoutMs = 8000): Promise<GeolocationPosition> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.reject(new Error('Location is unavailable on this device.'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: timeoutMs,
    });
  });
}

function openScanDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SCAN_STORE)) {
        request.result.createObjectStore(SCAN_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Offline storage could not be opened.'));
  });
}

async function runStoreRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openScanDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SCAN_STORE, mode);
    const request = operation(transaction.objectStore(SCAN_STORE));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error('Offline scan storage failed.'));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Offline scan transaction failed.')); };
  });
}

export async function queueOfficerScan(body: OfficerScanPayload, ownerId?: string): Promise<QueuedOfficerScan> {
  const requestId = body.client_request_id ?? crypto.randomUUID();
  const database = await openScanDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SCAN_STORE, 'readwrite');
    const store = transaction.objectStore(SCAN_STORE);
    const lookup = store.get(requestId);
    let queued: QueuedOfficerScan;
    let failure: Error | undefined;
    lookup.onsuccess = () => {
      const existing = lookup.result as QueuedOfficerScan | undefined;
      if (existing && (existing.ownerId !== ownerId || existing.body.image_base64 !== body.image_base64
        || existing.body.captured_at !== body.captured_at || existing.body.module_key !== body.module_key)) {
        failure = new Error('This saved request belongs to a different capture. Its original photo has been retained.');
        transaction.abort();
        return;
      }
      queued = {
        id: requestId, ownerId, capturedAt: body.captured_at,
        attempts: existing?.attempts ?? 0, status: 'pending',
        body: { ...body, client_request_id: requestId, offline_queued: true,
          recovery_original_context: getOfficerScanRecoveryContext(existing?.body ?? { ...body, client_request_id: requestId }) },
      };
      store.put(queued);
    };
    transaction.oncomplete = () => { database.close(); resolve(queued); };
    transaction.onerror = transaction.onabort = () => {
      database.close();
      reject(failure ?? transaction.error ?? new Error('The saved capture could not be updated safely.'));
    };
  });
}

export async function listQueuedOfficerScans(ownerId?: string): Promise<QueuedOfficerScan[]> {
  const scans = await runStoreRequest<QueuedOfficerScan[]>('readonly', (store) => store.getAll());
  return scans.filter((scan) => !ownerId || scan.ownerId === ownerId).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

export async function removeQueuedOfficerScan(id: string): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.delete(id));
}

export async function markQueuedOfficerScanAttempt(scan: QueuedOfficerScan, lastError?: string, needsReview = false): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.put({ ...scan, attempts: scan.attempts + 1, lastError, status: needsReview ? 'needs_review' : 'pending' }));
}

export function shouldDropQueuedOfficerScan(scan: QueuedOfficerScan): boolean {
  return scan.attempts + 1 >= MAX_UPLOAD_ATTEMPTS;
}
export type ScanComplianceStatus = 'compliant' | 'at_risk' | 'breach' | 'breach_exempt' | 'unknown';
export type ScanModuleKey = 'freedom_camping' | 'parking_enforcement';

export interface OfficerScanPayload {
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
  enforcement_exempt?: boolean;
  exemption_reason?: string | null;
  zone_id: string | null;
  zone_name: string | null;
  on_site: boolean;
  in_operating_bounds: boolean;
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
  capturedAt: string;
  attempts: number;
  body: OfficerScanPayload;
}

const DB_NAME = 'fcm-field-operations';
const DB_VERSION = 1;
const SCAN_STORE = 'officer-scan-queue';

export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
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
}): OfficerScanPayload {
  const plateNumber = normalizePlate(input.plateNumber ?? '');
  return {
    ...(plateNumber ? { plate_number: plateNumber } : {}),
    ...(input.imageBase64 ? { image_base64: input.imageBase64 } : {}),
    gps_lat: input.latitude ?? null,
    gps_lng: input.longitude ?? null,
    ...(input.zoneId ? { zone_id: input.zoneId } : {}),
    module_key: input.moduleKey ?? 'freedom_camping',
    captured_at: input.capturedAt ?? new Date().toISOString(),
    ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
  };
}

export function canSubmitOfficerScan(payload: OfficerScanPayload): boolean {
  const hasEvidence = Boolean(payload.plate_number || payload.image_base64);
  const hasLocation = Boolean(
    payload.zone_id || (payload.gps_lat !== null && payload.gps_lng !== null),
  );
  return hasEvidence && hasLocation;
}

export function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  return name === 'FunctionsFetchError' || /failed to fetch|network|load failed|fetch/i.test(message);
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Offline scan storage failed.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error('Offline scan transaction failed.'));
  });
}

export async function queueOfficerScan(body: OfficerScanPayload): Promise<QueuedOfficerScan> {
  const capturedAt = body.captured_at;
  const queued: QueuedOfficerScan = {
    id: crypto.randomUUID(),
    capturedAt,
    attempts: 0,
    body: { ...body, offline_queued: true },
  };
  await runStoreRequest('readwrite', (store) => store.put(queued));
  return queued;
}

export async function listQueuedOfficerScans(): Promise<QueuedOfficerScan[]> {
  const scans = await runStoreRequest<QueuedOfficerScan[]>('readonly', (store) => store.getAll());
  return scans.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}

export async function removeQueuedOfficerScan(id: string): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.delete(id));
}

export async function markQueuedOfficerScanAttempt(scan: QueuedOfficerScan): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.put({ ...scan, attempts: scan.attempts + 1 }));
}
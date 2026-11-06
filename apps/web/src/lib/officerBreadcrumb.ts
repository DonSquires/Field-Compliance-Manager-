import { supabase } from './supabase';

export const BREADCRUMB_INTERVAL_MS = 120_000;

export interface OfficerBreadcrumb {
  clientEventId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  heading: number | null;
  speedKmh: number | null;
  physicalAddress: string | null;
  activityType: 'gps_update';
  shiftId: string | null;
}

interface QueuedBreadcrumb {
  id: string;
  attempts: number;
  event: OfficerBreadcrumb;
  /** Absent on items queued before ownership was recorded. */
  ownerUserId?: string;
}

// Mirrors the role gate in public.record_officer_breadcrumb.
const BREADCRUMB_ROLES = new Set(['officer', 'admin_officer', 'scan_operator']);

export function canRecordOfficerBreadcrumbs(role: string | null | undefined): boolean {
  return typeof role === 'string' && BREADCRUMB_ROLES.has(role);
}

/**
 * record_officer_breadcrumb raises P0001 only for validation failures (stale
 * capture window, bad coordinates, foreign shift, non-officer session). Those
 * can never succeed on retry and would otherwise block the queue forever.
 */
export function isPermanentBreadcrumbRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P0001';
}

export type BreadcrumbDeliveryResult =
  | { confirmed: true; pendingCount: number }
  | { confirmed: false; pendingCount: number; error: string };

const DB_NAME = 'fcm-officer-breadcrumbs';
const DB_VERSION = 1;
const STORE_NAME = 'pending-breadcrumbs';

export function buildOfficerBreadcrumb(position: GeolocationPosition, shiftId?: string | null, physicalAddress?: string | null): OfficerBreadcrumb {
  return {
    clientEventId: crypto.randomUUID(),
    recordedAt: new Date(position.timestamp).toISOString(),
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    heading: position.coords.heading,
    speedKmh: position.coords.speed === null ? null : position.coords.speed * 3.6,
    physicalAddress: physicalAddress ?? null,
    activityType: 'gps_update',
    shiftId: shiftId ?? null,
  };
}

export function isBreadcrumbDue(lastCapturedAt: number | null, now: number): boolean {
  return lastCapturedAt === null || now - lastCapturedAt >= BREADCRUMB_INTERVAL_MS;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Breadcrumb storage could not be opened.'));
  });
}

function runStoreRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Breadcrumb storage failed.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error('Breadcrumb transaction failed.'));
  }));
}

async function listQueuedBreadcrumbs(): Promise<QueuedBreadcrumb[]> {
  const queued = await runStoreRequest<QueuedBreadcrumb[]>('readonly', (store) => store.getAll());
  return queued.sort((left, right) => left.event.recordedAt.localeCompare(right.event.recordedAt));
}

async function saveQueuedBreadcrumb(queued: QueuedBreadcrumb): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.put(queued));
}

async function removeQueuedBreadcrumb(id: string): Promise<void> {
  await runStoreRequest('readwrite', (store) => store.delete(id));
}

async function sendBreadcrumb(event: OfficerBreadcrumb): Promise<void> {
  const { error } = await supabase.rpc('record_officer_breadcrumb', {
    p_client_event_id: event.clientEventId,
    p_recorded_at: event.recordedAt,
    p_gps_lat: event.latitude,
    p_gps_lng: event.longitude,
    p_accuracy_meters: event.accuracyMeters,
    p_heading: event.heading,
    p_speed_kmh: event.speedKmh,
    p_physical_address: event.physicalAddress,
    p_activity_type: event.activityType,
    p_shift_id: event.shiftId,
  });
  if (error) throw error;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return fallback;
}

async function pendingCountFor(ownerUserId: string): Promise<number> {
  const items = await listQueuedBreadcrumbs();
  return items.filter((item) => belongsTo(item, ownerUserId)).length;
}

function belongsTo(item: QueuedBreadcrumb, ownerUserId: string): boolean {
  return item.ownerUserId === undefined || item.ownerUserId === ownerUserId;
}

export async function captureOfficerBreadcrumb(event: OfficerBreadcrumb, ownerUserId: string): Promise<BreadcrumbDeliveryResult> {
  const queued: QueuedBreadcrumb = { id: event.clientEventId, attempts: 0, event, ownerUserId };
  try {
    await saveQueuedBreadcrumb(queued);
    await sendBreadcrumb(event);
    await removeQueuedBreadcrumb(queued.id);
    return { confirmed: true, pendingCount: await pendingCountFor(ownerUserId) };
  } catch (error) {
    if (isPermanentBreadcrumbRejection(error)) await removeQueuedBreadcrumb(queued.id).catch(() => undefined);
    return {
      confirmed: false,
      pendingCount: await pendingCountFor(ownerUserId).catch(() => 1),
      error: errorMessage(error, 'Breadcrumb receipt was not confirmed.'),
    };
  }
}

/** Sends only the signed-in officer's queued positions; another login's items wait for that login. */
export async function flushOfficerBreadcrumbs(ownerUserId: string): Promise<BreadcrumbDeliveryResult> {
  try {
    const queued = (await listQueuedBreadcrumbs()).filter((item) => belongsTo(item, ownerUserId));
    for (const item of queued) {
      try {
        await sendBreadcrumb(item.event);
        await removeQueuedBreadcrumb(item.id);
      } catch (error) {
        if (isPermanentBreadcrumbRejection(error)) {
          await removeQueuedBreadcrumb(item.id);
          continue;
        }
        await saveQueuedBreadcrumb({ ...item, attempts: item.attempts + 1 });
        return {
          confirmed: false,
          pendingCount: await pendingCountFor(ownerUserId),
          error: errorMessage(error, 'Queued breadcrumbs remain unconfirmed.'),
        };
      }
    }
    return { confirmed: true, pendingCount: 0 };
  } catch (error) {
    return {
      confirmed: false,
      pendingCount: 0,
      error: error instanceof Error ? error.message : 'Breadcrumb queue could not be read.',
    };
  }
}
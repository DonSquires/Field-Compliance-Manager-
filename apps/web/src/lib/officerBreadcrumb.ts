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
  activityType: 'gps_update';
  shiftId: string | null;
}

interface QueuedBreadcrumb {
  id: string;
  attempts: number;
  event: OfficerBreadcrumb;
}

export type BreadcrumbDeliveryResult =
  | { confirmed: true; pendingCount: number }
  | { confirmed: false; pendingCount: number; error: string };

const DB_NAME = 'fcm-officer-breadcrumbs';
const DB_VERSION = 1;
const STORE_NAME = 'pending-breadcrumbs';

export function buildOfficerBreadcrumb(position: GeolocationPosition, shiftId?: string | null): OfficerBreadcrumb {
  return {
    clientEventId: crypto.randomUUID(),
    recordedAt: new Date(position.timestamp).toISOString(),
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    heading: position.coords.heading,
    speedKmh: position.coords.speed === null ? null : position.coords.speed * 3.6,
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
    p_activity_type: event.activityType,
    p_shift_id: event.shiftId,
  });
  if (error) throw error;
}

export async function captureOfficerBreadcrumb(event: OfficerBreadcrumb): Promise<BreadcrumbDeliveryResult> {
  const queued: QueuedBreadcrumb = { id: event.clientEventId, attempts: 0, event };
  try {
    await saveQueuedBreadcrumb(queued);
    await sendBreadcrumb(event);
    await removeQueuedBreadcrumb(queued.id);
    return { confirmed: true, pendingCount: (await listQueuedBreadcrumbs()).length };
  } catch (error) {
    return {
      confirmed: false,
      pendingCount: await listQueuedBreadcrumbs().then((items) => items.length).catch(() => 1),
      error: error instanceof Error ? error.message : 'Breadcrumb receipt was not confirmed.',
    };
  }
}

export async function flushOfficerBreadcrumbs(): Promise<BreadcrumbDeliveryResult> {
  try {
    const queued = await listQueuedBreadcrumbs();
    for (const item of queued) {
      try {
        await sendBreadcrumb(item.event);
        await removeQueuedBreadcrumb(item.id);
      } catch (error) {
        await saveQueuedBreadcrumb({ ...item, attempts: item.attempts + 1 });
        return {
          confirmed: false,
          pendingCount: (await listQueuedBreadcrumbs()).length,
          error: error instanceof Error ? error.message : 'Queued breadcrumbs remain unconfirmed.',
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
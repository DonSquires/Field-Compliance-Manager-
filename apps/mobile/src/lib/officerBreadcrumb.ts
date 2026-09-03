import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export const BREADCRUMB_INTERVAL_MS = 120_000;
const QUEUE_KEY = 'fcm-mobile-officer-breadcrumb-queue-v1';

export type OfficerBreadcrumb = {
  clientEventId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  shiftId: string | null;
};

export type QueuedBreadcrumb = { attempts: number; event: OfficerBreadcrumb };

async function listQueue(): Promise<QueuedBreadcrumb[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as QueuedBreadcrumb[]; } catch { return []; }
}

async function saveQueue(queue: QueuedBreadcrumb[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

async function send(event: OfficerBreadcrumb): Promise<void> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const { error } = await supabase.rpc('record_officer_breadcrumb', {
    p_client_event_id: event.clientEventId,
    p_recorded_at: event.recordedAt,
    p_gps_lat: event.latitude,
    p_gps_lng: event.longitude,
    p_accuracy_meters: event.accuracyMeters,
    p_heading: null,
    p_speed_kmh: null,
    p_activity_type: 'gps_update',
    p_shift_id: event.shiftId,
  });
  if (error) throw error;
}

export async function recordMobileBreadcrumb(input: Omit<OfficerBreadcrumb, 'clientEventId' | 'recordedAt'>): Promise<{ confirmed: boolean; pending: number }> {
  const event: OfficerBreadcrumb = { ...input, clientEventId: crypto.randomUUID(), recordedAt: new Date().toISOString() };
  const queue = await listQueue();
  queue.push({ attempts: 0, event });
  await saveQueue(queue);
  try {
    await send(event);
    const remaining = (await listQueue()).filter((item) => item.event.clientEventId !== event.clientEventId);
    await saveQueue(remaining);
    return { confirmed: true, pending: remaining.length };
  } catch {
    return { confirmed: false, pending: queue.length };
  }
}

export async function flushMobileBreadcrumbs(): Promise<{ confirmed: boolean; pending: number }> {
  const queue = await listQueue();
  const pending: QueuedBreadcrumb[] = [];
  for (const item of queue) {
    try { await send(item.event); } catch { pending.push({ ...item, attempts: item.attempts + 1 }); }
  }
  await saveQueue(pending);
  return { confirmed: pending.length === 0, pending: pending.length };
}
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { supabase } from './supabase';

const QUEUE_KEY = 'fcm-mobile-officer-scan-queue-v1';
const MAX_UPLOAD_ATTEMPTS = 5;

export type ScanModuleKey = 'freedom_camping' | 'parking_enforcement';

export type OfficerScanPayload = {
  plate_number?: string;
  image_base64: string;
  gps_lat: number | null;
  gps_lng: number | null;
  module_key: ScanModuleKey;
  captured_at: string;
  client_request_id: string;
  offline_queued?: boolean;
  synced_at?: string;
};

export type OfficerScanResult = {
  observation_id: string;
  plate_number: string;
  compliance_status: 'compliant' | 'at_risk' | 'breach' | 'breach_exempt' | 'unknown';
  compliance_reason: string | null;
  zone_name: string | null;
  breach_alert_id: string | null;
};

export type QueuedOfficerScan = { id: string; attempts: number; payload: OfficerScanPayload };

export async function captureVehiclePhoto(): Promise<string | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('Camera permission is required to capture vehicle evidence.');
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing: false,
  });
  if (result.canceled) return null;
  return result.assets[0]?.uri ?? null;
}

export async function chooseVehiclePhoto(): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('Photo library permission is required to select vehicle evidence.');
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false });
  if (result.canceled) return null;
  return result.assets[0]?.uri ?? null;
}

export async function captureEvidencePhoto(source: 'camera' | 'library'): Promise<{ uri: string; base64: string }> {
  const uri = source === 'camera' ? await captureVehiclePhoto() : await chooseVehiclePhoto();
  if (!uri) throw new Error('No photo was selected.');
  const base64 = await imageUriToBase64(uri);
  return { uri, base64 };
}

export async function imageUriToBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

export async function captureCoordinates(): Promise<{ lat: number; lng: number } | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return null;
  const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: location.coords.latitude, lng: location.coords.longitude };
}

export async function submitOfficerScan(payload: OfficerScanPayload): Promise<OfficerScanResult> {
  if (!supabase) throw new Error('Mobile client configuration is unavailable.');
  const { data, error } = await supabase.functions.invoke<OfficerScanResult>('process-officer-scan', { body: payload });
  if (error) throw error;
  if (!data?.observation_id) throw new Error('The scan completed without an observation receipt.');
  return data;
}

export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  return name === 'FunctionsFetchError' || /failed to fetch|network|load failed|network request failed/i.test(message);
}

export async function listQueuedOfficerScans(): Promise<QueuedOfficerScan[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as QueuedOfficerScan[]; } catch { return []; }
}

export async function queueOfficerScan(payload: OfficerScanPayload): Promise<void> {
  const queue = await listQueuedOfficerScans();
  queue.push({ id: crypto.randomUUID(), attempts: 0, payload: { ...payload, offline_queued: true } });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function removeQueuedOfficerScan(id: string): Promise<void> {
  const queue = await listQueuedOfficerScans();
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter((item) => item.id !== id)));
}

export async function syncQueuedOfficerScans(): Promise<{ synced: number; pending: number; dropped: number }> {
  const queue = await listQueuedOfficerScans();
  const pending: QueuedOfficerScan[] = [];
  let synced = 0;
  let dropped = 0;
  for (const item of queue) {
    try {
      await submitOfficerScan({ ...item.payload, synced_at: new Date().toISOString() });
      synced += 1;
    } catch {
      const attempts = item.attempts + 1;
      // Drop rather than retry forever so a permanently-rejected scan cannot grow the queue unbounded.
      if (attempts >= MAX_UPLOAD_ATTEMPTS) dropped += 1;
      else pending.push({ ...item, attempts });
    }
  }
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(pending));
  return { synced, pending: pending.length, dropped };
}
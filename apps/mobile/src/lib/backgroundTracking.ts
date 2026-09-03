import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { BREADCRUMB_INTERVAL_MS, recordMobileBreadcrumb } from './officerBreadcrumb';

export const BACKGROUND_LOCATION_TASK = 'fcm-officer-background-location';
const TRACKING_CONTEXT_KEY = 'fcm-mobile-background-tracking-context-v1';

type TrackingContext = { shiftId: string };

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const location = locations.at(-1);
  if (!location) return;
  const rawContext = await AsyncStorage.getItem(TRACKING_CONTEXT_KEY);
  if (!rawContext) return;
  let context: TrackingContext;
  try { context = JSON.parse(rawContext) as TrackingContext; } catch { return; }
  await recordMobileBreadcrumb({
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracyMeters: location.coords.accuracy ?? null,
    shiftId: context.shiftId,
  });
});

export async function startMobileBackgroundTracking(shiftId: string): Promise<void> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Foreground location permission is required to track an active shift.');
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) throw new Error('Background location permission is required to continue tracking outside the app.');
  await AsyncStorage.setItem(TRACKING_CONTEXT_KEY, JSON.stringify({ shiftId } satisfies TrackingContext));
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: BREADCRUMB_INTERVAL_MS,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Field tracking active',
      notificationBody: 'Location is being recorded for your active shift.',
    },
  });
}

export async function stopMobileBackgroundTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await AsyncStorage.removeItem(TRACKING_CONTEXT_KEY);
}

export function isMobileBackgroundTrackingActive(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
}
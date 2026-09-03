import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { supabase } from './supabase';

const TOKEN_STORAGE_KEY = 'fcm_officer_device_token';

export type DeviceTokenReceipt = {
  id: string;
  push_token: string;
  platform: string;
  is_active: boolean;
  last_seen_at: string;
};

export async function getStoredDeviceToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function registerOfficerDeviceToken(
  customToken?: string,
  platformOverride?: 'expo' | 'ios' | 'android' | 'web',
  deviceName?: string,
  appVersion?: string
): Promise<DeviceTokenReceipt | null> {
  if (!supabase) return null;

  const platform = platformOverride ?? (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'expo');
  const token = customToken ?? (await getStoredDeviceToken()) ?? `ExponentPushToken[mock-${Date.now()}]`;

  const { data, error } = await supabase.rpc('register_officer_device_token', {
    p_push_token: token,
    p_platform: platform,
    p_device_name: deviceName ?? `Device (${platform})`,
    p_app_version: appVersion ?? '1.0.0',
  });

  const receipt = (data as DeviceTokenReceipt[] | null)?.[0];
  if (error || !receipt) {
    throw error ?? new Error('Device token registration was not confirmed.');
  }

  try {
    await AsyncStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Non-fatal cache failure
  }

  return receipt;
}

export async function unregisterOfficerDeviceToken(): Promise<boolean> {
  if (!supabase) return false;
  const token = await getStoredDeviceToken();
  if (!token) return false;

  const { data, error } = await supabase.rpc('unregister_officer_device_token', {
    p_push_token: token,
  });

  if (!error && data) {
    try {
      await AsyncStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Non-fatal cache failure
    }
    return true;
  }

  return false;
}

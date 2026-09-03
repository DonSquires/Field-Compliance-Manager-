import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const OFFLINE_PACKAGE_STORAGE_KEY = 'fcm_offline_data_package';

export type OfficerDataPackage = {
  package_timestamp: string;
  organization_id: string;
  officer_id: string;
  shift_id: string | null;
  location_zones: Array<{
    id: string;
    location_id: string | null;
    name: string;
    address: string | null;
    zone_type: string;
    module_key: string;
    rule_type: string;
    is_active: boolean;
  }>;
  zone_compliance_matrix: Array<{
    id: string;
    zone_id: string;
    max_consecutive_nights: number | null;
    max_nights_per_month: number | null;
    scv_required: boolean | null;
    is_current: boolean;
  }>;
  entity_flags: Array<{
    id: string;
    entity_type: string;
    plate_number: string | null;
    flag_type: string;
    flag_reason: string;
    severity: string;
    is_active: boolean;
  }>;
  module_rule_sets: Array<{
    id: string;
    module_key: string;
    name: string;
    evidence_requirements: unknown;
    approval_policy: unknown;
  }>;
  shift_stops: Array<{
    id: string;
    site_id: string | null;
    zone_id: string | null;
    status: string;
    sla_respond_by: string | null;
    notes: string | null;
  }>;
  welfare_settings: Record<string, unknown>;
};

export async function getCachedOfficerDataPackage(): Promise<OfficerDataPackage | null> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_PACKAGE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OfficerDataPackage;
  } catch {
    return null;
  }
}

export async function downloadOfficerDataPackage(shiftId: string | null = null): Promise<OfficerDataPackage> {
  if (!supabase) throw new Error('Supabase client unavailable.');

  const { data, error } = await supabase.rpc('get_officer_data_package', {
    p_shift_id: shiftId,
  });

  if (error || !data) {
    throw error ?? new Error('Data package download was not confirmed.');
  }

  const pkg = data as unknown as OfficerDataPackage;

  try {
    await AsyncStorage.setItem(OFFLINE_PACKAGE_STORAGE_KEY, JSON.stringify(pkg));
  } catch {
    // Non-fatal cache write error
  }

  return pkg;
}

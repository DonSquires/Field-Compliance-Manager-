import { supabase } from './supabase';
import type { PermitSummary, PermitValidityState } from './permits';

const FIELDWORK_PERMIT_COLUMNS =
  'id, canonical_person_id, holder_name, permit_number, permit_type, forest_areas, activities, hunting_season, date_from, date_to, status, firearm_licence_valid, chainsaw_safety_equipment, keys_issued, conditions, compliance_checked_at, vehicle_plates';

interface FieldworkPermitRow extends Omit<PermitSummary, 'vehicles'> {
  vehicle_plates: string[] | null;
  validity_state?: PermitValidityState | null;
}

interface PermitLoadError {
  code?: string;
  message: string;
}

const toSummary = (row: FieldworkPermitRow): PermitSummary => {
  const { vehicle_plates: plates, ...permit } = row;
  return {
    ...permit,
    vehicles: (plates ?? []).map((plate_number) => ({ canonical_vehicle_id: null, plate_number })),
  };
};

// ATLAS READS: person_permits_fieldwork
/** Forest/site access permits that list this plate, current permits first. */
export async function loadVehiclePermits(plate: string): Promise<{ data: PermitSummary[]; error: PermitLoadError | null }> {
  const read = (columns: string) => supabase
    .from('person_permits_fieldwork')
    .select(columns)
    .contains('vehicle_plates', [plate])
    .order('date_to', { ascending: false, nullsFirst: false });
  let result = await read(`${FIELDWORK_PERMIT_COLUMNS}, validity_state`);
  // 42703 = undefined column: the view predates validity_state, so derive it in the card instead.
  if (result.error?.code === '42703') result = await read(FIELDWORK_PERMIT_COLUMNS);
  if (result.error) return { data: [], error: result.error };
  return { data: ((result.data ?? []) as unknown as FieldworkPermitRow[]).map(toSummary), error: null };
}

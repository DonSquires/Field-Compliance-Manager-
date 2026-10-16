import { supabase } from './supabase';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface BriefingHazard {
  id: string;
  title: string;
  hazard_class: string;
  risk_level: RiskLevel;
  controls: string[];
  details: string | null;
  status: 'reported' | 'active';
  origin: 'bob_extracted' | 'officer_reported' | 'manual';
  version: number;
  place_name: string;
  place_kind: 'site' | 'zone' | 'location';
  source_name: string | null;
  source_locator: string | null;
  source_as_of: string | null;
  has_source_document: boolean;
  recorded_by: string;
  updated_at: string;
}

export interface BriefingWarning {
  id: string;
  hazard_class: string;
  alert_level: RiskLevel;
  raised_at: string;
  organization_name: string;
  contact_phone: string | null;
  reason: string | null;
}

export interface BriefingPlace { kind: 'site' | 'zone'; id: string; location_id: string; name: string }

export interface SafetyBriefing {
  shift_id: string;
  stop_id: string | null;
  shift_status: string;
  places: BriefingPlace[];
  hazards: BriefingHazard[];
  warnings: BriefingWarning[];
  item_count: number;
  briefing_hash: string;
  acknowledgement_required: boolean;
  acknowledged: boolean;
  acknowledged_at: string | null;
  changed_since_acknowledgement: boolean;
  is_assigned_officer: boolean;
}

/** Officer-readable names for place_hazards.hazard_class (and the entity_flags subset). */
export const HAZARD_CLASS_LABELS: Record<string, string> = {
  violence_or_aggression: 'Violence or aggression',
  weapons: 'Weapons',
  dangerous_dog: 'Dangerous dog',
  hazardous_substances: 'Hazardous substances',
  biological_or_infection: 'Biological or infection risk',
  sharps: 'Sharps or needles',
  slips_trips_falls: 'Slips, trips and falls',
  traffic_and_vehicles: 'Traffic and vehicles',
  working_at_height: 'Working at height',
  electrical: 'Electrical',
  fire_or_explosion: 'Fire or explosion',
  confined_space: 'Confined space',
  lone_working: 'Lone working',
  weather_or_environment: 'Weather or environment',
  security_threat: 'Security threat',
  manual_handling: 'Manual handling',
  medical_or_welfare: 'Medical or welfare',
  unsafe_structure_or_ground: 'Unsafe structure or ground',
  vehicle_defect: 'Vehicle defect',
  other: 'Other hazard',
};

export const HAZARD_CLASSES = Object.keys(HAZARD_CLASS_LABELS).filter((key) => key !== 'vehicle_defect');

export const RISK_LABELS: Record<RiskLevel, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export const hazardClassLabel = (value: string): string => HAZARD_CLASS_LABELS[value] ?? value.replaceAll('_', ' ');

export const briefingNeedsAcknowledgement = (briefing: SafetyBriefing | null): boolean =>
  Boolean(briefing && briefing.is_assigned_officer && briefing.acknowledgement_required && !briefing.acknowledged);

/** Where the hazard came from, in one line: "Site H&S plan · Section 4.2 · 1 Sep 2026". */
export const describeHazardSource = (hazard: Pick<BriefingHazard, 'source_name' | 'source_locator' | 'source_as_of' | 'origin'>): string => {
  const parts = [hazard.source_name, hazard.source_locator, hazard.source_as_of ? new Date(`${hazard.source_as_of}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : null].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return hazard.origin === 'officer_reported' ? 'Reported by an officer on shift' : 'Recorded by your organisation';
};

export async function fetchShiftSafetyBriefing(shiftId: string, stopId: string | null = null): Promise<SafetyBriefing> {
  // ATLAS READS: get_shift_safety_briefing
  const { data, error } = await supabase.rpc('get_shift_safety_briefing', { p_shift_id: shiftId, p_stop_id: stopId });
  if (error) throw new Error(error.message);
  return data as SafetyBriefing;
}

export type AcknowledgeResult = { ok: true; acknowledgedAt: string } | { ok: false; changed: boolean; message: string };

export async function acknowledgeSafetyBriefing(briefing: SafetyBriefing, requestId: string, coords?: { lat: number | null; lng: number | null }): Promise<AcknowledgeResult> {
  // ATLAS WRITES: acknowledge_safety_briefing (rejects a briefing that changed while it was being read)
  const { data, error } = await supabase.rpc('acknowledge_safety_briefing', {
    p_shift_id: briefing.shift_id,
    p_briefing_hash: briefing.briefing_hash,
    p_client_request_id: requestId,
    p_stop_id: briefing.stop_id,
    p_gps_lat: coords?.lat ?? null,
    p_gps_lng: coords?.lng ?? null,
  });
  if (error) return { ok: false, changed: error.hint === 'briefing_changed' || /briefing changed/i.test(error.message), message: error.message };
  return { ok: true, acknowledgedAt: (data as { acknowledged_at: string }).acknowledged_at };
}

export interface HazardReportInput { shiftId: string; placeKind: 'site' | 'zone'; placeId: string; title: string; hazardClass: string; riskLevel: RiskLevel; details: string; controls: string[] }

export async function reportPlaceHazard(input: HazardReportInput, requestId: string): Promise<string> {
  // ATLAS WRITES: report_place_hazard
  const { data, error } = await supabase.rpc('report_place_hazard', {
    p_shift_id: input.shiftId,
    p_place_kind: input.placeKind,
    p_place_id: input.placeId,
    p_title: input.title.trim(),
    p_hazard_class: input.hazardClass,
    p_risk_level: input.riskLevel,
    p_client_request_id: requestId,
    p_details: input.details.trim() || null,
    p_controls: input.controls.map((control) => control.trim()).filter(Boolean),
  });
  if (error || !data) throw new Error(error?.message ?? 'The hazard report was not confirmed.');
  return data as string;
}

/**
 * Opens the hazard's source document through a short-lived signed link (place-hazard-source).
 * The tab is opened synchronously in the click so mobile browsers do not block it as a pop-up.
 */
export async function openHazardSource(hazardId: string): Promise<{ opened: boolean; message?: string }> {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  // ATLAS CALLS: place-hazard-source
  const { data, error } = await supabase.functions.invoke('place-hazard-source', { body: { hazard_id: hazardId } });
  const result = (data ?? {}) as { has_document?: boolean; url?: string; source_name?: string | null; source_locator?: string | null; error?: string };
  if (error || result.error || !result.has_document || !result.url) {
    tab?.close();
    if (error || result.error) return { opened: false, message: error?.message ?? result.error };
    return { opened: false, message: `The source document is not attached${result.source_name ? ` (${[result.source_name, result.source_locator].filter(Boolean).join(', ')})` : ''}. Ask your supervisor for a copy.` };
  }
  if (tab) tab.location.href = result.url;
  else window.location.assign(result.url);
  return { opened: true };
}

import { edgeFunctionErrorMessage } from './edgeFunctionError';
import { supabase } from './supabase';
import { parseSafetyBriefing, type SafetyBriefing } from './safetyBriefing';

export const isStaticGuardingService = (value: string | null | undefined): boolean =>
  ['static_guarding', 'site_guard', 'static'].includes(value?.trim().toLowerCase() ?? '');

export interface OfficerStaticBriefing {
  post: unknown;
  safety: SafetyBriefing | null;
  privacy: { status: 'checked' | 'partly_withheld' | 'unavailable'; message?: string };
  requirements: string[] | null;
  roster_notes: string | null;
  work_unit_name: string | null;
  contacts: Array<{ id: string; name: string; role: string | null; phone: string | null; kind: string }>;
}

export async function fetchOfficerStaticBriefing(shiftId: string | null, stopId: string | null = null): Promise<OfficerStaticBriefing> {
  const body = stopId ? { shift_id: shiftId, stop_id: stopId } : { shift_id: shiftId };
  const { data, error } = await supabase.functions.invoke('officer-shift-briefing', { body });
  if (error || data?.error) {
    const fallback = error?.message && !/non-2xx status code/i.test(error.message) ? error.message : 'The private shift briefing could not be loaded.';
    throw new Error(data?.error ?? await edgeFunctionErrorMessage(error, fallback));
  }
  if (data?.post === null && data?.safety === null) return { post: null, safety: null, privacy: { status: 'unavailable' }, requirements: null, roster_notes: null, work_unit_name: null, contacts: [] };
  if (!data?.post || !['checked', 'partly_withheld', 'unavailable'].includes(data.privacy?.status)
    || (data.requirements !== null && (!Array.isArray(data.requirements) || data.requirements.some((value: unknown) => typeof value !== 'string')))
    || (data.roster_notes !== null && typeof data.roster_notes !== 'string')
    || (data.work_unit_name !== null && typeof data.work_unit_name !== 'string')
    || !Array.isArray(data.contacts) || data.contacts.some((value: OfficerStaticBriefing['contacts'][number]) => !value || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.kind !== 'string' || (value.role !== null && typeof value.role !== 'string') || (value.phone !== null && typeof value.phone !== 'string'))) throw new Error('Shift briefing data was incomplete. Retry or contact operations.');
  return data as OfficerStaticBriefing;
}

export async function fetchStaticShiftSafety(shiftId: string, stopId: string | null = null): Promise<SafetyBriefing> {
  const result = await fetchOfficerStaticBriefing(shiftId, stopId);
  if (result.privacy.status !== 'checked') {
    throw new Error(result.privacy.message ?? 'Safety details are withheld pending private Oracle review. Contact operations before starting.');
  }
  const safety = parseSafetyBriefing(result.safety, shiftId, stopId);
  if (!safety.is_assigned_officer) throw new Error('The assigned officer could not be confirmed for this safety briefing.');
  return safety;
}

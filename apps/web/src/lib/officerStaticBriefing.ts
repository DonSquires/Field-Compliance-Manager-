import { supabase } from './supabase';
import { parseSafetyBriefing, type SafetyBriefing } from './safetyBriefing';

export interface OfficerStaticBriefing {
  post: unknown;
  safety: SafetyBriefing | null;
  privacy: { status: 'checked' | 'partly_withheld' | 'unavailable'; message?: string };
  requirements: string[];
  contacts: Array<{ id: string; name: string; role: string | null; phone: string | null; kind: string }>;
}

export async function fetchOfficerStaticBriefing(shiftId: string | null): Promise<OfficerStaticBriefing> {
  const { data, error } = await supabase.functions.invoke('officer-shift-briefing', { body: { shift_id: shiftId } });
  if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'The private shift briefing could not be loaded.');
  if (data?.post === null && data?.safety === null) return { post: null, safety: null, privacy: { status: 'unavailable' }, requirements: [], contacts: [] };
  if (!data?.post || !['checked', 'partly_withheld', 'unavailable'].includes(data.privacy?.status)
    || !Array.isArray(data.requirements) || data.requirements.some((value: unknown) => typeof value !== 'string')
    || !Array.isArray(data.contacts) || data.contacts.some((value: OfficerStaticBriefing['contacts'][number]) => !value || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.kind !== 'string' || (value.role !== null && typeof value.role !== 'string') || (value.phone !== null && typeof value.phone !== 'string'))) throw new Error('Shift briefing data was incomplete. Retry or contact operations.');
  return data as OfficerStaticBriefing;
}

export async function fetchStaticShiftSafety(shiftId: string): Promise<SafetyBriefing> {
  const result = await fetchOfficerStaticBriefing(shiftId);
  if (result.privacy.status !== 'checked') {
    throw new Error(result.privacy.message ?? 'Safety details are withheld pending private Oracle review. Contact operations before starting.');
  }
  return parseSafetyBriefing(result.safety, shiftId);
}

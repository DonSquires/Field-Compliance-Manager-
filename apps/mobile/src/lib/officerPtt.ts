import { supabase } from './supabase';

export type PttTransmissionReceipt = {
  transmission_id: string;
  organization_id: string;
  state: string;
  started_at: string;
};

export type PttTranscriptReceipt = {
  segment_id: string;
  transmission_id: string;
  sequence: number;
  created_at: string;
};

export async function openPttTransmission(
  channelId: string | null = null,
  emergency: boolean = false
): Promise<PttTransmissionReceipt> {
  if (!supabase) throw new Error('Supabase client unavailable.');

  const { data, error } = await supabase.rpc('open_ptt_transmission', {
    p_channel_id: channelId,
    p_emergency: emergency,
    p_metadata: { source: 'mobile_ptt_client' },
  });

  const receipt = (data as PttTransmissionReceipt[] | null)?.[0];
  if (error || !receipt) {
    throw error ?? new Error('PTT transmission start was not confirmed.');
  }

  return receipt;
}

export async function closePttTransmission(
  transmissionId: string,
  state: 'ended' | 'failed' | 'emergency' = 'ended'
): Promise<boolean> {
  if (!supabase) return false;

  const { data, error } = await supabase.rpc('close_ptt_transmission', {
    p_transmission_id: transmissionId,
    p_state: state,
  });

  return !error && Boolean((data as unknown[])?.length);
}

export async function recordRadioTranscriptSegment(
  transmissionId: string,
  sequence: number,
  text: string,
  confidence: number = 1.0,
  isFinal: boolean = true
): Promise<PttTranscriptReceipt> {
  if (!supabase) throw new Error('Supabase client unavailable.');

  const { data, error } = await supabase.rpc('record_radio_transcript_segment', {
    p_transmission_id: transmissionId,
    p_sequence: sequence,
    p_text: text.trim(),
    p_confidence: confidence,
    p_is_final: isFinal,
  });

  const receipt = (data as PttTranscriptReceipt[] | null)?.[0];
  if (error || !receipt) {
    throw error ?? new Error('Radio transcript segment was not confirmed.');
  }

  return receipt;
}

import { supabase } from './supabase';

export type RegisteredEvidenceItem = {
  id: string;
  organization_id: string;
  module_key: string;
  evidence_kind: string;
  storage_path: string;
  sha256_hash: string | null;
  is_court_ready: boolean;
  retention_days: number;
  captured_at: string;
};

export type SealedEvidenceReceipt = {
  evidence_id: string;
  sha256_hash: string;
  is_court_ready: boolean;
  locked_at: string;
};

export async function registerEvidenceMedia(
  moduleKey: string,
  evidenceKind: 'photo' | 'video' | 'audio' | 'document' | 'note',
  storagePath: string,
  sha256Hash?: string,
  isCourtReady: boolean = false,
  retentionDays?: number,
  metadata?: Record<string, unknown>
): Promise<RegisteredEvidenceItem> {
  if (!supabase) throw new Error('Supabase client unavailable.');

  const { data, error } = await supabase.rpc('register_evidence_media_item', {
    p_module_key: moduleKey,
    p_evidence_kind: evidenceKind,
    p_storage_path: storagePath,
    p_sha256_hash: sha256Hash ?? null,
    p_is_court_ready: isCourtReady,
    p_retention_days: retentionDays ?? null,
    p_metadata: metadata ?? {},
  });

  const item = (data as RegisteredEvidenceItem[] | null)?.[0];
  if (error || !item) {
    throw error ?? new Error('Evidence media registration was not confirmed.');
  }

  return item;
}

export async function sealCourtReadyEvidence(
  evidenceId: string,
  sha256Hash: string,
  notes?: string
): Promise<SealedEvidenceReceipt> {
  if (!supabase) throw new Error('Supabase client unavailable.');

  const { data, error } = await supabase.rpc('seal_court_ready_evidence', {
    p_evidence_id: evidenceId,
    p_sha256_hash: sha256Hash,
    p_notes: notes ?? null,
  });

  const receipt = (data as SealedEvidenceReceipt[] | null)?.[0];
  if (error || !receipt) {
    throw error ?? new Error('Court-ready evidence sealing was not confirmed.');
  }

  return receipt;
}

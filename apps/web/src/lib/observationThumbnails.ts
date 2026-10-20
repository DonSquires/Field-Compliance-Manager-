import { supabase } from './supabase';

export interface ObservationPhotoSource {
  id: string;
  /** observations.photo_url: a scans-bucket path or an absolute URL. */
  photo_path: string | null;
}

/**
 * First available photo per observation, as a short-lived signed URL. The scan's
 * own photo wins; otherwise the earliest photo attached to the observation later
 * (observation_supporting_evidence or evidence_items, both in bob-uploads), the
 * same sources RecordEvidencePanel lists. Best-effort: lookup failures leave the
 * observation without a thumbnail rather than failing the caller.
 */
// ATLAS READS: observation_supporting_evidence, evidence_items
export async function loadObservationThumbnails(observations: ObservationPhotoSource[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (observations.length === 0) return result;

  const scanPaths = new Map<string, string>();
  for (const obs of observations) {
    if (!obs.photo_path) continue;
    if (/^https?:/i.test(obs.photo_path)) result[obs.id] = obs.photo_path;
    else scanPaths.set(obs.id, obs.photo_path);
  }

  if (scanPaths.size > 0) {
    try {
      const { data } = await supabase.storage.from('scans').createSignedUrls([...new Set(scanPaths.values())], 900);
      const byPath = new Map((data ?? []).filter((item) => item.signedUrl && !item.error && item.path).map((item) => [item.path as string, item.signedUrl as string]));
      for (const [id, path] of scanPaths) { const url = byPath.get(path); if (url) result[id] = url; }
    } catch { /* thumbnails are optional */ }
  }

  const missing = observations.map((obs) => obs.id).filter((id) => !result[id]);
  if (missing.length === 0) return result;

  const firstPath = new Map<string, { path: string; at: number }>();
  const consider = (id: unknown, path: unknown, capturedAt: unknown) => {
    if (typeof id !== 'string' || typeof path !== 'string' || !path) return;
    const at = typeof capturedAt === 'string' ? Date.parse(capturedAt) : Number.MAX_SAFE_INTEGER;
    const current = firstPath.get(id);
    if (!current || at < current.at) firstPath.set(id, { path, at });
  };
  try {
    const [supporting, items] = await Promise.all([
      supabase.from('observation_supporting_evidence').select('observation_id,storage_path,captured_at')
        .in('observation_id', missing).eq('evidence_kind', 'external_photo').order('captured_at').limit(500),
      supabase.from('evidence_items').select('storage_path,captured_at,metadata')
        .in('metadata->>observation_id', missing).order('captured_at').limit(500),
    ]);
    for (const row of (supporting.data ?? []) as Array<{ observation_id: string; storage_path: string | null; captured_at: string }>) {
      consider(row.observation_id, row.storage_path, row.captured_at);
    }
    for (const row of (items.data ?? []) as Array<{ storage_path: string | null; captured_at: string; metadata: Record<string, unknown> | null }>) {
      consider(row.metadata?.observation_id, row.storage_path, row.captured_at);
    }
    if (firstPath.size === 0) return result;
    const { data } = await supabase.storage.from('bob-uploads').createSignedUrls([...new Set([...firstPath.values()].map((item) => item.path))], 900);
    const byPath = new Map((data ?? []).filter((item) => item.signedUrl && !item.error && item.path).map((item) => [item.path as string, item.signedUrl as string]));
    for (const [id, { path }] of firstPath) { const url = byPath.get(path); if (url) result[id] = url; }
  } catch { /* thumbnails are optional */ }
  return result;
}

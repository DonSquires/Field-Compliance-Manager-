import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Paperclip } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { sha256Hex } from '../lib/importPreview';
import { MAX_PHOTO_BYTES, safeFileName } from './RecordEvidencePanel.helpers';

interface JobEvidenceRow { id: string; storage_path: string | null; captured_at: string; evidence_kind: string; metadata: Record<string, unknown> | null }

export function dispatchEvidencePath(organizationId: string, jobId: string, sha256: string, fileName: string): string {
  return `org/${organizationId}/dispatch-evidence/${jobId}/${sha256.slice(0, 16)}-${safeFileName(fileName)}`;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : 'Upload failed.');

/**
 * Photos and files from the officer's phone, attached to one dispatch job.
 * Governed path: bob-uploads storage (org-scoped prefix) then the
 * register_evidence_media_item RPC, which writes evidence_items + audit_log.
 */
export function DispatchJobEvidence({ jobId }: { jobId: string }) {
  const { profile } = useAuth();
  const organizationId = profile?.organizationId ?? null;
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<JobEvidenceRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ATLAS READS: evidence_items (metadata.dispatch_job_id)
  const load = useCallback(async () => {
    if (!organizationId) { setLoading(false); return; }
    setLoading(true);
    const { data, error: queryError } = await supabase
      .from('evidence_items')
      .select('id,storage_path,captured_at,evidence_kind,metadata')
      .eq('metadata->>dispatch_job_id', jobId)
      .order('captured_at', { ascending: false })
      .limit(24);
    if (queryError) { setError(`Could not load evidence for this job: ${queryError.message}`); setLoading(false); return; }
    const rows = (data ?? []) as JobEvidenceRow[];
    setItems(rows);
    const signed: Record<string, string> = {};
    await Promise.all(rows.filter((row) => row.storage_path && row.evidence_kind === 'photo').map(async (row) => {
      const { data: link } = await supabase.storage.from('bob-uploads').createSignedUrl(row.storage_path as string, 900);
      if (link?.signedUrl) signed[row.id] = link.signedUrl;
    }));
    setUrls(signed);
    setLoading(false);
  }, [jobId, organizationId]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length || !organizationId) return;
    setError(null); setNotice(null);
    const failures: string[] = [];
    let saved = 0;
    for (const [index, file] of files.entries()) {
      setProgress(`Uploading ${index + 1} of ${files.length}: ${file.name}`);
      if (file.size > MAX_PHOTO_BYTES) { failures.push(`${file.name} is over 15 MB`); continue; }
      try {
        const sha256 = await sha256Hex(await file.arrayBuffer());
        const path = dispatchEvidencePath(organizationId, jobId, sha256, file.name);
        const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        // The same file already uploaded to this job is fine: registration below is what matters.
        if (uploadError && !/already exists|Duplicate/i.test(uploadError.message)) throw uploadError;
        // ATLAS WRITES: register_evidence_media_item (evidence_items + audit_log)
        const { error: rpcError } = await supabase.rpc('register_evidence_media_item', {
          p_module_key: 'dispatch',
          p_evidence_kind: file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'document',
          p_storage_path: path,
          p_sha256_hash: sha256,
          p_is_court_ready: false,
          p_retention_days: null,
          p_metadata: { dispatch_job_id: jobId, record_kind: 'dispatch_job', original_name: file.name, content_type: file.type || null, captured_from: 'officer_portal' },
        });
        if (rpcError) throw rpcError;
        saved += 1;
      } catch (err) {
        failures.push(`${file.name}: ${describe(err)}`);
      }
    }
    setProgress(null);
    if (saved) setNotice(`${saved} ${saved === 1 ? 'item' : 'items'} added to this job.`);
    if (failures.length) setError(`Not saved — ${failures.join('; ')}. Try again when you have signal.`);
    if (cameraInput.current) cameraInput.current.value = '';
    if (fileInput.current) fileInput.current.value = '';
    await load();
  };

  const busy = progress !== null;
  return (
    <section className="officer-job-evidence" aria-label="Photos and evidence for this job">
      <h4>Photos and evidence</h4>
      {!organizationId ? <p role="status">Evidence upload needs confirmed organisation access.</p> : (
        <>
          <div className="officer-job-evidence-actions">
            <label className={`btn btn-primary officer-job-evidence-button${busy ? ' is-disabled' : ''}`}>
              <Camera size={20} aria-hidden="true" />Add photo / evidence
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" multiple disabled={busy} onChange={(event) => void upload(event.target.files)} />
            </label>
            <label className={`btn btn-secondary officer-job-evidence-button${busy ? ' is-disabled' : ''}`}>
              <Paperclip size={20} aria-hidden="true" />Attach file
              <input ref={fileInput} type="file" accept="image/*,video/*,application/pdf,.doc,.docx,.txt" multiple disabled={busy} onChange={(event) => void upload(event.target.files)} />
            </label>
          </div>
          <div aria-live="polite" className="officer-job-evidence-status">
            {progress && <p className="is-progress">{progress}</p>}
            {notice && <p className="is-success">{notice}</p>}
          </div>
          {error && <p className="is-error" role="alert">{error}</p>}
          {loading ? <p className="officer-job-evidence-empty">Loading evidence…</p>
            : items.length === 0 ? <p className="officer-job-evidence-empty">No photos or files attached to this job yet.</p>
            : <ul className="officer-job-evidence-list">
                {items.map((item) => {
                  const name = typeof item.metadata?.original_name === 'string' ? item.metadata.original_name : item.evidence_kind;
                  return <li key={item.id}>
                    {urls[item.id] ? <img src={urls[item.id]} alt={`Evidence: ${name}`} loading="lazy" /> : <Paperclip size={20} aria-hidden="true" />}
                    <span>{name}<small>{new Date(item.captured_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</small></span>
                  </li>;
                })}
              </ul>}
        </>
      )}
    </section>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { evidenceStoragePath, MAX_PHOTO_BYTES } from './RecordEvidencePanel.helpers';
import { sha256Hex } from '../lib/importPreview';
import { supabase } from '../lib/supabase';

export type EvidenceRecordKind = 'location_event' | 'observation';

interface Props {
  recordKind: EvidenceRecordKind;
  recordId: string;
  organizationId: string;
  canAdd: boolean;
}

interface EvidenceRow {
  id: string;
  storage_path: string | null;
  captured_at: string;
  sha256_hash: string | null;
  metadata: Record<string, unknown> | null;
}

function describe(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : 'The photo could not be added.';
}

export const RecordEvidencePanel: React.FC<Props> = ({ recordKind, recordId, organizationId, canAdd }) => {
  const [items, setItems] = useState<EvidenceRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [busy, setBusy] = useState(false);

  // ATLAS READS: evidence_items
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const base = supabase.from('evidence_items').select('id,storage_path,captured_at,sha256_hash,metadata').order('captured_at', { ascending: false });
    const { data, error: queryError } = recordKind === 'location_event'
      ? await base.eq('location_event_id', recordId)
      : await base.eq('metadata->>observation_id', recordId);
    if (queryError) { setError(describe(queryError)); setLoading(false); return; }
    const rows = (data ?? []) as EvidenceRow[];
    setItems(rows);
    const signed: Record<string, string> = {};
    await Promise.all(rows.filter((row) => row.storage_path).map(async (row) => {
      const { data: link } = await supabase.storage.from('bob-uploads').createSignedUrl(row.storage_path as string, 900);
      if (link?.signedUrl) signed[row.id] = link.signedUrl;
    }));
    setUrls(signed);
    setLoading(false);
  }, [recordId, recordKind]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Choose an image file (JPEG, PNG, WebP or HEIC).'); return; }
    if (file.size > MAX_PHOTO_BYTES) { setError('That photo is over 15 MB. Resize it and try again.'); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sha256 = await sha256Hex(await file.arrayBuffer());
      const path = evidenceStoragePath(organizationId, recordId, sha256, file.name);
      const { error: uploadError } = await supabase.storage.from('bob-uploads').upload(path, file, { contentType: file.type, upsert: false });
      // The same photo already uploaded to this record is fine: registration below is what matters.
      if (uploadError && !/already exists|Duplicate/i.test(uploadError.message)) throw uploadError;
      const { error: rpcError } = await supabase.rpc('attach_external_photo_to_record', {
        p_record_kind: recordKind,
        p_record_id: recordId,
        p_storage_path: path,
        p_sha256: sha256,
        p_description: description || null,
        p_source_note: sourceNote || null,
        p_original_name: file.name,
      });
      if (rpcError) throw rpcError;
      setFile(null); setDescription(''); setSourceNote('');
      setNotice('Photo added to this record. It is marked as externally supplied.');
      await load();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="record-evidence" aria-labelledby="record-evidence-title">
      <h4 id="record-evidence-title">Photos and evidence</h4>
      {loading && <p className="subtitle" role="status">Loading evidence…</p>}
      {!loading && items.length === 0 && <p className="subtitle">No photos or evidence are attached to this record yet.</p>}
      {items.length > 0 && (
        <ul className="record-evidence__list">
          {items.map((item) => {
            const meta = item.metadata ?? {};
            const external = meta.provenance === 'external';
            return (
              <li key={item.id}>
                {urls[item.id] ? <a href={urls[item.id]} target="_blank" rel="noopener noreferrer"><img src={urls[item.id]} alt={typeof meta.description === 'string' && meta.description ? meta.description : 'Evidence photo'} loading="lazy" /></a> : <span className="record-evidence__nopreview">No preview</span>}
                <div>
                  <strong>{typeof meta.description === 'string' && meta.description ? meta.description : 'Photo'}</strong>
                  <small>{new Date(item.captured_at).toLocaleString('en-NZ')}{external ? ' · supplied externally, not verified' : ''}</small>
                  {typeof meta.source_note === 'string' && meta.source_note && <small>Source: {meta.source_note}</small>}
                  {item.sha256_hash && <small title={item.sha256_hash}>SHA-256 {item.sha256_hash.slice(0, 12)}…</small>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <output className="alert alert-success">{notice}</output>}
      {canAdd && (
        <form className="record-evidence__form" onSubmit={(event) => void submit(event)}>
          <label>Photo <input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <label>What it shows <input type="text" value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. Vehicle at the gate, rear plate visible" /></label>
          <label>Where it came from <input type="text" value={sourceNote} maxLength={200} onChange={(event) => setSourceNote(event.target.value)} placeholder="e.g. Sent by the forest manager by text" /></label>
          <button type="submit" className="btn btn-primary" disabled={!file || busy}><ImagePlus size={16} aria-hidden="true" /> {busy ? 'Adding…' : 'Add photo'}</button>
          <small>The original file is kept unchanged and fingerprinted. External photos are never treated as court-ready until separately reviewed.</small>
        </form>
      )}
    </section>
  );
};

export default RecordEvidencePanel;

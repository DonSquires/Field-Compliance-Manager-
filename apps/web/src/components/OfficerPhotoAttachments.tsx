import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOfficerUnsavedWork } from '../context/OfficerUnsavedWorkContext';
import { attachOfficerPhoto, OFFICER_PHOTO_BUCKET, OfficerPhotoTarget, validateOfficerPhoto } from '../lib/officerRecordPhotos';
import { supabase } from '../lib/supabase';
import './OfficerPhotoAttachments.css';

interface PendingPhoto {
  id: string;
  file: File;
  preview: string;
  selectedAt: string;
  status: 'pending' | 'uploading' | 'failed' | 'confirmed';
  evidenceId?: string;
  previewUnavailable?: boolean;
  error?: string;
}
interface SavedPhoto { id: string; evidence_id: string; storage_path: string; original_name: string; selected_at: string; sha256_hash: string; }
interface Props { target: OfficerPhotoTarget; onPendingChange?: (pending: boolean) => void; }

export const OfficerPhotoAttachments: React.FC<Props> = ({ target, onPendingChange }) => {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [saved, setSaved] = useState<SavedPhoto[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previews = useRef<string[]>([]);
  const pending = photos.some((photo) => photo.status !== 'confirmed');
  useOfficerUnsavedWork(pending || busy);
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  useEffect(() => () => { previews.current.forEach((url) => URL.revokeObjectURL(url)); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await supabase.from('officer_record_photos')
        .select('id,evidence_id,storage_path,original_name,selected_at,sha256_hash')
        .eq('organization_id', target.organizationId)
        .eq(target.kind === 'field_report' ? 'field_report_id' : 'incident_id', target.id)
        .order('registered_at', { ascending: false });
      if (response.error) throw response.error;
      const rows = (response.data ?? []) as SavedPhoto[];
      setSaved(rows);
      const signed: Record<string, string> = {};
      await Promise.all(rows.map(async (row) => {
        const result = await supabase.storage.from(OFFICER_PHOTO_BUCKET).createSignedUrl(row.storage_path, 900);
        if (result.data?.signedUrl) signed[row.id] = result.data.signedUrl;
      }));
      setUrls(signed);
    } catch {
      setError('Saved photos could not be loaded. Access or the photo service may be unavailable; no public-storage fallback is used.');
    } finally { setLoading(false); }
  }, [target.id, target.kind, target.organizationId]);
  useEffect(() => { void load(); }, [load]);

  const choose = (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const selected: PendingPhoto[] = [];
    for (const file of Array.from(event.target.files ?? [])) {
      try {
        validateOfficerPhoto(file);
        const preview = URL.createObjectURL(file);
        previews.current.push(preview);
        selected.push({ id: crypto.randomUUID(), file, preview, selectedAt: new Date().toISOString(), status: 'pending' });
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Photo could not be selected.'); }
    }
    setPhotos((current) => [...current, ...selected]);
    event.target.value = '';
  };
  const remove = (photo: PendingPhoto) => {
    URL.revokeObjectURL(photo.preview);
    previews.current = previews.current.filter((url) => url !== photo.preview);
    setPhotos((current) => current.filter((entry) => entry.id !== photo.id));
  };
  const upload = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    for (const photo of photos.filter((entry) => entry.status !== 'confirmed')) {
      setPhotos((current) => current.map((entry) => entry.id === photo.id ? { ...entry, status: 'uploading', error: undefined } : entry));
      try {
        const receipt = await attachOfficerPhoto(target, photo.file, photo.selectedAt);
        setPhotos((current) => current.map((entry) => entry.id === photo.id ? { ...entry, status: 'confirmed', evidenceId: receipt.evidence_id } : entry));
      } catch (failure) {
        setPhotos((current) => current.map((entry) => entry.id === photo.id ? {
          ...entry, status: 'failed', error: failure instanceof Error ? failure.message : 'Photo not confirmed. Retry the photo only.',
        } : entry));
      }
    }
    setBusy(false);
    await load();
  };

  return <section className="officer-photo-attachments" aria-label={`${target.kind === 'incident' ? 'Incident' : 'Report'} photos`}>
    <h3>Private source photos</h3>
    <p>The {target.kind === 'incident' ? 'incident' : 'report'} is already saved. Add photos here without submitting it again. Originals remain unverified and private, pending privacy/Oracle review before client publication. Selection time is not verified capture time.</p>
    <div className="officer-photo-attachments__controls">
      <label>Take photo<input aria-label="Take evidence photo" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" disabled={busy} onChange={choose} /></label>
      <label>Choose from gallery<input aria-label="Choose evidence photos from gallery" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple disabled={busy} onChange={choose} /></label>
    </div>
    <small>Up to 15 MB per photo. HEIC previews depend on your phone/browser; the original is preserved.</small>
    {photos.length > 0 && <ul className="officer-photo-attachments__list">{photos.map((photo) => <li key={photo.id}>
      {photo.previewUnavailable ? <p>Preview unavailable in this browser. The original photo can still be uploaded.</p> : <img src={photo.preview} alt={`Selected photo: ${photo.file.name}`} onError={() => setPhotos((current) => current.map((entry) => entry.id === photo.id ? { ...entry, previewUnavailable: true } : entry))} />}
      <span>{photo.file.name}</span><strong role="status">{{
        pending: 'Pending — not uploaded', uploading: 'Uploading and confirming…',
        failed: 'Failed — attachment not confirmed', confirmed: 'Confirmed — private, pending review',
      }[photo.status]}</strong>
      {photo.error && <p role="alert">{photo.error}</p>}
      {photo.status !== 'confirmed' && <button type="button" disabled={busy} onClick={() => remove(photo)}>Remove selection</button>}
    </li>)}</ul>}
    {pending && <button type="button" disabled={busy} onClick={() => void upload()}>{busy ? 'Uploading photos…' : 'Upload / retry unconfirmed photos'}</button>}
    {pending && <p role="status">Unconfirmed photos are only held on this device. Stay here to upload or remove them; leaving loses the selections. Removing a failed selection does not delete any original already uploaded.</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={loading || busy} onClick={() => { setError(null); void load(); }}>Refresh confirmed photos</button>
    {loading ? <p role="status">Loading confirmed photos…</p> : saved.length === 0 && !photos.some((photo) => photo.status === 'confirmed') ? <p>No confirmed photos attached.</p> : <ul className="officer-photo-attachments__list">{saved.filter((row) => !photos.some((photo) => photo.status === 'confirmed' && photo.evidenceId === row.evidence_id)).map((photo) => <li key={photo.id}>
      {urls[photo.id] ? <a href={urls[photo.id]} target="_blank" rel="noopener noreferrer"><img src={urls[photo.id]} alt={`Private source photo: ${photo.original_name}`} onError={() => setUrls((current) => { const next = { ...current }; delete next[photo.id]; return next; })} /></a> : <p>Preview unavailable. Refresh to retry.</p>}
      <span>{photo.original_name}</span><strong>Confirmed · private, pending review</strong>
      <small>Selected {new Date(photo.selected_at).toLocaleString('en-NZ')}</small>
      <small title={photo.sha256_hash}>Original SHA-256 {photo.sha256_hash.slice(0, 12)}…</small>
    </li>)}</ul>}
  </section>;
};

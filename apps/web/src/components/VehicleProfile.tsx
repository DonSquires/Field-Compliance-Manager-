import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { describeLoadFailures } from '../lib/friendlyLoadError';
import './VehicleProfile.css';

export interface EditableVehicle {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  year: number | null;
  colour: string | null;
  body_type: string | null;
  rego_expiry: string | null;
  wof_expiry: string | null;
  cof_expiry: string | null;
}

const fields = [
  ['make', 'Make', 'text'], ['model', 'Model', 'text'], ['year', 'Year', 'number'],
  ['colour', 'Colour', 'text'], ['body_type', 'Body type', 'text'],
  ['rego_expiry', 'Registration expiry', 'date'], ['wof_expiry', 'WoF expiry', 'date'],
  ['cof_expiry', 'CoF expiry', 'date'],
] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  return `${describeLoadFailures([['vehicle profile', { message }]])} ${message}`;
}

export default function VehicleProfile({ vehicle, onUpdated }: {
  vehicle: EditableVehicle;
  onUpdated: () => Promise<void>;
}) {
  const { profile } = useAuth();
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map(([key]) => [key, String(vehicle[key] ?? '')])));
  const [reason, setReason] = useState('');
  const [photoReason, setPhotoReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<{ path: string; hash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const url = file ? URL.createObjectURL(file) : null;
    setPreviewUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        // ATLAS READS: vehicle_profile_photos — private, caller-RLS media.
        const [photo, permission] = await Promise.all([
          supabase.from('vehicle_profile_photos').select('storage_path').eq('canonical_vehicle_id', vehicle.id).maybeSingle(),
          profile?.organizationId
            ? supabase.rpc('is_admin_for_org', { target_org_id: profile.organizationId })
            : Promise.resolve({ data: false, error: null }),
        ]);
        if (photo.error) throw photo.error;
        if (permission.error) throw permission.error;
        let url: string | null = null;
        if (photo.data) {
          const signed = await supabase.storage.from('vehicle-profile-photos').createSignedUrl(photo.data.storage_path, 3600);
          if (signed.error) throw signed.error;
          url = signed.data.signedUrl;
        }
        if (active) { setPhotoUrl(url); setCanEdit(permission.data === true); }
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [vehicle.id, profile?.organizationId, photoVersion]);

  async function saveDetails(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    let saved = false;
    try {
      // ATLAS CALLS: update_vehicle_profile_details — existing registry governance.
      const result = await supabase.rpc('update_vehicle_profile_details', {
        p_organization_id: profile?.organizationId, p_vehicle_id: vehicle.id,
        p_fields: draft, p_reason: reason.trim(),
      });
      if (result.error) throw result.error;
      saved = true;
      await onUpdated();
      setEditing(false); setReason(''); setNotice('Vehicle details saved with audit history.');
    } catch (failure) {
      setError(saved ? `Vehicle details were saved, but the refreshed profile could not be loaded. Refresh this vehicle. ${errorMessage(failure)}` : errorMessage(failure));
    }
    finally { setBusy(false); }
  }

  async function savePhoto(event: FormEvent) {
    event.preventDefault();
    if (!file || !profile?.organizationId || !profile.id) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size) {
        throw new Error('Choose a JPEG, PNG or WebP image of at most 5 MB.');
      }
      let receipt = uploaded;
      if (!receipt) {
        // Re-encode the user-selected image: remove embedded location metadata
        // before sharing a profile photo; retain original evidence separately.
        const bitmap = await createImageBitmap(file);
        if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error('Choose an image smaller than 40 megapixels.'); }
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) { bitmap.close(); throw new Error('This browser cannot prepare the photo.'); }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
          value => value ? resolve(value) : reject(new Error('Could not prepare the photo.')), 'image/webp', 0.9,
        ));
        if (blob.type !== 'image/webp') throw new Error('This browser cannot prepare a WebP profile photo. Try a current browser.');
        if (blob.size > 5 * 1024 * 1024) throw new Error('Prepared photo exceeds 5 MB; choose a smaller image.');
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const path = `${profile.organizationId}/${profile.id}/${vehicle.id}/${crypto.randomUUID()}.webp`;
        const upload = await supabase.storage.from('vehicle-profile-photos').upload(path, blob, {
          contentType: 'image/webp', upsert: false,
        });
        if (upload.error) throw upload.error;
        receipt = { path, hash };
        setUploaded(receipt);
      }
      // ATLAS CALLS: set_vehicle_profile_photo — explicit human designation, audit.
      const saved = await supabase.rpc('set_vehicle_profile_photo', {
        p_organization_id: profile.organizationId, p_vehicle_id: vehicle.id,
        p_storage_path: receipt.path, p_sha256_hash: receipt.hash, p_reason: photoReason.trim(),
      });
      if (saved.error) throw saved.error;
      setUploaded(null); setFile(null); setPhotoReason('');
      setPhotoVersion(value => value + 1);
      setNotice('Shared vehicle profile photo saved with audit history.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <section className="contact-card vehicle-profile" aria-label="Vehicle profile">
    <h2>Vehicle profile</h2>
    {loading && <p role="status">Loading photo and edit permissions…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {photoUrl ? <img className="vehicle-profile-photo" src={photoUrl} alt={`Profile of vehicle ${vehicle.plate_number}`}
      onError={() => setError('The vehicle photo could not be displayed. Refresh to request a new private link.')} />
      : !loading && <p>No profile photo available in your authorised scope.</p>}
    <p>Profile photos are shared with authorised organisations, not public. A profile photo is not proof of identity or enforcement evidence.</p>
    {!loading && !canEdit && <p>Vehicle profile changes require an organisation administrator.</p>}
    {canEdit && <>
      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => {
        setDraft(Object.fromEntries(fields.map(([key]) => [key, String(vehicle[key] ?? '')])));
        setEditing(value => !value);
      }}>{editing ? 'Cancel editing' : 'Edit vehicle details'}</button>
      {editing && <form onSubmit={saveDetails}>
        <p>Registration is fixed. Shared vehicle facts may require grand master review. Blank fields leave existing values unchanged.</p>
        <fieldset disabled={busy}><legend>Vehicle details</legend>
          <div className="vehicle-profile-fields">{fields.map(([key, label, type]) => <label key={key}>
            {label}<input type={type} value={draft[key]} maxLength={type === 'text' ? 100 : undefined}
              min={key === 'year' ? 1886 : undefined} max={key === 'year' ? new Date().getFullYear() + 1 : undefined}
              onChange={event => setDraft({ ...draft, [key]: event.target.value })} />
          </label>)}</div>
          <label>Reason / source for detail changes<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button className="btn btn-primary" disabled={!reason.trim()}>Save vehicle details</button>
        </fieldset>
      </form>}
      <form onSubmit={savePhoto}><fieldset disabled={busy}><legend>{photoUrl ? 'Replace profile photo' : 'Add profile photo'}</legend>
        <label>Vehicle profile photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
          setFile(event.target.files?.[0] ?? null); setUploaded(null); setError(null);
        }} /></label>
        <p>JPEG, PNG or WebP, up to 5 MB. Embedded location metadata is removed. Only upload a photo you have permission to share; avoid people and private surroundings.</p>
        {previewUrl && <img className="vehicle-profile-photo" src={previewUrl} alt="Selected vehicle photo preview" />}
        <label>Reason / source for profile photo<textarea required value={photoReason} onChange={event => setPhotoReason(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={!file || !photoReason.trim()}>{busy ? 'Saving…' : 'Save profile photo'}</button>
        {uploaded && <p role="status">Photo uploaded; if linking fails, retry Save profile photo to reuse this upload.</p>}
      </fieldset></form>
    </>}
  </section>;
}

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileText, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

interface PolicyReceipt {
  zone_id: string;
  module_key: string;
  organization_id: string;
  configuration_version: number;
  configured: boolean;
  policy_version: number | null;
  policy: {
    time_limit_minutes?: number | null;
    disabled_multiplier?: number | null;
    grace_period_minutes?: number | null;
    signage_photo_path?: string | null;
    max_consecutive_nights?: number | null;
    max_nights_per_month?: number | null;
    scv_required?: boolean;
    source_ref?: string | null;
    source_url?: string | null;
    notes?: string | null;
  };
}

const emptyDraft = { minutes: '', multiplier: '1', grace: '0', consecutive: '', monthly: '', scv: false, source: '', url: '', notes: '' };

export function WorkingZonePolicyEditor({ zoneId, moduleKey, configurationVersion, onSaved, onDirtyChange, saveBlockedReason }: {
  zoneId: string; moduleKey: string; configurationVersion: number; onSaved: () => void;
  /** Lets the parent hold back commands that bump the zone version, which would reload and replace this draft. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Set while another draft on the same zone is unsaved: saving would bump the shared version under it. */
  saveBlockedReason?: string | null;
}) {
  const { operatingOrganizationId, profile } = useAuth();
  const providerId = operatingOrganizationId ?? profile?.organizationId ?? null;
  const [receipt, setReceipt] = useState<PolicyReceipt | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [baseline, setBaseline] = useState(emptyDraft);
  const [confirmed, setConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const parking = moduleKey === 'parking_enforcement';

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setReceipt(null); setFile(null); setUploadedPath(null); setConfirmed(false);
    void supabase.rpc('get_working_zone_policy', { p_zone_id: zoneId, p_operating_organization_id: providerId }).then(({ data, error: loadError }) => {
      if (!active) return;
      if (loadError || !data) setError(loadError?.message ?? 'Working-zone policy could not be loaded.');
      else {
        const next = data as PolicyReceipt;
        setReceipt(next);
        const loaded = { minutes: next.policy.time_limit_minutes?.toString() ?? '', multiplier: next.policy.disabled_multiplier?.toString() ?? '1', grace: next.policy.grace_period_minutes?.toString() ?? '0',
          consecutive: next.policy.max_consecutive_nights?.toString() ?? '', monthly: next.policy.max_nights_per_month?.toString() ?? '',
          scv: next.policy.scv_required ?? false, source: next.policy.source_ref ?? '', url: next.policy.source_url ?? '', notes: next.policy.notes ?? '' };
        setDraft(loaded); setBaseline(loaded);
        setRequestId(crypto.randomUUID());
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [zoneId, moduleKey, configurationVersion, providerId, revision]);

  const dirty = file !== null || (Object.keys(emptyDraft) as Array<keyof typeof emptyDraft>).some((key) => draft[key] !== baseline[key]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const change = (values: Partial<typeof emptyDraft>) => {
    setDraft((current) => ({ ...current, ...values }));
    setConfirmed(false); setNotice(null); setRequestId(crypto.randomUUID());
  };

  const save = async () => {
    if (!receipt || saving || saveBlockedReason) return;
    setError(null); setNotice(null);
    if (!draft.source.trim() || !confirmed) { setError('Record the policy source and confirm that the entered rules match it.'); return; }
    if (parking && (!Number.isInteger(Number(draft.minutes)) || Number(draft.minutes) < 1 || Number(draft.minutes) > 1440 || !Number.isFinite(Number(draft.multiplier)) || Number(draft.multiplier) < 1 || Number(draft.multiplier) > 4)) {
      setError('Enter a posted limit of 1 to 1440 minutes and a multiplier of 1 to 4.'); return;
    }
    if (parking && (!Number.isInteger(Number(draft.grace)) || Number(draft.grace) < 0 || Number(draft.grace) > 1440)) { setError('Enter a grace period of 0 to 1440 minutes.'); return; }
    if (!parking && [draft.consecutive, draft.monthly].some((value) => value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 0))) {
      setError('Night limits must be whole numbers of zero or more.'); return;
    }
    if (parking && !file && !uploadedPath && !receipt.policy.signage_photo_path) { setError('Add a photograph of the posted sign.'); return; }
    if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024)) {
      setError('The sign photo must be JPEG, PNG or WebP, no larger than 15 MB.'); return;
    }
    setSaving(true);
    try {
      let signagePath = uploadedPath ?? receipt.policy.signage_photo_path ?? null;
      if (parking && file && !uploadedPath) {
        const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
        signagePath = `org/${receipt.organization_id}/parking-signage/${zoneId}/${requestId}.${extension}`;
        const { error: uploadError } = await supabase.storage.from('scans').upload(signagePath, file, { upsert: false, contentType: file.type });
        if (uploadError) throw uploadError;
        setUploadedPath(signagePath);
      }
      const { data, error: saveError } = await supabase.rpc('save_working_zone_policy', {
        p_request_id: requestId, p_zone_id: zoneId, p_expected_version: receipt.configuration_version,
        p_operating_organization_id: providerId,
        p_policy: { source_ref: draft.source.trim(), source_url: draft.url.trim() || null, source_confirmed: confirmed,
          ...(parking ? { time_limit_minutes: Number(draft.minutes), disabled_multiplier: Number(draft.multiplier), grace_period_minutes: Number(draft.grace), signage_photo_path: signagePath }
            : { max_consecutive_nights: draft.consecutive === '' ? null : Number(draft.consecutive), max_nights_per_month: draft.monthly === '' ? null : Number(draft.monthly), scv_required: draft.scv, notes: draft.notes.trim() || null }) },
      });
      if (saveError || !data) throw saveError ?? new Error('The saved policy receipt was not confirmed.');
      const saved = data as PolicyReceipt;
      setReceipt(saved); setBaseline(draft); setFile(null); setUploadedPath(null); setConfirmed(false); setRequestId(crypto.randomUUID());
      setNotice(`${parking ? 'Parking' : 'Freedom Camping'} policy saved. Version ${saved.policy_version}.`);
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : (saveError as { message?: string })?.message ?? 'Policy could not be saved.');
    } finally { setSaving(false); }
  };

  return <fieldset className="place-manager-module-fields" aria-label={parking ? 'Parking working-zone policy' : 'Freedom Camping working-zone policy'} disabled={saving}>
    <legend><FileText size={15} />{parking ? 'Parking policy' : 'Freedom camping policy'}</legend>
    {loading ? <div role="status">Loading working-zone policy...</div> : <>
      {receipt && <div role="status">{receipt.configured ? `Policy version ${receipt.policy_version}` : 'Policy not configured'}</div>}
      {error && <div className="place-manager-message is-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      {!receipt ? <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry policy</button> : <>
        <div className="place-manager-grid">
          {parking ? <>
            <label><span>Posted limit in minutes</span><input type="number" min="1" max="1440" step="1" value={draft.minutes} onChange={(event) => change({ minutes: event.target.value })} /></label>
            <label><span>Disabled-bay multiplier</span><input type="number" min="1" max="4" step="0.25" value={draft.multiplier} onChange={(event) => change({ multiplier: event.target.value })} /></label>
            <label><span>Grace period in minutes</span><input type="number" min="0" max="1440" step="1" value={draft.grace} onChange={(event) => change({ grace: event.target.value })} /></label>
            <label><span>{receipt.policy.signage_photo_path ? 'Replace photographed sign' : 'Photograph of posted sign'}</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedPath(null); setConfirmed(false); setRequestId(crypto.randomUUID()); }} /></label>
          </> : <>
            <label><span>Consecutive-night limit</span><input type="number" min="0" max="366" step="1" value={draft.consecutive} onChange={(event) => change({ consecutive: event.target.value })} placeholder="No consecutive limit" /></label>
            <label><span>Monthly-night limit</span><input type="number" min="0" max="31" step="1" value={draft.monthly} onChange={(event) => change({ monthly: event.target.value })} placeholder="No monthly limit" /></label>
            <label className="place-manager-check"><input type="checkbox" checked={draft.scv} onChange={(event) => change({ scv: event.target.checked })} />Self-contained vehicle requirement applies</label>
          </>}
          <label><span>Policy source / clause</span><input maxLength={2000} value={draft.source} onChange={(event) => change({ source: event.target.value })} /></label>
          <label><span>Policy source URL (optional)</span><input type="url" maxLength={2000} value={draft.url} onChange={(event) => change({ url: event.target.value })} /></label>
        </div>
        {!parking && <label><span>Policy wording / notes</span><textarea rows={3} maxLength={12000} value={draft.notes} onChange={(event) => change({ notes: event.target.value })} /></label>}
        <label className="place-manager-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{parking ? 'I checked these rules against the photographed sign.' : 'I checked these rules against the Freedom Camping policy source.'}</label>
        {dirty && <button type="button" onClick={() => setRevision((value) => value + 1)}>Discard policy changes</button>}
        {saveBlockedReason && <span className="place-manager-save-hint">{saveBlockedReason}</span>}
        <button type="button" className="is-primary" onClick={() => void save()} disabled={saving || !confirmed || !draft.source.trim() || Boolean(saveBlockedReason)}><Save size={15} />{saving ? 'Saving policy' : 'Save working-zone policy'}</button>
      </>}
      {notice && <div className="place-manager-message is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    </>}
  </fieldset>;
}
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './RecordFollowUp.css';

interface OwnerLink {
  link_id: string;
  relationship: 'owner' | 'registered_owner';
  active: boolean;
  source: string | null;
  basis: string | null;
  nzta_restricted: boolean;
  person_record_id: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  locality: string | null;
  recorded_at: string;
  recorded_by_name: string | null;
  ended_at: string | null;
}

interface NztaCheck {
  check_id: string;
  checked_at: string;
  relationship: string;
  display_name: string | null;
  source_authority: string | null;
}

const SOURCES: Array<[string, string]> = [
  ['owner_declared', 'Owner or driver told us'],
  ['officer_observed', 'Officer established on site'],
  ['nzta_mvr', 'NZTA motor vehicle register'],
  ['other', 'Other source'],
];

const SOURCE_LABEL = Object.fromEntries(SOURCES);
const NZTA_NOTICE = 'NZTA register information is restricted. Only people your organisation has authorised for vehicle owner details can see it, and it may only be used for the lawful purpose it was obtained for. Do not share it with clients or other organisations.';
const EMPTY_FIELDS = { display_name: '', phone: '', email: '', suburb: '', city: '', address: '' };

/**
 * Owner identity for a canonical vehicle. Owners are recorded by the caller's
 * organisation as a person -> vehicle edge, creating the person record and its
 * canonical person when needed. Personal information: visible to users holding
 * the vehicle_owner_identity access area (or administrators). Only the suburb
 * and city are shown, never the street address.
 */
export const VehicleOwnerPanel: React.FC<{
  vehicleId: string;
  organizationId: string | null | undefined;
  onChanged?: () => void;
}> = ({ vehicleId, organizationId, onChanged }) => {
  const [access, setAccess] = useState<{ view: boolean; record: boolean } | null>(null);
  const [owners, setOwners] = useState<OwnerLink[]>([]);
  const [checks, setChecks] = useState<NztaCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [personQuery, setPersonQuery] = useState('');
  const [personMatches, setPersonMatches] = useState<Array<{ id: string; display_name: string | null }>>([]);
  const [personId, setPersonId] = useState('');
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [source, setSource] = useState('owner_declared');
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);

  // ATLAS CALLS: can_access_vehicle_owner_identity
  useEffect(() => {
    if (!organizationId) { setAccess({ view: false, record: false }); return; }
    let cancelled = false;
    void Promise.all([
      supabase.rpc('can_access_vehicle_owner_identity', { p_organization_id: organizationId, p_record: false }),
      supabase.rpc('can_access_vehicle_owner_identity', { p_organization_id: organizationId, p_record: true }),
    ]).then(([viewResult, recordResult]) => {
      if (cancelled) return;
      if (viewResult.error) setError(viewResult.error.message);
      setAccess({ view: viewResult.data === true, record: recordResult.data === true });
    });
    return () => { cancelled = true; };
  }, [organizationId]);

  const canView = access?.view === true;
  const canRecord = access?.record === true;

  // ATLAS CALLS: get_vehicle_owner_links, get_vehicle_identity_checks
  const load = useCallback(async () => {
    if (!canView || !organizationId) { setLoading(false); return; }
    setLoading(true);
    const [ownerResult, checkResult] = await Promise.all([
      supabase.rpc('get_vehicle_owner_links', { p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId }),
      supabase.rpc('get_vehicle_identity_checks', { p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId }),
    ]);
    if (ownerResult.error) setError(ownerResult.error.message);
    else setOwners(Array.isArray(ownerResult.data) ? ownerResult.data as OwnerLink[] : []);
    setChecks(checkResult.error ? [] : (Array.isArray(checkResult.data) ? checkResult.data as NztaCheck[] : []));
    setLoading(false);
  }, [canView, organizationId, vehicleId]);

  useEffect(() => { void load(); }, [load]);

  // ATLAS READS: person_records (own organisation, caller RLS)
  useEffect(() => {
    if (!adding || mode !== 'existing' || !organizationId || personQuery.trim().length < 2) { setPersonMatches([]); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const term = personQuery.trim().replace(/[%_,()]/g, ' ');
      void supabase.from('person_records').select('id,display_name').eq('organization_id', organizationId)
        .ilike('display_name', `%${term}%`).order('display_name').limit(10)
        .then(({ data }) => { if (!cancelled) setPersonMatches(Array.isArray(data) ? data as typeof personMatches : []); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [adding, mode, organizationId, personQuery]);

  if (access === null) return null;
  if (!canView) {
    return <p className="vehicle-profile-hint">Owner details are personal information. They are shown only to people your organisation has authorised for vehicle owner details (an administrator can enable this under Users).</p>;
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    // ATLAS CALLS: record_vehicle_owner
    const { error: saveError } = await supabase.rpc('record_vehicle_owner', {
      p_organization_id: organizationId,
      p_canonical_vehicle_id: vehicleId,
      p_person_record_id: mode === 'existing' ? personId || null : null,
      p_person_fields: mode === 'new' ? Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()])) : null,
      p_source: source,
      p_basis: basis.trim(),
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setAdding(false);
    setFields(EMPTY_FIELDS);
    setPersonId(''); setPersonQuery(''); setBasis('');
    await load();
    onChanged?.();
  };

  const endLink = async (owner: OwnerLink) => {
    const reason = window.prompt(`Why is ${owner.display_name ?? 'this person'} no longer the owner?`);
    if (!reason?.trim()) return;
    // ATLAS CALLS: end_vehicle_owner_link
    const { error: endError } = await supabase.rpc('end_vehicle_owner_link', { p_link_id: owner.link_id, p_reason: reason.trim() });
    if (endError) setError(endError.message);
    else { await load(); onChanged?.(); }
  };

  const activeOwners = owners.filter((owner) => owner.active);
  const pastOwners = owners.filter((owner) => !owner.active);
  const canSave = basis.trim() && (mode === 'existing' ? Boolean(personId) : Boolean(fields.display_name.trim()));

  return (
    <section className="vehicle-owner" aria-label="Vehicle owner">
      <div className="vehicle-owner__head">
        <h3>Owner</h3>
        {canRecord && <button type="button" className="btn btn-sm btn-secondary" aria-expanded={adding} onClick={() => setAdding((value) => !value)}>
          {adding ? 'Cancel' : activeOwners.length ? 'Change owner' : 'Add owner'}
        </button>}
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading ? <p role="status">Loading owner…</p> : activeOwners.length === 0 ? <p>No owner recorded by your organisation.</p> : activeOwners.map((owner) => (
        <div key={owner.link_id} className="vehicle-owner__card">
          <div className="vehicle-owner__title">
            <strong>{owner.display_name ?? 'Unnamed person'}</strong>
            <span className="badge badge-info">{owner.relationship === 'registered_owner' ? 'Registered owner' : 'Owner'}</span>
            {owner.nzta_restricted && <span className="badge badge-warning" title={NZTA_NOTICE}>NZTA restricted</span>}
          </div>
          <div className="vehicle-owner__meta">{[owner.phone, owner.email, owner.locality].filter(Boolean).join(' · ') || 'No contact details recorded'}</div>
          <small>{SOURCE_LABEL[owner.source ?? ''] ?? 'Source not recorded'} · {owner.basis ?? ''} · recorded {new Date(owner.recorded_at).toLocaleDateString('en-NZ')} by {owner.recorded_by_name ?? 'staff'}</small>
          {owner.nzta_restricted && <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>}
          {canRecord && <div><button type="button" className="btn btn-sm btn-secondary" onClick={() => void endLink(owner)}>No longer owner</button></div>}
        </div>
      ))}
      {pastOwners.length > 0 && <details><summary>Previous owners ({pastOwners.length})</summary>
        <ul>{pastOwners.map((owner) => <li key={owner.link_id}>{owner.display_name ?? 'Unnamed person'} · until {owner.ended_at ? new Date(owner.ended_at).toLocaleDateString('en-NZ') : '—'}{owner.nzta_restricted ? ' · NZTA restricted' : ''}</li>)}</ul>
      </details>}
      {checks.length > 0 && <details><summary>NZTA register checks ({checks.length})</summary>
        <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>
        <ul>{checks.map((check) => <li key={check.check_id}>{new Date(check.checked_at).toLocaleDateString('en-NZ')} · {check.relationship.replace(/_/g, ' ')} · {check.display_name ?? 'Person not named'}{check.source_authority ? ` · ${check.source_authority}` : ''}</li>)}</ul>
      </details>}
      {adding && canRecord && (
        <form className="vehicle-owner__form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <legend>{activeOwners.length ? 'Record the new owner' : 'Record the owner'}</legend>
            <div role="radiogroup" aria-label="Owner person" className="vehicle-owner__mode">
              <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New person</label>
              <label><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Existing person record</label>
            </div>
            {mode === 'new' ? (
              <div className="vehicle-profile-fields">
                <label>Full name<input required value={fields.display_name} maxLength={200} onChange={(event) => setFields({ ...fields, display_name: event.target.value })} /></label>
                <label>Phone<input value={fields.phone} maxLength={50} onChange={(event) => setFields({ ...fields, phone: event.target.value })} /></label>
                <label>Email<input type="email" value={fields.email} maxLength={200} onChange={(event) => setFields({ ...fields, email: event.target.value })} /></label>
                <label>Suburb<input value={fields.suburb} maxLength={100} onChange={(event) => setFields({ ...fields, suburb: event.target.value })} /></label>
                <label>Town / city<input value={fields.city} maxLength={100} onChange={(event) => setFields({ ...fields, city: event.target.value })} /></label>
                <label>Street address (optional)<input value={fields.address} maxLength={300} onChange={(event) => setFields({ ...fields, address: event.target.value })} aria-describedby="vehicle-owner-street-hint" /></label>
                <small id="vehicle-owner-street-hint" className="vehicle-profile-hint">Kept on the person record. Only the suburb and town/city are shown with the vehicle.</small>
              </div>
            ) : (
              <>
                <label>Find person<input type="search" value={personQuery} onChange={(event) => { setPersonQuery(event.target.value); setPersonId(''); }} placeholder="Type at least 2 letters of the name" /></label>
                <label>Person record
                  <select required value={personId} onChange={(event) => setPersonId(event.target.value)}>
                    <option value="">{personMatches.length ? 'Select person' : 'No matches yet'}</option>
                    {personMatches.map((person) => <option key={person.id} value={person.id}>{person.display_name || 'Unnamed person'}</option>)}
                  </select>
                </label>
              </>
            )}
            <label>Where did these details come from?
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {source === 'nzta_mvr' && <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>}
            <label>Reason / evidence<textarea required value={basis} maxLength={1000} onChange={(event) => setBasis(event.target.value)} placeholder="For example: driver produced licence at gate, 12/10" /></label>
            <p className="vehicle-profile-hint">A new person is added to your person records and the shared person register. Any previous owner your organisation recorded is ended, and the change is audit-logged.</p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canSave}>{busy ? 'Saving…' : 'Save owner'}</button>
          </fieldset>
        </form>
      )}
    </section>
  );
};

export default VehicleOwnerPanel;

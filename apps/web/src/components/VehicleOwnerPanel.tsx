import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isDuplicateError, type NewPersonFields, type PersonMatch } from '../lib/personIdentity';
import { PersonIdentityPanel, PersonMatchSuggestions, PersonSearchPicker } from './PersonIdentity';
import './RecordFollowUp.css';

type Relationship = 'owner' | 'registered_owner' | 'driver' | 'associated_person';

export interface VehiclePersonLink {
  link_id: string;
  relationship: Relationship;
  active: boolean;
  source: string | null;
  basis: string | null;
  nzta_restricted: boolean;
  person_record_id: string | null;
  canonical_person_id: string | null;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  locality: string | null;
  observation_ids: string[] | null;
  details_visible: boolean;
  recorded_at: string;
  recorded_by_name: string | null;
  ended_at: string | null;
  source_checked_at: string | null;
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
const ROLES: Array<[Exclude<Relationship, 'registered_owner'>, string]> = [
  ['owner', 'Owner'],
  ['driver', 'Driver'],
  ['associated_person', 'Associated person'],
];

const SOURCE_LABEL = Object.fromEntries(SOURCES);
const ROLE_LABEL: Record<Relationship, string> = { owner: 'Owner', registered_owner: 'Registered owner', driver: 'Driver', associated_person: 'Associated person' };
const NZTA_NOTICE = 'NZTA register information is restricted. Only people your organisation has authorised for vehicle owner details can see it, and it may only be used for the lawful purpose it was obtained for. Do not share it with clients or other organisations.';
const EMPTY_FIELDS = { display_name: '', phone: '', email: '', suburb: '', city: '', address: '' };
const isOwner = (link: VehiclePersonLink) => link.relationship === 'owner' || link.relationship === 'registered_owner';

/**
 * People linked to a canonical vehicle by the caller's organisation: the owner
 * (one current owner), drivers and associated people (any number), optionally
 * tied to the sighting where they were established. Authorised users (the
 * vehicle_owner_identity access area, or administrators) see full details and
 * can record people; everyone else in the organisation sees only that a person
 * has been identified and their suburb and town/city.
 */
export const VehicleOwnerPanel: React.FC<{
  vehicleId: string;
  organizationId: string | null | undefined;
  /** Scope the panel to the people established at one sighting. */
  observationId?: string | null;
  onChanged?: () => void;
}> = ({ vehicleId, organizationId, observationId = null, onChanged }) => {
  const [access, setAccess] = useState<{ view: boolean; record: boolean } | null>(null);
  const [people, setPeople] = useState<VehiclePersonLink[]>([]);
  const [checks, setChecks] = useState<NztaCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Exclude<Relationship, 'registered_owner'> | null>(null);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [pickedPerson, setPickedPerson] = useState<PersonMatch | null>(null);
  const [fields, setFields] = useState(EMPTY_FIELDS);
  const [confirmNew, setConfirmNew] = useState(false);
  const [source, setSource] = useState('owner_declared');
  const [basis, setBasis] = useState('');
  const [openIdentityFor, setOpenIdentityFor] = useState<string | null>(null);
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
    if (access === null || !organizationId) { setLoading(false); return; }
    setLoading(true);
    const [peopleResult, checkResult] = await Promise.all([
      supabase.rpc('get_vehicle_owner_links', { p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId }),
      canView && !observationId
        ? supabase.rpc('get_vehicle_identity_checks', { p_organization_id: organizationId, p_canonical_vehicle_id: vehicleId })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (peopleResult.error) setError(peopleResult.error.message);
    else setPeople(Array.isArray(peopleResult.data) ? peopleResult.data as VehiclePersonLink[] : []);
    setChecks(checkResult.error ? [] : (Array.isArray(checkResult.data) ? checkResult.data as NztaCheck[] : []));
    setLoading(false);
  }, [access, canView, observationId, organizationId, vehicleId]);

  useEffect(() => { void load(); }, [load]);

  if (access === null) return null;

  const startAdding = (role: Exclude<Relationship, 'registered_owner'>) => {
    setAdding((current) => current === role ? null : role);
    setSource(role === 'owner' ? 'owner_declared' : 'officer_observed');
    setError(null);
    setPickedPerson(null);
    setConfirmNew(false);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId || !adding) return;
    setBusy(true);
    setError(null);
    // ATLAS CALLS: record_vehicle_person
    const { error: saveError } = await supabase.rpc('record_vehicle_person', {
      p_organization_id: organizationId,
      p_canonical_vehicle_id: vehicleId,
      p_person_record_id: mode === 'existing' ? pickedPerson?.person_record_id ?? null : null,
      p_person_fields: mode === 'new'
        ? Object.fromEntries(Object.entries({ ...fields, confirm_new_person: confirmNew } as NewPersonFields)
          .filter(([, value]) => typeof value === 'boolean' ? value : Boolean(String(value ?? '').trim()))
          .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]))
        : null,
      p_relationship: adding,
      p_source: source,
      p_basis: basis.trim(),
      p_observation_id: observationId,
    });
    setBusy(false);
    if (saveError) {
      const message = saveError.message;
      setError(isDuplicateError(message)
        ? `${message.replace(/^POSSIBLE_DUPLICATE:\s*/, '')} Pick the existing person above, or tick “This is a different person”.`
        : message);
      return;
    }
    setAdding(null);
    setFields(EMPTY_FIELDS);
    setPickedPerson(null);
    setConfirmNew(false);
    setBasis('');
    await load();
    onChanged?.();
  };

  const endLink = async (link: VehiclePersonLink) => {
    const reason = window.prompt(`Why is ${link.display_name ?? 'this person'} no longer the ${ROLE_LABEL[link.relationship].toLowerCase()}?`);
    if (!reason?.trim()) return;
    // ATLAS CALLS: end_vehicle_owner_link
    const { error: endError } = await supabase.rpc('end_vehicle_owner_link', { p_link_id: link.link_id, p_reason: reason.trim() });
    if (endError) setError(endError.message);
    else { await load(); onChanged?.(); }
  };

  const scoped = observationId ? people.filter((link) => link.observation_ids?.includes(observationId)) : people;
  const active = scoped.filter((link) => link.active);
  const past = scoped.filter((link) => !link.active);
  const hasOwner = people.some((link) => link.active && isOwner(link));
  const canSave = Boolean(basis.trim()) && (mode === 'existing' ? Boolean(pickedPerson) : Boolean(fields.display_name.trim()));
  const sourceOptions = adding && adding !== 'owner' ? SOURCES.filter(([value]) => value !== 'nzta_mvr') : SOURCES;

  const card = (link: VehiclePersonLink) => link.details_visible ? (
    <div key={link.link_id} className="vehicle-owner__card">
      <div className="vehicle-owner__title">
        <strong>{link.display_name ?? 'Unnamed person'}</strong>
        <span className="badge badge-info">{ROLE_LABEL[link.relationship]}</span>
        {link.nzta_restricted && <span className="badge badge-warning" title={NZTA_NOTICE}>NZTA restricted</span>}
      </div>
      <div className="vehicle-owner__meta">{[link.phone, link.email].filter(Boolean).join(' · ') || 'No contact details recorded'}</div>
      <div className="vehicle-owner__meta">{link.address || link.locality || 'No address recorded'}</div>
      <small>{SOURCE_LABEL[link.source ?? ''] ?? 'Source not recorded'}{link.basis ? ` · ${link.basis}` : ''} · recorded {new Date(link.recorded_at).toLocaleDateString('en-NZ')} by {link.recorded_by_name ?? 'staff'}
        {link.source_checked_at ? ` · NZTA observation ${new Date(link.source_checked_at).toLocaleDateString('en-NZ')} (not a transfer date)` : ''}
        {!observationId && link.observation_ids?.length ? ` · seen at ${link.observation_ids.length} sighting${link.observation_ids.length === 1 ? '' : 's'}` : ''}</small>
      {link.nzta_restricted && <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>}
      <div className="vehicle-owner__actions">
        {link.person_record_id && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpenIdentityFor(link.person_record_id!)}>Identity…</button>}
        {canRecord && <button type="button" className="btn btn-sm btn-secondary" onClick={() => void endLink(link)}>No longer {ROLE_LABEL[link.relationship].toLowerCase()}</button>}
      </div>
    </div>
  ) : (
    <div key={link.link_id} className="vehicle-owner__card is-redacted">
      <div className="vehicle-owner__title">
        <strong>{isOwner(link) ? 'Owner identified' : `${ROLE_LABEL[link.relationship]} identified`}</strong>
        <span className="badge badge-info">{ROLE_LABEL[link.relationship]}</span>
      </div>
      <div className="vehicle-owner__meta">{link.locality ? `Registered to ${link.locality}` : 'Locality not recorded'}</div>
      <small>Your organisation has identified this person on {new Date(link.recorded_at).toLocaleDateString('en-NZ')}. Their details are shown only to authorised users.</small>
      {link.person_record_id && <div><button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpenIdentityFor(link.person_record_id!)}>Identity…</button></div>}
    </div>
  );

  return (
    <section className="vehicle-owner" aria-label={observationId ? 'People at this sighting' : 'People linked to this vehicle'}>
      <div className="vehicle-owner__head">
        <h3>{observationId ? 'People at this sighting' : 'Owner, drivers and associated people'}</h3>
        {canRecord && <div className="vehicle-owner__actions">
          {(observationId ? ROLES.filter(([role]) => role !== 'owner') : ROLES).map(([role, label]) => (
            <button key={role} type="button" className="btn btn-sm btn-secondary" aria-expanded={adding === role} onClick={() => startAdding(role)}>
              {adding === role ? 'Cancel' : role === 'owner' && hasOwner ? 'Change owner' : `Add ${label.toLowerCase()}`}
            </button>
          ))}
        </div>}
      </div>
      {!canView && <p className="vehicle-profile-hint">Names and contact details are personal information, shown only to people your organisation has authorised for vehicle owner details (an administrator can enable this under Users).</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading ? <p role="status">Loading people…</p> : active.length === 0
        ? <p>{observationId ? 'No one has been recorded at this sighting.' : 'No owner, driver or associated person recorded by your organisation.'}</p>
        : active.map(card)}
      {canView && past.length > 0 && <details><summary>Previous links ({past.length})</summary>
        <ul>{past.map((link) => <li key={link.link_id}>{link.display_name ?? 'Unnamed person'} · {ROLE_LABEL[link.relationship]}
          {link.source === 'nzta_mvr' && link.source_checked_at
            ? ` · observed ${new Date(link.source_checked_at).toLocaleDateString('en-NZ')}; superseded by NZTA check ${link.ended_at ? new Date(link.ended_at).toLocaleDateString('en-NZ') : 'date unavailable'} (not transfer dates)`
            : ` · until ${link.ended_at ? new Date(link.ended_at).toLocaleDateString('en-NZ') : '—'}`}
          {link.nzta_restricted ? ' · NZTA restricted' : ''}</li>)}</ul>
      </details>}
      {checks.length > 0 && <details><summary>NZTA register checks ({checks.length})</summary>
        <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>
        <ul>{checks.map((check) => <li key={check.check_id}>{new Date(check.checked_at).toLocaleDateString('en-NZ')} · {check.relationship.replace(/_/g, ' ')} · {check.display_name ?? 'Person not named'}{check.source_authority ? ` · ${check.source_authority}` : ''}</li>)}</ul>
      </details>}
      {adding && canRecord && (
        <form className="vehicle-owner__form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <legend>{adding === 'owner' ? (hasOwner ? 'Record the new owner' : 'Record the owner') : `Record a ${ROLE_LABEL[adding].toLowerCase()}`}{observationId ? ' at this sighting' : ''}</legend>
            <div role="radiogroup" aria-label="Person" className="vehicle-owner__mode">
              <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New person</label>
              <label><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Existing person record</label>
            </div>
            {mode === 'new' ? (
              <div className="vehicle-profile-fields">
                <label>Full name<input required value={fields.display_name} maxLength={200}
                  onChange={(event) => { setFields({ ...fields, display_name: event.target.value }); setConfirmNew(false); }} /></label>
                <label>Phone<input value={fields.phone} maxLength={50} onChange={(event) => setFields({ ...fields, phone: event.target.value })} /></label>
                <label>Email<input type="email" value={fields.email} maxLength={200} onChange={(event) => setFields({ ...fields, email: event.target.value })} /></label>
                <label>Street address<input value={fields.address} maxLength={300} onChange={(event) => setFields({ ...fields, address: event.target.value })} aria-describedby="vehicle-owner-street-hint" /></label>
                <label>Suburb<input value={fields.suburb} maxLength={100} onChange={(event) => setFields({ ...fields, suburb: event.target.value })} /></label>
                <label>Town / city<input value={fields.city} maxLength={100} onChange={(event) => setFields({ ...fields, city: event.target.value })} /></label>
                <small id="vehicle-owner-street-hint" className="vehicle-profile-hint">Authorised users see the full address. Everyone else sees only the suburb and town/city.</small>
              </div>
            ) : (
              <PersonSearchPicker organizationId={organizationId} value={pickedPerson} onChange={setPickedPerson} />
            )}
            {mode === 'new' && (
              <PersonMatchSuggestions organizationId={organizationId} fields={fields} confirmNew={confirmNew}
                onConfirmNewChange={setConfirmNew} onPick={(match) => { setMode('existing'); setPickedPerson(match); }} />
            )}
            <label>Where did these details come from?
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                {sourceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {source === 'nzta_mvr' && <p className="vehicle-owner__notice" role="note">{NZTA_NOTICE}</p>}
            <label>Reason / evidence<textarea required value={basis} maxLength={1000} onChange={(event) => setBasis(event.target.value)} placeholder={adding === 'owner' ? 'For example: owner produced registration papers, 12/10' : 'For example: driver produced licence at gate, 12/10'} /></label>
            <p className="vehicle-profile-hint">A new person is added to your person records and the shared person register. {adding === 'owner' ? 'Any previous owner your organisation recorded is ended. ' : 'A vehicle can have several drivers and associated people. '}Every change is audit-logged.</p>
            <button type="submit" className="btn btn-primary btn-sm"
              disabled={mode === 'existing' ? !basis.trim() || !pickedPerson : !canSave}>{busy ? 'Saving…' : `Save ${ROLE_LABEL[adding].toLowerCase()}`}</button>
          </fieldset>
        </form>
      )}
      {openIdentityFor && <PersonIdentityPanel personRecordId={openIdentityFor} onClose={() => setOpenIdentityFor(null)} onChanged={() => void load()} />}
    </section>
  );
};

export default VehicleOwnerPanel;

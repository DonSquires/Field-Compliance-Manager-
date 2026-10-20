import React, { useCallback, useEffect, useState } from 'react';
import {
  MENTION_ROLES, MENTION_ROLE_LABEL, getObservationPeople, isDuplicateError, recordObservationPersonMention,
  reviewObservationPersonMention, type NewPersonFields, type ObservationPerson, type PersonMatch,
} from '../lib/personIdentity';
import { PersonIdentityPanel, PersonMatchSuggestions, PersonSearchPicker, PersonStateBadge } from './PersonIdentity';
import './PersonIdentity.css';

const EMPTY: NewPersonFields = { display_name: '', date_of_birth: '', phone: '', suburb: '', city: '' };
const errorText = (error: unknown) => (error instanceof Error ? error.message : (error as { message?: string })?.message) ?? 'Something went wrong';

/**
 * Everyone recorded at one sighting: the identity of record plus anyone
 * mentioned (driver, passenger, witness…). Any member can add a person; they
 * stay Unconfirmed until an administrator confirms a verified identity.
 */
export const ObservationPeoplePanel: React.FC<{
  observationId: string;
  organizationId: string | null | undefined;
  isAdmin?: boolean;
  onChanged?: () => void;
}> = ({ observationId, organizationId, isAdmin = false, onChanged }) => {
  const [people, setPeople] = useState<ObservationPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [picked, setPicked] = useState<PersonMatch | null>(null);
  const [fields, setFields] = useState<NewPersonFields>(EMPTY);
  const [confirmNew, setConfirmNew] = useState(false);
  const [role, setRole] = useState('mentioned');
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setPeople(await getObservationPeople(observationId)); setError(null); } catch (loadError) { setError(errorText(loadError)); }
    setLoading(false);
  }, [observationId]);

  useEffect(() => { void load(); }, [load]);

  const reset = () => { setAdding(false); setPicked(null); setFields(EMPTY); setConfirmNew(false); setBasis(''); setRole('mentioned'); };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await recordObservationPersonMention({
        observationId,
        personRecordId: mode === 'existing' ? picked?.person_record_id : null,
        personFields: mode === 'new' ? { ...fields, confirm_new_person: confirmNew } : null,
        role,
        basis,
      });
      reset();
      await load();
      onChanged?.();
    } catch (saveError) {
      const message = errorText(saveError);
      setError(isDuplicateError(message) ? `${message.replace(/^POSSIBLE_DUPLICATE:\s*/, '')} Pick them from the list above, or tick “This is a different person”.` : message);
    }
    setBusy(false);
  };

  const review = async (person: ObservationPerson, action: 'confirm' | 'dismiss', setIdentity = false) => {
    if (!person.mention_id) return;
    const notes = action === 'dismiss' ? window.prompt(`Why is ${person.display_name ?? 'this person'} not connected to this sighting?`) : '';
    if (action === 'dismiss' && !notes?.trim()) return;
    setBusy(true); setError(null);
    try { await reviewObservationPersonMention(person.mention_id, action, notes ?? undefined, setIdentity); await load(); onChanged?.(); }
    catch (reviewError) { setError(errorText(reviewError)); }
    setBusy(false);
  };

  const canSave = Boolean(basis.trim()) && (mode === 'existing' ? Boolean(picked) : fields.display_name.trim().length >= 2);
  const hasIdentityOfRecord = people.some((person) => person.is_identity_of_record);

  return (
    <section className="vehicle-owner observation-people" aria-label="People mentioned at this sighting">
      <div className="vehicle-owner__head">
        <h3>People mentioned</h3>
        <button type="button" className="btn btn-sm btn-secondary" aria-expanded={adding} onClick={() => (adding ? reset() : setAdding(true))}>{adding ? 'Cancel' : 'Add person'}</button>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading ? <p role="status">Loading people…</p> : people.length === 0 ? <p>No one has been mentioned at this sighting.</p> : (
        <ul className="observation-people__list">
          {people.map((person) => (
            <li key={person.mention_id ?? `record-${person.person_record_id}`} className="vehicle-owner__card">
              <div className="vehicle-owner__title">
                <button type="button" className="observation-people__name" onClick={() => setOpenPerson(person.person_record_id)}>{person.display_name || 'Unnamed person'}</button>
                <span className="badge badge-info">{MENTION_ROLE_LABEL[person.mention_role] ?? person.mention_role}</span>
                {person.is_identity_of_record
                  ? <span className="badge badge-success">Identity of record</span>
                  : <span className={`badge ${person.status === 'confirmed' ? 'badge-success' : 'badge-warning'}`}>{person.status === 'confirmed' ? 'Confirmed' : 'Unconfirmed'}</span>}
                <PersonStateBadge state={person.review_state} />
              </div>
              {person.aliases?.length ? <div className="vehicle-owner__meta">Also known as {person.aliases.join(', ')}</div> : null}
              {person.basis && <div className="vehicle-owner__meta">{person.basis}</div>}
              {person.recorded_at && <small>Added {new Date(person.recorded_at).toLocaleDateString('en-NZ')} by {person.recorded_by_name ?? 'staff'}{person.review_notes ? ` · ${person.review_notes}` : ''}</small>}
              {person.mention_id && (
                <div className="vehicle-owner__actions">
                  {isAdmin && person.status === 'unconfirmed' && (
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy || person.review_state !== 'verified'}
                      title={person.review_state !== 'verified' ? 'Verify this person’s identity first' : undefined}
                      onClick={() => void review(person, 'confirm')}>Confirm</button>
                  )}
                  {isAdmin && !hasIdentityOfRecord && person.review_state === 'verified' && (
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void review(person, 'confirm', true)}>Set as identity of record</button>
                  )}
                  {person.can_dismiss && <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void review(person, 'dismiss')}>Not connected</button>}
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpenPerson(person.person_record_id)}>Identity…</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form className="vehicle-owner__form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <legend>Add a person mentioned at this sighting</legend>
            <div role="radiogroup" aria-label="Person" className="vehicle-owner__mode">
              <label><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Person already on record</label>
              <label><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New person</label>
            </div>
            {mode === 'existing' ? <PersonSearchPicker organizationId={organizationId} value={picked} onChange={setPicked} /> : (
              <>
                <div className="vehicle-profile-fields">
                  <label>Name<input required value={fields.display_name} maxLength={200} onChange={(event) => { setFields({ ...fields, display_name: event.target.value }); setConfirmNew(false); }} /></label>
                  <label>Date of birth<input type="date" value={fields.date_of_birth} onChange={(event) => setFields({ ...fields, date_of_birth: event.target.value })} /></label>
                  <label>Phone<input value={fields.phone} maxLength={50} onChange={(event) => setFields({ ...fields, phone: event.target.value })} /></label>
                  <label>Suburb<input value={fields.suburb} maxLength={100} onChange={(event) => setFields({ ...fields, suburb: event.target.value })} /></label>
                  <label>Town / city<input value={fields.city} maxLength={100} onChange={(event) => setFields({ ...fields, city: event.target.value })} /></label>
                </div>
                <PersonMatchSuggestions organizationId={organizationId} fields={fields} confirmNew={confirmNew} onConfirmNewChange={setConfirmNew}
                  onPick={(match) => { setMode('existing'); setPicked(match); }} />
              </>
            )}
            <label>How are they connected?
              <select value={role} onChange={(event) => setRole(event.target.value)}>
                {MENTION_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>How did they come up?<textarea required value={basis} maxLength={1000} onChange={(event) => setBasis(event.target.value)} placeholder="e.g. Named by the driver as the vehicle owner" /></label>
            <p className="vehicle-profile-hint">They are added as Unconfirmed. An administrator confirms them once their identity is verified. Every change is audit-logged.</p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canSave}>{busy ? 'Saving…' : 'Add person'}</button>
          </fieldset>
        </form>
      )}
      {openPerson && <PersonIdentityPanel personRecordId={openPerson} onClose={() => setOpenPerson(null)} onChanged={() => void load()} />}
    </section>
  );
};

export default ObservationPeoplePanel;

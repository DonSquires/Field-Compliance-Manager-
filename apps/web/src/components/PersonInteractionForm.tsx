import React, { useState } from 'react';
import { CheckCircle2, UserPlus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './PersonInteractionForm.css';

export const INTERACTION_TYPES: Array<{ value: string; label: string }> = [
  { value: 'spoken_to', label: 'Spoke with them' },
  { value: 'warning_given', label: 'Warning given' },
  { value: 'trespass_notice_served', label: 'Trespass notice served' },
  { value: 'moved_on', label: 'Moved on' },
  { value: 'welfare_check', label: 'Welfare check' },
  { value: 'observed', label: 'Observed only' },
  { value: 'report_attached', label: 'Report attached' },
  { value: 'other', label: 'Something else' },
];

interface PersonInteractionFormProps {
  organizationId: string;
  dispatchJobId?: string | null;
  shiftId?: string | null;
  /** Record against a known person record (admin/person-search users) instead of typing a name. */
  personRecordId?: string | null;
  personName?: string | null;
  source?: 'field' | 'admin';
  defaultOpen?: boolean;
  onRecorded?: (result: { interactionId: string; personRecordId: string | null }) => void;
}

interface PersonDetails {
  description: string;
  date_of_birth: string;
  phone: string;
  address: string;
}

const EMPTY_DETAILS: PersonDetails = { description: '', date_of_birth: '', phone: '', address: '' };

/** Only the fields the officer filled in; null when nothing was added. */
export const personDetailsPayload = (details: PersonDetails): Record<string, string> | null => {
  const entries = Object.entries(details)
    .map(([key, value]) => [key, value.replace(/\s+/g, ' ').trim()] as const)
    .filter(([, value]) => value.length > 0);
  return entries.length ? Object.fromEntries(entries) : null;
};

const receiptFor = (who: string, linkedRecord: boolean, detailsAdded: boolean, detailsStatus: string | undefined) => {
  if (detailsStatus === 'applied') return `Recorded on ${who}'s history and the person details were updated.`;
  if (detailsStatus === 'pending') return `Recorded on ${who}'s history. The details you added are waiting for an administrator to review.`;
  if (detailsAdded && !linkedRecord) return `Saved for ${who}. Any details you added will be checked by an administrator before the person record changes.`;
  return linkedRecord ? `Recorded on ${who}'s history.` : `Recorded for ${who}. An administrator will review the person record.`;
};

// ATLAS CALLS: rpc record_person_interaction (writes person_interactions, person_records drafts, audit_log)
export const PersonInteractionForm: React.FC<PersonInteractionFormProps> = ({
  organizationId, dispatchJobId = null, shiftId = null, personRecordId = null, personName = null,
  source = 'field', defaultOpen = false, onRecorded,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState('');
  const [type, setType] = useState('spoken_to');
  const [notes, setNotes] = useState('');
  const [details, setDetails] = useState<PersonDetails>(EMPTY_DETAILS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  // One id per attempt so a retry after a dropped connection cannot record twice.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const idBase = `person-interaction-${dispatchJobId ?? shiftId ?? personRecordId ?? 'new'}`;
  const hasWork = Boolean(dispatchJobId || shiftId);
  const trimmedName = name.trim();
  const canSubmit = hasWork && !busy && notes.trim().length >= 3 && (personRecordId || trimmedName.length >= 2);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    const detailsPayload = personDetailsPayload(details);
    try {
      const { data, error: rpcError } = await supabase.rpc('record_person_interaction', {
        p_client_request_id: requestId,
        p_organization_id: organizationId,
        p_interaction_type: type,
        p_notes: notes.trim(),
        p_person_record_id: personRecordId,
        p_new_person_name: personRecordId ? null : trimmedName,
        p_dispatch_job_id: dispatchJobId,
        p_shift_id: dispatchJobId ? null : shiftId,
        p_source: source,
        p_details: detailsPayload,
      });
      if (rpcError) throw rpcError;
      const result = data as { interaction_id?: string; person_record_id?: string | null; details_status?: string } | null;
      if (!result?.interaction_id) throw new Error('The interaction was not confirmed. Try again.');
      const who = personName ?? trimmedName;
      setReceipt(receiptFor(who, Boolean(personRecordId), Boolean(detailsPayload), result.details_status));
      setName('');
      setNotes('');
      setDetails(EMPTY_DETAILS);
      setType('spoken_to');
      setRequestId(crypto.randomUUID());
      onRecorded?.({ interactionId: result.interaction_id, personRecordId: result.person_record_id ?? null });
    } catch (caught) {
      const message = typeof caught === 'object' && caught && 'message' in caught ? String((caught as { message: unknown }).message) : '';
      setError(message || 'The interaction could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="person-interaction">
        {receipt && <p className="person-interaction-receipt" role="status"><CheckCircle2 size={16} aria-hidden="true" />{receipt}</p>}
        <button type="button" className="btn btn-secondary person-interaction-open" onClick={() => { setOpen(true); setReceipt(null); }}>
          <UserPlus size={16} aria-hidden="true" />{personRecordId ? 'Add interaction' : 'Add a person involved'}
        </button>
      </div>
    );
  }

  return (
    <form className="person-interaction is-open" onSubmit={submit} aria-label={personRecordId ? 'Add interaction' : 'Person involved'}>
      {!hasWork && <p className="person-interaction-error" role="alert">Choose a job or shift before recording a person.</p>}
      {!personRecordId && (
        <div className="form-group">
          <label htmlFor={`${idBase}-name`}>Name as given</label>
          <input id={`${idBase}-name`} value={name} maxLength={120} autoComplete="off" required
            onChange={(event) => setName(event.target.value)} placeholder="For example: John Smith, or Unknown male" />
          <small>Use the name they gave. If unknown, describe them (for example "Unknown male, grey hoodie").</small>
        </div>
      )}
      <div className="form-group">
        <label htmlFor={`${idBase}-type`}>What happened</label>
        <select id={`${idBase}-type`} value={type} onChange={(event) => setType(event.target.value)}>
          {INTERACTION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor={`${idBase}-notes`}>Notes</label>
        <textarea id={`${idBase}-notes`} rows={3} value={notes} maxLength={4000} required
          onChange={(event) => setNotes(event.target.value)} placeholder="What was said or done, and the outcome" />
      </div>
      <details className="person-interaction-details">
        <summary>Add person details (optional)</summary>
        <p className="person-interaction-hint">
          Saved with a new person record. If this person is already on file, an administrator checks the changes first.
        </p>
        <div className="form-group">
          <label htmlFor={`${idBase}-description`}>Description</label>
          <textarea id={`${idBase}-description`} rows={2} value={details.description} maxLength={1000}
            onChange={(event) => setDetails((current) => ({ ...current, description: event.target.value }))}
            placeholder="Height, build, clothing, distinguishing features" />
        </div>
        <div className="person-interaction-detail-row">
          <div className="form-group">
            <label htmlFor={`${idBase}-dob`}>Date of birth</label>
            <input id={`${idBase}-dob`} type="date" value={details.date_of_birth} min="1900-01-01"
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setDetails((current) => ({ ...current, date_of_birth: event.target.value }))} />
          </div>
          <div className="form-group">
            <label htmlFor={`${idBase}-phone`}>Phone</label>
            <input id={`${idBase}-phone`} type="tel" inputMode="tel" value={details.phone} maxLength={40} pattern="[0-9+() \-]{5,40}"
              autoComplete="off" onChange={(event) => setDetails((current) => ({ ...current, phone: event.target.value }))} />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor={`${idBase}-address`}>Address</label>
          <input id={`${idBase}-address`} value={details.address} maxLength={300} autoComplete="off"
            onChange={(event) => setDetails((current) => ({ ...current, address: event.target.value }))} />
        </div>
      </details>
      {error && <p className="person-interaction-error" role="alert">{error}</p>}
      {receipt && <p className="person-interaction-receipt" role="status"><CheckCircle2 size={16} aria-hidden="true" />{receipt}</p>}
      <div className="person-interaction-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busy ? 'Saving…' : 'Save person'}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Close</button>
      </div>
    </form>
  );
};

export default PersonInteractionForm;

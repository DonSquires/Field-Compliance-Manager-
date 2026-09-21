import { useState } from 'react';
import { AlertTriangle, CalendarX2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { agreementTermState, agreementTermWords, dayWords, localToday } from '../lib/agreementTerm';
import './CrmAgreementTerm.css';

export interface AgreementTerm { id: string; name: string; starts_on: string | null; ends_on: string | null }
export { agreementTermState, agreementTermWords };

/** The agreement's term in plain words, and the provider's governed way to end it. */
export function CrmAgreementTerm({ agreement, canEnd, onEnded }: { agreement: AgreementTerm; canEnd: boolean; onEnded: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [endsOn, setEndsOn] = useState(localToday());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = agreementTermState(agreement);

  const end = async () => {
    setSaving(true); setError(null);
    // ATLAS WRITES: end_service_agreement (provider administrator; audited before/after ends_on)
    const { error: endError } = await supabase.rpc('end_service_agreement', { p_agreement_id: agreement.id, p_ends_on: endsOn, p_reason: reason.trim() });
    if (endError) setError(endError.message);
    else { setOpen(false); setReason(''); await onEnded(); }
    setSaving(false);
  };

  return (
    <div className={`crm-agreement-term is-${state}`}>
      <span>{agreementTermWords(agreement)}</span>
      {canEnd && (state === 'live' || state === 'ending') && !open && <button type="button" className="crm-agreement-term-end" onClick={() => setOpen(true)}><CalendarX2 size={14} aria-hidden="true" /> End this agreement</button>}
      {open && (
        <form className="crm-agreement-term-form" onSubmit={(event) => { event.preventDefault(); void end(); }} aria-label={`End ${agreement.name}`}>
          <p>Ending stops new quotes, invitations and activation on this agreement from the day after the end date. Work already rostered or delivered stays on record.{agreement.starts_on ? ` To cancel one that never took effect, end it the day before it started (${dayWords(agreement.starts_on)}).` : ''}</p>
          <label><span>Last day in force</span><input type="date" required value={endsOn} onChange={(event) => setEndsOn(event.target.value)} /></label>
          <label><span>Why it is ending</span><input required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Contract expired, not renewed" /></label>
          {error && <p className="crm-agreement-term-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
          <div><button type="button" onClick={() => { setOpen(false); setError(null); }}>Keep it</button><button type="submit" className="is-danger" disabled={saving || reason.trim().length < 3}>{saving ? 'Ending…' : 'End agreement'}</button></div>
        </form>
      )}
    </div>
  );
}

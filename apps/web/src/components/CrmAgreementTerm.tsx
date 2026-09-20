import { useState } from 'react';
import { AlertTriangle, CalendarX2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './CrmAgreementTerm.css';

export interface AgreementTerm { id: string; name: string; starts_on: string | null; ends_on: string | null }

const dayWords = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
const localToday = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** 'live' while ends_on is null or today or later; 'ended' after; 'cancelled' when it ended before it started. */
export const agreementTermState = (agreement: Pick<AgreementTerm, 'starts_on' | 'ends_on'>, today = localToday()): 'live' | 'ending' | 'ended' | 'cancelled' => {
  if (!agreement.ends_on) return 'live';
  if (agreement.starts_on && agreement.ends_on < agreement.starts_on) return 'cancelled';
  if (agreement.ends_on < today) return 'ended';
  return agreement.ends_on === today ? 'ending' : 'live';
};

/** 'In force since 20 Sep 2026' · 'In force since 20 Sep 2026 · ends 30 Sep 2026' · 'Ended 19 Sep 2026' · 'Cancelled before it took effect'. */
export const agreementTermWords = (agreement: Pick<AgreementTerm, 'starts_on' | 'ends_on'>, today = localToday()): string => {
  const state = agreementTermState(agreement, today);
  if (state === 'cancelled') return 'Cancelled before it took effect';
  if (state === 'ended') return `Ended ${dayWords(agreement.ends_on!)}`;
  const since = agreement.starts_on ? `In force since ${dayWords(agreement.starts_on)}` : 'In force';
  if (state === 'ending') return `${since} · ends today`;
  return agreement.ends_on ? `${since} · ends ${dayWords(agreement.ends_on)}` : since;
};

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

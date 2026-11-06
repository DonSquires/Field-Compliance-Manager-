import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

interface BreakPlan {
  shift_id: string;
  planned_minutes: number;
  unpaid: boolean;
  taken_minutes: number;
}
interface BreakReceipt {
  id: string;
  shift_id: string;
  break_type: 'rest' | 'meal';
  started_at: string;
  ended_at: string | null;
  is_paid: boolean;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function parseBreak(value: unknown, shiftId: string): BreakReceipt {
  if (!isRecord(value) || typeof value.id !== 'string' || value.shift_id !== shiftId
    || !['rest', 'meal'].includes(String(value.break_type)) || typeof value.is_paid !== 'boolean'
    || typeof value.started_at !== 'string' || !Number.isFinite(Date.parse(value.started_at))
    || !(value.ended_at === null || (typeof value.ended_at === 'string' && Number.isFinite(Date.parse(value.ended_at))))) {
    throw new Error('Break receipt could not be confirmed. Refresh or contact operations before retrying.');
  }
  return { id: value.id, shift_id: shiftId, break_type: value.break_type === 'meal' ? 'meal' : 'rest',
    started_at: value.started_at, ended_at: value.ended_at, is_paid: value.is_paid };
}
const message = (value: unknown) => isRecord(value) && typeof value.message === 'string' ? value.message : 'Break status could not be confirmed.';

export function OfficerShiftBreakControl({ shiftId }: { shiftId: string }) {
  const [plan, setPlan] = useState<BreakPlan | null>(null);
  const [active, setActive] = useState<BreakReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const request = useRef<{ id: string; type: 'meal' | 'rest' } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [planned, current] = await Promise.all([
        supabase.rpc('get_officer_break_plan', { p_shift_id: shiftId }),
        supabase.from('shift_breaks').select('id,shift_id,break_type,started_at,ended_at,is_paid').eq('shift_id', shiftId).is('ended_at', null).maybeSingle(),
      ]);
      if (planned.error) throw planned.error;
      if (current.error) throw current.error;
      const value: unknown = planned.data;
      if (!isRecord(value) || value.shift_id !== shiftId || typeof value.planned_minutes !== 'number'
        || !Number.isInteger(value.planned_minutes) || value.planned_minutes < 0
        || typeof value.taken_minutes !== 'number' || !Number.isFinite(value.taken_minutes) || value.taken_minutes < 0
        || typeof value.unpaid !== 'boolean') throw new Error('The break plan could not be confirmed.');
      setPlan({ shift_id: shiftId, planned_minutes: value.planned_minutes, taken_minutes: value.taken_minutes, unpaid: value.unpaid });
      setActive(current.data === null ? null : parseBreak(current.data, shiftId));
      setError(null);
    } catch (failure) { setPlan(null); setError(message(failure)); }
    finally { setLoading(false); }
  }, [shiftId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const change = async (type: 'meal' | 'rest') => {
    setBusy(true); setError(null); setNotice(null);
    try {
      if (active) {
        const result = await supabase.rpc('end_shift_break', { p_break_id: active.id, p_notes: null });
        if (result.error) throw result.error;
        const receipt = parseBreak(result.data, shiftId);
        if (receipt.id !== active.id || receipt.ended_at === null) throw new Error('Break end was not confirmed. Retry or refresh; do not assume it ended.');
        setActive(null);
        request.current = null;
        setNotice('Break finished. Actual duration recorded.');
        await load();
      } else {
        if (request.current && request.current.type !== type) throw new Error('Retry the same break type or refresh to confirm the previous attempt first.');
        request.current ??= { id: crypto.randomUUID(), type };
        const result = await supabase.rpc('start_shift_break', { p_client_request_id: request.current.id, p_shift_id: shiftId, p_break_type: type });
        if (result.error) throw result.error;
        const receipt = parseBreak(result.data, shiftId);
        if (receipt.ended_at !== null) throw new Error('This break has already ended. Refresh before starting another.');
        setActive(receipt); setNow(Date.now()); request.current = null;
        setNotice('Break started and recorded.');
      }
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const remaining = plan && active && !active.is_paid && plan.unpaid
    ? Math.max(0, Math.ceil((plan.planned_minutes - plan.taken_minutes) * 60 - (now - Date.parse(active.started_at)) / 1000)) : null;
  return <section aria-label="Shift break">
    {loading ? <span role="status">Checking break status...</span> : <>
      {plan && <p>{plan.planned_minutes ? `${plan.planned_minutes} min ${plan.unpaid ? 'unpaid' : 'paid'} planned break` : 'No break allowance planned'}. Actual unpaid time only is deducted.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!plan ? <button type="button" disabled={busy} onClick={() => void load()}>Retry break status</button> : <>
        <button type="button" disabled={busy} onClick={() => void change(plan.unpaid ? 'meal' : 'rest')}>{busy ? 'Recording...' : active ? 'Finish break' : 'Start break'}</button>
        {remaining !== null && <span role="timer" aria-label="Unpaid break remaining">{remaining ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining` : 'Planned time reached - finish your break when you return'}</span>}
        {!active && <details><summary>Other rest or meal break</summary><p>The plan does not replace your rest and meal entitlements.</p><button type="button" disabled={busy} onClick={() => void change('rest')}>Start paid rest break</button><button type="button" disabled={busy} onClick={() => void change('meal')}>Start unpaid meal break</button></details>}
      </>}
    </>}
  </section>;
}

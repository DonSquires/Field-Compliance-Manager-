import { useEffect, useState } from 'react';
import {
  decidePlaceServiceChange, describeTerms, fetchPlaceServices, placeServiceChangeLabels as kindLabel,
  type PlaceServiceTerms, type Season, type StaticPostTerms,
} from '../../lib/placeServices';

export interface PlaceServiceChangeAction {
  id: string;
  triggered_by?: string | null;
  user_id?: string | null;
  can_decide?: boolean;
  status: string;
  proposed_payload: unknown;
}

interface ChangePayload {
  version_id: string;
  location_id: string;
  change_kind: 'create' | 'update' | 'end';
  effective_from: string;
  terms: PlaceServiceTerms | StaticPostTerms | null;
}

type Decision = 'approve' | 'reject' | 'withdraw';

function readPayload(value: unknown): ChangePayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<ChangePayload>;
  if (typeof payload.version_id !== 'string' || typeof payload.location_id !== 'string') return null;
  return payload as ChangePayload;
}

function isStaticPost(terms: PlaceServiceChangePayloadTerms): terms is StaticPostTerms {
  return Boolean(terms && 'post_name' in terms);
}
type PlaceServiceChangePayloadTerms = ChangePayload['terms'];

export function PlaceServiceChangeReview({ action, currentUserId, onDecided }: {
  action: PlaceServiceChangeAction;
  currentUserId: string | null;
  onDecided: (message: string) => void;
}) {
  const payload = readPayload(action.proposed_payload);
  const [labels, setLabels] = useState<{ checks: Record<string, string>; seasons: Season[] }>({ checks: {}, seasons: [] });
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<{ key: string; requestId: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationId = payload?.location_id ?? null;

  useEffect(() => {
    if (!locationId) return;
    let active = true;
    fetchPlaceServices(locationId)
      .then(workspace => {
        if (!active) return;
        setLabels({
          checks: Object.fromEntries((workspace.check_types ?? []).map(check => [check.check_key, check.label])),
          seasons: workspace.seasons ?? [],
        });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [locationId]);

  if (!payload) return <p role="alert">This place change could not be read. Refresh and try again.</p>;

  const requester = action.triggered_by ?? action.user_id ?? null;
  const ownChange = Boolean(currentUserId && requester === currentUserId);
  const pending = action.status === 'pending' || action.status === 'pending_approval' || action.status === 'proposed';
  const terms = payload.terms;
  const summary = !terms ? 'Ends this service'
    : isStaticPost(terms) ? `Static post: ${terms.post_name}${terms.required_skill_names?.length ? ` · needs ${terms.required_skill_names.join(', ')}` : ''}`
      : describeTerms(terms, labels);

  const reasonRequired = decision !== 'withdraw';
  const submit = async () => {
    if (!decision || (reasonRequired && !reason.trim())) return;
    const key = `${decision}:${reason.trim()}`;
    const requestId = attempt?.key === key ? attempt.requestId : crypto.randomUUID();
    setAttempt({ key, requestId });
    setSaving(true);
    setError(null);
    try {
      const result = await decidePlaceServiceChange(payload.version_id, decision, reason.trim(), requestId);
      setAttempt(null);
      setDecision(null);
      setReason('');
      onDecided(result.status === 'approved'
        ? `Change approved. It applies from ${result.applied_effective_from ?? payload.effective_from}.`
        : result.status === 'withdrawn' ? 'Change withdrawn. The current service stays as it is.'
          : 'Change rejected. The current service stays as it is.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The decision could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3" aria-label="Place service change">
      <div>
        <p className="text-sm font-medium">{kindLabel[payload.change_kind] ?? 'Change'} from {payload.effective_from}</p>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>
      {ownChange && pending && <p className="text-sm">Another administrator must approve this</p>}
      {ownChange && pending && !decision && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => setDecision('withdraw')}>Withdraw change</button>
        </div>
      )}
      {!ownChange && pending && action.can_decide !== false && !decision && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => setDecision('approve')}>Approve change</button>
          <button type="button" className="btn" onClick={() => setDecision('reject')}>Reject change</button>
        </div>
      )}
      {decision && (
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="block text-sm">
            {reasonRequired ? 'Reason' : 'Reason (optional)'}
            <textarea className="input mt-1 w-full" required={reasonRequired} rows={3} value={reason} onChange={event => setReason(event.target.value)} />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving || (reasonRequired && !reason.trim())}>
              {saving ? 'Saving…' : decision === 'approve' ? 'Confirm approval' : decision === 'withdraw' ? 'Confirm withdrawal' : 'Confirm rejection'}
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => { setDecision(null); setError(null); }}>Back</button>
          </div>
        </form>
      )}
    </section>
  );
}

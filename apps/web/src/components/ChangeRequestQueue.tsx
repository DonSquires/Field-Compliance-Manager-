import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  CHANGE_REQUEST_REVIEW_ROLES, bobEvaluationPrompt, changeRequestStatusLabel,
  listChangeRequests, setChangeRequestDisposition,
  type ChangeRequestDisposition, type ChangeRequestRecord,
} from '../lib/bobChangeRequest';
import './ChangeRequestButton.css';

export function ChangeRequestQueue({ onOpenBob }: { onOpenBob?: (prompt: string) => void }) {
  const { profile } = useAuth();
  const [requests, setRequests] = useState<ChangeRequestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const allowed = CHANGE_REQUEST_REVIEW_ROLES.has(profile?.role ?? '');
  const load = useCallback(async () => {
    setLoading(true);
    try { setRequests(await listChangeRequests({ dispositions: ['open', 'reviewing'] })); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review queue could not be loaded.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);
  if (!allowed) return null;
  const review = async (request: ChangeRequestRecord, disposition: ChangeRequestDisposition) => {
    setBusy(request.id); setError(null);
    try { await setChangeRequestDisposition(request.id, disposition, notes[request.id] ?? ''); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review action failed.'); }
    finally { setBusy(null); }
  };
  return <section className="change-request-queue" aria-label="Page change review queue">
    <details>
      <summary>Page change requests · {loading ? 'Loading' : `${requests.length} awaiting review`}</summary>
      <p>Unprotected requests go to Bob Builder chat automatically for assessment, planning and an autopilot job. Protected and stop-line requests wait here for a person. Merge and deployment always stay human.</p>
      <button type="button" disabled={loading || !!busy} onClick={() => void load()}>Refresh requests</button>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !requests.length && <p>No page change requests awaiting review.</p>}
      {requests.map((request) => <article key={request.id}>
        <h3>{request.desiredBehavior}</h3>
        <small>{request.page} · {changeRequestStatusLabel(request)} · {new Date(request.created_at).toLocaleString('en-NZ')}</small>
        <p><strong>Before:</strong> {request.currentBehavior || 'Not described'}</p>
        <p><strong>Reason:</strong> {request.businessReason || 'Not stated'}</p>
        <p>Risk: {request.repair_risk}. {request.stop_line_hit ? 'Held for platform review; do not pass to Bob.' : 'No code executes from this queue.'}</p>
        <label>Review note<textarea maxLength={1000} value={notes[request.id] ?? request.review_note ?? ''} onChange={(event) => setNotes({ ...notes, [request.id]: event.target.value })} /></label>
        <button type="button" disabled={!!busy || !onOpenBob || !!request.stop_line_hit} onClick={() => onOpenBob?.(bobEvaluationPrompt(request))}>Evaluate with Bob</button>
        <button type="button" disabled={!!busy || request.disposition === 'reviewing'} onClick={() => void review(request, 'reviewing')}>Mark reviewing</button>
        <button type="button" disabled={!!busy || !(notes[request.id]?.trim())} onClick={() => void review(request, 'dismissed')}>Decline with note</button>
        <button type="button" disabled={!!busy || !(notes[request.id]?.trim())} onClick={() => void review(request, 'resolved')}>Resolve with note</button>
      </article>)}
    </details>
  </section>;
}

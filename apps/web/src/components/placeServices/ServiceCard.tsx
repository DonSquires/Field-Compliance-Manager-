import { useState, type FormEvent } from 'react';
import { describeTerms, endStaticPost, placeServiceChangeLabels, type PlaceService, type PlaceServiceTerms,
  type PlaceServicesWorkspace } from '../../lib/placeServices';

function isPatrolTerms(terms: PlaceService['terms']): terms is PlaceServiceTerms {
  return terms !== null && 'days' in terms;
}

function EndPostForm({ workUnit, onCancel, onEnded }: {
  workUnit: { id: string; name: string }; onCancel: () => void; onEnded: (status: 'pending' | 'approved') => void;
}) {
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<{ reason: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (busy || !trimmed) return;
    const requestId = attempt?.reason === trimmed ? attempt.requestId : crypto.randomUUID();
    setAttempt({ reason: trimmed, requestId });
    setBusy(true);
    setError(null);
    try {
      const result = await endStaticPost(workUnit.id, trimmed, requestId);
      onEnded(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The post could not be ended. Try again.');
      setBusy(false);
    }
  }
  return <form className="place-service-end-post" onSubmit={event => void submit(event)}>
    <p>Ending this post stops new rostering for it. Shifts already on the roster are kept.</p>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    <label>Reason for ending {workUnit.name}<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
    <div className="place-service-actions">
      <button type="submit" className="is-primary" disabled={busy || !reason.trim()}>{busy ? 'Ending…' : 'Confirm end'}</button>
      <button type="button" onClick={onCancel} disabled={busy}>Back</button>
    </div>
  </form>;
}

export function ServiceCard({ service, workspace, moduleLabels, onEdit, onEnd, onResponsibleRun, onPostEnded }: {
  service: PlaceService;
  workspace: PlaceServicesWorkspace;
  moduleLabels: Record<string, string>;
  onEdit: () => void;
  onEnd: () => void;
  onResponsibleRun: () => void;
  onPostEnded: (status: 'pending' | 'approved') => void;
}) {
  const [endingPost, setEndingPost] = useState(false);
  const anchor = workspace.anchors.find(item => item.id === (service.anchor.site_id ?? service.anchor.zone_id));
  const labels = { checks: Object.fromEntries(workspace.check_types.map(item => [item.check_key, item.label])), seasons: workspace.seasons };
  const proposed = service.pending?.terms;
  const postName = proposed && 'post_name' in proposed ? proposed.post_name : null;
  const activePost = service.service_kind === 'static_guarding' && service.work_unit?.active ? service.work_unit : null;
  return <article className="place-service-card">
    <div>
      <h4>{moduleLabels[service.module_key] ?? service.module_key.replaceAll('_', ' ')}</h4>
      <p>{anchor ? `${anchor.kind === 'site' ? 'Site' : 'Area'} · ${anchor.name}` : 'Place no longer available'}</p>
      <p>{service.responsibility?.work_unit_name ?? service.work_unit?.name ?? postName ?? 'No responsible run yet'}</p>
      {isPatrolTerms(service.terms) && <p>{describeTerms(service.terms, labels)}</p>}
      {service.effective_from && <p>Effective from {service.effective_from}</p>}
      {service.pending && <div className="place-service-pending">
        <strong>Waiting for approval</strong>
        <span>{placeServiceChangeLabels[service.pending.change_kind] ?? 'Change'} from {service.pending.effective_from}</span>
        {proposed && isPatrolTerms(proposed) && <span>{describeTerms(proposed, labels)}</span>}
      </div>}
    </div>
    {workspace.can_manage && service.service_kind === 'patrol' && service.delivery_schedule_id && !service.pending && <div className="place-service-actions">
      <button type="button" onClick={onEdit} disabled={!isPatrolTerms(service.terms)}>Edit</button>
      <button type="button" onClick={onResponsibleRun}>Responsible run</button>
      <button type="button" onClick={onEnd}>End</button>
    </div>}
    {workspace.can_manage && activePost && !service.pending && (endingPost
      ? <EndPostForm workUnit={activePost} onCancel={() => setEndingPost(false)} onEnded={status => { setEndingPost(false); onPostEnded(status); }} />
      : <div className="place-service-actions"><button type="button" onClick={() => setEndingPost(true)}>End post</button></div>)}
  </article>;
}

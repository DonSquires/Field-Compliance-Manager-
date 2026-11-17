import { useEffect, useState, type FormEvent } from 'react';
import { addStaticPost, fetchOperatingSkills, type OperatingSkill, type PlaceServicesWorkspace,
  type StaticPostResult } from '../../lib/placeServices';

export function StaticPostDialog({ locationId, workspace, onClose }: {
  locationId: string; workspace: PlaceServicesWorkspace; onClose: (changed: boolean) => void;
}) {
  const [agreementId, setAgreementId] = useState(workspace.agreements[0]?.id ?? '');
  const [anchorKey, setAnchorKey] = useState(workspace.anchors[0] ? `${workspace.anchors[0].kind}:${workspace.anchors[0].id}` : '');
  const [branchId, setBranchId] = useState(workspace.operating_branches[0]?.id ?? '');
  const [postName, setPostName] = useState('');
  const [reason, setReason] = useState('');
  const [skills, setSkills] = useState<OperatingSkill[] | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [attempt, setAttempt] = useState<{ payload: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StaticPostResult | null>(null);

  useEffect(() => {
    let current = true;
    setSkills(null);
    setSkillIds([]);
    setSkillError(null);
    if (!branchId) return;
    fetchOperatingSkills(branchId)
      .then(rows => { if (current) setSkills(rows); })
      .catch(cause => { if (current) setSkillError(cause instanceof Error ? cause.message : 'Skills could not be loaded'); });
    return () => { current = false; };
  }, [branchId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !postName.trim() || !reason.trim() || !anchorKey || !agreementId || !branchId) return;
    const [kind, anchorId] = anchorKey.split(':');
    const input = {
      locationId, agreementId, siteId: kind === 'site' ? anchorId : null, zoneId: kind === 'zone' ? anchorId : null,
      postName: postName.trim(), operatingOrganizationId: branchId, requiredSkillIds: skillIds, reason: reason.trim(),
    };
    const payload = JSON.stringify(input);
    const requestId = attempt?.payload === payload ? attempt.requestId : crypto.randomUUID();
    setAttempt({ payload, requestId });
    setBusy(true);
    setError(null);
    try { setResult(await addStaticPost({ ...input, requestId })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The static post could not be created'); }
    finally { setBusy(false); }
  }

  if (result) return <section className="place-service-editor" aria-label="Static post saved">
    <h3>Add static post</h3>
    {result.status === 'approved'
      ? <p role="status">Post created; roster it from the Roster. <a href="/admin/roster">Open the Roster</a></p>
      : <p role="status">Waiting for approval. Another administrator must approve this post before it can be rostered.</p>}
    <div className="place-service-actions"><button type="button" onClick={() => onClose(true)}>Done</button></div>
  </section>;

  return <form className="place-service-editor" aria-label="Add static post" onSubmit={submit}>
    <h3>Add static post</h3>
    <p>A static post creates a rosterable work unit for guarding this site or area.</p>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    {workspace.agreements.length > 1 && <label>Agreement<select value={agreementId} onChange={event => setAgreementId(event.target.value)}>
      {workspace.agreements.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    <label>Site or area<select value={anchorKey} onChange={event => setAnchorKey(event.target.value)}>
      {workspace.anchors.map(item => <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
        {item.kind === 'site' ? 'Site' : 'Area'} · {item.name}</option>)}
    </select></label>
    <label>Post name<input required maxLength={200} value={postName} onChange={event => setPostName(event.target.value)} /></label>
    <label>Operating branch<select value={branchId} onChange={event => setBranchId(event.target.value)}>
      {workspace.operating_branches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <fieldset>
      <legend>Required skills (optional)</legend>
      {skillError ? <p role="alert" className="place-service-error">{skillError}</p>
        : skills === null ? <p role="status">Loading skills…</p>
          : !skills.length ? <p>This branch has no active skills. Officers will not be filtered by skill.</p>
            : <div className="place-service-choices">{skills.map(skill => <label key={skill.id} className="place-service-choice">
              <input type="checkbox" checked={skillIds.includes(skill.id)} onChange={() => setSkillIds(ids =>
                ids.includes(skill.id) ? ids.filter(id => id !== skill.id) : [...ids, skill.id])} />{skill.skill_name}</label>)}</div>}
    </fieldset>
    <label>Reason for change<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
    <div className="place-service-actions">
      <button type="submit" className="is-primary" disabled={busy || !postName.trim() || !reason.trim() || !anchorKey}>
        {busy ? 'Creating…' : 'Create static post'}</button>
      <button type="button" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
    </div>
  </form>;
}

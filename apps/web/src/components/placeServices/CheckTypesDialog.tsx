import { useState, type FormEvent } from 'react';
import { manageCheckType, type PlaceServicesWorkspace } from '../../lib/placeServices';

type CheckType = PlaceServicesWorkspace['check_types'][number];
type Mutation = Parameters<typeof manageCheckType>[0];

export function CheckTypesDialog({ workspace, onClose }: { workspace: PlaceServicesWorkspace; onClose: (changed: boolean) => void }) {
  const organizationId = workspace.agreements[0]?.provider_organization_id ?? '';
  const [types, setTypes] = useState<CheckType[]>(workspace.check_types);
  const [inactive, setInactive] = useState<CheckType[]>(workspace.inactive_check_types ?? []);
  const [changed, setChanged] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: '', needsPhoto: false, needsNote: false });
  const [attempt, setAttempt] = useState<{ payload: string; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mutate(input: Omit<Mutation, 'requestId' | 'organizationId'>) {
    const payload = JSON.stringify(input);
    const requestId = attempt?.payload === payload ? attempt.requestId : crypto.randomUUID();
    setAttempt({ payload, requestId });
    setBusy(true);
    setError(null);
    try {
      const saved = await manageCheckType({ ...input, organizationId, requestId });
      setChanged(true);
      const savedType: CheckType = { id: saved.check_type_id, check_key: saved.check_key, label: saved.label,
        needs_photo: saved.needs_photo, needs_note: saved.needs_note, is_global: false };
      setTypes(current => {
        const rest = current.filter(item => item.id !== saved.check_type_id);
        return saved.active ? [...rest, savedType] : rest;
      });
      setInactive(current => {
        const rest = current.filter(item => item.id !== saved.check_type_id);
        return saved.active ? rest : [...rest, savedType];
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The check type could not be saved');
      return false;
    } finally { setBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.label.trim() || busy) return;
    if (await mutate({ action: 'create', checkTypeId: null, label: draft.label.trim(), needsPhoto: draft.needsPhoto, needsNote: draft.needsNote })) {
      setDraft({ label: '', needsPhoto: false, needsNote: false });
    }
  }

  async function rename(item: CheckType) {
    if (!renaming?.label.trim() || busy) return;
    if (await mutate({ action: 'update', checkTypeId: item.id, label: renaming.label.trim(), needsPhoto: item.needs_photo, needsNote: item.needs_note })) {
      setRenaming(null);
    }
  }

  const ordered = [...types].sort((a, b) => Number(b.is_global) - Number(a.is_global) || a.label.localeCompare(b.label));
  return <section className="place-service-editor" aria-label="Check types">
    <h3>Check types</h3>
    <p>Checks officers can be asked to complete at a stop. Default checks are shared and cannot be changed here.</p>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    <ul className="place-check-types" aria-label="Active check types">
      {ordered.map(item => <li key={item.id}>
        {renaming?.id === item.id
          ? <span className="place-service-choices">
            <label>New name for {item.label}<input value={renaming.label} maxLength={80}
              onChange={event => setRenaming({ id: item.id, label: event.target.value })} /></label>
            <button type="button" onClick={() => void rename(item)} disabled={busy || !renaming.label.trim()}>Save name</button>
            <button type="button" onClick={() => setRenaming(null)} disabled={busy}>Cancel</button>
          </span>
          : <span>{item.label}</span>}
        <span className="place-check-type-needs">
          {item.needs_photo && 'Photo'}{item.needs_photo && item.needs_note && ' · '}{item.needs_note && 'Note'}
        </span>
        {item.is_global ? <span className="place-check-type-default">Default</span>
          : renaming?.id !== item.id && <span className="place-service-actions">
            <button type="button" disabled={busy} onClick={() => setRenaming({ id: item.id, label: item.label })}>Rename</button>
            {confirmingDeactivate === item.id
              ? <button type="button" disabled={busy} onClick={() => void mutate({ action: 'deactivate', checkTypeId: item.id,
                label: null, needsPhoto: null, needsNote: null }).then(() => setConfirmingDeactivate(null))}>Confirm deactivate</button>
              : <button type="button" disabled={busy} onClick={() => setConfirmingDeactivate(item.id)}>Deactivate</button>}
          </span>}
      </li>)}
    </ul>
    {inactive.length > 0 && <>
      <h4>Deactivated</h4>
      <ul className="place-check-types" aria-label="Deactivated check types">
        {[...inactive].sort((a, b) => a.label.localeCompare(b.label)).map(item => <li key={item.id}>
          <span>{item.label}</span>
          <span className="place-service-actions">
            <button type="button" disabled={busy} aria-label={`Reactivate ${item.label}`}
              onClick={() => void mutate({ action: 'reactivate', checkTypeId: item.id, label: null, needsPhoto: null, needsNote: null })}>Reactivate</button>
          </span>
        </li>)}
      </ul>
    </>}
    <form onSubmit={add} className="place-service-choices" aria-label="Add check type">
      <label>New check type<input value={draft.label} maxLength={80} onChange={event => setDraft({ ...draft, label: event.target.value })} /></label>
      <label className="place-service-choice"><input type="checkbox" checked={draft.needsPhoto}
        onChange={event => setDraft({ ...draft, needsPhoto: event.target.checked })} />Needs photo</label>
      <label className="place-service-choice"><input type="checkbox" checked={draft.needsNote}
        onChange={event => setDraft({ ...draft, needsNote: event.target.checked })} />Needs note</label>
      <button type="submit" disabled={busy || !draft.label.trim() || !organizationId}>Add check type</button>
    </form>
    <div className="place-service-actions"><button type="button" onClick={() => onClose(changed)} disabled={busy}>Done</button></div>
  </section>;
}

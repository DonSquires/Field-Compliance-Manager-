import { useState } from 'react';
import { setOperatingSetting, type PlaceServicesWorkspace } from '../../lib/placeServices';

type Setting = 'place_changes_need_second_approver' | 'branches_may_set_up_static_posts';

const explanations: Record<Setting, { label: string; help: string }> = {
  place_changes_need_second_approver: {
    label: 'Changes to place services need a second administrator',
    help: 'Schedule and static-post changes wait until a different administrator approves them.',
  },
  branches_may_set_up_static_posts: {
    label: 'Branches may set up static posts',
    help: "Administrators of this organisation's branches may create static posts operated by their branch. They currently need a head-office administrator to open this screen for them.",
  },
};

export function PlaceSettingsPanel({ workspace, onClose }: { workspace: PlaceServicesWorkspace; onClose: (changed: boolean) => void }) {
  const organizationId = workspace.agreements[0]?.provider_organization_id ?? '';
  const [saved, setSaved] = useState(workspace.settings);
  const [draft, setDraft] = useState(workspace.settings);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One request ID per setting and value, kept until it saves, so a retry after a lost response replays.
  const [requestIds, setRequestIds] = useState<Record<string, string>>({});

  const settingKeys = Object.keys(explanations) as Setting[];
  const dirty = Boolean(saved && draft && settingKeys.some(setting => saved[setting] !== draft[setting]));

  function edit(setting: Setting, value: boolean) {
    setDraft(current => current && { ...current, [setting]: value });
    setNotice(null);
  }

  async function save() {
    if (busy || !saved || !draft || !dirty) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const ids = { ...requestIds };
    for (const setting of settingKeys) {
      if (saved[setting] === draft[setting]) continue;
      const key = `${setting}:${draft[setting]}`;
      ids[key] ??= crypto.randomUUID();
      setRequestIds(ids);
      try {
        const result = await setOperatingSetting(organizationId, setting, draft[setting], ids[key]);
        setSaved(current => current && { ...current, [setting]: result.to });
        setChanged(true);
        delete ids[key];
        setRequestIds({ ...ids });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The settings could not be saved');
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    setNotice('Settings saved.');
  }

  if (!saved || !draft) return <section className="place-service-editor" aria-label="Place settings">
    <h3>Place settings</h3><p>Settings are not available to you for this organisation.</p>
    <div className="place-service-actions"><button type="button" onClick={() => onClose(false)}>Done</button></div>
  </section>;

  return <section className="place-service-editor" aria-label="Place settings">
    <h3>Place settings</h3>
    {error && <p role="alert" className="place-service-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {settingKeys.map(setting => <div key={setting}>
      <label className="place-service-choice"><input type="checkbox" checked={draft[setting]} disabled={busy}
        onChange={event => edit(setting, event.target.checked)} />{explanations[setting].label}</label>
      <p>{explanations[setting].help}</p>
    </div>)}
    {draft.place_changes_need_second_approver && !draft.other_approver_available && <div role="alert" className="place-service-pending">
      <span>No other administrator can approve changes. Turn this off, or add an approver.</span>
      <span className="place-service-actions"><button type="button" disabled={busy}
        onClick={() => edit('place_changes_need_second_approver', false)}>Turn off second approval</button></span>
    </div>}
    <div className="place-service-actions">
      <button type="button" onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save settings'}</button>
      {dirty
        ? <button type="button" onClick={() => { setDraft(saved); setError(null); }} disabled={busy}>Discard changes</button>
        : <button type="button" onClick={() => onClose(changed)} disabled={busy}>Done</button>}
    </div>
  </section>;
}

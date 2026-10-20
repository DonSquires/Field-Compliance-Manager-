import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './RecordFollowUp.css';

export type RecordUpdateKind = 'note' | 'follow_up_requested' | 'follow_up_resolved' | 'hs_concern';

interface RecordUpdate {
  id: string;
  entry_kind: RecordUpdateKind;
  body: string;
  created_at: string;
  created_by_name: string | null;
}

export const RECORD_UPDATE_LABELS: Record<RecordUpdateKind, string> = {
  note: 'Note',
  follow_up_requested: 'Follow-up needed',
  follow_up_resolved: 'Follow-up done',
  hs_concern: 'H&S concern',
};

/**
 * Append-only updates on an observation or patrol visit. The original record
 * is never edited; each entry is attributed, timestamped and audit-logged.
 */
export const RecordUpdatesPanel: React.FC<{
  recordKind: 'observation' | 'location_event';
  recordId: string;
  onChanged?: () => void;
}> = ({ recordKind, recordId, onChanged }) => {
  const [updates, setUpdates] = useState<RecordUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entryKind, setEntryKind] = useState<RecordUpdateKind>('note');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  // ATLAS CALLS: list_record_updates
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: loadError } = await supabase.rpc('list_record_updates', { p_record_kind: recordKind, p_record_id: recordId });
    if (loadError) setError(loadError.message);
    else setUpdates(Array.isArray(data) ? data as RecordUpdate[] : []);
    setLoading(false);
  }, [recordKind, recordId]);

  useEffect(() => { void load(); }, [load]);

  // ATLAS CALLS: add_record_update
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    const { error: saveError } = await supabase.rpc('add_record_update', {
      p_record_kind: recordKind, p_record_id: recordId, p_entry_kind: entryKind, p_body: body.trim(),
    });
    setBusy(false);
    if (saveError) { setError(saveError.message); return; }
    setBody('');
    setEntryKind('note');
    await load();
    onChanged?.();
  };

  return (
    <section className="record-updates" aria-label="Updates and follow-up">
      <h4>Updates and follow-up</h4>
      <p className="subtitle">The original record stays unchanged. Updates are added beneath it with your name and the time.</p>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading ? <p role="status">Loading updates…</p> : updates.length === 0 ? <p>No updates yet.</p> : (
        <ol className="record-updates__list">
          {updates.map((update) => (
            <li key={update.id}>
              <span className={`badge ${update.entry_kind === 'hs_concern' ? 'badge-danger' : update.entry_kind === 'follow_up_requested' ? 'badge-warning' : update.entry_kind === 'follow_up_resolved' ? 'badge-success' : 'badge-info'}`}>{RECORD_UPDATE_LABELS[update.entry_kind]}</span>
              {' '}<small>{new Date(update.created_at).toLocaleString('en-NZ')} · {update.created_by_name ?? 'Staff member'}</small>
              <p>{update.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={(event) => void save(event)} className="record-updates__form">
        <label>Type
          <select value={entryKind} onChange={(event) => setEntryKind(event.target.value as RecordUpdateKind)}>
            {(Object.keys(RECORD_UPDATE_LABELS) as RecordUpdateKind[]).map((kind) => <option key={kind} value={kind}>{RECORD_UPDATE_LABELS[kind]}</option>)}
          </select>
        </label>
        <label>Update
          <textarea required maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="What happened next, what needs doing, or what was found" />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>{busy ? 'Saving…' : 'Add update'}</button>
      </form>
    </section>
  );
};

export default RecordUpdatesPanel;

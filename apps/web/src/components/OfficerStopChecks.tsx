/**
 * OfficerStopChecks — the checks the place asks for at this stop, each recorded through record_patrol_stop_check.
 * A failed save keeps its exact request (ID, GPS, photo path) so a retry cannot change what was captured.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { attachOfficerPhoto } from '../lib/officerRecordPhotos';
import { plainWords } from '../lib/rosterWords';

export interface StopCheck {
  check_key: string;
  label: string;
  needs_photo: boolean;
  needs_note: boolean;
  outcome: 'done' | 'could_not_complete' | null;
  notes: string | null;
  performed_at: string | null;
}

type Outcome = 'done' | 'could_not_complete';
interface Draft { outcome: Outcome; notes: string; photo: File | null }
interface Attempt { draftKey: string; args: Record<string, unknown> }

export const checksOutstanding = (checks: StopCheck[] | undefined) => !checks || checks.some(check => !check.outcome);
export const validStopChecks = (value: unknown): value is StopCheck[] => Array.isArray(value) && value.every((check: unknown) =>
  check !== null && typeof check === 'object'
  && 'check_key' in check && typeof check.check_key === 'string' && check.check_key.length > 0
  && 'label' in check && typeof check.label === 'string'
  && 'needs_photo' in check && typeof check.needs_photo === 'boolean'
  && 'needs_note' in check && typeof check.needs_note === 'boolean'
  && 'outcome' in check && (check.outcome === null || check.outcome === 'done' || check.outcome === 'could_not_complete')
  && 'notes' in check && (check.notes === null || typeof check.notes === 'string')
  && 'performed_at' in check && (check.performed_at === null || typeof check.performed_at === 'string'));

async function currentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!navigator.geolocation) return null;
  return new Promise(resolve => navigator.geolocation.getCurrentPosition(
    ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
    () => resolve(null),
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 10_000 },
  ));
}

async function uploadStopPhoto(stopId: string, file: File): Promise<string> {
  const context = await supabase.rpc('officer_photo_target_context', { p_record_kind: 'patrol_stop', p_record_id: stopId });
  const organizationId = (context.data as Array<{ organization_id: string }> | null)?.[0]?.organization_id;
  if (context.error || !organizationId) throw new Error('Photo access could not be confirmed. The check has not been saved.');
  const receipt = await attachOfficerPhoto({ kind: 'patrol_stop', id: stopId, organizationId }, file, new Date().toISOString());
  return receipt.storage_path;
}

const draftKeyOf = (draft: Draft) => JSON.stringify([draft.outcome, draft.notes.trim(), draft.photo?.name ?? null, draft.photo?.size ?? null, draft.photo?.lastModified ?? null]);

export function OfficerStopChecks({ stopId, checks, onRecorded, onDirtyChange }: {
  stopId: string;
  checks: StopCheck[];
  onRecorded: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, Attempt>>({});

  useEffect(() => {
    onDirtyChange?.(Object.keys(drafts).length > 0 || saving !== null);
    return () => onDirtyChange?.(false);
  }, [drafts, saving, onDirtyChange]);

  if (!checks.length) return null;

  const edit = (key: string, patch: Partial<Draft>) => setDrafts(current => {
    const base = current[key] ?? { outcome: 'done' as Outcome, notes: '', photo: null };
    return { ...current, [key]: { ...base, ...patch } };
  });

  const save = async (check: StopCheck) => {
    const draft = drafts[check.check_key];
    if (!draft) return;
    setSaving(check.check_key);
    setErrors(current => { const next = { ...current }; delete next[check.check_key]; return next; });
    try {
      const draftKey = draftKeyOf(draft);
      let attempt = attempts.current[check.check_key];
      if (!attempt || attempt.draftKey !== draftKey) {
        const photoPath = draft.photo ? await uploadStopPhoto(stopId, draft.photo) : null;
        const position = await currentPosition();
        attempt = {
          draftKey,
          args: {
            p_request_id: crypto.randomUUID(), p_stop_id: stopId, p_check_key: check.check_key,
            p_outcome: draft.outcome, p_notes: draft.notes.trim() || null, p_photo_path: photoPath,
            p_gps_lat: position?.latitude ?? null, p_gps_lng: position?.longitude ?? null,
            p_gps_accuracy_metres: position?.accuracy ?? null,
          },
        };
        attempts.current[check.check_key] = attempt;
      }
      // ATLAS WRITES: record_patrol_stop_check
      const { error } = await supabase.rpc('record_patrol_stop_check', attempt.args);
      if (error) throw new Error(error.message);
      delete attempts.current[check.check_key];
      setDrafts(current => { const next = { ...current }; delete next[check.check_key]; return next; });
      onRecorded();
    } catch (cause) {
      setErrors(current => ({ ...current, [check.check_key]: cause instanceof Error ? cause.message : 'The check could not be saved. Try again.' }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <fieldset className="patrol-stop-checks">
      <legend>Checks at this place</legend>
      <ul>
        {checks.map(check => {
          const draft = drafts[check.check_key];
          const label = plainWords(check.label);
          if (check.outcome) {
            return (
              <li key={check.check_key} className="patrol-stop-check is-recorded">
                {check.outcome === 'done' ? <CheckCircle2 size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />}
                <span><strong>{label}</strong> · {check.outcome === 'done' ? 'Done' : "Couldn't complete"}{check.notes ? ` — ${check.notes}` : ''}</span>
              </li>
            );
          }
          const noteRequired = draft?.outcome === 'could_not_complete' || (draft?.outcome === 'done' && check.needs_note);
          const photoMissing = draft?.outcome === 'done' && check.needs_photo && !draft.photo;
          const ready = Boolean(draft) && (!noteRequired || Boolean(draft?.notes.trim())) && !photoMissing;
          const busy = saving === check.check_key;
          return (
            <li key={check.check_key} className="patrol-stop-check">
              <span><strong>{label}</strong>{check.needs_photo ? ' · photo needed' : ''}{check.needs_note ? ' · note needed' : ''}</span>
              <div className="patrol-stop-check-choices" role="group" aria-label={`Outcome for ${label}`}>
                <button type="button" className={`btn${draft?.outcome === 'done' ? ' btn-primary' : ''}`} aria-pressed={draft?.outcome === 'done'}
                  aria-label={`Done ${label}`} disabled={busy} onClick={() => edit(check.check_key, { outcome: 'done' })}>Done</button>
                <button type="button" className={`btn${draft?.outcome === 'could_not_complete' ? ' btn-primary' : ''}`} aria-pressed={draft?.outcome === 'could_not_complete'}
                  aria-label={`Couldn't complete ${label}`} disabled={busy} onClick={() => edit(check.check_key, { outcome: 'could_not_complete' })}>Couldn&apos;t complete</button>
              </div>
              {draft && (noteRequired || draft.outcome === 'done') && (
                <label>
                  <span>{draft.outcome === 'could_not_complete' ? 'Why it could not be completed' : check.needs_note ? 'Note' : 'Note (optional)'}</span>
                  <textarea rows={2} value={draft.notes} required={noteRequired} disabled={busy} onChange={event => edit(check.check_key, { notes: event.target.value })} />
                </label>
              )}
              {draft?.outcome === 'done' && check.needs_photo && (
                <label>
                  <span>Photo</span>
                  <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={event => edit(check.check_key, { photo: event.target.files?.[0] ?? null })} />
                </label>
              )}
              {errors[check.check_key] && <p role="alert" className="patrol-stop-check-error">{errors[check.check_key]}</p>}
              {draft && (
                <button type="button" className="btn btn-primary" aria-label={`Save ${label}`} disabled={!ready || busy} onClick={() => void save(check)}>
                  {busy ? 'Saving…' : 'Save check'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

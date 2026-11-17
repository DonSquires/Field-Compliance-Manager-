import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import { userFacingError } from '../lib/userFacingError';

export type StopCheck = {
  check_key: string;
  label: string;
  needs_photo: boolean;
  needs_note: boolean;
  outcome: 'done' | 'could_not_complete' | null;
  notes: string | null;
};
type Outcome = 'done' | 'could_not_complete';
type Draft = { outcome: Outcome; notes: string };
type StoredAttempt = { draftKey: string; args: Record<string, unknown> };

export const checksOutstanding = (checks: StopCheck[] | undefined) => (checks ?? []).some((check) => !check.outcome);

// A failed save is kept on the device so a retry, even after a restart, resends the exact same request.
const attemptKey = (stopId: string, checkKey: string) => `fcm:patrol-stop-check:${stopId}:${checkKey}`;

export function OfficerStopChecks({ stopId, checks, onRecorded }: { stopId: string; checks: StopCheck[]; onRecorded: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void Promise.all(checks.filter((check) => !check.outcome).map(async (check) => {
      const raw = await AsyncStorage.getItem(attemptKey(stopId, check.check_key));
      if (!raw) return null;
      const stored = JSON.parse(raw) as StoredAttempt;
      return [check.check_key, { outcome: stored.args.p_outcome as Outcome, notes: (stored.args.p_notes as string | null) ?? '' }] as const;
    })).then((restored) => {
      if (!active) return;
      const entries = restored.filter((entry): entry is readonly [string, Draft] => entry !== null);
      if (entries.length) setDrafts((current) => ({ ...Object.fromEntries(entries), ...current }));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [stopId, checks]);

  if (!checks.length) return null;

  const save = async (check: StopCheck) => {
    const draft = drafts[check.check_key];
    if (!draft || !supabase) return;
    setBusy(check.check_key);
    setErrors((current) => { const next = { ...current }; delete next[check.check_key]; return next; });
    const key = attemptKey(stopId, check.check_key);
    try {
      const draftKey = JSON.stringify([draft.outcome, draft.notes.trim()]);
      const raw = await AsyncStorage.getItem(key);
      const stored = raw ? JSON.parse(raw) as StoredAttempt : null;
      let attempt: StoredAttempt;
      if (stored?.draftKey === draftKey) attempt = stored;
      else {
        let coordinates: { lat: number; lng: number } | null = null;
        try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
        attempt = {
          draftKey,
          args: {
            p_request_id: crypto.randomUUID(),
            p_stop_id: stopId, p_check_key: check.check_key, p_outcome: draft.outcome, p_notes: draft.notes.trim() || null,
            p_photo_path: null, p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null, p_gps_accuracy_metres: null,
          },
        };
        await AsyncStorage.setItem(key, JSON.stringify(attempt));
      }
      const { error } = await supabase.rpc('record_patrol_stop_check', attempt.args);
      if (error) throw error;
      await AsyncStorage.removeItem(key);
      setDrafts((current) => { const next = { ...current }; delete next[check.check_key]; return next; });
      onRecorded();
    } catch (cause) {
      setErrors((current) => ({ ...current, [check.check_key]: userFacingError(cause, 'The check was not saved. Try again; the same record will be sent.') }));
    } finally { setBusy(null); }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.heading}>Checks at this place</Text>
      {checks.map((check) => {
        if (check.outcome) {
          return <Text key={check.check_key} style={styles.recorded}>{check.label} · {check.outcome === 'done' ? 'Done' : "Couldn't complete"}{check.notes ? ` — ${check.notes}` : ''}</Text>;
        }
        const draft = drafts[check.check_key];
        const noteRequired = draft?.outcome === 'could_not_complete' || (draft?.outcome === 'done' && check.needs_note);
        // Photo capture for checks is on the web officer screen; the mobile lane cannot attach one yet.
        const photoBlocked = draft?.outcome === 'done' && check.needs_photo;
        const ready = Boolean(draft) && (!noteRequired || Boolean(draft?.notes.trim())) && !photoBlocked;
        const saving = busy === check.check_key;
        return (
          <View key={check.check_key} style={styles.check}>
            <Text style={styles.label}>{check.label}{check.needs_photo ? ' · photo needed' : ''}{check.needs_note ? ' · note needed' : ''}</Text>
            <View style={styles.choices}>
              {(['done', 'could_not_complete'] as const).map((outcome) => (
                <Pressable key={outcome} accessibilityRole="button" accessibilityLabel={`${check.label}: ${outcome === 'done' ? 'Done' : "Couldn't complete"}`} accessibilityState={{ selected: draft?.outcome === outcome, disabled: saving }} disabled={saving}
                  onPress={() => setDrafts((current) => ({ ...current, [check.check_key]: { outcome, notes: current[check.check_key]?.notes ?? '' } }))}
                  style={[styles.choice, draft?.outcome === outcome && styles.choiceOn]}>
                  <Text style={[styles.choiceText, draft?.outcome === outcome && styles.choiceTextOn]}>{outcome === 'done' ? 'Done' : "Couldn't complete"}</Text>
                </Pressable>
              ))}
            </View>
            {draft && (
              <TextInput value={draft.notes} editable={!saving} multiline style={styles.input} placeholderTextColor="#718197"
                placeholder={draft.outcome === 'could_not_complete' ? 'Why it could not be completed' : check.needs_note ? 'Note' : 'Note (optional)'}
                accessibilityLabel={draft.outcome === 'could_not_complete' ? 'Why it could not be completed' : 'Note'}
                onChangeText={(value) => setDrafts((current) => ({ ...current, [check.check_key]: { ...draft, notes: value } }))} />
            )}
            {photoBlocked && <Text style={styles.error}>This check needs a photo. Record it on the web officer screen, or choose Couldn&apos;t complete.</Text>}
            {errors[check.check_key] && <Text style={styles.error}>{errors[check.check_key]}</Text>}
            {draft && (
              <Pressable accessibilityRole="button" accessibilityLabel={`Save ${check.label}`} disabled={!ready || saving} onPress={() => void save(check)} style={[styles.save, (!ready || saving) && styles.disabled]}>
                {saving ? <ActivityIndicator color="#04211e" /> : <Text style={styles.saveText}>Save check</Text>}
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8, borderWidth: 1, borderColor: '#30485b', borderRadius: 6, padding: 9 },
  heading: { color: '#a7b7c1', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  recorded: { color: '#a7b7c1', fontSize: 12 },
  check: { gap: 6 },
  label: { color: '#dce8eb', fontSize: 13, fontWeight: '700' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5 },
  choiceOn: { backgroundColor: '#7dd3c7', borderColor: '#7dd3c7' },
  choiceText: { color: '#dce8eb', fontSize: 13, fontWeight: '700' },
  choiceTextOn: { color: '#04211e' },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' },
  error: { color: '#f3a0a8', fontSize: 12 },
  save: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' },
  saveText: { color: '#04211e', fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});

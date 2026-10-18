import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';

type Place = { kind: 'site' | 'zone'; id: string; name: string };
type Assessment = { id: string; task: string; hazards: string; controls: string[]; likelihood: number; consequence: number; decision: string; signed_at: string; review_status: string; review_outcome: string | null };

export function OfficerTaskRiskAssessments({ shiftId, places }: { shiftId: string; places: Place[] }) {
  const [items, setItems] = useState<Assessment[]>([]);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [task, setTask] = useState('');
  const [hazards, setHazards] = useState('');
  const [controls, setControls] = useState('');
  const [likelihood, setLikelihood] = useState('');
  const [consequence, setConsequence] = useState('');
  const [decision, setDecision] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(crypto.randomUUID());
  const activeShift = useRef(shiftId);
  activeShift.current = shiftId;
  const load = useCallback(async () => {
    if (!supabase) throw new Error('Connect to load task assessments.');
    // ATLAS READS: get_shift_risk_assessments
    const { data, error: failure } = await supabase.rpc('get_shift_risk_assessments', { p_shift_id: shiftId });
    if (failure || !Array.isArray(data)) throw new Error(failure?.message ?? 'Task assessments unavailable.');
    if (activeShift.current === shiftId) setItems(data as Assessment[]);
  }, [shiftId]);
  useEffect(() => {
    setItems([]); setOpen(false); setError(null); setNotice(null); setSaving(false);
    request.current = crypto.randomUUID();
    void load().catch((cause: Error) => { if (activeShift.current === shiftId) setError(cause.message); });
  }, [load, shiftId]);
  const submit = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      if (!supabase || !place || !understood || !['proceed_with_controls', 'stop_work'].includes(decision)) {
        throw new Error('Choose a place and work decision, then confirm your assessment.');
      }
      if (!/^[1-5]$/.test(likelihood) || !/^[1-5]$/.test(consequence)) throw new Error('Likelihood and consequence must each be 1-5.');
      // ATLAS WRITES: submit_dynamic_risk_assessment
      const { data, error: failure } = await supabase.rpc('submit_dynamic_risk_assessment', {
        p_shift_id: shiftId, p_place_kind: place.kind, p_place_id: place.id, p_task: task.trim(), p_hazards: hazards.trim(),
        p_controls: controls.split('\n').map((c) => c.trim()).filter(Boolean), p_likelihood: Number(likelihood),
        p_consequence: Number(consequence), p_decision: decision, p_understood: understood, p_client_request_id: request.current,
      });
      if (failure || !data?.id || !data?.signed_at) throw new Error(failure?.message ?? 'Signed assessment not confirmed.');
      if (activeShift.current !== shiftId) return;
      setOpen(false); request.current = crypto.randomUUID();
      setNotice(decision === 'stop_work'
        ? 'STOP WORK on this task. Move to safety and contact your supervisor now. Your assessment is recorded and reviewers notified.'
        : 'Signed assessment recorded. Proceed only with the recorded controls; supervisor review is pending.');
      await load();
    } catch (cause) { if (activeShift.current === shiftId) setError(cause instanceof Error ? cause.message : 'Assessment not saved.'); }
    finally { if (activeShift.current === shiftId) setSaving(false); }
  };
  const button = (label: string, onPress: () => void, selected?: boolean) => <Pressable
    accessibilityRole={selected === undefined ? 'button' : 'radio'} accessibilityState={{ disabled: saving, selected }}
    disabled={saving} style={styles.button} onPress={onPress}><Text style={styles.text}>{selected ? 'Selected: ' : ''}{label}</Text></Pressable>;
  return <View style={styles.panel}>
    <Text style={styles.heading}>Dynamic task risk assessments</Text>
    <Text style={styles.text}>Assess the task before doing it. An unsafe decision means stop this task and contact your supervisor.</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {notice && <Text accessibilityRole="alert" style={styles.text}>{notice}</Text>}
    {button('Refresh task assessments', () => { void load().catch((cause: Error) => setError(cause.message)); })}
    {button('Assess a task', () => {
      setPlace(places[0] ?? null); setTask(''); setHazards(''); setControls(''); setLikelihood(''); setConsequence('');
      setDecision(''); setUnderstood(false); setOpen(true); setNotice(null); setError(null); request.current = crypto.randomUUID();
    })}
    {open && <>
      {!places.length && <Text style={styles.error}>No place is linked to this shift. Contact your supervisor.</Text>}
      {places.map((p) => <View key={`${p.kind}:${p.id}`}>{button(p.name, () => setPlace(p), place?.id === p.id && place.kind === p.kind)}</View>)}
      <TextInput accessibilityLabel="Task to be done" placeholder="Task to be done" placeholderTextColor="#a7cce7" style={styles.input} value={task} onChangeText={setTask} maxLength={200} editable={!saving} />
      <TextInput accessibilityLabel="Hazards observed" placeholder="Hazards observed" placeholderTextColor="#a7cce7" style={styles.input} value={hazards} onChangeText={setHazards} maxLength={4000} editable={!saving} multiline />
      <TextInput accessibilityLabel="Task controls, one per line" placeholder="Task controls, one per line" placeholderTextColor="#a7cce7" style={styles.input} value={controls} onChangeText={setControls} editable={!saving} multiline />
      <TextInput accessibilityLabel="Task likelihood (1-5)" placeholder="Likelihood 1-5" placeholderTextColor="#a7cce7" style={styles.input} value={likelihood} onChangeText={setLikelihood} editable={!saving} keyboardType="number-pad" maxLength={1} />
      <TextInput accessibilityLabel="Task consequence (1-5)" placeholder="Consequence 1-5" placeholderTextColor="#a7cce7" style={styles.input} value={consequence} onChangeText={setConsequence} editable={!saving} keyboardType="number-pad" maxLength={1} />
      {button('Proceed with these controls', () => setDecision('proceed_with_controls'), decision === 'proceed_with_controls')}
      {button('Unsafe - stop work and contact supervisor', () => setDecision('stop_work'), decision === 'stop_work')}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: understood }} disabled={saving} style={styles.button} onPress={() => setUnderstood(!understood)}><Text style={styles.text}>{understood ? 'Confirmed: ' : ''}I assessed this task, understand the risks and controls, and confirm this decision.</Text></Pressable>
      {button(saving ? 'Recording...' : 'Sign and submit assessment', () => { void submit(); })}
      {button('Cancel assessment', () => setOpen(false))}
    </>}
    {!items.length && <Text style={styles.text}>No task assessments recorded on this shift.</Text>}
    {items.map((a) => <View key={a.id} style={styles.panel}>
      <Text style={styles.heading}>{a.task}</Text>
      <Text style={styles.text}>{a.decision === 'stop_work' ? 'STOP WORK - reassess before resuming this task' : 'Proceed only with the recorded controls'}</Text>
      <Text style={styles.text}>{a.hazards} | Score {a.likelihood * a.consequence}/25</Text>
      {a.controls.map((c, i) => <Text key={i} style={styles.text}>- {c}</Text>)}
      <Text style={styles.text}>Signed {new Date(a.signed_at).toLocaleString('en-NZ')} | {a.review_status === 'closed' ? 'Reviewed by supervisor' : 'Awaiting supervisor review'}</Text>
      {a.review_outcome && <Text style={styles.text}>Supervisor findings: {a.review_outcome}</Text>}
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 8, paddingVertical: 10 }, heading: { color: '#eef6f7', fontSize: 15, fontWeight: '800' },
  text: { color: '#c5dce8', fontSize: 14 }, error: { color: '#ffd19a', fontSize: 14 },
  button: { minHeight: 44, justifyContent: 'center', padding: 10, backgroundColor: '#234a52', borderRadius: 5 },
  input: { minHeight: 44, padding: 10, color: '#eef6f7', borderWidth: 1, borderColor: '#3a5364', borderRadius: 5 },
});

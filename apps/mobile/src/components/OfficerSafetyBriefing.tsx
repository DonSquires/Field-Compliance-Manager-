import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { OfficerTaskRiskAssessments } from './OfficerTaskRiskAssessments';

type Place = { kind: 'site' | 'zone'; id: string; name: string };
type Hazard = {
  id: string; title: string; risk_level: string; controls: string[]; details: string | null;
  status: string; place_name: string; source_name: string | null; source_locator: string | null; has_source_document: boolean;
};
type Briefing = {
  briefing_hash: string; item_count: number; acknowledged: boolean; is_assigned_officer: boolean;
  hazards: Hazard[]; places: Place[];
  warnings: Array<{ id: string; hazard_class: string; alert_level: string; reason: string | null }>;
};
type Props = { shiftId: string; shiftStatus: string; busy: boolean; onReadyToStart: () => Promise<void> };

export function OfficerSafetyBriefing({ shiftId, shiftStatus, busy, onReadyToStart }: Props) {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [reading, setReading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [title, setTitle] = useState('');
  const [controls, setControls] = useState('');
  const [risk, setRisk] = useState('medium');
  const ackRequest = useRef(crypto.randomUUID());
  const reportRequest = useRef(crypto.randomUUID());
  const context = `${shiftId}:${shiftStatus}`;
  const activeContext = useRef(context);
  activeContext.current = context;
  const notStarted = ['scheduled', 'published', 'accepted'].includes(shiftStatus);

  const load = useCallback(async () => {
    if (!supabase) throw new Error('The app is not connected. Safety briefing cannot be checked.');
    // ATLAS READS: get_shift_safety_briefing
    const { data, error: failure } = await supabase.rpc('get_shift_safety_briefing', { p_shift_id: shiftId, p_stop_id: null });
    if (failure) throw new Error(failure.message);
    if (!data || data.shift_id !== shiftId || data.stop_id !== null
      || !Array.isArray(data.hazards) || !Array.isArray(data.places) || !Array.isArray(data.warnings)
      || typeof data.briefing_hash !== 'string' || !data.briefing_hash
      || !Number.isInteger(data.item_count) || data.item_count !== data.hazards.length + data.warnings.length
      || typeof data.is_assigned_officer !== 'boolean' || typeof data.acknowledged !== 'boolean') {
      throw new Error('The server did not return a safety briefing. Retry before starting work.');
    }
    const next = data as Briefing;
    if (activeContext.current === context) {
      setBriefing(next); setError(null);
    }
    return next;
  }, [shiftId, context]);

  useEffect(() => {
    setBriefing(null); setReading(false); setStarting(false); setReporting(false); setError(null); setNotice(null);
    let cancelled = false;
    const refresh = async () => {
      try { await load(); }
      catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Safety updates could not be checked.');
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 120_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load]);

  const prepareStart = async () => {
    setSaving(true); setError(null);
    try {
      const next = await load();
      if (!next.is_assigned_officer) throw new Error('Only the assigned officer can confirm these risks.');
      if (next.item_count > 0 && !next.acknowledged) {
        ackRequest.current = crypto.randomUUID();
        setStarting(true); setReading(true);
      } else await onReadyToStart();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The briefing could not be checked. Shift not started.');
    } finally { setSaving(false); }
  };

  const acknowledge = async () => {
    if (!supabase || !briefing) return;
    setSaving(true); setError(null);
    try {
      // ATLAS WRITES: acknowledge_safety_briefing
      const { data, error: failure } = await supabase.rpc('acknowledge_safety_briefing', {
        p_shift_id: shiftId, p_stop_id: null, p_briefing_hash: briefing.briefing_hash, p_client_request_id: ackRequest.current,
      });
      if (failure?.hint === 'briefing_changed') {
        await load(); ackRequest.current = crypto.randomUUID();
        throw new Error('The safety briefing changed. Read the updated risks and confirm again.');
      }
      if (failure) throw new Error(failure.message);
      if (!data?.acknowledged_at || data.briefing_hash !== briefing.briefing_hash) {
        await load(); ackRequest.current = crypto.randomUUID();
        throw new Error('This version was not confirmed. Review the briefing and try again.');
      }
      setReading(false);
      if (starting) { setStarting(false); await onReadyToStart(); }
      else { setNotice('Safety briefing confirmed.'); await load(); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Safety briefing not confirmed. Retry before working.');
    } finally { setSaving(false); }
  };

  const openSource = async (hazardId: string) => {
    if (!supabase) return;
    try {
      // ATLAS CALLS: place-hazard-source
      const { data, error: failure } = await supabase.functions.invoke('place-hazard-source', { body: { hazard_id: hazardId } });
      if (failure) throw new Error(failure.message);
      if (!data?.has_document || typeof data.url !== 'string') throw new Error('The source document is not attached. Ask your supervisor for a copy.');
      await Linking.openURL(data.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The source document could not be opened.'); }
  };

  const report = async () => {
    if (!supabase || !place || !title.trim()) { setError('Choose a place and describe the hazard.'); return; }
    setSaving(true); setError(null);
    try {
      // ATLAS WRITES: report_place_hazard
      const { data, error: failure } = await supabase.rpc('report_place_hazard', {
        p_shift_id: shiftId, p_place_kind: place.kind, p_place_id: place.id, p_title: title.trim(),
        p_hazard_class: 'other', p_risk_level: risk, p_client_request_id: reportRequest.current,
        p_controls: controls.split('\n').map((line) => line.trim()).filter(Boolean),
      });
      if (failure || !data) throw new Error(failure?.message ?? 'Hazard report was not confirmed.');
      setReporting(false); setTitle(''); setControls(''); reportRequest.current = crypto.randomUUID();
      setNotice('Hazard reported. Other officers can see it as not yet reviewed; it is awaiting administrator review.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Hazard report was not saved.'); }
    finally { setSaving(false); }
  };

  if (!notStarted && shiftStatus !== 'in_progress') return null;
  const disabled = busy || saving;
  return <View style={styles.panel}>
    <Text style={styles.heading}>Site safety briefing</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {notice && <Text style={styles.text}>{notice}</Text>}
    {!briefing && !error && <Text style={styles.text}>Loading site risks...</Text>}
    {notStarted && <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => void prepareStart()}>
      <Text style={styles.buttonText}>{disabled ? 'Checking...' : 'Clock in / start shift'}</Text>
    </Pressable>}
    {shiftStatus === 'in_progress' && <Text style={styles.text}>
      {briefing ? briefing.item_count > 0 && !briefing.acknowledged ? 'Safety briefing updated - read and confirm before working.' : `${briefing.item_count} recorded safety items` : 'Safety briefing unavailable. Check risks with your supervisor before working.'}
    </Text>}
    <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => { void load().then(() => setReading(true)).catch((cause: Error) => setError(cause.message)); }}>
      <Text style={styles.buttonText}>{briefing ? 'Read site risks' : 'Retry safety briefing'}</Text>
    </Pressable>
    {reading && briefing && <View style={styles.panel}>
      {briefing.item_count === 0 && <Text style={styles.text}>No hazards recorded. Stay alert and report anything new.</Text>}
      {briefing.warnings.map((warning) => <Text key={warning.id} style={styles.error}>{warning.alert_level}: {warning.hazard_class.replaceAll('_', ' ')}{warning.reason ? ` - ${warning.reason}` : ''}</Text>)}
      {briefing.hazards.map((hazard) => <View key={hazard.id} style={styles.hazard}>
        <Text style={styles.heading}>{hazard.risk_level.toUpperCase()}: {hazard.title}</Text>
        <Text style={styles.text}>{hazard.place_name}{hazard.status === 'reported' ? ' - Reported, not yet reviewed' : ''}</Text>
        {hazard.controls.map((control, index) => <Text key={index} style={styles.text}>- {control}</Text>)}
        {hazard.details && <Text style={styles.text}>{hazard.details}</Text>}
        <Text style={styles.text}>{[hazard.source_name, hazard.source_locator].filter(Boolean).join(' - ')}</Text>
        {hazard.has_source_document && <Pressable accessibilityRole="button" style={styles.button} onPress={() => void openSource(hazard.id)}><Text style={styles.buttonText}>Open source document</Text></Pressable>}
      </View>)}
      {briefing.item_count > 0 && !briefing.acknowledged && <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => void acknowledge()}>
        <Text style={styles.buttonText}>{saving ? 'Confirming...' : starting ? "I've read these risks - start shift" : "I've read and understood these risks"}</Text>
      </Pressable>}
      <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => { setReading(false); setStarting(false); }}><Text style={styles.buttonText}>Close without confirming</Text></Pressable>
    </View>}
    {shiftStatus === 'in_progress' && briefing && <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => { setPlace(briefing.places[0] ?? null); setReporting(true); }}>
      <Text style={styles.buttonText}>Report a hazard</Text>
    </Pressable>}
    {reporting && briefing && <View style={styles.panel}>
      <Text style={styles.heading}>Report a new hazard</Text>
      {briefing.places.length === 0 && <Text style={styles.error}>No place is linked to this shift. Tell your supervisor directly.</Text>}
      {briefing.places.map((option) => <Pressable key={`${option.kind}:${option.id}`} accessibilityRole="radio" accessibilityState={{ selected: place?.id === option.id && place.kind === option.kind }} style={styles.button} onPress={() => setPlace(option)}><Text style={styles.buttonText}>{place?.id === option.id && place.kind === option.kind ? 'Selected: ' : ''}{option.name}</Text></Pressable>)}
      <TextInput accessibilityLabel="Hazard description" placeholder="What is the hazard?" placeholderTextColor="#a7cce7" style={styles.input} value={title} onChangeText={setTitle} maxLength={160} editable={!disabled} />
      <Text style={styles.text}>Risk level</Text>
      {['critical', 'high', 'medium', 'low'].map((level) => <Pressable key={level} accessibilityRole="radio" accessibilityState={{ selected: risk === level }} style={styles.button} onPress={() => setRisk(level)}><Text style={styles.buttonText}>{risk === level ? 'Selected: ' : ''}{level}</Text></Pressable>)}
      <TextInput accessibilityLabel="Actions others should take, one per line" placeholder="What should others do? One action per line." placeholderTextColor="#a7cce7" style={styles.input} value={controls} onChangeText={setControls} multiline editable={!disabled} />
      <Pressable accessibilityRole="button" disabled={disabled || !place || !title.trim()} style={styles.button} onPress={() => void report()}><Text style={styles.buttonText}>{saving ? 'Sending...' : 'Submit hazard report'}</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={disabled} style={styles.button} onPress={() => setReporting(false)}><Text style={styles.buttonText}>Cancel report</Text></Pressable>
    </View>}
    {shiftStatus === 'in_progress' && briefing && <OfficerTaskRiskAssessments shiftId={shiftId} places={briefing.places} />}
  </View>;
}

const styles = StyleSheet.create({
  panel: { gap: 9, padding: 12, borderWidth: 1, borderColor: '#3a5364', borderRadius: 8, backgroundColor: '#0b1926' },
  hazard: { gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderColor: '#3a5364' },
  heading: { color: '#eef6f7', fontSize: 15, fontWeight: '800' },
  text: { color: '#c5dce8', fontSize: 14 },
  error: { color: '#ffd19a', fontSize: 14 },
  button: { minHeight: 44, justifyContent: 'center', padding: 10, borderRadius: 5, backgroundColor: '#234a52' },
  buttonText: { color: '#eef6f7', fontSize: 14, fontWeight: '700' },
  input: { minHeight: 44, borderWidth: 1, borderColor: '#3a5364', color: '#eef6f7', padding: 10, borderRadius: 5 },
});

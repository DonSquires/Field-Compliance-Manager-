import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type Props = { shiftId: string | null };
type ReportType = 'incident' | 'maintenance' | 'health_safety';
type Severity = 'low' | 'medium' | 'high' | 'critical';

export function OfficerFieldReportPanel({ shiftId }: Props) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ReportType>('incident');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationName, setLocationName] = useState('');
  const [immediateAction, setImmediateAction] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [followUpNotes, setFollowUpNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const eventId = useRef(crypto.randomUUID());
  const capturedAt = useRef(new Date().toISOString());

  const submit = async () => {
    if (!supabase || title.trim().length < 5 || description.trim().length < 10 || (followUp && !followUpNotes.trim())) return;
    setBusy(true);
    try {
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      const { data, error } = await supabase.rpc('submit_officer_field_report', {
        p_client_event_id: eventId.current,
        p_reported_at: capturedAt.current,
        p_report_type: type,
        p_severity: severity,
        p_title: title.trim(),
        p_description: description.trim(),
        p_location_name: locationName.trim() || null,
        p_address: null,
        p_gps_lat: coordinates?.lat ?? null,
        p_gps_lng: coordinates?.lng ?? null,
        p_shift_id: shiftId,
        p_immediate_action: immediateAction.trim() || null,
        p_follow_up_required: followUp,
        p_follow_up_notes: followUp ? followUpNotes.trim() : null,
      });
      const receipt = (data as Array<{ id: string }> | null)?.[0];
      if (error || !receipt) throw error ?? new Error('Report receipt was not confirmed.');
      Alert.alert('Report confirmed', `Receipt ${receipt.id.slice(0, 8)}. Your report is available for supervisor review.`);
      setTitle(''); setDescription(''); setLocationName(''); setImmediateAction(''); setFollowUp(false); setFollowUpNotes('');
      eventId.current = crypto.randomUUID(); capturedAt.current = new Date().toISOString(); setOpen(false);
    } catch (error) { Alert.alert('Report not confirmed', error instanceof Error ? error.message : 'Your report remains available for retry.'); } finally { setBusy(false); }
  };

  const valid = title.trim().length >= 5 && description.trim().length >= 10 && (!followUp || Boolean(followUpNotes.trim()));
  return <View style={styles.panel}><Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}><Text style={styles.triggerText}>{open ? 'Close field report' : 'Submit field report'}</Text></Pressable>{open && <View style={styles.form}><Text style={styles.title}>Field report</Text><View style={styles.options}>{(['incident', 'maintenance', 'health_safety'] as ReportType[]).map((value) => <Pressable key={value} onPress={() => setType(value)} style={[styles.option, type === value && styles.optionActive]}><Text style={styles.optionText}>{value.replaceAll('_', ' ')}</Text></Pressable>)}</View><View style={styles.options}>{(['low', 'medium', 'high', 'critical'] as Severity[]).map((value) => <Pressable key={value} onPress={() => setSeverity(value)} style={[styles.option, severity === value && styles.optionActive]}><Text style={styles.optionText}>{value}</Text></Pressable>)}</View><TextInput value={title} onChangeText={setTitle} placeholder="Short operational summary" placeholderTextColor="#718197" style={styles.input} /><TextInput value={description} onChangeText={setDescription} placeholder="What happened and current conditions" placeholderTextColor="#718197" multiline style={[styles.input, styles.textarea]} /><TextInput value={locationName} onChangeText={setLocationName} placeholder="Site or area (optional)" placeholderTextColor="#718197" style={styles.input} /><TextInput value={immediateAction} onChangeText={setImmediateAction} placeholder="Immediate action taken (optional)" placeholderTextColor="#718197" multiline style={styles.input} /><Pressable onPress={() => setFollowUp((value) => !value)} style={styles.followUp}><Text style={styles.optionText}>{followUp ? 'Follow-up required' : 'No follow-up required'}</Text></Pressable>{followUp && <TextInput value={followUpNotes} onChangeText={setFollowUpNotes} placeholder="Required follow-up" placeholderTextColor="#718197" multiline style={styles.input} />}<Pressable disabled={!valid || busy} onPress={() => void submit()} style={[styles.submit, (!valid || busy) && styles.disabled]}>{busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit report</Text>}</Pressable></View>}</View>;
}

const styles = StyleSheet.create({ panel: { gap: 8 }, trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' }, triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' }, form: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, option: { minHeight: 34, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, paddingHorizontal: 9 }, optionActive: { borderColor: '#7dd3c7', backgroundColor: '#10302e' }, optionText: { color: '#dce8eb', fontSize: 11, fontWeight: '700', textTransform: 'capitalize' }, input: { minHeight: 42, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, textarea: { minHeight: 90 }, followUp: { minHeight: 38, justifyContent: 'center' }, submit: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, submitText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 } });
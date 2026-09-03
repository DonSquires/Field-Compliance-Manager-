import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { loadOfficerTimesheetWork, submitOfficerTimesheetFromWork, type TimesheetWorkEntry } from '../lib/officerTimesheetWork';

type Timesheet = { id: string; period_start: string; period_end: string; scheduled_hours: number | null; actual_hours: number | null; overtime_hours: number; status: string; review_notes: string | null };
type Props = { officerId: string };

export function OfficerTimesheetPanel({ officerId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Timesheet[]>([]);
  const [work, setWork] = useState<TimesheetWorkEntry[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [adjustment, setAdjustment] = useState('0');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventId = useRef(crypto.randomUUID());

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError(null);
    try {
      const { data, error: queryError } = await supabase.from('timesheets').select('id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, status, review_notes').eq('staff_id', officerId).order('period_start', { ascending: false }).limit(12);
      if (queryError) throw queryError;
      setRows((data as Timesheet[]) ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Timesheets could not be loaded.'); }
    finally { setLoading(false); }
  }, [officerId]);

  useEffect(() => { if (open) void load(); }, [load, open]);

  const refreshWork = async () => {
    if (!start || !end || start > end) { setWork([]); return; }
    try { setWork(await loadOfficerTimesheetWork(start, end)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Completed work could not be loaded.'); }
  };

  const submit = async () => {
    const adjustmentHours = Number(adjustment || 0);
    if (!supabase || !start || !end || start > end || !Number.isFinite(adjustmentHours) || adjustmentHours < -744 || adjustmentHours > 744) return;
    setBusy(true); setError(null);
    try {
      const receipt = await submitOfficerTimesheetFromWork(eventId.current, start, end, adjustmentHours, notes);
      Alert.alert('Timesheet confirmed', `Receipt ${receipt.id.slice(0, 8)} · ${receipt.actual_hours} hours from ${receipt.source_count} work records.`);
      eventId.current = crypto.randomUUID(); setStart(''); setEnd(''); setAdjustment('0'); setWork([]); setNotes(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Timesheet was not confirmed.'); }
    finally { setBusy(false); }
  };

  const derivedHours = work.reduce((total, item) => total + item.calculated_minutes, 0) / 60;
  const valid = Boolean(start && end && start <= end && Number.isFinite(Number(adjustment || 0)) && Number(adjustment || 0) >= -744 && Number(adjustment || 0) <= 744);

  return <View style={styles.panel}>
    <Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}><Text style={styles.triggerText}>{open ? 'Close timesheets' : 'Timesheets'}</Text></Pressable>
    {open && <View style={styles.content}>
      <Text style={styles.title}>Submit timesheet from completed work</Text>
      <TextInput value={start} onChangeText={setStart} onBlur={() => void refreshWork()} placeholder="Period start (YYYY-MM-DD)" placeholderTextColor="#718197" style={styles.input} />
      <TextInput value={end} onChangeText={setEnd} onBlur={() => void refreshWork()} placeholder="Period end (YYYY-MM-DD)" placeholderTextColor="#718197" style={styles.input} />
      <View style={styles.workSummary}><Text style={styles.detail}>Derived work: {derivedHours.toFixed(2)} hours · {work.length} shifts/jobs</Text><Pressable onPress={() => void refreshWork()}><Text style={styles.refresh}>Refresh work</Text></Pressable></View>
      {work.map((item) => <View key={`${item.source_type}-${item.source_id}`} style={styles.item}><Text style={styles.itemTitle}>{item.label} · {item.work_status}</Text><Text style={styles.detail}>{item.calculated_minutes} minutes · {new Date(item.started_at).toLocaleString('en-NZ')} to {new Date(item.ended_at).toLocaleString('en-NZ')}</Text></View>)}
      <TextInput value={adjustment} onChangeText={setAdjustment} placeholder="Payroll adjustment hours (optional)" placeholderTextColor="#718197" keyboardType="numbers-and-punctuation" style={styles.input} />
      <Text style={styles.detail}>Adjustments are exceptions only. Completed and partial shifts/jobs remain the source of actual hours.</Text>
      <TextInput value={notes} onChangeText={setNotes} placeholder="Payroll review notes (optional)" placeholderTextColor="#718197" multiline style={styles.input} />
      <Pressable disabled={!valid || busy} onPress={() => void submit()} style={[styles.submit, (!valid || busy) && styles.disabled]}>{busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit derived hours</Text>}</Pressable>
      <View style={styles.heading}><Text style={styles.title}>Recent timesheets</Text><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>
      {error && <Text style={styles.error}>{error}</Text>}
      {loading ? <ActivityIndicator color="#7dd3c7" /> : rows.length === 0 ? <Text style={styles.empty}>No timesheets.</Text> : rows.map((item) => <View key={item.id} style={styles.item}><Text style={styles.itemTitle}>{item.period_start} to {item.period_end} · {item.status}</Text><Text style={styles.detail}>Scheduled {item.scheduled_hours ?? '-'} · Actual {item.actual_hours ?? '-'} · Overtime {item.overtime_hours}</Text>{item.review_notes && <Text style={styles.detail}>Review: {item.review_notes}</Text>}</View>)}
    </View>}
  </View>;
}

const styles = StyleSheet.create({ panel: { gap: 8 }, trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' }, triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' }, content: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, title: { color: '#eef6f7', fontSize: 16, fontWeight: '800' }, input: { minHeight: 42, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, workSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, submit: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, submitText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 6 }, item: { gap: 3, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 9 }, itemTitle: { color: '#dce8eb', fontSize: 12, fontWeight: '800', textTransform: 'capitalize' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 } });

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { loadOfficerTimesheetWork, submitOfficerTimesheetFromWork, type TimesheetWorkEntry } from '../lib/officerTimesheetWork';
import { userFacingError } from '../lib/userFacingError';

type Timesheet = { id: string; period_start: string; period_end: string; scheduled_hours: number | null; actual_hours: number | null; overtime_hours: number; status: string; review_notes: string | null };
type Props = { officerId: string; organizationId: string | null };
type WorkPreview =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; entries: TimesheetWorkEntry[] }
  | { key: string; status: 'error'; message: string };

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function OfficerTimesheetPanel({ officerId, organizationId }: Props) {
  const [open, setOpen] = useState(false);
  const [timesheetList, setTimesheetList] = useState<{ key: string; rows: Timesheet[] } | null>(null);
  const [preview, setPreview] = useState<WorkPreview | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [adjustment, setAdjustment] = useState('0');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listUnavailable, setListUnavailable] = useState(false);
  const eventId = useRef<{ id: string; fingerprint: string } | null>(null);
  const listRequest = useRef(0);
  const listKey = JSON.stringify([officerId, organizationId]);
  const listCurrent = timesheetList?.key === listKey;
  const rows = listCurrent ? timesheetList.rows : [];
  const periodValid = isIsoDate(start) && isIsoDate(end) && start <= end;
  const previewKey = JSON.stringify([officerId, organizationId, start, end]);
  const currentPreview = preview?.key === previewKey ? preview : null;
  const previewReady = Boolean(organizationId && periodValid && currentPreview?.status === 'ready');
  const workLoading = open && Boolean(organizationId) && periodValid && (!currentPreview || currentPreview.status === 'loading');
  const work = previewReady && currentPreview?.status === 'ready' ? currentPreview.entries : [];

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    const isCurrent = () => request === listRequest.current;
    if (!supabase) { setLoading(false); setListUnavailable(true); setError('Timesheets are unavailable. Try again.'); return; }
    if (!organizationId) { setLoading(false); setListUnavailable(true); setError('Organisation access could not be confirmed. Timesheets are unavailable.'); return; }
    setLoading(true); setError(null);
    try {
      const { data: staff, error: staffError } = await supabase.from('staff_profiles').select('id').eq('organization_id', organizationId).or(`user_id.eq.${officerId},id.eq.${officerId}`);
      if (!isCurrent()) return;
      if (staffError) throw staffError;
      if (!Array.isArray(staff) || staff.some((row) => !row || typeof row.id !== 'string' || row.id.length === 0)) throw new Error('Staff access could not be confirmed.');
      if (staff.length === 0) { setTimesheetList({ key: listKey, rows: [] }); setListUnavailable(true); setError('No staff profile is linked to your account. Contact payroll.'); return; }
      const staffIds: string[] = staff.map((row) => row.id);
      const { data, error: queryError } = await supabase.from('timesheets').select('id, period_start, period_end, scheduled_hours, actual_hours, overtime_hours, status, review_notes').eq('organization_id', organizationId).in('staff_id', staffIds).order('period_start', { ascending: false }).limit(12);
      if (!isCurrent()) return;
      if (queryError) throw queryError;
      if (!Array.isArray(data)) throw new Error('Timesheets could not be loaded.');
      setTimesheetList({ key: listKey, rows: data as Timesheet[] }); setListUnavailable(false);
    } catch (cause) {
      if (isCurrent()) {
        setListUnavailable(true);
        setError(userFacingError(cause, 'Timesheets could not be loaded. Try again.'));
      }
    }
    finally { if (isCurrent()) setLoading(false); }
  }, [officerId, organizationId, listKey]);

  useEffect(() => {
    if (open) void load();
    return () => { listRequest.current += 1; };
  }, [load, open]);

  useEffect(() => {
    if (!open || !organizationId || !periodValid) return;
    let active = true;
    setPreview({ key: previewKey, status: 'loading' });
    void loadOfficerTimesheetWork(start, end).then(
      (entries) => { if (active) setPreview({ key: previewKey, status: 'ready', entries }); },
      (cause) => {
        if (active) setPreview({ key: previewKey, status: 'error', message: userFacingError(cause, 'Could not load finished work. Try again.') });
      },
    );
    return () => { active = false; };
  }, [open, organizationId, periodValid, previewKey, previewRetry, start, end]);

  const submit = async () => {
    const adjustmentHours = Number(adjustment || 0);
    if (!supabase) { setError('Timesheets are unavailable. Try again.'); return; }
    if (!listCurrent || listUnavailable || loading) { setError('Refresh your timesheet list before submitting.'); return; }
    if (!periodValid || !previewReady || !Number.isFinite(adjustmentHours) || adjustmentHours < -744 || adjustmentHours > 744) {
      setError('Check the dates, work preview and adjustment before submitting.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const fingerprint = JSON.stringify([officerId, organizationId, start, end, adjustmentHours, notes.trim()]);
      if (!eventId.current || eventId.current.fingerprint !== fingerprint) {
        eventId.current = { id: crypto.randomUUID(), fingerprint };
      }
      const receipt = await submitOfficerTimesheetFromWork(eventId.current.id, start, end, adjustmentHours, notes);
      Alert.alert('Timesheet confirmed', `Receipt ${receipt.id.slice(0, 8)} · ${receipt.actual_hours} hours from ${receipt.source_count} work records.`);
      eventId.current = null; setStart(''); setEnd(''); setAdjustment('0'); setPreview(null); setNotes(''); await load();
    } catch (cause) { setError(userFacingError(cause, 'Timesheet was not confirmed. Your entries are available to retry.')); }
    finally { setBusy(false); }
  };

  const derivedHours = work.reduce((total, item) => total + item.calculated_minutes, 0) / 60;
  const valid = Boolean(periodValid && previewReady && listCurrent && !listUnavailable && !loading && Number.isFinite(Number(adjustment || 0)) && Number(adjustment || 0) >= -744 && Number(adjustment || 0) <= 744);

  return <View style={styles.panel}>
    <Pressable onPress={() => { setPreview(null); setOpen((value) => !value); }} style={styles.trigger} accessibilityRole="button"><Text style={styles.triggerText}>{open ? 'Close timesheets' : 'Timesheets'}</Text></Pressable>
    {open && <View style={styles.content}>
      <Text style={styles.title}>Submit timesheet from completed work</Text>
      <TextInput value={start} onChangeText={setStart} editable={!busy} accessibilityLabel="Period start" placeholder="Period start (YYYY-MM-DD)" placeholderTextColor="#718197" style={styles.input} />
      <TextInput value={end} onChangeText={setEnd} editable={!busy} accessibilityLabel="Period end" placeholder="Period end (YYYY-MM-DD)" placeholderTextColor="#718197" style={styles.input} />
      <View style={styles.workSummary} accessibilityLiveRegion="polite">
        <Text style={styles.detail}>{!organizationId ? 'Organisation access could not be confirmed.' : !periodValid ? 'Enter valid dates, with the end on or after the start.' : currentPreview?.status === 'error' ? currentPreview.message : workLoading || !previewReady ? 'Checking finished work…' : `Derived work: ${derivedHours.toFixed(2)} hours · ${work.length} shifts/jobs`}</Text>
        <Pressable disabled={!organizationId || !periodValid || workLoading || busy} accessibilityRole="button" accessibilityState={{ disabled: !organizationId || !periodValid || workLoading || busy }} onPress={() => setPreviewRetry((value) => value + 1)}><Text style={styles.refresh}>{currentPreview?.status === 'error' ? 'Retry work' : 'Refresh work'}</Text></Pressable>
      </View>
      {work.map((item) => <View key={`${item.source_type}-${item.source_id}`} style={styles.item}><Text style={styles.itemTitle}>{item.label} · {item.work_status}</Text><Text style={styles.detail}>{item.calculated_minutes} minutes · {new Date(item.started_at).toLocaleString('en-NZ')} to {new Date(item.ended_at).toLocaleString('en-NZ')}</Text></View>)}
      <TextInput value={adjustment} onChangeText={setAdjustment} editable={!busy} accessibilityLabel="Payroll adjustment hours" placeholder="Payroll adjustment hours (optional)" placeholderTextColor="#718197" keyboardType="numbers-and-punctuation" style={styles.input} />
      <Text style={styles.detail}>Adjustments are exceptions only. Completed and partial shifts/jobs remain the source of actual hours.</Text>
      <TextInput value={notes} onChangeText={setNotes} editable={!busy} accessibilityLabel="Payroll review notes" placeholder="Payroll review notes (optional)" placeholderTextColor="#718197" multiline style={styles.input} />
      <Pressable disabled={!valid || busy} accessibilityRole="button" accessibilityState={{ disabled: !valid || busy }} onPress={() => void submit()} style={[styles.submit, (!valid || busy) && styles.disabled]}>{busy ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Submit derived hours</Text>}</Pressable>
      <View style={styles.heading}><Text style={styles.title}>Recent timesheets</Text><Pressable disabled={loading || busy} accessibilityRole="button" accessibilityLabel="Refresh timesheet list" accessibilityState={{ disabled: loading || busy }} onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>
      {error && <Text style={styles.error}>{error}</Text>}
      {loading || (!listCurrent && !listUnavailable) ? <ActivityIndicator color="#7dd3c7" /> : listUnavailable ? <Text style={styles.empty}>Timesheets could not be loaded.</Text> : rows.length === 0 ? <Text style={styles.empty}>No timesheets.</Text> : rows.map((item) => <View key={item.id} style={styles.item}><Text style={styles.itemTitle}>{item.period_start} to {item.period_end} · {item.status}</Text><Text style={styles.detail}>Scheduled {item.scheduled_hours ?? '-'} · Actual {item.actual_hours ?? '-'} · Overtime {item.overtime_hours}</Text>{item.review_notes && <Text style={styles.detail}>Review: {item.review_notes}</Text>}</View>)}
    </View>}
  </View>;
}

const styles = StyleSheet.create({ panel: { gap: 8 }, trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' }, triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' }, content: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, title: { color: '#eef6f7', fontSize: 16, fontWeight: '800' }, input: { minHeight: 42, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, workSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, submit: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, submitText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 6 }, item: { gap: 3, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 9 }, itemTitle: { color: '#dce8eb', fontSize: 12, fontWeight: '800', textTransform: 'capitalize' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 } });

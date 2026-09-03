import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';

type DispatchJob = { id: string; job_type: string; priority: string; status: string; briefing_notes: string | null; sla_respond_by: string | null };
type Props = { shiftId: string | null };

const ACTIVE_STATUSES = ['dispatched', 'acknowledged', 'en_route', 'on_scene'];
const NEXT_STATUS: Record<string, string> = { dispatched: 'acknowledged', acknowledged: 'en_route', en_route: 'on_scene', on_scene: 'completed' };
const ACTION_LABEL: Record<string, string> = { dispatched: 'Acknowledge', acknowledged: 'Start en route', en_route: 'Mark on scene', on_scene: 'Complete job' };

export function OfficerDispatchPanel({ shiftId }: Props) {
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !shiftId) { setJobs([]); return; }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.from('dispatch_jobs').select('id, job_type, priority, status, briefing_notes, sla_respond_by').eq('shift_id', shiftId).in('status', ACTIVE_STATUSES).order('priority', { ascending: false }).order('created_at');
      if (queryError) throw queryError;
      setJobs((data as DispatchJob[]) ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dispatch jobs could not be loaded.'); } finally { setLoading(false); }
  }, [shiftId]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, [load]);

  const advance = async (job: DispatchJob) => {
    const next = NEXT_STATUS[job.status];
    const outcome = notes[job.id]?.trim() ?? '';
    if (!next || (next === 'completed' && !outcome) || !supabase) return;
    setBusy(job.id);
    setError(null);
    try {
      const { data, error: transitionError } = await supabase.rpc('advance_dispatch_job_status', { p_job_id: job.id, p_expected_status: job.status, p_next_status: next, p_outcome_notes: next === 'completed' ? outcome : null });
      if (transitionError) throw transitionError;
      const receipt = (data as Array<{ id: string; status: string }> | null)?.[0];
      if (!receipt || receipt.id !== job.id || receipt.status !== next) throw new Error('The dispatch status change was not confirmed.');
      if (next === 'completed') setJobs((current) => current.filter((item) => item.id !== job.id));
      else setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: next } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dispatch status could not be updated.'); } finally { setBusy(null); }
  };

  if (!shiftId) return null;
  return <View style={styles.panel}><View style={styles.heading}><View><Text style={styles.eyebrow}>Active shift</Text><Text style={styles.title}>Dispatch</Text></View><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{error && <Text style={styles.error}>{error}</Text>}{loading ? <ActivityIndicator color="#7dd3c7" /> : jobs.length === 0 ? <Text style={styles.empty}>No active dispatch jobs.</Text> : jobs.map((job) => <View key={job.id} style={styles.job}><View style={styles.jobTop}><Text style={styles.jobTitle}>{job.job_type.replaceAll('_', ' ')}</Text><Text style={[styles.priority, job.priority === 'urgent' || job.priority === 'high' ? styles.priorityHigh : null]}>{job.priority}</Text></View>{job.briefing_notes && <Text style={styles.detail}>{job.briefing_notes}</Text>}<Text style={styles.meta}>{job.status.replaceAll('_', ' ')}{job.sla_respond_by ? ` · respond by ${new Date(job.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : ''}</Text>{job.status === 'on_scene' && <TextInput value={notes[job.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [job.id]: value }))} placeholder="Verified outcome" placeholderTextColor="#718197" multiline style={styles.input} />}{NEXT_STATUS[job.status] && <Pressable disabled={busy === job.id || (job.status === 'on_scene' && !notes[job.id]?.trim())} onPress={() => void advance(job)} style={[styles.action, (busy === job.id || (job.status === 'on_scene' && !notes[job.id]?.trim())) && styles.disabled]}>{busy === job.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.actionText}>{ACTION_LABEL[job.status]}</Text>}</Pressable>}</View>)}</View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 8 }, job: { gap: 7, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 11 }, jobTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, jobTitle: { color: '#dce8eb', fontSize: 14, fontWeight: '800', textTransform: 'capitalize', flex: 1 }, priority: { color: '#a7cce7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, priorityHigh: { color: '#f3a0a8' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 }, meta: { color: '#78909e', fontSize: 11, textTransform: 'capitalize' }, input: { minHeight: 74, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, action: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, actionText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 },
});
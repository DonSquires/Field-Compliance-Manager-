import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type DispatchJob = { id: string; job_type: string; priority: string; status: string; briefing_notes: string | null; sla_respond_by: string | null; site: { name: string; address: string | null; hs_notes: string | null; access_instructions: string | null } | null };
type Props = { shiftId: string | null };

const ACTIVE_STATUSES = ['dispatched', 'acknowledged', 'en_route', 'on_scene'];
const NEXT_STATUS: Record<string, string> = { dispatched: 'acknowledged', acknowledged: 'en_route', en_route: 'on_scene', on_scene: 'completed' };
const ACTION_LABEL: Record<string, string> = { dispatched: 'Acknowledge', acknowledged: 'Start en route', en_route: 'Mark on scene', on_scene: 'Complete job' };
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function OfficerDispatchPanel({ shiftId }: Props) {
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<{ jobId: string; durationSeconds: number; distanceMeters: number } | null>(null);

  const recommendedJob = [...jobs].sort((left, right) => {
    const leftDeadline = left.sla_respond_by ? new Date(left.sla_respond_by).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDeadline = right.sla_respond_by ? new Date(right.sla_respond_by).getTime() : Number.MAX_SAFE_INTEGER;
    return leftDeadline - rightDeadline || (PRIORITY_WEIGHT[left.priority] ?? 9) - (PRIORITY_WEIGHT[right.priority] ?? 9);
  })[0] ?? null;

  const load = useCallback(async () => {
    if (!supabase || !shiftId) { setJobs([]); return; }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.from('dispatch_jobs').select('id, job_type, priority, status, briefing_notes, sla_respond_by, site:client_site_id(name, address, hs_notes, access_instructions)').eq('shift_id', shiftId).in('status', ACTIVE_STATUSES).order('priority', { ascending: false }).order('created_at');
      if (queryError) throw queryError;
      setJobs((data as unknown as DispatchJob[]) ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Dispatch jobs could not be loaded.'); } finally { setLoading(false); }
  }, [shiftId]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, [load]);

  useEffect(() => {
    const client = supabase;
    if (!client || !shiftId) return;
    const channel = client.channel(`officer_dispatch_route_${shiftId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'dispatch_jobs', filter: `shift_id=eq.${shiftId}` }, () => void load()).subscribe();
    return () => { void client.removeChannel(channel); };
  }, [load, shiftId]);

  useEffect(() => {
    const client = supabase;
    if (!client || !recommendedJob?.site?.address) { setRoute(null); return; }
    let cancelled = false;
    const refreshRoute = async () => {
      const position = await captureCoordinates();
      if (!position || cancelled) return;
      const { data, error: routeError } = await client.functions.invoke<{ duration_seconds: number; distance_meters: number }>('officer-route-guidance', { body: { dispatch_job_id: recommendedJob.id, origin_lat: position.lat, origin_lng: position.lng } });
      if (!routeError && data && !cancelled) setRoute({ jobId: recommendedJob.id, durationSeconds: data.duration_seconds, distanceMeters: data.distance_meters });
    };
    void refreshRoute();
    return () => { cancelled = true; };
  }, [recommendedJob?.id, recommendedJob?.site?.address]);

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

  const navigate = async (address: string) => {
    const url = `google.navigation:q=${encodeURIComponent(address)}`;
    const supported = await Linking.canOpenURL(url);
    await Linking.openURL(supported ? url : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`);
  };

  if (!shiftId) return null;
  return <View style={styles.panel}><View style={styles.heading}><View><Text style={styles.eyebrow}>Active shift</Text><Text style={styles.title}>Dispatch</Text></View><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{error && <Text style={styles.error}>{error}</Text>}{loading ? <ActivityIndicator color="#7dd3c7" /> : jobs.length === 0 ? <Text style={styles.empty}>No active dispatch jobs.</Text> : <>{recommendedJob?.site?.address && <View style={styles.recommended}><Text style={styles.eyebrow}>Recommended next stop</Text><Text style={styles.recommendedTitle}>{recommendedJob.site.name}</Text><Text style={styles.detail}>Respond by {recommendedJob.sla_respond_by ? new Date(recommendedJob.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) : 'no deadline recorded'}</Text>{route?.jobId === recommendedJob.id && <Text style={styles.route}>ETA {Math.ceil(route.durationSeconds / 60)} min · {(route.distanceMeters / 1000).toFixed(1)} km</Text>}<Pressable onPress={() => void navigate(recommendedJob.site!.address!)} style={styles.primaryNavigate}><Text style={styles.primaryNavigateText}>Start navigation</Text></Pressable></View>}{jobs.map((job) => <View key={job.id} style={styles.job}><View style={styles.jobTop}><Text style={styles.jobTitle}>{job.job_type.replaceAll('_', ' ')}</Text><Text style={[styles.priority, job.priority === 'urgent' || job.priority === 'high' ? styles.priorityHigh : null]}>{job.priority}</Text></View>{job.site && <View><Text style={styles.location}>{job.site.name}</Text>{job.site.address && <Text style={styles.detail}>{job.site.address}</Text>}{job.site.access_instructions && <Text style={styles.detail}>Access: {job.site.access_instructions}</Text>}{job.site.hs_notes && <Text style={styles.safety}>Safety: {job.site.hs_notes}</Text>}{job.site.address && <Pressable onPress={() => void navigate(job.site!.address!)} style={styles.navigate}><Text style={styles.navigateText}>Navigate</Text></Pressable>}</View>}{job.briefing_notes && <Text style={styles.detail}>{job.briefing_notes}</Text>}<Text style={styles.meta}>{job.status.replaceAll('_', ' ')}{job.sla_respond_by ? ` · respond by ${new Date(job.sla_respond_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}` : ''}</Text>{job.status === 'on_scene' && <TextInput value={notes[job.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [job.id]: value }))} placeholder="Verified outcome" placeholderTextColor="#718197" multiline style={styles.input} />}{NEXT_STATUS[job.status] && <Pressable disabled={busy === job.id || (job.status === 'on_scene' && !notes[job.id]?.trim())} onPress={() => void advance(job)} style={[styles.action, (busy === job.id || (job.status === 'on_scene' && !notes[job.id]?.trim())) && styles.disabled]}>{busy === job.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.actionText}>{ACTION_LABEL[job.status]}</Text>}</Pressable>}</View>)}</>}</View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 8 }, recommended: { gap: 6, borderWidth: 1, borderColor: '#5c91bd', borderRadius: 6, backgroundColor: '#102a3a', padding: 12 }, recommendedTitle: { color: '#eef6f7', fontSize: 15, fontWeight: '800' }, route: { color: '#7dd3c7', fontSize: 13, fontWeight: '800' }, primaryNavigate: { minHeight: 46, borderRadius: 5, backgroundColor: '#7dd3c7', alignItems: 'center', justifyContent: 'center', marginTop: 3 }, primaryNavigateText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, job: { gap: 7, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 11 }, jobTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, jobTitle: { color: '#dce8eb', fontSize: 14, fontWeight: '800', textTransform: 'capitalize', flex: 1 }, priority: { color: '#a7cce7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, priorityHigh: { color: '#f3a0a8' }, location: { color: '#eef6f7', fontSize: 13, fontWeight: '800' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 }, safety: { color: '#f3c57f', fontSize: 12, lineHeight: 18, fontWeight: '700' }, navigate: { alignSelf: 'flex-start', minHeight: 38, justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: '#5c91bd', borderRadius: 5 }, navigateText: { color: '#8ec4ff', fontSize: 12, fontWeight: '800' }, meta: { color: '#78909e', fontSize: 11, textTransform: 'capitalize' }, input: { minHeight: 74, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, action: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, actionText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 },
});
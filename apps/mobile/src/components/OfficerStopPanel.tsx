import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { supabase } from '../lib/supabase';

type ShiftStop = { id: string; module_key: string; stop_order: number; visit_number: number; status: string; sla_status: string; sla_arrive_by: string; officer_notes: string | null; client_sites: Array<{ name: string }>; location_zones: Array<{ name: string }> };
type Props = { shiftId: string | null };

export function OfficerStopPanel({ shiftId }: Props) {
  const [stops, setStops] = useState<ShiftStop[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !shiftId) { setStops([]); return; }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.from('shift_stops').select('id, module_key, stop_order, visit_number, status, sla_status, sla_arrive_by, officer_notes, client_sites(name), location_zones(name)').eq('shift_id', shiftId).in('status', ['pending', 'en_route', 'on_scene']).order('stop_order').order('visit_number');
      if (queryError) throw queryError;
      setStops((data as ShiftStop[]) ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Shift stops could not be loaded.'); } finally { setLoading(false); }
  }, [shiftId]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, [load]);

  const complete = async (stop: ShiftStop) => {
    if (!supabase) return;
    setBusy(stop.id);
    setError(null);
    try {
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      const { error: completionError } = await supabase.rpc('complete_shift_stop', { p_stop_id: stop.id, p_officer_notes: notes[stop.id]?.trim() || null, p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null });
      if (completionError) throw completionError;
      setStops((current) => current.filter((item) => item.id !== stop.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Stop completion was not confirmed.'); } finally { setBusy(null); }
  };

  if (!shiftId) return null;
  return <View style={styles.panel}><View style={styles.heading}><View><Text style={styles.eyebrow}>Active shift</Text><Text style={styles.title}>Patrol stops</Text></View><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{error && <Text style={styles.error}>{error}</Text>}{loading ? <ActivityIndicator color="#7dd3c7" /> : stops.length === 0 ? <Text style={styles.empty}>No active stops.</Text> : stops.map((stop) => <View key={stop.id} style={styles.stop}><Text style={styles.stopTitle}>{stop.stop_order + 1}. {stop.client_sites[0]?.name ?? stop.location_zones[0]?.name ?? stop.module_key.replaceAll('_', ' ')}</Text><Text style={styles.meta}>{stop.status.replaceAll('_', ' ')} · {stop.sla_status.replaceAll('_', ' ')} · arrive by {new Date(stop.sla_arrive_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</Text><TextInput value={notes[stop.id] ?? ''} onChangeText={(value) => setNotes((current) => ({ ...current, [stop.id]: value }))} placeholder="Attendance notes (optional)" placeholderTextColor="#718197" multiline style={styles.input} /><Pressable disabled={busy === stop.id} onPress={() => void complete(stop)} style={[styles.complete, busy === stop.id && styles.disabled]}>{busy === stop.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.completeText}>Complete stop</Text>}</Pressable></View>)}</View>;
}

const styles = StyleSheet.create({
  panel: { gap: 10, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 8 }, stop: { gap: 7, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 11 }, stopTitle: { color: '#dce8eb', fontSize: 14, fontWeight: '800', textTransform: 'capitalize' }, meta: { color: '#78909e', fontSize: 11, textTransform: 'capitalize' }, input: { minHeight: 56, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' }, complete: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, completeText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 },
});
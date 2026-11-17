import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { supabase } from '../lib/supabase';
import { userFacingError } from '../lib/userFacingError';
import { OfficerStopChecks, checksOutstanding, type StopCheck } from './OfficerStopChecks';

type Stop = {
  id: string; stop_order: number; visit_number: number; visits_total: number;
  status: 'pending' | 'en_route' | 'on_scene' | 'completed' | 'skipped' | 'cancelled';
  sla_status: string; sla_arrive_by: string; module_key: string;
  place: { name: string }; checks?: StopCheck[];
};
type Bundle = { shift: { id: string }; stops: Stop[] } | null;
type StopBriefing = {
  stop_id: string; briefing_hash: string; acknowledged: boolean; acknowledgement_required: boolean; is_assigned_officer: boolean;
  hazards: Array<{ id: string; title: string; risk_level: string; controls: string[] }>;
  warnings: Array<{ id: string; hazard_class: string; reason: string | null }>;
};
type Props = { shiftId: string | null };

const needsAcknowledgement = (briefing: StopBriefing) => briefing.is_assigned_officer && briefing.acknowledgement_required && !briefing.acknowledged;

export function OfficerStopPanel({ shiftId }: Props) {
  const [stops, setStops] = useState<Stop[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<{ stop: Stop; briefing: StopBriefing } | null>(null);
  const pending = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!supabase || !shiftId) { setStops([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_officer_patrol_stops', { p_shift_id: shiftId });
      if (rpcError) throw rpcError;
      setStops((data as Bundle)?.stops ?? []);
      setLoadError(null);
    } catch (cause) {
      setLoadError(userFacingError(cause, 'Patrol stops could not be loaded. Pull to refresh or try again.'));
    } finally { setLoading(false); }
  }, [shiftId]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, [load]);

  const act = async (stop: Stop, action: 'arrive' | 'depart', acknowledged = false) => {
    if (!supabase || !shiftId) return;
    setBusy(stop.id);
    setActionError(null);
    try {
      if (action === 'arrive' && !acknowledged) {
        const { data, error: briefingError } = await supabase.rpc('get_shift_safety_briefing', { p_shift_id: shiftId, p_stop_id: stop.id });
        if (briefingError || !data || (data as StopBriefing).stop_id !== stop.id) {
          throw briefingError ?? new Error('Stop briefing was not returned');
        }
        if (needsAcknowledgement(data as StopBriefing)) { setBriefing({ stop, briefing: data as StopBriefing }); return; }
      }
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      const key = `${stop.id}:${action}`;
      pending.current[key] ??= crypto.randomUUID();
      const { error: rpcError } = await supabase.rpc('manage_officer_patrol_stop', {
        p_stop_id: stop.id, p_expected_status: stop.status, p_action: action === 'arrive' ? 'arrive' : 'depart',
        p_request_id: pending.current[key], p_notes: action === 'depart' ? notes.trim() || null : null,
        p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null, p_gps_accuracy_metres: null, p_sla_delay_reason: null,
      });
      if (rpcError) throw rpcError;
      delete pending.current[key];
      if (action === 'depart') setNotes('');
      await load();
    } catch (cause) {
      setActionError(userFacingError(cause, action === 'arrive'
        ? 'Arrival was not recorded. Check the safety briefing and try again.'
        : 'Departure was not recorded. Check every check is saved and try again.'));
    } finally { setBusy(null); }
  };

  const acknowledge = async () => {
    if (!supabase || !shiftId || !briefing) return;
    setBusy(briefing.stop.id);
    try {
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      const { error: ackError } = await supabase.rpc('acknowledge_safety_briefing', {
        p_shift_id: shiftId, p_briefing_hash: briefing.briefing.briefing_hash, p_client_request_id: crypto.randomUUID(),
        p_stop_id: briefing.stop.id, p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null,
      });
      if (ackError) throw ackError;
      const stop = briefing.stop;
      setBriefing(null);
      await act(stop, 'arrive', true);
    } catch (cause) {
      setActionError(userFacingError(cause, 'The briefing changed or could not be confirmed. Reload it and read it again.'));
      setBriefing(null);
      setBusy(null);
    }
  };

  if (!shiftId) return null;
  const active = stops.filter((stop) => stop.status === 'pending' || stop.status === 'en_route' || stop.status === 'on_scene');
  const current = active.find((stop) => stop.status === 'on_scene') ?? active[0] ?? null;

  return (
    <View style={styles.panel}>
      <View style={styles.heading}>
        <View><Text style={styles.eyebrow}>Active shift</Text><Text style={styles.title}>Patrol stops</Text></View>
        <Pressable accessibilityRole="button" onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable>
      </View>
      {loadError && <Text style={styles.error}>{loadError}</Text>}
      {actionError && <Text style={styles.error}>{actionError}</Text>}
      {loading && !stops.length ? <ActivityIndicator color="#7dd3c7" /> : !loadError && active.length === 0 ? <Text style={styles.empty}>No stops left on this shift.</Text> : active.map((stop) => {
        const isCurrent = stop.id === current?.id;
        const outstanding = checksOutstanding(stop.checks);
        return (
          <View key={stop.id} style={styles.stop}>
            <Text style={styles.stopTitle}>{stop.stop_order}. {stop.place.name}{stop.visits_total > 1 ? ` · visit ${stop.visit_number} of ${stop.visits_total}` : ''}</Text>
            <Text style={styles.meta}>{stop.status === 'on_scene' ? 'On site' : 'Next'} · arrive by {new Date(stop.sla_arrive_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</Text>
            {isCurrent && briefing?.stop.id === stop.id && (
              <View style={styles.briefing}>
                <Text style={styles.briefingTitle}>Safety briefing for {stop.place.name}</Text>
                {briefing.briefing.hazards.map((hazard) => <Text key={hazard.id} style={styles.briefingItem}>{hazard.risk_level.toUpperCase()} · {hazard.title}{hazard.controls.length ? ` — ${hazard.controls.join('; ')}` : ''}</Text>)}
                {briefing.briefing.warnings.map((warning) => <Text key={warning.id} style={styles.briefingItem}>Warning · {warning.hazard_class.replaceAll('_', ' ')}{warning.reason ? ` — ${warning.reason}` : ''}</Text>)}
                <Pressable accessibilityRole="button" disabled={busy === stop.id} onPress={() => void acknowledge()} style={[styles.complete, busy === stop.id && styles.disabled]}>
                  <Text style={styles.completeText}>I have read this — record arrival</Text>
                </Pressable>
              </View>
            )}
            {isCurrent && stop.status !== 'on_scene' && briefing?.stop.id !== stop.id && (
              <Pressable accessibilityRole="button" disabled={busy === stop.id} onPress={() => void act(stop, 'arrive')} style={[styles.complete, busy === stop.id && styles.disabled]}>
                {busy === stop.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.completeText}>Arrived at {stop.place.name}</Text>}
              </Pressable>
            )}
            {isCurrent && stop.status === 'on_scene' && (
              <>
                <OfficerStopChecks stopId={stop.id} checks={stop.checks ?? []} onRecorded={() => void load()} />
                <TextInput value={notes} onChangeText={setNotes} placeholder="What you found and did here (optional)" placeholderTextColor="#718197" multiline style={styles.input} />
                {outstanding && <Text style={styles.hint}>Record every check first</Text>}
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: outstanding || busy === stop.id }} disabled={outstanding || busy === stop.id}
                  onPress={() => void act(stop, 'depart')} style={[styles.complete, (outstanding || busy === stop.id) && styles.disabled]}>
                  {busy === stop.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.completeText}>Leaving {stop.place.name}</Text>}
                </Pressable>
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' },
  refresh: { minHeight: 44, color: '#8ec4ff', fontSize: 12, fontWeight: '700', padding: 8, textAlignVertical: 'center' },
  error: { color: '#f3a0a8', fontSize: 12 },
  empty: { color: '#a7b7c1', paddingVertical: 8 },
  stop: { gap: 7, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 11 },
  stopTitle: { color: '#dce8eb', fontSize: 14, fontWeight: '800' },
  meta: { color: '#78909e', fontSize: 11 },
  hint: { color: '#fbbf24', fontSize: 12 },
  briefing: { gap: 6, borderWidth: 1, borderColor: '#fbbf24', borderRadius: 6, padding: 9 },
  briefingTitle: { color: '#fbbf24', fontSize: 13, fontWeight: '800' },
  briefingItem: { color: '#dce8eb', fontSize: 12 },
  input: { minHeight: 56, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', padding: 9, textAlignVertical: 'top' },
  complete: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' },
  completeText: { color: '#04211e', fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});

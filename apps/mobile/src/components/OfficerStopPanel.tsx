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
  place: { name: string }; checks: StopCheck[];
};
type Bundle = { shift: { id: string }; stops: Stop[] } | null;
type StopBriefing = {
  stop_id: string; briefing_hash: string; acknowledged: boolean; acknowledgement_required: boolean; is_assigned_officer: boolean;
  hazards: Array<{ id: string; title: string; risk_level: string; controls: string[] }>;
  warnings: Array<{ id: string; hazard_class: string; reason: string | null }>;
};
type PrivateBriefing = {
  shift_id: string; stop_id: string;
  officer_instructions: string | null; access_instructions: string | null; hs_notes: string | null;
  privacy: { status: 'checked' | 'partly_withheld' | 'unavailable' };
};
type Props = { shiftId: string | null };

const needsAcknowledgement = (briefing: StopBriefing) => briefing.is_assigned_officer && briefing.acknowledgement_required && !briefing.acknowledged;
const isPrivateBriefing = (value: unknown, shiftId: string, stopId: string): value is PrivateBriefing => {
  if (!value || typeof value !== 'object' || !('shift_id' in value) || value.shift_id !== shiftId
    || !('stop_id' in value) || value.stop_id !== stopId || !('privacy' in value)
    || !value.privacy || typeof value.privacy !== 'object' || !('status' in value.privacy)) return false;
  const status = value.privacy.status;
  if (status !== 'checked' && status !== 'partly_withheld' && status !== 'unavailable') return false;
  return ['officer_instructions', 'access_instructions', 'hs_notes'].every((key) =>
    key in value && (value[key as keyof typeof value] === null || typeof value[key as keyof typeof value] === 'string'))
    && (status !== 'unavailable' || ['officer_instructions', 'access_instructions', 'hs_notes']
      .every((key) => value[key as keyof typeof value] === null));
};
const isBundle = (value: unknown, shiftId: string): value is NonNullable<Bundle> => {
  if (!value || typeof value !== 'object' || !('shift' in value) || !('stops' in value)
    || !value.shift || typeof value.shift !== 'object' || !('id' in value.shift) || value.shift.id !== shiftId
    || !Array.isArray(value.stops)) return false;
  return value.stops.every((stop: unknown) => stop && typeof stop === 'object'
    && 'id' in stop && typeof stop.id === 'string' && stop.id.length > 0
    && 'stop_order' in stop && typeof stop.stop_order === 'number' && Number.isFinite(stop.stop_order)
    && 'visit_number' in stop && typeof stop.visit_number === 'number' && Number.isFinite(stop.visit_number)
    && 'visits_total' in stop && typeof stop.visits_total === 'number' && Number.isFinite(stop.visits_total)
    && 'status' in stop && ['pending', 'en_route', 'on_scene', 'completed', 'skipped', 'cancelled'].some((status) => status === stop.status)
    && 'sla_status' in stop && typeof stop.sla_status === 'string'
    && 'sla_arrive_by' in stop && typeof stop.sla_arrive_by === 'string' && Number.isFinite(Date.parse(stop.sla_arrive_by))
    && 'module_key' in stop && typeof stop.module_key === 'string'
    && 'place' in stop && stop.place && typeof stop.place === 'object'
    && 'name' in stop.place && typeof stop.place.name === 'string'
    && 'checks' in stop && Array.isArray(stop.checks)
    && stop.checks.every((check: unknown) => check && typeof check === 'object'
      && 'check_key' in check && typeof check.check_key === 'string' && check.check_key.length > 0
      && 'label' in check && typeof check.label === 'string'
      && 'needs_photo' in check && typeof check.needs_photo === 'boolean'
      && 'needs_note' in check && typeof check.needs_note === 'boolean'
      && 'outcome' in check && (check.outcome === null || check.outcome === 'done' || check.outcome === 'could_not_complete')
      && 'notes' in check && (check.notes === null || typeof check.notes === 'string')));
};

export function OfficerStopPanel({ shiftId }: Props) {
  const [stops, setStops] = useState<Stop[]>([]);
  const [notesByStop, setNotesByStop] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<{ stop: Stop; briefing: StopBriefing } | null>(null);
  const [privateBriefing, setPrivateBriefing] = useState<PrivateBriefing | null>(null);
  const [privateLoading, setPrivateLoading] = useState(false);
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [privateAttempt, setPrivateAttempt] = useState(0);
  const pending = useRef<Record<string, string>>({});
  const loadVersion = useRef(0);
  const currentShiftId = useRef(shiftId);
  currentShiftId.current = shiftId;

  const load = useCallback(async () => {
    if (currentShiftId.current !== shiftId) return;
    const version = ++loadVersion.current;
    if (!supabase || !shiftId) { setStops([]); setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_officer_patrol_stops_sanitized', { p_shift_id: shiftId });
      if (rpcError) throw rpcError;
      if (!isBundle(data, shiftId)) throw new Error('Assigned stop details could not be confirmed');
      if (version !== loadVersion.current) return;
      setStops(data.stops);
      setLoadError(null);
    } catch (cause) {
      if (version === loadVersion.current) setLoadError(userFacingError(cause, 'Patrol stops could not be loaded. Pull to refresh or try again.'));
    } finally { if (version === loadVersion.current) setLoading(false); }
  }, [shiftId]);

  useEffect(() => {
    setStops([]);
    setBusy(null);
    setBriefing(null);
    setActionError(null);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { loadVersion.current += 1; clearInterval(timer); };
  }, [load]);

  const active = stops.filter((stop) => stop.status === 'pending' || stop.status === 'en_route' || stop.status === 'on_scene');
  const current = active.find((stop) => stop.status === 'on_scene') ?? active[0] ?? null;
  const currentStopId = current?.status === 'pending' || current?.status === 'en_route' ? current.id : null;
  useEffect(() => {
    let activeRequest = true;
    setPrivateBriefing(null);
    setPrivateError(null);
    if (!supabase || !shiftId || !currentStopId) { setPrivateLoading(false); return; }
    setPrivateLoading(true);
    void supabase.functions.invoke('officer-patrol-stop-briefing', { body: { shift_id: shiftId, stop_id: currentStopId } })
      .then(({ data, error }) => {
        if (!activeRequest) return;
        if (error || !isPrivateBriefing(data, shiftId, currentStopId))
          throw error ?? new Error('Invalid private briefing response');
        setPrivateBriefing(data);
      }).catch((cause) => {
        const message = userFacingError(cause, 'The private stop briefing could not be confirmed. Retry or contact operations.');
        if (activeRequest) setPrivateError(message);
      }).finally(() => { if (activeRequest) setPrivateLoading(false); });
    return () => { activeRequest = false; };
  }, [shiftId, currentStopId, privateAttempt]);

  const act = async (stop: Stop, action: 'arrive' | 'depart', acknowledged = false) => {
    if (!supabase || !shiftId) return;
    setBusy(stop.id);
    setActionError(null);
    try {
      if (action === 'arrive' && !acknowledged) {
        const { data, error: briefingError } = await supabase.rpc('get_shift_safety_briefing', { p_shift_id: shiftId, p_stop_id: stop.id });
        if (currentShiftId.current !== shiftId) return;
        if (briefingError || !data || (data as StopBriefing).stop_id !== stop.id) {
          throw briefingError ?? new Error('Stop briefing was not returned');
        }
        if (needsAcknowledgement(data as StopBriefing)) { setBriefing({ stop, briefing: data as StopBriefing }); return; }
      }
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      if (currentShiftId.current !== shiftId) return;
      const key = `${stop.id}:${action}`;
      pending.current[key] ??= crypto.randomUUID();
      const { error: rpcError } = await supabase.rpc('manage_officer_patrol_stop', {
        p_stop_id: stop.id, p_expected_status: stop.status, p_action: action === 'arrive' ? 'arrive' : 'depart',
        p_request_id: pending.current[key], p_notes: action === 'depart' ? notesByStop[stop.id]?.trim() || null : null,
        p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null, p_gps_accuracy_metres: null, p_sla_delay_reason: null,
      });
      if (rpcError) throw rpcError;
      delete pending.current[key];
      if (currentShiftId.current !== shiftId) return;
      if (action === 'depart') setNotesByStop((current) => { const next = { ...current }; delete next[stop.id]; return next; });
      await load();
    } catch (cause) {
      const message = userFacingError(cause, action === 'arrive'
        ? 'Arrival was not recorded. Check the safety briefing and try again.'
        : 'Departure was not recorded. Check every check is saved and try again.');
      if (currentShiftId.current === shiftId) setActionError(message);
    } finally { if (currentShiftId.current === shiftId) setBusy(null); }
  };

  const acknowledge = async () => {
    if (!supabase || !shiftId || !briefing) return;
    setBusy(briefing.stop.id);
    try {
      let coordinates: { lat: number; lng: number } | null = null;
      try { coordinates = await captureCoordinates(); } catch { coordinates = null; }
      if (currentShiftId.current !== shiftId) return;
      const { error: ackError } = await supabase.rpc('acknowledge_safety_briefing', {
        p_shift_id: shiftId, p_briefing_hash: briefing.briefing.briefing_hash, p_client_request_id: crypto.randomUUID(),
        p_stop_id: briefing.stop.id, p_gps_lat: coordinates?.lat ?? null, p_gps_lng: coordinates?.lng ?? null,
      });
      if (ackError) throw ackError;
      if (currentShiftId.current !== shiftId) return;
      const stop = briefing.stop;
      setBriefing(null);
      await act(stop, 'arrive', true);
    } catch (cause) {
      const message = userFacingError(cause, 'The briefing changed or could not be confirmed. Reload it and read it again.');
      if (currentShiftId.current !== shiftId) return;
      setActionError(message);
      setBriefing(null);
      setBusy(null);
    }
  };

  if (!shiftId) return null;
  return (
    <View style={styles.panel}>
      <View style={styles.heading}>
        <View><Text style={styles.eyebrow}>Active shift</Text><Text style={styles.title}>Patrol stops</Text></View>
        <Pressable accessibilityRole="button" onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable>
      </View>
      {loadError && <Text accessibilityRole="alert" style={styles.error}>{loadError}</Text>}
      {actionError && <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text>}
      {loadError && !stops.length ? null : loading && !stops.length ? <ActivityIndicator color="#7dd3c7" /> : active.length === 0 ? <Text style={styles.empty}>No stops left on this shift.</Text> : active.map((stop) => {
        const isCurrent = stop.id === current?.id;
        const outstanding = checksOutstanding(stop.checks);
        return (
          <View key={stop.id} style={styles.stop}>
            <Text style={styles.stopTitle}>{stop.stop_order}. {stop.place.name}{stop.visits_total > 1 ? ` · visit ${stop.visit_number} of ${stop.visits_total}` : ''}</Text>
            <Text style={styles.meta}>{stop.status === 'on_scene' ? 'On site' : 'Next'} · arrive by {new Date(stop.sla_arrive_by).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}</Text>
            {isCurrent && currentStopId === stop.id && (
              <View style={styles.briefing}>
                <Text style={styles.briefingTitle}>Private site briefing</Text>
                {privateLoading && <ActivityIndicator color="#7dd3c7" />}
                {privateError && <Text accessibilityRole="alert" style={styles.error}>{privateError}</Text>}
                {privateBriefing?.stop_id === stop.id && privateBriefing.shift_id === shiftId && privateBriefing.privacy.status === 'checked' && (
                  <>
                    {privateBriefing.officer_instructions && <Text style={styles.briefingItem}>Do here: {privateBriefing.officer_instructions}</Text>}
                    {privateBriefing.access_instructions && <Text style={styles.briefingItem}>Access: {privateBriefing.access_instructions}</Text>}
                    {privateBriefing.hs_notes && <Text style={styles.briefingItem}>Safety: {privateBriefing.hs_notes}</Text>}
                    {!privateBriefing.officer_instructions && !privateBriefing.access_instructions && !privateBriefing.hs_notes
                      && <Text style={styles.briefingItem}>No briefing text supplied. This is not safety clearance.</Text>}
                  </>
                )}
                {privateBriefing && privateBriefing.privacy.status !== 'checked'
                  && <Text accessibilityRole="alert" style={styles.error}>Some or all briefing details are withheld. Contact operations before relying on this information. Recording arrival is not safety clearance.</Text>}
                {(privateError || (privateBriefing && privateBriefing.privacy.status !== 'checked')) && (
                  <Pressable accessibilityRole="button" onPress={() => setPrivateAttempt((attempt) => attempt + 1)}>
                    <Text style={styles.refresh}>Retry private briefing</Text>
                  </Pressable>
                )}
              </View>
            )}
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
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy === stop.id }} disabled={busy === stop.id}
                onPress={() => void act(stop, 'arrive')}
                style={[styles.complete, busy === stop.id && styles.disabled]}>
                {busy === stop.id ? <ActivityIndicator color="#04211e" /> : <Text style={styles.completeText}>Arrived at {stop.place.name}</Text>}
              </Pressable>
            )}
            {isCurrent && stop.status === 'on_scene' && (
              <>
                <OfficerStopChecks stopId={stop.id} checks={stop.checks ?? []} onRecorded={() => void load()} />
                <TextInput value={notesByStop[stop.id] ?? ''} editable={busy !== stop.id}
                  onChangeText={(text) => setNotesByStop((current) => ({ ...current, [stop.id]: text }))}
                  placeholder="What you found and did here (optional)" placeholderTextColor="#718197" multiline style={styles.input} />
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

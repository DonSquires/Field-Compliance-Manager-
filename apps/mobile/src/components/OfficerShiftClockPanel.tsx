import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { OfficerSafetyBriefing } from './OfficerSafetyBriefing';

type Props = { shiftId: string | null; shiftStatus: string | null; shiftServiceType: string | null; onStarted?: () => void };

type OpenBreak = { id: string; break_type: string; started_at: string };
type Entitlement = {
  worked_hours: number;
  rest_breaks_required: number;
  meal_breaks_required: number;
  rest_breaks_taken: number;
  meal_breaks_taken: number;
  compliant: boolean;
};

export function OfficerShiftClockPanel({ shiftId, shiftStatus, shiftServiceType, onStarted }: Props) {
  const [busy, setBusy] = useState(false);
  const [openBreak, setOpenBreak] = useState<OpenBreak | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const startRequestId = useRef(crypto.randomUUID());

  const refresh = useCallback(async () => {
    if (!supabase || !shiftId) return;
    const [breakResponse, entitlementResponse] = await Promise.all([
      supabase.from('shift_breaks').select('id,break_type,started_at').eq('shift_id', shiftId).is('ended_at', null).maybeSingle(),
      supabase.rpc('get_shift_break_entitlement', { p_shift_id: shiftId }),
    ]);
    setOpenBreak((breakResponse.data as OpenBreak | null) ?? null);
    const receipt = (entitlementResponse.data as Entitlement[] | null)?.[0] ?? null;
    setEntitlement(receipt);
  }, [shiftId]);

  useEffect(() => { void refresh(); }, [refresh, shiftStatus]);

  if (!shiftId || !shiftStatus) return null;

  const startShift = async () => {
    if (!supabase) return;
    setBusy(true);
    try {
      // Position is recorded as clock-in evidence; static posts keep their own stricter boundary check.
      let lat: number | null = null;
      let lng: number | null = null;
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.granted) {
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        lat = position.coords.latitude;
        lng = position.coords.longitude;
      }
      const { data, error } = await supabase.rpc('start_officer_shift', {
        p_client_request_id: startRequestId.current,
        p_shift_id: shiftId,
        p_expected_status: shiftStatus,
        p_gps_lat: lat,
        p_gps_lng: lng,
      });
      const receipt = (data as Array<{ started_at: string; created: boolean; superseded_shift_id?: string | null; superseded_service_type?: string | null }> | null)?.[0];
      if (error || !receipt) throw error ?? new Error('Clock-in was not confirmed.');
      Alert.alert(
        receipt.created ? 'Shift started' : 'Already started',
        `Clocked in at ${new Date(receipt.started_at).toLocaleTimeString('en-NZ')}.${receipt.superseded_shift_id ? ` Your earlier ${(receipt.superseded_service_type ?? 'other').replace(/_/g, ' ')} shift was ended; anything left open on it is on record.` : ''}`,
      );
      onStarted?.();
      await refresh();
    } catch (cause) {
      Alert.alert('Not clocked in', cause instanceof Error ? cause.message : 'Your shift remains available to start.');
    } finally {
      setBusy(false);
    }
  };

  const beginBreak = async (breakType: 'rest' | 'meal') => {
    if (!supabase) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('start_shift_break', {
        p_client_request_id: crypto.randomUUID(),
        p_shift_id: shiftId,
        p_break_type: breakType,
      });
      if (error) throw error;
      await refresh();
    } catch (cause) {
      Alert.alert('Break not started', cause instanceof Error ? cause.message : 'Retry when you are able.');
    } finally {
      setBusy(false);
    }
  };

  const finishBreak = async () => {
    if (!supabase || !openBreak) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('end_shift_break', { p_break_id: openBreak.id, p_notes: null });
      if (error) throw error;
      await refresh();
    } catch (cause) {
      Alert.alert('Break not ended', cause instanceof Error ? cause.message : 'Retry when you are able.');
    } finally {
      setBusy(false);
    }
  };

  const notStarted = shiftStatus === 'scheduled' || shiftStatus === 'published' || shiftStatus === 'accepted';

  return (
    <View style={styles.panel}>
      {(notStarted || shiftStatus === 'in_progress') && <OfficerSafetyBriefing key={shiftId} shiftId={shiftId} shiftStatus={shiftStatus} shiftServiceType={shiftServiceType} busy={busy} onReadyToStart={startShift} />}

      {shiftStatus === 'in_progress' && (
        <View style={styles.content}>
          <Text style={styles.title}>Breaks</Text>
          {entitlement && (
            <Text style={[styles.meta, !entitlement.compliant && styles.metaWarning]}>
              {entitlement.worked_hours}h worked · rest {entitlement.rest_breaks_taken}/{entitlement.rest_breaks_required} · meal {entitlement.meal_breaks_taken}/{entitlement.meal_breaks_required}
              {entitlement.compliant ? ' · entitlements met' : ' · entitlements outstanding'}
            </Text>
          )}
          {openBreak ? (
            <Pressable disabled={busy} onPress={() => void finishBreak()} style={[styles.endBreak, busy && styles.disabled]}>
              <Text style={styles.endBreakText}>
                End {openBreak.break_type} break · started {new Date(openBreak.started_at).toLocaleTimeString('en-NZ')}
              </Text>
            </Pressable>
          ) : (
            <View style={styles.row}>
              <Pressable disabled={busy} onPress={() => void beginBreak('rest')} style={[styles.breakButton, busy && styles.disabled]}>
                <Text style={styles.breakText}>Rest break (paid)</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => void beginBreak('meal')} style={[styles.breakButton, busy && styles.disabled]}>
                <Text style={styles.breakText}>Meal break (unpaid)</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  start: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' },
  startText: { color: '#04211e', fontSize: 14, fontWeight: '800' },
  content: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 },
  title: { color: '#eef6f7', fontSize: 15, fontWeight: '800' },
  meta: { color: '#a7cce7', fontSize: 12, fontWeight: '600' },
  metaWarning: { color: '#f0b429' },
  row: { flexDirection: 'row', gap: 8 },
  breakButton: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' },
  breakText: { color: '#a7cce7', fontSize: 12, fontWeight: '800' },
  endBreak: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#f0b429' },
  endBreakText: { color: '#221a04', fontSize: 12, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});

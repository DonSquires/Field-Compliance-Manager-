import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { captureCoordinates } from '../lib/officerScan';
import { recordMobileCheckIn, triggerMobileSos } from '../lib/officerSafety';

type Props = { officerId: string; organizationId: string | null };

export function OfficerSafetyBar({ officerId, organizationId }: Props) {
  const [pending, setPending] = useState<'checkin' | 'sos' | null>(null);
  const [status, setStatus] = useState('Safety check-in required');

  const getCoordinates = async () => {
    try { return await captureCoordinates(); } catch { return null; }
  };

  const checkIn = async () => {
    if (!organizationId) { Alert.alert('Safety unavailable', 'Your organization context is not available.'); return; }
    setPending('checkin');
    try {
      await recordMobileCheckIn({ organizationId, officerId, coordinates: await getCoordinates() });
      setStatus(`Checked in at ${new Date().toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (error) {
      Alert.alert('Check-in not confirmed', error instanceof Error ? error.message : 'Retry your check-in.');
    } finally { setPending(null); }
  };

  const confirmSos = () => {
    if (!organizationId) { Alert.alert('SOS unavailable', 'Your organization context is not available.'); return; }
    Alert.alert('Trigger SOS?', 'This creates an emergency welfare alert for supervisors.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Trigger SOS', style: 'destructive', onPress: () => void triggerSos() },
    ]);
  };

  const triggerSos = async () => {
    if (!organizationId) return;
    setPending('sos');
    try {
      await triggerMobileSos({ organizationId, officerId, coordinates: await getCoordinates() });
      setStatus('SOS confirmed. Supervisors have been alerted.');
    } catch (error) {
      Alert.alert('SOS not confirmed', error instanceof Error ? error.message : 'Retry SOS or use your emergency procedure.');
    } finally { setPending(null); }
  };

  return <View style={styles.bar}><View style={styles.status}><Text style={styles.label}>Safety</Text><Text style={styles.message}>{status}</Text></View><View style={styles.actions}><Pressable disabled={pending !== null} onPress={() => void checkIn()} style={[styles.checkIn, pending !== null && styles.disabled]}>{pending === 'checkin' ? <ActivityIndicator color="#04211e" /> : <Text style={styles.checkInText}>Check in</Text>}</Pressable><Pressable disabled={pending !== null} onPress={confirmSos} style={[styles.sos, pending !== null && styles.disabled]}>{pending === 'sos' ? <ActivityIndicator color="#fff" /> : <Text style={styles.sosText}>SOS</Text>}</Pressable></View></View>;
}

const styles = StyleSheet.create({
  bar: { gap: 10, borderWidth: 1, borderColor: '#3b5b72', borderRadius: 8, backgroundColor: '#0d1d2b', padding: 12 }, status: { gap: 2 }, label: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, message: { color: '#dce8eb', fontSize: 13, fontWeight: '600' }, actions: { flexDirection: 'row', gap: 8 }, checkIn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#7dd3c7' }, checkInText: { color: '#04211e', fontWeight: '800', fontSize: 13 }, sos: { minWidth: 68, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: '#b8303b' }, sosText: { color: '#fff', fontWeight: '900', fontSize: 13 }, disabled: { opacity: 0.5 },
});
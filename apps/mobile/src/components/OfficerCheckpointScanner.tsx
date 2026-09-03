import { useEffect, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';

type Props = { officerId: string; organizationId: string | null; shiftId: string | null };
type Checkpoint = { id: string; name: string; gps_lat: number | null; gps_lng: number | null; radius_meters: number; client_site_id: string | null; zone_id: string | null };

function distanceMetres(from: Location.LocationObject, checkpoint: Checkpoint): number | null {
  if (checkpoint.gps_lat == null || checkpoint.gps_lng == null) return null;
  const radius = 6_371_000;
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(checkpoint.gps_lat - from.coords.latitude);
  const longitudeDelta = radians(checkpoint.gps_lng - from.coords.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(from.coords.latitude)) * Math.cos(radians(checkpoint.gps_lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function OfficerCheckpointScanner({ officerId, organizationId, shiftId }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => { if (!open) setScanned(false); }, [open]);

  const recordVisit = async (rawCode: string) => {
    if (!supabase || !organizationId || !shiftId || busy || scanned) return;
    setScanned(true);
    setBusy(true);
    try {
      const [{ data: checkpoint, error: checkpointError }, location] = await Promise.all([
        supabase.from('patrol_checkpoints').select('id, name, gps_lat, gps_lng, radius_meters, client_site_id, zone_id').eq('organization_id', organizationId).eq('qr_code', rawCode).eq('active', true).maybeSingle(),
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      ]);
      if (checkpointError) throw checkpointError;
      if (!checkpoint) throw new Error('This QR code is not an active checkpoint for your organization.');
      const typedCheckpoint = checkpoint as Checkpoint;
      const distance = distanceMetres(location, typedCheckpoint);
      const accuracy = location.coords.accuracy ?? null;
      if (distance !== null && accuracy !== null && accuracy > typedCheckpoint.radius_meters) throw new Error('GPS accuracy is too poor for this checkpoint. Move to open sky and retry.');
      if (distance !== null && distance > typedCheckpoint.radius_meters) throw new Error('You are outside the checkpoint radius. Move closer and retry.');

      const { data: existingPatrol, error: patrolReadError } = await supabase.from('patrols').select('id').eq('shift_id', shiftId).eq('officer_user_id', officerId).eq('status', 'in_progress').maybeSingle();
      if (patrolReadError) throw patrolReadError;
      let patrolId = existingPatrol?.id as string | undefined;
      if (!patrolId) {
        const { data: patrol, error: patrolCreateError } = await supabase.from('patrols').insert({ organization_id: organizationId, shift_id: shiftId, officer_user_id: officerId, zone_id: typedCheckpoint.zone_id, status: 'in_progress', started_at: new Date().toISOString() }).select('id').single();
        if (patrolCreateError || !patrol) throw patrolCreateError ?? new Error('Patrol session was not confirmed.');
        patrolId = patrol.id;
      }

      let stopId: string | null = null;
      if (typedCheckpoint.client_site_id || typedCheckpoint.zone_id) {
        const filters = [typedCheckpoint.client_site_id && `site_id.eq.${typedCheckpoint.client_site_id}`, typedCheckpoint.zone_id && `zone_id.eq.${typedCheckpoint.zone_id}`].filter(Boolean).join(',');
        const { data: stops, error: stopError } = await supabase.from('shift_stops').select('id').eq('shift_id', shiftId).in('status', ['pending', 'en_route', 'on_scene']).or(filters).order('stop_order').limit(2);
        if (stopError) throw stopError;
        if (stops?.length === 1) stopId = stops[0].id;
      }

      const { error: visitError } = await supabase.from('patrol_checkpoint_visits').insert({ organization_id: organizationId, patrol_id: patrolId, checkpoint_id: typedCheckpoint.id, officer_user_id: officerId, gps_lat: location.coords.latitude, gps_lng: location.coords.longitude, gps_accuracy: accuracy, gps_distance_from_checkpoint: distance, within_radius: distance === null ? null : true, scan_method: 'qr_camera', shift_stop_id: stopId, notes: 'QR checkpoint scan from mobile app' });
      if (visitError) throw visitError;
      setOpen(false);
      Alert.alert('Checkpoint confirmed', `${typedCheckpoint.name} was recorded.`);
    } catch (error) {
      setScanned(false);
      Alert.alert('Checkpoint not confirmed', error instanceof Error ? error.message : 'The checkpoint visit could not be recorded.');
    } finally { setBusy(false); }
  };

  if (!shiftId) return null;
  const openScanner = async () => { if (!permission?.granted) await requestPermission(); setOpen(true); };
  return <View><Pressable onPress={() => void openScanner()} style={styles.trigger}><Text style={styles.triggerText}>Scan checkpoint QR</Text></Pressable><Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}><View style={styles.modal}><View style={styles.header}><Text style={styles.title}>Scan checkpoint</Text><Pressable onPress={() => setOpen(false)}><Text style={styles.close}>Close</Text></Pressable></View>{permission?.granted ? <CameraView style={styles.camera} onBarcodeScanned={busy || scanned ? undefined : ({ data }) => void recordVisit(data)} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} /> : <View style={styles.permission}><Text style={styles.message}>Camera permission is required to scan a checkpoint.</Text><Pressable onPress={() => void requestPermission()} style={styles.trigger}><Text style={styles.triggerText}>Allow camera</Text></Pressable></View>}{busy && <View style={styles.busy}><ActivityIndicator color="#7dd3c7" /><Text style={styles.message}>Verifying GPS and recording attendance</Text></View>}</View></Modal></View>;
}

const styles = StyleSheet.create({
  trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364', paddingHorizontal: 12 }, triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' }, modal: { flex: 1, backgroundColor: '#07111c', padding: 20, gap: 16 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, title: { color: '#eef6f7', fontSize: 20, fontWeight: '800' }, close: { color: '#a7cce7', fontSize: 14, fontWeight: '700' }, camera: { flex: 1, borderRadius: 8, overflow: 'hidden' }, permission: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }, busy: { alignItems: 'center', gap: 8 }, message: { color: '#a7b7c1', fontSize: 13, textAlign: 'center' },
});
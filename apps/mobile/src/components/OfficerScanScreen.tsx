import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  type OfficerScanPayload,
  type OfficerScanResult,
  type ScanModuleKey,
  captureCoordinates,
  captureVehiclePhoto,
  chooseVehiclePhoto,
  imageUriToBase64,
  isNetworkFailure,
  listQueuedOfficerScans,
  queueOfficerScan,
  removeQueuedOfficerScan,
  submitOfficerScan,
  syncQueuedOfficerScans,
} from '../lib/officerScan';
import { OfficerSafetyBar } from './OfficerSafetyBar';
import { OfficerDispatchPanel } from './OfficerDispatchPanel';
import { OfficerFieldReportPanel } from './OfficerFieldReportPanel';
import { OfficerLeavePanel } from './OfficerLeavePanel';
import { OfficerTimesheetPanel } from './OfficerTimesheetPanel';
import { OfficerCheckpointScanner } from './OfficerCheckpointScanner';
import { OfficerCredentialsPanel } from './OfficerCredentialsPanel';
import { OfficerDebriefPanel } from './OfficerDebriefPanel';
import { NotificationInbox } from './NotificationInbox';
import { OfficerStopPanel } from './OfficerStopPanel';
import { OfficerVehicleLookup } from './OfficerVehicleLookup';
import { OfficerBiosecurityPanel } from './OfficerBiosecurityPanel';

type Props = { onSignOut: () => void; officerId: string; organizationId: string | null; shiftId: string | null; shiftStatus: string | null };

export function OfficerScanScreen({ onSignOut, officerId, organizationId, shiftId, shiftStatus }: Props) {
  const [moduleKey, setModuleKey] = useState<ScanModuleKey>('freedom_camping');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [coordinates, setCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [queued, setQueued] = useState(0);
  const [queueItems, setQueueItems] = useState<Awaited<ReturnType<typeof listQueuedOfficerScans>>>([]);
  const [showQueue, setShowQueue] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<OfficerScanResult | null>(null);

  const refreshQueue = async () => { const items = await listQueuedOfficerScans(); setQueued(items.length); setQueueItems(items); };
  useEffect(() => { void refreshQueue(); }, []);

  const setPhoto = async (source: () => Promise<string | null>) => {
    try { const uri = await source(); if (uri) { setPhotoUri(uri); setResult(null); } } catch (error) { Alert.alert('Evidence unavailable', error instanceof Error ? error.message : 'Vehicle evidence could not be captured.'); }
  };

  const locate = async () => {
    try {
      const point = await captureCoordinates();
      if (!point) Alert.alert('Location unavailable', 'Location permission was not granted. A scan requires a verified location.');
      else setCoordinates(point);
    } catch { Alert.alert('Location unavailable', 'A location fix could not be captured.'); }
  };

  const submit = async () => {
    if (!photoUri || !coordinates) return;
    setWorking(true);
    setResult(null);
    try {
      const payload: OfficerScanPayload = { image_base64: await imageUriToBase64(photoUri), gps_lat: coordinates.lat, gps_lng: coordinates.lng, module_key: moduleKey, captured_at: new Date().toISOString() };
      try {
        setResult(await submitOfficerScan(payload));
        setPhotoUri(null);
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
        await queueOfficerScan(payload);
        await refreshQueue();
        Alert.alert('Queued for sync', 'The scan is stored securely on this device and will be retried from the queue.');
      }
    } catch (error) {
      Alert.alert('Scan unavailable', error instanceof Error ? error.message : 'The scan could not be prepared.');
    } finally { setWorking(false); }
  };

  const sync = async () => {
    setWorking(true);
    try { const status = await syncQueuedOfficerScans(); await refreshQueue(); Alert.alert('Queue sync', `${status.synced} sent, ${status.pending} still pending.`); } finally { setWorking(false); }
  };

  const discardQueuedScan = async (id: string) => {
    await removeQueuedOfficerScan(id);
    await refreshQueue();
  };

  return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><View><Text style={styles.eyebrow}>Field operations</Text><Text style={styles.title}>Vehicle scan</Text></View><Pressable onPress={onSignOut} style={styles.secondary}><Text style={styles.secondaryText}>Sign out</Text></Pressable></View>
    <OfficerSafetyBar officerId={officerId} organizationId={organizationId} shiftId={shiftId} />
    <NotificationInbox organizationId={organizationId} userId={officerId} />
    <OfficerDispatchPanel shiftId={shiftId} />
    <OfficerStopPanel shiftId={shiftId} />
    <OfficerCheckpointScanner officerId={officerId} organizationId={organizationId} shiftId={shiftId} />
    <OfficerFieldReportPanel shiftId={shiftId} />
    <OfficerBiosecurityPanel shiftId={shiftId} />
    <OfficerLeavePanel officerId={officerId} />
    <OfficerTimesheetPanel officerId={officerId} />
    <OfficerDebriefPanel shiftId={shiftId} shiftStatus={shiftStatus} />
    <OfficerCredentialsPanel officerId={officerId} />
    <OfficerVehicleLookup organizationId={organizationId} />
    <View style={styles.moduleRow}>{(['freedom_camping', 'parking_enforcement'] as ScanModuleKey[]).map((key) => <Pressable key={key} onPress={() => { setModuleKey(key); setResult(null); }} style={[styles.module, moduleKey === key && styles.moduleActive]}><Text style={styles.moduleText}>{key === 'freedom_camping' ? 'Freedom camping' : 'Parking'}</Text></Pressable>)}</View>
    <View style={styles.photoPanel}>{photoUri ? <Image source={{ uri: photoUri }} style={styles.photo} /> : <Text style={styles.photoEmpty}>Capture a clear rear vehicle image with the plate visible.</Text>}<View style={styles.actionRow}><Pressable onPress={() => void setPhoto(captureVehiclePhoto)} style={styles.primary}><Text style={styles.primaryText}>Open camera</Text></Pressable><Pressable onPress={() => void setPhoto(chooseVehiclePhoto)} style={styles.secondary}><Text style={styles.secondaryText}>Choose photo</Text></Pressable></View></View>
    <View style={styles.location}><Text style={styles.label}>Location</Text><Text style={styles.detail}>{coordinates ? `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}` : 'No location captured'}</Text><Pressable onPress={() => void locate()} style={styles.secondary}><Text style={styles.secondaryText}>{coordinates ? 'Refresh GPS' : 'Capture GPS'}</Text></Pressable></View>
    <Pressable disabled={!photoUri || !coordinates || working} onPress={() => void submit()} style={[styles.submit, (!photoUri || !coordinates || working) && styles.disabled]}>{working ? <ActivityIndicator color="#04211e" /> : <Text style={styles.submitText}>Process scan</Text>}</Pressable>
    <View style={styles.queuePanel}><Pressable disabled={working} onPress={() => void sync()} style={styles.queue}><Text style={styles.queueText}>Queued scans: {queued}. Sync now</Text></Pressable>{queued > 0 && <Pressable onPress={() => setShowQueue((current) => !current)} style={styles.queue}><Text style={styles.queueText}>{showQueue ? 'Hide queued scans' : 'Review queued scans'}</Text></Pressable>}{showQueue && <View style={styles.queueList}>{queueItems.map((item) => <View key={item.id} style={styles.queueItem}><View><Text style={styles.queueItemTitle}>{item.payload.module_key.replaceAll('_', ' ')}</Text><Text style={styles.detail}>Captured {new Date(item.payload.captured_at).toLocaleString('en-NZ')} · {item.attempts} retry attempt{item.attempts === 1 ? '' : 's'}</Text></View><Pressable onPress={() => void discardQueuedScan(item.id)} style={styles.discard}><Text style={styles.discardText}>Discard</Text></Pressable></View>)}</View>}</View>
    {result && <View style={styles.result}><Text style={styles.resultStatus}>{result.compliance_status.replaceAll('_', ' ')}</Text><Text style={styles.resultPlate}>{result.plate_number}</Text><Text style={styles.detail}>{result.zone_name ?? 'No verified zone matched'}{result.compliance_reason ? ` · ${result.compliance_reason}` : ''}</Text></View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07111c' }, content: { padding: 20, gap: 16 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }, title: { color: '#eef6f7', fontSize: 28, fontWeight: '700', marginTop: 4 }, moduleRow: { flexDirection: 'row', gap: 8 }, module: { flex: 1, minHeight: 46, borderRadius: 6, borderWidth: 1, borderColor: '#30485b', alignItems: 'center', justifyContent: 'center', padding: 8 }, moduleActive: { borderColor: '#7dd3c7', backgroundColor: '#10302e' }, moduleText: { color: '#dce8eb', fontSize: 13, fontWeight: '700', textAlign: 'center' }, photoPanel: { borderWidth: 1, borderColor: '#30485b', borderRadius: 8, padding: 14, gap: 14, backgroundColor: '#0b1926' }, photo: { width: '100%', height: 260, borderRadius: 5 }, photoEmpty: { color: '#a7b7c1', lineHeight: 21, minHeight: 120, textAlign: 'center', textAlignVertical: 'center' }, actionRow: { flexDirection: 'row', gap: 10 }, primary: { flex: 1, minHeight: 48, borderRadius: 6, backgroundColor: '#7dd3c7', alignItems: 'center', justifyContent: 'center', padding: 10 }, primaryText: { color: '#04211e', fontWeight: '800' }, secondary: { minHeight: 40, borderRadius: 6, borderWidth: 1, borderColor: '#3a5364', backgroundColor: '#0d1d2b', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, secondaryText: { color: '#c8d9e1', fontWeight: '700', fontSize: 12 }, location: { borderWidth: 1, borderColor: '#263f51', borderRadius: 6, padding: 14, gap: 8 }, label: { color: '#7dd3c7', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' }, detail: { color: '#a7b7c1', fontSize: 13, lineHeight: 20 }, submit: { minHeight: 52, borderRadius: 6, backgroundColor: '#7dd3c7', alignItems: 'center', justifyContent: 'center' }, submitText: { color: '#04211e', fontSize: 16, fontWeight: '800' }, disabled: { opacity: 0.45 }, queuePanel: { borderWidth: 1, borderColor: '#263f51', borderRadius: 6 }, queue: { alignItems: 'center', padding: 10 }, queueText: { color: '#8ec4ff', fontSize: 13, fontWeight: '700' }, queueList: { borderTopWidth: 1, borderTopColor: '#263f51' }, queueItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: '#1e3345', padding: 12 }, queueItemTitle: { color: '#dce8eb', fontSize: 13, fontWeight: '800', textTransform: 'capitalize' }, discard: { minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#8e3c43', paddingHorizontal: 10 }, discardText: { color: '#f3a0a8', fontSize: 12, fontWeight: '800' }, result: { borderLeftWidth: 3, borderLeftColor: '#7dd3c7', backgroundColor: '#10302e', padding: 14, gap: 5 }, resultStatus: { color: '#7dd3c7', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }, resultPlate: { color: '#eef6f7', fontSize: 24, fontWeight: '800' },
});
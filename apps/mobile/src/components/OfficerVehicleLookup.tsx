import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { supabase } from '../lib/supabase';

type Vehicle = { id: string; plate_number: string; make: string | null; model: string | null; colour: string | null; rego_status: string | null; wof_status: string | null; cof_status: string | null; homeless_status: string | null };
type Scv = { certificate_status: string; expiry_date: string | null };
type Flag = { flag_type: string; alert_level: string | null; reason: string | null };
type Observation = { observed_at: string; is_compliant: boolean | null; compliance_reason: string | null };
type Breach = { breach_type: string; status: string; created_at: string };
type Props = { organizationId: string | null };

export function OfficerVehicleLookup({ organizationId }: Props) {
  const [plate, setPlate] = useState('');
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [scv, setScv] = useState<Scv | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [breaches, setBreaches] = useState<Breach[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const plateNumber = plate.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!supabase || !plateNumber) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const [vehicleResult, scvResult, observationResult, breachResult] = await Promise.all([
        supabase.from('canonical_vehicles').select('id, plate_number, make, model, colour, rego_status, wof_status, cof_status, homeless_status').eq('plate_number', plateNumber).maybeSingle(),
        supabase.from('canonical_scv').select('certificate_status, expiry_date').eq('plate_number', plateNumber).maybeSingle(),
        supabase.from('observations').select('observed_at, is_compliant, compliance_reason').eq('plate_number', plateNumber).order('observed_at', { ascending: false }).limit(5),
        supabase.from('breach_alerts').select('breach_type, status, created_at').eq('plate_number', plateNumber).order('created_at', { ascending: false }).limit(5),
      ]);
      const queryError = vehicleResult.error ?? scvResult.error ?? observationResult.error ?? breachResult.error;
      if (queryError) throw queryError;
      const vehicleRow = vehicleResult.data as Vehicle | null;
      setVehicle(vehicleRow);
      setScv(scvResult.data as Scv | null);
      setObservations((observationResult.data as Observation[]) ?? []);
      setBreaches((breachResult.data as Breach[]) ?? []);
      if (vehicleRow && organizationId) {
        const { data, error: flagError } = await supabase.from('entity_flags').select('flag_type, alert_level, reason').eq('organization_id', organizationId).eq('entity_type', 'vehicle').eq('entity_id', vehicleRow.id).eq('active', true);
        if (flagError) throw flagError;
        setFlags((data as Flag[]) ?? []);
      } else setFlags([]);
    } catch (cause) { console.warn('Vehicle lookup failed', cause); setError("We couldn't look up this vehicle right now. Please try again."); } finally { setLoading(false); }
  };

  const hasResults = Boolean(vehicle || scv || observations.length || breaches.length);
  return (
    <View style={styles.panel}>
      <Text style={styles.eyebrow}>Field reference</Text>
      <Text style={styles.title}>Vehicle lookup</Text>
      <View style={styles.searchRow}>
        <TextInput value={plate} onChangeText={(value) => setPlate(value.toUpperCase())} placeholder="Plate number" placeholderTextColor="#718197" autoCapitalize="characters" style={styles.input} />
        <Pressable onPress={() => void search()} disabled={loading || !plate.trim()} style={[styles.search, (loading || !plate.trim()) && styles.disabled]}>
          {loading ? <ActivityIndicator color="#04211e" /> : <Text style={styles.searchText}>Search</Text>}
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {searched && !loading && !error && (
        <View style={styles.results}>
          {!hasResults ? <Text style={styles.empty}>No vehicle, certificate, observation, or breach records found.</Text> : <>
            <View style={styles.vehicle}>
              <Text style={styles.plate}>{vehicle?.plate_number ?? plate}</Text>
              <Text style={styles.vehicleName}>{vehicle ? `${vehicle.make ?? 'Unknown'} ${vehicle.model ?? ''}`.trim() : 'Vehicle details unavailable'}</Text>
              <Text style={styles.detail}>Rego {vehicle?.rego_status ?? 'unknown'} · WoF {vehicle?.wof_status ?? 'unknown'} · CoF {vehicle?.cof_status ?? 'unknown'}</Text>
              <Text style={styles.detail}>SCV {scv?.certificate_status ?? 'no record'}{scv?.expiry_date ? ` · expires ${scv.expiry_date}` : ''}</Text>
              {vehicle?.homeless_status && vehicle.homeless_status !== 'none' && <Text style={styles.warning}>Vulnerability status: {vehicle.homeless_status}</Text>}
            </View>
            {flags.map((flag, index) => <View key={`${flag.flag_type}-${index}`} style={styles.flag}><Text style={styles.flagTitle}>{flag.alert_level ?? 'alert'} · {flag.flag_type}</Text>{flag.reason && <Text style={styles.detail}>{flag.reason}</Text>}</View>)}
            {observations.length > 0 && <View style={styles.list}><Text style={styles.listTitle}>Recent observations</Text>{observations.map((item, index) => <Text key={`${item.observed_at}-${index}`} style={styles.detail}>{new Date(item.observed_at).toLocaleString('en-NZ')} · {item.is_compliant === true ? 'compliant' : item.is_compliant === false ? 'review required' : 'status unknown'}{item.compliance_reason ? ` · ${item.compliance_reason}` : ''}</Text>)}</View>}
            {breaches.length > 0 && <View style={styles.list}><Text style={styles.listTitle}>Recent breaches</Text>{breaches.map((item, index) => <Text key={`${item.created_at}-${index}`} style={styles.detail}>{item.breach_type.replaceAll('_', ' ')} · {item.status.replaceAll('_', ' ')}</Text>)}</View>}
          </>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 9, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, searchRow: { flexDirection: 'row', gap: 8 }, input: { flex: 1, minHeight: 44, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, color: '#eef6f7', paddingHorizontal: 10, fontWeight: '700' }, search: { minWidth: 78, minHeight: 44, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: '#7dd3c7' }, searchText: { color: '#04211e', fontSize: 13, fontWeight: '800' }, disabled: { opacity: 0.45 }, error: { color: '#f3a0a8', fontSize: 12 }, results: { gap: 8 }, empty: { color: '#a7b7c1', paddingVertical: 8 }, vehicle: { gap: 4, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 10 }, plate: { color: '#eef6f7', fontSize: 20, fontWeight: '900', letterSpacing: 1 }, vehicleName: { color: '#dce8eb', fontSize: 14, fontWeight: '800' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 }, warning: { color: '#f3ce89', fontSize: 12, fontWeight: '700' }, flag: { gap: 3, borderLeftWidth: 3, borderLeftColor: '#e05a62', backgroundColor: '#23151a', padding: 8 }, flagTitle: { color: '#f3a0a8', fontSize: 12, fontWeight: '800', textTransform: 'capitalize' }, list: { gap: 4, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 9 }, listTitle: { color: '#dce8eb', fontSize: 12, fontWeight: '800' },
});
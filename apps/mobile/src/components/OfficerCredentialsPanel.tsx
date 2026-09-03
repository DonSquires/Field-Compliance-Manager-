import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';

type Credential = { id: string; credential_type: string; credential_number: string | null; issuing_authority: string | null; expiry_date: string | null; verified: boolean };
type Props = { officerId: string };

function expiryState(value: string | null): 'expired' | 'expiring' | 'current' | 'none' {
  if (!value) return 'none';
  const days = (new Date(value).getTime() - Date.now()) / 86_400_000;
  return days < 0 ? 'expired' : days <= 30 ? 'expiring' : 'current';
}

export function OfficerCredentialsPanel({ officerId }: Props) {
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError(null);
    try { const { data, error: queryError } = await supabase.from('staff_credentials').select('id, credential_type, credential_number, issuing_authority, expiry_date, verified').eq('staff_id', officerId).order('expiry_date', { ascending: true }); if (queryError) throw queryError; setCredentials((data as Credential[]) ?? []); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Credentials could not be loaded.'); } finally { setLoading(false); }
  }, [officerId]);
  useEffect(() => { if (open) void load(); }, [load, open]);
  return <View style={styles.panel}><Pressable onPress={() => setOpen((value) => !value)} style={styles.trigger}><Text style={styles.triggerText}>{open ? 'Close credentials' : 'My credentials'}</Text></Pressable>{open && <View style={styles.list}><View style={styles.heading}><Text style={styles.title}>Credentials</Text><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{error && <Text style={styles.error}>{error}</Text>}{loading ? <ActivityIndicator color="#7dd3c7" /> : credentials.length === 0 ? <Text style={styles.empty}>No credentials on file.</Text> : credentials.map((credential) => { const state = expiryState(credential.expiry_date); return <View key={credential.id} style={[styles.item, state === 'expired' && styles.expired, state === 'expiring' && styles.expiring]}><View style={styles.itemTop}><Text style={styles.name}>{credential.credential_type.replaceAll('_', ' ')}</Text><Text style={credential.verified ? styles.verified : styles.unverified}>{credential.verified ? 'Verified' : 'Unverified'}</Text></View>{credential.credential_number && <Text style={styles.detail}>{credential.credential_number}</Text>}{credential.issuing_authority && <Text style={styles.detail}>{credential.issuing_authority}</Text>}<Text style={state === 'expired' || state === 'expiring' ? styles.warning : styles.detail}>{state === 'expired' ? `Expired ${credential.expiry_date}` : credential.expiry_date ? `Expires ${credential.expiry_date}` : 'No expiry recorded'}</Text></View>; })}</View>}</View>;
}

const styles = StyleSheet.create({ panel: { gap: 8 }, trigger: { minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' }, triggerText: { color: '#a7cce7', fontSize: 13, fontWeight: '800' }, list: { gap: 8, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, title: { color: '#eef6f7', fontSize: 17, fontWeight: '800' }, refresh: { color: '#8ec4ff', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 8 }, item: { gap: 4, borderTopWidth: 1, borderTopColor: '#263f51', paddingTop: 10 }, expired: { borderLeftWidth: 3, borderLeftColor: '#e05a62', paddingLeft: 8 }, expiring: { borderLeftWidth: 3, borderLeftColor: '#e6b45b', paddingLeft: 8 }, itemTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, name: { color: '#dce8eb', fontSize: 13, fontWeight: '800', textTransform: 'capitalize', flex: 1 }, verified: { color: '#7dd3c7', fontSize: 11, fontWeight: '800' }, unverified: { color: '#f3a0a8', fontSize: 11, fontWeight: '800' }, detail: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 }, warning: { color: '#f3ce89', fontSize: 12, fontWeight: '800' }, });
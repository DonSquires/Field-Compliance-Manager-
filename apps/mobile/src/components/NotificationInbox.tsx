import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';

type Notification = {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string | null;
  category: string;
  read_at: string | null;
  created_at: string;
};

type Props = { organizationId: string | null; userId: string };

export function NotificationInbox({ organizationId, userId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase.from('notifications').select('id, severity, title, body, category, read_at, created_at').eq('organization_id', organizationId).order('created_at', { ascending: false }).limit(30);
      if (queryError) throw queryError;
      setRows((data as Notification[]) ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Notifications could not be loaded.');
    } finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const client = supabase;
    if (!client || !organizationId) return;
    const channel = client.channel(`mobile_notifications_${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `organization_id=eq.${organizationId}` }, () => void load()).subscribe();
    return () => { void client.removeChannel(channel); };
  }, [load, organizationId, userId]);

  const markRead = async (id: string) => {
    if (!supabase) return;
    const readAt = new Date().toISOString();
    const { error: updateError } = await supabase.from('notifications').update({ read_at: readAt }).eq('id', id).is('read_at', null);
    if (updateError) { Alert.alert('Notification not updated', updateError.message); return; }
    setRows((current) => current.map((item) => item.id === id ? { ...item, read_at: readAt } : item));
  };

  const unread = rows.filter((item) => !item.read_at).length;
  return <View style={styles.wrap}><Pressable onPress={() => { setOpen((current) => !current); if (!open) void load(); }} style={styles.trigger}><Text style={styles.triggerText}>Notifications{unread ? ` (${unread > 99 ? '99+' : unread})` : ''}</Text></Pressable>{open && <View style={styles.panel}><View style={styles.panelHeader}><Text style={styles.title}>Notifications</Text><Pressable onPress={() => void load()}><Text style={styles.refresh}>Refresh</Text></Pressable></View>{error && <Text style={styles.error}>{error}</Text>}{loading ? <ActivityIndicator color="#7dd3c7" /> : rows.length === 0 ? <Text style={styles.empty}>No notifications</Text> : rows.map((item) => <Pressable key={item.id} onPress={() => { if (!item.read_at) void markRead(item.id); }} style={[styles.item, !item.read_at && styles.unread, item.severity === 'critical' && styles.critical]}><Text style={styles.itemTitle}>{item.title}</Text>{item.body && <Text style={styles.body}>{item.body}</Text>}<Text style={styles.meta}>{item.category.replaceAll('_', ' ')} · {new Date(item.created_at).toLocaleString('en-NZ')}</Text></Pressable>)}</View>}</View>;
}

const styles = StyleSheet.create({
  wrap: { gap: 8 }, trigger: { alignSelf: 'flex-start', minHeight: 38, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 5, borderWidth: 1, borderColor: '#3a5364' }, triggerText: { color: '#a7cce7', fontWeight: '700', fontSize: 12 }, panel: { gap: 8, borderWidth: 1, borderColor: '#30485b', borderRadius: 8, backgroundColor: '#0b1926', padding: 12 }, panelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, title: { color: '#eef6f7', fontSize: 16, fontWeight: '800' }, refresh: { color: '#7dd3c7', fontSize: 12, fontWeight: '700' }, error: { color: '#f3a0a8', fontSize: 12 }, empty: { color: '#a7b7c1', paddingVertical: 10, textAlign: 'center' }, item: { gap: 4, borderTopWidth: 1, borderTopColor: '#263f51', paddingVertical: 10 }, unread: { borderLeftWidth: 3, borderLeftColor: '#7dd3c7', paddingLeft: 8 }, critical: { borderLeftColor: '#e05a62' }, itemTitle: { color: '#dce8eb', fontSize: 13, fontWeight: '800' }, body: { color: '#a7b7c1', fontSize: 12, lineHeight: 18 }, meta: { color: '#78909e', fontSize: 11, textTransform: 'capitalize' },
});
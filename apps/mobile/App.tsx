import 'react-native-url-polyfill/auto';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';
import { OfficerScanScreen } from './src/components/OfficerScanScreen';
import { useFieldContext } from './src/hooks/useFieldContext';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const fieldContext = useFieldContext(session?.user.id ?? null);

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setLoading(false); });
    return () => listener.subscription.unsubscribe();
  }, []);

  const signIn = async () => {
    if (!supabase || !email.trim() || !password) return;
    setSigningIn(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setSigningIn(false);
    if (error) Alert.alert('Sign-in unavailable', error.message);
  };

  const signOut = async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) Alert.alert('Sign-out unavailable', error.message);
  };

  if (loading) return <LoadingScreen />;
  if (!isSupabaseConfigured) return <ConfigurationScreen />;
  if (!session) return <SignInScreen email={email} password={password} signingIn={signingIn} onChangeEmail={setEmail} onChangePassword={setPassword} onSignIn={() => void signIn()} />;
  return <OfficerScanScreen onSignOut={() => void signOut()} officerId={session.user.id} organizationId={fieldContext.profile?.organizationId ?? null} shiftId={fieldContext.assignment?.id ?? null} />;
}

function LoadingScreen() { return <SafeAreaView style={styles.centered}><ActivityIndicator color="#74d6c8" /><Text style={styles.muted}>Restoring secure session</Text><StatusBar style="light" /></SafeAreaView>; }
function ConfigurationScreen() { return <SafeAreaView style={styles.centered}><Text style={styles.eyebrow}>Field Compliance Manager</Text><Text style={styles.title}>Mobile app setup required</Text><Text style={styles.body}>This build needs its protected Supabase project settings before officers can sign in.</Text><Text style={styles.code}>EXPO_PUBLIC_SUPABASE_URL{`\n`}EXPO_PUBLIC_SUPABASE_ANON_KEY</Text><StatusBar style="light" /></SafeAreaView>; }
function SignInScreen({ email, password, signingIn, onChangeEmail, onChangePassword, onSignIn }: { email: string; password: string; signingIn: boolean; onChangeEmail: (value: string) => void; onChangePassword: (value: string) => void; onSignIn: () => void }) { return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.authContent}><View style={styles.brandMark}><Text>FCM</Text></View><Text style={styles.eyebrow}>Secure field access</Text><Text style={styles.hero}>Field operations, ready when you are.</Text><Text style={styles.body}>Use your Field Compliance Manager account. Your session is encrypted on this device.</Text><View style={styles.form}><Text style={styles.label}>Email</Text><TextInput value={email} onChangeText={onChangeEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="name@organisation.nz" placeholderTextColor="#728797" style={styles.input} /><Text style={styles.label}>Password</Text><TextInput value={password} onChangeText={onChangePassword} secureTextEntry autoComplete="password" placeholder="Password" placeholderTextColor="#728797" style={styles.input} /><Pressable accessibilityRole="button" disabled={signingIn || !email.trim() || !password} onPress={onSignIn} style={({ pressed }) => [styles.primaryButton, (signingIn || !email.trim() || !password) && styles.disabledButton, pressed && styles.pressed]}>{signingIn ? <ActivityIndicator color="#04211e" /> : <Text style={styles.primaryButtonText}>Sign in securely</Text>}</Pressable></View></ScrollView><StatusBar style="light" /></SafeAreaView>; }
function OfficerHome({ email, profile, assignment, loading, error, onRefresh, onSignOut }: { email: string; profile: { displayName: string; role: string } | null; assignment: { serviceType: string; scheduledStart: string; scheduledEnd: string; status: string; totalStops: number; completedStops: number } | null; loading: boolean; error: string | null; onRefresh: () => void; onSignOut: () => void }) { const assignmentLabel = assignment?.serviceType.replaceAll('_', ' ') ?? 'Standby'; return <SafeAreaView style={styles.screen}><ScrollView contentContainerStyle={styles.homeContent}><View style={styles.homeHeader}><View><Text style={styles.eyebrow}>Field operations</Text><Text style={styles.title}>{profile ? `Ready, ${profile.displayName.split(' ')[0]}` : 'Field profile unavailable'}</Text><Text style={styles.muted}>{email}</Text></View><Pressable accessibilityRole="button" onPress={onSignOut} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Sign out</Text></Pressable></View>{error ? <View style={styles.errorCard}><Text style={styles.errorTitle}>Operations unavailable</Text><Text style={styles.body}>{error}</Text><Pressable accessibilityRole="button" onPress={onRefresh} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Retry</Text></Pressable></View> : <View style={styles.safetyCard}><Text style={styles.safetyLabel}>Current assignment</Text><Text style={styles.safetyTitle}>{loading ? 'Checking roster' : assignmentLabel}</Text><Text style={styles.body}>{loading ? 'Loading your current field assignment.' : assignment ? `${assignment.completedStops} of ${assignment.totalStops} stops completed. Ends ${new Date(assignment.scheduledEnd).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })}.` : 'No accepted or active shift is currently assigned. Safety and welfare controls will remain available as they are added.'}</Text></View>}<Text style={styles.sectionTitle}>Field tools</Text><View style={styles.toolGrid}><Tool label="Assignment" detail="Secure roster context" /><Tool label="Check in" detail="Welfare confirmation" /><Tool label="Field report" detail="Evidence capture" /><Tool label="Vehicle lookup" detail="Compliance history" /></View></ScrollView><StatusBar style="light" /></SafeAreaView>; }
function Tool({ label, detail }: { label: string; detail: string }) { return <View style={styles.tool}><Text style={styles.toolTitle}>{label}</Text><Text style={styles.toolDetail}>{detail}</Text></View>; }

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#07111c' }, centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 28, backgroundColor: '#07111c' }, authContent: { flexGrow: 1, justifyContent: 'center', padding: 26 }, homeContent: { padding: 20, gap: 18 }, brandMark: { width: 54, height: 54, alignItems: 'center', justifyContent: 'center', marginBottom: 25, borderWidth: 1, borderColor: '#4c8f87', borderRadius: 8, backgroundColor: '#10302e' }, eyebrow: { color: '#7dd3c7', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' }, hero: { marginTop: 8, color: '#eef6f7', fontSize: 31, fontWeight: '700', lineHeight: 38 }, title: { marginTop: 5, color: '#eef6f7', fontSize: 23, fontWeight: '700' }, body: { marginTop: 10, color: '#a7b7c1', fontSize: 14, lineHeight: 21 }, muted: { marginTop: 5, color: '#8297a6', fontSize: 12 }, code: { width: '100%', marginTop: 16, padding: 12, borderWidth: 1, borderColor: '#2e4558', borderRadius: 6, color: '#bcd1da', backgroundColor: '#0c1b29', fontFamily: 'monospace', fontSize: 12, lineHeight: 20 }, form: { marginTop: 34, gap: 9 }, label: { marginTop: 7, color: '#a9bdc8', fontSize: 12, fontWeight: '600' }, input: { minHeight: 48, paddingHorizontal: 13, borderWidth: 1, borderColor: '#30485b', borderRadius: 6, color: '#eff8fa', backgroundColor: '#0b1926', fontSize: 15 }, primaryButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 16, borderRadius: 6, backgroundColor: '#7dd3c7' }, primaryButtonText: { color: '#04211e', fontSize: 15, fontWeight: '800' }, disabledButton: { opacity: 0.45 }, pressed: { opacity: 0.8 }, homeHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }, secondaryButton: { paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: '#3a5364', borderRadius: 5, backgroundColor: '#0d1d2b' }, secondaryButtonText: { color: '#c8d9e1', fontSize: 12, fontWeight: '700' }, safetyCard: { padding: 17, borderWidth: 1, borderColor: '#547a72', borderRadius: 7, backgroundColor: '#0e2928' }, errorCard: { padding: 17, borderWidth: 1, borderColor: '#82464a', borderRadius: 7, backgroundColor: '#30191d' }, errorTitle: { color: '#ffd0d0', fontSize: 18, fontWeight: '700' }, safetyLabel: { color: '#86ddd2', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }, safetyTitle: { marginTop: 5, color: '#eef9f7', fontSize: 18, fontWeight: '700' }, sectionTitle: { color: '#ecf4f6', fontSize: 17, fontWeight: '700' }, toolGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, tool: { width: '47.5%', minHeight: 105, padding: 14, borderWidth: 1, borderColor: '#2d4355', borderRadius: 6, backgroundColor: '#0b1926' }, toolTitle: { color: '#e5f0f3', fontSize: 15, fontWeight: '700' }, toolDetail: { marginTop: 6, color: '#899eae', fontSize: 11, lineHeight: 16 },
});

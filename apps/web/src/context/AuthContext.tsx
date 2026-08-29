import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';

export type AppRole =
  | 'admin'
  | 'admin_officer'
  | 'grand_master'
  | 'master'
  | 'nzscv_monitor'
  | 'officer'
  | 'scan_operator'
  | 'client_admin'
  | 'client_officer'
  | 'client_viewer'
  | 'unknown';

export interface AppProfile {
  id: string;
  displayName: string;
  email?: string;
  role: AppRole;
  organizationId: string | null;
}

interface AuthContextValue {
  profile: AppProfile | null;
  hasSession: boolean;
  loading: boolean;
  error: string | null;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  profile: null,
  hasSession: false,
  loading: true,
  error: null,
  signInWithPassword: async () => ({ error: 'Auth not initialised' }),
  signOut: async () => undefined,
});

// ATLAS READS: user_profiles (mapped to the authenticated auth.users session)
async function loadProfile(userId: string): Promise<AppProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, display_name, email, role, organization_id')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    displayName: data.display_name || data.email || 'Unknown',
    email: data.email ?? undefined,
    role: (data.role as AppRole) ?? 'unknown',
    organizationId: data.organization_id ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user?.id;
      if (userId) {
        if (!cancelled) setHasSession(true);
        const p = await loadProfile(userId);
        if (!cancelled) setProfile(p);
      }
      if (!cancelled) setLoading(false);
    };

    bootstrap();

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!session?.user) {
        setHasSession(false);
        setProfile(null);
        return;
      }
      setHasSession(true);
      const p = await loadProfile(session.user.id);
      setProfile(p);
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signInWithPassword = async (email: string, password: string) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      return { error: signInError.message };
    }
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setHasSession(false);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ profile, hasSession, loading, error, signInWithPassword, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

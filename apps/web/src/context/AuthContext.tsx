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
  employerOrganizationId: string | null;
  moduleAccess?: string[];
}

export interface OperatingOrganization {
  organizationId: string;
  organizationName: string;
  authorityBasis: 'organisation_home' | 'branch_authorisation' | 'corporate_oversight';
  roleAtBranch: string | null;
  moduleAccess: string[];
  canBeRostered: boolean;
  isDefault: boolean;
}

interface AuthContextValue {
  profile: AppProfile | null;
  hasSession: boolean;
  recoveryMode: boolean;
  loading: boolean;
  error: string | null;
  operatingOrganizationId: string | null;
  operatingOrganizations: OperatingOrganization[];
  setOperatingOrganization: (organizationId: string) => void;
  refreshOperatingOrganizations: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  profile: null,
  hasSession: false,
  recoveryMode: false,
  loading: true,
  error: null,
  operatingOrganizationId: null,
  operatingOrganizations: [],
  setOperatingOrganization: () => undefined,
  refreshOperatingOrganizations: async () => undefined,
  signInWithPassword: async () => ({ error: 'Auth not initialised' }),
  requestPasswordReset: async () => ({ error: 'Auth not initialised' }),
  updatePassword: async () => ({ error: 'Auth not initialised' }),
  signOut: async () => undefined,
});

// ATLAS READS: user_profiles (mapped to the authenticated auth.users session)
async function loadProfile(userId: string): Promise<AppProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, display_name, email, role, organization_id, employer_organization_id, module_access')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    displayName: data.display_name || data.email || 'Unknown',
    email: data.email ?? undefined,
    role: (data.role as AppRole) ?? 'unknown',
    organizationId: data.organization_id ?? null,
    employerOrganizationId: data.employer_organization_id ?? null,
    moduleAccess: data.module_access ?? [],
  };
}

async function loadOperatingOrganizations(): Promise<OperatingOrganization[]> {
  const { data, error } = await supabase.rpc('get_operating_organization_contexts');
  if (error || !Array.isArray(data)) return [];
  return data.map((context) => ({
    organizationId: context.organization_id,
    organizationName: context.organization_name,
    authorityBasis: context.authority_basis,
    roleAtBranch: context.role_at_branch,
    moduleAccess: context.module_access ?? [],
    canBeRostered: context.can_be_rostered,
    isDefault: context.is_default,
  }));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operatingOrganizationId, setOperatingOrganizationId] = useState<string | null>(null);
  const [operatingOrganizations, setOperatingOrganizations] = useState<OperatingOrganization[]>([]);

  useEffect(() => {
    let cancelled = false;

    const hydrateProfile = async (userId: string) => {
      const nextProfile = await loadProfile(userId);
      const contexts = nextProfile ? await loadOperatingOrganizations() : [];
      const storageKey = `fcm:operating-organization:${userId}`;
      const storedOrganizationId = sessionStorage.getItem(storageKey);
      const selected = contexts.find((context) => context.organizationId === storedOrganizationId)
        ?? contexts.find((context) => context.isDefault)
        ?? contexts[0];
      if (!cancelled) {
        setProfile(nextProfile);
        setOperatingOrganizations(contexts);
        setOperatingOrganizationId(selected?.organizationId ?? null);
        if (selected) sessionStorage.setItem(storageKey, selected.organizationId);
        else sessionStorage.removeItem(storageKey);
      }
    };

    const bootstrap = async () => {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user?.id;
      if (userId) {
        if (!cancelled) setHasSession(true);
        await hydrateProfile(userId);
      }
      if (!cancelled) setLoading(false);
    };

    bootstrap();

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (!session?.user) {
        setHasSession(false);
        setProfile(null);
        setOperatingOrganizations([]);
        setOperatingOrganizationId(null);
        return;
      }
      setHasSession(true);
      await hydrateProfile(session.user.id);
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

  const requestPasswordReset = async (email: string) => {
    setError(null);
    const redirectTo = typeof window !== 'undefined' ? `${window.location.origin}/` : undefined;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (resetError) {
      setError(resetError.message);
      return { error: resetError.message };
    }
    return { error: null };
  };

  const updatePassword = async (password: string) => {
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      return { error: updateError.message };
    }
    setRecoveryMode(false);
    return { error: null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setHasSession(false);
    setRecoveryMode(false);
    setProfile(null);
    setOperatingOrganizations([]);
    setOperatingOrganizationId(null);
  };

  const setOperatingOrganization = (organizationId: string) => {
    if (!profile || !operatingOrganizations.some((context) => context.organizationId === organizationId)) return;
    sessionStorage.setItem(`fcm:operating-organization:${profile.id}`, organizationId);
    setOperatingOrganizationId(organizationId);
  };

  const refreshOperatingOrganizations = async () => {
    if (!profile) return;
    const contexts = await loadOperatingOrganizations();
    setOperatingOrganizations(contexts);
    if (operatingOrganizationId && !contexts.some((context) => context.organizationId === operatingOrganizationId)) {
      const fallback = contexts.find((context) => context.isDefault) ?? contexts[0];
      setOperatingOrganizationId(fallback?.organizationId ?? null);
      if (fallback) sessionStorage.setItem(`fcm:operating-organization:${profile.id}`, fallback.organizationId);
    }
  };

  return (
    <AuthContext.Provider value={{ profile, hasSession, recoveryMode, loading, error, operatingOrganizationId, operatingOrganizations, setOperatingOrganization, refreshOperatingOrganizations, signInWithPassword, requestPasswordReset, updatePassword, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

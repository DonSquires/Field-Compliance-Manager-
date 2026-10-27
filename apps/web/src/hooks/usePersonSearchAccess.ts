import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

export function usePersonSearchAccess(enabled = true) {
  const { profile } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ userId: string; allowed: boolean; error: string | null } | null>(null);
  const userId = profile?.id;
  const retry = useCallback(() => { setResult(null); setAttempt(value => value + 1); }, []);

  useEffect(() => {
    if (!userId || !enabled) return;
    let cancelled = false;
    setResult(null);
    const load = async () => {
      try {
        // ATLAS CALLS: can_search_people
        const { data, error } = await supabase.rpc('can_search_people');
        if (error) throw new Error(error.message);
        if (typeof data !== 'boolean') throw new Error('Invalid person-search access response');
        if (!cancelled) setResult({ userId, allowed: data, error: null });
      } catch (error) {
        if (!cancelled) setResult({ userId, allowed: false, error: error instanceof Error ? error.message : 'Could not verify person-search authorization. Retry or contact your administrator.' });
      }
    };
    void load();
    const refresh = () => { if (!document.hidden) retry(); };
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('focus', refresh); };
  }, [userId, profile?.organizationId, attempt, retry, enabled]);

  const current = result?.userId === userId ? result : null;
  return { allowed: enabled && current?.allowed === true, loading: enabled && !current, error: current?.error ?? null, retry };
}

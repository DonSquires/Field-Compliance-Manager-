import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

const MAX_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Remasks NZTA register data when the caller's reveal window closes. The
 * deadline comes from the server clock (get_nzta_reveal_seconds_remaining), so
 * a wrong device clock cannot keep data on screen, and it is re-checked when
 * the tab becomes visible again after sleep or backgrounding.
 */
export function useNztaRevealExpiry({
  subjectType, subjectId, organizationId = null, enabled, onExpire,
}: {
  subjectType: 'vehicle' | 'person';
  subjectId: string | null | undefined;
  organizationId?: string | null;
  enabled: boolean;
  onExpire: () => void;
}) {
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!enabled || !subjectId) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expire = () => {
      if (!active) return;
      active = false;
      if (timer) clearTimeout(timer);
      onExpireRef.current();
    };

    const check = async () => {
      if (timer) clearTimeout(timer);
      const { data, error } = await supabase.rpc('get_nzta_reveal_seconds_remaining', {
        p_subject_type: subjectType, p_subject_id: subjectId, p_organization_id: organizationId,
      });
      if (!active) return;
      const seconds = typeof data === 'number' ? data : null;
      if (error || seconds === null || seconds <= 0) { expire(); return; }
      timer = setTimeout(() => { void check(); }, Math.min(seconds * 1000 + 250, MAX_TIMEOUT_MS));
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, subjectType, subjectId, organizationId]);
}

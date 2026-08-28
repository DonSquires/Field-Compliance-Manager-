/**
 * useEnabledModules.ts — organisation module entitlement, fail-closed for
 * safety-relevant modules
 *
 * Rebuilt per docs/ui-baseline.md ("Resolved: useEnabledModules.ts has the
 * exact same fail-open ambiguity as AdminShell — confirmed live in
 * OfficerShell"). The original hook collapsed three distinct states
 * (loading, read error, genuinely-unconfigured org) into one fail-open
 * `configured: false` outcome, which both AdminShell and OfficerShell then
 * interpreted as "show everything" — including safety-relevant modules such
 * as Welfare Monitoring, which is available platform-wide but may be
 * deliberately disabled for a given organisation.
 *
 * This rebuild exposes the four states explicitly and requires callers to
 * decide, per module, whether "unconfigured" is an acceptable rollout
 * fail-open state — "loading" and "error" are NEVER treated as authorization
 * to show a gated feature, and safety-relevant modules fail closed on every
 * state except a positively confirmed "configured" + enabled.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type ModuleGateStatus = 'loading' | 'error' | 'unconfigured' | 'configured';

export interface EnabledModulesApi {
  status: ModuleGateStatus;
  enabledModules: ReadonlySet<string>;
  /**
   * Decide whether a module should be shown/usable right now.
   *
   * - `safetyRelevant` modules (e.g. welfare/man-down) fail CLOSED unless
   *   status is 'configured' AND the module is explicitly enabled.
   * - Non-safety-relevant modules may fail OPEN only on the genuinely
   *   'unconfigured' state (a deliberate rollout allowance) — loading and
   *   error still fail closed, since neither is evidence the org intends
   *   this module to be visible.
   */
  isModuleEnabled: (moduleKey: string, options?: { safetyRelevant?: boolean }) => boolean;
}

export function useEnabledModules(organizationId: string | null | undefined): EnabledModulesApi {
  const [status, setStatus] = useState<ModuleGateStatus>('loading');
  const [enabledModules, setEnabledModules] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!organizationId) {
      setStatus('loading');
      setEnabledModules(new Set());
      return;
    }
    let cancelled = false;
    setStatus('loading');

    supabase
      .from('organization_modules')
      .select('module_key, enabled')
      .eq('organization_id', organizationId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setStatus('error');
          setEnabledModules(new Set());
          return;
        }
        const rows = data ?? [];
        if (rows.length === 0) {
          setStatus('unconfigured');
          setEnabledModules(new Set());
          return;
        }
        setEnabledModules(new Set(rows.filter((r) => r.enabled).map((r) => r.module_key)));
        setStatus('configured');
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  function isModuleEnabled(moduleKey: string, options?: { safetyRelevant?: boolean }): boolean {
    if (status === 'configured') return enabledModules.has(moduleKey);
    if (options?.safetyRelevant) return false; // fail closed: loading, error, and unconfigured all deny
    return status === 'unconfigured'; // non-critical rollout allowance; loading/error still deny
  }

  return { status, enabledModules, isModuleEnabled };
}

/**
 * useOrganization.ts — Provide organization context
 *
 * Returns org metadata, modules, settings, and permissions for the logged-in user.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

export interface Organization {
  id: string;
  name: string;
  jurisdiction?: string;
  region?: string;
  timezone?: string;
  enabled_modules: string[];
  settings?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export function useOrganization() {
  const { profile } = useAuth();
  const [org, setOrg] = useState<Organization | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchOrganization = useCallback(async () => {
    if (!profile?.organizationId) return;

    setIsLoading(true);
    setError(null);

    try {
      const { data, error: err } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', profile.organizationId)
        .single();

      if (err) throw err;

      setOrg({
        id: data.id,
        name: data.name,
        jurisdiction: data.jurisdiction,
        region: data.region,
        timezone: data.timezone,
        enabled_modules: data.enabled_modules || [],
        settings: data.settings,
        created_at: data.created_at,
        updated_at: data.updated_at,
      });
    } catch (err) {
      console.error('Error fetching organization:', err);
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [profile?.organizationId]);

  useEffect(() => {
    fetchOrganization();
  }, [fetchOrganization]);

  const isModuleEnabled = useCallback(
    (moduleKey: string) => org?.enabled_modules?.includes(moduleKey) || false,
    [org?.enabled_modules]
  );

  return {
    org,
    isLoading,
    error,
    isModuleEnabled,
    refetch: fetchOrganization,
  };
}

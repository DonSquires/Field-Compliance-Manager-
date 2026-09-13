import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useServiceRelationships } from '../context/ServiceRelationshipContext';

export type ActiveModuleContext = {
  moduleKey: string | null;
  enabled: boolean;
  organizationId: string | null;
  dominantAnchorKind: string | null;
  activeZoneId: string | null;
  activeSiteId: string | null;
  activeLocationId: string | null;
  governingJurisdictionId: string | null;
  governingJurisdictionName: string | null;
  moduleRuleSetId: string | null;
  moduleRuleSetName: string | null;
  evidenceRequirements: Record<string, unknown> | null;
  approvalPolicy: Record<string, unknown> | null;
  reportTemplateCode: string | null;
  jurisdictionRuleSetId: string | null;
  jurisdictionRuleSetName: string | null;
  jurisdictionName: string | null;
  jurisdictionRules: Record<string, unknown> | null;
  resolutionStatus: string | null;
  effectiveRules: Record<string, unknown> | null;
  policyStatus: string | null;
  loading: boolean;
  error: string | null;
};

export function useActiveModuleContext(moduleKey: string | null) {
  const { profile } = useAuth();
  const { selectedAgreement, selectedSite, selectedZone } = useServiceRelationships();
  const [state, setState] = useState<ActiveModuleContext>({
    moduleKey,
    enabled: false,
    organizationId: profile?.organizationId ?? null,
    dominantAnchorKind: null,
    activeZoneId: selectedZone?.id ?? null,
    activeSiteId: selectedSite?.id ?? null,
    activeLocationId: null,
    governingJurisdictionId: null,
    governingJurisdictionName: null,
    moduleRuleSetId: null,
    moduleRuleSetName: null,
    evidenceRequirements: null,
    approvalPolicy: null,
    reportTemplateCode: null,
    jurisdictionRuleSetId: null,
    jurisdictionRuleSetName: null,
    jurisdictionName: null,
    jurisdictionRules: null,
    resolutionStatus: null,
    effectiveRules: null,
    policyStatus: null,
    loading: true,
    error: null,
  });

  const resolve = useCallback(async () => {
    if (!profile?.organizationId || !moduleKey) {
      setState((current) => ({ ...current, loading: false, error: null, moduleKey, enabled: false }));
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null, moduleKey }));

    try {
      const { data, error: rpcError } = await supabase.rpc('resolve_active_rules', {
        p_organization_id: profile.organizationId,
        p_module_key: moduleKey,
        p_lat: null,
        p_lng: null,
        p_zone_id: selectedZone?.id ?? null,
        p_site_id: selectedSite?.id ?? null,
        p_location_id: null,
        p_at: new Date().toISOString(),
      });

      if (rpcError) throw rpcError;

      const row = Array.isArray(data) ? data[0] ?? null : null;
      if (!row) {
        setState({
          moduleKey,
          enabled: false,
          organizationId: profile.organizationId,
          dominantAnchorKind: null,
          activeZoneId: selectedZone?.id ?? null,
          activeSiteId: selectedSite?.id ?? null,
          activeLocationId: null,
          governingJurisdictionId: null,
          governingJurisdictionName: null,
          moduleRuleSetId: null,
          moduleRuleSetName: null,
          evidenceRequirements: null,
          approvalPolicy: null,
          reportTemplateCode: null,
          jurisdictionRuleSetId: null,
          jurisdictionRuleSetName: null,
          jurisdictionName: null,
          jurisdictionRules: null,
          resolutionStatus: null,
          effectiveRules: null,
          policyStatus: null,
          loading: false,
          error: null,
        });
        return;
      }

      setState({
        moduleKey,
        enabled: Boolean(row.enabled),
        organizationId: row.organization_id ?? profile.organizationId,
        dominantAnchorKind: row.dominant_anchor_kind ?? null,
        activeZoneId: row.active_zone_id ?? selectedZone?.id ?? null,
        activeSiteId: row.active_site_id ?? selectedSite?.id ?? null,
        activeLocationId: row.active_location_id ?? null,
        governingJurisdictionId: row.governing_jurisdiction_id ?? null,
        governingJurisdictionName: row.governing_jurisdiction_name ?? null,
        moduleRuleSetId: row.module_rule_set_id ?? null,
        moduleRuleSetName: row.module_rule_set_name ?? null,
        evidenceRequirements: row.evidence_requirements ?? null,
        approvalPolicy: row.approval_policy ?? null,
        reportTemplateCode: row.report_template_code ?? null,
        jurisdictionRuleSetId: row.jurisdiction_rule_set_id ?? null,
        jurisdictionRuleSetName: row.jurisdiction_rule_set_name ?? null,
        jurisdictionName: row.jurisdiction_name ?? null,
        jurisdictionRules: row.jurisdiction_rules ?? null,
        resolutionStatus: row.resolution_status ?? null,
        effectiveRules: row.effective_rules ?? null,
        policyStatus: row.policy_status ?? null,
        loading: false,
        error: null,
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        moduleKey,
        enabled: false,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to resolve module context',
      }));
    }
  }, [moduleKey, profile?.organizationId, selectedSite?.id, selectedZone?.id]);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  return useMemo(() => state, [state]);
}

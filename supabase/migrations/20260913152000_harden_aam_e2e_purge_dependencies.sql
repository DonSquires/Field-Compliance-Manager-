CREATE OR REPLACE FUNCTION public.purge_aam_e2e_dataset(p_provider_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id constant uuid := 'a1000000-0000-4000-8000-000000000001';
  v_agreement_id constant uuid := 'a1000000-0000-4000-8000-000000000004';
  v_location_id constant uuid := 'a1000000-0000-4000-8000-000000000002';
  v_site_id constant uuid := 'a1000000-0000-4000-8000-000000000003';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = v_account_id
      AND (o.parent_organization_id IS DISTINCT FROM p_provider_organization_id OR o.external_refs->>'dataset' IS DISTINCT FROM 'aam_e2e_20260831')
  ) THEN RAISE EXCEPTION 'AAM dataset identity collision'; END IF;

  DELETE FROM public.debrief_followups f WHERE f.shift_id IN (SELECT s.id FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%');
  DELETE FROM public.shift_debriefs d WHERE d.shift_id IN (SELECT s.id FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_service_item_consumption c WHERE c.shift_id IN (SELECT s.id FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_inventory_transactions t WHERE t.shift_id IN (SELECT s.id FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_service_costs c WHERE c.shift_id IN (SELECT s.id FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%');
  DELETE FROM public.shifts s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%';
  DELETE FROM public.roster_slots s WHERE s.organization_id = p_provider_organization_id AND s.notes LIKE '[AAM E2E]%';
  DELETE FROM public.shift_templates t WHERE t.organization_id = p_provider_organization_id AND t.name LIKE '[AAM E2E]%';
  DELETE FROM public.roster_work_units w WHERE w.organization_id = p_provider_organization_id AND w.name LIKE '[AAM E2E]%';
  DELETE FROM public.crm_activation_handoff_tasks t USING public.crm_activation_handoffs h WHERE t.handoff_id = h.id AND h.account_organization_id = v_account_id;
  DELETE FROM public.crm_activation_handoffs h WHERE h.account_organization_id = v_account_id;
  DELETE FROM public.crm_onboarding_events e WHERE e.account_organization_id = v_account_id;
  DELETE FROM public.crm_onboarding_ledgers l WHERE l.account_organization_id = v_account_id;
  DELETE FROM public.geofence_boundary_history h WHERE (h.entity_type = 'client_site' AND h.entity_id = v_site_id) OR (h.entity_type = 'location_zone' AND h.entity_id IN (SELECT z.id FROM public.location_zones z WHERE z.location_id = v_location_id));
  DELETE FROM public.service_agreement_locations l WHERE l.service_agreement_id = v_agreement_id;
  DELETE FROM public.service_agreement_modules m WHERE m.service_agreement_id = v_agreement_id;
  DELETE FROM public.crm_commercial_settings c WHERE c.service_agreement_id = v_agreement_id;
  DELETE FROM public.crm_contacts c WHERE c.organization_id = v_account_id;
  DELETE FROM public.location_zones z WHERE z.location_id = v_location_id;
  DELETE FROM public.client_sites s WHERE s.id = v_site_id;
  DELETE FROM public.locations l WHERE l.id = v_location_id;
  DELETE FROM public.service_agreements a WHERE a.id = v_agreement_id;
  DELETE FROM public.organizations o WHERE o.id = v_account_id;
  RETURN jsonb_build_object('purged', true, 'dataset', 'aam_e2e_20260831');
END;
$$;

REVOKE ALL ON FUNCTION public.purge_aam_e2e_dataset(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_aam_e2e_dataset(uuid) TO service_role;

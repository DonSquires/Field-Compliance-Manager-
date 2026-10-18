DO $$
DECLARE
  v_canonical_org constant uuid := 'ae297f06-1c15-478a-9337-5704b3522d5b';
  v_legacy_org constant uuid := '6e5bb295-27f9-4ac0-b6f7-81a648c2b73f';
  v_provider_org constant uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_operational_agreement constant uuid := 'e53834ad-0a20-4d84-ba31-c7dbbb611939';
  v_operational_site constant uuid := '93637e49-8cfa-45ed-8c86-737d28a72adf';
  v_operational_location constant uuid := '2d2a62d7-e673-40ed-bd63-ab3de21dc6d1';
  v_platform_placeholder_site constant uuid := '66b16b6a-b396-4f39-9473-d0b0afdd048c';
  v_platform_location_link constant uuid := '45357c53-012c-42cb-b07c-3b3c8e8bf6a5';
  v_test_work_unit constant uuid := '3ea092e9-1d05-4c4a-ba4b-8ee7d931b32e';
  v_rows integer;
BEGIN
  PERFORM 1
  FROM public.organizations
  WHERE id = v_canonical_org
    AND name = 'NMDHB'
    AND organization_type = 'government'
    AND active
    AND status = 'active'
    AND parent_organization_id IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical own-rooted NMDHB organization does not match the reviewed identity';
  END IF;

  PERFORM 1
  FROM public.organizations
  WHERE id = v_legacy_org
    AND name = 'NMDHB'
    AND organization_type = 'client'
    AND status = 'prospect'
    AND NOT active
    AND parent_organization_id = v_provider_org
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Legacy NMDHB prospect shell does not match the reviewed identity';
  END IF;

  IF (SELECT count(*) FROM public.locations WHERE organization_id = v_legacy_org) <> 1
     OR (SELECT count(*) FROM public.client_sites WHERE client_organization_id = v_legacy_org) <> 1
     OR (SELECT count(*) FROM public.location_zones WHERE organization_id = v_legacy_org) <> 1
     OR (SELECT count(*) FROM public.service_agreements WHERE client_organization_id = v_legacy_org) <> 1
     OR (SELECT count(*) FROM public.crm_contacts WHERE organization_id = v_legacy_org) <> 1 THEN
    RAISE EXCEPTION 'Legacy NMDHB operational surface changed after review';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.service_agreements agreement
    JOIN public.service_agreement_modules module
      ON module.service_agreement_id = agreement.id
    WHERE agreement.id = v_operational_agreement
      AND agreement.provider_organization_id = v_provider_org
      AND agreement.client_organization_id = v_legacy_org
      AND agreement.agreement_type = 'operational'
      AND module.module_key = 'static_guarding'
      AND module.enabled
  ) THEN
    RAISE EXCEPTION 'Reviewed NMDHB static agreement was not found';
  END IF;

  UPDATE public.locations
  SET organization_id = v_canonical_org
  WHERE id = v_operational_location
    AND organization_id = v_legacy_org;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Expected to re-home one NMDHB location'; END IF;

  UPDATE public.canonical_place_links
  SET organization_id = v_canonical_org
  WHERE organization_id = v_legacy_org
    AND source_table = 'locations'
    AND source_id = v_operational_location;

  UPDATE public.boundary_proposals
  SET organization_id = v_canonical_org
  WHERE organization_id = v_legacy_org;

  UPDATE public.client_sites
  SET client_organization_id = v_canonical_org,
      organization_id = v_canonical_org,
      external_refs = external_refs || jsonb_build_object(
        'organization_consolidation',
        jsonb_build_object(
          'from_organization_id', v_legacy_org,
          'to_organization_id', v_canonical_org,
          'reviewed_on', current_date
        )
      )
  WHERE id = v_operational_site
    AND client_organization_id = v_legacy_org
    AND organization_id = v_legacy_org;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Expected to re-home one NMDHB site'; END IF;

  UPDATE public.location_zones
  SET organization_id = v_canonical_org
  WHERE organization_id = v_legacy_org
    AND location_id = v_operational_location;

  UPDATE public.crm_contacts
  SET organization_id = v_canonical_org
  WHERE organization_id = v_legacy_org;

  UPDATE public.service_agreements
  SET client_organization_id = v_canonical_org,
      external_refs = external_refs || jsonb_build_object(
        'organization_consolidation',
        jsonb_build_object(
          'from_organization_id', v_legacy_org,
          'to_organization_id', v_canonical_org,
          'reviewed_on', current_date
        )
      )
  WHERE id = v_operational_agreement
    AND client_organization_id = v_legacy_org;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'Expected to re-home one NMDHB operational agreement'; END IF;

  UPDATE public.roster_work_units
  SET active = false,
      updated_at = clock_timestamp()
  WHERE id = v_test_work_unit
    AND organization_id = v_provider_org
    AND name = 'Test'
    AND service_type = 'static_guarding';

  UPDATE public.service_agreement_locations
  SET status = 'ended',
      updated_at = clock_timestamp()
  WHERE id = v_platform_location_link
    AND status = 'active'
    AND service_agreement_id IN (
      SELECT id
      FROM public.service_agreements
      WHERE agreement_type = 'financial'
        AND client_organization_id = v_canonical_org
    );

  UPDATE public.client_sites
  SET active = false,
      name = 'Auto Onboarded Site - NMDHB (legacy platform placeholder)',
      external_refs = external_refs || jsonb_build_object(
        'retirement_reason',
        'Layer-1 platform billing agreement must not own an operational place'
      )
  WHERE id = v_platform_placeholder_site
    AND client_organization_id = v_canonical_org
    AND site_origin = 'contracted';

  UPDATE public.organizations
  SET name = 'NMDHB (legacy R&M prospect shell)',
      parent_organization_id = NULL,
      status = 'archived',
      active = false,
      discoverable = false,
      account_notes = concat_ws(
        E'\n\n',
        nullif(account_notes, ''),
        'Merged ' || current_date || ': operational agreement, place, zone, contact, and static work configuration moved to canonical own-rooted NMDHB organization ' || v_canonical_org || '. Shell retained for audit history.'
      )
  WHERE id = v_legacy_org;

  INSERT INTO public.audit_log(
    organization_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_canonical_org,
    'nmdhb_organization_consolidated',
    'organizations',
    v_canonical_org,
    jsonb_build_object(
      'legacy_organization_id', v_legacy_org,
      'provider_organization_id', v_provider_org,
      'operational_agreement_id', v_operational_agreement,
      'operational_site_id', v_operational_site,
      'owner_decision', 'consolidate_onto_own_rooted_government_organization',
      'retained_legacy_shell', true
    )
  );
END;
$$;

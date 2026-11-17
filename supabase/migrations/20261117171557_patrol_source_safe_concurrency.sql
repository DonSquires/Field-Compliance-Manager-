-- Preserve existing import semantics while preventing conflicting payload overwrites and stale source updates.

CREATE OR REPLACE FUNCTION "public"."stage_patrol_import_chunk_unlocked"(p_batch_id uuid, p_provider_organization_id uuid, p_client_organization_id uuid, p_observations jsonb, p_events jsonb, p_proposals jsonb)
 RETURNS TABLE(obs_inserted integer, obs_matched integer, evt_inserted integer, evt_matched integer, proposal_candidates integer, proposals_inserted integer, proposals_existing integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_obs jsonb; v_evt jsonb; v_proposal jsonb;
  v_existing_obs public.observations%rowtype; v_existing_evt public.location_events%rowtype;
  v_vehicle_id uuid; v_plate text; v_zone_id uuid; v_site_id uuid; v_officer_id uuid;
  v_distance numeric; v_rows integer;
  v_obs_inserted integer := 0; v_obs_matched integer := 0;
  v_evt_inserted integer := 0; v_evt_matched integer := 0; v_proposals_inserted integer := 0;
  v_source_hash text;
BEGIN
  IF v_actor IS NULL OR NOT public.is_tenant_import_admin(p_provider_organization_id) THEN RAISE EXCEPTION 'Tenant import administrator required'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.organization_id <> p_provider_organization_id OR v_batch.status <> 'staging' THEN RAISE EXCEPTION 'Open provider import batch required'; END IF;
  IF v_batch.manifest_json->>'target_client_organization_id' <> p_client_organization_id::text THEN RAISE EXCEPTION 'Import batch client mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.service_agreements agreement
    WHERE agreement.provider_organization_id = p_provider_organization_id
      AND agreement.client_organization_id = p_client_organization_id
      AND agreement.agreement_type = 'operational'
      AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
      AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
  ) THEN RAISE EXCEPTION 'Active operational provider-client agreement required'; END IF;
  IF jsonb_typeof(p_observations) <> 'array' OR jsonb_typeof(p_events) <> 'array' OR jsonb_typeof(p_proposals) <> 'array' THEN RAISE EXCEPTION 'Import chunk values must be arrays'; END IF;
  v_source_hash := v_batch.source_sha256;

  FOR v_obs IN SELECT * FROM jsonb_array_elements(p_observations) LOOP
    v_zone_id := NULLIF(v_obs->>'zone_id', '')::uuid;
    v_site_id := NULLIF(v_obs->>'site_id', '')::uuid;
    v_officer_id := NULLIF(v_obs->>'officer_id', '')::uuid;
    IF v_zone_id IS NULL AND v_site_id IS NULL THEN RAISE EXCEPTION 'Observation import requires a resolved place'; END IF;
    IF v_obs->'payload'->>'source_sha256' <> v_source_hash THEN RAISE EXCEPTION 'Observation source hash does not match its batch'; END IF;
    IF v_obs->'payload'->>'source_file' IS DISTINCT FROM v_batch.source_file THEN RAISE EXCEPTION 'Observation source file does not match its batch'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_profiles profile WHERE profile.id = v_officer_id AND profile.deactivated_at IS NULL AND (profile.organization_id = p_provider_organization_id OR profile.employer_organization_id = p_provider_organization_id)) THEN RAISE EXCEPTION 'Observation officer does not belong to the provider'; END IF;
    IF v_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones zone WHERE zone.id = v_zone_id AND zone.organization_id = p_client_organization_id) THEN RAISE EXCEPTION 'Observation zone does not belong to the client'; END IF;
    IF v_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites site WHERE site.id = v_site_id AND (site.client_organization_id = p_client_organization_id OR site.organization_id = p_client_organization_id)) THEN RAISE EXCEPTION 'Observation site does not belong to the client'; END IF;
    IF EXISTS (SELECT 1 FROM public.location_events event
      WHERE event.organization_id = p_client_organization_id AND event.external_ref = v_obs->>'external_ref')
      THEN RAISE EXCEPTION 'Source reference is used by another evidence kind'; END IF;

    SELECT * INTO v_existing_obs FROM public.observations
    WHERE organization_id = p_client_organization_id AND external_refs->>'external_ref' = v_obs->>'external_ref'
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing_obs.external_refs->'import'->>'source' IS DISTINCT FROM 'rm_patrol_log_import' THEN
        RAISE EXCEPTION 'Observation external reference is not owned by this importer';
      END IF;
      IF nullif(v_existing_obs.external_refs->'import'->>'source_sha256', '') IS NOT NULL
         AND v_existing_obs.external_refs->'import'->>'source_sha256' <> v_source_hash THEN RAISE EXCEPTION 'Observation source version conflict requires reconciliation'; END IF;
      IF v_existing_obs.officer_id IS DISTINCT FROM v_officer_id OR upper(v_existing_obs.plate_number) IS DISTINCT FROM upper(v_obs->>'plate')
         OR v_existing_obs.zone_id IS DISTINCT FROM v_zone_id OR v_existing_obs.site_id IS DISTINCT FROM v_site_id
         OR v_existing_obs.observed_at IS DISTINCT FROM (v_obs->>'occurred_at')::timestamptz
         OR (v_obs->>'officer_notes' IS NOT NULL AND v_existing_obs.officer_notes IS DISTINCT FROM v_obs->>'officer_notes')
         THEN RAISE EXCEPTION 'Observation core fields conflict with existing evidence'; END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_each(jsonb_strip_nulls(v_obs->'payload')) item
        WHERE v_existing_obs.external_refs->'import' ? item.key
          AND v_existing_obs.external_refs->'import'->item.key IS DISTINCT FROM 'null'::jsonb
          AND jsonb_strip_nulls(v_existing_obs.external_refs->'import'->item.key) IS DISTINCT FROM item.value
      ) THEN RAISE EXCEPTION 'Observation payload conflict requires reconciliation'; END IF;
      v_distance := CASE WHEN v_obs->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN (v_obs->'payload'->>'job_kms')::numeric ELSE NULL END;
      UPDATE public.observations SET
        external_refs = jsonb_set(coalesce(external_refs, '{}'::jsonb), '{import}', coalesce(external_refs->'import', '{}'::jsonb) || jsonb_strip_nulls(v_obs->'payload'), true),
        distance_km = coalesce(distance_km, v_distance)
      WHERE id = v_existing_obs.id;
      v_obs_matched := v_obs_matched + 1;
    ELSE
      v_plate := v_obs->>'plate';
      SELECT id INTO v_vehicle_id FROM public.canonical_vehicles WHERE upper(plate_number) = upper(v_plate) LIMIT 1;
      IF v_vehicle_id IS NULL THEN INSERT INTO public.canonical_vehicles(plate_number, compliance_source) VALUES(v_plate, 'canonical') RETURNING id INTO v_vehicle_id; END IF;
      INSERT INTO public.observations(organization_id, officer_id, plate_number, zone_id, site_id, observed_at, module_key, canonical_vehicle_id, officer_notes, plate_source, external_refs, distance_km)
      VALUES(p_client_organization_id, v_officer_id, v_plate, v_zone_id, v_site_id, (v_obs->>'occurred_at')::timestamptz, 'patrol', v_vehicle_id, v_obs->>'officer_notes', 'manual',
        jsonb_build_object('external_ref', v_obs->>'external_ref', 'import', v_obs->'payload'),
        CASE WHEN v_obs->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN (v_obs->'payload'->>'job_kms')::numeric ELSE NULL END);
      v_obs_inserted := v_obs_inserted + 1;
    END IF;
  END LOOP;

  FOR v_evt IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    v_zone_id := NULLIF(v_evt->>'zone_id', '')::uuid;
    v_site_id := NULLIF(v_evt->>'site_id', '')::uuid;
    v_officer_id := NULLIF(v_evt->>'observed_entity_id', '')::uuid;
    IF v_zone_id IS NULL AND v_site_id IS NULL THEN RAISE EXCEPTION 'Location event import requires a resolved place'; END IF;
    IF v_evt->'payload'->>'source_sha256' <> v_source_hash THEN RAISE EXCEPTION 'Location event source hash does not match its batch'; END IF;
    IF v_evt->'payload'->>'source_file' IS DISTINCT FROM v_batch.source_file THEN RAISE EXCEPTION 'Location event source file does not match its batch'; END IF;
    IF v_officer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_profiles profile WHERE profile.id = v_officer_id AND profile.deactivated_at IS NULL AND (profile.organization_id = p_provider_organization_id OR profile.employer_organization_id = p_provider_organization_id)) THEN RAISE EXCEPTION 'Location event staff does not belong to the provider'; END IF;
    IF v_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones zone WHERE zone.id = v_zone_id AND zone.organization_id = p_client_organization_id) THEN RAISE EXCEPTION 'Location event zone does not belong to the client'; END IF;
    IF v_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites site WHERE site.id = v_site_id AND (site.client_organization_id = p_client_organization_id OR site.organization_id = p_client_organization_id)) THEN RAISE EXCEPTION 'Location event site does not belong to the client'; END IF;
    IF EXISTS (SELECT 1 FROM public.observations observation
      WHERE observation.organization_id = p_client_organization_id AND observation.external_refs->>'external_ref' = v_evt->>'external_ref')
      THEN RAISE EXCEPTION 'Source reference is used by another evidence kind'; END IF;

    SELECT * INTO v_existing_evt FROM public.location_events
    WHERE organization_id = p_client_organization_id AND external_ref = v_evt->>'external_ref'
    FOR UPDATE;
    IF FOUND THEN
      IF v_existing_evt.source IS DISTINCT FROM 'rm_patrol_log_import' THEN
        RAISE EXCEPTION 'Location event external reference is not owned by this importer';
      END IF;
      IF nullif(v_existing_evt.payload->>'source_sha256', '') IS NOT NULL AND v_existing_evt.payload->>'source_sha256' <> v_source_hash THEN RAISE EXCEPTION 'Location event source version conflict requires reconciliation'; END IF;
      IF v_existing_evt.zone_id IS DISTINCT FROM v_zone_id OR v_existing_evt.client_site_id IS DISTINCT FROM v_site_id
         OR v_existing_evt.observed_entity_id IS DISTINCT FROM v_officer_id
         OR v_existing_evt.occurred_at IS DISTINCT FROM (v_evt->>'occurred_at')::timestamptz
         OR v_existing_evt.event_type IS DISTINCT FROM v_evt->>'event_type'
         OR (v_evt->>'status' IS NOT NULL AND v_existing_evt.status IS DISTINCT FROM v_evt->>'status')
         OR (v_evt->>'observed_entity_type' IS NOT NULL AND v_existing_evt.observed_entity_type IS DISTINCT FROM v_evt->>'observed_entity_type')
         THEN RAISE EXCEPTION 'Location event core fields conflict with existing evidence'; END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_each(jsonb_strip_nulls(v_evt->'payload')) item
        WHERE v_existing_evt.payload ? item.key
          AND v_existing_evt.payload->item.key IS DISTINCT FROM 'null'::jsonb
          AND jsonb_strip_nulls(v_existing_evt.payload->item.key) IS DISTINCT FROM item.value
      ) THEN RAISE EXCEPTION 'Location event payload conflict requires reconciliation'; END IF;
      v_distance := CASE WHEN v_evt->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN (v_evt->'payload'->>'job_kms')::numeric ELSE NULL END;
      UPDATE public.location_events SET payload = coalesce(payload, '{}'::jsonb) || jsonb_strip_nulls(v_evt->'payload'), distance_km = coalesce(distance_km, v_distance) WHERE id = v_existing_evt.id;
      v_evt_matched := v_evt_matched + 1;
    ELSE
      PERFORM public.create_location_event(
        p_organization_id => p_client_organization_id, p_event_type => v_evt->>'event_type', p_client_site_id => v_site_id, p_zone_id => v_zone_id,
        p_module_key => 'patrol', p_occurred_at => (v_evt->>'occurred_at')::timestamptz, p_status => v_evt->>'status',
        p_source => 'rm_patrol_log_import', p_external_ref => v_evt->>'external_ref', p_payload => v_evt->'payload',
        p_observed_entity_type => v_evt->>'observed_entity_type', p_observed_entity_id => v_officer_id,
        p_provider_organization_id => p_provider_organization_id, p_client_organization_id => p_client_organization_id
      );
      IF v_evt->'payload'->>'job_kms' ~ '^[0-9]+([.][0-9]+)?$' THEN UPDATE public.location_events SET distance_km = (v_evt->'payload'->>'job_kms')::numeric WHERE organization_id = p_client_organization_id AND external_ref = v_evt->>'external_ref'; END IF;
      v_evt_inserted := v_evt_inserted + 1;
    END IF;
  END LOOP;

  FOR v_proposal IN SELECT * FROM jsonb_array_elements(p_proposals) LOOP
    IF v_proposal->>'target_type' NOT IN ('workshop_work_order', 'finance_service_cost') THEN RAISE EXCEPTION 'Unsupported import proposal target'; END IF;
    IF v_proposal->'source_values'->>'source_sha256' <> v_source_hash THEN RAISE EXCEPTION 'Proposal source hash does not match its batch'; END IF;
    IF v_proposal->'source_values'->>'source_file' IS DISTINCT FROM v_batch.source_file THEN RAISE EXCEPTION 'Proposal source file does not match its batch'; END IF;
    IF v_proposal->'proposed_payload'->>'organization_id' <> p_provider_organization_id::text OR v_proposal->'proposed_payload'->>'client_organization_id' <> p_client_organization_id::text THEN RAISE EXCEPTION 'Proposal organization scope mismatch'; END IF;
    IF v_proposal->>'target_type' = 'workshop_work_order' THEN
      IF NOT EXISTS (SELECT 1 FROM public.reference_codes code WHERE code.id = (v_proposal->'proposed_payload'->>'work_subject_code_id')::uuid AND code.organization_id = p_provider_organization_id AND code.code_type = 'work_subject' AND code.is_active) THEN RAISE EXCEPTION 'Proposal work subject is invalid'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.reference_codes code WHERE code.id = (v_proposal->'proposed_payload'->>'work_activity_code_id')::uuid AND code.organization_id = p_provider_organization_id AND code.code_type = 'work_activity' AND code.is_active) THEN RAISE EXCEPTION 'Proposal work activity is invalid'; END IF;
    END IF;
    INSERT INTO public.file_import_row_proposals(organization_id,batch_id,source_record_key,source_row_number,target_type,proposed_payload,source_values,confidence,created_by)
    VALUES(p_provider_organization_id,p_batch_id,v_proposal->>'source_record_key',NULLIF(v_proposal->>'source_row_number','')::integer,v_proposal->>'target_type',v_proposal->'proposed_payload',v_proposal->'source_values',NULLIF(v_proposal->>'confidence','')::numeric,v_actor)
    ON CONFLICT(batch_id,source_record_key,target_type) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_proposals_inserted := v_proposals_inserted + v_rows;
  END LOOP;

  RETURN QUERY SELECT v_obs_inserted, v_obs_matched, v_evt_inserted, v_evt_matched,
    jsonb_array_length(p_proposals), v_proposals_inserted, jsonb_array_length(p_proposals) - v_proposals_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."apply_patrol_source_updates"(p_batch_id uuid, p_provider_organization_id uuid, p_client_organization_id uuid, p_updates jsonb)
 RETURNS TABLE(external_ref text, record_id uuid, outcome text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_desired jsonb;
  v_payload jsonb;
  v_kind text;
  v_ref text;
  v_id uuid;
  v_version public.patrol_import_record_versions%rowtype;
  v_observation public.observations%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_zone uuid;
  v_site uuid;
  v_officer uuid;
  v_occurred timestamptz;
  v_distance numeric;
  v_plate text;
  v_vehicle uuid;
  v_hold text;
  v_lock_key text;
  v_updated integer := 0;
  v_ignored constant text[] := array['source', 'source_file', 'source_sheet', 'source_row', 'source_sha256', 'derivative_sha256',
    'classification_profile', 'source_profile', 'evidence_record_type', 'evidence_external_ref', 'client_organization_id'];
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 500 then
    raise exception 'Between 0 and 500 update rows are required per call';
  end if;

  for v_lock_key in
    select distinct value->>'external_ref' as lock_key
    from jsonb_array_elements(p_updates) value
    where nullif(value->>'external_ref', '') is not null
    order by lock_key
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_lock_key, 0));
  end loop;
  for v_lock_key in
    select distinct upper(btrim(value->'desired'->>'plate')) as lock_key
    from jsonb_array_elements(p_updates) value
    where value->>'kind' = 'observation' and nullif(btrim(value->'desired'->>'plate'), '') is not null
    order by lock_key
  loop
    perform pg_advisory_xact_lock(hashtextextended('vehicle:' || v_lock_key, 0));
  end loop;

  for v_item in
    select value from jsonb_array_elements(p_updates) value order by value->>'kind', value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    if coalesce(v_item->>'prior_source_fingerprint', '') !~ '^[a-f0-9]{64}$' then
      raise exception 'Source updates require the prior source fingerprint';
    end if;
    v_kind := v_item->>'kind';
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';
    v_hold := null;
    if (v_kind = 'event' and exists (
      select 1 from public.observations observation
      where observation.organization_id = p_client_organization_id and observation.external_refs->>'external_ref' = v_ref
    )) or (v_kind = 'observation' and exists (
      select 1 from public.location_events event
      where event.organization_id = p_client_organization_id and event.external_ref = v_ref
    )) then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'ambiguous_record_key';
      return next; continue;
    end if;

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = v_kind and version.record_id = v_id and version.is_current
    for update;
    if not found then
      v_hold := 'source_baseline_required';
    elsif v_version.client_organization_id <> p_client_organization_id
       or v_version.provider_organization_id <> p_provider_organization_id
       or v_version.external_ref <> v_ref then
      raise exception 'Source history scope does not match the requested record';
    elsif v_version.source_fingerprint = v_item->>'source_fingerprint' and v_version.batch_id = p_batch_id then
      external_ref := v_ref; record_id := v_id; outcome := 'already_applied'; detail := null;
      return next; continue;
    elsif v_version.source_fingerprint <> v_item->>'prior_source_fingerprint' then
      v_hold := 'stale_source_comparison';
    elsif v_version.source_file <> v_payload->>'source_file'
       or v_version.source_sheet is distinct from v_payload->>'source_sheet'
       or v_version.source_profile <> v_payload->>'classification_profile' then
      v_hold := 'source_identity_changed';
    end if;

    if v_hold is null then
      if v_kind = 'event' then
        perform 1 from public.location_events event
        where event.id = v_id and event.organization_id = p_client_organization_id for update;
      else
        perform 1 from public.observations observation
        where observation.id = v_id and observation.organization_id = p_client_organization_id for update;
      end if;
      v_before := public.patrol_source_record_state(v_kind, v_id);
      if v_before is null then
        v_hold := 'previously_linked_record_missing';
      elsif v_before is distinct from v_version.state_after then
        v_hold := 'fcm_record_changed_since_last_sync';
      end if;
    end if;

    if v_hold is null then
      v_occurred := (v_desired->>'occurred_at')::timestamptz;
      v_zone := nullif(v_desired->>'zone_id', '')::uuid;
      v_site := nullif(v_desired->>'site_id', '')::uuid;
      v_officer := nullif(v_desired->>(case when v_kind = 'event' then 'observed_entity_id' else 'officer_id' end), '')::uuid;
      v_distance := case when v_desired->'distance_km' is null or jsonb_typeof(v_desired->'distance_km') = 'null'
        then null else (v_desired->>'distance_km')::numeric end;
      if (v_zone is null) = (v_site is null) then
        v_hold := 'one_resolved_place_required';
      elsif v_distance is not null and v_distance < 0 then
        v_hold := 'invalid_source_distance';
      elsif (v_zone is not null and not exists (
        select 1 from public.location_zones zone
        join public.locations house on house.id = zone.location_id
        where zone.id = v_zone and house.organization_id = p_client_organization_id
      )) or (v_site is not null and not exists (
        select 1 from public.client_sites site
        join public.locations house on house.id = site.location_id
        where site.id = v_site and house.organization_id = p_client_organization_id
      )) then
        v_hold := 'source_place_owner_mismatch';
      elsif not exists (
        select 1 from public.service_agreements agreement
        join public.service_agreement_modules module
          on module.service_agreement_id = agreement.id and module.module_key = 'patrol' and module.enabled
        join public.service_agreement_locations location
          on location.service_agreement_id = agreement.id and location.status = 'active'
        where agreement.provider_organization_id = p_provider_organization_id
          and agreement.client_organization_id = p_client_organization_id
          and agreement.agreement_type = 'operational'
          and (agreement.starts_on is null or agreement.starts_on <= current_date)
          and (agreement.ends_on is null or agreement.ends_on >= current_date)
          and ((v_zone is not null and location.zone_id = v_zone) or (v_site is not null and location.site_id = v_site))
      ) then
        v_hold := 'place_outside_contracted_patrol_coverage';
      elsif (v_officer is not null or v_kind = 'observation') and not exists (
        select 1 from public.user_profiles profile
        where profile.id = v_officer and profile.deactivated_at is null
          and (profile.organization_id = p_provider_organization_id or profile.employer_organization_id = p_provider_organization_id)
      ) then
        v_hold := 'source_staff_not_active_for_provider';
      elsif exists (
        select 1
        from public.file_import_row_proposals proposal
        cross join lateral jsonb_each(proposal.source_values) source_value
        where proposal.organization_id = p_provider_organization_id
          and proposal.source_record_key = v_ref
          -- Only an undecided or unapplied review of the old values blocks the edit; applied
          -- outcomes are revisited through the fresh proposal staged in this batch.
          and proposal.batch_id <> p_batch_id
          and proposal.status in ('proposed', 'approved')
          and source_value.key <> all (v_ignored)
          and v_payload ? source_value.key
          and v_payload->source_value.key is distinct from source_value.value
      ) then
        v_hold := 'dependent_proposal_review_required';
      end if;
    end if;

    if v_hold is null and v_kind = 'event' and exists (
      select 1 from public.location_events event
      where event.id = v_id
        and (event.zone_id is distinct from v_zone or event.client_site_id is distinct from v_site)
    ) then
      v_hold := 'source_place_difference_requires_review';
    end if;

    if v_hold is null and v_kind = 'observation' then
      select * into v_observation from public.observations where id = v_id for update;
      v_plate := upper(btrim(v_desired->>'plate'));
      if nullif(v_plate, '') is null then
        v_hold := 'observation_plate_required';
      elsif v_observation.locked_at is not null and (
        v_observation.observed_at is distinct from v_occurred
        or upper(v_observation.plate_number) is distinct from v_plate
        or v_observation.officer_id is distinct from v_officer
        or v_observation.zone_id is distinct from v_zone
        or v_observation.site_id is distinct from v_site
      ) then
        v_hold := 'locked_evidence_requires_correction_review';
      elsif v_observation.zone_id is distinct from v_zone or v_observation.site_id is distinct from v_site then
        v_hold := 'source_place_difference_requires_review';
      end if;
    end if;

    if v_hold is not null then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := v_hold;
      return next; continue;
    end if;

    if v_kind = 'event' then
      update public.location_events event
      set occurred_at = v_occurred,
          zone_id = v_zone,
          client_site_id = v_site,
          observed_entity_id = v_officer,
          observed_entity_type = v_desired->>'observed_entity_type',
          event_type = v_desired->>'event_type',
          status = v_desired->>'status',
          distance_km = v_distance,
          payload = v_payload
      where event.id = v_id and event.organization_id = p_client_organization_id
        and event.external_ref = v_ref and event.source = 'rm_patrol_log_import';
    else
      if upper(v_observation.plate_number) is distinct from v_plate then
        select id into v_vehicle from public.canonical_vehicles where upper(plate_number) = v_plate limit 1;
        if v_vehicle is null then
          insert into public.canonical_vehicles(plate_number, compliance_source) values (v_plate, 'canonical') returning id into v_vehicle;
        end if;
      else
        v_vehicle := v_observation.canonical_vehicle_id;
      end if;
      update public.observations observation
      set observed_at = v_occurred,
          -- Plate identity is case-insensitive; keep the stored spelling so locked evidence is not rewritten.
          plate_number = case when upper(observation.plate_number) = v_plate then observation.plate_number else v_plate end,
          canonical_vehicle_id = v_vehicle,
          zone_id = v_zone,
          site_id = v_site,
          officer_id = v_officer,
          officer_notes = v_desired->>'officer_notes',
          distance_km = v_distance,
          external_refs = jsonb_set(coalesce(observation.external_refs, '{}'::jsonb), '{import}', v_payload, true)
      where observation.id = v_id and observation.organization_id = p_client_organization_id
        and observation.external_refs->>'external_ref' = v_ref;
    end if;
    if not found then
      raise exception 'Source update target changed during synchronisation';
    end if;

    v_after := public.patrol_source_record_state(v_kind, v_id);
    v_changed := public.patrol_source_state_diff(v_before, v_after);

    update public.patrol_import_record_versions set is_current = false where id = v_version.id;
    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      v_version.version_no + 1, 'update', v_changed, v_before, v_after, auth.uid()
    );

    insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    values (p_provider_organization_id, auth.uid(), 'patrol_source_row_updated',
      case v_kind when 'event' then 'location_events' else 'observations' end, v_id,
      jsonb_build_object('batch_id', p_batch_id, 'client_organization_id', p_client_organization_id,
        'external_ref', v_ref, 'version_no', v_version.version_no + 1, 'changed_fields', to_jsonb(v_changed),
        'source_file', v_payload->>'source_file', 'source_sheet', v_payload->>'source_sheet',
        'source_row', (v_payload->>'source_row')::integer, 'source_sha256', v_payload->>'source_sha256'));

    v_updated := v_updated + 1;
    external_ref := v_ref; record_id := v_id; outcome := 'updated'; detail := array_to_string(v_changed, ',');
    return next;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."tg_observations_enforce_lock"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if old.locked_at is not null then
    if new.locked_at is distinct from old.locked_at then
      raise exception
        'observation % is locked. locked_at may not be cleared or rewritten. Use the authorised correction path.',
        old.id
        using errcode = 'P0001';
    end if;
    if (
      new.observed_at       is distinct from old.observed_at       or
      new.gps_lat           is distinct from old.gps_lat           or
      new.gps_lng           is distinct from old.gps_lng           or
      new.plate_number      is distinct from old.plate_number      or
      new.is_compliant      is distinct from old.is_compliant      or
      new.compliance_reason is distinct from old.compliance_reason or
      new.officer_id        is distinct from old.officer_id        or
      new.zone_id           is distinct from old.zone_id           or
      new.site_id           is distinct from old.site_id
    ) then
      raise exception
        'observation % is locked (locked_at = %). Frozen fact fields may not be edited after lock. Authorised corrections require the correction workflow (Part 2, not yet built).',
        old.id, old.locked_at
        using errcode = 'P0001';
    end if;
  end if;

  if old.locked_at is null and new.locked_at is not null then
    if (
      new.observed_at       is distinct from old.observed_at       or
      new.gps_lat           is distinct from old.gps_lat           or
      new.gps_lng           is distinct from old.gps_lng           or
      new.plate_number      is distinct from old.plate_number      or
      new.is_compliant      is distinct from old.is_compliant      or
      new.compliance_reason is distinct from old.compliance_reason or
      new.officer_id        is distinct from old.officer_id        or
      new.zone_id           is distinct from old.zone_id           or
      new.site_id           is distinct from old.site_id
    ) then
      raise exception
        'observation % cannot be locked with mutated frozen fields. Frozen fact fields must be unchanged at the moment of lock.',
        old.id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."adopt_patrol_source_baseline"(p_batch_id uuid, p_provider_organization_id uuid, p_client_organization_id uuid, p_records jsonb)
 RETURNS TABLE(external_ref text, record_id uuid, outcome text, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch public.file_import_batches%rowtype;
  v_item jsonb;
  v_desired jsonb;
  v_payload jsonb;
  v_kind text;
  v_ref text;
  v_id uuid;
  v_version public.patrol_import_record_versions%rowtype;
  v_existing jsonb;
  v_current jsonb;
  v_target jsonb;
  v_before jsonb;
  v_after jsonb;
  v_mismatch text[];
  v_lock_key text;
  v_provenance constant text[] := array['source', 'source_file', 'source_sheet', 'source_row', 'source_sha256', 'derivative_sha256', 'classification_profile'];
begin
  v_batch := public.patrol_source_sync_batch(p_batch_id, p_provider_organization_id, p_client_organization_id);
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception 'Between 0 and 500 baseline rows are required per call';
  end if;

  for v_lock_key in
    select distinct value->>'external_ref' as lock_key
    from jsonb_array_elements(p_records) value
    where nullif(value->>'external_ref', '') is not null
    order by lock_key
  loop
    perform pg_advisory_xact_lock(hashtextextended(p_client_organization_id::text || ':evidence:' || v_lock_key, 0));
  end loop;

  for v_item in
    select value from jsonb_array_elements(p_records) value order by value->>'kind', value->>'external_ref'
  loop
    v_payload := public.patrol_source_assert_row_provenance(v_batch, v_item);
    v_kind := v_item->>'kind';
    v_ref := v_item->>'external_ref';
    v_id := (v_item->>'record_id')::uuid;
    v_desired := v_item->'desired';

    if (v_kind = 'event' and exists (
      select 1 from public.observations observation
      where observation.organization_id = p_client_organization_id and observation.external_refs->>'external_ref' = v_ref
    )) or (v_kind = 'observation' and exists (
      select 1 from public.location_events event
      where event.organization_id = p_client_organization_id and event.external_ref = v_ref
    )) then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'ambiguous_record_key';
      return next; continue;
    end if;

    if v_kind = 'event' then
      select event.payload into v_existing from public.location_events event
      where event.id = v_id and event.organization_id = p_client_organization_id
        and event.external_ref = v_ref and event.source = 'rm_patrol_log_import'
      for update;
    else
      select observation.external_refs->'import' into v_existing from public.observations observation
      where observation.id = v_id and observation.organization_id = p_client_organization_id
        and observation.external_refs->>'external_ref' = v_ref
        and coalesce(observation.external_refs->'import'->>'source', 'rm_patrol_log_import') = 'rm_patrol_log_import'
      for update;
    end if;
    if not found then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'record_not_owned_by_importer';
      return next; continue;
    end if;

    select * into v_version from public.patrol_import_record_versions version
    where version.record_kind = v_kind and version.record_id = v_id and version.is_current;
    if found then
      external_ref := v_ref; record_id := v_id;
      if v_version.source_fingerprint = v_item->>'source_fingerprint' then
        outcome := 'already_current'; detail := null;
      else
        outcome := 'held'; detail := 'baseline_already_recorded';
      end if;
      return next; continue;
    end if;

    if (nullif(v_existing->>'source_file', '') is not null and v_existing->>'source_file' is distinct from v_payload->>'source_file')
       or (nullif(v_existing->>'source_sheet', '') is not null and v_existing->>'source_sheet' is distinct from v_payload->>'source_sheet') then
      external_ref := v_ref; record_id := v_id; outcome := 'held'; detail := 'existing_source_identity_mismatch';
      return next; continue;
    end if;

    v_current := public.patrol_source_record_state(v_kind, v_id);
    v_target := jsonb_build_object(
      'occurred_at', to_char((v_desired->>'occurred_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'zone_id', nullif(v_desired->>'zone_id', ''),
      'site_id', nullif(v_desired->>'site_id', ''),
      'distance_km', case when v_desired->'distance_km' is null or jsonb_typeof(v_desired->'distance_km') = 'null' then null else (v_desired->>'distance_km')::numeric end
    ) || case v_kind
      when 'event' then jsonb_build_object(
        'officer_id', nullif(v_desired->>'observed_entity_id', ''),
        'event_type', v_desired->>'event_type',
        'status', v_desired->>'status',
        'observed_entity_type', v_desired->>'observed_entity_type')
      else jsonb_build_object(
        'officer_id', nullif(v_desired->>'officer_id', ''),
        'plate', upper(v_desired->>'plate'),
        'officer_notes', v_desired->>'officer_notes')
    end;

    select coalesce(array_agg(field order by field), '{}'::text[]) into v_mismatch
    from (
      select key as field from jsonb_each(v_target) target
      where (v_current->key) is distinct from target.value
        and not (jsonb_typeof(v_current->key) = 'number' and jsonb_typeof(target.value) = 'number'
                 and (v_current->>key)::numeric = (target.value#>>'{}')::numeric)
      union all
      select 'payload.' || key from (
        select jsonb_object_keys(v_payload || coalesce(v_existing, '{}'::jsonb)) as key
      ) payload_keys
      where key <> all (v_provenance)
        and coalesce(v_existing->key, 'null'::jsonb) is distinct from coalesce(v_payload->key, 'null'::jsonb)
    ) differences;

    if cardinality(v_mismatch) > 0 then
      external_ref := v_ref; record_id := v_id; outcome := 'held';
      detail := 'initial_difference_requires_review:' || array_to_string(v_mismatch, ',');
      return next; continue;
    end if;

    v_before := v_current;
    if v_kind = 'event' then
      update public.location_events event
      set payload = coalesce(event.payload, '{}'::jsonb) || jsonb_build_object(
        'source', v_payload->'source', 'source_file', v_payload->'source_file', 'source_sheet', v_payload->'source_sheet',
        'source_row', v_payload->'source_row', 'source_sha256', v_payload->'source_sha256',
        'derivative_sha256', v_payload->'derivative_sha256', 'classification_profile', v_payload->'classification_profile')
      where event.id = v_id;
    else
      update public.observations observation
      set external_refs = jsonb_set(coalesce(observation.external_refs, '{}'::jsonb), '{import}',
        coalesce(observation.external_refs->'import', '{}'::jsonb) || jsonb_build_object(
          'source', v_payload->'source', 'source_file', v_payload->'source_file', 'source_sheet', v_payload->'source_sheet',
          'source_row', v_payload->'source_row', 'source_sha256', v_payload->'source_sha256',
          'derivative_sha256', v_payload->'derivative_sha256', 'classification_profile', v_payload->'classification_profile'), true)
      where observation.id = v_id;
    end if;
    v_after := public.patrol_source_record_state(v_kind, v_id);

    insert into public.patrol_import_record_versions(
      provider_organization_id, client_organization_id, record_kind, record_id, external_ref, source_profile,
      source_file, source_sheet, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, changed_fields, state_before, state_after, applied_by
    ) values (
      p_provider_organization_id, p_client_organization_id, v_kind, v_id, v_ref, v_payload->>'classification_profile',
      v_payload->>'source_file', v_payload->>'source_sheet', (v_payload->>'source_row')::integer,
      v_payload->>'source_sha256', v_payload->>'derivative_sha256', v_item->>'source_fingerprint', p_batch_id,
      1, 'baseline', public.patrol_source_state_diff(v_before, v_after), v_before, v_after, auth.uid()
    );

    external_ref := v_ref; record_id := v_id; outcome := 'adopted'; detail := null;
    return next;
  end loop;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_provider_organization_id, auth.uid(), 'patrol_source_baseline_recorded', 'file_import_batches', p_batch_id,
    jsonb_build_object('client_organization_id', p_client_organization_id, 'rows', jsonb_array_length(p_records)));
end;
$function$;

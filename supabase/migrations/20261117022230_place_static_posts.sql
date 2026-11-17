-- Static posts use the same immutable service-version and approval path as patrols.
CREATE OR REPLACE FUNCTION public.create_operating_roster_work_unit(
  p_operating_organization_id uuid, p_name text, p_work_unit_type text, p_service_type text,
  p_patrol_route_id uuid DEFAULT NULL, p_service_agreement_location_id uuid DEFAULT NULL,
  p_service_agreement_module_id uuid DEFAULT NULL, p_workplace_id uuid DEFAULT NULL,
  p_team_id uuid DEFAULT NULL, p_cost_centre_id uuid DEFAULT NULL
)
RETURNS public.roster_work_units LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_agreement uuid;
BEGIN
  IF NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.is_admin_for_org(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch administrator required';
  END IF;
  IF nullif(trim(coalesce(p_name,'')),'') IS NULL OR nullif(trim(coalesce(p_service_type,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Name and service type are required';
  END IF;
  IF p_work_unit_type = 'patrol' THEN
    IF p_patrol_route_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.patrol_routes route
      WHERE route.id=p_patrol_route_id AND route.organization_id=p_operating_organization_id AND route.is_active) THEN
      RAISE EXCEPTION 'Active patrol route in this operating branch required';
    END IF;
  ELSIF p_work_unit_type = 'static' THEN
    IF p_patrol_route_id IS NOT NULL OR p_workplace_id IS NOT NULL OR p_team_id IS NOT NULL OR p_cost_centre_id IS NOT NULL THEN
      RAISE EXCEPTION 'Static work units cannot have patrol, workplace, team or cost centre references' USING ERRCODE = '23514';
    END IF;
    SELECT location.service_agreement_id INTO v_agreement
      FROM public.service_agreement_locations location JOIN public.service_agreements agreement ON agreement.id=location.service_agreement_id
        AND public.can_set_up_static_post(agreement.provider_organization_id,p_operating_organization_id)
      WHERE location.id=p_service_agreement_location_id AND location.status='active';
    IF v_agreement IS NULL OR NOT EXISTS(SELECT 1 FROM public.service_agreement_modules module
      WHERE module.id=p_service_agreement_module_id AND module.service_agreement_id=v_agreement
        AND module.enabled AND module.module_key='static_guarding') THEN
      RAISE EXCEPTION 'Active static guarding agreement location and module required';
    END IF;
    RETURN public.create_static_roster_work_unit_internal(v_actor,p_operating_organization_id,p_name,p_service_type,
      p_service_agreement_location_id,p_service_agreement_module_id);
  ELSIF p_work_unit_type = 'internal' THEN
    IF p_workplace_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.organization_workplaces workplace
      WHERE workplace.id=p_workplace_id AND workplace.organization_id=p_operating_organization_id AND workplace.active) THEN
      RAISE EXCEPTION 'Active provider workplace required';
    END IF;
    IF p_team_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.teams team
      WHERE team.id=p_team_id AND team.organization_id=p_operating_organization_id AND team.status='active') THEN
      RAISE EXCEPTION 'Active team in this operating branch required';
    END IF;
    IF p_cost_centre_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.cost_centres centre
      WHERE centre.id=p_cost_centre_id AND centre.organization_id=p_operating_organization_id AND centre.active) THEN
      RAISE EXCEPTION 'Active cost centre in this operating branch required';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported work unit type';
  END IF;
  INSERT INTO public.roster_work_units(organization_id,name,work_unit_type,service_type,patrol_route_id,
    service_agreement_location_id,service_agreement_module_id,workplace_id,team_id,cost_centre_id,created_by)
  VALUES(p_operating_organization_id,trim(p_name),p_work_unit_type,trim(p_service_type),p_patrol_route_id,
    p_service_agreement_location_id,p_service_agreement_module_id,p_workplace_id,p_team_id,p_cost_centre_id,v_actor)
  RETURNING * INTO v_unit;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(p_operating_organization_id,v_actor,'roster_work_unit_created','roster_work_units',v_unit.id,
    jsonb_build_object('work_unit_type',v_unit.work_unit_type,'service_type',v_unit.service_type,
      'operating_organization_id',p_operating_organization_id));
  RETURN v_unit;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_place_static_post_version(p_version_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_version public.place_service_term_versions%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_site uuid;
  v_zone uuid;
  v_operating uuid;
  v_ids uuid[];
  v_names text[];
  v_location_id uuid;
  v_module_id uuid;
  v_enabled text[];
BEGIN
  SELECT * INTO v_version FROM public.place_service_term_versions WHERE id = p_version_id FOR UPDATE;
  IF NOT FOUND OR v_version.service_kind <> 'static_guarding' OR v_version.status <> 'pending' THEN
    RAISE EXCEPTION 'Pending static post change required';
  END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = v_version.service_agreement_id FOR UPDATE;
  IF NOT FOUND OR v_agreement.provider_organization_id IS DISTINCT FROM v_version.organization_id THEN
    RAISE EXCEPTION 'Service agreement no longer available';
  END IF;

  IF v_version.change_kind = 'end' THEN
    SELECT * INTO v_unit FROM public.roster_work_units WHERE id = v_version.work_unit_id FOR UPDATE;
    IF NOT FOUND OR NOT v_unit.active OR v_unit.work_unit_type <> 'static'
      OR v_unit.name IS DISTINCT FROM v_version.terms ->> 'post_name'
      OR v_unit.organization_id IS DISTINCT FROM (v_version.terms ->> 'operating_organization_id')::uuid
      OR v_unit.service_agreement_location_id IS DISTINCT FROM (v_version.terms ->> 'service_agreement_location_id')::uuid
      OR v_unit.service_agreement_module_id IS DISTINCT FROM (v_version.terms ->> 'service_agreement_module_id')::uuid
      OR NOT EXISTS (
        SELECT 1 FROM public.service_agreement_locations l
        JOIN public.service_agreement_modules m ON m.id = v_unit.service_agreement_module_id
          AND m.service_agreement_id = l.service_agreement_id AND m.module_key = 'static_guarding'
        WHERE l.id = v_unit.service_agreement_location_id AND l.service_agreement_id = v_agreement.id
      ) THEN
      RAISE EXCEPTION 'Static post has changed; reload before ending it' USING ERRCODE = '40001';
    END IF;
    UPDATE public.roster_work_units SET active = false, updated_at = clock_timestamp() WHERE id = v_unit.id;
    RETURN v_unit.id;
  END IF;
  IF v_version.change_kind <> 'create' THEN
    RAISE EXCEPTION 'Unsupported static post change';
  END IF;
  IF v_agreement.agreement_type IS DISTINCT FROM 'operational'
    OR (v_agreement.starts_on IS NOT NULL AND v_agreement.starts_on > public.place_service_today())
    OR (v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on < public.place_service_today()) THEN
    RAISE EXCEPTION 'An active operational agreement is required';
  END IF;

  v_site := (v_version.terms ->> 'site_id')::uuid;
  v_zone := (v_version.terms ->> 'zone_id')::uuid;
  v_operating := (v_version.terms ->> 'operating_organization_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v_version.location_id
                 AND l.organization_id = v_agreement.client_organization_id)
    OR (v_site IS NULL) = (v_zone IS NULL)
    OR (v_site IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = v_site
      AND s.location_id = v_version.location_id AND s.client_organization_id = v_agreement.client_organization_id AND s.active))
    OR (v_zone IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = v_zone
      AND z.location_id = v_version.location_id AND z.is_active AND NOT z.is_verification_point))
    OR NOT EXISTS (SELECT 1 FROM public.module_catalog WHERE module_key = 'static_guarding' AND active) THEN
    RAISE EXCEPTION 'Static post place or service is no longer available';
  END IF;
  IF NOT public.can_approve_action(v_version.requested_by, v_operating)
    OR (v_operating IS DISTINCT FROM v_agreement.provider_organization_id
        AND (NOT coalesce((SELECT s.branches_may_set_up_static_posts FROM public.organization_operating_settings s
                           WHERE s.organization_id = v_agreement.provider_organization_id), false)
             OR NOT (v_operating = ANY(public.get_descendant_organizations(v_agreement.provider_organization_id))))) THEN
    RAISE EXCEPTION 'Requester is no longer authorised to set up this static post' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid), '{}'::uuid[]) INTO v_ids
    FROM jsonb_array_elements_text(v_version.terms -> 'required_skill_ids');
  SELECT coalesce(array_agg(c.skill_name ORDER BY c.skill_name), '{}'::text[]) INTO v_names
    FROM public.roster_skill_catalog c WHERE c.organization_id = v_operating AND c.active AND c.id = ANY(v_ids);
  IF cardinality(v_names) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more selected skills are inactive or outside this organisation';
  END IF;
  INSERT INTO public.service_agreement_modules(service_agreement_id, module_key, enabled)
    VALUES (v_agreement.id, 'static_guarding', true)
    ON CONFLICT (service_agreement_id, module_key) DO UPDATE SET enabled = true
    RETURNING id INTO v_module_id;
  SELECT coalesce(array_agg(module_key ORDER BY module_key), '{}'::text[]) INTO v_enabled
    FROM public.service_agreement_modules WHERE service_agreement_id = v_agreement.id AND enabled;
  UPDATE public.service_agreements SET enabled_modules = v_enabled WHERE id = v_agreement.id
    AND enabled_modules IS DISTINCT FROM v_enabled;
  SELECT l.id INTO v_location_id FROM public.service_agreement_locations l
    WHERE l.service_agreement_id = v_agreement.id AND l.site_id IS NOT DISTINCT FROM v_site
      AND l.zone_id IS NOT DISTINCT FROM v_zone LIMIT 1;
  IF v_location_id IS NULL THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, zone_id, status, created_by)
      VALUES (v_agreement.id, v_site, v_zone, 'active', v_version.requested_by) RETURNING id INTO v_location_id;
  ELSE
    UPDATE public.service_agreement_locations SET status = 'active' WHERE id = v_location_id AND status <> 'active';
  END IF;
  v_unit := public.create_static_roster_work_unit_internal(v_version.requested_by, v_operating,
    v_version.terms ->> 'post_name', 'static_guarding', v_location_id, v_module_id);
  UPDATE public.roster_work_units SET required_skill_ids = v_ids, required_skill_names = v_names,
    updated_at = clock_timestamp() WHERE id = v_unit.id;
  RETURN v_unit.id;
END;
$$;
COMMENT ON FUNCTION public.apply_place_static_post_version(uuid) IS
  'Internal application of a pending static-post change; validates current agreement, place, branch authority and skills before creation, or deactivates the existing unit without altering roster slots.';
REVOKE ALL ON FUNCTION public.apply_place_static_post_version(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_place_static_post_version(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.add_place_static_post(
  p_client_request_id uuid, p_location_id uuid, p_agreement_id uuid, p_site_id uuid, p_zone_id uuid,
  p_post_name text, p_operating_organization_id uuid, p_required_skill_ids uuid[], p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_existing public.place_service_term_versions%rowtype;
  v_ids uuid[];
  v_terms jsonb;
  v_fingerprint text;
  v_version uuid := gen_random_uuid();
  v_unit uuid;
  v_action uuid;
  v_pending boolean;
  v_result jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_today date := public.place_service_today();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.can_set_up_static_post(v_agreement.provider_organization_id, p_operating_organization_id) THEN
    RAISE EXCEPTION 'Authorised operating organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF array_position(coalesce(p_required_skill_ids, '{}'::uuid[]), NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Skill IDs cannot contain null';
  END IF;
  SELECT coalesce(array_agg(DISTINCT id ORDER BY id), '{}'::uuid[]) INTO v_ids
    FROM unnest(coalesce(p_required_skill_ids, '{}'::uuid[])) id;
  v_terms := jsonb_build_object('site_id', p_site_id, 'zone_id', p_zone_id, 'post_name', btrim(coalesce(p_post_name, '')),
    'operating_organization_id', p_operating_organization_id, 'required_skill_ids', to_jsonb(v_ids));
  v_fingerprint := md5(jsonb_build_object('actor', v_actor, 'location', p_location_id, 'agreement', p_agreement_id,
    'terms', v_terms, 'reason', v_reason, 'kind', 'static_create')::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('place_service_change:' || p_client_request_id::text, 0));
  SELECT * INTO v_existing FROM public.place_service_term_versions WHERE client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.requested_by IS DISTINCT FROM v_actor OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'This request ID was already used for a different change' USING ERRCODE = '42501';
    END IF;
    SELECT a.metadata -> 'result' INTO v_result FROM public.audit_log a
      WHERE a.action IN ('place_service_change_approved', 'place_service_change_pending')
        AND a.metadata ->> 'kind' = 'save' AND a.metadata ->> 'client_request_id' = p_client_request_id::text LIMIT 1;
    IF v_result IS NULL THEN RAISE EXCEPTION 'Static post request receipt missing'; END IF;
    RETURN v_result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF NOT public.user_can_operate_organization(p_operating_organization_id)
    OR NOT public.can_set_up_static_post(v_agreement.provider_organization_id, p_operating_organization_id) THEN
    RAISE EXCEPTION 'Authorised operating organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF v_agreement.agreement_type IS DISTINCT FROM 'operational'
    OR (v_agreement.starts_on IS NOT NULL AND v_agreement.starts_on > v_today)
    OR (v_agreement.ends_on IS NOT NULL AND v_agreement.ends_on < v_today) THEN
    RAISE EXCEPTION 'An active operational agreement is required';
  END IF;
  IF nullif(v_terms ->> 'post_name', '') IS NULL THEN RAISE EXCEPTION 'Post name is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND l.organization_id = v_agreement.client_organization_id)
    OR (p_site_id IS NULL) = (p_zone_id IS NULL)
    OR (p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = p_site_id
      AND s.location_id = p_location_id AND s.client_organization_id = v_agreement.client_organization_id AND s.active))
    OR (p_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = p_zone_id
      AND z.location_id = p_location_id AND z.is_active AND NOT z.is_verification_point)) THEN
    RAISE EXCEPTION 'Choose an active site or work area on this location';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.module_catalog WHERE module_key = 'static_guarding' AND active) THEN
    RAISE EXCEPTION 'Static guarding is not an active service';
  END IF;
  IF (SELECT count(*) FROM public.roster_skill_catalog c WHERE c.organization_id = p_operating_organization_id
      AND c.active AND c.id = ANY(v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'One or more selected skills are inactive or outside this organisation';
  END IF;
  v_pending := coalesce((SELECT s.place_changes_need_second_approver FROM public.organization_operating_settings s
                         WHERE s.organization_id = v_agreement.provider_organization_id), false);
  IF v_pending THEN
    INSERT INTO public.bob_agentic_actions(organization_id,user_id,triggered_by,action_type,status,proposed_payload,
      context_table,context_record_id,context_summary,idempotency_key)
    VALUES(v_agreement.provider_organization_id,v_actor,v_actor,'place_service_change','pending',
      jsonb_build_object('version_id',v_version,'location_id',p_location_id,'change_kind','create','effective_from',v_today,'terms',v_terms),
      'place_service_term_versions',v_version,'Create static post: ' || (v_terms ->> 'post_name'),
      'place_service_change:' || p_client_request_id::text) RETURNING id INTO v_action;
  END IF;
  INSERT INTO public.place_service_term_versions(id,organization_id,service_agreement_id,location_id,service_kind,change_kind,
    effective_from,terms,status,reason,requested_by,client_request_id,request_fingerprint,approval_action_id)
  VALUES(v_version,v_agreement.provider_organization_id,v_agreement.id,p_location_id,'static_guarding','create',
    v_today,v_terms,'pending',v_reason,v_actor,p_client_request_id,v_fingerprint,v_action);
  IF NOT v_pending THEN
    v_unit := public.apply_place_static_post_version(v_version);
    UPDATE public.place_service_term_versions SET status='approved',applied_effective_from=v_today,
      decided_by=v_actor,decided_at=clock_timestamp(),work_unit_id=v_unit WHERE id=v_version;
  END IF;
  v_result := jsonb_build_object('version_id',v_version,'status',CASE WHEN v_pending THEN 'pending' ELSE 'approved' END,'work_unit_id',v_unit);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_agreement.provider_organization_id,v_actor,'place_service_change_' || (v_result ->> 'status'),
    'place_service_term_versions',v_version,jsonb_build_object('kind','save','client_request_id',p_client_request_id,
    'version_id',v_version,'location_id',p_location_id,'agreement_id',v_agreement.id,'change_kind','create','result',v_result));
  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.add_place_static_post(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid[],text) IS
  'Requests a static post at a site or area under an operational agreement, with optional second approval, active operating-organisation skills and replay-safe audit evidence.';
REVOKE ALL ON FUNCTION public.add_place_static_post(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_place_static_post(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid[],text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.end_place_static_post(p_client_request_id uuid, p_work_unit_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_existing public.place_service_term_versions%rowtype;
  v_location uuid;
  v_version uuid := gen_random_uuid();
  v_action uuid;
  v_pending boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fingerprint text;
  v_result jsonb;
  v_today date := public.place_service_today();
  v_terms jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id = p_work_unit_id;
  IF NOT FOUND OR v_unit.work_unit_type <> 'static' THEN RAISE EXCEPTION 'Static post not found' USING ERRCODE = 'P0002'; END IF;
  SELECT a.* INTO v_agreement
    FROM public.service_agreements a JOIN public.service_agreement_locations l ON l.service_agreement_id=a.id
    JOIN public.service_agreement_modules m ON m.id=v_unit.service_agreement_module_id
      AND m.service_agreement_id=a.id AND m.module_key='static_guarding'
    WHERE l.id=v_unit.service_agreement_location_id;
  SELECT coalesce(s.location_id,z.location_id) INTO v_location
    FROM public.service_agreement_locations l
    LEFT JOIN public.client_sites s ON s.id=l.site_id LEFT JOIN public.location_zones z ON z.id=l.zone_id
    WHERE l.id=v_unit.service_agreement_location_id;
  IF v_agreement.id IS NULL OR v_location IS NULL THEN RAISE EXCEPTION 'Static post agreement place not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id)
    AND NOT (public.user_can_operate_organization(v_unit.organization_id)
      AND public.can_set_up_static_post(v_agreement.provider_organization_id,v_unit.organization_id)) THEN
    RAISE EXCEPTION 'Authorised administrator required' USING ERRCODE = '42501';
  END IF;
  v_fingerprint := md5(jsonb_build_object('actor',v_actor,'work_unit',p_work_unit_id,'reason',v_reason,'kind','static_end')::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('place_service_change:' || p_client_request_id::text, 0));
  SELECT * INTO v_existing FROM public.place_service_term_versions WHERE client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_existing.requested_by IS DISTINCT FROM v_actor OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'This request ID was already used for a different change' USING ERRCODE = '42501';
    END IF;
    SELECT a.metadata -> 'result' INTO v_result FROM public.audit_log a
      WHERE a.action IN ('place_service_change_approved','place_service_change_pending')
        AND a.metadata ->> 'kind'='save' AND a.metadata ->> 'client_request_id'=p_client_request_id::text LIMIT 1;
    IF v_result IS NULL THEN RAISE EXCEPTION 'Static post request receipt missing'; END IF;
    RETURN v_result || jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=v_agreement.id FOR UPDATE;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id=p_work_unit_id FOR UPDATE;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id)
    AND NOT (public.user_can_operate_organization(v_unit.organization_id)
      AND public.can_set_up_static_post(v_agreement.provider_organization_id,v_unit.organization_id)) THEN
    RAISE EXCEPTION 'Authorised administrator required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.service_agreement_locations l
    JOIN public.service_agreement_modules m ON m.id=v_unit.service_agreement_module_id
      AND m.service_agreement_id=l.service_agreement_id AND m.module_key='static_guarding'
    LEFT JOIN public.client_sites s ON s.id=l.site_id LEFT JOIN public.location_zones z ON z.id=l.zone_id
    WHERE l.id=v_unit.service_agreement_location_id AND l.service_agreement_id=v_agreement.id
      AND coalesce(s.location_id,z.location_id)=v_location
  ) THEN
    RAISE EXCEPTION 'Static post has changed; reload before ending it' USING ERRCODE = '40001';
  END IF;
  IF NOT v_unit.active THEN RAISE EXCEPTION 'Static post has already ended'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'Give a reason for ending this post'; END IF;
  IF EXISTS(SELECT 1 FROM public.place_service_term_versions WHERE work_unit_id=p_work_unit_id AND status='pending') THEN
    RAISE EXCEPTION 'A change to this post is already waiting for approval';
  END IF;
  v_terms := jsonb_build_object('work_unit_id',v_unit.id,'post_name',v_unit.name,
    'operating_organization_id',v_unit.organization_id,'service_agreement_location_id',v_unit.service_agreement_location_id,
    'service_agreement_module_id',v_unit.service_agreement_module_id);
  v_pending := coalesce((SELECT s.place_changes_need_second_approver FROM public.organization_operating_settings s
                         WHERE s.organization_id=v_agreement.provider_organization_id),false);
  IF v_pending THEN
    INSERT INTO public.bob_agentic_actions(organization_id,user_id,triggered_by,action_type,status,proposed_payload,
      context_table,context_record_id,context_summary,idempotency_key)
    VALUES(v_agreement.provider_organization_id,v_actor,v_actor,'place_service_change','pending',
      jsonb_build_object('version_id',v_version,'location_id',v_location,'change_kind','end','effective_from',v_today,
        'terms',v_terms),
      'place_service_term_versions',v_version,'End static post: ' || v_unit.name,
      'place_service_change:' || p_client_request_id::text) RETURNING id INTO v_action;
  END IF;
  INSERT INTO public.place_service_term_versions(id,organization_id,service_agreement_id,location_id,work_unit_id,service_kind,
    change_kind,effective_from,terms,status,reason,requested_by,client_request_id,request_fingerprint,approval_action_id)
  VALUES(v_version,v_agreement.provider_organization_id,v_agreement.id,v_location,v_unit.id,'static_guarding','end',
    v_today,v_terms,'pending',
    v_reason,v_actor,p_client_request_id,v_fingerprint,v_action);
  IF NOT v_pending THEN
    PERFORM public.apply_place_static_post_version(v_version);
    UPDATE public.place_service_term_versions SET status='approved',applied_effective_from=v_today,
      decided_by=v_actor,decided_at=clock_timestamp() WHERE id=v_version;
  END IF;
  v_result := jsonb_build_object('version_id',v_version,'status',CASE WHEN v_pending THEN 'pending' ELSE 'approved' END,'work_unit_id',v_unit.id);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_agreement.provider_organization_id,v_actor,'place_service_change_' || (v_result ->> 'status'),
    'place_service_term_versions',v_version,jsonb_build_object('kind','save','client_request_id',p_client_request_id,
    'version_id',v_version,'location_id',v_location,'agreement_id',v_agreement.id,'change_kind','end','result',v_result));
  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.end_place_static_post(uuid,uuid,text) IS
  'Requests a static post end, retaining existing slots and shifts; a second provider approver is required when configured.';
REVOKE ALL ON FUNCTION public.end_place_static_post(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_place_static_post(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.get_place_services(uuid) RENAME TO get_place_services_patrol_base;
REVOKE ALL ON FUNCTION public.get_place_services_patrol_base(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_place_services_patrol_base(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_place_services(p_location_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_workspace jsonb;
  v_services jsonb;
BEGIN
  v_workspace := public.get_place_services_patrol_base(p_location_id);
  IF NOT coalesce((v_workspace ->> 'can_manage')::boolean, false) THEN
    RETURN v_workspace;
  END IF;
  WITH agreements AS (
    SELECT (a ->> 'id')::uuid AS id FROM jsonb_array_elements(v_workspace -> 'agreements') a
  ), items AS (
    SELECT item FROM jsonb_array_elements(v_workspace -> 'services') item
      WHERE item ->> 'service_kind' IS DISTINCT FROM 'static_guarding'
    UNION ALL
    SELECT jsonb_build_object(
      'delivery_schedule_id',NULL,'service_agreement_id',a.id,'service_kind','static_guarding',
      'module_key','static_guarding','anchor',jsonb_build_object('site_id',sal.site_id,'zone_id',sal.zone_id),
      'active',u.active,'terms',jsonb_build_object('post_name',u.name,'operating_organization_id',u.organization_id,
        'required_skill_ids',to_jsonb(u.required_skill_ids),'required_skill_names',to_jsonb(u.required_skill_names)),
      'effective_from',created.applied_effective_from,
      'pending',(SELECT jsonb_build_object('version_id',v.id,'change_kind',v.change_kind,'effective_from',v.effective_from,
        'terms',v.terms,'requested_by',v.requested_by,'requested_by_name',p.display_name)
        FROM public.place_service_term_versions v LEFT JOIN public.user_profiles p ON p.id=v.requested_by
        WHERE v.work_unit_id=u.id AND v.status='pending' ORDER BY v.requested_at DESC LIMIT 1),
      'responsibility',NULL,'work_unit',jsonb_build_object('id',u.id,'name',u.name,'active',u.active))
    FROM public.roster_work_units u
    JOIN public.service_agreement_locations sal ON sal.id=u.service_agreement_location_id
    JOIN agreements a ON a.id=sal.service_agreement_id
    JOIN public.service_agreement_modules sam ON sam.id=u.service_agreement_module_id
      AND sam.service_agreement_id=a.id AND sam.module_key='static_guarding'
    LEFT JOIN public.client_sites s ON s.id=sal.site_id
    LEFT JOIN public.location_zones z ON z.id=sal.zone_id
    LEFT JOIN LATERAL (SELECT v.applied_effective_from FROM public.place_service_term_versions v
      WHERE v.work_unit_id=u.id AND v.service_kind='static_guarding' AND v.change_kind='create' AND v.status='approved'
      ORDER BY v.applied_effective_from DESC LIMIT 1) created ON true
    WHERE u.work_unit_type='static' AND u.active AND coalesce(s.location_id,z.location_id)=p_location_id
    UNION ALL
    SELECT jsonb_build_object(
      'delivery_schedule_id',NULL,'service_agreement_id',v.service_agreement_id,'service_kind','static_guarding',
      'module_key','static_guarding','anchor',jsonb_build_object('site_id',v.terms->'site_id','zone_id',v.terms->'zone_id'),
      'active',false,'terms',NULL,'effective_from',NULL,
      'pending',jsonb_build_object('version_id',v.id,'change_kind',v.change_kind,'effective_from',v.effective_from,
        'terms',v.terms,'requested_by',v.requested_by,'requested_by_name',p.display_name),
      'responsibility',NULL,'work_unit',NULL)
    FROM public.place_service_term_versions v JOIN agreements a ON a.id=v.service_agreement_id
    LEFT JOIN public.user_profiles p ON p.id=v.requested_by
    WHERE v.location_id=p_location_id AND v.service_kind='static_guarding'
      AND v.change_kind='create' AND v.status='pending' AND v.work_unit_id IS NULL
  )
  SELECT coalesce(jsonb_agg(item),'[]'::jsonb) INTO v_services FROM items;
  RETURN jsonb_set(v_workspace,'{services}',v_services);
END;
$$;
COMMENT ON FUNCTION public.get_place_services(uuid) IS
  'Place services workspace including active static posts and pending static changes, limited to agreements administered by the caller.';
REVOKE ALL ON FUNCTION public.get_place_services(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_place_services(uuid) TO authenticated, service_role;
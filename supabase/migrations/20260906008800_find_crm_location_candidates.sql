CREATE OR REPLACE FUNCTION public.find_crm_location_candidates(
  p_account_organization_id uuid,
  p_query text DEFAULT NULL,
  p_address text DEFAULT NULL
) RETURNS TABLE(
  location_id uuid,
  name text,
  address text,
  suburb text,
  postcode text,
  site_count integer,
  zone_count integer,
  boundary_state text,
  match_reason text,
  belongs_to_account boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_query text := lower(trim(coalesce(p_query, '')));
  v_address_key text := nullif(regexp_replace(lower(trim(coalesce(p_address, ''))), '[^a-z0-9]+', '', 'g'), '');
BEGIN
  SELECT profile.organization_id INTO v_provider FROM public.user_profiles AS profile WHERE profile.id = v_actor AND profile.deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.crm_actor_can_manage_account(p_account_organization_id) THEN RAISE EXCEPTION 'Active CRM administrator required for this organization'; END IF;
  IF char_length(v_query) < 2 AND coalesce(char_length(v_address_key), 0) < 4 THEN RAISE EXCEPTION 'Enter a location name or complete address to search'; END IF;

  RETURN QUERY
  WITH matches AS (
    SELECT location.id, location.organization_id, location.name, location.address, location.suburb, location.postcode,
      CASE WHEN v_address_key IS NOT NULL AND location.address_match_key = v_address_key THEN 0 WHEN lower(location.name) = v_query THEN 1 ELSE 2 END AS match_rank
    FROM public.locations AS location
    WHERE (v_address_key IS NOT NULL AND location.address_match_key = v_address_key)
       OR (char_length(v_query) >= 2 AND lower(location.name) LIKE '%' || v_query || '%')
  )
  SELECT match.id, match.name, match.address, match.suburb, match.postcode,
    (SELECT count(*)::integer FROM public.client_sites AS site WHERE site.location_id = match.id),
    (SELECT count(*)::integer FROM public.location_zones AS zone WHERE zone.location_id = match.id),
    CASE WHEN EXISTS (SELECT 1 FROM public.client_sites AS site WHERE site.location_id = match.id AND site.boundary_verification = 'verified') OR EXISTS (SELECT 1 FROM public.location_zones AS zone WHERE zone.location_id = match.id AND zone.boundary_verification = 'verified') THEN 'verified geometry available' WHEN EXISTS (SELECT 1 FROM public.client_sites AS site WHERE site.location_id = match.id AND site.boundary IS NOT NULL) OR EXISTS (SELECT 1 FROM public.location_zones AS zone WHERE zone.location_id = match.id AND zone.boundary IS NOT NULL) THEN 'geometry requires review' ELSE 'no geometry recorded' END,
    CASE match.match_rank WHEN 0 THEN 'Exact address match' WHEN 1 THEN 'Exact location name' ELSE 'Similar location name' END,
    match.organization_id = p_account_organization_id
  FROM matches AS match
  ORDER BY match.match_rank, match.name
  LIMIT 20;
END; $$;

REVOKE ALL ON FUNCTION public.find_crm_location_candidates(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_crm_location_candidates(uuid,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_crm_location(
  p_client_request_id uuid, p_organization_id uuid, p_action text, p_name text, p_address text DEFAULT NULL,
  p_suburb text DEFAULT NULL, p_postcode text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS public.locations LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')), '');v_address text:=nullif(trim(coalesce(p_address,'')), '');v_address_key text:=nullif(regexp_replace(lower(coalesce(v_address,'')),'[^a-z0-9]+','','g'),'');
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.crm_actor_can_manage_account(p_organization_id) THEN RAISE EXCEPTION 'Active CRM administrator required for this organization'; END IF;
  IF p_action<>'create' OR p_client_request_id IS NULL OR v_name IS NULL OR char_length(v_name)>200 OR (v_address IS NOT NULL AND char_length(v_address)>500) THEN RAISE EXCEPTION 'Valid location creation request is required'; END IF;
  SELECT * INTO v_location FROM public.locations WHERE organization_id=p_organization_id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_location; END IF;
  IF v_address_key IS NOT NULL AND EXISTS(SELECT 1 FROM public.locations WHERE address_match_key=v_address_key) THEN RAISE EXCEPTION 'A physical place with this address already exists. Review the lookup result and use an agreement for authorized access.'; END IF;
  INSERT INTO public.locations(organization_id,name,address,address_match_key,suburb,postcode,notes,created_by,client_request_id) VALUES(p_organization_id,v_name,v_address,v_address_key,nullif(trim(coalesce(p_suburb,'')),''),nullif(trim(coalesce(p_postcode,'')),''),nullif(trim(coalesce(p_notes,'')),''),v_actor,p_client_request_id) RETURNING * INTO v_location;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_provider,v_actor,'crm_location_created','locations',v_location.id,jsonb_build_object('account_organization_id',p_organization_id,'address_match_key',v_address_key));
  RETURN v_location;
END; $$;
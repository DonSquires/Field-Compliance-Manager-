DROP FUNCTION IF EXISTS public.create_crm_site(uuid, uuid, text, text, text, double precision, double precision);

CREATE FUNCTION public.create_crm_site(
  p_client_request_id uuid,
  p_account_organization_id uuid,
  p_name text,
  p_address text,
  p_site_type text DEFAULT 'commercial_premises',
  p_center_lat double precision DEFAULT NULL,
  p_center_lng double precision DEFAULT NULL,
  p_location_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, address text, site_type text, active boolean, boundary_status text, boundary_verification text, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid(); v_provider uuid; v_site public.client_sites%rowtype;
  v_name text := nullif(trim(coalesce(p_name, '')), ''); v_address text := nullif(trim(coalesce(p_address, '')), ''); v_address_key text;
BEGIN
  SELECT up.organization_id INTO v_provider FROM public.user_profiles AS up WHERE up.id=v_actor AND up.deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.crm_actor_can_manage_account(p_account_organization_id) THEN RAISE EXCEPTION 'Active CRM administrator required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  PERFORM 1 FROM public.organizations AS org WHERE org.id=p_account_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CRM account organization not found'; END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.locations AS house WHERE house.id=p_location_id AND house.organization_id=p_account_organization_id) THEN RAISE EXCEPTION 'Location house does not belong to the account'; END IF;
  SELECT site.* INTO v_site FROM public.client_sites AS site WHERE site.client_organization_id=p_account_organization_id AND site.client_request_id=p_client_request_id;
  IF FOUND THEN id:=v_site.id; name:=v_site.name; address:=v_site.address; site_type:=v_site.site_type; active:=v_site.active; boundary_status:=v_site.boundary_status; boundary_verification:=v_site.boundary_verification; created:=false; RETURN NEXT; RETURN; END IF;
  IF v_name IS NULL OR char_length(v_name)>200 THEN RAISE EXCEPTION 'Site name is required and must be 200 characters or fewer'; END IF;
  IF v_address IS NULL OR char_length(v_address)<4 OR char_length(v_address)>500 THEN RAISE EXCEPTION 'A complete site address is required'; END IF;
  IF p_center_lat IS NULL OR p_center_lng IS NULL OR p_center_lat NOT BETWEEN -90 AND 90 OR p_center_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Resolve the address before creating the site'; END IF;
  IF p_site_type NOT IN ('freedom_camping_area','parking_area','commercial_premises','residential_complex','government_facility','hospital','education_facility','industrial_site','public_space','other') THEN RAISE EXCEPTION 'Unsupported site type'; END IF;
  v_address_key:=regexp_replace(lower(v_address),'[^a-z0-9]+','','g');
  IF EXISTS (SELECT 1 FROM public.client_sites AS duplicate_site WHERE duplicate_site.client_organization_id=p_account_organization_id AND duplicate_site.address_match_key=v_address_key) THEN RAISE EXCEPTION 'A site with this address already exists for the account'; END IF;
  INSERT INTO public.client_sites(client_organization_id,location_id,name,address,address_match_key,site_type,active,site_origin,boundary_status,boundary_verification,center_point,client_request_id)
  VALUES(p_account_organization_id,p_location_id,v_name,v_address,v_address_key,p_site_type,true,'contracted','provisional','unverified',ST_SetSRID(ST_MakePoint(p_center_lng,p_center_lat),4326),p_client_request_id) RETURNING * INTO v_site;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_provider,v_actor,'crm_site_created','client_sites',v_site.id,jsonb_build_object('account_organization_id',p_account_organization_id,'location_id',p_location_id,'address_match_key',v_address_key,'center_source','resolved_address'));
  id:=v_site.id; name:=v_site.name; address:=v_site.address; site_type:=v_site.site_type; active:=v_site.active; boundary_status:=v_site.boundary_status; boundary_verification:=v_site.boundary_verification; created:=true; RETURN NEXT;
END; $$;

REVOKE ALL ON FUNCTION public.create_crm_site(uuid,uuid,text,text,text,double precision,double precision,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_crm_site(uuid,uuid,text,text,text,double precision,double precision,uuid) TO authenticated,service_role;

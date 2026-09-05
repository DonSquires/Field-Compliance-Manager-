CREATE TABLE public.quote_proposal_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  place_kind text NOT NULL CHECK (place_kind IN ('site','zone')),
  name text NOT NULL,
  address text NOT NULL,
  module_key text NOT NULL REFERENCES public.module_catalog(module_key) ON DELETE RESTRICT,
  site_type text CHECK (site_type IS NULL OR site_type IN ('freedom_camping_area','parking_area','commercial_premises','residential_complex','government_facility','hospital','education_facility','industrial_site','public_space','other')),
  zone_type text CHECK (zone_type IS NULL OR zone_type IN ('freedom_camping','parking','noise_control','biosecurity','trespass','access_control','general','patrol_route')),
  proposed_geometry jsonb,
  geometry_source text NOT NULL DEFAULT 'manual' CHECK (geometry_source IN ('manual','map_pin','linz_address','linz_parcel','document')),
  candidate_site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  candidate_zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  resolution text NOT NULL CHECK (resolution IN ('create_new','use_existing')),
  client_request_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  converted_site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  converted_zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  converted_at timestamptz,
  CONSTRAINT quote_proposal_places_kind_candidate_xor CHECK ((place_kind='site' AND candidate_zone_id IS NULL AND converted_zone_id IS NULL) OR (place_kind='zone' AND candidate_site_id IS NULL AND converted_site_id IS NULL)),
  CONSTRAINT quote_proposal_places_request_unique UNIQUE (quote_id,client_request_id),
  CONSTRAINT quote_proposal_places_identity_unique UNIQUE NULLS NOT DISTINCT (quote_id,place_kind,name,address,module_key)
);
ALTER TABLE public.quote_proposal_places ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_proposal_places_select ON public.quote_proposal_places FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.quotes quote WHERE quote.id=quote_id AND public.is_admin_for_org(quote.provider_org_id)));
REVOKE ALL ON public.quote_proposal_places FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.quote_proposal_places TO authenticated;
GRANT ALL ON public.quote_proposal_places TO service_role;

CREATE OR REPLACE FUNCTION public.manage_crm_quote_proposal_place(p_client_request_id uuid,p_quote_id uuid,p_action text,p_place_id uuid DEFAULT NULL,p_place_kind text DEFAULT NULL,p_name text DEFAULT NULL,p_address text DEFAULT NULL,p_module_key text DEFAULT NULL,p_site_type text DEFAULT NULL,p_zone_type text DEFAULT NULL,p_proposed_geometry jsonb DEFAULT NULL,p_geometry_source text DEFAULT 'manual',p_candidate_site_id uuid DEFAULT NULL,p_candidate_zone_id uuid DEFAULT NULL,p_resolution text DEFAULT 'create_new')
RETURNS public.quote_proposal_places LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_quote public.quotes%rowtype;v_place public.quote_proposal_places%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')), '');v_address text:=nullif(trim(coalesce(p_address,'')), '');
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required';END IF;
  SELECT * INTO v_quote FROM public.quotes WHERE id=p_quote_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_quote.provider_org_id) OR v_quote.status<>'draft' THEN RAISE EXCEPTION 'Draft quote administration required';END IF;
  SELECT * INTO v_place FROM public.quote_proposal_places WHERE quote_id=v_quote.id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_place;END IF;
  IF p_action='remove' THEN
    DELETE FROM public.quote_proposal_places WHERE id=p_place_id AND quote_id=v_quote.id RETURNING * INTO v_place;
    IF NOT FOUND THEN RAISE EXCEPTION 'Proposed place not found';END IF;
  ELSE
    IF p_action<>'create' OR p_place_kind NOT IN ('site','zone') OR v_name IS NULL OR char_length(v_name)>200 OR v_address IS NULL OR char_length(v_address)<4 OR char_length(v_address)>500 OR p_resolution NOT IN ('create_new','use_existing') OR p_geometry_source NOT IN ('manual','map_pin','linz_address','linz_parcel','document') THEN RAISE EXCEPTION 'Valid proposed place details are required';END IF;
    IF NOT EXISTS(SELECT 1 FROM public.quote_proposal_modules module WHERE module.quote_id=v_quote.id AND module.module_key=p_module_key) THEN RAISE EXCEPTION 'Proposed place requires a selected quote module';END IF;
    IF (p_place_kind='site' AND (p_zone_type IS NOT NULL OR p_candidate_zone_id IS NOT NULL OR (p_resolution='use_existing' AND (p_candidate_site_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.client_sites site WHERE site.id=p_candidate_site_id AND site.client_organization_id=v_quote.client_org_id))))) OR (p_place_kind='zone' AND (p_site_type IS NOT NULL OR p_candidate_site_id IS NOT NULL OR p_zone_type IS NULL OR (p_resolution='use_existing' AND (p_candidate_zone_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.location_zones zone WHERE zone.id=p_candidate_zone_id AND zone.organization_id=v_quote.client_org_id))))) THEN RAISE EXCEPTION 'Proposed place candidate does not belong to the quote client';END IF;
    INSERT INTO public.quote_proposal_places(quote_id,place_kind,name,address,module_key,site_type,zone_type,proposed_geometry,geometry_source,candidate_site_id,candidate_zone_id,resolution,client_request_id,created_by)
    VALUES(v_quote.id,p_place_kind,v_name,v_address,p_module_key,CASE WHEN p_place_kind='site' THEN coalesce(p_site_type,'commercial_premises') END,CASE WHEN p_place_kind='zone' THEN p_zone_type END,p_proposed_geometry,p_geometry_source,p_candidate_site_id,p_candidate_zone_id,p_resolution,p_client_request_id,v_actor)
    ON CONFLICT(quote_id,place_kind,name,address,module_key) DO UPDATE SET name=excluded.name RETURNING * INTO v_place;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_quote.provider_org_id,v_actor,'crm_quote_proposal_place_'||p_action,'quote_proposal_places',v_place.id,jsonb_build_object('quote_id',v_quote.id,'place_kind',v_place.place_kind,'module_key',v_place.module_key,'resolution',v_place.resolution));
  RETURN v_place;
END;$$;

CREATE OR REPLACE FUNCTION public.activate_quote_proposal_places() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE place public.quote_proposal_places%rowtype;v_site_id uuid;v_zone_id uuid;
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    FOR place IN SELECT * FROM public.quote_proposal_places WHERE quote_id=new.id LOOP
      IF place.place_kind='site' THEN
        IF place.resolution='use_existing' THEN v_site_id:=place.candidate_site_id;
        ELSE
          IF EXISTS(SELECT 1 FROM public.client_sites site WHERE site.client_organization_id=new.client_org_id AND site.address_match_key=regexp_replace(lower(place.address),'[^a-z0-9]+','','g')) THEN RAISE EXCEPTION 'Proposed Site requires duplicate resolution before acceptance';END IF;
          INSERT INTO public.client_sites(client_organization_id,name,address,address_match_key,site_type,active,site_origin,boundary_status,boundary_verification) VALUES(new.client_org_id,place.name,place.address,regexp_replace(lower(place.address),'[^a-z0-9]+','','g'),place.site_type,true,'contracted','provisional','unverified') RETURNING id INTO v_site_id;
        END IF;
        INSERT INTO public.service_agreement_locations(service_agreement_id,site_id,status,created_by) VALUES(new.service_agreement_id,v_site_id,'active',new.accepted_by) ON CONFLICT(service_agreement_id,site_id) DO UPDATE SET status='active',updated_at=clock_timestamp();
        INSERT INTO public.site_services(organization_id,service_agreement_id,module_key,site_id,service_hours,enabled,active,created_by) SELECT new.provider_org_id,new.service_agreement_id,place.module_key,v_site_id,'{}'::jsonb,true,true,new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.site_services service WHERE service.service_agreement_id=new.service_agreement_id AND service.module_key=place.module_key AND service.site_id=v_site_id);
        UPDATE public.quote_proposal_places SET converted_site_id=v_site_id,converted_at=clock_timestamp() WHERE id=place.id;
      ELSE
        IF place.resolution='use_existing' THEN v_zone_id:=place.candidate_zone_id;
        ELSE
          IF EXISTS(SELECT 1 FROM public.location_zones zone WHERE zone.organization_id=new.client_org_id AND zone.address_match_key=regexp_replace(lower(place.address),'[^a-z0-9]+','','g')) THEN RAISE EXCEPTION 'Proposed Zone requires duplicate resolution before acceptance';END IF;
          INSERT INTO public.location_zones(organization_id,name,address,address_match_key,zone_type,module_key,is_active,boundary_status,boundary_verification) VALUES(new.client_org_id,place.name,place.address,regexp_replace(lower(place.address),'[^a-z0-9]+','','g'),place.zone_type,place.module_key,true,'provisional','unverified') RETURNING id INTO v_zone_id;
        END IF;
        INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(new.service_agreement_id,v_zone_id,'active',new.accepted_by) ON CONFLICT(service_agreement_id,zone_id) DO UPDATE SET status='active',updated_at=clock_timestamp();
        INSERT INTO public.site_services(organization_id,service_agreement_id,module_key,zone_id,service_hours,enabled,active,created_by) SELECT new.provider_org_id,new.service_agreement_id,place.module_key,v_zone_id,'{}'::jsonb,true,true,new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.site_services service WHERE service.service_agreement_id=new.service_agreement_id AND service.module_key=place.module_key AND service.zone_id=v_zone_id);
        UPDATE public.quote_proposal_places SET converted_zone_id=v_zone_id,converted_at=clock_timestamp() WHERE id=place.id;
      END IF;
    END LOOP;
  END IF;
  RETURN new;
END;$$;
CREATE TRIGGER trg_activate_quote_proposal_places AFTER UPDATE OF status ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.activate_quote_proposal_places();
REVOKE ALL ON FUNCTION public.manage_crm_quote_proposal_place(uuid,uuid,text,uuid,text,text,text,text,text,text,jsonb,text,uuid,uuid,text),public.activate_quote_proposal_places() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_quote_proposal_place(uuid,uuid,text,uuid,text,text,text,text,text,text,jsonb,text,uuid,uuid,text) TO authenticated,service_role;
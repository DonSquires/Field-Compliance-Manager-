CREATE OR REPLACE FUNCTION public.activate_quote_proposal_places() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE place public.quote_proposal_places%rowtype;v_site_id uuid;v_zone_id uuid;v_point geometry;
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    FOR place IN SELECT * FROM public.quote_proposal_places WHERE quote_id=new.id LOOP
      IF place.place_kind='site' THEN
        IF place.resolution='use_existing' THEN v_site_id:=place.candidate_site_id;
        ELSE
          IF EXISTS(SELECT 1 FROM public.client_sites site WHERE site.client_organization_id=new.client_org_id AND site.address_match_key=regexp_replace(lower(place.address),'[^a-z0-9]+','','g')) THEN RAISE EXCEPTION 'Proposed Site requires duplicate resolution before acceptance';END IF;
          v_point:=CASE WHEN place.proposed_geometry IS NOT NULL AND place.proposed_geometry->>'type'='Point' THEN ST_SetSRID(ST_GeomFromGeoJSON(place.proposed_geometry::text),4326) ELSE NULL END;
          INSERT INTO public.client_sites(client_organization_id,name,address,address_match_key,site_type,active,site_origin,boundary_status,boundary_verification,center_point) VALUES(new.client_org_id,place.name,place.address,regexp_replace(lower(place.address),'[^a-z0-9]+','','g'),place.site_type,true,'contracted','provisional','unverified',v_point) RETURNING id INTO v_site_id;
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

CREATE OR REPLACE FUNCTION public.import_approved_freedom_places(p_places jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_place jsonb;
  v_client uuid;
  v_provider uuid;
  v_agreement uuid;
  v_location uuid;
  v_site uuid;
  v_zone uuid;
  v_geojson jsonb;
  v_created jsonb := '[]'::jsonb;
BEGIN
  IF NOT has_table_privilege(current_user, 'public.locations', 'INSERT') THEN RAISE EXCEPTION 'Service role table privilege required'; END IF;
  IF jsonb_typeof(p_places) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Places must be a JSON array'; END IF;
  FOR v_place IN SELECT value FROM jsonb_array_elements(p_places) LOOP
    v_client := (v_place->>'client_organization_id')::uuid;
    v_provider := (v_place->>'provider_organization_id')::uuid;
    v_agreement := (v_place->>'service_agreement_id')::uuid;
    IF v_client IS NULL OR v_provider IS NULL OR v_agreement IS NULL THEN RAISE EXCEPTION 'Client, provider, and agreement are required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_agreements WHERE id=v_agreement AND provider_organization_id=v_provider AND client_organization_id=v_client) THEN RAISE EXCEPTION 'Agreement does not bind the supplied organizations'; END IF;
    v_geojson := v_place->'geojson';
    IF v_geojson IS NULL OR v_geojson->>'type' NOT IN ('Polygon','MultiPolygon') THEN RAISE EXCEPTION 'Approved place geometry must be Polygon or MultiPolygon'; END IF;
    INSERT INTO public.locations(organization_id,name,address,notes,created_by)
      VALUES(v_client,v_place->>'location_name',NULL,'Imported from approved Freedom Camping jurisdiction source. Source project: '||coalesce(v_place->>'source_project','unknown')||'; source id: '||coalesce(v_place->>'source_id','unknown'),v_actor)
      ON CONFLICT DO NOTHING RETURNING id INTO v_location;
    IF v_location IS NULL THEN SELECT id INTO v_location FROM public.locations WHERE organization_id=v_client AND name=v_place->>'location_name' ORDER BY created_at DESC LIMIT 1; END IF;
    INSERT INTO public.client_sites(client_organization_id,organization_id,location_id,name,address,active,site_origin,ownership_status,ownership_signals,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,external_refs)
      VALUES(v_client,v_client,v_location,v_place->>'site_name',NULL,true,'contracted','resolved',jsonb_build_object('source','FreedomCamp-Manager','approval','user_directed_live_import'),ST_GeomFromGeoJSON(v_geojson::text),'authoritative','verified',v_actor,jsonb_build_object('source_project',v_place->>'source_project','source_id',v_place->>'source_id','source_sha256',v_place->>'source_sha256'))
      ON CONFLICT DO NOTHING RETURNING id INTO v_site;
    IF v_site IS NULL THEN SELECT id INTO v_site FROM public.client_sites WHERE client_organization_id=v_client AND location_id=v_location AND name=v_place->>'site_name' ORDER BY created_at DESC LIMIT 1; END IF;
    INSERT INTO public.location_zones(organization_id,location_id,site_id,name,zone_type,module_key,is_active,boundary,boundary_verification,boundary_status,boundary_verified_by,boundary_verified_at,metadata,bylaw_clause,nightly_limit_consecutive,nightly_limit_monthly,scv_required)
      VALUES(v_client,v_location,v_site,v_place->>'zone_name',coalesce(v_place->>'zone_type','freedom_camping'),v_place->>'module_key',true,ST_Multi(ST_GeomFromGeoJSON(v_geojson::text)),'verified','authoritative',v_actor,clock_timestamp(),jsonb_build_object('source_project',v_place->>'source_project','source_id',v_place->>'source_id','source_sha256',v_place->>'source_sha256','source_policy',v_place->'policy'),(v_place->'policy'->>'bylaw_clause'),(v_place->'policy'->>'nightly_limit_consecutive')::integer,(v_place->'policy'->>'nightly_limit_monthly')::integer,coalesce((v_place->'policy'->>'scv_required')::boolean,false))
      ON CONFLICT DO NOTHING RETURNING id INTO v_zone;
    IF v_zone IS NULL THEN SELECT id INTO v_zone FROM public.location_zones WHERE organization_id=v_client AND location_id=v_location AND name=v_place->>'zone_name' ORDER BY created_at DESC LIMIT 1; END IF;
    INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(v_agreement,v_zone,'active',v_actor) ON CONFLICT DO NOTHING;
    v_created := v_created || jsonb_build_object('location_id',v_location,'site_id',v_site,'zone_id',v_zone,'agreement_id',v_agreement,'source_id',v_place->>'source_id');
  END LOOP;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES((p_places->0->>'provider_organization_id')::uuid,v_actor,'freedom_places_imported','service_agreement_locations',null,jsonb_build_object('count',jsonb_array_length(p_places),'source_project',p_places->0->>'source_project','approval','user_directed_live_import'));
  RETURN v_created;
END;
$$;
REVOKE ALL ON FUNCTION public.import_approved_freedom_places(jsonb) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_approved_freedom_places(jsonb) TO service_role;

-- officer_field_reports already has real site_id/zone_id columns (with FKs to
-- client_sites/location_zones) but submit_officer_field_report never accepted
-- or wrote them - the frontend only ever set the free-text location_name/
-- address. This adds optional trailing params so ServiceRelationshipContext's
-- already-live geofence resolution (resolve_context_authorized watching GPS)
-- can populate the structured place reference, same site-XOR-zone pattern
-- used everywhere else in the house model. Additive - existing callers
-- omitting the new params are unaffected (both default null).
CREATE OR REPLACE FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_gps_lat double precision DEFAULT NULL::double precision, p_gps_lng double precision DEFAULT NULL::double precision, p_shift_id uuid DEFAULT NULL::uuid, p_immediate_action text DEFAULT NULL::text, p_follow_up_required boolean DEFAULT false, p_follow_up_notes text DEFAULT NULL::text, p_site_id uuid DEFAULT NULL::uuid, p_zone_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, created boolean, received_at timestamp with time zone, shift_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_home_org uuid;
  v_report_org uuid;
  v_shift public.shifts%rowtype;
  v_existing public.officer_field_reports%rowtype;
  v_report public.officer_field_reports%rowtype;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT p.organization_id INTO v_home_org
  FROM public.user_profiles p
  WHERE p.id=v_user_id AND p.deactivated_at IS NULL AND p.role IN('officer','admin_officer');
  IF v_home_org IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;
  IF p_client_event_id IS NULL THEN RAISE EXCEPTION 'client_event_id is required'; END IF;
  IF p_reported_at IS NULL OR p_reported_at > now()+interval '5 minutes' OR p_reported_at < now()-interval '24 hours' THEN RAISE EXCEPTION 'reported_at is outside the accepted capture window'; END IF;
  IF char_length(trim(coalesce(p_title,''))) NOT BETWEEN 5 AND 200 THEN RAISE EXCEPTION 'Title must be between 5 and 200 characters'; END IF;
  IF char_length(trim(coalesce(p_description,''))) NOT BETWEEN 10 AND 10000 THEN RAISE EXCEPTION 'Description must be between 10 and 10000 characters'; END IF;
  IF (p_gps_lat IS NULL) <> (p_gps_lng IS NULL) THEN RAISE EXCEPTION 'Both GPS coordinates are required together'; END IF;
  IF p_gps_lat IS NOT NULL AND (p_gps_lat NOT BETWEEN -90 AND 90 OR p_gps_lng NOT BETWEEN -180 AND 180) THEN RAISE EXCEPTION 'Invalid GPS coordinates'; END IF;
  IF p_follow_up_required AND nullif(trim(coalesce(p_follow_up_notes,'')),'') IS NULL THEN RAISE EXCEPTION 'Follow-up notes are required'; END IF;
  IF p_site_id IS NOT NULL AND p_zone_id IS NOT NULL THEN RAISE EXCEPTION 'A report resolves to a site or a zone, never both'; END IF;

  v_report_org := v_home_org;
  IF p_shift_id IS NOT NULL THEN
    SELECT s.* INTO v_shift
    FROM public.shifts s
    WHERE s.id=p_shift_id AND s.officer_user_id=v_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift does not belong to the authenticated officer'; END IF;
    v_report_org := v_shift.organization_id;
  END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id=p_site_id) THEN RAISE EXCEPTION 'Site not found'; END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id=p_zone_id) THEN RAISE EXCEPTION 'Zone not found'; END IF;

  SELECT r.* INTO v_existing
  FROM public.officer_field_reports r
  WHERE r.organization_id=v_report_org AND r.officer_id=v_user_id AND r.client_event_id=p_client_event_id;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id,false,v_existing.created_at,v_existing.shift_id; RETURN; END IF;

  INSERT INTO public.officer_field_reports(organization_id,officer_id,client_event_id,reported_at,report_type,severity,status,title,description,location_name,address,gps_lat,gps_lng,shift_id,immediate_action,follow_up_required,follow_up_notes,site_id,zone_id)
  VALUES(v_report_org,v_user_id,p_client_event_id,p_reported_at,p_report_type,p_severity,'submitted',trim(p_title),trim(p_description),nullif(trim(coalesce(p_location_name,'')),''),nullif(trim(coalesce(p_address,'')),''),p_gps_lat,p_gps_lng,p_shift_id,nullif(trim(coalesce(p_immediate_action,'')),''),coalesce(p_follow_up_required,false),nullif(trim(coalesce(p_follow_up_notes,'')),''),p_site_id,p_zone_id)
  RETURNING * INTO v_report;

  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_report_org,v_user_id,'officer_field_report_submitted','officer_field_reports',v_report.id,jsonb_build_object('report_type',v_report.report_type,'severity',v_report.severity,'shift_id',v_report.shift_id,'follow_up_required',v_report.follow_up_required,'site_id',v_report.site_id,'zone_id',v_report.zone_id));

  RETURN QUERY SELECT v_report.id,true,v_report.created_at,v_report.shift_id;
END;
$function$;
COMMENT ON FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text, p_address text, p_gps_lat double precision, p_gps_lng double precision, p_shift_id uuid, p_immediate_action text, p_follow_up_required boolean, p_follow_up_notes text, p_site_id uuid, p_zone_id uuid) IS 'Creates a retry-safe officer field report, storing branch-shift-linked evidence under the operating organization. site_id/zone_id are the geofence-resolved structured place (site XOR zone), populated by ServiceRelationshipContext''s live GPS resolution - see docs/canon/GEOFENCE_PRINCIPLES.md.';
REVOKE ALL ON FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text, p_address text, p_gps_lat double precision, p_gps_lng double precision, p_shift_id uuid, p_immediate_action text, p_follow_up_required boolean, p_follow_up_notes text, p_site_id uuid, p_zone_id uuid) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text, p_address text, p_gps_lat double precision, p_gps_lng double precision, p_shift_id uuid, p_immediate_action text, p_follow_up_required boolean, p_follow_up_notes text, p_site_id uuid, p_zone_id uuid) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text, p_address text, p_gps_lat double precision, p_gps_lng double precision, p_shift_id uuid, p_immediate_action text, p_follow_up_required boolean, p_follow_up_notes text, p_site_id uuid, p_zone_id uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."submit_officer_field_report"(p_client_event_id uuid, p_reported_at timestamp with time zone, p_report_type report_type, p_severity report_severity, p_title text, p_description text, p_location_name text, p_address text, p_gps_lat double precision, p_gps_lng double precision, p_shift_id uuid, p_immediate_action text, p_follow_up_required boolean, p_follow_up_notes text, p_site_id uuid, p_zone_id uuid) TO "service_role";

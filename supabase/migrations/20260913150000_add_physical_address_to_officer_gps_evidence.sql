ALTER TABLE public.officer_gps_log
  ADD COLUMN IF NOT EXISTS physical_address text;

COMMENT ON COLUMN public.officer_gps_log.physical_address IS
  'Reverse-resolved physical address captured with the device GPS fix. This is evidence provenance, not a replacement for the coordinate.';

DROP FUNCTION IF EXISTS public.record_officer_breadcrumb(uuid, timestamptz, double precision, double precision, double precision, double precision, double precision, text, uuid);

CREATE OR REPLACE FUNCTION public.record_officer_breadcrumb(
  p_client_event_id uuid,
  p_recorded_at timestamptz,
  p_gps_lat double precision,
  p_gps_lng double precision,
  p_accuracy_meters double precision DEFAULT NULL,
  p_heading double precision DEFAULT NULL,
  p_speed_kmh double precision DEFAULT NULL,
  p_activity_type text DEFAULT 'gps_update',
  p_shift_id uuid DEFAULT NULL,
  p_physical_address text DEFAULT NULL
) RETURNS TABLE (id uuid, created boolean, received_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.officer_gps_log%rowtype;
  v_created public.officer_gps_log%rowtype;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT up.organization_id INTO v_org_id FROM public.user_profiles up
  WHERE up.id = v_user_id AND up.deactivated_at IS NULL AND up.role IN ('officer', 'scan_operator');
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Active officer profile not found'; END IF;
  IF p_client_event_id IS NULL THEN RAISE EXCEPTION 'client_event_id is required'; END IF;
  IF p_recorded_at IS NULL OR p_recorded_at > now() + interval '5 minutes' OR p_recorded_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'recorded_at is outside the accepted capture window';
  END IF;
  IF p_gps_lat NOT BETWEEN -90 AND 90 OR p_gps_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Invalid GPS coordinates'; END IF;
  IF p_accuracy_meters IS NOT NULL AND p_accuracy_meters < 0 THEN RAISE EXCEPTION 'GPS accuracy cannot be negative'; END IF;
  IF p_activity_type NOT IN ('gps_update', 'shift_start', 'shift_end', 'scan', 'welfare_checkin', 'sos', 'checkpoint_scan') THEN
    RAISE EXCEPTION 'Unsupported breadcrumb activity type';
  END IF;
  IF p_shift_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = p_shift_id AND s.organization_id = v_org_id AND s.officer_user_id = v_user_id
  ) THEN RAISE EXCEPTION 'Shift does not belong to the authenticated officer'; END IF;

  SELECT g.* INTO v_existing FROM public.officer_gps_log g
  WHERE g.organization_id = v_org_id AND g.officer_id = v_user_id AND g.client_event_id = p_client_event_id;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id, false, v_existing.created_at; RETURN; END IF;

  BEGIN
    INSERT INTO public.officer_gps_log (
      organization_id, officer_id, client_event_id, recorded_at, gps_lat, gps_lng,
      accuracy_meters, heading, speed_kmh, activity_type, shift_id, physical_address
    ) VALUES (
      v_org_id, v_user_id, p_client_event_id, p_recorded_at, p_gps_lat, p_gps_lng,
      p_accuracy_meters, p_heading, p_speed_kmh, p_activity_type, p_shift_id, NULLIF(trim(p_physical_address), '')
    ) RETURNING * INTO v_created;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_created FROM public.officer_gps_log
    WHERE organization_id = v_org_id AND officer_id = v_user_id AND client_event_id = p_client_event_id;
    RETURN QUERY SELECT v_created.id, false, v_created.created_at; RETURN;
  END;
  RETURN QUERY SELECT v_created.id, true, v_created.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_officer_breadcrumb(uuid, timestamptz, double precision, double precision, double precision, double precision, double precision, text, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_officer_breadcrumb(uuid, timestamptz, double precision, double precision, double precision, double precision, double precision, text, uuid, text) TO authenticated, service_role;

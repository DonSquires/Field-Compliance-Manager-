ALTER TABLE public.shift_stops
  ADD COLUMN actual_travel_distance_km numeric(10,3),
  ADD COLUMN travel_from_stop_id uuid REFERENCES public.shift_stops(id),
  ADD COLUMN travel_distance_method text,
  ADD COLUMN travel_odometer_start_km numeric(12,3),
  ADD COLUMN travel_odometer_end_km numeric(12,3),
  ADD COLUMN travel_distance_version integer NOT NULL DEFAULT 0,
  ADD COLUMN travel_distance_recorded_at timestamptz,
  ADD COLUMN travel_distance_recorded_by uuid REFERENCES public.user_profiles(id),
  ADD CONSTRAINT shift_stop_actual_travel_shape CHECK (
    (actual_travel_distance_km IS NULL AND travel_from_stop_id IS NULL AND travel_distance_method IS NULL
      AND travel_odometer_start_km IS NULL AND travel_odometer_end_km IS NULL)
    OR (actual_travel_distance_km BETWEEN 0 AND 1000000 AND travel_from_stop_id IS NOT NULL AND travel_from_stop_id<>id
      AND travel_distance_recorded_at IS NOT NULL AND travel_distance_recorded_by IS NOT NULL
      AND ((travel_distance_method='recorded_km' AND travel_odometer_start_km IS NULL AND travel_odometer_end_km IS NULL)
        OR (travel_distance_method='odometer_difference' AND travel_odometer_start_km>=0
          AND travel_odometer_end_km>=travel_odometer_start_km
          AND actual_travel_distance_km=travel_odometer_end_km-travel_odometer_start_km)))
  );

CREATE OR REPLACE FUNCTION public.record_patrol_travel_distance(
  p_request_id uuid,p_from_stop_id uuid,p_to_stop_id uuid,
  p_distance_km numeric DEFAULT NULL,p_odometer_start_km numeric DEFAULT NULL,
  p_odometer_end_km numeric DEFAULT NULL,p_expected_version integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $function$
DECLARE
  v_actor uuid:=auth.uid();
  v_from public.shift_stops%rowtype;
  v_to public.shift_stops%rowtype;
  v_shift public.shifts%rowtype;
  v_distance numeric;
  v_method text;
  v_replay jsonb;
  v_result jsonb;
  v_before jsonb;
BEGIN
  IF v_actor IS NULL OR p_request_id IS NULL OR p_from_stop_id IS NULL OR p_to_stop_id IS NULL
    OR p_from_stop_id=p_to_stop_id THEN RAISE EXCEPTION 'Two different attended stops and a request identity are required'; END IF;
  SELECT * INTO v_to FROM public.shift_stops WHERE id=p_to_stop_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Destination stop not found'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id=v_to.shift_id;
  IF NOT FOUND OR v_shift.officer_user_id<>v_actor OR NOT EXISTS(
    SELECT 1 FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL
  ) THEN RAISE EXCEPTION 'Only the assigned active officer can record this patrol travel'; END IF;
  SELECT * INTO v_from FROM public.shift_stops WHERE id=p_from_stop_id FOR SHARE;
  IF NOT FOUND OR v_from.shift_id<>v_to.shift_id OR v_from.organization_id<>v_to.organization_id
    OR v_to.organization_id<>v_shift.organization_id THEN RAISE EXCEPTION 'Travel stops must belong to the same assigned patrol shift'; END IF;
  IF v_from.actual_departed_at IS NULL OR v_to.actual_arrived_at IS NULL
    OR v_from.status<>'completed' OR v_to.status NOT IN ('on_scene','completed')
    OR v_from.actual_departed_at>v_to.actual_arrived_at THEN
    RAISE EXCEPTION 'Record departure from the origin and arrival at the destination first';
  END IF;
  IF EXISTS(SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_shift.id
    AND st.id NOT IN(v_from.id,v_to.id) AND st.actual_arrived_at>v_from.actual_departed_at
    AND st.actual_arrived_at<v_to.actual_arrived_at) THEN
    RAISE EXCEPTION 'Another attended stop lies between these places; record the individual travel legs';
  END IF;
  IF (p_odometer_start_km IS NULL)<>(p_odometer_end_km IS NULL) THEN
    RAISE EXCEPTION 'Enter both odometer readings or a measured distance'; END IF;
  IF p_odometer_start_km IS NOT NULL THEN
    IF p_odometer_start_km<0 OR p_odometer_end_km<p_odometer_start_km THEN
      RAISE EXCEPTION 'Odometer reset or decreasing reading requires review'; END IF;
    v_distance:=p_odometer_end_km-p_odometer_start_km;
    v_method:='odometer_difference';
    IF p_distance_km IS NOT NULL AND p_distance_km<>v_distance THEN
      RAISE EXCEPTION 'Entered distance does not match the odometer difference'; END IF;
  ELSE
    v_distance:=p_distance_km;v_method:='recorded_km';
  END IF;
  IF v_distance IS NULL OR v_distance<0 OR v_distance>1000000 OR v_distance::text IN ('NaN','Infinity','-Infinity')
    OR v_distance<>round(v_distance,3) THEN RAISE EXCEPTION 'Record measured kilometres with at most three decimal places'; END IF;
  SELECT metadata->'result' INTO v_replay FROM public.audit_log
  WHERE organization_id=v_shift.organization_id AND actor_user_id=v_actor AND action='patrol_actual_travel_recorded'
    AND metadata->>'request_id'=p_request_id::text ORDER BY created_at DESC LIMIT 1;
  IF v_replay IS NOT NULL THEN
    IF v_replay->>'from_stop_id'<>p_from_stop_id::text OR v_replay->>'to_stop_id'<>p_to_stop_id::text
      OR (v_replay->>'distance_km')::numeric<>v_distance OR v_replay->>'method'<>v_method
      OR (v_replay->>'odometer_start_km')::numeric IS DISTINCT FROM p_odometer_start_km
      OR (v_replay->>'odometer_end_km')::numeric IS DISTINCT FROM p_odometer_end_km THEN
      RAISE EXCEPTION 'Travel request identity was already used for different evidence'; END IF;
    RETURN v_replay||jsonb_build_object('replayed',true);
  END IF;
  IF v_to.travel_distance_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Recorded travel changed; refresh before saving a correction'; END IF;
  v_before:=jsonb_build_object('distance_km',v_to.actual_travel_distance_km,'from_stop_id',v_to.travel_from_stop_id,
    'method',v_to.travel_distance_method,'version',v_to.travel_distance_version,
    'odometer_start_km',v_to.travel_odometer_start_km,'odometer_end_km',v_to.travel_odometer_end_km);
  PERFORM set_config('app.patrol_travel_write',p_request_id::text,true);
  UPDATE public.shift_stops SET actual_travel_distance_km=v_distance,travel_from_stop_id=v_from.id,
    travel_distance_method=v_method,travel_odometer_start_km=p_odometer_start_km,travel_odometer_end_km=p_odometer_end_km,
    travel_distance_version=travel_distance_version+1,travel_distance_recorded_at=clock_timestamp(),travel_distance_recorded_by=v_actor
  WHERE id=v_to.id RETURNING * INTO v_to;
  PERFORM set_config('app.patrol_travel_write','',true);
  v_result:=jsonb_build_object('reference',p_request_id,'from_stop_id',v_from.id,'to_stop_id',v_to.id,
    'distance_km',v_to.actual_travel_distance_km,'method',v_method,'version',v_to.travel_distance_version,
    'recorded_at',v_to.travel_distance_recorded_at,'replayed',false,
    'odometer_start_km',v_to.travel_odometer_start_km,'odometer_end_km',v_to.travel_odometer_end_km);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_shift.organization_id,v_actor,'patrol_actual_travel_recorded','shift_stops',v_to.id,
    jsonb_build_object('request_id',p_request_id,'before',v_before,'result',v_result));
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_patrol_travel_distance(uuid,uuid,uuid,numeric,numeric,numeric,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_patrol_travel_distance(uuid,uuid,uuid,numeric,numeric,numeric,integer) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.protect_patrol_travel_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public
AS $function$
BEGIN
  IF (TG_OP='INSERT' AND (NEW.actual_travel_distance_km IS NOT NULL OR NEW.travel_from_stop_id IS NOT NULL
      OR NEW.travel_distance_method IS NOT NULL OR NEW.travel_distance_version<>0))
    OR (TG_OP='UPDATE' AND ROW(NEW.actual_travel_distance_km,NEW.travel_from_stop_id,NEW.travel_distance_method,
      NEW.travel_odometer_start_km,NEW.travel_odometer_end_km,NEW.travel_distance_version,
      NEW.travel_distance_recorded_at,NEW.travel_distance_recorded_by)
      IS DISTINCT FROM ROW(OLD.actual_travel_distance_km,OLD.travel_from_stop_id,OLD.travel_distance_method,
      OLD.travel_odometer_start_km,OLD.travel_odometer_end_km,OLD.travel_distance_version,
      OLD.travel_distance_recorded_at,OLD.travel_distance_recorded_by)) THEN
    IF nullif(current_setting('app.patrol_travel_write',true),'') IS NULL THEN
      RAISE EXCEPTION 'Record patrol travel through the audited travel command'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER protect_patrol_travel_fields BEFORE INSERT OR UPDATE ON public.shift_stops
FOR EACH ROW EXECUTE FUNCTION public.protect_patrol_travel_fields();

DO $patch$
DECLARE v_definition text;v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('public.get_officer_patrol_stops(uuid)'::regprocedure);
  v_anchor:='''arrival_verification'', st.arrival_verification';
  IF length(v_definition)-length(replace(v_definition,v_anchor,''))<>length(v_anchor) THEN
    RAISE EXCEPTION 'Officer stop read changed; review travel field projection before applying'; END IF;
  EXECUTE replace(v_definition,v_anchor,
    '''actual_travel_distance_km'', st.actual_travel_distance_km, ''travel_from_stop_id'', st.travel_from_stop_id, '
    ||'''travel_distance_method'', st.travel_distance_method, ''travel_distance_version'', st.travel_distance_version, '
    ||v_anchor);
END;
$patch$;
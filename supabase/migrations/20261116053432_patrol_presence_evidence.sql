CREATE TABLE public.patrol_billing_evidence_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  accuracy_meters numeric NOT NULL CHECK (
    accuracy_meters>0 AND accuracy_meters::text NOT IN ('NaN','Infinity','-Infinity')),
  max_gap_seconds integer NOT NULL CHECK (max_gap_seconds>0),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  version integer NOT NULL CHECK (version>0),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,version),
  UNIQUE(organization_id,effective_from),
  CHECK (effective_to IS NULL OR effective_to>effective_from)
);
COMMENT ON TABLE public.patrol_billing_evidence_policies IS
  'Explicit operating-organization limits for GPS billing evidence. Append-only limits with exclusive effective_to; no implicit accuracy or gap defaults.';
CREATE INDEX patrol_billing_evidence_policies_actor_idx ON public.patrol_billing_evidence_policies(created_by);
ALTER TABLE public.patrol_billing_evidence_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.patrol_billing_evidence_policies FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.patrol_billing_evidence_policy_receipts (
  client_request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL REFERENCES public.user_profiles(id),
  policy_id uuid NOT NULL REFERENCES public.patrol_billing_evidence_policies(id),
  request_fingerprint jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX patrol_billing_evidence_policy_receipts_org_idx ON public.patrol_billing_evidence_policy_receipts(organization_id);
CREATE INDEX patrol_billing_evidence_policy_receipts_actor_idx ON public.patrol_billing_evidence_policy_receipts(actor_id);
CREATE INDEX patrol_billing_evidence_policy_receipts_policy_idx ON public.patrol_billing_evidence_policy_receipts(policy_id);
ALTER TABLE public.patrol_billing_evidence_policy_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.patrol_billing_evidence_policy_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.manage_patrol_billing_evidence_policy(
  p_client_request_id uuid,p_organization_id uuid,p_expected_policy_id uuid,
  p_accuracy_meters numeric,p_max_gap_seconds integer,p_effective_from timestamptz
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_current public.patrol_billing_evidence_policies%rowtype;
  v_policy public.patrol_billing_evidence_policies%rowtype;
  v_existing public.patrol_billing_evidence_policy_receipts%rowtype;
  v_fingerprint jsonb;
  v_at timestamptz;
  v_from timestamptz;
  v_receipt jsonb;
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=v_actor AND p.deactivated_at IS NULL)
    OR NOT public.is_admin_for_org(p_organization_id)
    OR NOT public.user_can_operate_organization(p_organization_id) THEN
    RAISE EXCEPTION 'Active operating administrator authority required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_accuracy_meters IS NULL OR p_accuracy_meters<=0
    OR p_accuracy_meters::text IN ('NaN','Infinity','-Infinity')
    OR p_max_gap_seconds IS NULL OR p_max_gap_seconds<=0 THEN
    RAISE EXCEPTION 'Explicit positive finite accuracy and sample-gap limits are required';
  END IF;
  IF p_effective_from IS NOT NULL AND NOT isfinite(p_effective_from) THEN
    RAISE EXCEPTION 'Policy effective time must be finite';
  END IF;
  v_fingerprint := jsonb_build_object('organization_id',p_organization_id,
    'expected_policy_id',p_expected_policy_id,'accuracy_meters',p_accuracy_meters,
    'max_gap_seconds',p_max_gap_seconds,'effective_from_epoch',extract(epoch FROM p_effective_from));
  PERFORM pg_advisory_xact_lock(hashtextextended('patrol-policy-request:'||p_client_request_id,0));
  SELECT * INTO v_existing FROM public.patrol_billing_evidence_policy_receipts r
    WHERE r.client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_existing.actor_id<>v_actor OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'Evidence policy request replay conflicts with its original save';
    END IF;
    RETURN v_existing.receipt;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patrol-policy-org:'||p_organization_id,0));
  SELECT * INTO v_current FROM public.patrol_billing_evidence_policies p
    WHERE p.organization_id=p_organization_id ORDER BY p.effective_from DESC LIMIT 1 FOR UPDATE;
  IF v_current.id IS DISTINCT FROM p_expected_policy_id THEN
    RAISE EXCEPTION 'Evidence policy changed; reload the latest version before saving';
  END IF;
  v_at := clock_timestamp();
  v_from := coalesce(p_effective_from,v_at);
  IF v_from<v_at THEN
    RAISE EXCEPTION 'Evidence policy cannot be backdated into past captures; choose effective now or a future time';
  END IF;
  IF v_current.id IS NOT NULL AND v_from<=v_current.effective_from THEN
    RAISE EXCEPTION 'New evidence policy must follow the latest scheduled version';
  END IF;
  IF v_current.id IS NOT NULL THEN
    UPDATE public.patrol_billing_evidence_policies SET effective_to=v_from WHERE id=v_current.id;
  END IF;
  INSERT INTO public.patrol_billing_evidence_policies(
    organization_id,accuracy_meters,max_gap_seconds,effective_from,version,created_by,created_at)
  VALUES(p_organization_id,p_accuracy_meters,p_max_gap_seconds,v_from,coalesce(v_current.version,0)+1,v_actor,v_at)
  RETURNING * INTO v_policy;
  v_receipt := jsonb_build_object('policy',to_jsonb(v_policy),'previous_policy_id',v_current.id);
  INSERT INTO public.patrol_billing_evidence_policy_receipts(
    client_request_id,organization_id,actor_id,policy_id,request_fingerprint,receipt)
  VALUES(p_client_request_id,p_organization_id,v_actor,v_policy.id,v_fingerprint,v_receipt);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(p_organization_id,v_actor,'patrol_billing_evidence_policy_saved',
    'patrol_billing_evidence_policies',v_policy.id,
    jsonb_build_object('client_request_id',p_client_request_id,'previous_policy_id',v_current.id,
      'accuracy_meters',p_accuracy_meters,'max_gap_seconds',p_max_gap_seconds,'effective_from',v_from));
  RETURN v_receipt;
END;
$$;
COMMENT ON FUNCTION public.manage_patrol_billing_evidence_policy(uuid,uuid,uuid,numeric,integer,timestamptz)
IS 'Append an authorized explicit GPS evidence policy with stale-version protection and actor-bound retry receipt. NULL effective_from explicitly means effective immediately at server save time; otherwise supply a future time. Historical captures are never requalified by backdating.';
REVOKE ALL ON FUNCTION public.manage_patrol_billing_evidence_policy(uuid,uuid,uuid,numeric,integer,timestamptz)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.manage_patrol_billing_evidence_policy(uuid,uuid,uuid,numeric,integer,timestamptz)
TO authenticated;

CREATE INDEX officer_gps_log_patrol_evidence_idx
  ON public.officer_gps_log(shift_id,officer_id,recorded_at,id);
CREATE INDEX geofence_boundary_history_capture_idx
  ON public.geofence_boundary_history(entity_type,entity_id,created_at DESC,version DESC);

CREATE FUNCTION public.classify_patrol_presence_fix_internal(p_gps_log_id uuid,p_service_agreement_location_id uuid)
RETURNS TABLE(gps_log_id uuid,recorded_at timestamptz,policy_id uuid,
  boundary_history_id uuid,classification text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $$
DECLARE
  v_gps public.officer_gps_log%rowtype;
  v_covered public.service_agreement_locations%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_policy public.patrol_billing_evidence_policies%rowtype;
  v_boundary public.geofence_boundary_history%rowtype;
  v_classification text := 'uncertain';
  v_reason text;
  v_distance double precision;
BEGIN
  SELECT * INTO v_gps FROM public.officer_gps_log g WHERE g.id=p_gps_log_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GPS source record is required'; END IF;
  SELECT * INTO v_covered FROM public.service_agreement_locations l WHERE l.id=p_service_agreement_location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contracted place is required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements a WHERE a.id=v_covered.service_agreement_id;
  IF NOT FOUND OR (v_covered.site_id IS NULL)=(v_covered.zone_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one place facet on an existing service agreement is required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.shifts s WHERE s.id=v_gps.shift_id
      AND s.officer_user_id=v_gps.officer_id AND s.organization_id=v_gps.organization_id)
    OR NOT (v_gps.organization_id=v_agreement.provider_organization_id
      OR v_gps.organization_id=ANY(public.get_descendant_organizations(v_agreement.provider_organization_id))) THEN
    RAISE EXCEPTION 'GPS source does not belong to an owned shift in the contracted operating organization';
  END IF;
  SELECT * INTO v_policy FROM public.patrol_billing_evidence_policies p
  WHERE p.organization_id=v_gps.organization_id AND p.effective_from<=v_gps.recorded_at
    AND p.created_at<=v_gps.recorded_at
    AND (p.effective_to IS NULL OR p.effective_to>v_gps.recorded_at)
  ORDER BY p.effective_from DESC LIMIT 1;
  SELECT * INTO v_boundary FROM public.geofence_boundary_history h
  WHERE h.entity_type=CASE WHEN v_covered.site_id IS NOT NULL THEN 'client_site' ELSE 'location_zone' END
    AND h.entity_id=coalesce(v_covered.site_id,v_covered.zone_id) AND h.created_at<=v_gps.recorded_at
  ORDER BY h.created_at DESC,h.version DESC,h.id DESC LIMIT 1;
  IF v_policy.id IS NULL THEN v_reason := 'missing_effective_policy';
  ELSIF v_boundary.id IS NULL THEN v_reason := 'missing_historical_boundary';
  ELSIF v_boundary.verification_state IS DISTINCT FROM 'verified'
    OR v_boundary.verified_at IS NULL OR v_boundary.verified_at>v_gps.recorded_at THEN
    v_reason := 'boundary_not_verified_at_capture';
  ELSIF v_boundary.boundary IS NULL OR ST_IsEmpty(v_boundary.boundary)
    OR NOT ST_IsValid(v_boundary.boundary) OR ST_SRID(v_boundary.boundary)<>4326
    OR GeometryType(v_boundary.boundary) NOT IN ('POLYGON','MULTIPOLYGON')
    OR ST_XMin(v_boundary.boundary)<-180 OR ST_XMax(v_boundary.boundary)>180
    OR ST_YMin(v_boundary.boundary)<-90 OR ST_YMax(v_boundary.boundary)>90 THEN
    v_reason := 'invalid_historical_boundary';
  ELSIF v_gps.accuracy_meters IS NULL OR v_gps.accuracy_meters::text IN ('NaN','Infinity','-Infinity')
    OR v_gps.accuracy_meters<0 OR v_gps.accuracy_meters>v_policy.accuracy_meters THEN
    v_reason := 'accuracy_not_qualified';
  ELSIF v_gps.gps_lat NOT BETWEEN -90 AND 90 OR v_gps.gps_lng NOT BETWEEN -180 AND 180
    OR ST_X(v_gps.gps_point) IS DISTINCT FROM v_gps.gps_lng
    OR ST_Y(v_gps.gps_point) IS DISTINCT FROM v_gps.gps_lat THEN
    v_reason := 'invalid_source_position';
  ELSE
    v_distance := ST_Distance(v_gps.gps_point::geography,ST_Boundary(v_boundary.boundary)::geography);
    IF v_distance<=v_gps.accuracy_meters THEN
      v_reason := 'accuracy_disk_crosses_boundary';
    ELSE
      v_classification := CASE WHEN ST_Covers(v_boundary.boundary,v_gps.gps_point) THEN 'inside' ELSE 'outside' END;
      v_reason := 'reliable_point';
    END IF;
  END IF;
  RETURN QUERY SELECT v_gps.id,v_gps.recorded_at,v_policy.id,v_boundary.id,v_classification,v_reason;
END;
$$;
COMMENT ON FUNCTION public.classify_patrol_presence_fix_internal(uuid,uuid)
IS 'Private read-only classification of one canonical GPS fix against its operating policy and verified historical place fence. A reliable point is not a qualified presence interval or a billable hour.';
REVOKE ALL ON FUNCTION public.classify_patrol_presence_fix_internal(uuid,uuid)
FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.project_patrol_presence_intervals_internal(p_shift_id uuid,p_service_agreement_location_id uuid)
RETURNS TABLE(started_at timestamptz,ended_at timestamptz,duration_seconds numeric,
  policy_id uuid,boundary_history_id uuid,inside_fix_count integer,source_event_ids uuid[],
  entry_event_ids uuid[],exit_event_ids uuid[],qualification_state text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public
AS $$
DECLARE
  v_shift public.shifts%rowtype;
BEGIN
  SELECT * INTO v_shift FROM public.shifts s WHERE s.id=p_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source shift is required'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.shift_stops ss
    JOIN public.shift_stop_modules m ON m.shift_stop_id=ss.id AND m.organization_id=ss.organization_id
    JOIN public.service_agreement_locations l ON l.id=m.service_agreement_location_id
    JOIN public.service_agreements a ON a.id=l.service_agreement_id
    WHERE ss.shift_id=v_shift.id AND ss.organization_id=v_shift.organization_id
      AND l.id=p_service_agreement_location_id
      AND ss.site_id IS NOT DISTINCT FROM l.site_id AND ss.zone_id IS NOT DISTINCT FROM l.zone_id
      AND (v_shift.organization_id=a.provider_organization_id
        OR v_shift.organization_id=ANY(public.get_descendant_organizations(a.provider_organization_id)))
  ) THEN RAISE EXCEPTION 'An explicit contracted stop attribution in this operating shift is required'; END IF;

  RETURN QUERY
  WITH fixes AS MATERIALIZED (
    SELECT g.id,g.recorded_at,c.policy_id,c.boundary_history_id,c.classification,p.max_gap_seconds
    FROM public.officer_gps_log g
    CROSS JOIN LATERAL public.classify_patrol_presence_fix_internal(g.id,p_service_agreement_location_id) c
    LEFT JOIN public.patrol_billing_evidence_policies p ON p.id=c.policy_id
    WHERE g.shift_id=v_shift.id AND g.officer_id=v_shift.officer_user_id
      AND g.organization_id=v_shift.organization_id AND g.recorded_at>=v_shift.actual_start
      AND g.recorded_at<=least(coalesce(v_shift.actual_end,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)
  ), moments AS (
    SELECT f.recorded_at,(array_agg(f.policy_id ORDER BY f.id))[1] AS policy_id,
      (array_agg(f.boundary_history_id ORDER BY f.id))[1] AS boundary_history_id,
      min(f.max_gap_seconds) AS max_gap_seconds,array_agg(f.id ORDER BY f.id) AS source_ids,
      CASE WHEN bool_and(f.classification='inside') THEN 'inside'
        WHEN bool_and(f.classification='outside') THEN 'outside' ELSE 'uncertain' END AS point_state
    FROM fixes f GROUP BY f.recorded_at
  ), neighbors AS (
    SELECT m.*,lag(m.recorded_at) OVER w AS prior_at,lead(m.recorded_at) OVER w AS next_at,
      lag(m.point_state) OVER w AS prior_state,lead(m.point_state) OVER w AS next_state,
      lag(m.policy_id) OVER w AS prior_policy,lead(m.policy_id) OVER w AS next_policy,
      lag(m.boundary_history_id) OVER w AS prior_boundary,lead(m.boundary_history_id) OVER w AS next_boundary,
      lag(m.source_ids) OVER w AS prior_sources,lead(m.source_ids) OVER w AS next_sources
    FROM moments m WINDOW w AS (ORDER BY m.recorded_at)
  ), grouped AS MATERIALIZED (
    SELECT n.*,sum(CASE WHEN n.point_state='inside' AND n.prior_state='inside'
      AND n.policy_id IS NOT DISTINCT FROM n.prior_policy
      AND n.boundary_history_id IS NOT DISTINCT FROM n.prior_boundary
      AND extract(epoch FROM n.recorded_at-n.prior_at)<=n.max_gap_seconds THEN 0 ELSE 1 END)
      OVER (ORDER BY n.recorded_at) AS segment_id
    FROM neighbors n
  ), spans AS (
    SELECT g.segment_id,g.policy_id,g.boundary_history_id,min(g.recorded_at) AS first_at,
      max(g.recorded_at) AS last_at,count(*)::integer AS fix_count,min(g.max_gap_seconds) AS gap_seconds
    FROM grouped g WHERE g.point_state='inside'
    GROUP BY g.segment_id,g.policy_id,g.boundary_history_id
  ), resolved AS (
    SELECT s.*,
      CASE WHEN a.prior_state='outside' AND a.prior_policy=s.policy_id
        AND a.prior_boundary=s.boundary_history_id
        AND extract(epoch FROM s.first_at-a.prior_at)<=s.gap_seconds
        THEN a.prior_sources END AS prior_sources,
      CASE WHEN b.next_state='outside' AND b.next_policy=s.policy_id
        AND b.next_boundary=s.boundary_history_id
        AND extract(epoch FROM b.next_at-s.last_at)<=s.gap_seconds
        THEN b.next_sources END AS next_sources,
      ARRAY(SELECT q.id FROM (
        SELECT unnest(g.source_ids) AS id FROM grouped g WHERE g.segment_id=s.segment_id
        UNION SELECT unnest(a.prior_sources)
        UNION SELECT unnest(b.next_sources)
      ) q ORDER BY q.id) AS all_sources,
      CASE
        WHEN s.fix_count<2 THEN 'insufficient_inside_fixes'
        WHEN a.prior_state IS DISTINCT FROM 'outside' THEN 'missing_confirmed_entry'
        WHEN b.next_state IS DISTINCT FROM 'outside' THEN 'missing_confirmed_exit'
        WHEN a.prior_policy IS DISTINCT FROM s.policy_id OR b.next_policy IS DISTINCT FROM s.policy_id
          OR a.prior_boundary IS DISTINCT FROM s.boundary_history_id OR b.next_boundary IS DISTINCT FROM s.boundary_history_id
          THEN 'evidence_context_changed'
        WHEN extract(epoch FROM s.first_at-a.prior_at)>s.gap_seconds
          OR extract(epoch FROM b.next_at-s.last_at)>s.gap_seconds THEN 'sample_gap'
        ELSE 'paired_boundary_evidence'
      END AS resolution
    FROM spans s
    JOIN grouped a ON a.segment_id=s.segment_id AND a.recorded_at=s.first_at
    JOIN grouped b ON b.segment_id=s.segment_id AND b.recorded_at=s.last_at
  )
  SELECT r.first_at,r.last_at,extract(epoch FROM r.last_at-r.first_at),r.policy_id,r.boundary_history_id,
    r.fix_count,r.all_sources,coalesce(r.prior_sources,'{}'::uuid[]),coalesce(r.next_sources,'{}'::uuid[]),
    CASE WHEN r.resolution='paired_boundary_evidence' THEN 'qualified' ELSE 'review' END,r.resolution
  FROM resolved r
  UNION ALL
  SELECT NULL::timestamptz,NULL::timestamptz,NULL::numeric,NULL::uuid,NULL::uuid,0,
    ARRAY(SELECT f.id FROM fixes f ORDER BY f.id),'{}'::uuid[],'{}'::uuid[],'review',
    CASE WHEN v_shift.actual_start IS NULL THEN 'missing_actual_start'
      WHEN NOT EXISTS(SELECT 1 FROM fixes) THEN 'missing_gps' ELSE 'no_qualified_inside_fixes' END
  WHERE NOT EXISTS(SELECT 1 FROM resolved);
END;
$$;
COMMENT ON FUNCTION public.project_patrol_presence_intervals_internal(uuid,uuid)
IS 'Private read-only projection of GPS presence for an explicitly attributed contracted stop. Distinct capture instants, consistent policy/fence, accuracy and gap limits, confirmed entry and exit, and at least two inside fixes are required. Uses only first-to-last inside elapsed seconds. Does not persist, claim or invoice evidence.';
REVOKE ALL ON FUNCTION public.project_patrol_presence_intervals_internal(uuid,uuid)
FROM PUBLIC,anon,authenticated,service_role;

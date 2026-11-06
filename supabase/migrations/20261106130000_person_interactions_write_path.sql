-- Person interactions get a governed write path (owner request 2026-11-06).
-- Officers recorded field dealings with people (for example a trespass outcome on a dispatch job) with no way
-- to put them on the person's profile: person_interactions had RLS and no writer at all. Officers may now
-- record an interaction on their own dispatch job or shift, naming an existing person or a new one. A new
-- person is created as a draft (manual_review_required) for administrator review; officers never edit
-- identity details. Administrators may record against any job or shift in their organisation. Every write
-- is idempotent per client request and audited.

ALTER TABLE public.person_interactions
  ADD COLUMN IF NOT EXISTS person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_request_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'field',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.person_interactions
  DROP CONSTRAINT IF EXISTS person_interactions_source_chk,
  ADD CONSTRAINT person_interactions_source_chk CHECK (source IN ('field', 'admin', 'bob'));
ALTER TABLE public.person_interactions
  DROP CONSTRAINT IF EXISTS person_interactions_type_chk,
  ADD CONSTRAINT person_interactions_type_chk CHECK (interaction_type IN (
    'spoken_to', 'warning_given', 'trespass_notice_served', 'moved_on', 'welfare_check',
    'observed', 'report_attached', 'other'));

CREATE UNIQUE INDEX IF NOT EXISTS person_interactions_client_request_uidx
  ON public.person_interactions (organization_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_interactions_person ON public.person_interactions (person_id, interacted_at DESC);
CREATE INDEX IF NOT EXISTS idx_person_interactions_person_record ON public.person_interactions (person_record_id, interacted_at DESC);
CREATE INDEX IF NOT EXISTS idx_person_interactions_dispatch_job ON public.person_interactions (dispatch_job_id);
CREATE INDEX IF NOT EXISTS idx_person_interactions_shift ON public.person_interactions (shift_id);
CREATE INDEX IF NOT EXISTS idx_person_interactions_officer ON public.person_interactions (officer_user_id);
CREATE INDEX IF NOT EXISTS idx_person_interactions_created_by ON public.person_interactions (created_by);
CREATE INDEX IF NOT EXISTS idx_person_interactions_evidence ON public.person_interactions (evidence_id);

COMMENT ON COLUMN public.person_interactions.person_record_id IS 'The organisation''s own person record the interaction was recorded against; person_id is its global canonical identity.';
COMMENT ON COLUMN public.person_interactions.dispatch_job_id IS 'Dispatch job the interaction happened on, when there was one.';
COMMENT ON COLUMN public.person_interactions.shift_id IS 'Shift the interaction happened on, when there was one.';
COMMENT ON COLUMN public.person_interactions.source IS 'field (officer portal), admin (back office) or bob (confirmed Bob chat update).';

CREATE OR REPLACE FUNCTION public.record_person_interaction(
  p_client_request_id uuid,
  p_organization_id uuid,
  p_interaction_type text,
  p_notes text,
  p_person_record_id uuid DEFAULT NULL,
  p_new_person_name text DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_interacted_at timestamptz DEFAULT NULL,
  p_source text DEFAULT 'field'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_is_admin boolean;
  v_can_search boolean;
  v_job public.dispatch_jobs%rowtype;
  v_shift public.shifts%rowtype;
  v_existing public.person_interactions%rowtype;
  v_person_id uuid := p_person_record_id;
  v_canonical_id uuid;
  v_matches uuid[];
  v_created boolean := false;
  v_name text := nullif(regexp_replace(trim(coalesce(p_new_person_name, '')), '\s+', ' ', 'g'), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_at timestamptz := coalesce(p_interacted_at, clock_timestamp());
  v_officer uuid;
  v_location uuid;
  v_site uuid;
  v_zone uuid;
  v_interaction public.person_interactions%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in to record a person interaction' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_profile FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_profile.id IS NULL THEN RAISE EXCEPTION 'Your account is not active' USING ERRCODE = '42501'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'A client request id is required'; END IF;
  IF p_organization_id IS NULL THEN RAISE EXCEPTION 'Choose the organisation this interaction belongs to'; END IF;
  IF p_interaction_type IS NULL OR p_interaction_type NOT IN (
    'spoken_to', 'warning_given', 'trespass_notice_served', 'moved_on', 'welfare_check',
    'observed', 'report_attached', 'other') THEN
    RAISE EXCEPTION 'Choose what happened with this person';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('field', 'admin', 'bob') THEN RAISE EXCEPTION 'Unsupported interaction source'; END IF;
  IF v_notes IS NULL OR length(v_notes) < 3 THEN RAISE EXCEPTION 'Describe what happened with this person'; END IF;
  IF length(v_notes) > 4000 THEN RAISE EXCEPTION 'Interaction notes must be 4000 characters or fewer'; END IF;
  IF v_at > clock_timestamp() + interval '5 minutes' THEN RAISE EXCEPTION 'The interaction time cannot be in the future'; END IF;
  IF (p_person_record_id IS NULL) = (v_name IS NULL) THEN RAISE EXCEPTION 'Choose an existing person or enter a new person''s name'; END IF;
  IF v_name IS NOT NULL AND (length(v_name) < 2 OR length(v_name) > 120) THEN RAISE EXCEPTION 'Enter the person''s name as given (2 to 120 characters)'; END IF;
  IF p_dispatch_job_id IS NULL AND p_shift_id IS NULL THEN RAISE EXCEPTION 'Record the interaction against a dispatch job or shift'; END IF;

  -- A retried request returns the interaction it already recorded instead of writing a second one.
  SELECT * INTO v_existing FROM public.person_interactions
  WHERE organization_id = p_organization_id AND client_request_id = p_client_request_id;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.created_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'This request id was already used' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object('interaction_id', v_existing.id, 'person_record_id', v_existing.person_record_id,
      'outcome', 'already_recorded');
  END IF;

  v_is_admin := public.is_admin_for_org(p_organization_id);
  v_can_search := v_is_admin OR public.can_search_people(p_organization_id);

  IF p_dispatch_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_dispatch_job_id;
    IF v_job.id IS NULL OR v_job.organization_id IS DISTINCT FROM p_organization_id THEN RAISE EXCEPTION 'Dispatch job not found in this organisation'; END IF;
    IF NOT v_is_admin THEN
      IF NOT (v_job.assigned_officer_id = v_actor
        OR EXISTS (SELECT 1 FROM public.dispatch_resources dr WHERE dr.id = v_job.dispatch_resource_id AND dr.assigned_officer_id = v_actor)
        OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = v_job.shift_id AND s.officer_user_id = v_actor)) THEN
        RAISE EXCEPTION 'Only the officer on this job or an administrator can record people for it' USING ERRCODE = '42501';
      END IF;
      IF v_job.status = 'cancelled' OR (v_job.completed_at IS NOT NULL AND v_job.completed_at < clock_timestamp() - interval '24 hours') THEN
        RAISE EXCEPTION 'This job is closed; ask an administrator to add the interaction' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF p_shift_id IS NULL AND v_job.shift_id IS NOT NULL THEN
      SELECT * INTO v_shift FROM public.shifts WHERE id = v_job.shift_id;
    END IF;
  END IF;

  IF p_shift_id IS NOT NULL THEN
    SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
    IF v_shift.id IS NULL OR v_shift.organization_id IS DISTINCT FROM p_organization_id THEN RAISE EXCEPTION 'Shift not found in this organisation'; END IF;
    IF v_job.id IS NOT NULL AND v_job.shift_id IS DISTINCT FROM v_shift.id THEN RAISE EXCEPTION 'The dispatch job is not on this shift'; END IF;
    IF NOT v_is_admin AND v_job.id IS NULL THEN
      IF v_shift.officer_user_id IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the officer on this shift or an administrator can record people for it' USING ERRCODE = '42501';
      END IF;
      IF v_shift.status NOT IN ('accepted', 'in_progress', 'completed')
        OR (v_shift.actual_end IS NOT NULL AND v_shift.actual_end < clock_timestamp() - interval '24 hours') THEN
        RAISE EXCEPTION 'This shift is closed; ask an administrator to add the interaction' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  v_location := coalesce(v_job.location_id, v_shift.location_id);
  v_site := v_job.client_site_id;
  v_zone := coalesce(v_job.zone_id, v_shift.zone_id);
  IF v_location IS NULL AND v_site IS NULL AND v_zone IS NULL THEN
    RAISE EXCEPTION 'This job or shift has no place recorded, so the interaction cannot be anchored';
  END IF;
  -- An administrator recording after the fact credits the officer who was on the job or shift.
  v_officer := CASE WHEN v_is_admin THEN coalesce(v_job.assigned_officer_id, v_shift.officer_user_id, v_actor) ELSE v_actor END;

  IF p_person_record_id IS NOT NULL THEN
    IF NOT v_can_search THEN
      RAISE EXCEPTION 'Enter the person''s name; choosing an existing record needs person-search access' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.person_records pr
      WHERE pr.id = p_person_record_id AND pr.organization_id = p_organization_id
        AND NOT (pr.metadata ? 'merged_into_person_record_id')
        AND NOT (pr.metadata ? 'resolved_into_person_record_id')
    ) THEN RAISE EXCEPTION 'Person record not found in this organisation'; END IF;
  ELSE
    -- Serialise per organisation and name so two officers naming the same person at once share one draft.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || coalesce(public.normalize_person_name(v_name), ''), 0));
    SELECT array_agg(pr.id) INTO v_matches FROM public.person_records pr
    WHERE pr.organization_id = p_organization_id
      AND public.normalize_person_name(pr.display_name) = public.normalize_person_name(v_name)
      AND NOT (pr.metadata ? 'merged_into_person_record_id')
      AND NOT (pr.metadata ? 'resolved_into_person_record_id');
    IF cardinality(v_matches) = 1 THEN
      v_person_id := v_matches[1];
    ELSE
      INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
      VALUES (p_organization_id, v_name, 'manual_review_required', jsonb_strip_nulls(jsonb_build_object(
        'profile_details', jsonb_build_object('category', 'Field interaction'),
        'created_from', 'person_interaction', 'recorded_by', v_actor,
        'dispatch_job_id', v_job.id, 'shift_id', v_shift.id,
        'possible_duplicate_count', CASE WHEN cardinality(v_matches) > 1 THEN cardinality(v_matches) END)))
      RETURNING id INTO v_person_id;
      v_created := true;
    END IF;
  END IF;

  v_canonical_id := public.ensure_canonical_person_for_record(v_person_id);
  IF v_canonical_id IS NULL THEN RAISE EXCEPTION 'The person''s platform identity could not be confirmed'; END IF;

  INSERT INTO public.person_interactions (
    organization_id, person_id, person_record_id, officer_user_id, interaction_type, notes, interacted_at,
    location_id, client_site_id, zone_id, dispatch_job_id, shift_id, client_request_id, created_by, source)
  VALUES (
    p_organization_id, v_canonical_id, v_person_id, v_officer, p_interaction_type, v_notes, v_at,
    v_location, v_site, v_zone, v_job.id, v_shift.id, p_client_request_id, v_actor, p_source)
  RETURNING * INTO v_interaction;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'person_interaction_recorded', 'person_interactions', v_interaction.id,
    jsonb_strip_nulls(jsonb_build_object(
      'person_record_id', v_person_id, 'canonical_person_id', v_canonical_id, 'person_created', v_created,
      'interaction_type', p_interaction_type, 'dispatch_job_id', v_job.id, 'shift_id', v_shift.id, 'source', p_source)));

  -- Officers without person-search access are not told whether the name matched an existing record.
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'interaction_id', v_interaction.id,
    'person_record_id', v_person_id,
    'outcome', 'recorded',
    'person_created', CASE WHEN v_can_search THEN v_created END,
    'review_state', CASE WHEN v_can_search THEN (SELECT review_state FROM public.person_records WHERE id = v_person_id) END));
END;
$function$;

COMMENT ON FUNCTION public.record_person_interaction(uuid, uuid, text, text, uuid, text, uuid, uuid, timestamptz, text) IS
  'Officer/admin write path for person interaction history. Officers record on their own dispatch job or shift; a new name creates a manual-review draft person. Idempotent per client request and audited.';
REVOKE ALL ON FUNCTION public.record_person_interaction(uuid, uuid, text, text, uuid, text, uuid, uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_person_interaction(uuid, uuid, text, text, uuid, text, uuid, uuid, timestamptz, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_person_interactions(p_canonical_person_id uuid, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to read person history' USING ERRCODE = '42501'; END IF;
  IF p_canonical_person_id IS NULL THEN RAISE EXCEPTION 'Choose a person'; END IF;

  -- Each organisation's history is shown only to its administrators and person-search users.
  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(history) ORDER BY history.interacted_at DESC)
    FROM (
      SELECT pi.id, pi.organization_id, org.name AS organization_name, pi.interaction_type, pi.notes, pi.interacted_at,
        pi.source, pi.dispatch_job_id, pi.shift_id, dj.job_type, coalesce(cs.name, z.name) AS place_name,
        officer.display_name AS officer_name
      FROM public.person_interactions pi
      JOIN public.organizations org ON org.id = pi.organization_id
      LEFT JOIN public.dispatch_jobs dj ON dj.id = pi.dispatch_job_id
      LEFT JOIN public.client_sites cs ON cs.id = pi.client_site_id
      LEFT JOIN public.location_zones z ON z.id = pi.zone_id
      LEFT JOIN public.user_profiles officer ON officer.id = pi.officer_user_id
      WHERE pi.person_id = p_canonical_person_id
        AND (public.is_admin_for_org(pi.organization_id) OR public.can_search_people(pi.organization_id))
      ORDER BY pi.interacted_at DESC
      LIMIT v_limit
    ) history
  ), '[]'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.get_person_interactions(uuid, integer) IS
  'Interaction history for one canonical person, limited to organisations where the caller is an administrator or person-search user.';
REVOKE ALL ON FUNCTION public.get_person_interactions(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_person_interactions(uuid, integer) TO authenticated, service_role;

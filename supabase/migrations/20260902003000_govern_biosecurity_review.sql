ALTER TABLE public.biosecurity_assessments
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'awaiting_review',
  ADD COLUMN IF NOT EXISTS review_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS review_priority text NOT NULL DEFAULT 'routine',
  ADD COLUMN IF NOT EXISTS assigned_reviewer_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS species_review_decision text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confirmed_species_name text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;

ALTER TABLE public.biosecurity_assessments
  DROP CONSTRAINT IF EXISTS biosecurity_assessments_review_status_check,
  DROP CONSTRAINT IF EXISTS biosecurity_assessments_review_priority_check,
  DROP CONSTRAINT IF EXISTS biosecurity_assessments_species_review_decision_check,
  DROP CONSTRAINT IF EXISTS biosecurity_assessments_review_version_check;

ALTER TABLE public.biosecurity_assessments
  ADD CONSTRAINT biosecurity_assessments_review_status_check
    CHECK (review_status IN ('awaiting_review', 'triaged', 'follow_up', 'closed')),
  ADD CONSTRAINT biosecurity_assessments_review_priority_check
    CHECK (review_priority IN ('urgent', 'high', 'routine', 'monitor')),
  ADD CONSTRAINT biosecurity_assessments_species_review_decision_check
    CHECK (species_review_decision IN ('pending', 'confirmed', 'rejected', 'insufficient_evidence')),
  ADD CONSTRAINT biosecurity_assessments_review_version_check
    CHECK (review_version > 0);

CREATE INDEX IF NOT EXISTS idx_biosecurity_review_queue
  ON public.biosecurity_assessments (organization_id, review_status, review_priority, review_due_at, assessed_at DESC);

REVOKE UPDATE, DELETE ON TABLE public.biosecurity_assessments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.manage_biosecurity_assessment_review(
  p_assessment_id uuid,
  p_expected_review_version integer,
  p_action text,
  p_priority text,
  p_assigned_reviewer_id uuid,
  p_review_due_at timestamptz,
  p_species_decision text,
  p_confirmed_species_name text,
  p_notes text
)
RETURNS TABLE(
  assessment_id uuid,
  review_status text,
  review_version integer,
  review_priority text,
  assigned_reviewer_id uuid,
  review_due_at timestamptz,
  species_review_decision text,
  confirmed_species_name text,
  species_confirmed boolean,
  follow_up_required boolean,
  reviewed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_item public.biosecurity_assessments%rowtype;
  v_next_status text;
  v_notes text := NULLIF(BTRIM(COALESCE(p_notes, '')), '');
  v_species_name text := NULLIF(BTRIM(COALESCE(p_confirmed_species_name, '')), '');
  v_officer uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT assessment.* INTO v_item
  FROM public.biosecurity_assessments assessment
  WHERE assessment.id = p_assessment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Biosecurity assessment not found';
  END IF;
  IF NOT public.is_admin_for_org(v_item.organization_id) THEN
    RAISE EXCEPTION 'Active Biosecurity administrator required';
  END IF;
  IF v_item.review_version <> p_expected_review_version THEN
    RAISE EXCEPTION 'Biosecurity review changed from expected version % to %', p_expected_review_version, v_item.review_version;
  END IF;
  IF v_notes IS NULL OR char_length(v_notes) < 10 THEN
    RAISE EXCEPTION 'Review rationale must contain at least 10 characters';
  END IF;
  IF p_priority NOT IN ('urgent', 'high', 'routine', 'monitor') THEN
    RAISE EXCEPTION 'Unsupported biosecurity review priority';
  END IF;
  IF p_assigned_reviewer_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles reviewer
    WHERE reviewer.id = p_assigned_reviewer_id
      AND reviewer.organization_id = v_item.organization_id
      AND reviewer.deactivated_at IS NULL
      AND reviewer.role IN ('grand_master', 'master', 'admin', 'admin_officer')
  ) THEN
    RAISE EXCEPTION 'Active organization reviewer required';
  END IF;

  IF p_action = 'triage' AND v_item.review_status IN ('awaiting_review', 'triaged', 'follow_up') THEN
    v_next_status := 'triaged';
    IF p_species_decision <> 'pending' THEN
      RAISE EXCEPTION 'Triage cannot make the final species decision';
    END IF;
  ELSIF p_action = 'require_follow_up' AND v_item.review_status IN ('awaiting_review', 'triaged', 'follow_up') THEN
    v_next_status := 'follow_up';
    IF p_species_decision <> 'insufficient_evidence' THEN
      RAISE EXCEPTION 'Follow-up requires an insufficient-evidence decision';
    END IF;
  ELSIF p_action = 'close' AND v_item.review_status IN ('awaiting_review', 'triaged', 'follow_up') THEN
    v_next_status := 'closed';
    IF p_species_decision NOT IN ('confirmed', 'rejected') THEN
      RAISE EXCEPTION 'Closure requires a confirmed or rejected species decision';
    END IF;
    IF p_species_decision = 'confirmed' AND v_species_name IS NULL THEN
      RAISE EXCEPTION 'Confirmed species name is required';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported Biosecurity review transition from % using %', v_item.review_status, p_action;
  END IF;

  IF v_next_status <> 'closed' THEN
    IF p_review_due_at IS NULL OR p_review_due_at <= v_now THEN
      RAISE EXCEPTION 'An active review requires a future due date';
    END IF;
    IF (p_priority = 'urgent' AND p_review_due_at > v_now + interval '2 days')
       OR (p_priority = 'high' AND p_review_due_at > v_now + interval '7 days')
       OR (p_priority = 'routine' AND p_review_due_at > v_now + interval '30 days')
       OR (p_priority = 'monitor' AND p_review_due_at > v_now + interval '90 days') THEN
      RAISE EXCEPTION 'Review due date exceeds the selected priority window';
    END IF;
  END IF;

    UPDATE public.biosecurity_assessments AS assessment
  SET review_status = v_next_status,
      review_version = assessment.review_version + 1,
      review_priority = p_priority,
      assigned_reviewer_id = p_assigned_reviewer_id,
      review_due_at = CASE WHEN v_next_status = 'closed' THEN NULL ELSE p_review_due_at END,
      species_review_decision = p_species_decision,
      confirmed_species_name = CASE WHEN p_species_decision = 'confirmed' THEN v_species_name ELSE NULL END,
      species_confirmed = p_species_decision = 'confirmed',
      reviewed_by = v_actor,
      reviewed_at = v_now,
      review_notes = v_notes,
      follow_up_required = v_next_status = 'follow_up',
      status = CASE WHEN v_next_status = 'closed' THEN 'closed' ELSE 'open' END
  WHERE assessment.id = v_item.id
  RETURNING * INTO v_item;

  v_officer := COALESCE(v_item.officer_user_id, v_item.officer_id);
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_item.organization_id,
    v_actor,
    'biosecurity_assessment_reviewed',
    'biosecurity_assessments',
    v_item.id,
    jsonb_build_object(
      'review_action', p_action,
      'review_status', v_item.review_status,
      'review_version', v_item.review_version,
      'priority', v_item.review_priority,
      'assigned_reviewer_id', v_item.assigned_reviewer_id,
      'species_decision', v_item.species_review_decision,
      'source_officer_id', v_officer,
      'rationale', v_notes
    )
  );

  IF v_officer IS NOT NULL THEN
    PERFORM public.enqueue_notification(
      p_organization_id => v_item.organization_id,
      p_category => 'biosecurity_review',
      p_title => CASE
        WHEN v_next_status = 'follow_up' THEN 'Biosecurity evidence follow-up required'
        WHEN v_next_status = 'closed' THEN 'Biosecurity assessment decision recorded'
        ELSE 'Biosecurity assessment triaged'
      END,
      p_body => v_notes,
      p_severity => CASE WHEN v_item.review_priority IN ('urgent', 'high') OR v_next_status = 'follow_up' THEN 'warning' ELSE 'info' END,
      p_recipient_user_id => v_officer,
      p_link_page => 'biosecurity-review',
      p_link_payload => jsonb_build_object('assessment_id', v_item.id),
      p_dedup_key => 'biosecurity_review:' || v_item.id::text || ':' || v_item.review_version::text
    );
  END IF;

  RETURN QUERY SELECT
    v_item.id,
    v_item.review_status,
    v_item.review_version,
    v_item.review_priority,
    v_item.assigned_reviewer_id,
    v_item.review_due_at,
    v_item.species_review_decision,
    v_item.confirmed_species_name,
    v_item.species_confirmed,
    v_item.follow_up_required,
    v_item.reviewed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_biosecurity_assessment_review(uuid, integer, text, text, uuid, timestamptz, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_biosecurity_assessment_review(uuid, integer, text, text, uuid, timestamptz, text, text, text) TO authenticated, service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check CHECK (category IN (
  'credential_expiry', 'sla_breach', 'report_ready', 'report_reviewed', 'leave_decision',
  'timesheet_decision', 'breach_decision', 'debrief_followup', 'noise_review', 'biosecurity_review',
  'welfare', 'dispatch', 'roster', 'open_job', 'system', 'schema_change_request',
  'bob_conversation', 'bob_self_memory'
));

COMMENT ON FUNCTION public.manage_biosecurity_assessment_review(uuid, integer, text, text, uuid, timestamptz, text, text, text)
IS 'Versioned administrator review boundary for biosecurity triage, evidence follow-up, and explicit human species decisions. Audits and personally notifies the reporting officer.';
CREATE OR REPLACE FUNCTION public.reopen_approved_timesheet(
  p_timesheet_id uuid,
  p_expected_revision integer,
  p_reason text
)
RETURNS public.timesheets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_sheet public.timesheets%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_previous_approved_by uuid;
  v_previous_approved_at timestamptz;
  v_previous_branch_reviewed_by uuid;
  v_previous_branch_reviewed_at timestamptz;
  v_previous_branch_review_notes text;
  v_previous_branch_reviewed_organization_id uuid;
  v_officer_user_id uuid;
BEGIN
  SELECT * INTO v_sheet
  FROM public.timesheets
  WHERE id = p_timesheet_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_sheet.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'A reason of 1 to 2000 characters is required';
  END IF;
  IF v_sheet.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Timesheet changed; reload before reopening';
  END IF;
  IF v_sheet.status <> 'approved' OR v_sheet.payroll_export_batch_id IS NOT NULL OR v_sheet.payroll_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'Only approved, unexported timesheets can be reopened';
  END IF;
  v_previous_approved_by := v_sheet.approved_by;
  v_previous_approved_at := v_sheet.approved_at;
  v_previous_branch_reviewed_by := v_sheet.branch_reviewed_by;
  v_previous_branch_reviewed_at := v_sheet.branch_reviewed_at;
  v_previous_branch_review_notes := v_sheet.branch_review_notes;
  v_previous_branch_reviewed_organization_id := v_sheet.branch_reviewed_organization_id;

  UPDATE public.timesheets
  SET status = 'submitted',
      revision = revision + 1,
      approved_by = NULL,
      approved_at = NULL,
      branch_reviewed_by = NULL,
      branch_reviewed_at = NULL,
      branch_review_notes = NULL,
      branch_reviewed_organization_id = NULL,
      review_notes = v_reason
  WHERE id = v_sheet.id
  RETURNING * INTO v_sheet;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_sheet.organization_id, auth.uid(), 'timesheet_reopened', 'timesheets', v_sheet.id,
    jsonb_build_object(
      'reason', v_reason,
      'previous_status', 'approved',
      'previous_revision', p_expected_revision,
      'previous_approved_by', v_previous_approved_by,
      'previous_approved_at', v_previous_approved_at,
      'previous_branch_reviewed_by', v_previous_branch_reviewed_by,
      'previous_branch_reviewed_at', v_previous_branch_reviewed_at,
      'previous_branch_review_notes', v_previous_branch_review_notes,
      'previous_branch_reviewed_organization_id', v_previous_branch_reviewed_organization_id
    )
  );

  SELECT coalesce(sp.user_id, sp.id) INTO v_officer_user_id
  FROM public.staff_profiles sp WHERE sp.id = v_sheet.staff_id;
  IF v_officer_user_id IS NOT NULL THEN
    PERFORM public.enqueue_notification(
      p_organization_id => v_sheet.organization_id,
      p_category => 'timesheet_decision',
      p_title => 'Timesheet returned for review',
      p_body => 'Your approved timesheet was returned for review: ' || v_reason,
      p_severity => 'info',
      p_recipient_user_id => v_officer_user_id,
      p_link_page => 'timesheet-decision',
      p_link_payload => jsonb_build_object('timesheet_id', v_sheet.id, 'status', 'submitted'),
      p_dedup_key => 'timesheet_reopened:' || v_sheet.id::text || ':' || v_sheet.revision::text
    );
  END IF;

  RETURN v_sheet;
END;
$function$;
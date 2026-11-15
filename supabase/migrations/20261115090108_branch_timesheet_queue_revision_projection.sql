-- The correction RPC requires the revision displayed by each queue row.
-- PostgreSQL requires recreation, not replacement, when a TABLE result gains a column.
DROP FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz);
DROP FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz, uuid);

CREATE FUNCTION public.get_branch_timesheet_queue(
  p_operating_organization_id uuid,
  p_from timestamp with time zone DEFAULT NULL,
  p_to timestamp with time zone DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  staff_id uuid,
  period_start date,
  period_end date,
  scheduled_hours numeric,
  actual_hours numeric,
  work_derived_hours numeric,
  adjustment_hours numeric,
  work_summary jsonb,
  status text,
  branch_review_notes text,
  branch_reviewed_by uuid,
  submitted_at timestamp with time zone,
  revision integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then
    raise exception 'Active authorized operating branch required';
  end if;

  return query
    select
      t.id, t.staff_id, t.period_start, t.period_end,
      t.scheduled_hours, t.actual_hours, t.work_derived_hours, t.adjustment_hours,
      t.work_summary, t.status, t.branch_review_notes, t.branch_reviewed_by, t.submitted_at, t.revision
    from public.timesheets t
    join public.staff_profiles staff on staff.id = t.staff_id
    join public.staff_branch_authorisations assignment
      on assignment.user_id = coalesce(staff.user_id, staff.id)
     and assignment.branch_org_id = p_operating_organization_id
     and assignment.status = 'active'
    where public.user_can_exercise_branch_authority(
            p_operating_organization_id,
            coalesce(staff.user_id, staff.id),
            'timesheet_local_review'
          )
      and (p_from is null or t.period_end >= p_from::date)
      and (p_to is null or t.period_start <= p_to::date)
    order by t.period_start desc;
end;
$function$;

CREATE FUNCTION public.get_branch_timesheet_queue(
  p_operating_organization_id uuid,
  p_from timestamp with time zone,
  p_to timestamp with time zone,
  p_staff_id uuid
)
RETURNS TABLE(
  id uuid,
  staff_id uuid,
  period_start date,
  period_end date,
  scheduled_hours numeric,
  actual_hours numeric,
  work_derived_hours numeric,
  adjustment_hours numeric,
  work_summary jsonb,
  status text,
  branch_review_notes text,
  branch_reviewed_by uuid,
  submitted_at timestamp with time zone,
  revision integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_operate_organization(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch required';
  END IF;
  RETURN QUERY
    SELECT t.id,t.staff_id,t.period_start,t.period_end,t.scheduled_hours,t.actual_hours,
      t.work_derived_hours,t.adjustment_hours,t.work_summary,t.status,t.branch_review_notes,
      t.branch_reviewed_by,t.submitted_at,t.revision
    FROM public.timesheets t
    JOIN public.staff_profiles staff ON staff.id=t.staff_id
    JOIN public.staff_branch_authorisations assignment
      ON assignment.user_id=coalesce(staff.user_id,staff.id)
     AND assignment.branch_org_id=p_operating_organization_id AND assignment.status='active'
    WHERE (p_staff_id IS NULL OR t.staff_id=p_staff_id)
      AND public.user_can_exercise_branch_authority(p_operating_organization_id,
        coalesce(staff.user_id,staff.id),'timesheet_local_review')
      AND (p_from IS NULL OR t.period_end>=p_from::date)
      AND (p_to IS NULL OR t.period_start<=p_to::date)
    ORDER BY t.period_start DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz) TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid, timestamptz, timestamptz, uuid) TO postgres, authenticated, service_role;
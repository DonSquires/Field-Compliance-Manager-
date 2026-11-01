-- Branch reviewers could not see when an officer submitted time: the submit
-- RPCs stamp timesheets.submitted_at, but this queue never returned it, so the
-- oldest waiting sheet looked the same as one sent a minute ago. Return the
-- existing column; branch authority scoping is unchanged.
--
-- Changing a RETURNS TABLE shape needs DROP + CREATE, which resets EXECUTE to
-- the PUBLIC default. 20260905005800 recreated this function that way and lost
-- the authenticated-only grant from 20260905005500, so restore it here.
DROP FUNCTION IF EXISTS public.get_branch_timesheet_queue(uuid);

CREATE FUNCTION public.get_branch_timesheet_queue(p_operating_organization_id uuid)
 RETURNS TABLE(id uuid, staff_id uuid, period_start date, period_end date, scheduled_hours numeric, actual_hours numeric, work_derived_hours numeric, adjustment_hours numeric, work_summary jsonb, status text, branch_review_notes text, branch_reviewed_by uuid, submitted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required';end if;
  return query select t.id,t.staff_id,t.period_start,t.period_end,t.scheduled_hours,t.actual_hours,t.work_derived_hours,t.adjustment_hours,t.work_summary,t.status,t.branch_review_notes,t.branch_reviewed_by,t.submitted_at from public.timesheets t join public.staff_profiles staff on staff.id=t.staff_id join public.staff_branch_authorisations assignment on assignment.user_id=coalesce(staff.user_id,staff.id) and assignment.branch_org_id=p_operating_organization_id and assignment.status='active' where public.user_can_exercise_branch_authority(p_operating_organization_id,coalesce(staff.user_id,staff.id),'timesheet_local_review') order by t.period_start desc;
end;$function$;

REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid) TO authenticated, service_role;

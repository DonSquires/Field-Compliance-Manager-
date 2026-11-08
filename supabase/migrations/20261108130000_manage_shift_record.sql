-- Allow roster administrators to manually correct a shift record from the
-- timesheet / attendance exception workflow.  This is the governed write path
-- behind the new independent Timesheets page.
--
-- Authority: authenticated user must be an active administrator for the shift's
-- owning organization.  Optimistic locking via p_expected_updated_at prevents
-- silently overwriting concurrent edits.

CREATE OR REPLACE FUNCTION public.manage_shift_record(
  p_shift_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_scheduled_start timestamp with time zone DEFAULT NULL,
  p_scheduled_end timestamp with time zone DEFAULT NULL,
  p_actual_start timestamp with time zone DEFAULT NULL,
  p_actual_end timestamp with time zone DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_now timestamptz := clock_timestamp();
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_shift_id is null then raise exception 'Shift identifier is required'; end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;

  if not public.is_admin_for_org(v_shift.organization_id) then
    raise exception 'Roster administrator access required';
  end if;

  if p_expected_updated_at is not null and v_shift.updated_at <> p_expected_updated_at then
    raise exception 'Shift was updated by another session; please reload and try again';
  end if;

  if v_reason is null then
    raise exception 'A reason for the edit is required';
  end if;

  update public.shifts
  set
    scheduled_start = coalesce(p_scheduled_start, scheduled_start),
    scheduled_end   = coalesce(p_scheduled_end, scheduled_end),
    actual_start    = coalesce(p_actual_start, actual_start),
    actual_end      = coalesce(p_actual_end, actual_end),
    service_type    = coalesce(nullif(trim(p_service_type), ''), service_type),
    status          = coalesce(nullif(trim(p_status), ''), status),
    notes           = coalesce(notes, '') || E'\n[' || v_now::text || ' admin edit] ' || v_reason,
    updated_at      = v_now
  where id = p_shift_id
  returning * into v_shift;

  insert into public.audit_log(
    organization_id, actor_user_id, action,
    target_table, target_id, metadata
  ) values (
    v_shift.organization_id, v_actor, 'shift_record_corrected',
    'shifts', v_shift.id,
    jsonb_build_object(
      'scheduled_start', p_scheduled_start,
      'scheduled_end', p_scheduled_end,
      'actual_start', p_actual_start,
      'actual_end', p_actual_end,
      'service_type', p_service_type,
      'status', p_status,
      'reason', v_reason
    )
  );

  return v_shift;
end;
$function$;

REVOKE ALL ON FUNCTION public.manage_shift_record(
  uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone,
  timestamp with time zone, timestamp with time zone, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.manage_shift_record(
  uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone,
  timestamp with time zone, timestamp with time zone, text, text, text
) TO postgres;

GRANT EXECUTE ON FUNCTION public.manage_shift_record(
  uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone,
  timestamp with time zone, timestamp with time zone, text, text, text
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.manage_shift_record(
  uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone,
  timestamp with time zone, timestamp with time zone, text, text, text
) TO service_role;

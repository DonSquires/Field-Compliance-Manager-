create or replace function public.get_officer_recovery_readiness(p_shift_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  with source as materialized (
    select public.get_shift_end_readiness(p_shift_id) as readiness
  )
  select jsonb_build_object(
    'shift_id', source.readiness -> 'shift_id',
    'status', source.readiness -> 'status',
    'scheduled_end', source.readiness -> 'scheduled_end',
    'actual_start', source.readiness -> 'actual_start',
    'open_stops', '[]'::jsonb,
    'open_stop_count', source.readiness -> 'open_stop_count',
    'open_required_task_count', source.readiness -> 'open_required_task_count',
    'open_dispatch_job_count', source.readiness -> 'open_dispatch_job_count',
    'active_welfare_alert_count', source.readiness -> 'active_welfare_alert_count',
    'debrief_submitted', source.readiness -> 'debrief_submitted',
    'blockers', '[]'::jsonb,
    'can_end', source.readiness -> 'can_end',
    'can_end_after_debrief', source.readiness -> 'can_end_after_debrief'
  )
  from source;
$function$;

revoke all on function public.get_officer_recovery_readiness(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_officer_recovery_readiness(uuid) to postgres, authenticated;

comment on function public.get_officer_recovery_readiness(uuid) is
  'Count-only shift recovery projection. Delegates authorization to get_shift_end_readiness and withholds stop names and other unreviewed text.';
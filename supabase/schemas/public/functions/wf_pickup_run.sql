create or replace function public.wf_pickup_run (
  _job_id    uuid,
  _runner_id text
)
  returns public.wf_runs
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _run public.wf_runs%rowtype;
begin
  insert into public.wf_runs (job_id, runner_id, status, picked_up_at)
  values (_job_id, _runner_id, 'picked_up', now())
  returning * into _run;

  perform public.wf_transition_job_state(_job_id, 'running', concat('runner pickup ', _runner_id), 'runner');

  return _run;
end;
$function$;

grant execute on function "public"."wf_pickup_run"(uuid, text) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_pickup_run"(uuid, text) from public;

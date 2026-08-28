create or replace function public.wf_create_job (
  _title   text,
  _payload jsonb default '{}'::jsonb
)
  returns public.wf_jobs
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _uid uuid := (select auth.uid());
  _job public.wf_jobs%rowtype;
begin
  if _uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.wf_jobs (title, payload, state, created_by)
  values (_title, coalesce(_payload, '{}'::jsonb), 'draft', _uid)
  returning * into _job;

  insert into public.wf_state_events (job_id, from_state, to_state, reason, actor_user_id, actor_type)
  values (_job.id, null, 'draft', 'job created', _uid, 'user');

  return _job;
end;
$function$;

grant execute on function "public"."wf_create_job"(text, jsonb) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_create_job"(text, jsonb) from public;

create or replace function public.wf_record_promotion (
  _job_id uuid,
  _note   text default null::text
)
  returns public.wf_jobs
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _job public.wf_jobs%rowtype;
begin
  select * into _job
  from public.wf_transition_job_state(_job_id, 'promoted', coalesce(_note, 'manual promotion'), 'user');

  return _job;
end;
$function$;

grant execute on function "public"."wf_record_promotion"(uuid, text) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_record_promotion"(uuid, text) from public;

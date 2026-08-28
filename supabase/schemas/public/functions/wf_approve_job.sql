create or replace function public.wf_approve_job (
  _job_id   uuid,
  _stage    public.wf_approval_stage,
  _decision public.wf_approval_decision,
  _comment  text                        default null::text
)
  returns public.wf_jobs
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _uid uuid := (select auth.uid());
  _next public.wf_job_state;
  _job public.wf_jobs%rowtype;
begin
  if _uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.wf_approvals (job_id, stage, decision, comment, decided_by)
  values (_job_id, _stage, _decision, _comment, _uid);

  if _decision = 'rejected' then
    _next := 'failed';
  elsif _stage = 'verify' then
    _next := 'verified';
  else
    _next := 'ratified';
  end if;

  select * into _job
  from public.wf_transition_job_state(
    _job_id,
    _next,
    concat('approval ', _stage::text, ':', _decision::text),
    'user'
  );

  return _job;
end;
$function$;

grant execute on function "public"."wf_approve_job"(uuid, public.wf_approval_stage, public.wf_approval_decision, text) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_approve_job"(uuid, public.wf_approval_stage, public.wf_approval_decision, text) from public;

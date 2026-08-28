create or replace function public.wf_transition_job_state (
  _job_id     uuid,
  _to_state   public.wf_job_state,
  _reason     text                 default null::text,
  _actor_type public.wf_actor_type default 'user'::public.wf_actor_type
)
  returns public.wf_jobs
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _job public.wf_jobs%rowtype;
  _from_state public.wf_job_state;
  _uid uuid := (select auth.uid());
  _allowed boolean := false;
begin
  if _uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into _job
  from public.wf_jobs
  where id = _job_id
  for update;

  if not found then
    raise exception 'Job not found: %', _job_id;
  end if;

  _from_state := _job.state;

  if _from_state = _to_state then
    raise exception 'No-op transition % -> % is not allowed', _from_state, _to_state;
  end if;

  _allowed :=
    ((_from_state = 'draft' and _to_state = 'verify_pending') and (_job.created_by = _uid or (select public.wf_has_role('operator'))))
    or ((_from_state = 'verify_pending' and _to_state = 'verified') and (select public.wf_has_role('verifier')))
    or ((_from_state = 'verified' and _to_state = 'ratify_pending') and ((select public.wf_has_role('operator')) or (select public.wf_has_role('verifier'))))
    or ((_from_state = 'ratify_pending' and _to_state = 'ratified') and (select public.wf_has_role('ratifier')))
    or ((_from_state = 'ratified' and _to_state = 'running') and ((select public.wf_has_role('runner')) or (select public.wf_has_role('operator'))))
    or ((_from_state = 'running' and _to_state = 'promoted') and (select public.wf_has_role('operator')) and exists (
      select 1 from public.wf_runs r where r.job_id = _job_id and r.status = 'succeeded'
    ))
    or (_to_state = 'failed' and (
      _job.created_by = _uid
      or (select public.wf_has_role('verifier'))
      or (select public.wf_has_role('ratifier'))
      or (select public.wf_has_role('operator'))
      or (select public.wf_has_role('runner'))
    ));

  if not _allowed then
    raise exception 'Illegal transition % -> % for user %', _from_state, _to_state, _uid;
  end if;

  update public.wf_jobs
  set
    state = _to_state,
    verified_at = case when _to_state = 'verified' then now() else verified_at end,
    ratified_at = case when _to_state = 'ratified' then now() else ratified_at end,
    promoted_at = case when _to_state = 'promoted' then now() else promoted_at end
  where id = _job_id
  returning * into _job;

  insert into public.wf_state_events (job_id, from_state, to_state, reason, actor_user_id, actor_type)
  values (_job_id, _from_state, _to_state, _reason, _uid, _actor_type);

  return _job;
end;
$function$;

grant execute on function "public"."wf_transition_job_state"(uuid, public.wf_job_state, text, public.wf_actor_type) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_transition_job_state"(uuid, public.wf_job_state, text, public.wf_actor_type) from public;

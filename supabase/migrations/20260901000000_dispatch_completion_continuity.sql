drop function if exists public.advance_dispatch_job_status(uuid, text, text, text);

create function public.advance_dispatch_job_status(
  p_job_id uuid,
  p_expected_status text,
  p_next_status text,
  p_outcome_notes text default null
) returns table (id uuid, status text, shift_id uuid, completed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.dispatch_jobs%rowtype;
  v_allowed boolean := false;
begin
  select * into v_job
  from public.dispatch_jobs
  where dispatch_jobs.id = p_job_id
  for update;

  if not found then raise exception 'Dispatch job not found'; end if;

  if not public.is_admin_for_org(v_job.organization_id) and not exists (
    select 1 from public.dispatch_resources dr
    where dr.id = v_job.dispatch_resource_id
      and dr.assigned_officer_id = auth.uid()
  ) then
    raise exception 'Not authorised to update this dispatch job';
  end if;

  if v_job.status <> p_expected_status then
    raise exception 'Dispatch job changed from expected status % to %', p_expected_status, v_job.status;
  end if;

  v_allowed := case v_job.status
    when 'pending' then p_next_status in ('dispatched', 'cancelled')
    when 'dispatched' then p_next_status in ('acknowledged', 'en_route', 'cancelled')
    when 'acknowledged' then p_next_status in ('en_route', 'cancelled')
    when 'en_route' then p_next_status in ('on_scene', 'cancelled')
    when 'on_scene' then p_next_status in ('completed', 'cancelled')
    else false
  end;

  if not v_allowed then
    raise exception 'Invalid dispatch transition from % to %', v_job.status, p_next_status;
  end if;

  if p_next_status in ('completed', 'cancelled') and nullif(trim(p_outcome_notes), '') is null then
    raise exception 'Outcome notes are required for terminal dispatch transitions';
  end if;

  update public.dispatch_jobs
  set status = p_next_status,
      acknowledged_at = case when p_next_status = 'acknowledged' then now() else acknowledged_at end,
      en_route_at = case when p_next_status = 'en_route' then now() else en_route_at end,
      on_scene_at = case when p_next_status = 'on_scene' then now() else on_scene_at end,
      completed_at = case when p_next_status = 'completed' then now() else completed_at end,
      outcome_notes = case when p_next_status in ('completed', 'cancelled') then nullif(trim(p_outcome_notes), '') else outcome_notes end
  where dispatch_jobs.id = p_job_id;

  if p_next_status in ('completed', 'cancelled') and v_job.dispatch_resource_id is not null and not exists (
    select 1 from public.dispatch_jobs other
    where other.dispatch_resource_id = v_job.dispatch_resource_id
      and other.id <> p_job_id
      and other.status in ('dispatched', 'acknowledged', 'en_route', 'on_scene')
  ) then
    update public.dispatch_resources
    set status = 'available'
    where dispatch_resources.id = v_job.dispatch_resource_id;
  end if;

  return query
  select updated.id, updated.status, updated.shift_id, updated.completed_at
  from public.dispatch_jobs updated
  where updated.id = p_job_id;
end;
$$;

revoke all on function public.advance_dispatch_job_status(uuid, text, text, text) from public, anon;
grant execute on function public.advance_dispatch_job_status(uuid, text, text, text) to authenticated, service_role;
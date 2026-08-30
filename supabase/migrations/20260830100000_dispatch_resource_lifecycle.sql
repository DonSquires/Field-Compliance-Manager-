drop function if exists public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, text, uuid);

create or replace function public.create_dispatch_job(
  p_organization_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_client_request_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_dispatch_resource_id uuid default null,
  p_briefing_notes text default null,
  p_shift_id uuid default null
) returns table (id uuid, created boolean, status text, sla_respond_by timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.dispatch_jobs%rowtype;
  v_created public.dispatch_jobs%rowtype;
  v_resource public.dispatch_resources%rowtype;
  v_shift public.shifts%rowtype;
begin
  if not public.is_admin_for_org(p_organization_id) then
    raise exception 'Not authorised to create dispatch jobs for this organisation';
  end if;

  if p_sla_minutes is null or p_sla_minutes < 1 or p_sla_minutes > 1440 then
    raise exception 'SLA minutes must be between 1 and 1440';
  end if;

  if not exists (
    select 1
    from public.service_agreements sa
    join public.service_agreement_locations sal on sal.service_agreement_id = sa.id
    join public.client_sites cs on cs.id = sal.site_id
    where sa.id = p_service_agreement_id
      and sa.provider_organization_id = p_organization_id
      and sal.site_id = p_client_site_id
      and sal.status = 'active'
      and cs.active = true
  ) then
    raise exception 'Site is not active under this service agreement';
  end if;

  select * into v_existing
  from public.dispatch_jobs
  where organization_id = p_organization_id
    and client_request_id = p_client_request_id;

  if found then
    return query select v_existing.id, false, v_existing.status, v_existing.sla_respond_by;
    return;
  end if;

  if p_dispatch_resource_id is not null then
    if p_shift_id is null then
      raise exception 'A shift is required when dispatching to a resource';
    end if;

    select * into v_resource
    from public.dispatch_resources
    where id = p_dispatch_resource_id
      and organization_id = p_organization_id
    for update;

    if not found or v_resource.status <> 'available' or v_resource.assigned_officer_id is null then
      raise exception 'Dispatch resource is not available with an assigned officer';
    end if;

    select * into v_shift
    from public.shifts
    where id = p_shift_id
      and organization_id = p_organization_id
      and status in ('accepted', 'in_progress')
    for share;

    if not found or v_shift.officer_user_id <> v_resource.assigned_officer_id then
      raise exception 'Shift officer does not match the selected dispatch resource';
    end if;
  elsif p_shift_id is not null then
    if not exists (
      select 1 from public.shifts
      where id = p_shift_id
        and organization_id = p_organization_id
        and status in ('accepted', 'in_progress')
    ) then
      raise exception 'Shift is not active in this organisation';
    end if;
  end if;

  begin
    insert into public.dispatch_jobs (
      organization_id, service_agreement_id, client_site_id, client_request_id,
      dispatch_resource_id, job_type, priority, status, sla_minutes,
      sla_respond_by, briefing_notes, shift_id, dispatched_at
    ) values (
      p_organization_id, p_service_agreement_id, p_client_site_id, p_client_request_id,
      p_dispatch_resource_id, p_job_type, p_priority,
      case when p_dispatch_resource_id is null then 'pending' else 'dispatched' end,
      p_sla_minutes, now() + make_interval(mins => p_sla_minutes),
      nullif(trim(p_briefing_notes), ''), p_shift_id,
      case when p_dispatch_resource_id is null then null else now() end
    ) returning * into v_created;

    if p_dispatch_resource_id is not null then
      update public.dispatch_resources
      set status = 'busy'
      where id = p_dispatch_resource_id;
    end if;
  exception when unique_violation then
    select * into v_created
    from public.dispatch_jobs
    where organization_id = p_organization_id
      and client_request_id = p_client_request_id;
    return query select v_created.id, false, v_created.status, v_created.sla_respond_by;
    return;
  end;

  return query select v_created.id, true, v_created.status, v_created.sla_respond_by;
end;
$$;

create or replace function public.advance_dispatch_job_status(
  p_job_id uuid,
  p_expected_status text,
  p_next_status text,
  p_outcome_notes text default null
) returns table (id uuid, status text)
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

  return query select p_job_id, p_next_status;
end;
$$;

revoke all on function public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) from public;
grant execute on function public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) to authenticated, service_role;

revoke all on function public.advance_dispatch_job_status(uuid, text, text, text) from public;
grant execute on function public.advance_dispatch_job_status(uuid, text, text, text) to authenticated, service_role;
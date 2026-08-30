alter table public.dispatch_jobs
  add column if not exists client_request_id uuid;

create unique index if not exists idx_dispatch_jobs_client_request
  on public.dispatch_jobs (organization_id, client_request_id)
  where client_request_id is not null;

create or replace function public.create_dispatch_job(
  p_organization_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_client_request_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_briefing_notes text default null,
  p_shift_id uuid default null
) returns table (id uuid, created boolean, sla_respond_by timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.dispatch_jobs%rowtype;
  v_created public.dispatch_jobs%rowtype;
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
    return query select v_existing.id, false, v_existing.sla_respond_by;
    return;
  end if;

  begin
    insert into public.dispatch_jobs (
      organization_id, service_agreement_id, client_site_id, client_request_id,
      job_type, priority, status, sla_minutes, sla_respond_by, briefing_notes,
      shift_id
    ) values (
      p_organization_id, p_service_agreement_id, p_client_site_id, p_client_request_id,
      p_job_type, p_priority, 'pending', p_sla_minutes,
      now() + make_interval(mins => p_sla_minutes), nullif(trim(p_briefing_notes), ''),
      p_shift_id
    ) returning * into v_created;
  exception when unique_violation then
    select * into v_created
    from public.dispatch_jobs
    where organization_id = p_organization_id
      and client_request_id = p_client_request_id;
    return query select v_created.id, false, v_created.sla_respond_by;
    return;
  end;

  return query select v_created.id, true, v_created.sla_respond_by;
end;
$$;

revoke all on function public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, text, uuid) from public;
grant execute on function public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, text, uuid) to authenticated, service_role;
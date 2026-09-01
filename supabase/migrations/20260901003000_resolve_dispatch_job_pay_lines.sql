-- Wires the dispatch completion pipeline to actually resolve pay lines.
-- rate_rules, dispatch_job_pay_lines, and compute_point_distance_km already
-- existed in schema (see their table/function comments), but nothing ever
-- called them: advance_dispatch_job_status() only flipped status/timestamps.
-- A completed dispatch job produced zero automatic pay consequence.
--
-- Scope: pay resolution only (rule_kind='pay'). Billing on-charge lines
-- (quote_lines.source_dispatch_id) are a separate, still-open gap deferred
-- to a follow-up, since attaching a line requires choosing WHICH open quote
-- to target and that convention does not exist yet.
--
-- rate_type coverage: hourly/per_hour_allowance (dispatched_at->completed_at
-- duration), per_hour_travel (en_route_at->on_scene_at duration), the flat
-- family (quantity=1), and per_km (distance between the officer's last known
-- GPS position before dispatch and the client site, via
-- compute_point_distance_km). 'percentage' and 'per_unit' have no defined
-- base/unit count for a dispatch job and are deliberately left unresolved
-- rather than guessed — matched rules of those types are skipped, not
-- inserted.
create or replace function public.resolve_dispatch_job_pay_lines(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.dispatch_jobs%rowtype;
  v_resource public.dispatch_resources%rowtype;
  v_rule public.rate_rules%rowtype;
  v_officer_lat double precision;
  v_officer_lng double precision;
  v_site_lat double precision;
  v_site_lng double precision;
  v_distance_km numeric;
  v_quantity numeric;
  v_line_total numeric;
begin
  select * into v_job from public.dispatch_jobs where id = p_job_id;
  if not found or v_job.status <> 'completed' or v_job.dispatch_resource_id is null then
    return;
  end if;

  select * into v_resource from public.dispatch_resources where id = v_job.dispatch_resource_id;
  if not found or v_resource.assigned_officer_id is null then
    return;
  end if;

  for v_rule in
    select * from public.rate_rules r
    where r.organization_id = v_job.organization_id
      and r.rule_kind = 'pay'
      and r.active
      and (r.service_type is null or r.service_type = v_resource.service_type)
      and (r.job_type is null or r.job_type = v_job.job_type)
      and (r.site_id is null or r.site_id = v_job.client_site_id)
      and (r.effective_from is null or r.effective_from <= coalesce(v_job.completed_at, now())::date)
      and (r.effective_to is null or r.effective_to >= coalesce(v_job.completed_at, now())::date)
    order by r.priority desc, r.created_at desc
  loop
    v_quantity := null;
    v_distance_km := null;

    case v_rule.rate_type
      when 'hourly', 'per_hour_allowance' then
        if v_job.dispatched_at is not null then
          v_quantity := round((extract(epoch from (v_job.completed_at - v_job.dispatched_at)) / 3600.0)::numeric, 4);
        end if;
      when 'per_hour_travel' then
        if v_job.en_route_at is not null and v_job.on_scene_at is not null then
          v_quantity := round((extract(epoch from (v_job.on_scene_at - v_job.en_route_at)) / 3600.0)::numeric, 4);
        end if;
      when 'flat', 'daily', 'oncall_flat', 'callout', 'higher_duties_flat', 'per_visit', 'per_notice' then
        v_quantity := 1;
      when 'per_km' then
        select og.gps_lat, og.gps_lng into v_officer_lat, v_officer_lng
        from public.officer_gps_log og
        where og.officer_id = v_resource.assigned_officer_id
          and og.created_at <= coalesce(v_job.dispatched_at, v_job.created_at)
        order by og.created_at desc
        limit 1;

        select cs.gps_lat, cs.gps_lng into v_site_lat, v_site_lng
        from public.client_sites cs
        where cs.id = v_job.client_site_id;

        if v_officer_lat is not null and v_officer_lng is not null and v_site_lat is not null and v_site_lng is not null then
          v_distance_km := public.compute_point_distance_km(v_officer_lat, v_officer_lng, v_site_lat, v_site_lng);
          v_quantity := v_distance_km;
        end if;
      else
        v_quantity := null;
    end case;

    if v_quantity is null then
      continue;
    end if;

    v_line_total := round((v_quantity * v_rule.amount)::numeric, 2);

    if v_rule.pay_code is not null then
      insert into public.dispatch_job_pay_lines (
        organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
        rate_type, description, quantity, unit_rate, line_total, distance_km,
        role_code, region_code, service_type, day_category
      ) values (
        v_job.organization_id, v_job.id, v_resource.assigned_officer_id, v_rule.id, v_rule.pay_code,
        v_rule.rate_type, v_rule.name, v_quantity, v_rule.amount, v_line_total, v_distance_km,
        v_rule.role_code, v_rule.region_code, v_rule.service_type, v_rule.day_category
      )
      on conflict (organization_id, source_dispatch_id, pay_code) where pay_code is not null
      do update set
        officer_user_id = excluded.officer_user_id,
        rate_rule_id = excluded.rate_rule_id,
        rate_type = excluded.rate_type,
        description = excluded.description,
        quantity = excluded.quantity,
        unit_rate = excluded.unit_rate,
        line_total = excluded.line_total,
        distance_km = excluded.distance_km,
        role_code = excluded.role_code,
        region_code = excluded.region_code,
        service_type = excluded.service_type,
        day_category = excluded.day_category;
    else
      insert into public.dispatch_job_pay_lines (
        organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
        rate_type, description, quantity, unit_rate, line_total, distance_km,
        role_code, region_code, service_type, day_category
      ) values (
        v_job.organization_id, v_job.id, v_resource.assigned_officer_id, v_rule.id, null,
        v_rule.rate_type, v_rule.name, v_quantity, v_rule.amount, v_line_total, v_distance_km,
        v_rule.role_code, v_rule.region_code, v_rule.service_type, v_rule.day_category
      )
      on conflict (organization_id, source_dispatch_id) where pay_code is null
      do update set
        officer_user_id = excluded.officer_user_id,
        rate_rule_id = excluded.rate_rule_id,
        rate_type = excluded.rate_type,
        description = excluded.description,
        quantity = excluded.quantity,
        unit_rate = excluded.unit_rate,
        line_total = excluded.line_total,
        distance_km = excluded.distance_km,
        role_code = excluded.role_code,
        region_code = excluded.region_code,
        service_type = excluded.service_type,
        day_category = excluded.day_category;
    end if;
  end loop;
end;
$$;

-- Internal only: called from advance_dispatch_job_status() (SECURITY DEFINER,
-- owned by postgres), which does not require callers to hold EXECUTE here.
revoke all on function public.resolve_dispatch_job_pay_lines(uuid) from public, anon, authenticated;
grant execute on function public.resolve_dispatch_job_pay_lines(uuid) to service_role;

comment on function public.resolve_dispatch_job_pay_lines(uuid) is 'Resolves and idempotently upserts dispatch_job_pay_lines for a completed dispatch job, matching the single highest-priority active rate_rules row (rule_kind=pay) per pay_code family. Called by advance_dispatch_job_status() on completion; safe to re-run.';

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

  if p_next_status = 'completed' then
    -- Fail-open: never block a completion on pay resolution. A resolution bug
    -- must not also make the officer unable to close out the job.
    begin
      perform public.resolve_dispatch_job_pay_lines(p_job_id);
    exception when others then
      raise warning 'resolve_dispatch_job_pay_lines failed for job %: %', p_job_id, sqlerrm;
    end;
  end if;

  return query
  select updated.id, updated.status, updated.shift_id, updated.completed_at
  from public.dispatch_jobs updated
  where updated.id = p_job_id;
end;
$$;

revoke all on function public.advance_dispatch_job_status(uuid, text, text, text) from public, anon;
grant execute on function public.advance_dispatch_job_status(uuid, text, text, text) to authenticated, service_role;

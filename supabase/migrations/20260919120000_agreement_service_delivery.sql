-- What the client can see was delivered at their places (owner walk finding 2026-09-19).
-- The client portal showed observations, report packs and invoices, but nothing about the guarding work itself:
-- whether the contracted patrol stops were visited and how long a guard was on the post. The monthly report pack's
-- "facilities" section counted every stop the provider organisation had, for every client, keyed only by site name —
-- not scoped to the agreement's places. Both are fixed here on one governed read.
--
-- agreement_service_delivery(agreement, from, to): internal assembler, no auth (used by the report pack builder).
-- get_agreement_service_delivery(agreement, from, to): the client/provider-facing read with the authorisation check.
-- No officer identities are exposed: the client sees presence at the place, not the people.

create or replace function public.agreement_service_delivery(p_agreement_id uuid, p_period_start date, p_period_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_agreement public.service_agreements%rowtype;
  v_start timestamptz := p_period_start::timestamptz;
  v_end timestamptz := (p_period_end + 1)::timestamptz;
  v_providers uuid[];
  v_places jsonb;
  v_totals jsonb;
begin
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  -- Shifts belong to the branch that rostered them; the agreement may name the employer or the branch as provider.
  v_providers := public.get_descendant_organizations(v_agreement.provider_organization_id);

  with places as (
    select sal.id as location_id, sal.site_id, sal.zone_id,
      coalesce(s.name, z.name) as place_name,
      case when s.id is not null then 'site' else 'zone' end as place_kind
    from public.service_agreement_locations sal
    left join public.client_sites s on s.id = sal.site_id
    left join public.location_zones z on z.id = sal.zone_id
    where sal.service_agreement_id = v_agreement.id and sal.status = 'active'
  ), stops as (
    select ss.*, sh.scheduled_start, sh.actual_start, sh.actual_end, sh.status as shift_status,
      p.location_id
    from public.shift_stops ss
    join public.shifts sh on sh.id = ss.shift_id
    join places p on (p.site_id is not null and p.site_id = ss.site_id) or (p.zone_id is not null and p.zone_id = ss.zone_id)
    where sh.organization_id = any(v_providers)
      and sh.status <> 'cancelled'
      and sh.scheduled_start >= v_start
      and sh.scheduled_start < least(v_end, now())
  ), per_place as (
    select p.location_id, p.place_name, p.place_kind,
      count(st.id) filter (where st.module_key is distinct from 'static_guarding') as patrol_expected,
      count(st.id) filter (where st.module_key is distinct from 'static_guarding' and st.status = 'completed') as patrol_completed,
      count(st.id) filter (where st.module_key is distinct from 'static_guarding' and st.status in ('skipped', 'cancelled')) as patrol_missed,
      count(st.id) filter (where st.module_key is distinct from 'static_guarding' and st.status = 'completed' and st.sla_status = 'breached') as patrol_late,
      count(st.id) filter (where st.module_key = 'static_guarding') as post_expected,
      count(st.id) filter (where st.module_key = 'static_guarding' and st.actual_arrived_at is not null) as post_attended,
      coalesce(sum(case when st.module_key = 'static_guarding' and st.actual_arrived_at is not null
        then greatest(0, extract(epoch from (coalesce(st.actual_departed_at, st.actual_end, now()) - st.actual_arrived_at)) / 60) end), 0)::integer as post_minutes,
      max(coalesce(st.actual_departed_at, st.actual_arrived_at)) as last_presence_at,
      count(distinct st.shift_id) as shift_count
    from places p
    left join stops st on st.location_id = p.location_id
    group by p.location_id, p.place_name, p.place_kind
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'location_id', location_id, 'place_name', place_name, 'place_kind', place_kind,
      'patrol_expected', patrol_expected, 'patrol_completed', patrol_completed, 'patrol_missed', patrol_missed, 'patrol_late', patrol_late,
      'post_expected', post_expected, 'post_attended', post_attended, 'post_minutes', post_minutes,
      'last_presence_at', last_presence_at, 'shift_count', shift_count
    ) order by place_name), '[]'::jsonb),
    jsonb_build_object(
      'patrol_expected', coalesce(sum(patrol_expected), 0), 'patrol_completed', coalesce(sum(patrol_completed), 0),
      'patrol_missed', coalesce(sum(patrol_missed), 0), 'patrol_late', coalesce(sum(patrol_late), 0),
      'post_expected', coalesce(sum(post_expected), 0), 'post_attended', coalesce(sum(post_attended), 0),
      'post_minutes', coalesce(sum(post_minutes), 0), 'place_count', count(*)
    )
  into v_places, v_totals
  from per_place;

  return jsonb_build_object(
    'agreement_id', v_agreement.id,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'places', v_places,
    'totals', v_totals
  );
end;
$$;

revoke all on function public.agreement_service_delivery(uuid, date, date) from public, anon, authenticated, service_role;
comment on function public.agreement_service_delivery(uuid, date, date) is
  'Internal assembler: per agreement place, contracted patrol stops expected/completed/missed/late and static-post attendances and minutes on post in the period, from shift_stops of the provider (and its branches). No authorisation check; call get_agreement_service_delivery from clients.';

create or replace function public.get_agreement_service_delivery(p_agreement_id uuid, p_period_start date, p_period_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_profile public.user_profiles%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 92 then
    raise exception 'Choose a period of up to 92 days';
  end if;
  select * into v_agreement from public.service_agreements a where a.id = p_agreement_id;
  if not found then raise exception 'Service agreement not found'; end if;
  select * into v_profile from public.user_profiles p where p.id = v_actor and p.deactivated_at is null;
  if not found then raise exception 'Active profile required'; end if;

  -- The client sees delivery for its own agreement when the portal is switched on; provider administrators and branch managers always can.
  if not (
    public.is_admin_for_org(v_agreement.provider_organization_id)
    or exists (
      select 1 from public.staff_branch_authorisations a
      where a.user_id = v_actor and a.status = 'active' and a.branch_org_id = v_agreement.provider_organization_id
        and a.role_at_branch in ('branch_manager', 'admin', 'master')
    )
    or (v_profile.organization_id = v_agreement.client_organization_id
        and v_profile.role in ('client_admin', 'client_officer', 'client_viewer', 'master', 'admin')
        and v_agreement.client_portal_access_mode in ('transparency_only', 'full_modules'))
  ) then
    raise exception 'Not authorised to view delivery for this agreement';
  end if;

  return public.agreement_service_delivery(p_agreement_id, p_period_start, p_period_end);
end;
$$;

revoke all on function public.get_agreement_service_delivery(uuid, date, date) from public, anon, authenticated, service_role;
grant execute on function public.get_agreement_service_delivery(uuid, date, date) to postgres, authenticated, service_role;
comment on function public.get_agreement_service_delivery(uuid, date, date) is
  'Client portal / provider read: what was delivered at the agreement''s places in a period (up to 92 days, shifts due so far) — patrol stops visited, static post attendances and hours on post, last presence. Client users of the agreement (portal transparency_only or full_modules) and provider administrators and branch managers only. No officer identities.';

-- Report pack: facilities scoped to the agreement's places (was: every stop of the provider, every client), plus the delivery block.
create or replace function public.generate_due_report_packs(p_period_start date, p_period_end date)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_agreement record;
  v_count integer := 0;
  v_data jsonb;
  v_start_ts timestamptz := p_period_start::timestamptz;
  v_end_ts timestamptz := (p_period_end::timestamptz + interval '1 day');
  v_sla_met integer;
  v_sla_breached integer;
  v_sla_running integer;
  v_inc_total integer;
  v_inc_by_sev jsonb;
  v_checkpoints integer;
  v_breaches integer;
  v_delivery jsonb;
  v_facilities jsonb;
begin
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end or p_period_end - p_period_start > 366 then
    raise exception 'Select a valid report period of 366 days or less';
  end if;

  select organization_id into v_provider
  from public.user_profiles
  where id = v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active provider administrator required';
  end if;

  for v_agreement in
    select id, provider_organization_id, monthly_report_template_code
    from public.service_agreements
    -- agreements held by the administrator's organisation or any of its branches (shifts and agreements live at branch level)
    where provider_organization_id = any(public.get_descendant_organizations(v_provider))
      and monthly_report_template_code is not null
  loop
    select count(*) filter (where status = 'met'), count(*) filter (where status = 'breached'), count(*) filter (where status = 'running')
    into v_sla_met, v_sla_breached, v_sla_running
    from public.sla_clocks
    where service_agreement_id = v_agreement.id
      and started_at >= v_start_ts and started_at < v_end_ts;

    select count(*), coalesce(jsonb_object_agg(severity, n), '{}'::jsonb)
    into v_inc_total, v_inc_by_sev
    from (
      select severity, count(*) as n
      from public.incidents
      where organization_id = v_agreement.provider_organization_id
        and occurred_at >= v_start_ts and occurred_at < v_end_ts
      group by severity
    ) s;

    select count(*) into v_checkpoints
    from public.patrol_checkpoint_visits
    where organization_id = v_agreement.provider_organization_id
      and visited_at >= v_start_ts and visited_at < v_end_ts;

    select count(*) into v_breaches
    from public.breach_alerts
    where organization_id = v_agreement.provider_organization_id
      and created_at >= v_start_ts and created_at < v_end_ts;

    v_delivery := public.agreement_service_delivery(v_agreement.id, p_period_start, p_period_end);
    -- Same shape the PDF renderer already reads, now only this agreement's places.
    select coalesce(jsonb_agg(jsonb_build_object('siteName', place->>'place_name', 'expected', (place->>'patrol_expected')::integer + (place->>'post_expected')::integer, 'completed', (place->>'patrol_completed')::integer + (place->>'post_attended')::integer) order by place->>'place_name'), '[]'::jsonb)
    into v_facilities
    from jsonb_array_elements(v_delivery->'places') as place;

    v_data := jsonb_build_object(
      'slaMet', coalesce(v_sla_met, 0),
      'slaBreached', coalesce(v_sla_breached, 0),
      'slaRunning', coalesce(v_sla_running, 0),
      'incidentsTotal', coalesce(v_inc_total, 0),
      'incidentsBySeverity', coalesce(v_inc_by_sev, '{}'::jsonb),
      'checkpointVisits', coalesce(v_checkpoints, 0),
      'breachAlerts', coalesce(v_breaches, 0),
      'facilities', v_facilities,
      'delivery', v_delivery
    );

    insert into public.monthly_report_packs (
      organization_id, service_agreement_id, template_code, period_start,
      period_end, status, data, generated_at, generated_by, updated_at
    ) values (
      v_agreement.provider_organization_id, v_agreement.id,
      v_agreement.monthly_report_template_code, p_period_start, p_period_end,
      'generated', v_data, now(), v_actor, now()
    )
    on conflict (service_agreement_id, template_code, period_start)
    do update set
      data = excluded.data,
      status = case when monthly_report_packs.status = 'sent' then 'sent' else 'generated' end,
      generated_at = now(), generated_by = v_actor, updated_at = now();

    v_count := v_count + 1;
  end loop;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, metadata)
  values (v_provider, v_actor, 'monthly_report_packs_generated', 'monthly_report_packs', jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'pack_count', v_count));
  return v_count;
end;
$$;

comment on function public.generate_due_report_packs(date, date) is
  'Assembles + upserts monthly_report_packs for every agreement (held by the administrator''s organisation or its branches) with a template code over the given period. facilities and delivery are scoped to the agreement''s places via agreement_service_delivery. Does not re-downgrade an already-sent pack.';

-- Client transparency: the agreement's delivery block now also says how the provider responded to the alarms and
-- incidents raised under it (count, attended, inside/over the response target, median and slowest minutes to scene,
-- by job type). Officer identities stay out of it. Feeds get_agreement_service_delivery (client portal, CRM panel)
-- and the monthly report pack through the same assembler.

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
  v_responses jsonb;
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


  -- Responses: dispatch jobs raised under this agreement (alarm responses, incidents, welfare checks...). The clock
  -- runs from the alarm when one is recorded (record_alarm_signal), otherwise from when the job was raised.
  with jobs as (
    select j.id, j.job_type, j.status, j.sla_minutes, j.on_scene_at,
      coalesce(e.received_at, j.created_at) as raised_at
    from public.dispatch_jobs j
    left join public.alarm_events e on e.dispatch_job_id = j.id
    where j.service_agreement_id = v_agreement.id
      and j.organization_id = any(v_providers)
      and j.status <> 'cancelled'
      and coalesce(e.received_at, j.created_at) >= v_start
      and coalesce(e.received_at, j.created_at) < v_end
  ), typed as (
    select job_type, count(*) as n from jobs group by job_type
  )
  select jsonb_build_object(
    'count', (select count(*) from jobs),
    'attended', (select count(*) from jobs where on_scene_at is not null),
    'within_target', (select count(*) from jobs where on_scene_at is not null and sla_minutes is not null and on_scene_at <= raised_at + make_interval(mins => sla_minutes)),
    'over_target', (select count(*) from jobs where on_scene_at is not null and sla_minutes is not null and on_scene_at > raised_at + make_interval(mins => sla_minutes)),
    'still_open', (select count(*) from jobs where on_scene_at is null and status <> 'completed'),
    'median_minutes_to_scene', (select round(percentile_cont(0.5) within group (order by extract(epoch from (on_scene_at - raised_at)) / 60.0)::numeric, 1) from jobs where on_scene_at is not null),
    'slowest_minutes_to_scene', (select round((max(extract(epoch from (on_scene_at - raised_at))) / 60.0)::numeric, 1) from jobs where on_scene_at is not null),
    'by_type', (select coalesce(jsonb_object_agg(job_type, n), '{}'::jsonb) from typed)
  ) into v_responses;

  return jsonb_build_object(
    'agreement_id', v_agreement.id,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'places', v_places,
    'totals', v_totals,
    'responses', v_responses
  );
end;
$$;


comment on function public.agreement_service_delivery(uuid, date, date) is
  'Internal assembler: per agreement place, contracted patrol stops expected/completed/missed/late and static-post attendances and minutes on post in the period; plus responses (dispatch jobs under the agreement: attended, within/over target from the alarm or the job, median minutes to scene). No officer identities. Auth is on get_agreement_service_delivery.';

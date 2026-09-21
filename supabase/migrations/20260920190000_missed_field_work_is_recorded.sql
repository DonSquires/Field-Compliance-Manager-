-- Missed field work is recorded, said, and handed to a person — it no longer stays "accepted / on_track" forever.
--
-- Before (observed live 2026-09-21 14:23 NZST): the Monday 07:00–11:00 Multi Module shift was never started.
-- Three hours after its end it still read status 'accepted', both contracted visits 'pending' / 'on_track',
-- nobody had been told, and the client's delivery block counted the visits as expected but neither done nor
-- missed. get_roster_attendance_exceptions listed it as a 'late_start' only while someone happened to be
-- looking at the roster page; a stop's sla_status became 'breached' only if the officer eventually arrived.
--
-- After, a five-minute sweep (pg_cron, in-database, no worker):
--  * DURING the window — a shift not started 15 min after its start: the branch's administrators are told once
--    ('Shift not started') and so is the officer; a contracted visit whose arrive-by time has passed without
--    arrival is marked sla_status 'breached' (it can still be visited; a late arrival keeps 'breached'), and the
--    administrators are told once per shift ('Contracted visits running late').
--  * AFTER the window — a shift that ended without ever starting becomes status 'missed', ended_reason
--    'not_started'; its unvisited stops become status 'missed' / sla 'breached'; an audit row is written; the
--    administrators are told once ('Shift missed — nobody attended'), critical.
--  * An in-progress shift more than 60 min past its end: administrators told once ('Shift still running').
-- Readers: get_roster_attendance_exceptions now also lists missed shifts (exception_type 'missed'), which can be
-- acknowledged like the others; agreement_service_delivery counts 'missed' stops as missed for the client.
-- Doctrine: accountability — the harmed party (the client, the place) must see what did not happen.

ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_status_check;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_status_check
  CHECK (status = ANY (ARRAY['scheduled','published','accepted','declined','in_progress','completed','cancelled','missed']));
ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_ended_reason_check;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_ended_reason_check
  CHECK (ended_reason IS NULL OR ended_reason = ANY (ARRAY['officer','superseded_by_next_shift','not_started']));
ALTER TABLE public.shift_stops DROP CONSTRAINT IF EXISTS shift_stops_status_check;
ALTER TABLE public.shift_stops ADD CONSTRAINT shift_stops_status_check
  CHECK (status = ANY (ARRAY['pending','en_route','on_scene','completed','skipped','cancelled','missed']));

CREATE OR REPLACE FUNCTION public.sweep_missed_field_work(p_now timestamptz DEFAULT clock_timestamp(), p_grace_minutes integer DEFAULT 15)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_officer text;
  v_work text;
  v_window text;
  v_late_starts integer := 0;
  v_late_visits integer := 0;
  v_missed integer := 0;
  v_overruns integer := 0;
  v_stops integer;
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin') AND coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  -- DURING: not started after the grace period, window still open.
  FOR r IN
    SELECT s.*
    FROM public.shifts s
    WHERE s.status IN ('scheduled', 'published', 'accepted')
      AND s.actual_start IS NULL
      AND s.scheduled_start + make_interval(mins => p_grace_minutes) < p_now
      AND s.scheduled_end > p_now
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.organization_id = s.organization_id AND n.dedup_key = 'shift_late_start:' || s.id::text)
  LOOP
    SELECT coalesce(up.display_name, up.email, 'The officer') INTO v_officer FROM public.user_profiles up WHERE up.id = r.officer_user_id;
    SELECT coalesce(u.name, pr.name, replace(r.service_type, '_', ' ')) INTO v_work
    FROM public.shifts s LEFT JOIN public.roster_slots rs ON rs.id = s.roster_slot_id LEFT JOIN public.roster_work_units u ON u.id = rs.work_unit_id
    LEFT JOIN public.patrol_routes pr ON pr.id = s.patrol_route_id WHERE s.id = r.id;
    v_window := to_char(r.scheduled_start AT TIME ZONE 'Pacific/Auckland', 'HH24:MI') || '–' || to_char(r.scheduled_end AT TIME ZONE 'Pacific/Auckland', 'HH24:MI');
    PERFORM public.enqueue_notification(
      p_organization_id => r.organization_id, p_category => 'roster', p_severity => 'warning',
      p_title => 'Shift not started', p_body => v_officer || ' has not started ' || v_work || ' (' || v_window || '). ' || greatest(0, floor(extract(epoch FROM (p_now - r.scheduled_start)) / 60))::integer || ' min after the start time.',
      p_recipient_user_id => NULL, p_recipient_role => 'admin', p_link_page => 'roster', p_link_payload => jsonb_build_object('shift_id', r.id, 'roster_slot_id', r.roster_slot_id),
      p_dedup_key => 'shift_late_start:' || r.id::text);
    IF r.officer_user_id IS NOT NULL THEN
      PERFORM public.enqueue_notification(
        p_organization_id => r.organization_id, p_category => 'roster', p_severity => 'warning',
        p_title => 'Your shift has started', p_body => v_work || ' started at ' || to_char(r.scheduled_start AT TIME ZONE 'Pacific/Auckland', 'HH24:MI') || '. Start it on your schedule, or tell your supervisor if you cannot attend.',
        p_recipient_user_id => r.officer_user_id, p_recipient_role => NULL, p_link_page => 'schedule', p_link_payload => jsonb_build_object('shift_id', r.id, 'roster_slot_id', r.roster_slot_id),
        p_dedup_key => 'shift_late_start_officer:' || r.id::text);
    END IF;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (r.organization_id, NULL, 'shift_late_start', 'shifts', r.id, jsonb_build_object('officer_user_id', r.officer_user_id, 'scheduled_start', r.scheduled_start, 'grace_minutes', p_grace_minutes, 'detected_at', p_now));
    v_late_starts := v_late_starts + 1;
  END LOOP;

  -- DURING: a contracted visit whose arrive-by time passed with nobody there.
  WITH late AS (
    UPDATE public.shift_stops st
    SET sla_status = 'breached', updated_at = p_now
    FROM public.shifts s
    WHERE s.id = st.shift_id
      AND st.is_adhoc = false
      AND st.status IN ('pending', 'en_route')
      AND st.sla_status <> 'breached'
      AND st.sla_arrive_by IS NOT NULL AND st.sla_arrive_by < p_now
      AND s.status IN ('scheduled', 'published', 'accepted', 'in_progress')
    RETURNING st.shift_id, s.organization_id
  ), per_shift AS (
    SELECT shift_id, organization_id, count(*) AS n FROM late GROUP BY shift_id, organization_id
  )
  SELECT coalesce(sum(n), 0)::integer INTO v_late_visits FROM per_shift;
  FOR r IN
    SELECT s.*, (SELECT count(*) FROM public.shift_stops st WHERE st.shift_id = s.id AND st.is_adhoc = false AND st.status IN ('pending', 'en_route') AND st.sla_status = 'breached') AS late_count
    FROM public.shifts s
    WHERE s.status IN ('scheduled', 'published', 'accepted', 'in_progress')
      AND s.scheduled_end > p_now
      AND EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = s.id AND st.is_adhoc = false AND st.status IN ('pending', 'en_route') AND st.sla_status = 'breached')
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.organization_id = s.organization_id AND n.dedup_key = 'shift_visits_late:' || s.id::text)
  LOOP
    SELECT coalesce(up.display_name, up.email, 'The officer') INTO v_officer FROM public.user_profiles up WHERE up.id = r.officer_user_id;
    SELECT coalesce(u.name, pr.name, replace(r.service_type, '_', ' ')) INTO v_work
    FROM public.shifts s LEFT JOIN public.roster_slots rs ON rs.id = s.roster_slot_id LEFT JOIN public.roster_work_units u ON u.id = rs.work_unit_id
    LEFT JOIN public.patrol_routes pr ON pr.id = s.patrol_route_id WHERE s.id = r.id;
    PERFORM public.enqueue_notification(
      p_organization_id => r.organization_id, p_category => 'sla_breach', p_severity => 'warning',
      p_title => 'Contracted visits running late', p_body => r.late_count || ' contracted ' || CASE WHEN r.late_count = 1 THEN 'visit has' ELSE 'visits have' END || ' passed their arrive-by time on ' || v_work || ' (' || v_officer || ').',
      p_recipient_user_id => NULL, p_recipient_role => 'admin', p_link_page => 'live-map', p_link_payload => jsonb_build_object('shift_id', r.id, 'officer_user_id', r.officer_user_id),
      p_dedup_key => 'shift_visits_late:' || r.id::text);
  END LOOP;

  -- AFTER: the window closed and nobody ever started. Recorded for every such shift; people are paged only when
  -- the window closed in the last 24 h (older ones are history the first sweep is catching up on).
  FOR r IN
    SELECT s.* FROM public.shifts s
    WHERE s.status IN ('scheduled', 'published', 'accepted')
      AND s.actual_start IS NULL
      AND s.scheduled_end <= p_now
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Old catch-up rows are recorded, not announced (the officer notice trigger honours this flag).
    PERFORM set_config('fcm.silent_shift_notice', CASE WHEN r.scheduled_end > p_now - interval '24 hours' THEN 'off' ELSE 'on' END, true);
    UPDATE public.shifts SET status = 'missed', ended_reason = 'not_started', updated_at = p_now WHERE id = r.id;
    PERFORM set_config('fcm.silent_shift_notice', 'off', true);
    UPDATE public.shift_stops SET status = 'missed', sla_status = 'breached', updated_at = p_now
    WHERE shift_id = r.id AND status IN ('pending', 'en_route');
    GET DIAGNOSTICS v_stops = ROW_COUNT;
    SELECT coalesce(up.display_name, up.email, 'The officer') INTO v_officer FROM public.user_profiles up WHERE up.id = r.officer_user_id;
    SELECT coalesce(u.name, pr.name, replace(r.service_type, '_', ' ')) INTO v_work
    FROM public.shifts s LEFT JOIN public.roster_slots rs ON rs.id = s.roster_slot_id LEFT JOIN public.roster_work_units u ON u.id = rs.work_unit_id
    LEFT JOIN public.patrol_routes pr ON pr.id = s.patrol_route_id WHERE s.id = r.id;
    v_window := to_char(r.scheduled_start AT TIME ZONE 'Pacific/Auckland', 'Dy DD Mon HH24:MI') || '–' || to_char(r.scheduled_end AT TIME ZONE 'Pacific/Auckland', 'HH24:MI');
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (r.organization_id, NULL, 'shift_missed', 'shifts', r.id, jsonb_build_object('officer_user_id', r.officer_user_id, 'roster_slot_id', r.roster_slot_id, 'scheduled_start', r.scheduled_start, 'scheduled_end', r.scheduled_end, 'stops_missed', v_stops, 'previous_status', r.status, 'detected_at', p_now, 'notified', r.scheduled_end > p_now - interval '24 hours'));
    IF r.scheduled_end > p_now - interval '24 hours' THEN
      PERFORM public.enqueue_notification(
        p_organization_id => r.organization_id, p_category => 'roster', p_severity => 'critical',
        p_title => 'Shift missed — nobody attended', p_body => v_officer || ' never started ' || v_work || ' (' || v_window || ').' || CASE WHEN v_stops > 0 THEN ' ' || v_stops || ' contracted ' || CASE WHEN v_stops = 1 THEN 'visit was' ELSE 'visits were' END || ' not made.' ELSE '' END || ' Acknowledge it on the roster and tell the client what happens next.',
        p_recipient_user_id => NULL, p_recipient_role => 'admin', p_link_page => 'roster', p_link_payload => jsonb_build_object('shift_id', r.id, 'roster_slot_id', r.roster_slot_id),
        p_dedup_key => 'shift_missed:' || r.id::text);
    END IF;
    v_missed := v_missed + 1;
  END LOOP;

  -- Still running long after the end: said once, never auto-ended (the officer may be legitimately held).
  FOR r IN
    SELECT s.* FROM public.shifts s
    WHERE s.status = 'in_progress' AND s.scheduled_end + interval '60 minutes' < p_now
      AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.organization_id = s.organization_id AND n.dedup_key = 'shift_overrun:' || s.id::text)
  LOOP
    SELECT coalesce(up.display_name, up.email, 'The officer') INTO v_officer FROM public.user_profiles up WHERE up.id = r.officer_user_id;
    PERFORM public.enqueue_notification(
      p_organization_id => r.organization_id, p_category => 'roster', p_severity => 'warning',
      p_title => 'Shift still running', p_body => v_officer || ' is still on a shift that was due to end at ' || to_char(r.scheduled_end AT TIME ZONE 'Pacific/Auckland', 'HH24:MI') || '. Check they are safe and end or extend the shift.',
      p_recipient_user_id => NULL, p_recipient_role => 'admin', p_link_page => 'live-map', p_link_payload => jsonb_build_object('shift_id', r.id, 'officer_user_id', r.officer_user_id),
      p_dedup_key => 'shift_overrun:' || r.id::text);
    v_overruns := v_overruns + 1;
  END LOOP;

  RETURN jsonb_build_object('at', p_now, 'late_starts', v_late_starts, 'late_visits', v_late_visits, 'missed_shifts', v_missed, 'overruns', v_overruns);
END;
$function$;
COMMENT ON FUNCTION public.sweep_missed_field_work(timestamptz, integer) IS 'Every five minutes (pg_cron): tells the branch when a shift has not started after the grace period, marks contracted visits whose arrive-by time has passed as breached, turns a shift that ended without starting into status missed (stops missed, audit row, critical notification), and flags shifts running long past their end. Idempotent through notification dedup keys.';
REVOKE ALL ON FUNCTION public.sweep_missed_field_work(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_missed_field_work(timestamptz, integer) TO postgres, service_role;

-- The roster's exception queue lists missed shifts too, and they can be acknowledged like the others.
CREATE OR REPLACE FUNCTION public.get_roster_attendance_exceptions(p_organization_id uuid, p_grace_minutes integer DEFAULT 15, p_from timestamptz DEFAULT (now() - interval '24 hours'), p_to timestamptz DEFAULT (now() + interval '24 hours'))
 RETURNS TABLE(shift_id uuid, officer_user_id uuid, service_type text, scheduled_start timestamptz, scheduled_end timestamptz, status text, exception_type text, minutes_overdue integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Roster administrator required'; end if;
  if p_grace_minutes < 0 or p_grace_minutes > 240 then raise exception 'Grace period is outside the accepted range'; end if;
  return query
  select s.id, s.officer_user_id, s.service_type, s.scheduled_start, s.scheduled_end, s.status,
    case when s.status = 'missed' then 'missed'
         when s.status in ('scheduled', 'published', 'accepted') then 'late_start'
         else 'active_overrun' end,
    case when s.status = 'missed' then greatest(0, floor(extract(epoch from (s.scheduled_end - s.scheduled_start)) / 60)::integer)
         when s.status in ('scheduled', 'published', 'accepted') then greatest(0, floor(extract(epoch from (clock_timestamp() - (s.scheduled_start + make_interval(mins => p_grace_minutes)))) / 60)::integer)
         else greatest(0, floor(extract(epoch from (clock_timestamp() - s.scheduled_end)) / 60)::integer) end
  from public.shifts s
  where s.organization_id = p_organization_id
    and s.scheduled_start >= p_from and s.scheduled_start <= p_to
    and (
      (s.status in ('scheduled', 'published', 'accepted') and s.scheduled_start + make_interval(mins => p_grace_minutes) < clock_timestamp() and s.actual_start is null)
      or (s.status = 'in_progress' and s.scheduled_end < clock_timestamp())
      or (s.status = 'missed' and not exists (
        select 1 from public.audit_log a where a.target_table = 'shifts' and a.target_id = s.id
          and a.action = 'roster_attendance_exception_acknowledged' and a.metadata->>'exception_type' = 'missed'))
    )
  order by s.scheduled_start;
end;
$function$;

CREATE OR REPLACE FUNCTION public.acknowledge_roster_attendance_exception(p_shift_id uuid, p_exception_type text, p_notes text)
 RETURNS TABLE(shift_id uuid, acknowledged_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid := auth.uid(); v_shift public.shifts%rowtype; v_user uuid; v_at timestamptz := clock_timestamp(); v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if v_notes is null then raise exception 'Attendance exception notes are required'; end if;
  if p_exception_type not in ('late_start', 'active_overrun', 'missed') then raise exception 'Unsupported attendance exception type'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if not public.is_admin_for_org(v_shift.organization_id) then raise exception 'Roster administrator required'; end if;
  v_user := v_shift.officer_user_id;
  if v_user is null then
    select coalesce(sp.user_id, sp.id) into v_user from public.staff_profiles sp where sp.id = (select rs.staff_id from public.roster_slots rs where rs.linked_shift_id = v_shift.id limit 1);
  end if;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_shift.organization_id, v_actor, 'roster_attendance_exception_acknowledged', 'shifts', v_shift.id, jsonb_build_object('exception_type', p_exception_type, 'notes', v_notes, 'acknowledged_at', v_at));
  if v_user is not null then
    perform public.enqueue_notification(p_organization_id => v_shift.organization_id, p_category => 'roster',
      p_title => case when p_exception_type = 'missed' then 'Missed shift reviewed' else 'Attendance exception acknowledged' end,
      p_body => v_notes, p_severity => 'warning', p_recipient_user_id => v_user, p_recipient_role => null, p_link_page => 'schedule',
      p_link_payload => jsonb_build_object('shift_id', v_shift.id, 'exception_type', p_exception_type), p_dedup_key => 'attendance_ack:' || v_shift.id::text || ':' || p_exception_type || ':' || extract(epoch from v_at)::bigint::text);
  end if;
  return query select v_shift.id, v_at;
end;
$function$;

-- The client's delivery block counts a visit nobody made as missed.
CREATE OR REPLACE FUNCTION public.agreement_service_delivery(p_agreement_id uuid, p_period_start date, p_period_end date)
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
      count(st.id) filter (where st.module_key is distinct from 'static_guarding' and st.status in ('skipped', 'cancelled', 'missed')) as patrol_missed,
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

-- Schedule the sweep (idempotent).
DO $$
DECLARE v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'missed-field-work-sweep-every-5m' LIMIT 1;
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  PERFORM cron.schedule_in_database('missed-field-work-sweep-every-5m', '*/5 * * * *', 'select public.sweep_missed_field_work();', 'postgres', NULL, TRUE);
END $$;

-- The officer's own notice says what happened in plain words instead of 'Shift missed — your field shift has changed'.
CREATE OR REPLACE FUNCTION public.tg_notify_shift_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user_id uuid; v_kind text; v_title text; v_body text;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if coalesce(current_setting('fcm.silent_shift_notice', true), 'off') = 'on' then return new; end if;
  if new.officer_user_id is not distinct from old.officer_user_id and new.scheduled_start is not distinct from old.scheduled_start and new.scheduled_end is not distinct from old.scheduled_end and new.status is not distinct from old.status then return new; end if;
  v_user_id := new.officer_user_id;
  if v_user_id is null then return new; end if;
  v_kind := case when new.officer_user_id is distinct from old.officer_user_id then 'ownership' when new.status = 'cancelled' then 'cancelled' when new.status = 'in_progress' then 'started' when new.status = 'completed' then 'completed' when new.status = 'missed' then 'missed' when new.scheduled_start is distinct from old.scheduled_start or new.scheduled_end is distinct from old.scheduled_end then 'timing' else new.status end;
  v_title := case when v_kind = 'missed' then 'Shift recorded as missed' else 'Shift ' || v_kind end;
  v_body := case when v_kind = 'cancelled' then 'A field shift has been cancelled.'
                 when v_kind = 'completed' then 'Your shift has been completed and is ready for timesheet review.'
                 when v_kind = 'missed' then 'You did not start the shift of ' || to_char(new.scheduled_start at time zone 'Pacific/Auckland', 'Dy DD Mon HH24:MI') || '–' || to_char(new.scheduled_end at time zone 'Pacific/Auckland', 'HH24:MI') || '. Your supervisor has been told. If this is wrong, talk to them today.'
                 else 'Your field shift has changed. Review your schedule.' end;
  perform public.enqueue_notification(p_organization_id => new.organization_id, p_category => 'roster', p_title => v_title, p_body => v_body, p_severity => case when v_kind in ('cancelled', 'missed') then 'warning' else 'info' end, p_recipient_user_id => v_user_id, p_link_page => 'schedule', p_link_payload => jsonb_build_object('shift_id', new.id, 'status', new.status), p_dedup_key => 'shift_change:' || new.id::text || ':' || v_kind || ':' || new.updated_at::text);
  return new;
end;
$function$;

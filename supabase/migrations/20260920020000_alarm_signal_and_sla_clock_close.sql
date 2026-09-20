-- Alarm response ladder: the alarm signal becomes a record, the response clock starts at the alarm, and the clock closes when the officer is on scene.
--
-- Before: the dispatch console typed the alarm's received time into briefing_notes text; alarm_events (designed
-- for exactly this, with sla_clocks.alarm_event_id waiting for it) had no writer; sla_respond_by and the SLA clock
-- were anchored at job creation, not the alarm; and nothing ever closed an SLA clock (live: 156 running, 1 met,
-- while 6 jobs had on_scene_at) so obligation dashboards counted every response as still running.

alter table public.alarm_events add column if not exists intake_channel text;
alter table public.alarm_events add column if not exists recorded_by uuid;
comment on column public.alarm_events.intake_channel is 'How the signal reached the control room: phone, email, sms, radio, monitoring_portal, other.';
comment on column public.alarm_events.recorded_by is 'The user who recorded a manual intake; null for machine-received signals.';
create unique index if not exists alarm_events_one_per_dispatch_job on public.alarm_events (dispatch_job_id) where dispatch_job_id is not null;

-- A dispatcher records (or corrects) the alarm behind an alarm-response job. Idempotent per job.
create or replace function public.record_alarm_signal(
  p_dispatch_job_id uuid,
  p_received_at timestamptz,
  p_signal_type text,
  p_intake_channel text,
  p_panel_id text default null,
  p_zone_number text default null,
  p_zone_name text default null,
  p_account_number text default null,
  p_notes text default null
) returns public.alarm_events
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_job public.dispatch_jobs%rowtype;
  v_event public.alarm_events%rowtype;
  v_site_name text;
begin
  select * into v_job from public.dispatch_jobs j where j.id = p_dispatch_job_id for update;
  if not found or not public.is_admin_for_org(v_job.organization_id) then raise exception 'Dispatch job not found or access denied'; end if;
  if v_job.status in ('completed', 'cancelled') then raise exception 'The alarm cannot be changed on a job that is already %', v_job.status; end if;
  if p_received_at is null or p_received_at > now() + interval '5 minutes' then raise exception 'The alarm received time cannot be in the future'; end if;
  if p_received_at < v_job.created_at - interval '7 days' then raise exception 'The alarm received time is more than 7 days before the job was created'; end if;
  if p_signal_type is null or p_signal_type not in ('burglary', 'panic_duress', 'fire', 'medical', 'tamper', 'power_fail', 'unknown') then raise exception 'Unknown alarm signal type'; end if;
  if p_intake_channel is null or p_intake_channel not in ('phone', 'email', 'sms', 'radio', 'monitoring_portal', 'other') then raise exception 'Unknown alarm intake channel'; end if;

  select s.name into v_site_name from public.client_sites s where s.id = v_job.client_site_id;

  insert into public.alarm_events (organization_id, site_id, dispatch_job_id, signal_type, intake_channel, panel_id, zone_number, zone_name, account_number, location_name, notes, received_at, recorded_by)
  values (v_job.organization_id, v_job.client_site_id, v_job.id, p_signal_type, p_intake_channel, nullif(trim(p_panel_id), ''), nullif(trim(p_zone_number), ''), nullif(trim(p_zone_name), ''), nullif(trim(p_account_number), ''), v_site_name, nullif(trim(p_notes), ''), p_received_at, auth.uid())
  on conflict (dispatch_job_id) where dispatch_job_id is not null do update
    set signal_type = excluded.signal_type, intake_channel = excluded.intake_channel, panel_id = excluded.panel_id, zone_number = excluded.zone_number,
        zone_name = excluded.zone_name, account_number = excluded.account_number, notes = excluded.notes, received_at = excluded.received_at, recorded_by = excluded.recorded_by
  returning * into v_event;

  -- The response target counts from the alarm, not from when the dispatcher finished typing.
  if v_job.job_type = 'alarm_response' and v_job.sla_minutes is not null then
    update public.dispatch_jobs j
    set sla_respond_by = p_received_at + make_interval(mins => j.sla_minutes),
        sla_breached = case when j.on_scene_at is not null then j.on_scene_at > p_received_at + make_interval(mins => j.sla_minutes) else false end
    where j.id = v_job.id;
    update public.sla_clocks c
    set started_at = p_received_at, alarm_event_id = v_event.id, updated_at = now(),
        elapsed_minutes = case when c.arrived_at is null then null else ceil(extract(epoch from (c.arrived_at - p_received_at)) / 60.0)::integer end,
        status = case when c.arrived_at is null then c.status
                      when c.target_minutes is null or ceil(extract(epoch from (c.arrived_at - p_received_at)) / 60.0) <= c.target_minutes then 'met' else 'breached' end
    where c.dispatch_job_id = v_job.id and c.status <> 'cancelled';
  else
    update public.sla_clocks c set alarm_event_id = v_event.id, updated_at = now() where c.dispatch_job_id = v_job.id and c.alarm_event_id is null;
  end if;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_job.organization_id, auth.uid(), 'alarm_signal_recorded', 'alarm_events', v_event.id, jsonb_build_object(
    'dispatch_job_id', v_job.id, 'signal_type', p_signal_type, 'intake_channel', p_intake_channel, 'received_at', p_received_at));
  return v_event;
end;
$$;
revoke all on function public.record_alarm_signal(uuid, timestamptz, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.record_alarm_signal(uuid, timestamptz, text, text, text, text, text, text, text) to authenticated, service_role;
comment on function public.record_alarm_signal(uuid, timestamptz, text, text, text, text, text, text, text) is 'Dispatcher records the alarm behind an alarm-response job (one per job, re-recording corrects it); re-anchors sla_respond_by and the SLA clock at the alarm received time; audited.';

-- The SLA clock closes when the officer is on scene, and is cancelled with the job. Both arrival paths
-- (arrive_at_dispatch_place, advance_dispatch_job_status) stamp dispatch_jobs.on_scene_at, so one trigger covers them.
create or replace function public.tg_dispatch_job_close_sla_clock() returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.status = 'cancelled' and coalesce(old.status, '') <> 'cancelled' then
    update public.sla_clocks c set status = 'cancelled', updated_at = now() where c.dispatch_job_id = new.id and c.status = 'running';
  elsif new.on_scene_at is not null and (old.on_scene_at is null or old.on_scene_at <> new.on_scene_at) then
    update public.sla_clocks c
    set arrived_at = new.on_scene_at,
        elapsed_minutes = ceil(extract(epoch from (new.on_scene_at - c.started_at)) / 60.0)::integer,
        status = case when c.target_minutes is null or ceil(extract(epoch from (new.on_scene_at - c.started_at)) / 60.0) <= c.target_minutes then 'met' else 'breached' end,
        updated_at = now()
    where c.dispatch_job_id = new.id and c.status in ('running', 'met', 'breached');
  end if;
  return new;
end;
$$;
drop trigger if exists trg_dispatch_job_close_sla_clock on public.dispatch_jobs;
create trigger trg_dispatch_job_close_sla_clock after update of on_scene_at, status on public.dispatch_jobs
for each row execute function public.tg_dispatch_job_close_sla_clock();

-- Correct the clocks that were left running after the officer had already arrived, or after the job was cancelled.
update public.sla_clocks c
set arrived_at = j.on_scene_at,
    elapsed_minutes = ceil(extract(epoch from (j.on_scene_at - c.started_at)) / 60.0)::integer,
    status = case when c.target_minutes is null or ceil(extract(epoch from (j.on_scene_at - c.started_at)) / 60.0) <= c.target_minutes then 'met' else 'breached' end,
    updated_at = now()
from public.dispatch_jobs j
where j.id = c.dispatch_job_id and c.status = 'running' and j.on_scene_at is not null;
update public.sla_clocks c set status = 'cancelled', updated_at = now()
from public.dispatch_jobs j where j.id = c.dispatch_job_id and c.status = 'running' and j.status = 'cancelled';

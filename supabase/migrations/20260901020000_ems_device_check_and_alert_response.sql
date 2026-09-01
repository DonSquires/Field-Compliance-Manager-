-- EMS (electronic monitoring device) officer check-in and alert response
-- workflow (#ems-devices-gap). ems_devices/ems_alerts/ems_device_checks were
-- SELECT-only under RLS -- present in schema, zero frontend, no way for an
-- officer to log a device check or for anyone to acknowledge/resolve an
-- alert. The officer 'ems' module previously fell back to the generic
-- OfficerFieldReportPage with no device context at all.

create or replace function public.submit_ems_device_check(
  p_device_id uuid,
  p_signal_quality text default null,
  p_physical_condition text default null,
  p_participant_present boolean default null,
  p_tamper_observed boolean default false,
  p_notes text default null,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null
) returns table(id uuid, alert_id uuid)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_device ems_devices%rowtype;
  v_check_id uuid;
  v_alert_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_signal_quality is not null and p_signal_quality not in ('strong', 'weak', 'no_signal') then
    raise exception 'Invalid signal quality';
  end if;

  select * into v_device from ems_devices where ems_devices.id = p_device_id;
  if not found then raise exception 'Device not found'; end if;
  if not is_admin_for_org(v_device.organization_id)
     and not exists (select 1 from user_profiles p where p.id = v_user_id and p.organization_id = v_device.organization_id and p.deactivated_at is null and p.role in ('officer', 'admin_officer')) then
    raise exception 'Not authorised to check this device';
  end if;

  insert into ems_device_checks (organization_id, device_id, officer_user_id, signal_quality, physical_condition, participant_present, tamper_observed, notes, gps_lat, gps_lng)
  values (v_device.organization_id, p_device_id, v_user_id, p_signal_quality, p_physical_condition, p_participant_present, coalesce(p_tamper_observed, false), nullif(trim(coalesce(p_notes, '')), ''), p_gps_lat, p_gps_lng)
  returning ems_device_checks.id into v_check_id;

  if coalesce(p_tamper_observed, false) then
    insert into ems_alerts (organization_id, device_id, alert_type, severity, status)
    values (v_device.organization_id, p_device_id, 'tamper', 'critical', 'active')
    returning ems_alerts.id into v_alert_id;
    update ems_devices set status = 'tampered' where ems_devices.id = p_device_id;
  end if;

  return query select v_check_id, v_alert_id;
end;
$$;

alter function public.submit_ems_device_check(uuid, text, text, boolean, boolean, text, double precision, double precision) owner to postgres;
comment on function public.submit_ems_device_check(uuid, text, text, boolean, boolean, text, double precision, double precision) is 'Officer/admin EMS device check submission. Tamper observations auto-raise a critical ems_alerts row and flag the device.';
revoke all on function public.submit_ems_device_check(uuid, text, text, boolean, boolean, text, double precision, double precision) from public, anon;
grant execute on function public.submit_ems_device_check(uuid, text, text, boolean, boolean, text, double precision, double precision) to authenticated, service_role;

create or replace function public.respond_to_ems_alert(
  p_alert_id uuid,
  p_expected_status text,
  p_next_status text,
  p_outcome text default null
) returns table(id uuid, status text, outcome text)
language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid := auth.uid();
  v_alert ems_alerts%rowtype;
  v_allowed boolean;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  select * into v_alert from ems_alerts where ems_alerts.id = p_alert_id for update;
  if not found then raise exception 'Alert not found'; end if;
  if not is_admin_for_org(v_alert.organization_id) then raise exception 'Not authorised to respond to this alert'; end if;
  if v_alert.status <> p_expected_status then raise exception 'Alert changed from expected status'; end if;

  v_allowed := case v_alert.status
    when 'active' then p_next_status in ('acknowledged', 'resolved', 'false_alarm')
    when 'acknowledged' then p_next_status in ('resolved', 'false_alarm')
    else false end;
  if not v_allowed then raise exception 'Invalid alert transition'; end if;
  if p_next_status in ('resolved', 'false_alarm') and nullif(trim(coalesce(p_outcome, '')), '') is null then
    raise exception 'An outcome is required to close an alert';
  end if;

  update ems_alerts set
    status = p_next_status,
    outcome = coalesce(p_outcome, outcome),
    responded_by = v_user_id,
    acknowledged_at = case when p_next_status = 'acknowledged' then now() else acknowledged_at end,
    resolved_at = case when p_next_status in ('resolved', 'false_alarm') then now() else resolved_at end
  where ems_alerts.id = p_alert_id;

  return query select p_alert_id, p_next_status, p_outcome;
end;
$$;

alter function public.respond_to_ems_alert(uuid, text, text, text) owner to postgres;
comment on function public.respond_to_ems_alert(uuid, text, text, text) is 'Org-admin EMS alert response: race-checked active -> acknowledged -> resolved/false_alarm lifecycle, outcome required to close.';
revoke all on function public.respond_to_ems_alert(uuid, text, text, text) from public, anon;
grant execute on function public.respond_to_ems_alert(uuid, text, text, text) to authenticated, service_role;

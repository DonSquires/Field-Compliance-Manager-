alter table public.breach_alerts
  add column if not exists requested_action text,
  add column if not exists requested_by uuid references public.user_profiles(id),
  add column if not exists requested_at timestamptz,
  add column if not exists request_notes text,
  add column if not exists request_id uuid,
  add column if not exists enforcement_mode text,
  add column if not exists request_disposition text;

alter table public.breach_alerts
  drop constraint if exists breach_alerts_requested_action_check,
  add constraint breach_alerts_requested_action_check
    check (requested_action is null or requested_action in ('written_warning', 'notice_to_vacate', 'infringement')),
  drop constraint if exists breach_alerts_enforcement_mode_check,
  add constraint breach_alerts_enforcement_mode_check
    check (enforcement_mode is null or enforcement_mode in ('officer_direct', 'admin_first', 'hybrid')),
  drop constraint if exists breach_alerts_request_disposition_check,
  add constraint breach_alerts_request_disposition_check
    check (request_disposition is null or request_disposition in ('direct', 'administrator_review'));

create unique index if not exists idx_breach_alerts_request_id
  on public.breach_alerts(request_id)
  where request_id is not null;

create or replace function public.resolve_enforcement_mode(p_zone_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    lz.enforcement_workflow_override,
    o.enforcement_workflow_mode,
    'officer_direct'
  )
  from public.location_zones lz
  join public.organizations o on o.id = lz.organization_id
  where lz.id = p_zone_id;
$$;

revoke all on function public.resolve_enforcement_mode(uuid) from public, anon, authenticated;
grant execute on function public.resolve_enforcement_mode(uuid) to service_role;

create or replace function public.submit_officer_breach_action(
  p_alert_id uuid,
  p_expected_status text,
  p_action text,
  p_notes text,
  p_request_id uuid
)
returns table(
  alert_id uuid,
  alert_status text,
  requested_action text,
  enforcement_mode text,
  disposition text,
  requested_at timestamptz,
  next_actor text,
  request_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_alert public.breach_alerts%rowtype;
  v_observation public.observations%rowtype;
  v_profile public.user_profiles%rowtype;
  v_mode text;
  v_disposition text;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_direct boolean;
begin
  if v_actor is null then
    raise exception 'Authenticated officer required';
  end if;
  if p_request_id is null then
    raise exception 'Request ID is required';
  end if;
  if p_action not in ('written_warning', 'notice_to_vacate', 'infringement') then
    raise exception 'Unsupported officer enforcement action %', p_action;
  end if;
  if v_notes is null then
    raise exception 'Enforcement notes are required';
  end if;

  select b.* into v_alert
  from public.breach_alerts b
  where b.request_id = p_request_id;

  if found then
    if v_alert.id <> p_alert_id or v_alert.requested_by <> v_actor then
      raise exception 'Request ID has already been used';
    end if;
    return query
      select v_alert.id, v_alert.status, v_alert.requested_action,
        v_alert.enforcement_mode, v_alert.request_disposition,
        v_alert.requested_at,
        case when v_alert.request_disposition = 'direct' then 'officer' else 'administrator' end,
        v_alert.request_id;
    return;
  end if;

  select b.* into v_alert
  from public.breach_alerts b
  where b.id = p_alert_id
  for update;
  if not found then
    raise exception 'Breach alert not found';
  end if;
  if v_alert.status <> p_expected_status then
    raise exception 'Breach alert changed from expected status % to %', p_expected_status, v_alert.status;
  end if;
  if v_alert.status <> 'open' then
    raise exception 'Officer enforcement requests require an open breach alert';
  end if;
  if v_alert.observation_id is null or v_alert.zone_id is null then
    raise exception 'Officer enforcement requires a zone-backed source observation';
  end if;

  select o.* into v_observation
  from public.observations o
  where o.id = v_alert.observation_id;
  if not found or v_observation.officer_id <> v_actor then
    raise exception 'Only the source officer may action this breach alert';
  end if;

  select p.* into v_profile
  from public.user_profiles p
  where p.id = v_actor and p.deactivated_at is null;
  if not found or v_profile.role not in ('officer', 'admin_officer') then
    raise exception 'Active field officer role required';
  end if;
  if not public.is_enforcement_operator_for_org(v_alert.organization_id) then
    raise exception 'Enforcement operator access is required for this organisation';
  end if;
  if not public.has_location_access(v_observation.site_id, v_observation.zone_id) then
    raise exception 'Active place authority is required for this breach';
  end if;
  if not public.user_has_task_entitlement(
    p_user => v_actor,
    p_observation_id => v_observation.id
  ) then
    raise exception 'A live task entitlement is required for this breach';
  end if;

  v_mode := public.resolve_enforcement_mode(v_alert.zone_id);
  if v_mode not in ('officer_direct', 'admin_first', 'hybrid') then
    raise exception 'A valid enforcement workflow mode could not be resolved';
  end if;

  v_direct := v_mode = 'officer_direct'
    or (v_mode = 'hybrid' and p_action <> 'infringement');
  v_disposition := case when v_direct then 'direct' else 'administrator_review' end;

  update public.breach_alerts
  set requested_action = p_action,
      requested_by = v_actor,
      requested_at = clock_timestamp(),
      request_notes = v_notes,
      request_id = p_request_id,
      enforcement_mode = v_mode,
      request_disposition = v_disposition,
      status = case when v_direct then 'actioned' else 'acknowledged' end,
      action_type = case when v_direct then p_action else null end,
      actioned_by = case when v_direct then v_actor else null end,
      actioned_at = case when v_direct then clock_timestamp() else null end,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Officer request: ' || v_notes)
  where id = v_alert.id
  returning * into v_alert;

  insert into public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_alert.organization_id,
    v_actor,
    case when v_direct then 'officer_breach_action_direct' else 'officer_breach_action_requested' end,
    'breach_alerts',
    v_alert.id,
    jsonb_build_object(
      'previous_status', p_expected_status,
      'status', v_alert.status,
      'requested_action', p_action,
      'enforcement_mode', v_mode,
      'disposition', v_disposition,
      'request_id', p_request_id,
      'observation_id', v_observation.id,
      'zone_id', v_alert.zone_id,
      'notes', v_notes
    )
  );

  if not v_direct then
    perform public.enqueue_notification(
      p_organization_id => v_alert.organization_id,
      p_category => 'breach_decision',
      p_title => 'Officer enforcement request needs review',
      p_body => v_notes,
      p_severity => 'warning',
      p_recipient_role => 'admin',
      p_link_page => 'breach-review',
      p_link_payload => jsonb_build_object('breach_alert_id', v_alert.id),
      p_dedup_key => 'breach_officer_request:' || p_request_id::text
    );
  end if;

  return query
    select v_alert.id, v_alert.status, v_alert.requested_action,
      v_alert.enforcement_mode, v_alert.request_disposition,
      v_alert.requested_at,
      case when v_direct then 'officer' else 'administrator' end,
      v_alert.request_id;
end;
$$;

revoke all on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  from public, anon;
grant execute on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  to authenticated, service_role;

create or replace function public.manage_breach_alert(
  p_alert_id uuid,
  p_expected_status text,
  p_action text,
  p_notes text
)
returns table(
  alert_id uuid,
  alert_status text,
  action_type text,
  actioned_at timestamptz,
  source_officer_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_alert public.breach_alerts%rowtype;
  v_officer uuid;
  v_next_status text;
  v_action_type text;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  select b.* into v_alert
  from public.breach_alerts b
  where b.id = p_alert_id
  for update;
  if not found then
    raise exception 'Breach alert not found';
  end if;
  if not public.is_admin_for_org(v_alert.organization_id) then
    raise exception 'Active compliance administrator required';
  end if;
  if v_alert.status <> p_expected_status then
    raise exception 'Breach alert changed from expected status % to %', p_expected_status, v_alert.status;
  end if;
  if v_notes is null then
    raise exception 'Breach decision notes are required';
  end if;

  if v_alert.status = 'open'
     and p_action in ('verbal_warning', 'written_warning', 'notice_to_vacate', 'infringement', 'tow_request', 'welfare_referral') then
    v_next_status := 'actioned';
    v_action_type := p_action;
  elsif v_alert.status = 'open' and p_action = 'dismissed' then
    v_next_status := 'dismissed';
    v_action_type := 'dismissed';
  elsif v_alert.status = 'acknowledged' and p_action = 'approve_requested' then
    if v_alert.requested_action is null then
      raise exception 'Officer request has no proposed action';
    end if;
    v_next_status := 'actioned';
    v_action_type := v_alert.requested_action;
  elsif v_alert.status = 'acknowledged' and p_action = 'dismissed' then
    v_next_status := 'dismissed';
    v_action_type := 'dismissed';
  elsif v_alert.status = 'actioned' and p_action in ('resolved', 'exempt_homeless') then
    v_next_status := p_action;
    v_action_type := v_alert.action_type;
  else
    raise exception 'Unsupported breach transition from % using %', v_alert.status, p_action;
  end if;

  update public.breach_alerts
  set status = v_next_status,
      action_type = v_action_type,
      actioned_by = v_actor,
      actioned_at = clock_timestamp(),
      notes = concat_ws(E'\n', nullif(notes, ''), 'Decision: ' || v_notes)
  where id = v_alert.id
  returning * into v_alert;

  select o.officer_id into v_officer
  from public.observations o
  where o.id = v_alert.observation_id;

  insert into public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_alert.organization_id,
    v_actor,
    'breach_alert_managed',
    'breach_alerts',
    v_alert.id,
    jsonb_build_object(
      'previous_status', p_expected_status,
      'status', v_alert.status,
      'action', p_action,
      'requested_action', v_alert.requested_action,
      'request_id', v_alert.request_id,
      'source_officer_id', v_officer,
      'notes', v_notes
    )
  );

  if v_officer is not null then
    perform public.enqueue_notification(
      p_organization_id => v_alert.organization_id,
      p_category => 'breach_decision',
      p_title => 'Breach review updated',
      p_body => v_notes,
      p_severity => 'info',
      p_recipient_user_id => v_officer,
      p_link_page => 'breach-decision',
      p_link_payload => jsonb_build_object('breach_alert_id', v_alert.id),
      p_dedup_key => 'breach_decision:' || v_alert.id::text || ':' || v_alert.status
    );
  end if;

  return query
    select v_alert.id, v_alert.status, v_alert.action_type, v_alert.actioned_at, v_officer;
end;
$$;

revoke all on function public.manage_breach_alert(uuid, text, text, text)
  from public, anon;
grant execute on function public.manage_breach_alert(uuid, text, text, text)
  to authenticated, service_role;

comment on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  is 'Governed officer enforcement request. Proves source ownership, active place and task authority, resolves enforcement mode server-side, and returns an idempotent direct-or-review receipt.';

comment on function public.resolve_enforcement_mode(uuid)
  is 'Internal effective enforcement workflow resolver: zone override, then organization default, then officer_direct. Called only from governed server-side paths.';

comment on column public.breach_alerts.requested_action
  is 'Officer-proposed notice action. Kept separate from action_type until administrator approval when review is required.';

comment on column public.breach_alerts.request_disposition
  is 'direct when the effective mode permits the officer action; administrator_review when approval is required.';

create table public.notice_print_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  breach_alert_id uuid not null references public.breach_alerts(id),
  notice_type text not null
    check (notice_type in ('written_warning', 'notice_to_vacate', 'infringement')),
  request_id uuid not null unique,
  authorized_by uuid not null references public.user_profiles(id),
  authorized_name text not null,
  status text not null default 'authorized'
    check (status in ('authorized', 'completed', 'failed')),
  response jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.notice_print_authorizations enable row level security;

revoke all on table public.notice_print_authorizations from public, anon, authenticated;
grant select, insert, update on table public.notice_print_authorizations to service_role;

create index idx_notice_print_authorizations_alert
  on public.notice_print_authorizations(breach_alert_id, created_at desc);

comment on table public.notice_print_authorizations
  is 'Server-only idempotency and receipt ledger for typed-name notice print authorization. Browser roles have no direct table access.';
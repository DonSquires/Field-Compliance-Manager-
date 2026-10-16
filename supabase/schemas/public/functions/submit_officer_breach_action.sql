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
as $function$
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
  if v_actor is null then raise exception 'Authenticated officer required'; end if;
  if p_request_id is null then raise exception 'Request ID is required'; end if;
  if p_action not in ('written_warning', 'notice_to_vacate', 'infringement') then
    raise exception 'Unsupported officer enforcement action %', p_action;
  end if;
  if v_notes is null then raise exception 'Enforcement notes are required'; end if;

  select b.* into v_alert from public.breach_alerts b where b.request_id = p_request_id;
  if found then
    if v_alert.id <> p_alert_id or v_alert.requested_by <> v_actor then
      raise exception 'Request ID has already been used';
    end if;
    return query select v_alert.id, v_alert.status, v_alert.requested_action,
      v_alert.enforcement_mode, v_alert.request_disposition, v_alert.requested_at,
      case when v_alert.request_disposition = 'direct' then 'officer' else 'administrator' end,
      v_alert.request_id;
    return;
  end if;

  select b.* into v_alert from public.breach_alerts b where b.id = p_alert_id for update;
  if not found then raise exception 'Breach alert not found'; end if;
  if v_alert.status <> p_expected_status then
    raise exception 'Breach alert changed from expected status % to %', p_expected_status, v_alert.status;
  end if;
  if v_alert.status <> 'open' then raise exception 'Officer enforcement requests require an open breach alert'; end if;
  if v_alert.observation_id is null or v_alert.zone_id is null then
    raise exception 'Officer enforcement requires a zone-backed source observation';
  end if;

  select o.* into v_observation from public.observations o where o.id = v_alert.observation_id;
  if not found or v_observation.officer_id <> v_actor then
    raise exception 'Only the source officer may action this breach alert';
  end if;
  select p.* into v_profile from public.user_profiles p where p.id = v_actor and p.deactivated_at is null;
  if not found or v_profile.role not in ('officer', 'admin_officer') then
    raise exception 'Active field officer role required';
  end if;
  if not public.is_enforcement_operator_for_org(v_alert.organization_id) then
    raise exception 'Enforcement operator access is required for this organisation';
  end if;
  if not public.has_location_access(v_observation.site_id, v_observation.zone_id) then
    raise exception 'Active place authority is required for this breach';
  end if;
  if not public.user_has_task_entitlement(p_user => v_actor, p_observation_id => v_observation.id) then
    raise exception 'A live task entitlement is required for this breach';
  end if;

  v_mode := public.resolve_enforcement_mode(v_alert.zone_id);
  if v_mode not in ('officer_direct', 'admin_first', 'hybrid') then
    raise exception 'A valid enforcement workflow mode could not be resolved';
  end if;
  v_direct := v_mode = 'officer_direct' or (v_mode = 'hybrid' and p_action <> 'infringement');
  v_disposition := case when v_direct then 'direct' else 'administrator_review' end;

  update public.breach_alerts
  set requested_action = p_action, requested_by = v_actor, requested_at = clock_timestamp(),
      request_notes = v_notes, request_id = p_request_id, enforcement_mode = v_mode,
      request_disposition = v_disposition,
      status = case when v_direct then 'actioned' else 'acknowledged' end,
      action_type = case when v_direct then p_action else null end,
      actioned_by = case when v_direct then v_actor else null end,
      actioned_at = case when v_direct then clock_timestamp() else null end,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Officer request: ' || v_notes)
  where id = v_alert.id
  returning * into v_alert;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_alert.organization_id, v_actor,
    case when v_direct then 'officer_breach_action_direct' else 'officer_breach_action_requested' end,
    'breach_alerts', v_alert.id,
    jsonb_build_object(
      'previous_status', p_expected_status, 'status', v_alert.status,
      'requested_action', p_action, 'enforcement_mode', v_mode,
      'disposition', v_disposition, 'request_id', p_request_id,
      'observation_id', v_observation.id, 'zone_id', v_alert.zone_id, 'notes', v_notes
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

  return query select v_alert.id, v_alert.status, v_alert.requested_action,
    v_alert.enforcement_mode, v_alert.request_disposition, v_alert.requested_at,
    case when v_direct then 'officer' else 'administrator' end, v_alert.request_id;
end;
$function$;

revoke all on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  from public, anon;
grant execute on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  to authenticated, service_role;

comment on function public.submit_officer_breach_action(uuid, text, text, text, uuid)
  is 'Governed officer enforcement request. Proves source ownership, active place and task authority, resolves enforcement mode server-side, and returns an idempotent direct-or-review receipt.';

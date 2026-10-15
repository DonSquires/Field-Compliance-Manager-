create or replace function public.insert_adhoc_stop(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_shift_id uuid,
  p_expected_job_status text,
  p_expected_shift_updated_at timestamp with time zone,
  p_reason text
)
returns table(
  shift_stop_id uuid,
  created boolean,
  dispatch_status text,
  runsheet_shift_id uuid,
  stop_order integer
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_receipt public.audit_log%rowtype;
  v_shift_agreement_id uuid;
  v_module_key text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_max_order integer;
begin
  if v_actor is null then raise exception 'Active user required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_dispatch_job_id is null or p_shift_id is null then raise exception 'Dispatch job and run sheet are required'; end if;
  if p_expected_job_status is null or p_expected_shift_updated_at is null then raise exception 'Expected job and run-sheet state are required'; end if;
  if v_reason is null then raise exception 'Reason is required'; end if;

  select * into v_job from public.dispatch_jobs where id = p_dispatch_job_id for update;
  if not found then raise exception 'Dispatch job not found'; end if;
  if not public.is_admin_for_org(v_job.organization_id) then raise exception 'Active organization administrator required'; end if;

  select * into v_receipt
  from public.audit_log
  where organization_id = v_job.organization_id
    and action = 'dispatch_job_runsheet_insert'
    and target_table = 'shift_stops'
    and metadata ->> 'client_request_id' = p_client_request_id::text;
  if found then
    if v_receipt.metadata ->> 'dispatch_job_id' is distinct from p_dispatch_job_id::text
       or v_receipt.metadata ->> 'shift_id' is distinct from p_shift_id::text then
      raise exception 'client_request_id has already been used for a different run-sheet insertion';
    end if;
    select * into v_stop from public.shift_stops where id = v_receipt.target_id;
    if not found then raise exception 'The prior run-sheet insertion receipt no longer resolves to a stop'; end if;
    return query select v_stop.id, false, v_job.status, v_stop.shift_id, v_stop.stop_order;
    return;
  end if;

  select * into v_shift from public.shifts where id = p_shift_id for update;
  if not found then raise exception 'Run sheet not found'; end if;
  if v_shift.organization_id is distinct from v_job.organization_id then raise exception 'Dispatch job and run sheet must belong to the same organization'; end if;

  if v_job.shift_stop_id is not null then
    select * into v_stop from public.shift_stops where id = v_job.shift_stop_id;
    if not found or v_stop.shift_id is distinct from p_shift_id then raise exception 'Dispatch job is already assigned to another run sheet'; end if;
    return query select v_stop.id, false, v_job.status, v_stop.shift_id, v_stop.stop_order;
    return;
  end if;

  if v_job.status is distinct from p_expected_job_status then raise exception 'Dispatch job changed from expected status % to %', p_expected_job_status, v_job.status; end if;
  if v_job.status not in ('pending', 'dispatched', 'acknowledged') then raise exception 'Only pending, dispatched or acknowledged jobs can be added to a run sheet'; end if;
  if v_shift.updated_at is distinct from p_expected_shift_updated_at then raise exception 'Run sheet changed after it was opened. Refresh and review it before adding the job'; end if;
  if v_shift.status not in ('published', 'accepted', 'in_progress') then raise exception 'Only published, accepted or in-progress run sheets can receive an urgent job'; end if;
  if v_job.shift_id is not null and v_job.shift_id is distinct from p_shift_id then raise exception 'Dispatch job is already assigned to another shift'; end if;
  if v_job.assigned_officer_id is not null and v_job.assigned_officer_id is distinct from v_shift.officer_user_id then raise exception 'The job is assigned to a different officer than this run sheet'; end if;
  if (v_job.client_site_id is null) = (v_job.zone_id is null) then raise exception 'Dispatch job must resolve to exactly one Site or Zone before run-sheet insertion'; end if;
  if v_job.service_agreement_id is null then raise exception 'Dispatch job must have a service agreement before run-sheet insertion'; end if;

  select coalesce(sal.service_agreement_id, sam.service_agreement_id)
  into v_shift_agreement_id
  from public.shifts s
  left join public.service_agreement_locations sal on sal.id = s.service_agreement_location_id
  left join public.service_agreement_modules sam on sam.id = s.service_agreement_module_id
  where s.id = v_shift.id;
  if v_shift_agreement_id is null or v_shift_agreement_id is distinct from v_job.service_agreement_id then raise exception 'Run sheet and dispatch job must resolve to the same service agreement'; end if;
  if not exists (
    select 1 from public.service_agreement_locations sal
    where sal.service_agreement_id = v_job.service_agreement_id
      and sal.status = 'active'
      and ((v_job.client_site_id is not null and sal.site_id = v_job.client_site_id)
        or (v_job.zone_id is not null and sal.zone_id = v_job.zone_id))
  ) then raise exception 'Dispatch place is not active under the run sheet service agreement'; end if;
  if v_job.module_key is not null and v_shift.module_key is not null and v_job.module_key is distinct from v_shift.module_key then raise exception 'Dispatch job module does not match the selected run sheet'; end if;

  v_module_key := coalesce(v_job.module_key, v_shift.module_key, v_shift.service_type);
  if v_module_key is null or trim(v_module_key) = '' then raise exception 'A canonical module is required for the run-sheet stop'; end if;
  select coalesce(max(s.stop_order), 0) into v_max_order from public.shift_stops s where s.shift_id = v_shift.id;

  insert into public.shift_stops (
    organization_id, shift_id, dispatch_job_id, site_id, zone_id, module_key, stop_order, visit_number, is_adhoc,
    sla_window_open, sla_arrive_by, required_dwell_minutes, status, sla_status, officer_instructions
  )
  values (
    v_job.organization_id, v_shift.id, v_job.id, v_job.client_site_id, v_job.zone_id, v_module_key, v_max_order + 10, 1, true,
    v_job.created_at,
    coalesce(v_job.sla_respond_by, v_job.created_at + make_interval(mins => greatest(coalesce(v_job.sla_minutes, 15), 1))),
    greatest(coalesce(v_job.expected_dwell_minutes, 5), 1), 'pending',
    case when coalesce(v_job.sla_respond_by, v_job.created_at + make_interval(mins => greatest(coalesce(v_job.sla_minutes, 15), 1))) < now() then 'breached' else 'on_track' end,
    v_job.briefing_notes
  )
  returning * into v_stop;

  update public.dispatch_jobs
  set shift_id = v_shift.id, shift_stop_id = v_stop.id, assigned_officer_id = coalesce(assigned_officer_id, v_shift.officer_user_id),
      adhoc_inserted_at = now(), status = 'dispatched', dispatched_at = coalesce(dispatched_at, now())
  where id = v_job.id;
  update public.shifts set total_stops = total_stops + 1, updated_at = now() where id = v_shift.id;
  update public.patrol_solve_cache set invalidated_at = now(), invalidation_reason = 'dispatch_job_runsheet_insert' where shift_id = v_shift.id;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_job.organization_id, v_actor, 'dispatch_job_runsheet_insert', 'shift_stops', v_stop.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id, 'dispatch_job_id', v_job.id, 'shift_id', v_shift.id,
      'officer_user_id', v_shift.officer_user_id, 'service_agreement_id', v_job.service_agreement_id,
      'site_id', v_job.client_site_id, 'zone_id', v_job.zone_id, 'module_key', v_module_key,
      'stop_order', v_stop.stop_order, 'previous_job_status', v_job.status, 'new_job_status', 'dispatched', 'reason', v_reason
    )
  );
  return query select v_stop.id, true, 'dispatched'::text, v_stop.shift_id, v_stop.stop_order;
end;
$function$;

revoke all on function public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text) from public, anon, authenticated, service_role;
grant execute on function public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text) to postgres, authenticated, service_role;
comment on function public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text) is 'Adds an eligible dispatch job to one current officer run sheet. Requires administrator authority, exact organization/agreement/place/officer alignment, optimistic job and shift state, replay identity, and writes an audit receipt.';

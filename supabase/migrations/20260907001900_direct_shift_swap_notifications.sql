-- Complete direct swap workflow and notify affected officers.

create or replace function public.request_shift_swap(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_swap_with_staff_id uuid default null,
  p_swap_type text default 'open',
  p_reason text default null
) returns public.shift_swaps
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid(); v_shift public.shifts%rowtype; v_original_staff public.staff_profiles%rowtype; v_replacement public.staff_profiles%rowtype; v_swap public.shift_swaps%rowtype; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_swap_type not in ('open', 'direct', 'coverage_request') then raise exception 'Unsupported shift swap type'; end if;
  if v_reason is null then raise exception 'A reason is required for a shift swap request'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor then raise exception 'Only the assigned officer can request a swap'; end if;
  if v_shift.status not in ('scheduled', 'published', 'accepted') then raise exception 'Only unstarted shifts can be swapped'; end if;
  select sp.* into v_original_staff from public.staff_profiles sp where sp.organization_id = v_shift.organization_id and (sp.user_id = v_actor or sp.id = v_actor) and sp.work_ready;
  if not found then raise exception 'Active work-ready staff profile required'; end if;
  if p_swap_with_staff_id is not null then
    if p_swap_type <> 'direct' then raise exception 'A replacement officer requires a direct swap'; end if;
    select sp.* into v_replacement from public.staff_profiles sp where sp.id = p_swap_with_staff_id and sp.organization_id = v_shift.organization_id and sp.work_ready;
    if not found or v_replacement.id = v_original_staff.id then raise exception 'Replacement officer is not eligible'; end if;
    if exists (select 1 from public.roster_slots rs where rs.staff_id = v_replacement.id and rs.status not in ('declined', 'cancelled') and rs.scheduled_start < v_shift.scheduled_end and rs.scheduled_end > v_shift.scheduled_start) then raise exception 'Replacement officer has an overlapping roster assignment'; end if;
  end if;
  select sw.* into v_swap from public.shift_swaps sw where sw.organization_id = v_shift.organization_id and sw.original_shift_id = v_shift.id and sw.status = 'pending' order by sw.created_at desc limit 1;
  if found then return v_swap; end if;
  insert into public.shift_swaps (organization_id, original_shift_id, original_staff_id, swap_with_staff_id, swap_type, reason, status, requested_by, requested_at) values (v_shift.organization_id, v_shift.id, v_original_staff.id, p_swap_with_staff_id, p_swap_type, v_reason, 'pending', v_actor, clock_timestamp()) returning * into v_swap;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_shift.organization_id, v_actor, 'shift_swap_requested', 'shift_swaps', v_swap.id, jsonb_build_object('shift_id', v_shift.id, 'swap_type', p_swap_type, 'replacement_staff_id', p_swap_with_staff_id, 'reason', v_reason, 'client_request_id', p_client_request_id));
  if p_swap_with_staff_id is not null and v_replacement.user_id is not null then perform public.enqueue_notification(v_shift.organization_id, 'roster', 'Direct shift swap requested', 'An officer has requested you take a rostered shift. Await roster approval.', 'warning', v_replacement.user_id, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'shift_id', v_shift.id), 'shift_swap_requested:' || v_swap.id::text); end if;
  return v_swap;
end;
$$;

create or replace function public.review_shift_swap(p_client_request_id uuid, p_swap_id uuid, p_expected_status text, p_decision text, p_review_notes text default null)
returns public.shift_swaps language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_swap public.shift_swaps%rowtype; v_orig_shift public.shifts%rowtype; v_notes text := nullif(trim(coalesce(p_review_notes, '')), ''); v_original_user uuid; v_replacement_user uuid;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select sw.* into v_swap from public.shift_swaps sw where sw.id = p_swap_id for update;
  if not found then raise exception 'Shift swap request not found'; end if;
  if not public.is_admin_for_org(v_swap.organization_id) then raise exception 'Not authorised to review shift swaps for this organization'; end if;
  if v_swap.status <> p_expected_status then raise exception 'Shift swap changed from expected status % to %', p_expected_status, v_swap.status; end if;
  if p_decision not in ('approved', 'declined') then raise exception 'Decision must be approved or declined'; end if;
  select coalesce(sp.user_id, sp.id) into v_original_user from public.staff_profiles sp where sp.id = v_swap.original_staff_id;
  select coalesce(sp.user_id, sp.id) into v_replacement_user from public.staff_profiles sp where sp.id = v_swap.swap_with_staff_id;
  if p_decision = 'approved' then
    if v_swap.swap_with_staff_id is null then raise exception 'Cannot approve swap without designated replacement staff'; end if;
    select sh.* into v_orig_shift from public.shifts sh where sh.id = v_swap.original_shift_id;
    if found then update public.shifts set officer_user_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.id; if v_orig_shift.roster_slot_id is not null then update public.roster_slots set staff_id = v_swap.swap_with_staff_id, updated_at = now() where id = v_orig_shift.roster_slot_id; end if; end if;
    update public.shift_swaps set status = 'approved', approved_by = v_actor, approved_at = now(), completed_at = now() where id = v_swap.id returning * into v_swap;
  else
    update public.shift_swaps set status = 'declined', declined_reason = v_notes, approved_by = v_actor, approved_at = now() where id = v_swap.id returning * into v_swap;
  end if;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_swap.organization_id, v_actor, 'shift_swap_reviewed', 'shift_swaps', v_swap.id, jsonb_build_object('decision', p_decision, 'original_shift_id', v_swap.original_shift_id, 'swap_with_staff_id', v_swap.swap_with_staff_id, 'client_request_id', p_client_request_id));
  if v_original_user is not null then perform public.enqueue_notification(v_swap.organization_id, 'roster', 'Shift swap ' || p_decision, coalesce(v_notes, 'Your shift swap request has been ' || p_decision || '.'), 'info', v_original_user, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'status', v_swap.status), 'shift_swap_decision:' || v_swap.id::text || ':original:' || v_swap.status); end if;
  if v_replacement_user is not null and v_replacement_user is distinct from v_original_user then perform public.enqueue_notification(v_swap.organization_id, 'roster', 'Direct shift swap ' || p_decision, coalesce(v_notes, 'The direct shift swap has been ' || p_decision || '.'), 'info', v_replacement_user, 'schedule', jsonb_build_object('shift_swap_id', v_swap.id, 'status', v_swap.status), 'shift_swap_decision:' || v_swap.id::text || ':replacement:' || v_swap.status); end if;
  return v_swap;
end;
$$;

revoke all on function public.request_shift_swap(uuid, uuid, uuid, text, text), public.review_shift_swap(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.request_shift_swap(uuid, uuid, uuid, text, text), public.review_shift_swap(uuid, uuid, text, text, text) to authenticated, service_role;
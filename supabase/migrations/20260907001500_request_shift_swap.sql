-- Add the missing officer-side request half of the existing shift swap workflow.

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
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_original_staff public.staff_profiles%rowtype;
  v_replacement public.staff_profiles%rowtype;
  v_swap public.shift_swaps%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if p_swap_type not in ('open', 'direct', 'coverage_request') then raise exception 'Unsupported shift swap type'; end if;
  if v_reason is null then raise exception 'A reason is required for a shift swap request'; end if;

  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if v_shift.officer_user_id <> v_actor then raise exception 'Only the assigned officer can request a swap'; end if;
  if v_shift.status not in ('scheduled', 'published', 'accepted') then raise exception 'Only unstarted shifts can be swapped'; end if;

  select sp.* into v_original_staff
  from public.staff_profiles sp
  where sp.organization_id = v_shift.organization_id
    and (sp.user_id = v_actor or sp.id = v_actor)
    and sp.work_ready;
  if not found then raise exception 'Active work-ready staff profile required'; end if;

  if p_swap_with_staff_id is not null then
    if p_swap_type <> 'direct' then raise exception 'A replacement officer requires a direct swap'; end if;
    select sp.* into v_replacement
    from public.staff_profiles sp
    where sp.id = p_swap_with_staff_id
      and sp.organization_id = v_shift.organization_id
      and sp.work_ready;
    if not found then raise exception 'Replacement officer is not work-ready in this organization'; end if;
    if v_replacement.id = v_original_staff.id then raise exception 'Replacement officer must be different'; end if;
    if exists (
      select 1 from public.roster_slots rs
      where rs.staff_id = v_replacement.id
        and rs.status not in ('declined', 'cancelled')
        and rs.scheduled_start < v_shift.scheduled_end
        and rs.scheduled_end > v_shift.scheduled_start
    ) then raise exception 'Replacement officer has an overlapping roster assignment'; end if;
  end if;

  select sw.* into v_swap
  from public.shift_swaps sw
  where sw.organization_id = v_shift.organization_id
    and sw.original_shift_id = v_shift.id
    and sw.status = 'pending'
  order by sw.created_at desc
  limit 1;
  if found then return v_swap; end if;

  insert into public.shift_swaps (
    organization_id, original_shift_id, original_staff_id, swap_with_staff_id,
    swap_type, reason, status, requested_by, requested_at
  ) values (
    v_shift.organization_id, v_shift.id, v_original_staff.id, p_swap_with_staff_id,
    p_swap_type, v_reason, 'pending', v_actor, clock_timestamp()
  ) returning * into v_swap;

  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (
    v_shift.organization_id, v_actor, 'shift_swap_requested', 'shift_swaps', v_swap.id,
    jsonb_build_object('shift_id', v_shift.id, 'swap_type', p_swap_type, 'replacement_staff_id', p_swap_with_staff_id, 'reason', v_reason, 'client_request_id', p_client_request_id)
  );

  return v_swap;
end;
$$;

revoke all on function public.request_shift_swap(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.request_shift_swap(uuid, uuid, uuid, text, text) to authenticated, service_role;

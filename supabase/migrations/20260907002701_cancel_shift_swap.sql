-- Allow the requesting officer to withdraw a pending shift swap.

create or replace function public.cancel_shift_swap(
  p_swap_id uuid,
  p_expected_status text,
  p_reason text
) returns public.shift_swaps
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_swap public.shift_swaps%rowtype; v_user uuid; v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then raise exception 'A cancellation reason is required'; end if;
  select sw.* into v_swap from public.shift_swaps sw where sw.id = p_swap_id for update;
  if not found then raise exception 'Shift swap request not found'; end if;
  if v_swap.status <> p_expected_status or v_swap.status <> 'pending' then raise exception 'Only the current pending swap request can be cancelled'; end if;
  select coalesce(sp.user_id, sp.id) into v_user from public.staff_profiles sp where sp.id = v_swap.original_staff_id;
  if v_user is distinct from v_actor then raise exception 'Only the requesting officer can cancel this swap'; end if;
  update public.shift_swaps set status = 'cancelled', declined_reason = v_reason where id = v_swap.id returning * into v_swap;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_swap.organization_id, v_actor, 'shift_swap_cancelled', 'shift_swaps', v_swap.id, jsonb_build_object('reason', v_reason, 'original_shift_id', v_swap.original_shift_id));
  return v_swap;
end;
$$;

revoke all on function public.cancel_shift_swap(uuid, text, text) from public, anon;
grant execute on function public.cancel_shift_swap(uuid, text, text) to authenticated, service_role;

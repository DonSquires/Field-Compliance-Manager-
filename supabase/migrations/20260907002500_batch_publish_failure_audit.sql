-- Preserve batch publish RPC compatibility while retaining materialization failures.

drop function if exists public.batch_publish_roster_slots(uuid, uuid, timestamptz, timestamptz);

create or replace function public.batch_publish_roster_slots(
  p_client_request_id uuid, p_organization_id uuid, p_from timestamptz, p_to timestamptz
) returns table(published_count integer, materialized_count integer, conflict_count integer)
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_provider uuid; v_slot record; v_unit public.roster_work_units%rowtype; v_pub integer := 0; v_mat integer := 0; v_conf integer := 0; v_res record; v_error text;
begin
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  select actor.organization_id into v_provider from public.user_profiles actor where actor.id = v_actor and actor.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active roster administrator required'; end if;
  if p_organization_id <> v_provider then raise exception 'Organization is outside your managed account hierarchy'; end if;
  for v_slot in (select s.* from public.roster_slots s where s.organization_id = v_provider and s.status = 'draft' and s.scheduled_start >= p_from and s.scheduled_start < p_to for update) loop
    if v_slot.staff_id is not null and exists (select 1 from public.leave_requests l where l.staff_id = v_slot.staff_id and l.status = 'approved' and daterange(l.starts_on, l.ends_on, '[]') && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')) then v_conf := v_conf + 1; continue; end if;
    update public.roster_slots set status = 'published', updated_at = now() where id = v_slot.id; v_pub := v_pub + 1;
    select wu.* into v_unit from public.roster_work_units wu where wu.id = v_slot.work_unit_id;
    if found and v_unit.work_unit_type <> 'internal' then
      begin select * into v_res from public.materialize_roster_slot(v_slot.id, 'published'); v_mat := v_mat + 1;
      exception when others then
        get stacked diagnostics v_error = message_text;
        insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_provider, v_actor, 'roster_batch_publish_materialization_failed', 'roster_slots', v_slot.id, jsonb_build_object('client_request_id', p_client_request_id, 'error', v_error, 'work_unit_id', v_slot.work_unit_id));
      end;
    end if;
  end loop;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_provider, v_actor, 'roster_period_batch_published', 'roster_slots', v_provider, jsonb_build_object('from', p_from, 'to', p_to, 'published_count', v_pub, 'materialized_count', v_mat, 'conflict_count', v_conf, 'client_request_id', p_client_request_id));
  return query select v_pub, v_mat, v_conf;
end;
$$;

create or replace function public.get_roster_batch_publish_failures(p_client_request_id uuid)
returns table (slot_id uuid, reason text, work_unit_id uuid)
language sql security definer stable set search_path = public
as $$
  select target_id, metadata->>'error', (metadata->>'work_unit_id')::uuid
  from public.audit_log
  where action = 'roster_batch_publish_materialization_failed'
    and metadata->>'client_request_id' = p_client_request_id::text
  order by created_at;
$$;

revoke all on function public.get_roster_batch_publish_failures(uuid) from public, anon;
grant execute on function public.get_roster_batch_publish_failures(uuid) to authenticated, service_role;

alter table public.shift_coverage_requests add column if not exists roster_slot_id uuid references public.roster_slots(id) on delete set null;
create unique index if not exists shift_coverage_requests_roster_slot_idx on public.shift_coverage_requests(roster_slot_id) where roster_slot_id is not null;

create function public.finalize_shift_coverage(p_request_id uuid,p_expected_status text,p_work_unit_id uuid,p_notes text default null)
returns table(request_id uuid,request_status text,roster_slot_id uuid,shift_id uuid) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_request public.shift_coverage_requests%rowtype;v_staff public.staff_profiles%rowtype;v_unit public.roster_work_units%rowtype;v_slot public.roster_slots%rowtype;v_materialized record;v_shift_id uuid;v_start timestamptz;v_end timestamptz;
begin
  select r.* into v_request from public.shift_coverage_requests r where r.id=p_request_id for update;if not found then raise exception 'Coverage request not found';end if;
  if not public.is_admin_for_org(v_request.organization_id) then raise exception 'Active roster administrator required';end if;
  if v_request.status<>p_expected_status then raise exception 'Coverage request changed from expected status % to %',p_expected_status,v_request.status;end if;
  if v_request.status<>'claimed' or v_request.claimed_by is null then raise exception 'Only claimed coverage can be finalized';end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.organization_id=v_request.organization_id and (sp.user_id=v_request.claimed_by or sp.id=v_request.claimed_by);if not found then raise exception 'Claimant staff profile not found';end if;
  select u.* into v_unit from public.roster_work_units u where u.id=p_work_unit_id and u.organization_id=v_request.organization_id and u.active;if not found then raise exception 'Active work unit in this organization required';end if;
  if v_request.patrol_route_id is not null and v_unit.patrol_route_id is distinct from v_request.patrol_route_id then raise exception 'Work unit does not match requested patrol route';end if;
  v_start:=(v_request.shift_date+v_request.start_time) at time zone 'Pacific/Auckland';v_end:=(v_request.shift_date+v_request.end_time) at time zone 'Pacific/Auckland';if v_end<=v_start then v_end:=v_end+interval '1 day';end if;
  select * into v_slot from public.create_roster_slot(v_request.id,v_unit.id,v_staff.id,v_start,v_end,true,concat_ws(E'\n',nullif(trim(coalesce(v_request.notes,'')),''),nullif(trim(coalesce(p_notes,'')),'')));
  if v_unit.work_unit_type<>'internal' then select * into v_materialized from public.materialize_roster_slot(v_slot.id,'published');v_shift_id:=v_materialized.shift_id;end if;
  update public.shift_coverage_requests set status='filled',filled_at=clock_timestamp(),roster_slot_id=v_slot.id where id=v_request.id returning * into v_request;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_request.organization_id,v_actor,'shift_coverage_finalized','shift_coverage_requests',v_request.id,jsonb_build_object('claimed_by',v_request.claimed_by,'work_unit_id',v_unit.id,'roster_slot_id',v_slot.id,'shift_id',v_shift_id));
  perform public.enqueue_notification(p_organization_id=>v_request.organization_id,p_category=>'roster',p_title=>'Coverage assignment confirmed',p_body=>'Your claimed coverage is now a confirmed roster assignment.',p_severity=>'info',p_recipient_user_id=>v_request.claimed_by,p_link_page=>'schedule',p_link_payload=>jsonb_build_object('roster_slot_id',v_slot.id,'shift_id',v_shift_id),p_dedup_key=>'coverage_finalized:'||v_request.id::text);
  return query select v_request.id,v_request.status,v_slot.id,v_shift_id;
end;$$;
revoke all on function public.finalize_shift_coverage(uuid,text,uuid,text) from public,anon;
grant execute on function public.finalize_shift_coverage(uuid,text,uuid,text) to authenticated,service_role;
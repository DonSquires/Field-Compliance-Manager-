alter table public.timesheets add column if not exists client_event_id uuid;
create unique index if not exists idx_timesheets_client_event on public.timesheets (organization_id, staff_id, client_event_id) where client_event_id is not null;

drop policy if exists timesheets_insert on public.timesheets;
drop policy if exists timesheets_officer_insert on public.timesheets;
drop policy if exists timesheets_update on public.timesheets;
create policy timesheets_admin_insert on public.timesheets for insert to authenticated with check (public.is_admin_for_org(organization_id));
create policy timesheets_admin_update on public.timesheets for update to authenticated using (public.is_admin_for_org(organization_id)) with check (public.is_admin_for_org(organization_id));

create function public.submit_officer_timesheet(p_client_event_id uuid,p_period_start date,p_period_end date,p_actual_hours numeric,p_overtime_hours numeric default 0,p_notes text default null)
returns table(id uuid,created boolean,submitted_at timestamptz) language plpgsql volatile security definer set search_path=public as $$
declare v_user_id uuid:=auth.uid(); v_staff public.staff_profiles%rowtype; v_sheet public.timesheets%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select sp.* into v_staff from public.staff_profiles sp join public.user_profiles up on up.id=v_user_id and up.deactivated_at is null
  where (sp.user_id=v_user_id or sp.id=v_user_id) and sp.organization_id=up.organization_id limit 1;
  if not found then raise exception 'Active staff profile required'; end if;
  if p_client_event_id is null then raise exception 'client_event_id is required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start>p_period_end or p_period_end-p_period_start>31 then raise exception 'Timesheet period must be between 1 and 32 days'; end if;
  if p_period_end>current_date then raise exception 'Future timesheet periods cannot be submitted'; end if;
  if p_actual_hours is null or p_actual_hours<0 or p_actual_hours>744 then raise exception 'Actual hours are outside the accepted range'; end if;
  if coalesce(p_overtime_hours,0)<0 or coalesce(p_overtime_hours,0)>p_actual_hours then raise exception 'Overtime hours must be between zero and actual hours'; end if;
  select t.* into v_sheet from public.timesheets t where t.organization_id=v_staff.organization_id and t.staff_id=v_staff.id and t.client_event_id=p_client_event_id;
  if found then return query select v_sheet.id,false,v_sheet.submitted_at; return; end if;
  if exists(select 1 from public.timesheets t where t.staff_id=v_staff.id and daterange(t.period_start,t.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')) then raise exception 'A timesheet already overlaps this period'; end if;
  insert into public.timesheets(organization_id,staff_id,period_start,period_end,actual_hours,overtime_hours,status,notes,submitted_at,client_event_id)
  values(v_staff.organization_id,v_staff.id,p_period_start,p_period_end,p_actual_hours,coalesce(p_overtime_hours,0),'submitted',nullif(trim(coalesce(p_notes,'')),''),clock_timestamp(),p_client_event_id) returning * into v_sheet;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_staff.organization_id,v_user_id,'timesheet_submitted','timesheets',v_sheet.id,jsonb_build_object('staff_id',v_staff.id,'period_start',p_period_start,'period_end',p_period_end,'actual_hours',p_actual_hours,'overtime_hours',coalesce(p_overtime_hours,0)));
  return query select v_sheet.id,true,v_sheet.submitted_at;
end;$$;
revoke all on function public.submit_officer_timesheet(uuid,date,date,numeric,numeric,text) from public,anon;
grant execute on function public.submit_officer_timesheet(uuid,date,date,numeric,numeric,text) to authenticated,service_role;
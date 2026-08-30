create table public.organization_workplaces (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, address text, active boolean not null default true, created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(), unique(organization_id,name)
);
create table public.cost_centres (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null, name text not null, active boolean not null default true, created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(), unique(organization_id,code)
);
create table public.roster_work_units (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, work_unit_type text not null, service_type text not null, active boolean not null default true,
  patrol_route_id uuid references public.patrol_routes(id) on delete restrict,
  service_agreement_location_id uuid references public.service_agreement_locations(id) on delete restrict,
  service_agreement_module_id uuid references public.service_agreement_modules(id) on delete restrict,
  workplace_id uuid references public.organization_workplaces(id) on delete restrict,
  team_id uuid references public.teams(id) on delete restrict,
  cost_centre_id uuid references public.cost_centres(id) on delete restrict,
  created_by uuid references public.user_profiles(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint roster_work_units_type_check check(work_unit_type in('patrol','static','internal')),
  constraint roster_work_units_exact_target_check check(
    (work_unit_type='patrol' and patrol_route_id is not null and service_agreement_location_id is null and service_agreement_module_id is null and workplace_id is null and team_id is null and cost_centre_id is null)
    or (work_unit_type='static' and patrol_route_id is null and service_agreement_location_id is not null and service_agreement_module_id is not null and workplace_id is null and team_id is null and cost_centre_id is null)
    or (work_unit_type='internal' and patrol_route_id is null and service_agreement_location_id is null and service_agreement_module_id is null and workplace_id is not null)
  ), unique(organization_id,name)
);
create table public.roster_slots (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  work_unit_id uuid not null references public.roster_work_units(id) on delete restrict,
  staff_id uuid not null references public.staff_profiles(id) on delete restrict,
  scheduled_start timestamptz not null, scheduled_end timestamptz not null, status text not null default 'draft',
  linked_shift_id uuid references public.shifts(id) on delete set null, client_request_id uuid not null,
  notes text, created_by uuid references public.user_profiles(id) on delete set null, created_at timestamptz not null default now(),
  constraint roster_slots_time_check check(scheduled_start<scheduled_end),
  constraint roster_slots_status_check check(status in('draft','published','accepted','declined','completed','cancelled')),
  unique(organization_id,client_request_id)
);
create index idx_roster_slots_period on public.roster_slots(organization_id,scheduled_start,scheduled_end);
create index idx_roster_work_units_type on public.roster_work_units(organization_id,work_unit_type) where active;

alter table public.organization_workplaces enable row level security;alter table public.cost_centres enable row level security;alter table public.roster_work_units enable row level security;alter table public.roster_slots enable row level security;
create policy organization_workplaces_select on public.organization_workplaces for select to authenticated using(public.org_access_allowed(organization_id));
create policy cost_centres_select on public.cost_centres for select to authenticated using(public.org_access_allowed(organization_id));
create policy roster_work_units_select on public.roster_work_units for select to authenticated using(public.org_access_allowed(organization_id));
create policy roster_slots_select on public.roster_slots for select to authenticated using(public.org_access_allowed(organization_id));
revoke all on public.organization_workplaces,public.cost_centres,public.roster_work_units,public.roster_slots from public,anon,authenticated;
grant select on public.organization_workplaces,public.cost_centres,public.roster_work_units,public.roster_slots to authenticated;
grant all on public.organization_workplaces,public.cost_centres,public.roster_work_units,public.roster_slots to service_role;

create function public.create_organization_workplace(p_name text,p_address text default null) returns public.organization_workplaces
language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_org uuid;v_row public.organization_workplaces%rowtype;
begin select up.organization_id into v_org from public.user_profiles up where up.id=v_actor and up.deactivated_at is null;if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active roster administrator required';end if;if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Workplace name is required';end if;insert into public.organization_workplaces(organization_id,name,address,created_by)values(v_org,trim(p_name),nullif(trim(coalesce(p_address,'')),''),v_actor)returning * into v_row;insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_org,v_actor,'organization_workplace_created','organization_workplaces',v_row.id,jsonb_build_object('name',v_row.name));return v_row;end;$$;
create function public.create_cost_centre(p_code text,p_name text) returns public.cost_centres
language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_org uuid;v_row public.cost_centres%rowtype;
begin select up.organization_id into v_org from public.user_profiles up where up.id=v_actor and up.deactivated_at is null;if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active roster administrator required';end if;if nullif(trim(coalesce(p_code,'')),'') is null or nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Cost centre code and name are required';end if;insert into public.cost_centres(organization_id,code,name,created_by)values(v_org,upper(trim(p_code)),trim(p_name),v_actor)returning * into v_row;insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(v_org,v_actor,'cost_centre_created','cost_centres',v_row.id,jsonb_build_object('code',v_row.code,'name',v_row.name));return v_row;end;$$;

create function public.create_roster_work_unit(p_name text,p_work_unit_type text,p_service_type text,p_patrol_route_id uuid default null,p_service_agreement_location_id uuid default null,p_service_agreement_module_id uuid default null,p_workplace_id uuid default null,p_team_id uuid default null,p_cost_centre_id uuid default null)
returns public.roster_work_units language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_org uuid;v_unit public.roster_work_units%rowtype;v_agreement uuid;
begin
 select up.organization_id into v_org from public.user_profiles up where up.id=v_actor and up.deactivated_at is null;if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Active roster administrator required';end if;
 if nullif(trim(coalesce(p_name,'')),'') is null or nullif(trim(coalesce(p_service_type,'')),'') is null then raise exception 'Name and service type are required';end if;
 if p_work_unit_type='patrol' then if p_patrol_route_id is null or not exists(select 1 from public.patrol_routes r where r.id=p_patrol_route_id and r.organization_id=v_org and r.is_active) then raise exception 'Active patrol route in this organization required';end if;
 elsif p_work_unit_type='static' then select sal.service_agreement_id into v_agreement from public.service_agreement_locations sal join public.service_agreements sa on sa.id=sal.service_agreement_id and sa.provider_organization_id=v_org where sal.id=p_service_agreement_location_id and sal.status='active';if v_agreement is null or not exists(select 1 from public.service_agreement_modules sam where sam.id=p_service_agreement_module_id and sam.service_agreement_id=v_agreement and sam.enabled and sam.module_key='static_guarding') then raise exception 'Active static guarding agreement location and module required';end if;
 elsif p_work_unit_type='internal' then if p_workplace_id is null or not exists(select 1 from public.organization_workplaces w where w.id=p_workplace_id and w.organization_id=v_org and w.active) then raise exception 'Active provider workplace required';end if;if p_team_id is not null and not exists(select 1 from public.teams t where t.id=p_team_id and t.organization_id=v_org and t.status='active') then raise exception 'Active team in this organization required';end if;if p_cost_centre_id is not null and not exists(select 1 from public.cost_centres c where c.id=p_cost_centre_id and c.organization_id=v_org and c.active) then raise exception 'Active cost centre in this organization required';end if;
 else raise exception 'Unsupported work unit type';end if;
 insert into public.roster_work_units(organization_id,name,work_unit_type,service_type,patrol_route_id,service_agreement_location_id,service_agreement_module_id,workplace_id,team_id,cost_centre_id,created_by)
 values(v_org,trim(p_name),p_work_unit_type,trim(p_service_type),p_patrol_route_id,p_service_agreement_location_id,p_service_agreement_module_id,p_workplace_id,p_team_id,p_cost_centre_id,v_actor) returning * into v_unit;
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_org,v_actor,'roster_work_unit_created','roster_work_units',v_unit.id,jsonb_build_object('work_unit_type',v_unit.work_unit_type,'service_type',v_unit.service_type));return v_unit;
end;$$;

create function public.create_roster_slot(p_client_request_id uuid,p_work_unit_id uuid,p_staff_id uuid,p_scheduled_start timestamptz,p_scheduled_end timestamptz,p_publish boolean default false,p_notes text default null)
returns public.roster_slots language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_unit public.roster_work_units%rowtype;v_staff public.staff_profiles%rowtype;v_slot public.roster_slots%rowtype;
begin
 select u.* into v_unit from public.roster_work_units u where u.id=p_work_unit_id and u.active;if not found or not public.is_admin_for_org(v_unit.organization_id) then raise exception 'Active authorized work unit required';end if;
 select sp.* into v_staff from public.staff_profiles sp where sp.id=p_staff_id and sp.organization_id=v_unit.organization_id;if not found or not v_staff.work_ready then raise exception 'Work-ready staff profile required';end if;
 if p_client_request_id is null then raise exception 'client_request_id is required';end if;if p_scheduled_start>=p_scheduled_end or p_scheduled_start<now()-interval '5 minutes' or p_scheduled_end-p_scheduled_start>interval '24 hours' then raise exception 'Slot timing is outside the accepted range';end if;
 select s.* into v_slot from public.roster_slots s where s.organization_id=v_unit.organization_id and s.client_request_id=p_client_request_id;if found then return v_slot;end if;
 if exists(select 1 from public.leave_requests l where l.staff_id=p_staff_id and l.status='approved' and daterange(l.starts_on,l.ends_on,'[]')&&daterange(p_scheduled_start::date,p_scheduled_end::date,'[]')) then raise exception 'Staff member has approved leave';end if;
 if exists(select 1 from public.roster_slots s where s.staff_id=p_staff_id and s.status not in('declined','cancelled') and s.scheduled_start<p_scheduled_end and s.scheduled_end>p_scheduled_start) then raise exception 'Staff member already has an overlapping roster slot';end if;
 insert into public.roster_slots(organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,client_request_id,notes,created_by) values(v_unit.organization_id,v_unit.id,p_staff_id,p_scheduled_start,p_scheduled_end,case when p_publish then 'published' else 'draft' end,p_client_request_id,nullif(trim(coalesce(p_notes,'')),''),v_actor) returning * into v_slot;
 insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_unit.organization_id,v_actor,'roster_slot_created','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'work_unit_type',v_unit.work_unit_type,'staff_id',p_staff_id,'status',v_slot.status));return v_slot;
end;$$;
revoke all on function public.create_organization_workplace(text,text),public.create_cost_centre(text,text),public.create_roster_work_unit(text,text,text,uuid,uuid,uuid,uuid,uuid,uuid),public.create_roster_slot(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text) from public,anon;
grant execute on function public.create_organization_workplace(text,text),public.create_cost_centre(text,text),public.create_roster_work_unit(text,text,text,uuid,uuid,uuid,uuid,uuid,uuid),public.create_roster_slot(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text) to authenticated,service_role;
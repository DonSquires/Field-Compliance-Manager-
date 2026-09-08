-- Site/zone induction is a place qualification, not a global staff skill.

create table if not exists public.site_induction_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_site_id uuid references public.client_sites(id) on delete cascade,
  zone_id uuid references public.location_zones(id) on delete cascade,
  service_agreement_location_id uuid references public.service_agreement_locations(id) on delete cascade,
  induction_name text not null,
  version text,
  required boolean not null default true,
  expires_after_days integer,
  active boolean not null default true,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(client_site_id, zone_id, service_agreement_location_id) >= 1)
);

create table if not exists public.staff_site_inductions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requirement_id uuid not null references public.site_induction_requirements(id) on delete cascade,
  staff_id uuid not null references public.staff_profiles(id) on delete cascade,
  completed_at timestamptz not null default now(),
  expires_at timestamptz,
  evidence_notes text,
  verified_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (requirement_id, staff_id)
);

alter table public.site_induction_requirements enable row level security;
alter table public.staff_site_inductions enable row level security;
create policy site_induction_requirements_select on public.site_induction_requirements for select using (public.org_access_allowed(organization_id));
create policy staff_site_inductions_select on public.staff_site_inductions for select using (public.org_access_allowed(organization_id));
revoke all on public.site_induction_requirements, public.staff_site_inductions from public, anon, authenticated;
grant select on public.site_induction_requirements, public.staff_site_inductions to authenticated;
grant all on public.site_induction_requirements, public.staff_site_inductions to service_role;

create or replace function public.get_site_induction_state(p_staff_id uuid, p_service_agreement_location_id uuid)
returns table (requirement_id uuid, induction_name text, required boolean, completed boolean, expires_at timestamptz)
language sql security definer stable set search_path = public as $$
  select r.id, r.induction_name, r.required,
    exists(select 1 from public.staff_site_inductions si where si.requirement_id = r.id and si.staff_id = p_staff_id and (si.expires_at is null or si.expires_at >= current_date)),
    (select si.expires_at from public.staff_site_inductions si where si.requirement_id = r.id and si.staff_id = p_staff_id order by si.completed_at desc limit 1)
  from public.site_induction_requirements r
  where r.service_agreement_location_id = p_service_agreement_location_id and r.active;
$$;

create or replace function public.manage_site_induction_requirement(
  p_requirement_id uuid default null,
  p_client_site_id uuid default null,
  p_zone_id uuid default null,
  p_service_agreement_location_id uuid default null,
  p_induction_name text default null,
  p_version text default null,
  p_required boolean default true,
  p_expires_after_days integer default null,
  p_active boolean default true,
  p_action text default 'create'
) returns public.site_induction_requirements
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_requirement public.site_induction_requirements%rowtype;
  v_name text := nullif(trim(coalesce(p_induction_name, '')), '');
begin
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Roster administrator required'; end if;
  if p_action not in ('create', 'update', 'deactivate') then raise exception 'Unsupported site induction action'; end if;

  if p_action in ('create', 'update') then
    if v_name is null then raise exception 'Induction name is required'; end if;
    if num_nonnulls(p_client_site_id, p_zone_id, p_service_agreement_location_id) = 0 then raise exception 'A site, zone, or agreement location is required'; end if;
    if p_expires_after_days is not null and p_expires_after_days < 0 then raise exception 'Expiry days cannot be negative'; end if;
    if p_client_site_id is not null and not public.has_location_access(p_client_site_id, null, 'provider_reads_client') then raise exception 'Site not found or not available to this provider'; end if;
    if p_zone_id is not null and not public.has_location_access(null, p_zone_id, 'provider_reads_client') then raise exception 'Zone not found or not available to this provider'; end if;
    if p_service_agreement_location_id is not null and not exists (
      select 1 from public.service_agreement_locations sal
      join public.service_agreements sa on sa.id = sal.service_agreement_id
      where sal.id = p_service_agreement_location_id and sa.provider_organization_id = v_org and sal.status = 'active'
    ) then raise exception 'Active agreement location not found for this provider'; end if;
  end if;

  if p_action = 'create' then
    insert into public.site_induction_requirements(organization_id, client_site_id, zone_id, service_agreement_location_id, induction_name, version, required, expires_after_days, active, created_by)
    values (v_org, p_client_site_id, p_zone_id, p_service_agreement_location_id, v_name, nullif(trim(p_version), ''), p_required, p_expires_after_days, p_active, v_actor)
    returning * into v_requirement;
  elsif p_action = 'update' then
    update public.site_induction_requirements
    set client_site_id = p_client_site_id, zone_id = p_zone_id, service_agreement_location_id = p_service_agreement_location_id, induction_name = v_name, version = nullif(trim(p_version), ''), required = p_required, expires_after_days = p_expires_after_days, active = p_active
    where id = p_requirement_id and organization_id = v_org
    returning * into v_requirement;
    if not found then raise exception 'Site induction requirement not found'; end if;
  else
    update public.site_induction_requirements set active = false
    where id = p_requirement_id and organization_id = v_org
    returning * into v_requirement;
    if not found then raise exception 'Site induction requirement not found'; end if;
  end if;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, v_actor, 'site_induction_requirement_' || p_action, 'site_induction_requirements', v_requirement.id, jsonb_build_object('induction_name', v_requirement.induction_name));
  return v_requirement;
end;
$$;

create or replace function public.record_staff_site_induction(
  p_staff_id uuid,
  p_requirement_id uuid,
  p_expires_at timestamptz default null,
  p_evidence_notes text default null
) returns public.staff_site_inductions
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_row public.staff_site_inductions%rowtype;
begin
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Roster administrator required'; end if;
  if not exists (select 1 from public.staff_profiles where id = p_staff_id and organization_id = v_org) then raise exception 'Staff profile not found'; end if;
  if not exists (select 1 from public.site_induction_requirements where id = p_requirement_id and organization_id = v_org) then raise exception 'Site induction requirement not found'; end if;

  insert into public.staff_site_inductions(organization_id, requirement_id, staff_id, expires_at, evidence_notes, verified_by)
  values (v_org, p_requirement_id, p_staff_id, p_expires_at, nullif(trim(p_evidence_notes), ''), v_actor)
  on conflict (requirement_id, staff_id) do update
  set completed_at = excluded.completed_at, expires_at = excluded.expires_at, evidence_notes = excluded.evidence_notes, verified_by = excluded.verified_by
  returning * into v_row;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, v_actor, 'staff_site_induction_recorded', 'staff_site_inductions', v_row.id, jsonb_build_object('staff_id', p_staff_id, 'requirement_id', p_requirement_id));
  return v_row;
end;
$$;

create or replace function public.tg_enforce_roster_slot_site_induction_requirements()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_work_unit public.roster_work_units%rowtype;
  v_requirement record;
begin
  if new.staff_id is null or new.work_unit_id is null then
    return new;
  end if;

  select wu.* into v_work_unit
  from public.roster_work_units wu
  where wu.id = new.work_unit_id and wu.active;

  if not found then
    return new;
  end if;

  for v_requirement in
    select r.id, r.induction_name
    from public.site_induction_requirements r
    where r.organization_id = v_work_unit.organization_id
      and r.active
      and r.required
      and (
        (r.service_agreement_location_id is not null and r.service_agreement_location_id = v_work_unit.service_agreement_location_id)
        or (r.zone_id is not null and exists(
              select 1
              from public.service_agreement_locations sal
              where sal.id = v_work_unit.service_agreement_location_id
                and sal.zone_id = r.zone_id
            ))
        or (r.client_site_id is not null and exists(
              select 1
              from public.service_agreement_locations sal
              where sal.id = v_work_unit.service_agreement_location_id
                and sal.site_id = r.client_site_id
            ))
      )
  loop
    if not exists (
      select 1
      from public.staff_site_inductions si
      where si.organization_id = v_work_unit.organization_id
        and si.staff_id = new.staff_id
        and si.requirement_id = v_requirement.id
        and (si.expires_at is null or si.expires_at >= current_date)
    ) then
      raise exception 'Assigned staff member lacks required current site induction: %', v_requirement.induction_name;
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_enforce_roster_slot_site_induction_requirements on public.roster_slots;
create trigger trg_enforce_roster_slot_site_induction_requirements
before insert or update of staff_id, work_unit_id on public.roster_slots
for each row execute function public.tg_enforce_roster_slot_site_induction_requirements();

revoke all on function public.get_site_induction_state(uuid, uuid) from public, anon;
grant execute on function public.get_site_induction_state(uuid, uuid) to authenticated, service_role;
revoke all on function public.manage_site_induction_requirement(uuid,uuid,uuid,uuid,text,text,boolean,integer,boolean,text), public.record_staff_site_induction(uuid,uuid,timestamptz,text) from public, anon;
grant execute on function public.manage_site_induction_requirement(uuid,uuid,uuid,uuid,text,text,boolean,integer,boolean,text), public.record_staff_site_induction(uuid,uuid,timestamptz,text) to authenticated, service_role;
revoke all on function public.tg_enforce_roster_slot_site_induction_requirements() from public, anon;
grant execute on function public.tg_enforce_roster_slot_site_induction_requirements() to authenticated, service_role;

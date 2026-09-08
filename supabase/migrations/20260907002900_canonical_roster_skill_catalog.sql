-- Canonical organization-scoped skill catalog. Human labels remain display data;
-- assignments and requirements use stable skill IDs.

create table if not exists public.roster_skill_catalog (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  skill_name text not null,
  skill_key text not null,
  skill_category text,
  active boolean not null default true,
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, skill_key)
);

alter table public.roster_work_units add column if not exists required_skill_ids uuid[] not null default '{}';
alter table public.staff_skills add column if not exists skill_id uuid references public.roster_skill_catalog(id) on delete restrict;

alter table public.roster_skill_catalog enable row level security;
create policy roster_skill_catalog_select on public.roster_skill_catalog for select using (public.org_access_allowed(organization_id));
revoke all on public.roster_skill_catalog from public, anon, authenticated;
grant select on public.roster_skill_catalog to authenticated;
grant all on public.roster_skill_catalog to service_role;

create or replace function public.manage_roster_skill_catalog(
  p_skill_id uuid default null,
  p_skill_name text default null,
  p_skill_category text default null,
  p_action text default 'create'
) returns public.roster_skill_catalog
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_skill public.roster_skill_catalog%rowtype; v_name text := nullif(trim(coalesce(p_skill_name, '')), ''); v_key text;
begin
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Roster administrator required'; end if;
  if p_action not in ('create','update','deactivate') then raise exception 'Unsupported skill catalog action'; end if;
  if p_action in ('create','update') and v_name is null then raise exception 'Skill name is required'; end if;
  v_key := regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g');
  if p_action = 'create' then
    insert into public.roster_skill_catalog(organization_id, skill_name, skill_key, skill_category, created_by) values (v_org, v_name, v_key, nullif(trim(p_skill_category), ''), v_actor) returning * into v_skill;
  elsif p_action = 'update' then
    select * into v_skill from public.roster_skill_catalog where id = p_skill_id and organization_id = v_org for update;
    if not found then raise exception 'Skill not found'; end if;
    update public.roster_skill_catalog set skill_name = v_name, skill_key = v_key, skill_category = nullif(trim(p_skill_category), '') where id = v_skill.id returning * into v_skill;
  else
    update public.roster_skill_catalog set active = false where id = p_skill_id and organization_id = v_org returning * into v_skill;
    if not found then raise exception 'Skill not found'; end if;
  end if;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_org, v_actor, 'roster_skill_catalog_' || p_action, 'roster_skill_catalog', v_skill.id, jsonb_build_object('skill_name', v_skill.skill_name, 'skill_key', v_skill.skill_key));
  return v_skill;
end;
$$;

create or replace function public.assign_roster_skill_to_staff(
  p_staff_id uuid,
  p_skill_id uuid,
  p_proficiency_level text,
  p_certified boolean default false,
  p_certification_expiry date default null,
  p_notes text default null
) returns public.staff_skills
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_org uuid; v_skill public.roster_skill_catalog%rowtype; v_row public.staff_skills%rowtype;
begin
  select organization_id into v_org from public.user_profiles where id = v_actor and deactivated_at is null;
  if v_org is null or not public.is_admin_for_org(v_org) then raise exception 'Roster administrator required'; end if;
  select * into v_skill from public.roster_skill_catalog where id = p_skill_id and organization_id = v_org and active;
  if not found then raise exception 'Active catalog skill required'; end if;
  if not exists (select 1 from public.staff_profiles where id = p_staff_id and organization_id = v_org) then raise exception 'Staff profile not found'; end if;
  insert into public.staff_skills(staff_id, organization_id, skill_id, skill_name, skill_category, proficiency_level, certified, certification_expiry, notes) values (p_staff_id, v_org, v_skill.id, v_skill.skill_name, v_skill.skill_category, p_proficiency_level, p_certified, p_certification_expiry, nullif(trim(p_notes), '')) returning * into v_row;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_org, v_actor, 'roster_skill_assigned_to_staff', 'staff_skills', v_row.id, jsonb_build_object('staff_id', p_staff_id, 'skill_id', p_skill_id));
  return v_row;
end;
$$;

revoke all on function public.manage_roster_skill_catalog(uuid,text,text,text), public.assign_roster_skill_to_staff(uuid,uuid,text,boolean,date,text) from public, anon;
grant execute on function public.manage_roster_skill_catalog(uuid,text,text,text), public.assign_roster_skill_to_staff(uuid,uuid,text,boolean,date,text) to authenticated, service_role;

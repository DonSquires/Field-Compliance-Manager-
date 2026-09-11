-- Add explicit skill requirements to typed work units and enforce them at slot writes.

alter table public.roster_work_units add column if not exists required_skill_names text[] not null default '{}';

create or replace function public.manage_roster_work_unit_skill_requirements(
  p_work_unit_id uuid,
  p_required_skill_names text[]
) returns public.roster_work_units
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_unit public.roster_work_units%rowtype; v_names text[];
begin
  select wu.* into v_unit from public.roster_work_units wu where wu.id = p_work_unit_id for update;
  if not found then raise exception 'Roster work unit not found'; end if;
  if not public.is_admin_for_org(v_unit.organization_id) then raise exception 'Roster administrator required'; end if;
  select coalesce(array_agg(distinct lower(trim(name)) order by lower(trim(name))), '{}') into v_names from unnest(coalesce(p_required_skill_names, '{}')) name where nullif(trim(name), '') is not null;
  update public.roster_work_units set required_skill_names = v_names where id = v_unit.id returning * into v_unit;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_unit.organization_id, v_actor, 'roster_work_unit_skills_updated', 'roster_work_units', v_unit.id, jsonb_build_object('required_skill_names', v_names));
  return v_unit;
end;
$$;

create or replace function public.tg_enforce_roster_slot_skill_requirements()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_required text[]; v_missing text;
begin
  if new.staff_id is null then return new; end if;
  select required_skill_names into v_required from public.roster_work_units where id = new.work_unit_id;
  select required into v_missing
  from unnest(coalesce(v_required, '{}')) required
  where not exists (
    select 1 from public.staff_skills skill
    where skill.staff_id = new.staff_id
      and lower(trim(skill.skill_name)) = lower(trim(required))
      and (not skill.certified or skill.certification_expiry is null or skill.certification_expiry >= current_date)
  ) limit 1;
  if v_missing is not null then raise exception 'Assigned staff member lacks required current skill: %', v_missing; end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_roster_slot_skill_requirements on public.roster_slots;
create trigger trg_enforce_roster_slot_skill_requirements before insert or update of staff_id, work_unit_id on public.roster_slots for each row execute function public.tg_enforce_roster_slot_skill_requirements();

revoke all on function public.manage_roster_work_unit_skill_requirements(uuid, text[]) from public, anon;
grant execute on function public.manage_roster_work_unit_skill_requirements(uuid, text[]) to authenticated, service_role;

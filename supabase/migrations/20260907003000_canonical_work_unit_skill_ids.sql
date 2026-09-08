-- Make work-unit requirements selectable by canonical catalog IDs.

create or replace function public.manage_roster_work_unit_skill_ids(
  p_work_unit_id uuid,
  p_required_skill_ids uuid[]
) returns public.roster_work_units
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_unit public.roster_work_units%rowtype; v_ids uuid[];
begin
  select * into v_unit from public.roster_work_units where id = p_work_unit_id for update;
  if not found or not public.is_admin_for_org(v_unit.organization_id) then raise exception 'Roster administrator required'; end if;
  select coalesce(array_agg(distinct id order by id), '{}') into v_ids from public.roster_skill_catalog where organization_id = v_unit.organization_id and active and id = any(coalesce(p_required_skill_ids, '{}'));
  update public.roster_work_units set required_skill_ids = v_ids, required_skill_names = coalesce((select array_agg(skill_name order by skill_name) from public.roster_skill_catalog where id = any(v_ids)), '{}') where id = v_unit.id returning * into v_unit;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_unit.organization_id, v_actor, 'roster_work_unit_skill_ids_updated', 'roster_work_units', v_unit.id, jsonb_build_object('required_skill_ids', v_ids));
  return v_unit;
end;
$$;

create or replace function public.tg_enforce_roster_slot_skill_requirements()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_required_id uuid; v_required_name text;
begin
  if new.staff_id is null then return new; end if;
  for v_required_id, v_required_name in select id, skill_name from public.roster_skill_catalog where id = any(coalesce((select required_skill_ids from public.roster_work_units where id = new.work_unit_id), '{}')) loop
    if not exists (select 1 from public.staff_skills skill where skill.staff_id = new.staff_id and skill.skill_id = v_required_id and (not skill.certified or skill.certification_expiry is null or skill.certification_expiry >= current_date)) then raise exception 'Assigned staff member lacks required current skill: %', v_required_name; end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.manage_roster_work_unit_skill_ids(uuid, uuid[]) from public, anon;
grant execute on function public.manage_roster_work_unit_skill_ids(uuid, uuid[]) to authenticated, service_role;

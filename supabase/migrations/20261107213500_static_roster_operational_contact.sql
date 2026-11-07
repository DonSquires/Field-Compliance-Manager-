create table public.roster_slot_contacts (
  roster_slot_id uuid primary key references public.roster_slots(id) on delete cascade,
  contact_name text,
  contact_phone text,
  version uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.user_profiles(id),
  constraint roster_slot_contacts_present check (contact_name is not null or contact_phone is not null),
  constraint roster_slot_contacts_name_valid check (
    contact_name is null or (
      contact_name = btrim(contact_name)
      and length(contact_name) between 1 and 120
      and contact_name !~ '[[:cntrl:]]'
    )
  ),
  constraint roster_slot_contacts_phone_valid check (
    contact_phone is null or (
      contact_phone = btrim(contact_phone)
      and length(contact_phone) <= 50
      and contact_phone ~* '^\+?[(0-9][0-9 ().-]*( *([e][x][t]\.?|x) *[0-9]+)?$'
      and length(regexp_replace(contact_phone, '[^0-9]', '', 'g')) between 3 and 20
    )
  )
);

comment on table public.roster_slot_contacts is
  'An explicitly designated operational contact for one static roster slot. It is not inferred from the place owner or account contacts.';

alter table public.roster_slot_contacts enable row level security;
revoke all on table public.roster_slot_contacts from public, anon, authenticated;
grant select on table public.roster_slot_contacts to authenticated, service_role;

create policy roster_slot_contacts_select on public.roster_slot_contacts
for select to authenticated
using (
  exists (
    select 1
    from public.roster_slots s
    join public.roster_work_units u on u.id = s.work_unit_id and u.organization_id = s.organization_id
    where s.id = roster_slot_contacts.roster_slot_id
      and (
        public.is_admin_for_org(s.organization_id)
        or (
          u.work_unit_type = 'static'
          and s.status in ('published', 'accepted')
          and exists (
            select 1 from public.staff_profiles sp
            where sp.id = s.staff_id
              and coalesce(sp.user_id, sp.id) = (select auth.uid())
          )
          and exists (
            select 1 from public.user_profiles p
            where p.id = (select auth.uid()) and p.deactivated_at is null
              and p.role in ('officer', 'admin_officer')
          )
        )
      )
  )
);

create function public.set_roster_slot_contact(
  p_slot_id uuid, p_expected_status text, p_contact_name text, p_contact_phone text,
  p_expected_version uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_existing public.roster_slot_contacts%rowtype;
  v_name text := nullif(btrim(p_contact_name), '');
  v_phone text := nullif(btrim(p_contact_phone), '');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select s.* into v_slot from public.roster_slots s where s.id = p_slot_id for update;
  if not found or not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Roster administrator access required';
  end if;
  if v_slot.status is distinct from p_expected_status then
    raise exception 'Roster slot changed from expected status';
  end if;
  if v_slot.status not in ('draft', 'published', 'accepted', 'declined') then
    raise exception 'A contact cannot be changed on a completed or cancelled slot';
  end if;
  if not exists (
    select 1 from public.roster_work_units u
    where u.id = v_slot.work_unit_id and u.organization_id = v_slot.organization_id and u.work_unit_type = 'static'
  ) then raise exception 'Static roster assignment required'; end if;
  if v_name is not null and (length(v_name) > 120 or v_name ~ '[[:cntrl:]]') then
    raise exception 'Contact name must be at most 120 characters on one line';
  end if;
  if v_phone is not null and (
    length(v_phone) > 50 or v_phone !~* '^\+?[(0-9][0-9 ().-]*( *([e][x][t]\.?|x) *[0-9]+)?$'
    or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 3 and 20
  ) then raise exception 'Enter a valid contact phone number'; end if;

  select c.* into v_existing from public.roster_slot_contacts c where c.roster_slot_id = v_slot.id;
  if v_existing.contact_name is not distinct from v_name and v_existing.contact_phone is not distinct from v_phone then
    return jsonb_build_object('roster_slot_id', v_slot.id, 'changed', false);
  end if;
  if v_existing.version is distinct from p_expected_version then
    raise exception 'Shift contact changed. Refresh the roster before saving';
  end if;
  if v_name is null and v_phone is null then
    delete from public.roster_slot_contacts where roster_slot_id = v_slot.id;
  else
    insert into public.roster_slot_contacts (roster_slot_id, contact_name, contact_phone, updated_by)
    values (v_slot.id, v_name, v_phone, v_actor)
    on conflict (roster_slot_id) do update
      set contact_name = excluded.contact_name, contact_phone = excluded.contact_phone,
          version = gen_random_uuid(), updated_at = now(), updated_by = excluded.updated_by;
  end if;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_slot.organization_id, v_actor, 'roster_slot_contact_changed', 'roster_slots', v_slot.id,
    jsonb_build_object('has_contact_name', v_name is not null, 'has_contact_phone', v_phone is not null));
  return jsonb_build_object('roster_slot_id', v_slot.id, 'changed', true);
end;
$function$;
revoke all on function public.set_roster_slot_contact(uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_roster_slot_contact(uuid, text, text, text, uuid) to authenticated;

-- The contact wrappers delegate to the rostered-break primitives (20261106120000) so a
-- static slot keeps its planned break and paid/unpaid setting when a contact is designated.
create function public.create_static_roster_slot_with_contact(
  p_client_request_id uuid, p_work_unit_id uuid, p_staff_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_publish boolean,
  p_notes text, p_planned_break_minutes integer, p_break_unpaid boolean,
  p_contact_name text, p_contact_phone text
) returns public.roster_slots
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_unit public.roster_work_units%rowtype;
  v_slot public.roster_slots%rowtype;
  v_contact public.roster_slot_contacts%rowtype;
begin
  if auth.uid() is null or p_client_request_id is null then raise exception 'Authentication and request ID required'; end if;
  if p_planned_break_minutes is null or p_break_unpaid is null then raise exception 'Break settings are required'; end if;
  select u.* into v_unit from public.roster_work_units u
  where u.id = p_work_unit_id and u.active and u.work_unit_type = 'static';
  if not found or not public.is_admin_for_org(v_unit.organization_id) then
    raise exception 'Active authorised static work unit required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_unit.organization_id::text || ':' || p_client_request_id::text, 0)
  );
  select s.* into v_slot from public.roster_slots s
  where s.organization_id = v_unit.organization_id and s.client_request_id = p_client_request_id for update;
  if found then
    select c.* into v_contact from public.roster_slot_contacts c where c.roster_slot_id = v_slot.id;
    if v_slot.work_unit_id is distinct from p_work_unit_id or v_slot.staff_id is distinct from p_staff_id
      or v_slot.scheduled_start is distinct from p_scheduled_start or v_slot.scheduled_end is distinct from p_scheduled_end
      or v_slot.notes is distinct from nullif(btrim(p_notes), '')
      or v_slot.planned_break_minutes is distinct from p_planned_break_minutes
      or v_slot.break_unpaid is distinct from p_break_unpaid
      or (v_slot.status in ('draft', 'published') and v_slot.status is distinct from case when p_publish then 'published' else 'draft' end)
      or v_contact.contact_name is distinct from nullif(btrim(p_contact_name), '')
      or v_contact.contact_phone is distinct from nullif(btrim(p_contact_phone), '') then
      raise exception 'Request ID already used for a different roster assignment';
    end if;
    return v_slot;
  end if;
  v_slot := public.create_roster_slot_with_break(p_client_request_id, p_work_unit_id, p_staff_id, p_scheduled_start,
    p_scheduled_end, p_publish, p_notes, p_planned_break_minutes, p_break_unpaid);
  perform public.set_roster_slot_contact(v_slot.id, v_slot.status, p_contact_name, p_contact_phone, null);
  return v_slot;
end;
$function$;
revoke all on function public.create_static_roster_slot_with_contact(uuid, uuid, uuid, timestamptz, timestamptz, boolean, text, integer, boolean, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_static_roster_slot_with_contact(uuid, uuid, uuid, timestamptz, timestamptz, boolean, text, integer, boolean, text, text) to authenticated;

create function public.update_static_roster_slot_with_contact(
  p_slot_id uuid, p_expected_status text, p_staff_id uuid,
  p_scheduled_start timestamptz, p_scheduled_end timestamptz, p_notes text,
  p_planned_break_minutes integer, p_break_unpaid boolean,
  p_contact_name text, p_contact_phone text, p_expected_contact_version uuid
) returns public.roster_slots
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_slot public.roster_slots%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_slot := public.update_roster_slot_with_break(p_slot_id, p_expected_status, p_staff_id, p_scheduled_start,
    p_scheduled_end, p_notes, p_planned_break_minutes, p_break_unpaid);
  perform public.set_roster_slot_contact(v_slot.id, v_slot.status, p_contact_name, p_contact_phone, p_expected_contact_version);
  return v_slot;
end;
$function$;
revoke all on function public.update_static_roster_slot_with_contact(uuid, text, uuid, timestamptz, timestamptz, text, integer, boolean, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.update_static_roster_slot_with_contact(uuid, text, uuid, timestamptz, timestamptz, text, integer, boolean, text, text, uuid) to authenticated;

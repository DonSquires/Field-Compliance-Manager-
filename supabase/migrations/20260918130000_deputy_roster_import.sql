-- 20260918130000_deputy_roster_import.sql
-- Deputy is the rostering model the owner wants; its exports are the bridge in.
--
-- Deputy "Location" == a rosterable thing (our roster_work_units), Deputy "Area" == the
-- pay/roster bucket, "Schedule" == planned shift (roster_slots), "Timesheet" == actual
-- (kept in the batch for a later step, never turned into pay here), "Is Leave" == leave.
-- The legacy importer dropped the billing evidence columns (EMS Minutes, NCR Minutes,
-- Purchase Order, REQ/RITM); they are kept here on the slot so invoices and monthly packs
-- can be built from delivery evidence later.

alter table public.roster_slots add column if not exists external_refs jsonb not null default '{}'::jsonb;
alter table public.roster_work_units add column if not exists external_refs jsonb not null default '{}'::jsonb;
comment on column public.roster_slots.external_refs is 'Source-system evidence for an imported slot, e.g. {"source":"deputy","deputy_location_code":..,"area_name":..,"pay_code":..,"ems_minutes":..,"ncr_minutes":..,"purchase_order":..,"req_ritm":..}.';
comment on column public.roster_work_units.external_refs is 'Source-system identity of this rosterable unit, e.g. {"deputy":{"code":"6947","name":"NSN: 585 Day Patrol"}} so later imports match without asking again.';

CREATE OR REPLACE FUNCTION public.apply_deputy_roster_import(
  p_client_request_id uuid,
  p_operating_organization_id uuid,
  p_source_file text,
  p_source_sha256 text,
  p_row_count integer,
  p_locations jsonb DEFAULT '[]'::jsonb,
  p_people jsonb DEFAULT '[]'::jsonb,
  p_slots jsonb DEFAULT '[]'::jsonb,
  p_leave jsonb DEFAULT '[]'::jsonb,
  p_manifest jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_existing jsonb;
  v_item jsonb;
  v_unit_id uuid;
  v_workplace_id uuid;
  v_staff_id uuid;
  v_units jsonb := '{}'::jsonb;         -- deputy location code -> work unit id
  v_people jsonb := '{}'::jsonb;        -- deputy export code -> staff id
  v_units_created integer := 0;
  v_units_matched integer := 0;
  v_people_matched integer := 0;
  v_slots_created integer := 0;
  v_slots_existing integer := 0;
  v_slots_unresolved integer := 0;
  v_leave_created integer := 0;
  v_leave_existing integer := 0;
  v_leave_unresolved integer := 0;
  v_receipt jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_client_request_id is null then raise exception 'client_request_id is required'; end if;
  if not public.is_admin_for_org(p_operating_organization_id) then
    raise exception 'Active authorized operating branch administrator required';
  end if;

  -- Replay: the batch already exists for this request id.
  select manifest_json->'receipt' into v_existing from public.file_import_batches
  where organization_id = p_operating_organization_id and parser = 'deputy_roster' and manifest_json->>'client_request_id' = p_client_request_id::text
  limit 1;
  if v_existing is not null then return v_existing; end if;

  -- 1. Places: match to an existing work unit, or create internal work (workplace + unit).
  for v_item in select * from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) loop
    if v_item->>'action' = 'match' and (v_item->>'work_unit_id') is not null then
      select id into v_unit_id from public.roster_work_units
      where id = (v_item->>'work_unit_id')::uuid and organization_id = p_operating_organization_id and active;
      if v_unit_id is null then raise exception 'Work unit % is not an active unit of this branch', v_item->>'work_unit_id'; end if;
      update public.roster_work_units
      set external_refs = external_refs || jsonb_build_object('deputy', jsonb_build_object('code', v_item->>'deputy_code', 'name', v_item->>'deputy_name')), updated_at = now()
      where id = v_unit_id;
      v_units_matched := v_units_matched + 1;
    elsif v_item->>'action' = 'create_internal' then
      select id into v_unit_id from public.roster_work_units
      where organization_id = p_operating_organization_id and external_refs->'deputy'->>'code' = v_item->>'deputy_code' limit 1;
      if v_unit_id is null then
        insert into public.organization_workplaces(organization_id, name, active, created_by)
        values (p_operating_organization_id, v_item->>'deputy_name', true, v_actor)
        returning id into v_workplace_id;
        insert into public.roster_work_units(organization_id, name, work_unit_type, service_type, workplace_id, active, created_by, external_refs)
        values (p_operating_organization_id, v_item->>'deputy_name', 'internal', coalesce(nullif(trim(v_item->>'service_type'), ''), 'administration'), v_workplace_id, true, v_actor,
          jsonb_build_object('deputy', jsonb_build_object('code', v_item->>'deputy_code', 'name', v_item->>'deputy_name', 'areas', coalesce(v_item->'areas', '[]'::jsonb))))
        returning id into v_unit_id;
        v_units_created := v_units_created + 1;
      else
        v_units_matched := v_units_matched + 1;
      end if;
    else
      continue;
    end if;
    v_units := v_units || jsonb_build_object(v_item->>'deputy_code', v_unit_id);
  end loop;

  -- 2. People: only admin-confirmed matches to existing staff of this branch; nothing is created.
  for v_item in select * from jsonb_array_elements(coalesce(p_people, '[]'::jsonb)) loop
    if (v_item->>'staff_id') is null then continue; end if;
    select sp.id into v_staff_id from public.staff_profiles sp
    where sp.id = (v_item->>'staff_id')::uuid and sp.organization_id = p_operating_organization_id;
    if v_staff_id is null then raise exception 'Staff % does not belong to this branch', v_item->>'staff_id'; end if;
    update public.staff_profiles
    set external_refs = external_refs || jsonb_build_object('deputy_export_code', v_item->>'export_code')
    where id = v_staff_id;
    v_people := v_people || jsonb_build_object(v_item->>'export_code', v_staff_id);
    v_people_matched := v_people_matched + 1;
  end loop;

  -- 3. Schedules -> draft roster slots, idempotent on the deterministic slot key.
  for v_item in select * from jsonb_array_elements(coalesce(p_slots, '[]'::jsonb)) loop
    v_unit_id := nullif(v_units->>(v_item->>'deputy_code'), '')::uuid;
    v_staff_id := nullif(v_people->>(v_item->>'export_code'), '')::uuid;
    if v_unit_id is null or v_staff_id is null then v_slots_unresolved := v_slots_unresolved + 1; continue; end if;
    if (v_item->>'starts_at')::timestamptz >= (v_item->>'ends_at')::timestamptz then v_slots_unresolved := v_slots_unresolved + 1; continue; end if;
    insert into public.roster_slots(organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end, status, client_request_id, notes, created_by, external_refs)
    values (p_operating_organization_id, v_unit_id, v_staff_id, (v_item->>'starts_at')::timestamptz, (v_item->>'ends_at')::timestamptz, 'draft', (v_item->>'key')::uuid,
      nullif(trim(coalesce(v_item->>'notes', '')), ''), v_actor,
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'deputy',
        'deputy_location_code', v_item->>'deputy_code', 'deputy_location_name', v_item->>'deputy_name',
        'area_name', v_item->>'area_name', 'area_export_code', v_item->>'area_code', 'pay_code', v_item->>'pay_code',
        'ems_minutes', (v_item->>'ems_minutes')::integer, 'ncr_minutes', (v_item->>'ncr_minutes')::integer,
        'purchase_order', nullif(v_item->>'purchase_order', ''), 'req_ritm', nullif(v_item->>'req_ritm', ''),
        'schedule_warning', nullif(v_item->>'warning', ''), 'deputy_published', (v_item->>'published')::boolean)))
    on conflict (organization_id, client_request_id) do nothing;
    if found then v_slots_created := v_slots_created + 1; else v_slots_existing := v_slots_existing + 1; end if;
  end loop;

  -- 4. Leave -> approved leave, idempotent on client_event_id.
  for v_item in select * from jsonb_array_elements(coalesce(p_leave, '[]'::jsonb)) loop
    v_staff_id := nullif(v_people->>(v_item->>'export_code'), '')::uuid;
    if v_staff_id is null then v_leave_unresolved := v_leave_unresolved + 1; continue; end if;
    if (v_item->>'leave_type') not in ('annual', 'sick', 'bereavement', 'parental', 'unpaid', 'other') then v_leave_unresolved := v_leave_unresolved + 1; continue; end if;
    if exists (select 1 from public.leave_requests where client_event_id = (v_item->>'key')::uuid) then v_leave_existing := v_leave_existing + 1; continue; end if;
    insert into public.leave_requests(staff_id, organization_id, leave_type, starts_on, ends_on, status, reason, approved_by, approved_at, notes, client_event_id)
    values (v_staff_id, p_operating_organization_id, v_item->>'leave_type', (v_item->>'starts_on')::date, (v_item->>'ends_on')::date,
      case when v_item->>'status' = 'Approved' then 'approved' else 'pending' end,
      'Imported from Deputy: ' || coalesce(v_item->>'deputy_type', 'leave'),
      case when v_item->>'status' = 'Approved' then v_actor end, case when v_item->>'status' = 'Approved' then now() end,
      case when nullif(trim(coalesce(v_item->>'hours', '')), '') is not null then 'Deputy hours: ' || trim(v_item->>'hours') end,
      (v_item->>'key')::uuid);
    v_leave_created := v_leave_created + 1;
  end loop;

  v_receipt := jsonb_build_object(
    'work_units_created', v_units_created, 'work_units_matched', v_units_matched, 'people_matched', v_people_matched,
    'slots_created', v_slots_created, 'slots_already_imported', v_slots_existing, 'slots_unresolved', v_slots_unresolved,
    'leave_created', v_leave_created, 'leave_already_imported', v_leave_existing, 'leave_unresolved', v_leave_unresolved,
    'timesheets_not_imported', coalesce((p_manifest->>'timesheet_rows')::integer, 0));

  insert into public.file_import_batches(organization_id, batch_name, source_file, source_sha256, parser, status, manifest_json, schema_json, row_count, duplicate_count, unresolved_count, created_by, reviewed_by, reviewed_at, review_reason)
  values (p_operating_organization_id, 'Deputy roster import ' || to_char(now() at time zone 'Pacific/Auckland', 'DD Mon YYYY HH24:MI'), coalesce(p_source_file, 'deputy.csv'), p_source_sha256, 'deputy_roster', 'applied',
    coalesce(p_manifest, '{}'::jsonb) || jsonb_build_object('client_request_id', p_client_request_id, 'receipt', v_receipt),
    jsonb_build_object('locations', (select coalesce(jsonb_agg(l - 'areas'), '[]'::jsonb) from jsonb_array_elements(coalesce(p_locations, '[]'::jsonb)) l), 'people_matched', v_people_matched),
    greatest(coalesce(p_row_count, 0), 0), v_slots_existing + v_leave_existing, v_slots_unresolved + v_leave_unresolved, v_actor, v_actor, now(), 'Applied through the Deputy import walkthrough')
  returning * into v_batch;

  v_receipt := v_receipt || jsonb_build_object('batch_id', v_batch.id);
  update public.file_import_batches set manifest_json = manifest_json || jsonb_build_object('receipt', v_receipt) where id = v_batch.id;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_operating_organization_id, v_actor, 'deputy_roster_import_applied', 'file_import_batches', v_batch.id, v_receipt);

  return v_receipt;
end;
$$;

REVOKE ALL ON FUNCTION public.apply_deputy_roster_import(uuid, uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_deputy_roster_import(uuid, uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.apply_deputy_roster_import(uuid, uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Apply an admin-reviewed Deputy export: Deputy Locations -> existing work units (or new internal workplace+unit), Deputy people -> existing staff only (never creates identities), Schedules -> draft roster_slots keyed on a deterministic client_request_id with billing evidence in external_refs, Is Leave -> leave_requests keyed on client_event_id. Timesheet actuals are counted, not imported. Records a file_import_batches row (parser deputy_roster) and an audit event; idempotent on client_request_id.';

-- Behavioural truth table: platform-wide safety warnings (redacted) and the plate registry projections.
-- Runs in a transaction and rolls back. Fixtures as postgres; reads/writes exercised as `authenticated` with a JWT sub.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin set local role postgres; end $$;
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_org_a uuid := gen_random_uuid();   -- raises the warnings
  v_org_b uuid := gen_random_uuid();   -- another provider, about to deal with the same vehicle / place
  v_a_officer uuid := gen_random_uuid();
  v_a_admin uuid := gen_random_uuid();
  v_b_officer uuid := gen_random_uuid();
  v_deactivated uuid := gen_random_uuid();
  v_vehicle uuid := gen_random_uuid();
  v_place uuid;
  v_site uuid := gen_random_uuid();
  v_flag public.entity_flags%rowtype; v_flag2 public.entity_flags%rowtype; v_flag3 public.entity_flags%rowtype;
  v_row record; v_n int; v_ok boolean; v_err text;
begin
  insert into public.organizations (id, name, organization_type, active, status, contact_email, contact_phone)
  values (v_org_a, 'Oracle Security A', 'service_provider', true, 'active', 'ops@oracle-a.test', '03 555 0100'),
         (v_org_b, 'Oracle Security B', 'service_provider', true, 'active', null, null);
  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values (v_a_officer, 'officer', v_org_a, v_org_a, 'A Officer'),
         (v_a_admin, 'admin', v_org_a, v_org_a, 'A Admin'),
         (v_b_officer, 'officer', v_org_b, v_org_b, 'B Officer'),
         (v_deactivated, 'officer', v_org_b, v_org_b, 'B Former');
  update public.user_profiles set deactivated_at = now() where id = v_deactivated;
  insert into public.canonical_vehicles (id, plate_number, make, model, colour, registered_owner_name, homeless_status, homeless_notes)
  values (v_vehicle, 'ORC123', 'Toyota', 'Hiace', 'White', 'A Real Person', 'confirmed', 'sleeps in the van most nights');
  -- The site trigger derives the house and the canonical place (20260915170000); read the place back.
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, active)
  values (v_site, v_org_a, v_org_a, 'Oracle Depot', '1 Oracle Way', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), true);
  select l.canonical_place_id into v_place from public.client_sites s join public.locations l on l.id = s.location_id where s.id = v_site;
  perform pg_temp.check('fixture: the site is linked to a canonical place', v_place is not null);

  -- Plate registry: readable through the projection, personal columns absent -----------------
  perform pg_temp.as_user(v_b_officer);
  select count(*) into v_n from public.canonical_vehicle_public where plate_number = 'ORC123';
  perform pg_temp.check('an officer of any organisation reads the plate through canonical_vehicle_public', v_n = 1);
  select count(*) into v_n from public.canonical_vehicles where plate_number = 'ORC123';
  perform pg_temp.check('the base table stays Bob-only', v_n = 0);
  perform pg_temp.check('the projection has no registered_owner_name or homeless_notes column',
    not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'canonical_vehicle_public' and column_name in ('registered_owner_name', 'homeless_notes')));
  perform pg_temp.check('the projection keeps the homeless status signal', (select homeless_status from public.canonical_vehicle_public where id = v_vehicle) = 'confirmed');

  -- Raise: officer of A raises a safety warning on the vehicle and an ordinary VOI flag ------------
  perform pg_temp.as_user(v_a_officer);
  v_err := null;
  begin
    perform public.raise_entity_flag(gen_random_uuid(), 'vehicle', v_vehicle, null, 'high', '', 'dangerous_dog');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a safety warning needs a note of what to expect: ' || coalesce(v_err, ''), v_ok);
  v_flag := public.raise_entity_flag('33333333-3333-4333-8333-333333333331', 'vehicle', v_vehicle, null, 'high', 'Large unrestrained dog in the vehicle; approach from the driver side only', 'dangerous_dog');
  perform pg_temp.check('safety warning raised for the officer''s organisation', v_flag.organization_id = v_org_a and v_flag.hazard_class = 'dangerous_dog' and v_flag.flag_type = 'safety_warning' and v_flag.active);
  v_flag2 := public.raise_entity_flag('33333333-3333-4333-8333-333333333331', 'vehicle', v_vehicle, null, 'low', 'replay', 'other');
  perform pg_temp.check('same request id replays the same flag', v_flag2.id = v_flag.id and v_flag2.hazard_class = 'dangerous_dog');
  v_flag2 := public.raise_entity_flag(gen_random_uuid(), 'vehicle', v_vehicle, 'voi', 'medium', 'Seen near the depot after hours', null);
  perform pg_temp.check('an ordinary of-interest flag has no hazard class', v_flag2.hazard_class is null and v_flag2.flag_type = 'voi');
  -- and a warning on the place, raised via the site id
  v_flag3 := public.raise_entity_flag(gen_random_uuid(), 'site', v_site, null, 'critical', 'Unstable retaining wall behind the gate', 'unsafe_structure_or_ground');
  perform pg_temp.check('a site warning is stored on the canonical place', v_flag3.entity_type = 'place' and v_flag3.entity_id = v_place);

  -- Read: the other organisation sees the warning, redacted --------------------------------------
  perform pg_temp.as_user(v_b_officer);
  select count(*) into v_n from public.get_safety_warnings('vehicle', array[v_vehicle]);
  perform pg_temp.check('B sees exactly one warning on the vehicle (the VOI flag is not exposed)', v_n = 1);
  select * into v_row from public.get_safety_warnings('vehicle', array[v_vehicle]);
  perform pg_temp.check('B gets hazard class, severity, raising organisation and its contact path',
    v_row.hazard_class = 'dangerous_dog' and v_row.alert_level = 'high' and v_row.organization_name = 'Oracle Security A' and v_row.contact_email = 'ops@oracle-a.test' and v_row.contact_phone = '03 555 0100');
  perform pg_temp.check('B does not get the narrative or the raiser', v_row.reason is null and v_row.is_own_organization = false);
  select count(*) into v_n from public.entity_flags where entity_id = v_vehicle;
  perform pg_temp.check('B still cannot read A''s flags directly (RLS unchanged)', v_n = 0);
  select * into v_row from public.get_safety_warnings('site', array[v_site]);
  perform pg_temp.check('B sees the place warning when asking by site id', v_row.hazard_class = 'unsafe_structure_or_ground' and v_row.requested_id = v_site and v_row.entity_id = v_place);

  -- Read: the raising organisation sees its own narrative ------------------------------------------
  perform pg_temp.as_user(v_a_admin);
  select * into v_row from public.get_safety_warnings('vehicle', array[v_vehicle]);
  perform pg_temp.check('A sees its own warning with the reason', v_row.is_own_organization and v_row.reason like 'Large unrestrained dog%');

  -- Guards ----------------------------------------------------------------------------------------
  perform pg_temp.as_user(v_deactivated);
  v_err := null;
  begin
    perform public.get_safety_warnings('vehicle', array[v_vehicle]);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a deactivated user gets nothing: ' || coalesce(v_err, ''), v_ok);
  perform pg_temp.as_user(v_b_officer);
  v_err := null;
  begin
    perform public.resolve_entity_flag(v_flag.id, 'not mine');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('another organisation cannot resolve A''s warning: ' || coalesce(v_err, ''), v_ok);

  -- Resolve: the raiser clears it; it disappears platform-wide ---------------------------------------
  perform pg_temp.as_user(v_a_officer);
  v_flag := public.resolve_entity_flag(v_flag.id, 'Dog rehomed');
  perform pg_temp.check('the raiser resolves the warning', not v_flag.active and v_flag.resolved_by = v_a_officer and v_flag.resolved_at is not null);
  perform pg_temp.as_user(v_b_officer);
  select count(*) into v_n from public.get_safety_warnings('vehicle', array[v_vehicle]);
  perform pg_temp.check('a resolved warning is no longer shown to anyone', v_n = 0);
  perform pg_temp.as_admin();
  perform pg_temp.check('raise and resolve are audited',
    (select count(*) from public.audit_log where target_table = 'entity_flags' and action in ('safety_warning_raised', 'safety_warning_resolved', 'entity_flag_raised')) = 4);
end $$;

rollback;

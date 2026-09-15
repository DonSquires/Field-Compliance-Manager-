-- Behavioural truth table for the place-model convergence (ruling 2026-09-15): one registry place,
-- org houses link to it, site/zone facets are siblings under the house, places are permanent.
-- Runs in a transaction and rolls back.
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
  v_org_a uuid := gen_random_uuid();
  v_org_b uuid := gen_random_uuid();
  v_admin_a uuid := gen_random_uuid();
  v_site_a uuid := gen_random_uuid();
  v_site_b uuid := gen_random_uuid();
  v_site_gps uuid := gen_random_uuid();
  v_zone_a uuid := gen_random_uuid();
  v_zone_named uuid := gen_random_uuid();
  v_house_a uuid; v_house_b uuid; v_house_zone uuid;
  v_canon_a uuid; v_canon_b uuid; v_canon_zone uuid; v_canon_x uuid; v_canon_y uuid;
  v_key text; v_kind text; v_status text; v_into uuid;
  v_ok boolean; v_err text; v_n int;
  v_rc record; v_row record;
  v_point geometry := st_setsrid(st_makepoint(173.2840, -41.2706), 4326);
begin
  insert into public.organizations (id, name, organization_type) values
    (v_org_a, 'T_PLACE_A', 'client'), (v_org_b, 'T_PLACE_B', 'client');
  insert into public.user_profiles (id, organization_id, role, display_name) values (v_admin_a, v_org_a, 'admin', 'AdminA');

  -- ── schema: duplicates are gone ───────────────────────────────────────────
  perform pg_temp.check('location_zones.site_id dropped',
    not exists (select 1 from information_schema.columns where table_schema='public' and table_name='location_zones' and column_name in ('site_id','parent_zone_id','boundary_legacy','repeat_stay_radius_meters','address','suburb','postcode','address_match_key')));
  perform pg_temp.check('client_site_zones table dropped',
    not exists (select 1 from information_schema.tables where table_schema='public' and table_name='client_site_zones'));
  perform pg_temp.check('get_zone_for_gps dropped',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_zone_for_gps'));
  perform pg_temp.check('locations.canonical_place_id present and required',
    exists (select 1 from information_schema.columns where table_schema='public' and table_name='locations' and column_name='canonical_place_id' and is_nullable='NO'));
  perform pg_temp.check('facet location_id required',
    (select count(*) from information_schema.columns where table_schema='public' and table_name in ('client_sites','location_zones') and column_name='location_id' and is_nullable='NO') = 2);
  perform pg_temp.check('single address key rule', public.address_match_key('  47 Example St, Nelson 7010 ') = '47examplestnelson7010');

  -- ── a site with no house gets one in its owner org; identity flows to the registry ──
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_site_a, v_org_a, v_org_a, 'T_SITE_A', '47 Example St', v_point, 'verified', true);
  select location_id, address_match_key into v_house_a, v_key from public.client_sites where id = v_site_a;
  perform pg_temp.check('site key normalised by trigger', v_key = '47examplest');
  perform pg_temp.check('site got a house', v_house_a is not null);
  select canonical_place_id into v_canon_a from public.locations where id = v_house_a;
  perform pg_temp.check('house has registry identity', v_canon_a is not null);
  select place_kind, canonical_key into v_kind, v_key from public.canonical_places where id = v_canon_a;
  perform pg_temp.check('registry row is a site keyed by address', v_kind = 'site' and v_key = 'site:47examplest');
  perform pg_temp.check('house link recorded', exists (select 1 from public.canonical_place_links where source_table='locations' and source_id=v_house_a and canonical_place_id=v_canon_a));
  perform pg_temp.check('registry took the site point', (select center_point is not null from public.canonical_places where id = v_canon_a));
  perform pg_temp.check('house org is the site owner', (select organization_id from public.locations where id = v_house_a) = v_org_a);

  -- second site at the same address in the same org reuses the house
  insert into public.client_sites (client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_org_a, v_org_a, 'T_SITE_A_DUP', '47 EXAMPLE ST.', v_point, 'unverified', true);
  perform pg_temp.check('same address in same org = same house', (select count(distinct location_id) from public.client_sites where client_organization_id = v_org_a) = 1);

  -- ── the same address in another organisation: its own house, the SAME registry place ──
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_site_b, v_org_b, v_org_b, 'T_SITE_B', '47 example st', v_point, 'unverified', true);
  select location_id into v_house_b from public.client_sites where id = v_site_b;
  perform pg_temp.check('other org gets its own house', v_house_b is not null and v_house_b <> v_house_a);
  select canonical_place_id into v_canon_b from public.locations where id = v_house_b;
  perform pg_temp.check('one place across organisations', v_canon_b = v_canon_a);
  perform pg_temp.check('projection helper agrees for both facets',
    public.ensure_canonical_place_for_projection('client_sites', v_site_a) = v_canon_a and public.ensure_canonical_place_for_projection('client_sites', v_site_b) = v_canon_a);

  -- ── a facet never hangs off another organisation's house ──
  begin
    insert into public.client_sites (client_organization_id, organization_id, location_id, name, address, center_point, boundary_verification, active)
      values (v_org_b, v_org_b, v_house_a, 'T_JUMP', '1 Jump St', v_point, 'unverified', true);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('site cannot use another org house: ' || coalesce(v_err,''), v_ok and v_err like '%another organisation%');
  begin
    insert into public.location_zones (organization_id, location_id, name, zone_type, module_key, is_active, boundary_verification)
      values (v_org_b, v_house_a, 'T_JUMP_ZONE', 'parking', 'parking_enforcement', true, 'unverified');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('zone cannot use another org house', v_ok and v_err like '%another organisation%');

  -- ── zones: an area gets its own house and a zone-kind registry row; siblings share a house by name ──
  insert into public.location_zones (id, organization_id, name, zone_type, module_key, is_active, boundary, boundary_verification, onsite_profile)
    values (v_zone_a, v_org_a, 'T_BEACH', 'freedom_camping', 'freedom_camping', true,
            st_multi(st_buffer(v_point::geography, 200)::geometry), 'verified', 'boundary');
  select location_id into v_house_zone from public.location_zones where id = v_zone_a;
  perform pg_temp.check('zone got a house', v_house_zone is not null and v_house_zone <> v_house_a);
  select canonical_place_id into v_canon_zone from public.locations where id = v_house_zone;
  select place_kind, canonical_key into v_kind, v_key from public.canonical_places where id = v_canon_zone;
  perform pg_temp.check('zone registry row is zone:<house id>', v_kind = 'zone' and v_key = 'zone:' || v_house_zone::text);
  perform pg_temp.check('registry took the zone boundary', (select boundary is not null from public.canonical_places where id = v_canon_zone));
  insert into public.location_zones (id, organization_id, name, zone_type, module_key, is_active, boundary_verification)
    values (v_zone_named, v_org_a, 'T_SITE_A', 'parking', 'parking_enforcement', true, 'unverified');
  perform pg_temp.check('zone named after a house is a sibling on that house', (select location_id from public.location_zones where id = v_zone_named) = v_house_a);
  perform pg_temp.check('zones_for_site lists house siblings', exists (select 1 from public.zones_for_site(v_site_a) where zone_id = v_zone_named));

  -- ── resolve_context: site and owner come from the matched zone's house ──
  insert into public.client_sites (client_organization_id, organization_id, location_id, name, address, center_point, boundary, boundary_verification, active)
    values (v_org_a, v_org_a, v_house_zone, 'T_BEACH_SITE', null, v_point, st_buffer(v_point::geography, 20)::geometry, 'verified', true);
  select * into v_rc from public.resolve_context(-41.2706, 173.2840, v_org_a, 'freedom_camping');
  perform pg_temp.check('resolve_context resolves the verified zone', v_rc.resolution_status = 'resolved' and v_rc.matched_zone_id = v_zone_a);
  perform pg_temp.check('resolve_context site is the house sibling', v_rc.site_id = (select id from public.client_sites where name = 'T_BEACH_SITE') and v_rc.on_site = true);
  perform pg_temp.check('resolve_context owner is the house org', v_rc.client_org_id = v_org_a);
  select * into v_rc from public.resolve_active_rules(v_org_a, 'freedom_camping', null, null, v_zone_a);
  perform pg_temp.check('resolve_active_rules zone anchor carries house + sibling site', v_rc.active_location_id = v_house_zone and v_rc.active_site_id is not null);

  -- ── gps_lat/gps_lng are derived from center_point ──
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, gps_lat, gps_lng, boundary_verification, active)
    values (v_site_gps, v_org_a, v_org_a, 'T_GPS', '9 Point Rd', -41.30, 173.20, 'unverified', true);
  perform pg_temp.check('gps-only insert builds center_point', (select st_x(center_point) between 173.19 and 173.21 from public.client_sites where id = v_site_gps));
  update public.client_sites set center_point = st_setsrid(st_makepoint(174.0, -40.0), 4326) where id = v_site_gps;
  perform pg_temp.check('center_point update refreshes gps columns', (select gps_lat = -40.0 and gps_lng = 174.0 from public.client_sites where id = v_site_gps));

  -- ── permanence ──
  perform pg_temp.check('authenticated cannot delete places',
    not has_table_privilege('authenticated', 'public.locations', 'DELETE') and not has_table_privilege('authenticated', 'public.client_sites', 'DELETE')
    and not has_table_privilege('authenticated', 'public.location_zones', 'DELETE') and not has_table_privilege('anon', 'public.canonical_places', 'TRUNCATE'));
  update public.client_sites set created_at = now() - interval '2 hours' where id = v_site_gps;
  begin
    delete from public.client_sites where id = v_site_gps;
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('an established place cannot be deleted', v_ok and v_err like 'Places are permanent%');
  update public.canonical_places set created_at = now() - interval '2 hours' where id = v_canon_a;
  begin
    delete from public.canonical_places where id = v_canon_a;
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('registry rows cannot be deleted', v_ok);
  perform set_config('app.place_delete_scope', 'test_dataset_purge', true);
  delete from public.client_sites where id = v_site_gps;
  perform pg_temp.check('test purge scope may delete', not exists (select 1 from public.client_sites where id = v_site_gps));
  perform set_config('app.place_delete_scope', '', true);

  -- ── merge: converge two registry rows without deleting either ──
  v_canon_x := public.ensure_canonical_place('zone', 'zone:t-x', 'T_X', null);
  v_canon_y := public.ensure_canonical_place('zone', 'zone:t-y', 'T_Y', null);
  perform public.merge_canonical_place(v_canon_x, v_canon_y);
  select status, merged_into_id into v_status, v_into from public.canonical_places where id = v_canon_x;
  perform pg_temp.check('merged row is kept and points at survivor', v_status = 'merged' and v_into = v_canon_y);
  perform pg_temp.check('merged key resolves to the survivor', public.ensure_canonical_place('zone', 'zone:t-x', 'T_X', null) = v_canon_y);
  perform pg_temp.check('place_kind is site|zone only', not exists (select 1 from public.canonical_places where place_kind not in ('site','zone')));

  -- ── registry is readable by any signed-in user ──
  perform pg_temp.as_user(v_admin_a);
  select count(*) into v_n from public.canonical_places where id in (v_canon_a, v_canon_zone);
  perform pg_temp.as_admin();
  perform pg_temp.check('registry searchable by authenticated user', v_n = 2);
end $$;

rollback;

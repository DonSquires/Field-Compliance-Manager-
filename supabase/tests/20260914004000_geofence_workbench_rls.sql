-- Behavioural truth table for the Geofence Workbench engine (20260914004000, live) and the
-- verification hardening (20260914140000). Runs in a transaction and rolls back. Real RLS:
-- fixtures as postgres, every command exercised as `authenticated` with a JWT sub.
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
-- Square polygon (as GeoJSON) of side p_side_m centred on lng/lat.
create or replace function pg_temp.square(p_lng double precision, p_lat double precision, p_side_m double precision) returns jsonb language sql as $$
  select st_asgeojson(st_transform(st_expand(st_transform(st_setsrid(st_makepoint(p_lng, p_lat), 4326), 2193), p_side_m / 2), 4326))::jsonb
$$;

do $$
declare
  v_provider uuid := gen_random_uuid();
  v_council  uuid := gen_random_uuid();
  v_stranger_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();        -- provider admin (custodian; agreement with the council)
  v_council_user uuid := gen_random_uuid(); -- council admin (owns the site)
  v_stranger uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();         -- council-owned, no boundary yet, centre only
  v_site2 uuid := gen_random_uuid();        -- council-owned, centre 30 m away, used for dedup + verify-nothing
  v_zone uuid := gen_random_uuid();         -- provider-owned freedom camping zone, no boundary
  v_cp_nopoint uuid := gen_random_uuid();   -- provider checkpoint with no coordinates
  v_cp uuid := gen_random_uuid();           -- provider checkpoint with a point + 5 m radius
  v_officer uuid := gen_random_uuid();      -- provider officer on an in-progress shift (checkpoint visits)
  v_shift uuid := gen_random_uuid();
  v_stranger_site uuid := gen_random_uuid(); -- owned by the stranger org: outside the provider's reach
  v_req uuid := gen_random_uuid();
  v_sneaky uuid;
  v_cpn record; v_cpn2 record; v_visit record; v_pv public.patrol_checkpoint_visits%rowtype;
  v_p1 record; v_p2 record; v_tiny record; v_pz record; v_porg record; v_pmulti record; v_acc record; v_accz record;
  v_cs public.client_sites%rowtype; v_z public.location_zones%rowtype; v_bp public.boundary_proposals%rowtype;
  v_row record; v_count int; v_err text; v_ok boolean;
begin
  -- ── fixtures ──────────────────────────────────────────────────────────────
  insert into public.organizations (id, name, organization_type) values
    (v_provider, 'T_PROVIDER', 'service_provider'), (v_council, 'T_COUNCIL', 'government'), (v_stranger_org, 'T_STRANGER', 'private_enterprise');
  insert into public.user_profiles (id, organization_id, role, display_name) values
    (v_admin, v_provider, 'admin', 'ProviderAdmin'), (v_council_user, v_council, 'admin', 'CouncilAdmin'), (v_stranger, v_stranger_org, 'admin', 'Stranger');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status)
    values (v_agreement, v_provider, v_council, 'Sites', current_date - 30, 'operational', 'accepted');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, address_match_key, center_point, boundary_verification, active)
    values (v_site, v_council, v_provider, 'T_SITE', '12 Workbench St', '12workbenchst', st_setsrid(st_makepoint(173.2840, -41.2706), 4326), 'unverified', true),
           (v_site2, v_council, v_provider, 'T_SITE_2', '14 Workbench St', '14workbenchst', st_setsrid(st_makepoint(173.28436, -41.2706), 4326), 'unverified', true);
  insert into public.service_agreement_locations (service_agreement_id, site_id, status) values (v_agreement, v_site, 'active'), (v_agreement, v_site2, 'active') on conflict do nothing;
  insert into public.location_zones (id, organization_id, name, zone_type, module_key, is_active, boundary_verification)
    values (v_zone, v_provider, 'T_ZONE', 'freedom_camping', 'freedom_camping', true, 'unverified');
  insert into public.patrol_checkpoints (id, organization_id, client_site_id, name, gps_lat, gps_lng, radius_meters)
    values (v_cp_nopoint, v_provider, v_site, 'T_CP_NOPOINT', null, null, 5), (v_cp, v_provider, v_site, 'T_CP', -41.2706, 173.2840, 5);
  insert into public.user_profiles (id, organization_id, role, display_name) values (v_officer, v_provider, 'officer', 'Officer');
  insert into public.shifts (id, organization_id, officer_user_id, service_type, scheduled_start, scheduled_end, actual_start, status)
    values (v_shift, v_provider, v_officer, 'patrol', now() - interval '2 hours', now() + interval '6 hours', now() - interval '2 hours', 'in_progress');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_stranger_site, v_stranger_org, v_stranger_org, 'T_STRANGER_SITE', '99 Elsewhere Rd', st_setsrid(st_makepoint(173.30, -41.28), 4326), 'unverified', true);

  -- ── staging table: readable within reach, never writable from the browser ──
  perform pg_temp.as_user(v_admin);
  begin
    insert into public.boundary_proposals (organization_id, entity_type, proposed_boundary, area_m2, source, gate_ok)
      values (v_council, 'client_site', st_multi(st_geomfromgeojson(pg_temp.square(173.2840, -41.2706, 30)::text)), 900, 'user_drawn', true);
    perform pg_temp.check('proposals cannot be inserted directly by a browser role', false);
  exception when insufficient_privilege then
    perform pg_temp.check('proposals cannot be inserted directly by a browser role', true);
  end;

  -- ── propose from a LINZ parcel: staged, measured, gated; live row untouched ──
  select * into v_p1 from public.propose_boundary(v_council, 'client_site', v_site, pg_temp.square(173.2840, -41.2706, 30), 'linz_parcel', '{"appellation":"LOT 1 DP 1"}'::jsonb, null, null, 'workbench');
  perform pg_temp.check('proposal staged with measured area and passing site gate', v_p1.proposal_id is not null and v_p1.area_m2 between 850 and 950 and v_p1.gate_ok and v_p1.gate_reason is null and v_p1.drift_from_current_m is null and not v_p1.current_has_boundary);
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_site;
  perform pg_temp.check('proposing never touches the live boundary', v_cs.boundary is null and v_cs.boundary_verification = 'unverified');
  select count(*) into v_count from public.audit_log where action = 'boundary_proposed' and target_id = v_p1.proposal_id;
  perform pg_temp.check('proposal is audited', v_count = 1);

  -- a second proposal for the same entity supersedes the open one
  perform pg_temp.as_user(v_admin);
  select * into v_p2 from public.propose_boundary(v_council, 'client_site', v_site, pg_temp.square(173.28401, -41.27061, 32), 'linz_building', '{}'::jsonb, null, null, 'workbench');
  perform pg_temp.as_admin();
  perform pg_temp.check('an older open proposal for the entity is superseded', (select status from public.boundary_proposals where id = v_p1.proposal_id) = 'superseded' and (select status from public.boundary_proposals where id = v_p2.proposal_id) = 'proposed');

  -- the area gate is loud: a 1 m² shape is staged but cannot be accepted
  perform pg_temp.as_user(v_admin);
  select * into v_tiny from public.propose_boundary(v_council, 'client_site', v_site2, pg_temp.square(173.28436, -41.2706, 1), 'user_drawn', '{}'::jsonb, null, null, 'workbench');
  perform pg_temp.check('a shape below the band is flagged, not hidden', not v_tiny.gate_ok and v_tiny.gate_reason like 'below_min_area:%');
  begin
    perform public.accept_boundary_proposal(v_tiny.proposal_id, null, false, null);
    perform pg_temp.check('a failing gate blocks acceptance', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a failing gate blocks acceptance', v_err like '%fails the site area gate%');
  end;

  -- geometry that is not a polygon is refused at the door
  begin
    perform public.propose_boundary(v_council, 'client_site', v_site, '{"type":"Point","coordinates":[173.284,-41.2706]}'::jsonb, 'user_drawn', '{}'::jsonb, null, null, 'workbench');
    perform pg_temp.check('a point is not a boundary', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a point is not a boundary', v_err like '%must be a polygon%');
  end;

  -- ── the stranger has no reach ─────────────────────────────────────────────
  perform pg_temp.as_user(v_stranger);
  select count(*) into v_count from public.boundary_proposals;
  perform pg_temp.check('a stranger sees no proposals', v_count = 0);
  begin
    perform public.propose_boundary(v_council, 'client_site', v_site, pg_temp.square(173.2840, -41.2706, 30), 'user_drawn', '{}'::jsonb, null, null, 'workbench');
    perform pg_temp.check('a stranger cannot propose for another org', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a stranger cannot propose for another org', v_err like '%Organization access denied%');
  end;
  begin
    perform public.accept_boundary_proposal(v_p2.proposal_id, null, false, null);
    perform pg_temp.check('a stranger cannot accept another org''s proposal', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a stranger cannot accept another org''s proposal', v_err like '%access denied%');
  end;
  begin
    perform public.reject_boundary_proposal(v_p2.proposal_id, 'nope');
    perform pg_temp.check('a stranger cannot reject another org''s proposal', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a stranger cannot reject another org''s proposal', v_err like '%access denied%');
  end;

  -- ── verification hardening: nothing can be certified without geometry ─────
  perform pg_temp.as_user(v_admin);
  begin
    perform public.verify_boundary('client_site', v_site2);
    perform pg_temp.check('a site with no geometry cannot be verified', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a site with no geometry cannot be verified', v_err like '%no boundary geometry to verify%');
  end;
  perform pg_temp.as_admin();
  perform pg_temp.check('the refused verification left no history and no state change',
    (select boundary_verification from public.client_sites where id = v_site2) = 'unverified'
    and not exists (select 1 from public.geofence_boundary_history where entity_type = 'client_site' and entity_id = v_site2));
  perform pg_temp.check('anon can no longer execute the verification or version helpers',
    not has_function_privilege('anon', 'public.verify_boundary(text, uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public._gbh_next_version(text, uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._gbh_next_version(text, uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_boundary_history(text, uuid)', 'EXECUTE'));
  -- Tier 4: a checkpoint is a point + radius; the same rule applies and it is versioned (Q3, Q4)
  perform pg_temp.as_user(v_admin);
  begin
    perform public.verify_boundary('patrol_checkpoint', v_cp_nopoint);
    perform pg_temp.check('a checkpoint with no point cannot be verified', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a checkpoint with no point cannot be verified', v_err like '%patrol_checkpoint%no boundary geometry to verify%');
  end;
  v_ok := public.verify_boundary('patrol_checkpoint', v_cp);
  perform pg_temp.as_admin();
  perform pg_temp.check('a checkpoint with a point is verified and versioned',
    v_ok and (select checkpoint_verification from public.patrol_checkpoints where id = v_cp) = 'verified'
    and (select checkpoint_verified_by from public.patrol_checkpoints where id = v_cp) = v_admin
    and exists (select 1 from public.geofence_boundary_history h where h.entity_type = 'patrol_checkpoint' and h.entity_id = v_cp and h.verification_state = 'verified' and h.version = 1
                and st_area(h.boundary::geography) between 70 and 90));
  perform pg_temp.check('the pointless checkpoint stayed unverified with no history',
    (select checkpoint_verification from public.patrol_checkpoints where id = v_cp_nopoint) = 'unverified'
    and not exists (select 1 from public.geofence_boundary_history where entity_type = 'patrol_checkpoint' and entity_id = v_cp_nopoint));

  -- ── Tier 4 direct-save (20260915100000): placed at a site, unverified, versioned; any move resets (Q3/Q4/Q8/P2) ──
  perform pg_temp.as_user(v_admin);
  select * into v_cpn from public.manage_patrol_checkpoint(v_req, 'create', v_provider, null, v_site, 'Gate A', 'Main gate', -41.27062, 173.28402, null, 'QR-GATE-A');
  perform pg_temp.check('a checkpoint is placed at a site with the platform default radius, unverified',
    v_cpn.created and v_cpn.radius_meters = 5 and v_cpn.checkpoint_verification = 'unverified' and v_cpn.history_version = 1 and v_cpn.client_site_id = v_site);
  perform pg_temp.as_admin();
  perform pg_temp.check('placement is versioned as a point-radius geometry and audited',
    exists (select 1 from public.geofence_boundary_history h where h.entity_type = 'patrol_checkpoint' and h.entity_id = v_cpn.id and h.version = 1
            and h.boundary_source = 'manual_point_radius' and h.changed_via = 'direct_edit' and h.verification_state = 'unverified' and st_area(h.boundary::geography) between 70 and 90)
    and exists (select 1 from public.audit_log a where a.action = 'patrol_checkpoint_created' and a.target_id = v_cpn.id));
  perform pg_temp.as_user(v_admin);
  select * into v_cpn2 from public.manage_patrol_checkpoint(v_req, 'create', v_provider, null, v_site, 'Gate A', null, -41.27062, 173.28402, null, null);
  perform pg_temp.check('replaying the same client_request_id returns the same checkpoint', not v_cpn2.created and v_cpn2.id = v_cpn.id and v_cpn2.history_version = 1);
  perform pg_temp.as_admin();
  insert into public.org_geofence_config (organization_id, config_key, config_value) values (v_provider, 'checkpoint_radius_m', 8);
  perform pg_temp.as_user(v_admin);
  select * into v_cpn2 from public.manage_patrol_checkpoint(gen_random_uuid(), 'create', v_provider, null, v_site, 'Gate B', null, -41.27070, 173.28410, null, null);
  perform pg_temp.check('the radius follows the organisation rule when one is set (Q8)', v_cpn2.radius_meters = 8);
  v_ok := public.verify_boundary('patrol_checkpoint', v_cpn.id);
  select * into v_cpn2 from public.manage_patrol_checkpoint(gen_random_uuid(), 'update', v_provider, v_cpn.id, null, null, null, -41.27080, 173.28402, null, null);
  perform pg_temp.check('moving a verified checkpoint resets it to unverified and writes a new version',
    v_ok and v_cpn2.geometry_changed and v_cpn2.checkpoint_verification = 'unverified' and v_cpn2.history_version = 3 and v_cpn2.gps_lat = -41.27080);
  v_ok := public.verify_boundary('patrol_checkpoint', v_cpn.id);
  select * into v_cpn2 from public.manage_patrol_checkpoint(gen_random_uuid(), 'update', v_provider, v_cpn.id, null, 'Gate A (north)', null, null, null, null, null);
  perform pg_temp.check('a rename keeps the verification and adds no version',
    v_ok and not v_cpn2.geometry_changed and v_cpn2.checkpoint_verification = 'verified' and v_cpn2.history_version = 4 and v_cpn2.name = 'Gate A (north)');
  perform pg_temp.as_admin();
  update public.patrol_checkpoints set radius_meters = 6 where id = v_cpn.id;
  perform pg_temp.check('a direct table edit of the geometry also resets verification (structural P2)',
    (select checkpoint_verification from public.patrol_checkpoints where id = v_cpn.id) = 'unverified'
    and (select checkpoint_verified_by from public.patrol_checkpoints where id = v_cpn.id) is null);
  begin
    update public.patrol_checkpoints set radius_meters = 0 where id = v_cpn.id;
    perform pg_temp.check('a zero radius is refused at the table', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a zero radius is refused at the table', v_err like '%between 1 and 500 metres%');
  end;
  insert into public.patrol_checkpoints (organization_id, client_site_id, name, gps_lat, gps_lng, radius_meters, checkpoint_verification, checkpoint_verified_by, checkpoint_verified_at)
    values (v_provider, v_site, 'T_SNEAKY', -41.27, 173.28, 5, 'verified', v_admin, now()) returning id into v_sneaky;
  perform pg_temp.check('nothing lands verified, whatever the writer claims', (select checkpoint_verification from public.patrol_checkpoints where id = v_sneaky) = 'unverified'
    and (select checkpoint_verified_by from public.patrol_checkpoints where id = v_sneaky) is null);
  perform pg_temp.as_user(v_stranger);
  begin
    perform public.manage_patrol_checkpoint(gen_random_uuid(), 'create', v_provider, null, v_site, 'X', null, -41.27, 173.28, null, null);
    perform pg_temp.check('a stranger cannot place checkpoints for another org', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a stranger cannot place checkpoints for another org', v_err like '%Organisation administrator required%');
  end;
  perform pg_temp.as_user(v_admin);
  begin
    perform public.manage_patrol_checkpoint(gen_random_uuid(), 'create', v_provider, null, v_stranger_site, 'X', null, -41.28, 173.30, null, null);
    perform pg_temp.check('a checkpoint cannot be placed at a site outside the caller''s reach', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a checkpoint cannot be placed at a site outside the caller''s reach', v_err like '%outside your reach%');
  end;
  begin
    perform public.manage_patrol_checkpoint(gen_random_uuid(), 'create', v_provider, null, v_site, 'X', null, null, null, null, null);
    perform pg_temp.check('a checkpoint needs a map position', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a checkpoint needs a map position', v_err like '%map position is required%');
  end;

  -- ── visits: presence is measured by the server from the recorded point; the client's claim is not the record (P1) ──
  perform pg_temp.as_user(v_officer);
  select * into v_visit from public.record_officer_checkpoint_visit(gen_random_uuid(), v_shift, v_cpn.id, -41.27077, 173.28402, 4.0, 1.0, true);
  perform pg_temp.as_admin();
  select * into v_pv from public.patrol_checkpoint_visits where id = v_visit.visit_id;
  perform pg_temp.check('a visit 3 m from the point is within the 6 m radius, distance measured by the server, unverified state recorded',
    v_visit.created and v_pv.gps_distance_from_checkpoint between 2.5 and 4.0 and v_pv.within_radius and v_pv.checkpoint_verification_at_visit = 'unverified');
  perform pg_temp.as_user(v_officer);
  select * into v_visit from public.record_officer_checkpoint_visit(gen_random_uuid(), v_shift, v_cpn.id, -41.27044, 173.28402, 4.0, 1.0, true);
  perform pg_temp.as_admin();
  select * into v_pv from public.patrol_checkpoint_visits where id = v_visit.visit_id;
  perform pg_temp.check('a client claiming within_radius from 40 m away is recorded as outside', v_pv.gps_distance_from_checkpoint between 35 and 45 and v_pv.within_radius = false);
  perform pg_temp.as_user(v_officer);
  select * into v_visit from public.record_officer_checkpoint_visit(gen_random_uuid(), v_shift, v_cp_nopoint, -41.2706, 173.2840, 4.0, 0.0, true);
  perform pg_temp.as_admin();
  select * into v_pv from public.patrol_checkpoint_visits where id = v_visit.visit_id;
  perform pg_temp.check('a checkpoint with no point yields no distance and no verdict, never a guess', v_pv.gps_distance_from_checkpoint is null and v_pv.within_radius is null);
  perform pg_temp.as_user(v_officer);
  select * into v_visit from public.record_officer_checkpoint_visit(gen_random_uuid(), v_shift, v_cp, -41.27061, 173.28401, 3.0, null, null);
  perform pg_temp.as_admin();
  select * into v_pv from public.patrol_checkpoint_visits where id = v_visit.visit_id;
  perform pg_temp.check('a visit at a verified checkpoint carries the verified state', v_pv.checkpoint_verification_at_visit = 'verified' and v_pv.within_radius);

  -- ── accept: the human's (edited) shape becomes the live boundary, unverified ──
  perform pg_temp.as_user(v_admin);
  select * into v_acc from public.accept_boundary_proposal(v_p2.proposal_id, pg_temp.square(173.28401, -41.27061, 34), false, 'Nudged to the fence line');
  perform pg_temp.check('accepted with a human edit recorded', v_acc.entity_type = 'client_site' and v_acc.entity_id = v_site and v_acc.human_edited and not v_acc.verified and v_acc.history_version = 1 and v_acc.area_m2 between 1100 and 1220);
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_site;
  perform pg_temp.check('live site boundary is the final polygon, authoritative provenance, still unverified',
    v_cs.boundary is not null and geometrytype(v_cs.boundary) = 'POLYGON' and v_cs.boundary_status = 'authoritative' and v_cs.boundary_verification = 'unverified' and v_cs.boundary_verified_by is null
    and st_area(v_cs.boundary::geography) between 1100 and 1220);
  select * into v_bp from public.boundary_proposals where id = v_p2.proposal_id;
  perform pg_temp.check('the proposal keeps what the source returned versus what the human saved',
    v_bp.status = 'accepted' and v_bp.human_edited and v_bp.decided_by = v_admin and v_bp.decision_note = 'Nudged to the fence line' and v_bp.final_boundary is not null and not st_equals(v_bp.final_boundary, v_bp.proposed_boundary) and v_bp.history_version = 1);
  select * into v_row from public.geofence_boundary_history where entity_type = 'client_site' and entity_id = v_site order by version desc limit 1;
  perform pg_temp.check('history records the edited shape as user_drawn, unverified, version 1', v_row.version = 1 and v_row.boundary_source = 'user_drawn' and v_row.verification_state = 'unverified' and v_row.changed_via = 'direct_edit');
  select count(*) into v_count from public.audit_log where action = 'boundary_proposal_accepted' and target_id = v_site;
  perform pg_temp.check('acceptance is audited', v_count = 1);
  begin
    perform pg_temp.as_user(v_admin);
    perform public.accept_boundary_proposal(v_p2.proposal_id, null, false, null);
    perform pg_temp.check('a decided proposal cannot be accepted twice', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a decided proposal cannot be accepted twice', v_err like '%already accepted%');
  end;

  -- ── verify: the map confirmation is a separate human act, recorded as such ──
  perform pg_temp.as_user(v_admin);
  v_ok := public.verify_boundary('client_site', v_site);
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_site;
  select count(*) into v_count from public.geofence_boundary_history where entity_type = 'client_site' and entity_id = v_site and verification_state = 'verified' and changed_via = 'verification' and version = 2;
  perform pg_temp.check('visual verification flips the state and writes version 2', v_ok and v_cs.boundary_verification = 'verified' and v_cs.boundary_verified_by = v_admin and v_count = 1);

  -- ── zones: multipolygon kept, accept + verify in one human act ────────────
  perform pg_temp.as_user(v_admin);
  select * into v_pz from public.propose_boundary(v_provider, 'location_zone', v_zone, pg_temp.square(173.30, -41.28, 120), 'council_gis', '{"layer":"fc_areas"}'::jsonb, null, null, 'batch');
  perform pg_temp.check('zone proposal inherits the zone type for its gate', v_pz.gate_ok and v_pz.area_m2 between 14000 and 14800);
  select * into v_accz from public.accept_boundary_proposal(v_pz.proposal_id, null, true, null);
  perform pg_temp.as_admin();
  select * into v_z from public.location_zones where id = v_zone;
  perform pg_temp.check('zone boundary live as multipolygon, verified in the same act, two history rows',
    v_accz.verified and not v_accz.human_edited and geometrytype(v_z.boundary) = 'MULTIPOLYGON' and v_z.boundary_verification = 'verified' and v_z.boundary_status = 'authoritative'
    and (select count(*) from public.geofence_boundary_history where entity_type = 'location_zone' and entity_id = v_zone) = 2);
  perform pg_temp.check('history keeps the source of an unedited acceptance', exists (select 1 from public.geofence_boundary_history where entity_type = 'location_zone' and entity_id = v_zone and boundary_source = 'council_gis' and version = 1));

  -- ── organisation jurisdiction is SENSITIVE: never through the workbench (Q5) ──
  perform pg_temp.as_user(v_admin);
  select * into v_porg from public.propose_boundary(v_provider, 'organization', v_provider, pg_temp.square(173.30, -41.28, 3000), 'nzta', '{}'::jsonb, null, null, 'workbench');
  begin
    perform public.accept_boundary_proposal(v_porg.proposal_id, null, false, null);
    perform pg_temp.check('an organisation jurisdiction cannot be accepted through the workbench (Q5)', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('an organisation jurisdiction cannot be accepted through the workbench (Q5)', v_err like '%cannot be accepted through the workbench%');
  end;
  perform pg_temp.as_admin();
  perform pg_temp.check('the jurisdiction stayed untouched', (select jurisdiction_geom from public.organizations where id = v_provider) is null);

  -- ── a site boundary must be one polygon ───────────────────────────────────
  perform pg_temp.as_user(v_admin);
  select * into v_pmulti from public.propose_boundary(v_council, 'client_site', v_site2,
    jsonb_build_object('type', 'MultiPolygon', 'coordinates', jsonb_build_array(
      (pg_temp.square(173.28436, -41.2706, 20))->'coordinates', (pg_temp.square(173.28480, -41.2706, 20))->'coordinates')),
    'user_drawn', '{}'::jsonb, null, null, 'workbench');
  begin
    perform public.accept_boundary_proposal(v_pmulti.proposal_id, null, false, null);
    perform pg_temp.check('a two-part shape is refused for a site', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a two-part shape is refused for a site', v_err like '%single polygon%');
  end;

  -- ── reject requires a reason and closes the proposal ──────────────────────
  begin
    perform public.reject_boundary_proposal(v_pmulti.proposal_id, '  ');
    perform pg_temp.check('a rejection needs a reason', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a rejection needs a reason', v_err like '%rejection reason is required%');
  end;
  perform pg_temp.check('rejection with a reason closes the proposal', public.reject_boundary_proposal(v_pmulti.proposal_id, 'Two lots; split the site'));
  perform pg_temp.as_admin();
  perform pg_temp.check('rejected proposal keeps the note and decider', exists (select 1 from public.boundary_proposals where id = v_pmulti.proposal_id and status = 'rejected' and decided_by = v_admin and decision_note = 'Two lots; split the site'));

  -- ── the review queue: sites and zones together, worst first, open proposal attached ──
  perform pg_temp.as_user(v_admin);
  select * into v_row from public.get_geofence_review_queue(null) q where q.entity_id = v_site2;
  perform pg_temp.check('a site with no polygon is top priority and carries no open proposal after rejection', v_row.boundary_state = 'missing' and v_row.priority >= 300 and v_row.open_proposal_id is null and v_row.active_agreements = 1);
  select * into v_row from public.get_geofence_review_queue(null) q where q.entity_id = v_site;
  perform pg_temp.check('a verified site ranks low and carries its geometry', v_row.boundary_state = 'verified' and v_row.priority < 100 and v_row.boundary_geojson is not null);
  select * into v_row from public.get_geofence_review_queue(v_provider) q where q.entity_id = v_zone;
  perform pg_temp.check('the queue is scoped by organisation and includes zones', v_row.entity_type = 'location_zone' and v_row.zone_type = 'freedom_camping' and v_row.boundary_state = 'verified');
  select count(*) into v_count from public.get_geofence_review_queue(null) q where q.entity_id in (v_site, v_site2, v_zone);
  perform pg_temp.check('the provider reaches its own zone and the client''s sites', v_count = 3);
  perform pg_temp.as_user(v_stranger);
  select count(*) into v_count from public.get_geofence_review_queue(null) q where q.entity_id in (v_site, v_site2, v_zone);
  perform pg_temp.check('a stranger''s queue holds none of them', v_count = 0);

  -- ── Q10 dedup: same key, or within 50 m ───────────────────────────────────
  perform pg_temp.as_user(v_admin);
  select * into v_row from public.find_existing_site_for_address(v_council, '12 Workbench St.', null, null) limit 1;
  perform pg_temp.check('an address matches by normalised key', v_row.site_id = v_site and v_row.match_reason = 'exact_address');
  select count(*) into v_count from public.find_existing_site_for_address(v_council, '99 Nowhere Rd', -41.2706, 173.2842);
  perform pg_temp.check('a nearby point finds the neighbouring sites within 50 m', v_count = 2);
  perform pg_temp.as_user(v_stranger);
  begin
    perform public.find_existing_site_for_address(v_council, '12 Workbench St', null, null);
    perform pg_temp.check('dedup lookup is org-access gated', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('dedup lookup is org-access gated', v_err like '%Organization access denied%');
  end;

  perform pg_temp.as_admin();
  raise notice '=== GEOFENCE WORKBENCH TRUTH TABLE COMPLETE ===';
end $$;
rollback;

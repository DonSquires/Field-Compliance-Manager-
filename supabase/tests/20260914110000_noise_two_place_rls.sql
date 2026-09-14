-- Behavioural truth table for the noise two-place model. Runs in a transaction and rolls back.
-- Real RLS: fixtures set up as postgres, reads/writes exercised as `authenticated` with a JWT sub.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.as_user(p_user uuid) returns void language plpgsql as $$
begin
  -- Both claim encodings: older images read request.jwt.claim.sub, newer read request.jwt.claims JSON.
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
  v_provider uuid := gen_random_uuid();   -- custodian (security contractor)
  v_council  uuid := gen_random_uuid();   -- client; owns the complainant's place
  v_landlord uuid := gen_random_uuid();   -- owns the SOURCE place only
  v_stranger_org uuid := gen_random_uuid();
  v_dispatcher uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_council_user uuid := gen_random_uuid();
  v_landlord_user uuid := gen_random_uuid();
  v_stranger uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_source_site uuid := gen_random_uuid();
  v_complainant_site uuid := gen_random_uuid();
  v_shift uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_resource uuid := gen_random_uuid();
  v_job2 uuid := gen_random_uuid();
  v_job3 uuid := gen_random_uuid();
  v_stranger_site uuid := gen_random_uuid();
  v_provider_admin uuid := gen_random_uuid();
  v_arrive record; v_arrive2 record; v_depart record; v_submit record; v_inter record; v_part record;
  v_hp record; v_hp2 record; v_hp3 record; v_hp4 record; v_arrive3 record; v_intake record; v_cs public.client_sites%rowtype;
  v_report jsonb; v_party jsonb; v_na public.noise_assessments%rowtype;
  v_count int; v_err text;
begin
  -- ── fixtures ──────────────────────────────────────────────────────────────
  insert into public.organizations (id, name, organization_type) values
    (v_provider, 'T_PROVIDER', 'service_provider'), (v_council, 'T_COUNCIL', 'government'),
    (v_landlord, 'T_LANDLORD', 'private_enterprise'), (v_stranger_org, 'T_STRANGER', 'private_enterprise');
  insert into public.user_profiles (id, organization_id, role, display_name) values
    (v_dispatcher, v_provider, 'admin_officer', 'Dispatcher'), (v_officer, v_provider, 'officer', 'Officer'),
    (v_council_user, v_council, 'admin', 'CouncilUser'), (v_landlord_user, v_landlord, 'admin', 'LandlordUser'),
    (v_stranger, v_stranger_org, 'admin', 'Stranger'), (v_provider_admin, v_provider, 'admin', 'ProviderAdmin');
  insert into public.service_agreements (id, provider_organization_id, client_organization_id, name, starts_on, agreement_type, invitation_status)
    values (v_agreement, v_provider, v_council, 'Noise after-hours', current_date - 30, 'operational', 'accepted');
  -- Source place (landlord-owned), verified 20 m boundary; complainant place (council-owned) ~120 m away, verified.
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary, boundary_verification, onsite_radius_meters, prompt_radius_meters, active)
    values (v_source_site, v_landlord, v_provider, 'T_SOURCE', '47 Example St', st_setsrid(st_makepoint(173.2840, -41.2706), 4326),
            st_buffer(st_setsrid(st_makepoint(173.2840, -41.2706), 4326)::geography, 20)::geometry, 'verified', 10, 50, true);
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary, boundary_verification, onsite_radius_meters, prompt_radius_meters, active)
    values (v_complainant_site, v_council, v_provider, 'T_COMPLAINANT', '49 Example St', st_setsrid(st_makepoint(173.2854, -41.2706), 4326),
            st_buffer(st_setsrid(st_makepoint(173.2854, -41.2706), 4326)::geography, 15)::geometry, 'verified', 10, 50, true);
  insert into public.service_agreement_locations (service_agreement_id, site_id, status) values (v_agreement, v_source_site, 'active'), (v_agreement, v_complainant_site, 'active') on conflict do nothing;
  insert into public.shifts (id, organization_id, officer_user_id, service_type, scheduled_start, scheduled_end, actual_start, status)
    values (v_shift, v_provider, v_officer, 'noise_control', now() - interval '2 hours', now() + interval '6 hours', now() - interval '2 hours', 'in_progress');
  insert into public.dispatch_resources (id, organization_id, name, callsign, service_type, assigned_officer_id, status)
    values (v_resource, v_provider, 'Unit 1', 'Alpha 1', 'noise_control', v_officer, 'available');
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, dispatch_resource_id, client_site_id, job_type, priority, status, sla_minutes, sla_respond_by, created_at, dispatched_at, module_key, assigned_officer_id, shift_id)
    values (v_job, v_provider, v_agreement, v_resource, v_source_site, 'noise_control', 'high', 'dispatched', 60, now() - interval '5 minutes', now() - interval '70 minutes', now() - interval '65 minutes', 'noise_control', v_officer, v_shift);

  -- ── dispatcher records the complainant place and protected identity ──────
  perform pg_temp.as_user(v_dispatcher);
  perform public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job, v_complainant_site, '49 Example St', 'complainant', 'A Complainant', '021 000 0000', null, 'Prefers not to be visited');
  perform pg_temp.as_admin();
  select count(*) into v_count from public.dispatch_jobs where id = v_job and harmed_party_site_id = v_complainant_site;
  perform pg_temp.check('job carries the harmed-party place', v_count = 1);

  -- protected identity is unreadable directly, even by the custodian officer
  perform pg_temp.as_user(v_officer);
  begin
    select count(*) into v_count from public.dispatch_job_protected_parties;
    perform pg_temp.check('protected parties table is not directly readable', false);
  exception when insufficient_privilege then
    perform pg_temp.check('protected parties table is not directly readable', true);
  end;
  -- ...but the attending officer can read it through the guarded, audited RPC while the job is live
  v_party := public.get_dispatch_job_protected_party(v_job, 'complainant');
  perform pg_temp.check('attending officer reads complainant via guarded RPC', (v_party->>'available')::boolean and v_party->>'basis' = 'attending_officer' and v_party->>'display_name' = 'A Complainant');
  -- ...and the landlord (source-side owner) cannot
  perform pg_temp.as_user(v_landlord_user);
  v_party := public.get_dispatch_job_protected_party(v_job, 'complainant');
  perform pg_temp.check('source-side owner gets no basis for complainant identity', not (v_party->>'available')::boolean and v_party->>'reason' = 'no_basis');
  perform pg_temp.as_admin();
  select count(*) into v_count from public.audit_log where action = 'protected_party_read' and target_table = 'dispatch_job_protected_parties';
  perform pg_temp.check('every protected read is audited (IPP 6)', v_count = 1);

  -- ── officer arrives at the source, 8 m from the boundary (verified_on_site) ──
  perform pg_temp.as_user(v_officer);
  select * into v_arrive from public.arrive_at_dispatch_place(gen_random_uuid(), v_job, 'work_place', -41.2706, 173.28433, 4.0, 'BWC-0007');
  perform pg_temp.check('source arrival verified_on_site', v_arrive.arrival_verification = 'verified_on_site' and v_arrive.arrival_distance_m < 15 and v_arrive.visit_number = 1);
  -- replay with the same client_request_id is idempotent (no second stop)
  perform pg_temp.as_admin();
  select count(*) into v_count from public.shift_stops where dispatch_job_id = v_job;
  perform pg_temp.check('one stop created for the source visit', v_count = 1);
  select count(*) into v_count from public.dispatch_jobs where id = v_job and status = 'on_scene' and on_scene_at is not null and sla_breached = true;
  perform pg_temp.check('job moved on_scene with SLA breach recorded (arrived after sla_respond_by)', v_count = 1);

  -- ── officer assesses ~30 m from the complainant boundary; END issued ─────────
  perform pg_temp.as_user(v_officer);
  select * into v_submit from public.submit_officer_noise_assessment(
    gen_random_uuid(), now(), 'stereo_music', '47 Example St', 'direction_notice', 3::smallint, 3::smallint, 2::smallint,
    null, null, null, 'END-2026-0042', null, null, false, false, false, 'Loud bass audible at street', null, false, v_shift, v_job, -41.2706, 173.2850);
  perform pg_temp.as_admin();
  select * into v_na from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('assessment derives source site from the job (rule #157)', v_na.site_id = v_source_site);
  perform pg_temp.check('assessment derives complainant place + address from the job', v_na.complainant_site_id = v_complainant_site and v_na.complaint_address = '49 Example St');
  perform pg_temp.check('complainant_protected forced true', v_na.complainant_protected = true);
  perform pg_temp.check('assessment linked to the source stop', v_na.source_stop_id = v_arrive.stop_id and v_na.complainant_stop_id is null);
  perform pg_temp.check('distances measured to complainant and source', v_na.assessment_distance_to_complainant_m between 10 and 60 and v_na.assessment_distance_to_source_m between 50 and 120);
  perform pg_temp.check('END expires 8 days after assessment (RMA s327(3), 2025 amendment)', v_na.end_expires_at = v_na.assessed_at + interval '192 hours');

  -- statutory preconditions
  perform pg_temp.as_user(v_officer);
  begin
    perform public.submit_officer_noise_assessment(gen_random_uuid(), now(), 'party', '12 Other St', 'direction_notice', 3::smallint, 3::smallint, 1::smallint,
      null, null, null, 'END-X', null, null, false, false, false, 'no complaint', null, false, v_shift, null, null, null);
    perform pg_temp.check('END without a complaint is refused', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('END without a complaint is refused', v_err like '%requires a linked complaint%');
  end;
  begin
    perform public.submit_officer_noise_assessment(gen_random_uuid(), now(), 'party', '47 Example St', 'equipment_seized', 4::smallint, 4::smallint, 2::smallint,
      null, null, 'SEZ-1', null, null, null, false, true, false, 'seizure without police', null, false, v_shift, v_job, null, null);
    perform pg_temp.check('seizure without Police present is refused (s328(3))', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('seizure without Police present is refused (s328(3))', v_err like '%Police present%');
  end;

  -- ── officer speaks to the complainant in person: arrival at the harmed-party place + interaction ──
  select * into v_arrive2 from public.arrive_at_dispatch_place(gen_random_uuid(), v_job, 'harmed_party_place', -41.2706, 173.2853, 6.0, null);
  perform pg_temp.check('complainant-place arrival verified (inside/at boundary)', v_arrive2.arrival_verification in ('verified_on_site', 'near_site') and v_arrive2.stop_id <> v_arrive.stop_id);
  select * into v_inter from public.record_job_party_interaction(gen_random_uuid(), v_job, 'complainant', 'in_person', now(), 'Confirmed noise now reduced; complainant satisfied', v_submit.id, v_arrive2.stop_id, -41.2706, 173.2853, 6.0);
  perform pg_temp.check('complainant interaction recorded and linked', v_inter.created and v_inter.id is not null);
  -- departure from the source without a delay reason is refused because the SLA was breached
  begin
    perform public.depart_dispatch_place(gen_random_uuid(), v_arrive.stop_id, 'Music turned down on arrival', -41.2706, 173.2843, null);
    perform pg_temp.check('SLA-breached departure requires a delay reason', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('SLA-breached departure requires a delay reason', v_err like '%delay reason is required%');
  end;
  select * into v_depart from public.depart_dispatch_place(gen_random_uuid(), v_arrive.stop_id, 'Music turned down on arrival', -41.2706, 173.2843, 'Held at prior job; dispatcher advised');
  perform pg_temp.check('source departure recorded with breached sla_status', v_depart.sla_status = 'breached' and v_depart.departed_at is not null);
  perform public.depart_dispatch_place(gen_random_uuid(), v_arrive2.stop_id, null, null, null, null);

  -- ── the report: exactly what happened, disclosed by basis ─────────────────
  -- custodian dispatcher sees everything except identity (which is RPC-only)
  perform pg_temp.as_user(v_dispatcher);
  v_report := public.get_noise_attendance_report(v_job);
  perform pg_temp.check('custodian report available with both attendances', (v_report->>'available')::boolean and jsonb_array_length(v_report->'attendances') = 2);
  perform pg_temp.check('custodian sees complainant place and delay reason', v_report->'job'->>'harmed_party_address' = '49 Example St' and v_report->'job'->>'sla_delay_reason' is not null);
  perform pg_temp.check('custodian sees the interaction summary', (v_report->'interactions'->0->>'summary') is not null);
  perform pg_temp.check('report never carries complainant identity', v_report::text not like '%A Complainant%' and v_report::text not like '%021 000 0000%');
  -- council (owns the complainant place) sees the complainant place but not identity or officer narrative
  perform pg_temp.as_user(v_council_user);
  v_report := public.get_noise_attendance_report(v_job);
  perform pg_temp.check('harmed-party owner (council) sees complainant place', (v_report->>'available')::boolean and v_report->'job'->>'harmed_party_address' = '49 Example St');
  perform pg_temp.check('harmed-party owner sees no interaction summary and no identity', (v_report->'interactions'->0->>'summary') is null and v_report::text not like '%A Complainant%');
  -- landlord (owns the source only) sees the attendance and action, complainant redacted
  perform pg_temp.as_user(v_landlord_user);
  v_report := public.get_noise_attendance_report(v_job);
  perform pg_temp.check('source-side owner sees the report with complainant redacted', (v_report->>'available')::boolean
    and v_report->'job'->>'harmed_party_address' is null and (v_report->'assessments'->0->>'complaint_address') is null
    and (v_report->'attendances'->1->>'site_id') is null and (v_report->'assessments'->0->>'end_number') = 'END-2026-0042');
  -- stranger gets nothing
  perform pg_temp.as_user(v_stranger);
  v_report := public.get_noise_attendance_report(v_job);
  perform pg_temp.check('unrelated org gets no basis', not (v_report->>'available')::boolean);

  -- ── W1 harmed-party read on the assessment row itself ─────────────────────
  perform pg_temp.as_user(v_council_user);
  select count(*) into v_count from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('W1: complainant place owner can read the assessment row', v_count = 1);
  perform pg_temp.as_user(v_landlord_user);
  select count(*) into v_count from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('W1: source-side owner cannot read the assessment row', v_count = 0);
  perform pg_temp.as_user(v_stranger);
  select count(*) into v_count from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('W1: stranger cannot read the assessment row', v_count = 0);
  perform pg_temp.as_user(v_officer);
  select count(*) into v_count from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('custody: recording officer org still reads its row', v_count = 1);
  -- interactions: officer sees own; council sees none directly
  select count(*) into v_count from public.job_party_interactions where dispatch_job_id = v_job;
  perform pg_temp.check('officer reads own interaction row', v_count = 1);
  perform pg_temp.as_user(v_council_user);
  select count(*) into v_count from public.job_party_interactions where dispatch_job_id = v_job;
  perform pg_temp.check('client cannot read interaction rows directly', v_count = 0);

  -- ── direction particulars (20260914120000): s327(2) form, s327(3) shorter period, s328(5) notice ──
  perform pg_temp.as_user(v_officer);
  select * into v_part from public.record_noise_direction_particulars(gen_random_uuid(), v_submit.id, false, 'occupier', 48::smallint, null);
  perform pg_temp.check('direction particulars receipt returned', v_part.assessment_id = v_submit.id and v_part.end_recipient_role = 'occupier');
  perform pg_temp.as_admin();
  select * into v_na from public.noise_assessments where id = v_submit.id;
  perform pg_temp.check('written direction to the occupier recorded', v_na.end_given_orally = false and v_na.end_recipient_role = 'occupier');
  perform pg_temp.check('expiry is assessed_at + 48 h after the officer specified 48 h', v_na.end_expires_at = v_na.assessed_at + interval '48 hours');
  perform pg_temp.as_user(v_officer);
  begin
    perform public.record_noise_direction_particulars(gen_random_uuid(), v_submit.id, false, 'occupier', 200::smallint, null);
    perform pg_temp.check('a period beyond the council rule / statute is refused', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a period beyond the council rule / statute is refused', v_err like '%between 1 and 192 hours%');
  end;
  begin
    perform public.record_noise_direction_particulars(gen_random_uuid(), v_submit.id, false, 'unoccupied_notice_left', null, false);
    perform pg_temp.check('unoccupied entry without the notice left is refused (s328(5))', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('unoccupied entry without the notice left is refused (s328(5))', v_err like '%RMA s328(5)%');
  end;
  begin
    perform public.record_noise_direction_particulars(gen_random_uuid(), v_submit.id, true, 'unoccupied_notice_left', null, true);
    perform pg_temp.check('an oral direction cannot be the one left at an unoccupied place', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('an oral direction cannot be the one left at an unoccupied place', v_err like '%must be written%');
  end;
  perform pg_temp.as_user(v_council_user);
  begin
    perform public.record_noise_direction_particulars(gen_random_uuid(), v_submit.id, false, 'occupier', null, null);
    perform pg_temp.check('a reader outside the custodian org cannot record particulars', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a reader outside the custodian org cannot record particulars', v_err like '%not found in the officer organisation%' or v_err like '%Active officer profile required%');
  end;

  -- ── dispatch place site-entry (20260914130000): an address-only complainant place becomes a provisional site ──
  perform pg_temp.as_admin();
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, dispatch_resource_id, client_site_id, job_type, priority, status, sla_minutes, sla_respond_by, created_at, dispatched_at, module_key, assigned_officer_id, shift_id)
    values (v_job2, v_provider, v_agreement, v_resource, v_source_site, 'noise_control', 'high', 'dispatched', 60, now() + interval '55 minutes', now() - interval '5 minutes', now() - interval '4 minutes', 'noise_control', v_officer, v_shift);
  insert into public.dispatch_jobs (id, organization_id, service_agreement_id, client_site_id, job_type, priority, status, sla_minutes, sla_respond_by, module_key)
    values (v_job3, v_provider, v_agreement, v_source_site, 'noise_control', 'normal', 'pending', 60, now() + interval '60 minutes', 'noise_control');
  perform pg_temp.as_user(v_dispatcher);
  select * into v_hp from public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job2, null, '51 Example St', 'complainant', 'B Complainant', null, null, null, -41.2706, 173.2860);
  perform pg_temp.check('address-only complainant place becomes a site on the job', v_hp.out_harmed_party_site_id is not null and v_hp.place_created and v_hp.house_action = 'created_house');
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_hp.out_harmed_party_site_id;
  perform pg_temp.check('the complainant site is a provisional adhoc facet of the client org with a house',
    v_cs.client_organization_id = v_council and v_cs.organization_id = v_provider and v_cs.site_origin = 'adhoc' and v_cs.boundary_status = 'provisional'
    and v_cs.boundary_verification = 'unverified' and v_cs.address_match_key = '51examplest' and v_cs.location_id is not null and v_cs.ownership_status = 'resolved');
  perform pg_temp.check('the house belongs to the client org with the same key', exists (select 1 from public.locations h where h.id = v_cs.location_id and h.organization_id = v_council and h.address_match_key = '51examplest'));
  perform pg_temp.check('the centre is the resolved coordinate', st_distance(v_cs.center_point::geography, st_setsrid(st_makepoint(173.2860, -41.2706), 4326)::geography) < 1);
  perform pg_temp.check('the complainant place is attached to the client agreement by the platform autolink, marked adhoc', exists (select 1 from public.service_agreement_locations l where l.site_id = v_cs.id and l.service_agreement_id = v_agreement) and v_cs.site_origin = 'adhoc');
  perform pg_temp.check('the job keeps the address as received', exists (select 1 from public.dispatch_jobs d where d.id = v_job2 and d.harmed_party_address = '51 Example St' and d.harmed_party_site_id = v_cs.id));
  -- same address, different spelling: the same site and house, no fork
  perform pg_temp.as_user(v_dispatcher);
  select * into v_hp2 from public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job2, null, '51 example st.', 'complainant', null, null, null, null, -41.27061, 173.28601);
  perform pg_temp.check('the same address resolves to the same site (no fork)', v_hp2.out_harmed_party_site_id = v_hp.out_harmed_party_site_id and not v_hp2.place_created and v_hp2.house_action = 'existing_house');
  perform pg_temp.as_admin();
  select count(*) into v_count from public.locations where organization_id = v_council and address_match_key = '51examplest';
  perform pg_temp.check('one house per address per owner', v_count = 1);
  -- arrival at the complainant place is measured against the provisional centre, not "no geofence"
  perform pg_temp.as_user(v_officer);
  select * into v_arrive3 from public.arrive_at_dispatch_place(gen_random_uuid(), v_job2, 'harmed_party_place', -41.2706, 173.2861, 5.0, null);
  perform pg_temp.check('arrival at a provisional complainant place is unverified_boundary with a distance', v_arrive3.arrival_verification = 'unverified_boundary' and v_arrive3.arrival_distance_m is not null and v_arrive3.arrival_distance_m < 20);
  -- a site owned by an unrelated org cannot be the harmed-party place (it would hand that org the W1 read)
  perform pg_temp.as_admin();
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_stranger_site, v_stranger_org, v_provider, 'T_STRANGER_SITE', '99 Elsewhere Rd', st_setsrid(st_makepoint(173.30, -41.28), 4326), 'unverified', true);
  perform pg_temp.as_user(v_dispatcher);
  begin
    perform public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job2, v_stranger_site, null, 'complainant', null, null, null, null, null, null);
    perform pg_temp.check('a stranger-org site cannot be the harmed-party place', false);
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform pg_temp.check('a stranger-org site cannot be the harmed-party place', v_err like '%client or custodian organisation%');
  end;
  -- a house already held by another org at that address: facet created without a house and flagged for review
  perform pg_temp.as_admin();
  insert into public.locations (organization_id, name, address, address_match_key) values (v_stranger_org, 'T_OTHER_HOUSE', '53 Example St', '53examplest');
  perform pg_temp.as_user(v_dispatcher);
  select * into v_hp3 from public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job2, null, '53 Example St', 'complainant', null, null, null, null, -41.2706, 173.2870);
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_hp3.out_harmed_party_site_id;
  perform pg_temp.check('a house under another org is neither reused nor forked: facet flagged needs_review',
    v_hp3.house_action = 'other_org_house' and v_cs.location_id is null and v_cs.ownership_status = 'needs_review' and v_cs.ownership_signals->>'house_conflict' = 'other_org_house');
  select count(*) into v_count from public.locations where address_match_key = '53examplest';
  perform pg_temp.check('no second house was created for the conflicted address', v_count = 1);
  -- an address without coordinates stays text on the job; no site is invented
  perform pg_temp.as_user(v_dispatcher);
  select * into v_hp4 from public.set_dispatch_job_harmed_party(gen_random_uuid(), v_job3, null, '55 Example St', 'complainant', null, null, null, null, null, null);
  perform pg_temp.check('an unresolved address stays text-only (no site invented)', v_hp4.out_harmed_party_site_id is null and not v_hp4.place_created and v_hp4.house_action is null);
  -- the work-place intake rides the same pipeline: provisional site with a house, attached to the agreement
  perform pg_temp.as_user(v_provider_admin);
  select * into v_intake from public.create_dispatch_intake_job(v_provider, v_agreement, gen_random_uuid(), 'noise_control', 'high', 60, '57 Example St', '57 Example St', -41.2706, 173.2880, null, null, null);
  perform pg_temp.as_admin();
  select * into v_cs from public.client_sites where id = v_intake.client_site_id;
  perform pg_temp.check('intake creates the work place as a provisional site with a house, attached to the agreement',
    v_intake.created and v_cs.client_organization_id = v_council and v_cs.location_id is not null and v_cs.site_origin = 'adhoc' and v_cs.boundary_status = 'provisional'
    and exists (select 1 from public.service_agreement_locations l where l.service_agreement_id = v_agreement and l.site_id = v_cs.id and l.status = 'active'));
  select count(*) into v_count from public.audit_log where action in ('dispatch_place_site_created', 'dispatch_place_house_created');
  perform pg_temp.check('every created place and house is audited', v_count = 5);

  perform pg_temp.as_admin();
  raise notice '=== NOISE TWO-PLACE TRUTH TABLE COMPLETE ===';
end $$;
rollback;

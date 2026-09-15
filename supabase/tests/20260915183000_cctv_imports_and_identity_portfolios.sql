-- Behavioural truth table for CCTV imports and identity portfolios. Runs in a transaction and rolls back.
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
end $$;
create or replace function pg_temp.as_admin() returns void language plpgsql as $$
begin set local role postgres; end $$;
create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;
-- Deterministic unit embeddings: a base direction plus a small perturbation, so cosine similarity is controllable.
create or replace function pg_temp.emb(p_dims int, p_seed int, p_noise real) returns jsonb language sql as $$
  select jsonb_agg(round((case when i = p_seed then 1.0 else 0.0 end + p_noise * sin(i * 0.37 + p_seed))::numeric, 6) order by i)
  from generate_series(1, p_dims) i
$$;

do $$
declare
  v_org uuid := gen_random_uuid(); v_other uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid(); v_stranger uuid := gen_random_uuid();
  v_house uuid; v_site uuid := gen_random_uuid(); v_zone uuid := gen_random_uuid(); v_other_house uuid;
  v_import public.cctv_imports%rowtype; v_reg jsonb; v_reg2 jsonb; v_job uuid; v_evidence uuid;
  v_n int; v_ok boolean; v_err text; v_row public.cctv_entity_observations%rowtype; v_row2 public.cctv_entity_observations%rowtype;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_v1 uuid; v_v2 uuid; v_a1 uuid; v_person uuid; v_vehicle uuid; v_key uuid;
begin
  insert into public.organizations (id, name, organization_type) values (v_org, 'T_CCTV_ORG', 'service_provider'), (v_other, 'T_CCTV_OTHER', 'client');
  insert into public.user_profiles (id, organization_id, role, display_name) values (v_admin, v_org, 'admin', 'CctvAdmin'), (v_stranger, v_other, 'admin', 'Stranger');
  insert into public.client_sites (id, client_organization_id, organization_id, name, address, center_point, boundary_verification, active)
    values (v_site, v_org, v_org, 'T_FOREST_GATE', '1 Forest Road', st_setsrid(st_makepoint(173.1, -41.4), 4326), 'verified', true);
  select location_id into v_house from public.client_sites where id = v_site;
  insert into public.location_zones (id, organization_id, location_id, name, zone_type, module_key, is_active, boundary_verification)
    values (v_zone, v_org, v_house, 'T_FOREST_BLOCK', 'biosecurity', 'biosecurity', true, 'unverified');
  insert into public.locations (organization_id, name, address) values (v_other, 'T_OTHER_HOUSE', '9 Other St') returning id into v_other_house;

  -- ── import: place first ──
  perform pg_temp.as_user(v_admin);
  begin
    perform public.create_cctv_import(v_org, v_other_house, 'Gate cam');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('import refused at a house the user cannot reach: ' || coalesce(v_err, ''), v_ok);
  begin
    perform public.create_cctv_import(v_org, v_house, 'Gate cam', p_source_timezone => 'Mars/Olympus');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('unknown time zone refused', v_ok and v_err like 'Unknown time zone%');
  begin
    perform public.create_cctv_import(v_org, v_other_house, 'Gate cam', p_site_id => v_site);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform pg_temp.check('facet must belong to the chosen house', v_ok);
  v_import := public.create_cctv_import(v_org, v_house, '  Gate Cam #1 ', p_site_id => v_site, p_zone_id => v_zone, p_source_device_kind => 'tapo',
                                        p_source_root_label => 'E:\', p_watermark_location_hint => 'FOREST GATE');
  perform pg_temp.check('import anchored to the registry place', v_import.canonical_place_id = (select canonical_place_id from public.locations where id = v_house));
  perform pg_temp.check('camera key derived from house + label', v_import.camera_key = left(v_house::text, 8) || ':gate-cam-1' and v_import.camera_label = 'Gate Cam #1');
  perform pg_temp.check('import visible to its organisation', exists (select 1 from public.cctv_imports where id = v_import.id));

  -- manifest drives the counts and the recorded window
  v_import := public.set_cctv_import_manifest(v_import.id, jsonb_build_array(
    jsonb_build_object('name', '20260910_081500_tp00001.mp4', 'kind', 'video', 'size_bytes', 268435456, 'slot_start_at', '2026-09-10T08:15:00+12:00', 'slot_end_at', '2026-09-10T08:45:00+12:00'),
    jsonb_build_object('name', '20260910_084500_tp00002.mp4', 'kind', 'video', 'size_bytes', 268435456, 'slot_start_at', '2026-09-10T08:45:00+12:00', 'slot_end_at', '2026-09-10T09:15:00+12:00'),
    jsonb_build_object('name', 'xxxxxxxx_000000_tp00003.mp4', 'kind', 'skipped_empty', 'size_bytes', 268435456, 'skip_reason', 'pre-allocated ring slot, no ftyp'),
    jsonb_build_object('name', 'snapshot/20260910/08/1757455000_1757455012_01.jpg', 'kind', 'snapshot', 'size_bytes', 40000)
  ), 'uploading');
  perform pg_temp.check('manifest counts derived', v_import.video_count = 2 and v_import.skipped_count = 1 and v_import.snapshot_count = 1 and v_import.bytes_total = 268435456 * 2 + 40000);
  perform pg_temp.check('recorded window from video slots', v_import.recorded_from = '2026-09-10T08:15:00+12:00'::timestamptz and v_import.recorded_to = '2026-09-10T09:15:00+12:00'::timestamptz and v_import.status = 'uploading');

  -- video registration: evidence + queued job, idempotent, path guarded
  begin
    perform public.register_cctv_import_video(v_import.id, 'org/' || v_other::text || '/cctv/x/file.mp4', 'file.mp4', 10);
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('video path must be under the import folder', v_ok and v_err like 'Video must be stored under%');
  v_reg := public.register_cctv_import_video(v_import.id, 'org/' || v_org::text || '/cctv/' || v_import.id::text || '/20260910_081500_tp00001.mp4',
             '20260910_081500_tp00001.mp4', 268435456, 'abc123', '2026-09-10T08:15:00+12:00', '2026-09-10T08:45:00+12:00', '20260910_081500_tp00001.mp4');
  v_evidence := (v_reg->>'evidence_item_id')::uuid; v_job := (v_reg->>'inference_job_id')::uuid;
  perform pg_temp.check('registration creates evidence in cctv_review', exists (select 1 from public.evidence_items e where e.id = v_evidence and e.module_key = 'cctv_review' and e.evidence_kind = 'video' and e.cctv_import_id = v_import.id and e.organization_id = v_org));
  perform pg_temp.check('registration queues a video_motion job', exists (select 1 from public.inference_jobs j where j.id = v_job and j.domain = 'video_motion' and j.status = 'queued'));
  v_reg2 := public.register_cctv_import_video(v_import.id, 'org/' || v_org::text || '/cctv/' || v_import.id::text || '/20260910_081500_tp00001.mp4',
             '20260910_081500_tp00001.mp4', 268435456, 'abc123', '2026-09-10T08:15:00+12:00', '2026-09-10T08:45:00+12:00', '20260910_081500_tp00001.mp4');
  perform pg_temp.check('re-registering the same file is idempotent', v_reg2->>'evidence_item_id' = v_reg->>'evidence_item_id' and v_reg2->>'inference_job_id' = v_reg->>'inference_job_id');
  perform pg_temp.check('import moves to registered', (select status from public.cctv_imports where id = v_import.id) = 'registered');

  -- device timeline from snapshot filenames
  v_n := public.record_cctv_device_events(v_import.id, jsonb_build_array(
    jsonb_build_object('source', 'device_snapshot', 'source_ref', '1757455000_1757455012_01.jpg', 'event_start_at', to_timestamp(1757455000), 'event_end_at', to_timestamp(1757455012)),
    jsonb_build_object('source', 'device_snapshot', 'source_ref', '1757455000_1757455012_01.jpg', 'event_start_at', to_timestamp(1757455000)),
    jsonb_build_object('source', 'device_snapshot', 'source_ref', 'bad', 'event_start_at', '')));
  perform pg_temp.check('device events deduped and validated', v_n = 1 and (select count(*) from public.cctv_device_events where cctv_import_id = v_import.id) = 1);

  -- ── worker writes observations; place inherited; portfolio clusters by similarity ──
  perform pg_temp.as_service();
  v_n := public.record_cctv_entity_observations(v_job, v_evidence, v_org, jsonb_build_array(
    jsonb_build_object('source_event_id', 'p-1', 'entity_kind', 'person', 'observed_at', '2026-09-10T08:20:00+12:00', 'observed_to', '2026-09-10T08:20:30+12:00',
                       'candidate_embedding', pg_temp.emb(128, 3, 0.02), 'appearance_embedding', pg_temp.emb(256, 7, 0.02), 'model_confidence', 0.91, 'quality_state', 'clear',
                       'attributes', jsonb_build_object('track_id', 't1', 'bbox', jsonb_build_array(10, 10, 80, 200))),
    jsonb_build_object('source_event_id', 'p-2', 'entity_kind', 'person', 'observed_at', '2026-09-10T08:30:00+12:00',
                       'candidate_embedding', pg_temp.emb(128, 3, 0.05), 'appearance_embedding', pg_temp.emb(256, 7, 0.05), 'model_confidence', 0.88),
    jsonb_build_object('source_event_id', 'p-3', 'entity_kind', 'person', 'observed_at', '2026-09-10T08:40:00+12:00',
                       'candidate_embedding', pg_temp.emb(128, 60, 0.02), 'model_confidence', 0.80, 'quality_state', 'flare'),
    jsonb_build_object('source_event_id', 'v-1', 'entity_kind', 'vehicle', 'observed_at', '2026-09-10T08:25:00+12:00',
                       'candidate_plate', 'abc 123', 'appearance_embedding', pg_temp.emb(256, 20, 0.02), 'model_confidence', 0.9,
                       'attributes', jsonb_build_object('make', 'Toyota', 'model', 'Hilux', 'colour', 'white', 'plate_confidence', 0.93)),
    jsonb_build_object('source_event_id', 'v-2', 'entity_kind', 'vehicle', 'observed_at', '2026-09-10T08:55:00+12:00',
                       'appearance_embedding', pg_temp.emb(256, 20, 0.04), 'model_confidence', 0.7, 'quality_state', 'degraded',
                       'attributes', jsonb_build_object('make', 'Toyota', 'colour', 'white')),
    jsonb_build_object('source_event_id', 'a-1', 'entity_kind', 'animal', 'observed_at', '2026-09-10T08:50:00+12:00',
                       'animal_type', 'Possum', 'species_confidence', 0.86, 'is_pest', true, 'model_confidence', 0.86),
    jsonb_build_object('source_event_id', 'junk', 'entity_kind', 'thing', 'observed_at', '2026-09-10T08:50:00+12:00')));
  perform pg_temp.check('six observations saved, unknown kind skipped', v_n = 6);
  select id into v_p1 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'p-1';
  select id into v_p2 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'p-2';
  select id into v_p3 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'p-3';
  select id into v_v1 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'v-1';
  select id into v_v2 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'v-2';
  select id into v_a1 from public.cctv_entity_observations where inference_job_id = v_job and source_event_id = 'a-1';
  select * into v_row from public.cctv_entity_observations where id = v_p1;
  perform pg_temp.check('observation inherits the import place', v_row.cctv_import_id = v_import.id and v_row.location_id = v_house and v_row.canonical_place_id = v_import.canonical_place_id and v_row.site_id = v_site and v_row.zone_id = v_zone);
  perform pg_temp.check('face and appearance vectors stored', v_row.face_vec is not null and v_row.appearance_vec is not null and v_row.portfolio_key is not null);
  perform pg_temp.check('first sighting starts a new portfolio', v_row.portfolio_state = 'unmatched' and jsonb_array_length(v_row.portfolio_candidates) = 0);
  select * into v_row2 from public.cctv_entity_observations where id = v_p2;
  perform pg_temp.check('similar face joins the same portfolio', v_row2.portfolio_key = v_row.portfolio_key and v_row2.portfolio_state = 'candidate' and jsonb_array_length(v_row2.portfolio_candidates) >= 1);
  perform pg_temp.check('different face starts its own portfolio', (select portfolio_key from public.cctv_entity_observations where id = v_p3) <> v_row.portfolio_key);
  perform pg_temp.check('quality state recorded', (select quality_state from public.cctv_entity_observations where id = v_p3) = 'flare');
  select * into v_row from public.cctv_entity_observations where id = v_v1;
  perform pg_temp.check('plate normalised, attributes kept, no identity from a model alone', v_row.candidate_plate = 'ABC123' and v_row.attributes->>'make' = 'Toyota' and v_row.canonical_vehicle_id is null and v_row.review_state = 'unreviewed');
  perform pg_temp.check('plate-less vehicle joins the portfolio by appearance', (select portfolio_key from public.cctv_entity_observations where id = v_v2) = v_row.portfolio_key);
  perform pg_temp.check('species recorded as a pest', (select animal_type = 'possum' and is_pest and species_confidence = 0.86::real from public.cctv_entity_observations where id = v_a1));

  -- re-run refreshes model fields on unreviewed rows only, never duplicates
  v_n := public.record_cctv_entity_observations(v_job, v_evidence, v_org, jsonb_build_array(
    jsonb_build_object('source_event_id', 'a-1', 'entity_kind', 'animal', 'observed_at', '2026-09-10T08:50:00+12:00', 'animal_type', 'Stoat', 'species_confidence', 0.9, 'is_pest', true)));
  perform pg_temp.check('re-run updates the unreviewed row in place', v_n = 1 and (select animal_type from public.cctv_entity_observations where id = v_a1) = 'stoat'
    and (select count(*) from public.cctv_entity_observations where inference_job_id = v_job) = 6);

  -- portfolio search as the worker: plate exact/similar, face, appearance
  perform pg_temp.check('portfolio search finds the face portfolio', exists (select 1 from public.find_cctv_portfolio_matches(v_org, 'person', pg_temp.emb(128, 3, 0.03)) m where m.basis = 'face' and m.portfolio_key = v_row2.portfolio_key));
  perform pg_temp.check('portfolio search ignores a different person', not exists (select 1 from public.find_cctv_portfolio_matches(v_org, 'person', pg_temp.emb(128, 90, 0.0)) m where m.basis = 'face'));

  -- ── human review: identity is a decision; first acceptance creates the canonical record ──
  perform pg_temp.as_user(v_stranger);
  begin
    perform public.review_cctv_entity_observation(v_v1, 'accept');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('reviewer outside the organisation is refused', v_ok and v_err like '%access denied%');
  perform pg_temp.as_user(v_admin);
  v_row := public.review_cctv_entity_observation(v_v1, 'accept', p_notes => 'Clear plate on the gate camera');
  perform pg_temp.as_admin();
  select id into v_vehicle from public.canonical_vehicles where plate_number = 'ABC123';
  perform pg_temp.check('accepting a plated vehicle creates or links the canonical vehicle', v_vehicle is not null and v_row.canonical_vehicle_id = v_vehicle and v_row.review_state = 'accepted' and v_row.portfolio_state = 'linked');
  perform pg_temp.check('canonical vehicle carries only observed attributes and provenance', (select make = 'Toyota' and model = 'Hilux' and colour = 'white' and registered_owner_name is null from public.canonical_vehicles where id = v_vehicle)
    and exists (select 1 from public.canonical_vehicle_links where canonical_vehicle_id = v_vehicle and source_table = 'cctv_entity_observations' and source_key = v_v1::text));
  perform pg_temp.as_user(v_admin);
  perform pg_temp.check('portfolio search now returns the canonical vehicle by similar plate', exists (select 1 from public.find_cctv_portfolio_matches(v_org, 'vehicle', null, null, 'ABC 12') m where m.match_kind = 'canonical_vehicle' and m.canonical_vehicle_id = v_vehicle));
  begin
    perform public.review_cctv_entity_observation(v_v2, 'new_vehicle');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm;
  end;
  perform pg_temp.check('a plate-less vehicle cannot be minted: ' || coalesce(v_err, ''), v_ok and v_err like 'A readable plate is required%');
  v_row := public.review_cctv_entity_observation(v_v1, 'accept_portfolio');
  perform pg_temp.check('accept_portfolio applies the identity to unreviewed siblings', (select canonical_vehicle_id = v_vehicle and review_state = 'accepted' and portfolio_state = 'linked' and candidate_plate = 'ABC123' from public.cctv_entity_observations where id = v_v2));

  v_row := public.review_cctv_entity_observation(v_p1, 'new_person', p_display_name => 'Unknown male, red jacket');
  v_person := v_row.person_record_id;
  perform pg_temp.as_admin();
  perform pg_temp.check('new_person creates an org person record and its canonical person', v_person is not null and v_row.canonical_person_id is not null
    and exists (select 1 from public.person_records where id = v_person and organization_id = v_org)
    and exists (select 1 from public.canonical_person_links where source_table = 'person_records' and source_id = v_person and canonical_person_id = v_row.canonical_person_id));
  perform pg_temp.as_user(v_admin);
  v_row := public.review_cctv_entity_observation(v_p2, 'link_person', p_target_id => v_person);
  perform pg_temp.check('link_person links to the same canonical person', v_row.canonical_person_id = (select canonical_person_id from public.cctv_entity_observations where id = v_p1) and v_row.portfolio_state = 'linked');
  begin
    perform public.review_cctv_entity_observation(v_v2, 'link_person', p_target_id => v_person);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform pg_temp.check('a vehicle cannot be linked to a person', v_ok);
  v_row := public.review_cctv_entity_observation(v_p3, 'reject', p_notes => 'IR flare, not a person');
  perform pg_temp.check('reject marks the row and its portfolio state', v_row.review_state = 'rejected' and v_row.portfolio_state = 'rejected');
  perform pg_temp.check('rejected rows leave portfolio search', not exists (select 1 from public.find_cctv_portfolio_matches(v_org, 'person', pg_temp.emb(128, 60, 0.01)) m where m.observation_id = v_p3));
  v_key := (select portfolio_key from public.cctv_entity_observations where id = v_a1);
  v_row := public.review_cctv_entity_observation(v_a1, 'merge_portfolio', p_target_id => v_a1);
  perform pg_temp.check('merge_portfolio keeps a self-merge stable', v_row.portfolio_key = v_key);
  perform pg_temp.as_admin();
  perform pg_temp.check('every review action is audited', (select count(*) from public.audit_log where target_table = 'cctv_entity_observations' and organization_id = v_org) = 6);

  -- ── reach: the place owner (other org) does not see this import; the org's members do ──
  perform pg_temp.as_user(v_stranger);
  perform pg_temp.check('stranger cannot see the import or its events', not exists (select 1 from public.cctv_imports where id = v_import.id) and not exists (select 1 from public.cctv_device_events where cctv_import_id = v_import.id));
  perform pg_temp.check('stranger cannot delete or write CCTV tables', not has_table_privilege('authenticated', 'public.cctv_imports', 'INSERT') and not has_table_privilege('authenticated', 'public.cctv_entity_observations', 'UPDATE'));
  perform pg_temp.as_admin();
end $$;

rollback;

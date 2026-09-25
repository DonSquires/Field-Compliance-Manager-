begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'ok   [%]', p_label;
end $$;

do $$
declare
  v_org uuid := gen_random_uuid();
  v_place uuid; v_location uuid; v_import uuid := gen_random_uuid();
  v_evidence_one uuid := gen_random_uuid(); v_evidence_two uuid := gen_random_uuid();
  v_job_one uuid := gen_random_uuid(); v_job_two uuid := gen_random_uuid();
  v_anchor uuid := gen_random_uuid(); v_same uuid := gen_random_uuid(); v_moved uuid := gen_random_uuid(); v_next_day uuid := gen_random_uuid();
  v_count integer;
begin
  insert into public.organizations (id, name, organization_type) values (v_org, 'T_CCTV_EVENT_ORG', 'service_provider');
  insert into public.locations (organization_id, name, address) values (v_org, 'T Camera Place', '991 Test Camera Road') returning id, canonical_place_id into v_location, v_place;
  insert into public.cctv_imports (id, organization_id, location_id, canonical_place_id, camera_label, camera_key, source_timezone)
    values (v_import, v_org, v_location, v_place, 'T Gate Camera', 't-gate-camera', 'Pacific/Auckland');
  insert into public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id, captured_at)
    values (v_evidence_one, v_org, 'cctv_review', 'video', 'test/one.mp4', v_import, '2026-09-25T10:00:00+12'),
           (v_evidence_two, v_org, 'cctv_review', 'video', 'test/two.mp4', v_import, '2026-09-25T10:05:00+12');
  insert into public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
    values (v_job_one, v_org, v_evidence_one, 'video_motion', 'processing'),
           (v_job_two, v_org, v_evidence_two, 'video_motion', 'processing');

  insert into public.cctv_entity_observations
    (id, organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, observed_to, cctv_import_id, candidate_plate, model_confidence, attributes, thumbnail, portfolio_candidates)
  values
    (v_anchor, v_org, v_job_one, v_evidence_one, 'vehicle-anchor', 'vehicle', '2026-09-25T10:00:00+12', '2026-09-25T10:01:00+12', v_import, 'ABC123', 0.80,
      '{"bbox":{"x":100,"y":100,"width":300,"height":180},"frame_count":4}'::jsonb, 'data:image/jpeg;base64,YQ==',
      '[{"match_kind":"observation","thumbnail":"data:image/jpeg;base64,YQ=="}]'::jsonb),
    (v_same, v_org, v_job_two, v_evidence_two, 'vehicle-same', 'vehicle', '2026-09-25T10:05:00+12', '2026-09-25T10:06:00+12', v_import, 'ABC123', 0.90,
      '{"bbox":{"x":108,"y":104,"width":298,"height":182},"frame_count":6}'::jsonb, 'data:image/jpeg;base64,Yg==', '[]'::jsonb),
    (v_moved, v_org, v_job_two, v_evidence_two, 'vehicle-moved', 'vehicle', '2026-09-25T10:07:00+12', '2026-09-25T10:08:00+12', v_import, 'ABC123', 0.85,
      '{"bbox":{"x":900,"y":500,"width":300,"height":180},"frame_count":3}'::jsonb, null, '[]'::jsonb),
    (v_next_day, v_org, v_job_two, v_evidence_two, 'vehicle-next-day', 'vehicle', '2026-09-26T10:05:00+12', '2026-09-26T10:06:00+12', v_import, 'ABC123', 0.90,
      '{"bbox":{"x":108,"y":104,"width":298,"height":182},"frame_count":3}'::jsonb, null, '[]'::jsonb);

  perform pg_temp.check('candidate image removed at the write boundary', not ((select portfolio_candidates from public.cctv_entity_observations where id = v_anchor) @? '$[*].thumbnail'));
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  v_count := public.coalesce_cctv_stationary_vehicle_observations(v_job_two);
  set local role postgres;

  perform pg_temp.check('one stationary source is consolidated', v_count = 1);
  perform pg_temp.check('stationary source remains with provenance', (select review_state = 'superseded' and attributes->>'superseded_by_observation_id' = v_anchor::text and thumbnail is null from public.cctv_entity_observations where id = v_same));
  perform pg_temp.check('anchor becomes one continuous event', (select observed_to = '2026-09-25T10:06:00+12'::timestamptz and (attributes->>'frame_count')::int = 10 and (attributes->>'source_observation_count')::int = 2 from public.cctv_entity_observations where id = v_anchor));
  perform pg_temp.check('moved vehicle remains a separate review event', (select review_state = 'unreviewed' from public.cctv_entity_observations where id = v_moved));
  perform pg_temp.check('next local day remains a separate review event', (select review_state = 'unreviewed' from public.cctv_entity_observations where id = v_next_day));
  perform pg_temp.check('no source observation was deleted', (select count(*) = 4 from public.cctv_entity_observations where organization_id = v_org));
end $$;

rollback;
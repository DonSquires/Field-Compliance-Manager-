-- Behavioural truth table: pre-provenance R&M patrol events are corrected in place only for
-- the known import artifacts (one-hour NZDT shift, missing provenance and distance), and
-- duplicate worksheet copies are archived â€” never silently deleted or re-imported.
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
create or replace function pg_temp.evt(
  p_ref text, p_hash text, p_site uuid, p_status text, p_at text, p_row integer, p_officer uuid,
  p_sheet text default '2025', p_cost numeric default 20, p_comments text default 'Prefeed check camera.'
) returns jsonb language sql as $$
  select jsonb_build_object(
    'external_ref', p_ref,
    'occurred_at', p_at,
    'site_id', p_site,
    'zone_id', null,
    'event_type', 'patrol_visit',
    'observed_entity_type', 'staff',
    'observed_entity_id', p_officer,
    'status', p_status,
    'distance_km', 12,
    'payload', jsonb_build_object(
      'source', 'rm_patrol_log_import',
      'source_file', 'oracle.xlsx',
      'source_sheet', p_sheet,
      'source_row', p_row,
      'source_sha256', p_hash,
      'derivative_sha256', repeat('b', 64),
      'classification_profile', 'rm_patrol_log',
      'job_number', split_part(p_ref, ':', 3),
      'job_cost', p_cost,
      'job_kms', 12,
      'job_time_hours', 0.7000000000000002,
      'comments', p_comments,
      'location_raw', 'Old reserve road',
      'reserve_raw', 'Reserve 7',
      'source_category', 'Patrol',
      'patroller_raw', 'Fixture Officer',
      'plates_found', '[]'::jsonb
    )
  );
$$;
create or replace function pg_temp.dart_update_evt(
  p_ref text, p_hash text, p_site uuid, p_at text, p_row integer, p_officer uuid, p_location text
) returns jsonb language sql as $$
  select fixture || jsonb_build_object('payload', fixture->'payload' || jsonb_build_object(
    'job_number', null,
    'source_sheet', 'Update 251215',
    'source_row', p_row,
    'location_raw', p_location
  ))
  from (select pg_temp.evt(p_ref, p_hash, p_site, null, p_at,
    p_row, p_officer, 'Update 251215') as fixture) source;
$$;
create or replace function pg_temp.manifest(p_key text, p_client uuid, p_sheet text default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'idempotency_key', p_key,
    'source_profile', 'rm_patrol_log',
    'derivative_sha256', repeat('b', 64),
    'source_sheet', p_sheet,
    'target_client_organization_id', p_client,
    'expected_proposal_count', 0,
    'direct_workshop_writes', 0,
    'direct_finance_writes', 0
  );
$$;
-- Turns a staged row into the shape the pre-provenance importer left behind.
create or replace function pg_temp.make_legacy(p_id uuid, p_shift interval) returns void language sql as $$
  update public.location_events
  set occurred_at = occurred_at + p_shift,
      distance_km = null,
      payload = (payload - 'source_file' - 'source_sheet' - 'source_row' - 'source_sha256' - 'derivative_sha256'
        - 'classification_profile') || jsonb_build_object('job_kms', null, 'job_time_hours', '0.7')
  where id = p_id;
$$;
-- The sheet's formulas skipped the day's Start row; the importer recomputes the leg and keeps the originals.
create or replace function pg_temp.leg_evt(p_event jsonb) returns jsonb language sql as $$
  select jsonb_set(p_event, '{distance_km}', '43'::jsonb) || jsonb_build_object('payload', (p_event->'payload') || jsonb_build_object(
    'job_kms', '43', 'job_time_hours', '1.0666666666666667', 'job_cost', 66.66666666666667,
    'source_leg_correction', jsonb_build_object('rule', 'formula_skipped_start_row', 'start_source_row', 9,
      'job_kms', '-84', 'job_time_hours', '-2.683333333333332', 'job_cost', -167.70833333333323)));
$$;
create or replace function pg_temp.make_leg_legacy(p_id uuid, p_job_cost numeric) returns void language sql as $$
  update public.location_events
  set distance_km = -84,
      payload = payload || jsonb_build_object('job_kms', '-84', 'job_time_hours', '-2.683333333333332', 'job_cost', p_job_cost)
  where id = p_id;
$$;

do $$
declare
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_automation uuid := gen_random_uuid();
  v_reviewer uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_suffix text := replace(gen_random_uuid()::text, '-', '');
  v_hash text := repeat('a', 64);
  v_fp text := repeat('1', 64);
  v_nzdt text := '2026-03-04T21:15:00.000Z';
  v_nzst text := '2026-06-04T22:00:00.000Z';
  v_batch public.file_import_batches%rowtype;
  v_canonical_batch public.file_import_batches%rowtype;
  v_update_batch public.file_import_batches%rowtype;
  v_ref jsonb := '{}'::jsonb;
  v_id jsonb := '{}'::jsonb;
  v_key text;
  v_result record;
  v_ok boolean;
  v_err text;
begin
  foreach v_key in array array['dst', 'std', 'time', 'identity', 'payload', 'linked', 'sourced',
    'copy', 'differs', 'leg', 'legbad', 'pair', 'paircopy', 'hold', 'holdcopy'] loop
    v_ref := v_ref || jsonb_build_object(v_key, 'rm_patrol_import:ORACLE:' || v_key || '-' || v_suffix);
  end loop;

  insert into public.organizations(id, name, organization_type, active, status)
  values (v_provider, 'Oracle Legacy Provider', 'service_provider', true, 'active'),
         (v_client, 'Oracle Legacy Client', 'government', true, 'active');
  insert into public.user_profiles(id, role, organization_id, employer_organization_id, display_name, email)
  values (v_automation, 'admin', v_provider, v_provider, 'Oracle import automation', 'oracle-legacy-import@field-compliance.invalid'),
         (v_reviewer, 'master', v_provider, v_provider, 'Oracle legacy reviewer', 'oracle-legacy-reviewer@example.invalid'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle legacy officer', 'oracle-legacy-officer@example.invalid');
  insert into public.client_sites(id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site, v_client, v_provider, 'Oracle legacy site', '1 Oracle Way', st_setsrid(st_makepoint(173.284, -41.271), 4326), -41.271, 173.284, true);
  insert into public.service_agreements(id, provider_organization_id, client_organization_id, name, agreement_type, starts_on)
  values (v_agreement, v_provider, v_client, 'Oracle legacy agreement', 'operational', current_date);
  insert into public.service_agreement_modules(service_agreement_id, module_key, enabled) values (v_agreement, 'patrol', true);
  insert into public.service_agreement_locations(service_agreement_id, site_id, status) values (v_agreement, v_site, 'active');
  insert into public.import_source_profiles(organization_id, profile_code, name, parser, column_mappings, target_mappings, active, created_by, import_actor_id)
  values (v_provider, 'rm_patrol_log', 'Oracle R&M patrol log', 'csv', '{}', '{}', true, v_reviewer, v_automation);

  -- Seed the records through the governed importer, then age them into legacy rows.
  perform pg_temp.as_user(v_automation);
  v_batch := public.begin_patrol_import_batch(v_provider, v_client, 'Oracle legacy seed', 'oracle.xlsx', v_hash, 'xlsx',
    pg_temp.manifest('oracle-legacy-seed-' || v_suffix, v_client),     '{"headers":[]}'::jsonb, 15, 0, 0);
  perform public.stage_patrol_import_chunk(v_batch.id, v_provider, v_client, '[]'::jsonb, jsonb_build_array(
    pg_temp.evt(v_ref->>'dst', v_hash, v_site, 'Prefeed', v_nzdt, 1, v_officer),
    pg_temp.evt(v_ref->>'std', v_hash, v_site, 'Prefeed', v_nzst, 2, v_officer),
    pg_temp.evt(v_ref->>'time', v_hash, v_site, 'Prefeed', v_nzdt, 3, v_officer),
    pg_temp.evt(v_ref->>'identity', v_hash, v_site, 'Prefeed', v_nzdt, 4, v_officer),
    pg_temp.evt(v_ref->>'payload', v_hash, v_site, 'Prefeed', v_nzdt, 5, v_officer),
    pg_temp.evt(v_ref->>'linked', v_hash, v_site, 'Prefeed', v_nzdt, 6, v_officer),
    pg_temp.evt(v_ref->>'sourced', v_hash, v_site, 'Prefeed', v_nzdt, 7, v_officer),
    pg_temp.evt(v_ref->>'copy', v_hash, v_site, null, v_nzdt, 8, v_officer, 'Update'),
    pg_temp.evt(v_ref->>'differs', v_hash, v_site, 'Cat', v_nzdt, 9, v_officer, 'Update'),
    pg_temp.evt(v_ref->>'leg', v_hash, v_site, 'Prefeed', v_nzst, 10, v_officer),
    pg_temp.evt(v_ref->>'legbad', v_hash, v_site, 'Prefeed', v_nzst, 11, v_officer),
    pg_temp.evt(v_ref->>'pair', v_hash, v_site, 'Prefeed', v_nzdt, 12, v_officer),
    pg_temp.evt(v_ref->>'paircopy', v_hash, v_site, null, v_nzdt, 14, v_officer, 'Update 251215'),
    pg_temp.evt(v_ref->>'hold', v_hash, v_site, 'Prefeed', v_nzdt, 13, v_officer),
    pg_temp.evt(v_ref->>'holdcopy', v_hash, v_site, 'Cat', v_nzdt, 15, v_officer, 'Update 251215')
  ), '[]'::jsonb);
  perform public.finalize_patrol_import_batch(v_batch.id, '{"direct_workshop_writes":0,"direct_finance_writes":0}'::jsonb);
  perform pg_temp.as_admin();
  foreach v_key in array array['dst', 'std', 'time', 'identity', 'payload', 'linked', 'sourced',
    'copy', 'differs', 'leg', 'legbad', 'pair', 'paircopy', 'hold', 'holdcopy'] loop
    v_id := v_id || jsonb_build_object(v_key, (select id from public.location_events
      where organization_id = v_client and external_ref = v_ref->>v_key));
  end loop;
  perform pg_temp.make_legacy((v_id->>'dst')::uuid, interval '1 hour');
  perform pg_temp.make_legacy((v_id->>'std')::uuid, interval '0');
  perform pg_temp.make_legacy((v_id->>'time')::uuid, interval '2 hours');
  perform pg_temp.make_legacy((v_id->>'leg')::uuid, interval '0');
  perform pg_temp.make_leg_legacy((v_id->>'leg')::uuid, -167.70833333333323);
  perform pg_temp.make_legacy((v_id->>'legbad')::uuid, interval '0');
  perform pg_temp.make_leg_legacy((v_id->>'legbad')::uuid, 999);
  perform pg_temp.make_legacy((v_id->>'pair')::uuid, interval '1 hour');
  perform pg_temp.make_legacy((v_id->>'hold')::uuid, interval '1 hour');
  perform pg_temp.make_legacy((v_id->>'identity')::uuid, interval '1 hour');
  update public.location_events set status = 'Check' where id = (v_id->>'identity')::uuid;
  perform pg_temp.make_legacy((v_id->>'payload')::uuid, interval '1 hour');
  update public.location_events set payload = payload || '{"job_cost":30}' where id = (v_id->>'payload')::uuid;
  perform pg_temp.make_legacy((v_id->>'linked')::uuid, interval '1 hour');
  insert into public.file_import_row_proposals(organization_id, batch_id, source_record_key, source_row_number, target_type, source_values, status)
  values (v_provider, v_batch.id, v_ref->>'linked', 6, 'finance_service_cost', jsonb_build_object('job_cost', 20), 'approved');
  -- Worksheet copies carry provenance but repeat the canonical visit one hour late.
  update public.location_events set occurred_at = occurred_at + interval '1 hour'
  where id in ((v_id->>'copy')::uuid, (v_id->>'differs')::uuid,
    (v_id->>'paircopy')::uuid, (v_id->>'holdcopy')::uuid);

  perform pg_temp.as_user(v_automation);
  v_batch := public.begin_patrol_import_batch(v_provider, v_client, 'Oracle legacy correction', 'oracle.xlsx', v_hash, 'xlsx',
    pg_temp.manifest('oracle-legacy-correct-' || v_suffix, v_client), '{"headers":[]}'::jsonb, 9, 0, 0);
  for v_result in
    select * from public.correct_legacy_patrol_source_records(v_batch.id, v_provider, v_client, (
      select jsonb_agg(jsonb_build_object('kind', 'event', 'record_id', v_id->>k, 'external_ref', v_ref->>k,
        'source_fingerprint', v_fp,
        'desired', case when k in ('leg', 'legbad')
          then pg_temp.leg_evt(pg_temp.evt(v_ref->>k, v_hash, v_site, 'Prefeed', v_nzst, n::integer, v_officer))
          else pg_temp.evt(v_ref->>k, v_hash, v_site, 'Prefeed', case when k = 'std' then v_nzst else v_nzdt end,
            n::integer, v_officer) end))
      from unnest(array['dst', 'std', 'time', 'identity', 'payload', 'linked', 'sourced', 'leg', 'legbad']) with ordinality as u(k, n)))
  loop
    v_key := split_part(split_part(v_result.external_ref, ':', 3), '-', 1);
    if v_key in ('dst', 'std') then
      perform pg_temp.check(v_key || ' legacy artifact is corrected: ' || coalesce(v_result.detail, ''), v_result.outcome = 'corrected');
    elsif v_key = 'leg' then
      perform pg_temp.check('a negative leg from a skipped Start row is corrected when legacy holds the sheet originals: '
        || coalesce(v_result.detail, ''), v_result.outcome = 'corrected');
    elsif v_key = 'legbad' then
      perform pg_temp.check('a leg correction does not excuse a legacy value that differs from the sheet original',
        v_result.outcome = 'held' and v_result.detail = 'legacy_payload_difference:job_cost');
    elsif v_key = 'time' then
      perform pg_temp.check('a time difference other than the NZDT artifact is held',
        v_result.outcome = 'held' and v_result.detail = 'legacy_time_difference_not_offset_artifact');
    elsif v_key = 'identity' then
      perform pg_temp.check('a changed issue status is held with its field name',
        v_result.outcome = 'held' and v_result.detail = 'legacy_identity_difference:status');
    elsif v_key = 'payload' then
      perform pg_temp.check('a changed legacy payload value is held with its key',
        v_result.outcome = 'held' and v_result.detail = 'legacy_payload_difference:job_cost');
    elsif v_key = 'linked' then
      perform pg_temp.check('a dependent finance proposal holds the correction',
        v_result.outcome = 'held' and v_result.detail = 'dependent_proposal_review_required');
    else
      perform pg_temp.check('a record that already carries provenance is not treated as legacy',
        v_result.outcome = 'held' and v_result.detail = 'not_a_legacy_record');
    end if;
  end loop;

  select outcome = 'already_current' into v_ok from public.correct_legacy_patrol_source_records(v_batch.id, v_provider, v_client,
    jsonb_build_array(jsonb_build_object('kind', 'event', 'record_id', v_id->>'dst', 'external_ref', v_ref->>'dst',
      'source_fingerprint', v_fp, 'desired', pg_temp.evt(v_ref->>'dst', v_hash, v_site, 'Prefeed', v_nzdt, 1, v_officer))));
  perform pg_temp.check('correction replay is idempotent', v_ok);

  perform pg_temp.as_admin();
  perform pg_temp.check('corrected record has the true time, distance and source provenance',
    (select occurred_at = v_nzdt::timestamptz and distance_km = 12 and payload->>'source_sheet' = '2025'
       and payload->>'source_sha256' = v_hash and payload->>'job_kms' = '12'
     from public.location_events where id = (v_id->>'dst')::uuid));
  perform pg_temp.check('a corrected leg stores the recomputed values and keeps the sheet originals as provenance',
    (select distance_km = 43 and payload->>'job_kms' = '43' and (payload->>'job_cost')::numeric > 66
       and payload->'source_leg_correction'->>'job_kms' = '-84'
     from public.location_events where id = (v_id->>'leg')::uuid)
    and (select distance_km = -84 from public.location_events where id = (v_id->>'legbad')::uuid));
  perform pg_temp.check('held records are untouched',
    (select count(*) = 4 from public.location_events
     where id in ((v_id->>'time')::uuid, (v_id->>'identity')::uuid, (v_id->>'payload')::uuid, (v_id->>'linked')::uuid)
       and payload->>'source_file' is null));
  perform pg_temp.check('each correction records version 1 with before and after state and an audit entry',
    (select count(*) = 2 and bool_and(version_no = 1 and is_current and state_before <> state_after)
     from public.patrol_import_record_versions
     where change_kind = 'legacy_correction' and record_id in ((v_id->>'dst')::uuid, (v_id->>'std')::uuid))
    and (select count(*) = 2 from public.audit_log where action = 'patrol_legacy_source_corrected'
         and target_id in ((v_id->>'dst')::uuid, (v_id->>'std')::uuid)));

  -- The approved Update worksheet flow patches one canonical row and archives
  -- its unique copy atomically; a copy with a different status remains live.
  perform pg_temp.as_user(v_automation);
  for v_result in
    select * from public.correct_legacy_patrol_source_records(v_batch.id, v_provider, v_client, jsonb_build_array(
      jsonb_build_object('kind', 'event', 'record_id', v_id->>'pair', 'external_ref', v_ref->>'pair',
        'source_fingerprint', v_fp, 'desired', pg_temp.evt(v_ref->>'pair', v_hash, v_site, 'Prefeed', v_nzdt, 12, v_officer)),
      jsonb_build_object('kind', 'event', 'record_id', v_id->>'hold', 'external_ref', v_ref->>'hold',
        'source_fingerprint', v_fp, 'desired', pg_temp.evt(v_ref->>'hold', v_hash, v_site, 'Prefeed', v_nzdt, 13, v_officer))))
  loop
    perform pg_temp.check('Update test canonical legacy row is corrected', v_result.outcome = 'corrected');
  end loop;
  v_canonical_batch := public.begin_patrol_import_batch(v_provider, v_client, 'DART 2025 canonical batch',
    'oracle.xlsx', v_hash, 'xlsx', pg_temp.manifest('oracle-dart-canonical-' || v_suffix, v_client, '2025'),
    '{"headers":[]}'::jsonb, 2, 0, 0);
  v_update_batch := public.begin_patrol_import_batch(v_provider, v_client, 'DART Update worksheet batch',
    'oracle.xlsx', v_hash, 'xlsx', pg_temp.manifest('oracle-dart-update-' || v_suffix, v_client, 'Update 251215'),
    '{"headers":[]}'::jsonb, 2, 0, 0);
  for v_result in
    select * from public.apply_dart_patrol_source_updates_and_supersede(
      v_canonical_batch.id, v_update_batch.id, v_provider, v_client, jsonb_build_array(
        jsonb_build_object(
          'canonical', jsonb_build_object('kind', 'event', 'record_id', v_id->>'pair',
            'external_ref', v_ref->>'pair', 'source_fingerprint', v_fp,
            'desired', pg_temp.evt(v_ref->>'pair', v_hash, v_site, 'Prefeed', v_nzdt, 12, v_officer)),
          'copy_external_ref', v_ref->>'paircopy', 'copy_record_id', v_id->>'paircopy',
          'update_external_ref', 'rm_patrol_import:DART_UPDATE:pair-' || v_suffix,
          'update_source_fingerprint', repeat('2', 64),
          'update_desired', pg_temp.dart_update_evt('rm_patrol_import:DART_UPDATE:pair-' || v_suffix,
            v_hash, v_site, v_nzdt, 14, v_officer, 'New reserve road')
        ),
        jsonb_build_object(
          'canonical', jsonb_build_object('kind', 'event', 'record_id', v_id->>'hold',
            'external_ref', v_ref->>'hold', 'source_fingerprint', v_fp,
            'desired', pg_temp.evt(v_ref->>'hold', v_hash, v_site, 'Prefeed', v_nzdt, 13, v_officer)),
          'copy_external_ref', v_ref->>'holdcopy', 'copy_record_id', v_id->>'holdcopy',
          'update_external_ref', 'rm_patrol_import:DART_UPDATE:hold-' || v_suffix,
          'update_source_fingerprint', repeat('3', 64),
          'update_desired', pg_temp.dart_update_evt('rm_patrol_import:DART_UPDATE:hold-' || v_suffix,
            v_hash, v_site, v_nzdt, 15, v_officer, 'Unchanged reserve road')
        )
      ))
  loop
    if v_result.external_ref like '%:pair-%' then
      perform pg_temp.check('one-to-one Update row patches and archives atomically',
        v_result.outcome = 'updated_and_superseded');
    else
      perform pg_temp.check('status-mismatched Update copy is held without archiving',
        v_result.outcome = 'held' and v_result.detail = 'not_an_identical_copy');
    end if;
  end loop;
  perform pg_temp.as_admin();
  perform pg_temp.check('Update patch preserves the canonical job number, versions the source row, and records audit',
    (select payload->>'location_raw' = 'New reserve road' and payload->>'job_number' = split_part(v_ref->>'pair', ':', 3)
       and payload->>'source_sheet' = '2025'
       and (payload->>'job_cost')::numeric = 20 and (payload->>'job_kms')::numeric = 12
       and abs((payload->>'job_time_hours')::numeric - 0.7) < 0.000000001
     from public.location_events where id = (v_id->>'pair')::uuid)
    and (select count(*) filter (where change_kind = 'update' and is_current and source_row = 14
         and state_before <> state_after) = 1
     from public.patrol_import_record_versions where record_id = (v_id->>'pair')::uuid)
    and exists (select 1 from public.audit_log where action = 'dart_update_row_applied_and_copy_archived'
      and target_id = (v_id->>'pair')::uuid));
  perform pg_temp.check('Update copy is archived with its source provenance',
    not exists (select 1 from public.location_events where id = (v_id->>'paircopy')::uuid)
    and exists (select 1 from public.location_events_superseded where external_ref = v_ref->>'paircopy'
      and canonical_location_event_id = (v_id->>'pair')::uuid)
    and exists (select 1 from public.patrol_import_record_versions
      where record_id = (v_id->>'paircopy')::uuid and change_kind = 'superseded' and source_row = 14));
  perform pg_temp.as_user(v_automation);
  select outcome = 'already_applied' into v_ok from public.apply_dart_patrol_source_updates_and_supersede(
    v_canonical_batch.id, v_update_batch.id, v_provider, v_client, jsonb_build_array(jsonb_build_object(
      'canonical', jsonb_build_object('kind', 'event', 'record_id', v_id->>'pair',
        'external_ref', v_ref->>'pair', 'source_fingerprint', v_fp,
        'desired', pg_temp.evt(v_ref->>'pair', v_hash, v_site, 'Prefeed', v_nzdt, 12, v_officer)),
      'copy_external_ref', v_ref->>'paircopy', 'copy_record_id', v_id->>'paircopy',
      'update_external_ref', 'rm_patrol_import:DART_UPDATE:pair-' || v_suffix,
      'update_source_fingerprint', repeat('2', 64),
      'update_desired', pg_temp.dart_update_evt('rm_patrol_import:DART_UPDATE:pair-' || v_suffix,
        v_hash, v_site, v_nzdt, 14, v_officer, 'New reserve road')
    )));
  perform pg_temp.as_admin();
  perform pg_temp.check('Update replay is idempotent', v_ok);
  perform pg_temp.check('status-mismatched source copy is untouched',
    exists (select 1 from public.location_events where id = (v_id->>'holdcopy')::uuid and status = 'Cat')
    and not exists (select 1 from public.location_events_superseded where external_ref = v_ref->>'holdcopy')
    and not exists (select 1 from public.patrol_import_record_versions
      where record_id = (v_id->>'hold')::uuid and change_kind = 'update'));

  -- Duplicate worksheet copies.
  perform pg_temp.as_user(v_automation);
  for v_result in
    select * from public.supersede_duplicate_patrol_events(v_batch.id, v_provider, v_client, jsonb_build_array(
      jsonb_build_object('kind', 'event', 'external_ref', v_ref->>'copy', 'canonical_external_ref', v_ref->>'dst'),
      jsonb_build_object('kind', 'event', 'external_ref', v_ref->>'differs', 'canonical_external_ref', v_ref->>'dst'),
      jsonb_build_object('kind', 'event', 'external_ref', v_ref->>'linked', 'canonical_external_ref', v_ref->>'dst')))
  loop
    v_key := split_part(split_part(v_result.external_ref, ':', 3), '-', 1);
    if v_key = 'copy' then
      perform pg_temp.check('a visit-level copy one hour late is superseded', v_result.outcome = 'superseded');
    elsif v_key = 'differs' then
      perform pg_temp.check('a copy with a different issue status is held',
        v_result.outcome = 'held' and v_result.detail = 'not_an_identical_copy:status');
    else
      perform pg_temp.check('a copy with dependent finance review is held',
        v_result.outcome = 'held' and v_result.detail = 'dependent_proposal_review_required');
    end if;
  end loop;
  select outcome = 'already_superseded' into v_ok from public.supersede_duplicate_patrol_events(v_batch.id, v_provider, v_client,
    jsonb_build_array(jsonb_build_object('kind', 'event', 'external_ref', v_ref->>'copy', 'canonical_external_ref', v_ref->>'dst')));
  perform pg_temp.check('supersede replay is idempotent', v_ok);

  perform pg_temp.as_admin();
  perform pg_temp.check('the copy left live activity and its full snapshot is archived against the canonical record',
    not exists (select 1 from public.location_events where id = (v_id->>'copy')::uuid)
    and (select event_snapshot->>'id' = v_id->>'copy' and canonical_location_event_id = (v_id->>'dst')::uuid
           and reason_code = 'duplicate_of_canonical_sheet' and superseded_by = v_automation
         from public.location_events_superseded where external_ref = v_ref->>'copy')
    and exists (select 1 from public.audit_log where action = 'patrol_duplicate_event_superseded'));

  v_ok := false;
  begin
    update public.location_events_superseded set reason_code = 'x' where external_ref = v_ref->>'copy';
  exception when others then v_ok := true; end;
  perform pg_temp.check('the supersede archive is append-only', v_ok);

  perform pg_temp.as_user(v_automation);
  v_ok := false;
  begin
    perform public.stage_patrol_import_chunk(v_batch.id, v_provider, v_client, '[]'::jsonb,
      jsonb_build_array(pg_temp.evt(v_ref->>'copy', v_hash, v_site, null, v_nzdt, 8, v_officer, 'Update')), '[]'::jsonb);
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a superseded copy cannot be re-imported: ' || coalesce(v_err, ''), v_ok and v_err ilike '%supersed%');

  v_ok := false;
  begin
    perform pg_temp.as_user(v_officer);
    perform public.supersede_duplicate_patrol_events(v_batch.id, v_provider, v_client, '[]'::jsonb);
  exception when others then v_ok := true; end;
  perform pg_temp.check('a non-import identity cannot use the supersede path', v_ok);
  perform pg_temp.as_admin();
  perform pg_temp.check('correction and archive do not create or alter consequential proposals',
    (select count(*) = 1 and bool_and(source_record_key = v_ref->>'linked' and status = 'approved'
       and target_type = 'finance_service_cost' and source_values = '{"job_cost":20}'::jsonb)
     from public.file_import_row_proposals where organization_id in (v_provider, v_client)));
  perform pg_temp.check('correction and archive do not create finance, roster, timesheet or payroll records',
    not exists (select 1 from public.finance_service_costs where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.finance_labour_cost_postings where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.roster_assignments where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.shifts where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.shift_stops where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.timesheets where organization_id in (v_provider, v_client))
    and not exists (select 1 from public.payroll_export_batches where organization_id in (v_provider, v_client)));
end $$;

select 'patrol_legacy_correction_and_supersede_ok' as sentinel;
rollback;

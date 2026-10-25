-- Behavioural truth table: an edited R&M patrol workbook row updates the matching
-- FCM record through an audited, append-only source history, and every unsafe
-- case is held per row instead of overwriting or deleting.
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
  p_ref text, p_hash text, p_site uuid, p_status text, p_distance numeric, p_job_cost numeric, p_row integer,
  p_officer uuid default null
) returns jsonb language sql as $$
  select jsonb_build_object(
    'external_ref', p_ref,
    'occurred_at', '2026-03-04T21:15:00.000Z',
    'site_id', p_site,
    'zone_id', null,
    'event_type', 'patrol_visit',
    'observed_entity_type', case when p_officer is null then null else 'staff' end,
    'observed_entity_id', p_officer,
    'status', p_status,
    'distance_km', p_distance,
    'payload', jsonb_build_object(
      'source', 'rm_patrol_log_import',
      'source_file', 'oracle.xlsx',
      'source_sheet', '2026',
      'source_row', p_row,
      'source_sha256', p_hash,
      'derivative_sha256', repeat('b', 64),
      'classification_profile', 'rm_patrol_log',
      'job_number', split_part(p_ref, ':', 3),
      'job_cost', p_job_cost,
      'job_kms', p_distance
    )
  );
$$;
create or replace function pg_temp.manifest(p_key text, p_client uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'idempotency_key', p_key,
    'source_profile', 'rm_patrol_log',
    'derivative_sha256', repeat('b', 64),
    'target_client_organization_id', p_client,
    'expected_proposal_count', 0,
    'direct_workshop_writes', 0,
    'direct_finance_writes', 0
  );
$$;

do $$
declare
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_automation uuid := gen_random_uuid();
  v_reviewer uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_site_a uuid := gen_random_uuid();
  v_site_b uuid := gen_random_uuid();
  v_site_outside uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_suffix text := replace(gen_random_uuid()::text, '-', '');
  v_ref_main text;
  v_ref_legacy text;
  v_ref_unbaselined text;
  v_ref_proposal text;
  v_ref_obs text;
  v_hash_1 text := repeat('a', 64);
  v_hash_2 text := repeat('c', 64);
  v_fp_1 text := repeat('1', 64);
  v_fp_2 text := repeat('2', 64);
  v_fp_3 text := repeat('3', 64);
  v_batch_1 public.file_import_batches%rowtype;
  v_batch_2 public.file_import_batches%rowtype;
  v_main_id uuid;
  v_legacy_id uuid;
  v_unbaselined_id uuid;
  v_proposal_id uuid;
  v_obs_id uuid;
  v_obs jsonb;
  v_result record;
  v_count integer;
  v_ok boolean;
  v_err text;
begin
  v_ref_main := 'rm_patrol_import:ORACLE:main-' || v_suffix;
  v_ref_legacy := 'rm_patrol_import:ORACLE:legacy-' || v_suffix;
  v_ref_unbaselined := 'rm_patrol_import:ORACLE:unbaselined-' || v_suffix;
  v_ref_proposal := 'rm_patrol_import:ORACLE:proposal-' || v_suffix;
  v_ref_obs := 'rm_patrol_import:ORACLE:obs-' || v_suffix;

  insert into public.organizations(id, name, organization_type, active, status)
  values (v_provider, 'Oracle Sync Provider', 'service_provider', true, 'active'),
         (v_client, 'Oracle Sync Client', 'government', true, 'active'),
         (v_other_org, 'Oracle Unrelated Provider', 'service_provider', true, 'active');
  insert into public.user_profiles(id, role, organization_id, employer_organization_id, display_name, email)
  values (v_automation, 'admin', v_provider, v_provider, 'Oracle import automation', 'oracle-sync-import@field-compliance.invalid'),
         (v_reviewer, 'master', v_provider, v_provider, 'Oracle sync reviewer', 'oracle-sync-reviewer@example.invalid'),
         (v_officer, 'officer', v_provider, v_provider, 'Oracle patrol officer', 'oracle-sync-officer@example.invalid'),
         (v_outsider, 'admin', v_other_org, v_other_org, 'Oracle unrelated admin', 'oracle-sync-outsider@example.invalid');
  insert into public.client_sites(id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  values (v_site_a, v_client, v_provider, 'Oracle site A', '1 Oracle Way', st_setsrid(st_makepoint(173.284, -41.271), 4326), -41.271, 173.284, true),
         (v_site_b, v_client, v_provider, 'Oracle site B', '2 Oracle Way', st_setsrid(st_makepoint(173.285, -41.272), 4326), -41.272, 173.285, true),
         (v_site_outside, v_client, v_provider, 'Oracle uncontracted site', '3 Oracle Way', st_setsrid(st_makepoint(173.286, -41.273), 4326), -41.273, 173.286, true);
  insert into public.service_agreements(id, provider_organization_id, client_organization_id, name, agreement_type, starts_on)
  values (v_agreement, v_provider, v_client, 'Oracle patrol agreement', 'operational', current_date);
  insert into public.service_agreement_modules(service_agreement_id, module_key, enabled) values (v_agreement, 'patrol', true);
  insert into public.service_agreement_locations(service_agreement_id, site_id, status)
  values (v_agreement, v_site_a, 'active'), (v_agreement, v_site_b, 'active');
  insert into public.import_source_profiles(organization_id, profile_code, name, parser, column_mappings, target_mappings, active, created_by, import_actor_id)
  values (v_provider, 'rm_patrol_log', 'Oracle R&M patrol log', 'csv', '{}', '{}', true, v_reviewer, v_automation);

  -- Workbook version 1: rows are staged by the existing governed importer.
  perform pg_temp.as_user(v_automation);
  v_batch_1 := public.begin_patrol_import_batch(
    v_provider, v_client, 'Oracle workbook v1', 'oracle.xlsx', v_hash_1, 'xlsx',
    pg_temp.manifest('oracle-sync-v1-' || v_suffix, v_client), '{"headers":[]}'::jsonb, 4, 0, 0
  );
  perform public.stage_patrol_import_chunk(
    v_batch_1.id, v_provider, v_client, '[]'::jsonb,
    jsonb_build_array(
      pg_temp.evt(v_ref_main, v_hash_1, v_site_a, 'completed', 12.5, 85, 10, v_officer),
      pg_temp.evt(v_ref_legacy, v_hash_1, v_site_a, 'completed', 3, 20, 11),
      pg_temp.evt(v_ref_unbaselined, v_hash_1, v_site_a, 'completed', 4, 20, 12),
      pg_temp.evt(v_ref_proposal, v_hash_1, v_site_a, 'completed', 5, 40, 13)
    ),
    '[]'::jsonb
  );
  perform pg_temp.as_admin();
  select id into v_main_id from public.location_events where organization_id = v_client and external_ref = v_ref_main;
  select id into v_legacy_id from public.location_events where organization_id = v_client and external_ref = v_ref_legacy;
  select id into v_unbaselined_id from public.location_events where organization_id = v_client and external_ref = v_ref_unbaselined;
  select id into v_proposal_id from public.location_events where organization_id = v_client and external_ref = v_ref_proposal;
  -- Simulate a legacy FCM record that no longer equals its source row.
  update public.location_events set status = 'legacy edited' where id = v_legacy_id;

  -- Baseline: only records that already equal the source are adopted.
  perform pg_temp.as_user(v_automation);
  for v_result in
    select * from public.adopt_patrol_source_baseline(v_batch_1.id, v_provider, v_client, jsonb_build_array(
      jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main, 'source_fingerprint', v_fp_1,
        'desired', pg_temp.evt(v_ref_main, v_hash_1, v_site_a, 'completed', 12.5, 85, 10, v_officer)),
      jsonb_build_object('kind', 'event', 'record_id', v_legacy_id, 'external_ref', v_ref_legacy, 'source_fingerprint', v_fp_1,
        'desired', pg_temp.evt(v_ref_legacy, v_hash_1, v_site_a, 'completed', 3, 20, 11)),
      jsonb_build_object('kind', 'event', 'record_id', v_proposal_id, 'external_ref', v_ref_proposal, 'source_fingerprint', v_fp_1,
        'desired', pg_temp.evt(v_ref_proposal, v_hash_1, v_site_a, 'completed', 5, 40, 13))
    ))
  loop
    if v_result.external_ref = v_ref_main then
      perform pg_temp.check('matching source row is adopted as baseline', v_result.outcome = 'adopted');
    elsif v_result.external_ref = v_ref_legacy then
      perform pg_temp.check('legacy record that differs from source is held with field names: ' || coalesce(v_result.detail, ''),
        v_result.outcome = 'held' and v_result.detail = 'initial_difference_requires_review:status');
    else
      perform pg_temp.check('second matching row is adopted', v_result.outcome = 'adopted');
    end if;
  end loop;
  select outcome = 'already_current' into v_ok from public.adopt_patrol_source_baseline(v_batch_1.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main, 'source_fingerprint', v_fp_1,
      'desired', pg_temp.evt(v_ref_main, v_hash_1, v_site_a, 'completed', 12.5, 85, 10, v_officer))));
  perform pg_temp.check('baseline replay is idempotent', v_ok);
  perform public.finalize_patrol_import_batch(v_batch_1.id, '{"direct_workshop_writes":0,"direct_finance_writes":0}'::jsonb);

  perform pg_temp.as_admin();
  perform pg_temp.check('legacy held record received no history and was not changed',
    not exists (select 1 from public.patrol_import_record_versions where record_id = v_legacy_id)
    and (select status = 'legacy edited' from public.location_events where id = v_legacy_id));
  insert into public.file_import_row_proposals(organization_id, batch_id, source_record_key, source_row_number, target_type, source_values, status)
  values (v_provider, v_batch_1.id, v_ref_proposal, 13, 'finance_service_cost',
    jsonb_build_object('source_sha256', v_hash_1, 'job_cost', 40), 'approved');

  -- Workbook version 2: the staff member edited rows in the spreadsheet.
  perform pg_temp.as_user(v_automation);
  v_batch_2 := public.begin_patrol_import_batch(
    v_provider, v_client, 'Oracle workbook v2', 'oracle.xlsx', v_hash_2, 'xlsx',
    pg_temp.manifest('oracle-sync-v2-' || v_suffix, v_client), '{"headers":[]}'::jsonb, 4, 0, 0
  );

  v_ok := false;
  begin
    perform public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
      jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
        'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
        'desired', pg_temp.evt(v_ref_main, v_hash_1, v_site_b, 'completed - gate damaged', 14, 95, 10, v_officer))));
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a row carrying another workbook version is rejected: ' || coalesce(v_err, ''), v_ok and v_err ilike '%provenance%');

  for v_result in
    select * from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
      jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
        'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
        'desired', pg_temp.evt(v_ref_main, v_hash_2, v_site_b, 'completed - gate damaged', 14, 95, 10, v_officer)),
      jsonb_build_object('kind', 'event', 'record_id', v_unbaselined_id, 'external_ref', v_ref_unbaselined,
        'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
        'desired', pg_temp.evt(v_ref_unbaselined, v_hash_2, v_site_a, 'cancelled', 4, 20, 12)),
      jsonb_build_object('kind', 'event', 'record_id', v_proposal_id, 'external_ref', v_ref_proposal,
        'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
        'desired', pg_temp.evt(v_ref_proposal, v_hash_2, v_site_a, 'completed', 5, 55, 13))
    ))
  loop
    if v_result.external_ref = v_ref_main then
      perform pg_temp.check('edited source row updates FCM and names changed fields: ' || coalesce(v_result.detail, ''),
        v_result.outcome = 'updated'
        and v_result.detail like '%distance_km%' and v_result.detail like '%site_id%'
        and v_result.detail like '%status%' and v_result.detail like '%payload.job_cost%');
    elsif v_result.external_ref = v_ref_unbaselined then
      perform pg_temp.check('record without a source baseline is held', v_result.outcome = 'held' and v_result.detail = 'source_baseline_required');
    else
      perform pg_temp.check('a dependent finance proposal holds the cost edit', v_result.outcome = 'held' and v_result.detail = 'dependent_proposal_review_required');
    end if;
  end loop;

  select outcome = 'already_applied' into v_ok from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
      'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
      'desired', pg_temp.evt(v_ref_main, v_hash_2, v_site_b, 'completed - gate damaged', 14, 95, 10, v_officer))));
  perform pg_temp.check('update replay in the same batch is idempotent', v_ok);

  select outcome = 'held' and detail = 'stale_source_comparison' into v_ok
  from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
      'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_3,
      'desired', pg_temp.evt(v_ref_main, v_hash_2, v_site_b, 'completed', 15, 95, 10, v_officer))));
  perform pg_temp.check('a comparison made against an older source version is held', v_ok);

  select outcome = 'held' and detail = 'place_outside_contracted_patrol_coverage' into v_ok
  from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
      'prior_source_fingerprint', v_fp_2, 'source_fingerprint', v_fp_3,
      'desired', pg_temp.evt(v_ref_main, v_hash_2, v_site_outside, 'completed', 15, 95, 10, v_officer))));
  perform pg_temp.check('a move to an uncontracted place is held', v_ok);

  perform pg_temp.as_admin();
  perform pg_temp.check('FCM record now reflects the edited source row',
    (select client_site_id = v_site_b and status = 'completed - gate damaged' and distance_km = 14
       and payload->>'job_cost' = '95' and payload->>'source_sha256' = v_hash_2
     from public.location_events where id = v_main_id));
  perform pg_temp.check('history keeps the baseline and one current update with before and after state',
    (select count(*) = 2
       and count(*) filter (where is_current and version_no = 2 and change_kind = 'update'
         and state_before->>'status' = 'completed' and state_after->>'status' = 'completed - gate damaged'
         and source_sha256 = v_hash_2 and batch_id = v_batch_2.id and applied_by = v_automation) = 1
     from public.patrol_import_record_versions where record_id = v_main_id));
  perform pg_temp.check('the update is audited with field names only',
    exists (select 1 from public.audit_log where action = 'patrol_source_row_updated' and target_id = v_main_id
      and metadata->'changed_fields' ? 'status' and not (metadata ? 'state_after')));
  perform pg_temp.check('held rows were not changed',
    (select status = 'completed' from public.location_events where id = v_unbaselined_id)
    and (select payload->>'job_cost' = '40' from public.location_events where id = v_proposal_id));

  -- Once the earlier finance review is resolved, the same source edit proceeds.
  update public.file_import_row_proposals set status = 'applied' where batch_id = v_batch_1.id and source_record_key = v_ref_proposal;
  perform pg_temp.as_user(v_automation);
  select outcome = 'updated' into v_ok from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_proposal_id, 'external_ref', v_ref_proposal,
      'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
      'desired', pg_temp.evt(v_ref_proposal, v_hash_2, v_site_a, 'completed', 5, 55, 13))));
  perform pg_temp.check('an applied earlier proposal does not block the edit permanently', v_ok);
  perform pg_temp.as_admin();

  -- Someone edits the record inside FCM after the sync; the next source edit must not overwrite it.
  update public.location_events set status = 'edited in FCM' where id = v_main_id;
  perform pg_temp.as_user(v_automation);
  select outcome = 'held' and detail = 'fcm_record_changed_since_last_sync' into v_ok
  from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'event', 'record_id', v_main_id, 'external_ref', v_ref_main,
      'prior_source_fingerprint', v_fp_2, 'source_fingerprint', v_fp_3,
      'desired', pg_temp.evt(v_ref_main, v_hash_2, v_site_b, 'completed', 16, 95, 10, v_officer))));
  perform pg_temp.check('an FCM-side edit holds the source update instead of overwriting it', v_ok);

  -- Only the configured import identity can sync.
  perform pg_temp.as_user(v_reviewer);
  v_ok := false;
  begin
    perform public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, '[]'::jsonb);
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('a different administrator cannot use the import batch: ' || coalesce(v_err, ''),
    v_ok and v_err ilike '%import identity%');

  -- Locked observation evidence: fact fields are held, distance can still follow the source.
  perform pg_temp.as_user(v_automation);
  v_obs := jsonb_build_object(
    'external_ref', v_ref_obs, 'occurred_at', '2026-03-04T22:00:00.000Z', 'site_id', v_site_a, 'zone_id', null,
    'officer_id', v_officer, 'plate', 'Orc' || substr(v_suffix, 1, 3), 'officer_notes', null, 'distance_km', 2,
    'payload', jsonb_build_object('source', 'rm_patrol_log_import', 'source_file', 'oracle.xlsx', 'source_sheet', '2026',
      'source_row', 20, 'source_sha256', v_hash_2, 'derivative_sha256', repeat('b', 64),
      'classification_profile', 'rm_patrol_log', 'job_number', 'obs', 'job_kms', 2));
  perform public.stage_patrol_import_chunk(v_batch_2.id, v_provider, v_client, jsonb_build_array(v_obs), '[]'::jsonb, '[]'::jsonb);
  perform pg_temp.as_admin();
  select id into v_obs_id from public.observations where organization_id = v_client and external_refs->>'external_ref' = v_ref_obs;
  perform pg_temp.as_user(v_automation);
  select outcome = 'adopted' into v_ok from public.adopt_patrol_source_baseline(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'observation', 'record_id', v_obs_id, 'external_ref', v_ref_obs, 'source_fingerprint', v_fp_1, 'desired', v_obs)));
  perform pg_temp.check('a newly staged observation is adopted', v_ok);
  perform pg_temp.as_admin();
  update public.observations set photo_captured_at = now() where id = v_obs_id;
  perform pg_temp.check('photo capture locks the observation', (select locked_at is not null from public.observations where id = v_obs_id));
  perform pg_temp.as_user(v_automation);
  select outcome = 'held' and detail = 'locked_evidence_requires_correction_review' into v_ok
  from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'observation', 'record_id', v_obs_id, 'external_ref', v_ref_obs,
      'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
      'desired', jsonb_set(v_obs, '{plate}', '"ZZZ999"'))));
  perform pg_temp.check('a plate edit on locked evidence is held', v_ok);
  select outcome = 'updated' into v_ok
  from public.apply_patrol_source_updates(v_batch_2.id, v_provider, v_client, jsonb_build_array(
    jsonb_build_object('kind', 'observation', 'record_id', v_obs_id, 'external_ref', v_ref_obs,
      'prior_source_fingerprint', v_fp_1, 'source_fingerprint', v_fp_2,
      'desired', jsonb_set(jsonb_set(v_obs, '{distance_km}', '3'), '{payload,job_kms}', '3'))));
  perform pg_temp.check('a non-evidence edit on a locked observation still updates', v_ok);

  -- History is append-only and readable only inside the provider's import administration.
  perform pg_temp.as_admin();
  v_ok := false;
  begin
    update public.patrol_import_record_versions set changed_fields = '{}' where record_id = v_main_id;
  exception when others then v_ok := true; end;
  perform pg_temp.check('history rows cannot be rewritten', v_ok);
  v_ok := false;
  begin
    delete from public.patrol_import_record_versions where record_id = v_main_id;
  exception when others then v_ok := true; end;
  perform pg_temp.check('history rows cannot be deleted', v_ok);

  perform pg_temp.as_user(v_reviewer);
  select count(*) into v_count from public.patrol_import_record_versions where record_id = v_main_id;
  perform pg_temp.check('provider import administrators can read history', v_count = 2);
  perform pg_temp.as_user(v_outsider);
  select count(*) into v_count from public.patrol_import_record_versions where record_id = v_main_id;
  perform pg_temp.check('another organization cannot read history', v_count = 0);
  v_ok := false;
  begin
    insert into public.patrol_import_record_versions(provider_organization_id, client_organization_id, record_kind, record_id,
      external_ref, source_profile, source_file, source_row, source_sha256, derivative_sha256, source_fingerprint, batch_id,
      version_no, change_kind, state_after, applied_by)
    values (v_provider, v_client, 'event', v_main_id, v_ref_main, 'rm_patrol_log', 'oracle.xlsx', 1, v_hash_1, v_hash_1, v_fp_1,
      v_batch_1.id, 9, 'update', '{}', v_outsider);
  exception when others then v_ok := true; end;
  perform pg_temp.check('clients cannot write history directly', v_ok);
  perform pg_temp.as_admin();
end $$;

rollback;

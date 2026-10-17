-- Behavioural truth table: import automation stages evidence and proposals;
-- a separate human reviews them against current tenant, contract, place,
-- assignee, catalog, classification-rule, and source-evidence truth.
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
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_automation uuid := gen_random_uuid();
  v_reviewer uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_subject uuid;
  v_activity uuid;
  v_subject_rule uuid := gen_random_uuid();
  v_activity_rule uuid := gen_random_uuid();
  v_batch public.file_import_batches%rowtype;
  v_replayed public.file_import_batches%rowtype;
  v_workshop_proposal uuid;
  v_finance_proposal uuid;
  v_external_ref text := 'rm_patrol_import:oracle:' || gen_random_uuid()::text;
  v_source_hash text := repeat('a', 64);
  v_derivative_hash text := repeat('b', 64);
  v_manifest jsonb;
  v_schema jsonb := '{"headers":[],"resolved_mappings":[]}'::jsonb;
  v_source_values jsonb;
  v_ok boolean;
  v_err text;
begin
  insert into public.organizations(id,name,organization_type,active,status)
  values(v_provider,'Oracle Import Provider','service_provider',true,'active'),
        (v_client,'Oracle Import Client','government',true,'active');
  insert into public.user_profiles(id,role,organization_id,employer_organization_id,display_name,email)
  values(v_automation,'admin',v_provider,v_provider,'Oracle import automation','oracle-import@field-compliance.invalid'),
        (v_reviewer,'master',v_provider,v_provider,'Oracle human reviewer','oracle-reviewer@example.invalid');
  insert into public.client_sites(id,client_organization_id,organization_id,name,address,center_point,gps_lat,gps_lng,active)
  values(v_site,v_client,v_provider,'Oracle contracted depot','1 Oracle Way',st_setsrid(st_makepoint(173.284,-41.271),4326),-41.271,173.284,true);
  insert into public.service_agreements(id,provider_organization_id,client_organization_id,name,agreement_type,starts_on)
  values(v_agreement,v_provider,v_client,'Oracle patrol and Workshop agreement','operational',current_date);
  insert into public.service_agreement_modules(service_agreement_id,module_key,enabled)
  values(v_agreement,'patrol',true),(v_agreement,'workshop',true);
  insert into public.service_agreement_locations(service_agreement_id,site_id,status)
  values(v_agreement,v_site,'active');
  select id into v_subject from public.reference_codes
  where organization_id=v_provider and code_type='work_subject' and code='electronic_lock' and is_active;
  select id into v_activity from public.reference_codes
  where organization_id=v_provider and code_type='work_activity' and code='maintenance' and is_active;
  insert into public.import_source_profiles(organization_id,profile_code,name,parser,column_mappings,target_mappings,active,created_by,import_actor_id)
  values(v_provider,'rm_patrol_log','Oracle R&M patrol log','csv','{}','{}',true,v_reviewer,v_automation);
  insert into public.import_value_classification_rules(id,organization_id,source_profile,rule_code,target_code_id,conditions,priority,active,created_by)
  values(v_subject_rule,v_provider,'rm_patrol_log','oracle-subject',v_subject,'[]',10,true,v_reviewer),
        (v_activity_rule,v_provider,'rm_patrol_log','oracle-activity',v_activity,'[]',20,true,v_reviewer);

  v_manifest := jsonb_build_object(
    'idempotency_key','oracle-review-' || gen_random_uuid()::text,
    'source_profile','rm_patrol_log',
    'derivative_sha256',v_derivative_hash,
    'target_client_organization_id',v_client,
    'expected_proposal_count',2,
    'direct_workshop_writes',0,
    'direct_finance_writes',0
  );
  v_source_values := jsonb_build_object(
    'source','rm_patrol_log_import',
    'source_profile','rm_patrol_log',
    'source_file','oracle.csv',
    'source_sha256',v_source_hash,
    'derivative_sha256',v_derivative_hash,
    'source_sheet','DATA',
    'source_row',2,
    'evidence_record_type','location_events',
    'evidence_external_ref',v_external_ref,
    'client_organization_id',v_client,
    'classification_rule_ids',jsonb_build_array(v_subject_rule,v_activity_rule),
    'job_cost',85,
    'travel_cost',20,
    'total_cost',105
  );

  perform pg_temp.as_user(v_automation);
  v_batch := public.begin_patrol_import_batch(
    v_provider,v_client,'Oracle governed import','oracle.csv',v_source_hash,'csv',
    v_manifest,v_schema,1,0,0
  );
  v_replayed := public.begin_patrol_import_batch(
    v_provider,v_client,'Oracle governed import','oracle.csv',v_source_hash,'csv',
    v_manifest,v_schema,1,0,0
  );
  perform pg_temp.check('exact open-batch replay returns the same batch',v_replayed.id=v_batch.id);
  begin
    perform public.begin_patrol_import_batch(
      v_provider,v_client,'Changed batch name','oracle.csv',v_source_hash,'csv',
      v_manifest,v_schema,1,0,0
    );
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('an open replay cannot mutate frozen metadata: ' || coalesce(v_err,''),v_ok and v_err ilike '%immutable%');

  perform public.stage_patrol_import_chunk(
    v_batch.id,v_provider,v_client,
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'external_ref',v_external_ref,
      'occurred_at',now(),
      'site_id',v_site,
      'zone_id',null,
      'event_type','patrol_log_unattributed',
      'observed_entity_type',null,
      'observed_entity_id',null,
      'status','maintenance evidence',
      'payload',jsonb_build_object(
        'source','rm_patrol_log_import',
        'source_file','oracle.csv',
        'source_sha256',v_source_hash,
        'derivative_sha256',v_derivative_hash,
        'source_sheet','DATA',
        'source_row',2,
        'classification_profile','rm_patrol_log'
      )
    )),
    jsonb_build_array(
      jsonb_build_object(
        'source_record_key',v_external_ref,
        'source_row_number',2,
        'target_type','workshop_work_order',
        'proposed_payload',jsonb_build_object(
          'organization_id',v_provider,
          'client_organization_id',v_client,
          'kind','maintenance',
          'title','Repair electronic lock',
          'description','Electronic lock would not open',
          'work_subject_code_id',v_subject,
          'work_activity_code_id',v_activity,
          'client_site_id',v_site,
          'zone_id',null,
          'assigned_user_id',v_reviewer,
          'scheduled_for',now(),
          'evidence_record_type','location_events',
          'evidence_external_ref',v_external_ref
        ),
        'source_values',v_source_values
      ),
      jsonb_build_object(
        'source_record_key',v_external_ref,
        'source_row_number',2,
        'target_type','finance_service_cost',
        'proposed_payload',jsonb_build_object(
          'organization_id',v_provider,
          'client_organization_id',v_client,
          'occurred_at',now(),
          'client_site_id',v_site,
          'zone_id',null,
          'job_cost',85,
          'travel_cost',20,
          'total_cost',105,
          'requires_cost_type_mapping',true,
          'evidence_record_type','location_events',
          'evidence_external_ref',v_external_ref
        ),
        'source_values',v_source_values
      )
    )
  );
  v_batch := public.finalize_patrol_import_batch(v_batch.id,'{"direct_workshop_writes":0,"direct_finance_writes":0}'::jsonb);
  perform pg_temp.check('automation stages a human-review batch',v_batch.status='needs_review' and v_batch.created_by=v_automation);

  perform pg_temp.as_admin();
  select id into v_workshop_proposal from public.file_import_row_proposals where batch_id=v_batch.id and target_type='workshop_work_order';
  select id into v_finance_proposal from public.file_import_row_proposals where batch_id=v_batch.id and target_type='finance_service_cost';
  perform pg_temp.as_user(v_reviewer);
  perform public.review_file_import_row_proposal(v_workshop_proposal,'approved','Evidence, contract, place, assignee, and rules verified');
  perform pg_temp.as_admin();
  perform pg_temp.check('human approval is accepted only after full live revalidation',
    (select status='approved' and reviewed_by=v_reviewer from public.file_import_row_proposals where id=v_workshop_proposal));

  perform pg_temp.as_user(v_reviewer);
  begin
    perform public.review_file_import_row_proposal(v_finance_proposal,'approved','Attempt before cost mapping');
    v_ok := false;
  exception when others then v_ok := true; v_err := sqlerrm; end;
  perform pg_temp.check('Finance approval remains blocked until cost-type mapping: ' || coalesce(v_err,''),
    v_ok and v_err ilike '%cost type mapping%');
  perform public.review_file_import_row_proposal(v_finance_proposal,'rejected','Cost type mapping is unresolved');
  perform pg_temp.as_admin();
  perform pg_temp.check('an invalid proposal can still be rejected and attributed to the human reviewer',
    (select status='rejected' and reviewed_by=v_reviewer from public.file_import_row_proposals where id=v_finance_proposal));
end $$;

rollback;
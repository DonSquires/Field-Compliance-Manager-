-- Rollback-only authenticated truth table for agreement-anchored custom reports.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.check(p_label text, p_ok boolean) returns void
language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL [%]', p_label;
  end if;
  raise notice 'ok   [%]', p_label;
end
$$;

do $$
declare
  v_platform_owner uuid := gen_random_uuid();
  v_parent uuid := gen_random_uuid();
  v_provider uuid := gen_random_uuid();
  v_other_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_other_client uuid := gen_random_uuid();
  v_outsider_org uuid := gen_random_uuid();
  v_parent_admin uuid := gen_random_uuid();
  v_grand_master uuid := gen_random_uuid();
  v_other_provider_admin uuid := gen_random_uuid();
  v_client_user uuid := gen_random_uuid();
  v_client_viewer uuid := gen_random_uuid();
  v_outsider_user uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_other_agreement uuid := gen_random_uuid();
  v_same_client_agreement uuid := gen_random_uuid();
  v_provider_as_client_agreement uuid := gen_random_uuid();
  v_financial_agreement uuid := gen_random_uuid();
  v_place uuid := gen_random_uuid();
  v_other_place uuid := gen_random_uuid();
  v_location uuid := gen_random_uuid();
  v_other_location uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_zone uuid := gen_random_uuid();
  v_other_zone uuid := gen_random_uuid();
  v_other_site uuid := gen_random_uuid();
  v_person uuid := gen_random_uuid();
  v_other_person uuid := gen_random_uuid();
  v_person_record uuid := gen_random_uuid();
  v_vehicle uuid := gen_random_uuid();
  v_other_vehicle uuid := gen_random_uuid();
  v_site_observation uuid := gen_random_uuid();
  v_zone_observation uuid := gen_random_uuid();
  v_other_observation uuid := gen_random_uuid();
  v_cross_tenant_breach uuid := gen_random_uuid();
  v_patrol uuid := gen_random_uuid();
  v_route uuid := gen_random_uuid();
  v_route_checkpoint uuid := gen_random_uuid();
  v_route_visit uuid := gen_random_uuid();
  v_legacy_checkpoint uuid := gen_random_uuid();
  v_legacy_visit uuid := gen_random_uuid();
  v_options jsonb;
  v_result jsonb;
  v_pack uuid;
  v_checkpoint_pack uuid;
  v_private_pack uuid;
  v_email_pack uuid;
  v_updated_at timestamptz;
  v_delivery_attempt uuid;
  v_denied boolean := false;
begin
  insert into public.organizations (id, name, organization_type, parent_organization_id, active, status)
  values
    (v_platform_owner, 'Platform Owner', 'service_provider', null, true, 'active'),
    (v_parent, 'Custom Report Parent', 'service_provider', null, true, 'active'),
    (v_provider, 'Custom Report Branch', 'service_provider', v_parent, true, 'active'),
    (v_other_provider, 'Unrelated Report Provider', 'service_provider', null, true, 'active'),
    (v_client, 'Custom Report Client', 'private_enterprise', null, true, 'active'),
    (v_other_client, 'Other Report Client', 'private_enterprise', null, true, 'active'),
    (v_outsider_org, 'Custom Report Outsider', 'private_enterprise', null, true, 'active');

  insert into auth.users (id, instance_id, aud, role, email)
  values
    (v_grand_master, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'platform-owner@example.test'),
    (v_parent_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'custom-report-parent@example.test'),
    (v_other_provider_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other-report-provider@example.test'),
    (v_client_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'custom-report-client@example.test'),
    (v_client_viewer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'custom-report-viewer@example.test'),
    (v_outsider_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'custom-report-outsider@example.test');

  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name, email)
  values
    (v_grand_master, 'grand_master', v_platform_owner, v_platform_owner, 'Platform Owner', 'platform-owner@example.test'),
    (v_parent_admin, 'master', v_parent, v_parent, 'Custom Report Parent Admin', 'custom-report-parent@example.test'),
    (v_other_provider_admin, 'admin', v_other_provider, v_other_provider, 'Other Report Provider Admin', 'other-report-provider@example.test'),
    (v_client_user, 'client_admin', v_client, v_client, 'Custom Report Client User', 'approved@example.test'),
    (v_client_viewer, 'client_viewer', v_client, v_client, 'Custom Report Client Viewer', 'custom-report-viewer@example.test'),
    (v_outsider_user, 'client_admin', v_outsider_org, v_outsider_org, 'Custom Report Outsider', 'custom-report-outsider@example.test');

  insert into public.service_agreements (
    id, provider_organization_id, client_organization_id, name,
    agreement_type, starts_on, invitation_status, client_portal_reports_enabled
  ) values
    (v_financial_agreement, v_platform_owner, v_provider, 'Platform Subscription', 'financial', date '2098-01-01', 'accepted', false),
    (v_agreement, v_provider, v_client, 'Custom Reporting Agreement', 'operational', date '2098-01-01', 'accepted', true),
    (v_other_agreement, v_provider, v_other_client, 'Other Reporting Agreement', 'operational', date '2098-01-01', 'accepted', true),
    (v_same_client_agreement, v_other_provider, v_client, 'Unrelated Provider Agreement', 'operational', date '2098-01-01', 'accepted', true),
    (v_provider_as_client_agreement, v_other_provider, v_provider, 'Provider As Client Agreement', 'operational', date '2098-01-01', 'accepted', true);

  insert into public.crm_contacts (organization_id, first_name, last_name, email, is_primary)
  values (v_client, 'Approved', 'Recipient', 'approved@example.test', true);

  insert into public.canonical_places (id, place_kind, canonical_key, display_name, normalized_name)
  values
    (v_place, 'site', 'site:customreport', 'Custom Report Place', 'custom report place'),
    (v_other_place, 'site', 'site:otherreport', 'Other Report Place', 'other report place');

  insert into public.locations (id, organization_id, name, address, canonical_place_id)
  values
    (v_location, v_client, 'Custom Report House', '1 Report Road', v_place),
    (v_other_location, v_other_client, 'Other Report House', '2 Report Road', v_other_place);

  insert into public.client_sites (
    id, client_organization_id, organization_id,
    name, address, location_id, center_point
  )
  values
    (v_site, v_client, v_client, 'Selected Site', '1 Report Road', v_location,
      public.st_setsrid(public.st_makepoint(173.28, -41.27), 4326)),
    (v_other_site, v_other_client, v_other_client, 'Other Agreement Site', '2 Report Road', v_other_location,
      public.st_setsrid(public.st_makepoint(173.29, -41.28), 4326));

  insert into public.location_zones (id, organization_id, name, location_id, zone_type, module_key)
  values
    (v_zone, v_client, 'Selected Zone', v_location, 'general', 'patrol'),
    (v_other_zone, v_other_client, 'Other Agreement Zone', v_other_location, 'general', 'patrol');

  insert into public.service_agreement_locations (service_agreement_id, site_id, status)
  values (v_agreement, v_site, 'active'), (v_other_agreement, v_other_site, 'active')
  on conflict (service_agreement_id, site_id) do update set status = excluded.status;
  insert into public.service_agreement_locations (service_agreement_id, zone_id, status)
  values (v_agreement, v_zone, 'active');

  insert into public.canonical_people (id, canonical_key, display_name, normalized_name, review_state, date_of_birth, homeless_notes)
  values
    (v_person, 'person:custom-report', 'Selected Person', 'selected person', 'verified', date '1980-01-01', 'private person note'),
    (v_other_person, 'person:other-report', 'Other Person', 'other person', 'verified', date '1981-01-01', 'other private note');

  insert into public.person_records (id, organization_id, display_name, review_state)
  values (v_person_record, v_provider, 'Selected Person', 'verified');
  insert into public.canonical_person_links (
    canonical_person_id, source_table, source_id, organization_id, link_kind
  ) values (v_person, 'person_records', v_person_record, v_provider, 'projection');

  insert into public.canonical_vehicles (id, plate_number, make, model, registered_owner_name, homeless_notes)
  values
    (v_vehicle, 'REPORT1', 'Toyota', 'Corolla', 'Private Owner', 'private vehicle note'),
    (v_other_vehicle, 'REPORT2', 'Ford', 'Ranger', 'Other Owner', 'other vehicle note');

  insert into public.observations (
    id, organization_id, officer_id, plate_number, site_id, zone_id,
    observed_at, is_compliant, compliance_reason, module_key,
    person_record_id, canonical_person_id, canonical_vehicle_id
  ) values
    (v_site_observation, v_provider, v_parent_admin, 'REPORT1', v_site, null,
      '2098-01-05T10:00:00Z', true, 'Compliant visit', 'patrol', v_person_record, v_person, v_vehicle),
    (v_zone_observation, v_provider, v_parent_admin, 'REPORT1', null, v_zone,
      '2098-01-06T10:00:00Z', false, 'Follow-up required', 'patrol', v_person_record, v_person, v_vehicle),
    (v_other_observation, v_provider, v_parent_admin, 'REPORT2', v_other_site, null,
      '2098-01-07T10:00:00Z', false, 'Outside selected agreement', 'patrol', null, v_other_person, v_other_vehicle);

  insert into public.breach_alerts (id, organization_id, observation_id, zone_id, plate_number, breach_type, status, created_at)
  values
    (gen_random_uuid(), v_provider, v_zone_observation, v_other_zone, 'REPORT1', 'other', 'open', '2098-01-06T10:05:00Z'),
    (gen_random_uuid(), v_provider, v_other_observation, null, 'REPORT2', 'other', 'open', '2098-01-07T10:05:00Z'),
    (v_cross_tenant_breach, v_other_provider, v_zone_observation, v_zone, 'REPORT1', 'other', 'open', '2098-01-06T10:06:00Z');

  insert into public.patrol_routes (id, organization_id, site_id, name)
  values (v_route, v_provider, v_site, 'Selected Site Route');
  insert into public.patrol_route_checkpoints (id, patrol_route_id, name, sequence_order)
  values (v_route_checkpoint, v_route, 'Route Gate', 1);
  insert into public.patrol_checkpoints (
    id, organization_id, name, client_site_id, checkpoint_verification
  ) values (
    v_legacy_checkpoint, v_provider, 'Legacy Gate', v_site, 'verified'
  );
  insert into public.patrols (id, organization_id, officer_user_id, status, started_at)
  values (v_patrol, v_provider, v_parent_admin, 'completed', '2098-01-08T09:00:00Z');
  insert into public.patrol_checkpoint_visits (
    id, organization_id, patrol_id, checkpoint_id, route_checkpoint_id,
    officer_user_id, visited_at, scan_method, within_radius
  ) values (
    v_route_visit, v_provider, v_patrol, null, v_route_checkpoint,
    v_parent_admin, '2098-01-08T10:00:00Z', 'qr_camera', true
  ), (
    v_legacy_visit, v_provider, v_patrol, v_legacy_checkpoint, null,
    v_parent_admin, '2098-01-08T10:05:00Z', 'qr_camera', true
  );

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  v_options := public.get_custom_report_scope_options(
    v_agreement, date '2098-01-01', date '2098-01-31'
  );
  perform pg_temp.check(
    'parent admin receives only agreement-relevant scope options',
    (v_options->'sites') @> jsonb_build_array(jsonb_build_object('id', v_site, 'name', 'Selected Site'))
    and not (v_options->'sites' @> jsonb_build_array(jsonb_build_object('id', v_other_site)))
    and (v_options->'zones') @> jsonb_build_array(jsonb_build_object('id', v_zone, 'name', 'Selected Zone'))
    and (v_options->'people') @> jsonb_build_array(jsonb_build_object('id', v_person, 'name', 'Selected Person'))
    and (v_options->'vehicles') @> jsonb_build_array(jsonb_build_object('id', v_vehicle, 'plate', 'REPORT1'))
  );

  v_result := public.generate_custom_report_pack(
    v_agreement,
    date '2098-01-01',
    date '2098-01-31',
    'Selected activity report',
    array[v_site],
    array[v_zone],
    array[v_person],
    array[v_vehicle],
    array['summary', 'observations', 'breaches']
  );
  v_pack := (v_result->>'id')::uuid;
  perform pg_temp.check(
    'mixed scope uses OR within place and AND across person and vehicle dimensions',
    (v_result->>'status') = 'draft'
    and (v_result->>'observation_count')::integer = 2
    and (v_result->>'breach_count')::integer = 1
  );
  set local role postgres;

  perform pg_temp.check(
    'custom pack preserves the exact selected scope and excludes private identity attributes',
    (select report_kind = 'custom'
       and status = 'draft'
       and report_scope->>'match_semantics' = 'or_within_dimensions_and_across_dimensions'
      and report_scope->>'privacy_tier' = 'personal'
       and report_scope->'site_ids' = jsonb_build_array(v_site)
       and report_scope->'zone_ids' = jsonb_build_array(v_zone)
       and report_scope->'person_ids' = jsonb_build_array(v_person)
       and report_scope->'vehicle_ids' = jsonb_build_array(v_vehicle)
       and data->'summary'->>'observation_count' = '2'
       and data->'summary'->>'breach_count' = '1'
       and data->'breaches' @> jsonb_build_array(jsonb_build_object(
         'observation_id', v_zone_observation,
         'zone_id', v_zone,
         'zone_name', 'Selected Zone'
       ))
       and position('Other Agreement Zone' in data::text) = 0
      and not (data->'breaches' @> jsonb_build_array(jsonb_build_object('id', v_cross_tenant_breach)))
       and position('date_of_birth' in data::text) = 0
       and position('registered_owner_name' in data::text) = 0
       and position('private person note' in data::text) = 0
       and position('private vehicle note' in data::text) = 0
     from public.monthly_report_packs where id = v_pack)
  );

  perform pg_temp.check(
    'custom report creation is audited with the selected scope counts',
    exists(
      select 1 from public.audit_log
      where target_table = 'monthly_report_packs'
        and target_id = v_pack
        and action = 'custom_report_pack_generated'
        and metadata->>'site_count' = '1'
        and metadata->>'zone_count' = '1'
        and metadata->>'person_count' = '1'
        and metadata->>'vehicle_count' = '1'
    )
  );

  v_denied := false;
  begin
    insert into public.monthly_report_packs (
      organization_id, service_agreement_id, template_code, period_start,
      period_end, status, report_kind, report_scope, data, generated_at, generated_by
    ) values (
      v_provider, v_agreement, 'invalid_custom_scope', date '2098-01-01',
      date '2098-01-31', 'draft', 'custom', '{}'::jsonb, '{}'::jsonb,
      clock_timestamp(), v_parent_admin
    );
  exception when check_violation then
    v_denied := true;
  end;
  perform pg_temp.check('custom report scope requires every governed field', v_denied);

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  v_result := public.generate_custom_report_pack(
    v_agreement, date '2098-01-01', date '2098-01-31', 'Route checkpoint report',
    array[v_site], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['summary', 'checkpoint_visits']
  );
  v_checkpoint_pack := (v_result->>'id')::uuid;
  set local role postgres;
  perform pg_temp.check(
    'route-checkpoint visits are included with their agreement Site and frozen name',
    (select data->'summary'->>'checkpoint_visit_count' = '2'
       and data->'checkpoint_visits' @> jsonb_build_array(jsonb_build_object(
         'id', v_route_visit,
         'route_checkpoint_id', v_route_checkpoint,
         'checkpoint_kind', 'route',
         'checkpoint_name', 'Route Gate',
         'site_id', v_site,
         'site_name', 'Selected Site'
       ))
     from public.monthly_report_packs where id = v_checkpoint_pack)
  );
  perform pg_temp.check(
    'legacy checkpoint visits are included with their frozen Site name',
    (select data->'checkpoint_visits' @> jsonb_build_array(jsonb_build_object(
         'id', v_legacy_visit,
         'checkpoint_id', v_legacy_checkpoint,
         'checkpoint_kind', 'legacy',
         'checkpoint_name', 'Legacy Gate',
         'site_id', v_site,
         'site_name', 'Selected Site'
       ))
     from public.monthly_report_packs where id = v_checkpoint_pack)
  );

  perform pg_temp.check(
    'artifact and delivery state RPCs are callable only by the trusted service role',
    not has_function_privilege('authenticated', 'public.record_report_pack_pdf(uuid,timestamptz,text,text,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_report_pack_email_delivery(uuid,timestamptz,uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.finalize_report_pack_email_delivery(uuid,uuid,text,text,text,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.record_report_pack_pdf(uuid,timestamptz,text,text,text,uuid)', 'execute')
  );

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role service_role;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_pack;
  perform public.record_report_pack_pdf(
    v_pack,
    v_updated_at,
    'org/' || v_provider || '/report-packs/' || v_pack || '/reviewed.pdf',
    repeat('a', 64),
    'oracle-renderer',
    v_parent_admin
  );
  perform pg_temp.check(
    'PDF metadata and generation audit are committed together',
    exists(
      select 1 from public.audit_log
      where target_id = v_pack and action = 'monthly_report_pack_pdf_generated'
    )
  );
  set local role authenticated;
  perform pg_temp.check(
    'provider administrator can read the current draft PDF object',
    public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/reviewed.pdf'
    )
  );
  set local role postgres;
  update public.monthly_report_packs
  set delivery_attempt_id = gen_random_uuid(),
      delivery_started_at = clock_timestamp()
  where id = v_pack;

  v_denied := false;
  begin
    update public.monthly_report_packs
    set pdf_path = 'org/' || v_provider || '/report-packs/' || v_pack || '/replacement.pdf'
    where id = v_pack;
  exception when others then
    v_denied := sqlerrm like '%delivery is in progress%';
  end;
  perform pg_temp.check('active email delivery claim blocks PDF replacement', v_denied);

  perform set_config('request.jwt.claim.sub', v_client_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client cannot read the provider-private custom draft',
    not exists(select 1 from public.monthly_report_packs where id = v_pack)
    and not public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/reviewed.pdf'
    )
  );
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_pack;
  v_denied := false;
  begin
    perform public.review_monthly_report_pack(
      v_pack, v_updated_at, 'Concurrent rewrite', null, null, null, 'save'
    );
  exception when others then
    v_denied := sqlerrm like '%delivery is in progress%';
  end;
  perform pg_temp.check('active email delivery claim blocks concurrent report edits', v_denied);
  set local role postgres;
  update public.monthly_report_packs
  set delivery_started_at = clock_timestamp() - interval '11 minutes'
  where id = v_pack;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_pack;
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  perform public.review_monthly_report_pack(
    v_pack, v_updated_at, 'Selected activity report',
    'Two linked observations and one breach were found.', null, null, 'publish'
  );
  set local role postgres;

  perform pg_temp.check(
    'review publication clears any prior email delivery claim',
    (select delivery_attempt_id is null and delivery_started_at is null
     from public.monthly_report_packs where id = v_pack)
  );
  perform pg_temp.check(
    'review publication retains the old PDF path but makes the artifact stale',
    (select pdf_path is not null
       and pdf_source_updated_at is not null
       and pdf_source_updated_at <> updated_at
     from public.monthly_report_packs where id = v_pack)
  );

  perform set_config('request.jwt.claim.sub', v_client_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client cannot read a stale published PDF object',
    not public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/reviewed.pdf'
    )
  );
  set local role service_role;
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_pack;
  perform public.record_report_pack_pdf(
    v_pack,
    v_updated_at,
    'org/' || v_provider || '/report-packs/' || v_pack || '/published.pdf',
    repeat('c', 64),
    'oracle-renderer',
    v_parent_admin
  );

  perform set_config('request.jwt.claim.sub', v_client_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client admin reads the published report and its current PDF object',
    exists(select 1 from public.monthly_report_packs where id = v_pack and status = 'generated')
    and public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/published.pdf'
    )
  );
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_client_viewer::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client viewer cannot read a published personal-scope report or PDF object',
    not exists(select 1 from public.monthly_report_packs where id = v_pack)
    and not public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/published.pdf'
    )
  );
  set local role postgres;

  v_delivery_attempt := gen_random_uuid();
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  update public.monthly_report_packs
  set delivery_channel = 'email'
  where id = v_pack;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_pack;
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role service_role;
  v_denied := false;
  begin
    perform public.claim_report_pack_email_delivery(
      v_pack, v_updated_at, v_delivery_attempt, v_parent_admin, 'unapproved@example.test'
    );
  exception when others then
    v_denied := sqlerrm like '%active primary client contact%';
  end;
  perform pg_temp.check(
    'delivery claim rejects a recipient other than the active primary client contact',
    v_denied and (select delivery_attempt_id is null from public.monthly_report_packs where id = v_pack)
  );
  perform public.claim_report_pack_email_delivery(
    v_pack, v_updated_at, v_delivery_attempt, v_parent_admin, 'approved@example.test'
  );
  perform public.finalize_report_pack_email_delivery(
    v_pack, v_delivery_attempt, 'sent', 'approved@example.test', null, v_parent_admin
  );
  perform pg_temp.check(
    'transactional delivery claim and finalization are audited and preserve a current PDF',
    (select status = 'sent'
       and delivery_attempt_id is null
       and delivery_started_at is null
      and delivery_recipient = 'approved@example.test'
      and sent_to = 'approved@example.test'
       and pdf_source_updated_at = updated_at
     from public.monthly_report_packs where id = v_pack)
    and exists(select 1 from public.audit_log where target_id = v_pack and action = 'monthly_report_pack_delivery_claimed' and metadata->>'recipient' = 'approved@example.test')
    and exists(select 1 from public.audit_log where target_id = v_pack and action = 'monthly_report_pack_sent')
  );
  set local role postgres;

  v_denied := false;
  begin
    update public.monthly_report_packs set editorial = '{}'::jsonb where id = v_pack;
  exception when others then
    v_denied := sqlerrm like '%Sent report packs are immutable%';
  end;
  perform pg_temp.check('sent report rejects direct row updates', v_denied);
  v_denied := false;
  begin
    delete from public.monthly_report_packs where id = v_pack;
  exception when others then
    v_denied := sqlerrm like '%Sent report packs are immutable%';
  end;
  perform pg_temp.check('sent report rejects direct row deletion', v_denied);

  perform set_config('request.jwt.claim.sub', v_other_provider_admin::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'an upstream provider and shared-client provider cannot inherit report custody',
    not public.is_report_provider_custodian_for_org(v_provider)
    and public.is_admin_for_org(v_provider)
    and
    not exists(select 1 from public.monthly_report_packs where id = v_pack)
    and not public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/published.pdf'
    )
  );
  v_denied := false;
  begin
    perform public.get_custom_report_scope_options(
      v_agreement, date '2098-01-01', date '2098-01-31'
    );
  exception when others then
    v_denied := sqlerrm like '%Provider administrator access required%';
  end;
  perform pg_temp.check('upstream provider cannot inspect another providers custom report scope', v_denied);
  v_denied := false;
  begin
    insert into public.monthly_report_packs (
      organization_id, service_agreement_id, template_code, period_start,
      period_end, status, report_kind, report_scope, data, generated_at, generated_by
    ) values (
      v_provider, v_agreement, 'upstream_injection', date '2098-01-01', date '2098-01-31',
      'draft', 'custom', jsonb_build_object(
        'match_semantics', 'or_within_dimensions_and_across_dimensions',
        'privacy_tier', 'operational_metadata',
        'site_ids', '[]'::jsonb,
        'zone_ids', '[]'::jsonb,
        'person_ids', '[]'::jsonb,
        'vehicle_ids', '[]'::jsonb,
        'sections', jsonb_build_array('summary')
      ), '{}'::jsonb, clock_timestamp(), v_other_provider_admin
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  perform pg_temp.check('upstream provider cannot inject report pack rows', v_denied);
  set local role postgres;
  select updated_at into v_updated_at
  from public.monthly_report_packs where id = v_checkpoint_pack;
  perform set_config('request.jwt.claim.sub', v_other_provider_admin::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform public.review_monthly_report_pack(
      v_checkpoint_pack, v_updated_at, 'Unauthorized review', null, null, null, 'save'
    );
  exception when others then
    v_denied := sqlerrm like '%Provider custodian access required%';
  end;
  perform pg_temp.check('upstream provider cannot review another providers custom report', v_denied);

  perform set_config('request.jwt.claim.sub', v_grand_master::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'platform owner grand master and financial agreement do not confer subscriber report access',
    not public.is_report_provider_custodian_for_org(v_provider)
    and not exists(select 1 from public.monthly_report_packs where id = v_checkpoint_pack)
    and not public.can_read_current_report_pack_pdf(
      'org/' || v_provider || '/report-packs/' || v_pack || '/published.pdf'
    )
  );
  v_denied := false;
  begin
    perform public.get_custom_report_scope_options(
      v_agreement, date '2098-01-01', date '2098-01-31'
    );
  exception when others then
    v_denied := sqlerrm like '%Provider administrator access required%';
  end;
  perform pg_temp.check('platform owner grand master cannot inspect subscriber report scope', v_denied);

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  v_result := public.generate_custom_report_pack(
    v_agreement, date '2098-01-01', date '2098-01-31', 'Private email report',
    array[v_site], '{}'::uuid[], array[v_person], '{}'::uuid[], array['summary', 'observations']
  );
  v_private_pack := (v_result->>'id')::uuid;
  set local role postgres;
  update public.user_profiles set deactivated_at = clock_timestamp() where id = v_client_user;
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_private_pack;
  v_denied := false;
  begin
    perform public.review_monthly_report_pack(
      v_private_pack, v_updated_at, 'Private email report', null, null, null, 'publish'
    );
  exception when others then
    v_denied := sqlerrm like '%require an active client administrator%';
  end;
  perform pg_temp.check(
    'personal report cannot be published without an active entitled client administrator',
    v_denied and (select status = 'draft' from public.monthly_report_packs where id = v_private_pack)
  );

  set local role postgres;
  update public.service_agreements
  set client_portal_reports_enabled = false
  where id = v_agreement;
  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  v_result := public.generate_custom_report_pack(
    v_agreement, date '2098-01-01', date '2098-01-31', 'Operational email report',
    '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['summary']
  );
  v_email_pack := (v_result->>'id')::uuid;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_email_pack;
  perform public.review_monthly_report_pack(
    v_email_pack, v_updated_at, 'Operational email report', null, null, null, 'publish'
  );
  perform pg_temp.check(
    'operational metadata report falls back to approved email when portal delivery is unavailable',
    (select delivery_channel = 'email' and report_scope->>'privacy_tier' = 'operational_metadata'
     from public.monthly_report_packs where id = v_email_pack)
  );
  set local role service_role;
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_email_pack;
  perform public.record_report_pack_pdf(
    v_email_pack,
    v_updated_at,
    'org/' || v_provider || '/report-packs/' || v_email_pack || '/operational-email.pdf',
    repeat('b', 64),
    'oracle-renderer',
    v_parent_admin
  );
  select updated_at into v_updated_at from public.monthly_report_packs where id = v_email_pack;
  v_delivery_attempt := gen_random_uuid();
  perform public.claim_report_pack_email_delivery(v_email_pack, v_updated_at, v_delivery_attempt, v_parent_admin, null);
  perform public.finalize_report_pack_email_delivery(
    v_email_pack, v_delivery_attempt, 'failed', null, 'Oracle SMTP failure', v_parent_admin
  );
  perform pg_temp.check(
    'failed email finalization stales the PDF and records the failure audit atomically',
    (select status = 'failed' and delivery_error = 'Oracle SMTP failure' and pdf_source_updated_at is null
     from public.monthly_report_packs where id = v_email_pack)
    and exists(select 1 from public.audit_log where target_id = v_email_pack and action = 'monthly_report_pack_send_failed')
  );

  perform set_config('request.jwt.claim.sub', v_outsider_user::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform public.generate_custom_report_pack(
      v_agreement, date '2098-01-01', date '2098-01-31', 'Forbidden report',
      array[v_site], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['summary']
    );
  exception when others then
    v_denied := sqlerrm like '%Provider administrator access required%';
  end;
  perform pg_temp.check('unrelated user cannot generate a custom report', v_denied);
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_parent_admin::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform public.generate_custom_report_pack(
      v_agreement, date '2098-01-01', date '2098-01-31', 'Cross-agreement report',
      array[v_other_site], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['summary']
    );
  exception when others then
    v_denied := sqlerrm like '%outside this agreement%';
  end;
  perform pg_temp.check('cross-agreement place scope is rejected', v_denied);

  v_denied := false;
  begin
    perform public.generate_custom_report_pack(
      v_agreement, date '2097-12-01', date '2098-01-05', 'Outside agreement term',
      '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], array['summary']
    );
  exception when others then
    v_denied := sqlerrm like '%must fall within the service agreement term%';
  end;
  perform pg_temp.check('report period cannot extend outside the agreement term', v_denied);

  v_denied := false;
  begin
    perform public.generate_custom_report_pack(
      v_agreement, date '2098-01-01', date '2098-01-31', 'Unsupported relationship report',
      '{}'::uuid[], '{}'::uuid[], array[v_person], '{}'::uuid[], array['incidents']
    );
  exception when others then
    v_denied := sqlerrm like '%do not have a governed person or vehicle link%';
  end;
  perform pg_temp.check('entity filters cannot imply unsupported incident relationships', v_denied);
end
$$;

rollback;
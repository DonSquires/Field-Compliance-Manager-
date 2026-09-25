-- Rollback-only authenticated truth table for report review, publication, and
-- client delivery routing.
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
  v_provider uuid := gen_random_uuid();
  v_client_portal uuid := gen_random_uuid();
  v_client_email uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_client_user uuid := gen_random_uuid();
  v_outsider_user uuid := gen_random_uuid();
  v_portal_agreement uuid := gen_random_uuid();
  v_email_agreement uuid := gen_random_uuid();
  v_portal_pack uuid;
  v_email_pack uuid;
  v_updated_at timestamptz;
  v_result jsonb;
  v_denied boolean := false;
begin
  insert into public.organizations (id, name, organization_type, active, status)
  values
    (v_provider, 'Report Review Provider', 'service_provider', true, 'active'),
    (v_client_portal, 'Report Review Portal Client', 'government', true, 'active'),
    (v_client_email, 'Report Review Email Client', 'private_enterprise', true, 'active'),
    (v_outsider, 'Report Review Outsider', 'private_enterprise', true, 'active');

  insert into auth.users (id, instance_id, aud, role, email)
  values
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'report-review-admin@example.test'),
    (v_client_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'report-review-client@example.test'),
    (v_outsider_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'report-review-outsider@example.test');

  insert into public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  values
    (v_admin, 'master', v_provider, v_provider, 'Report Review Admin'),
    (v_client_user, 'client_admin', v_client_portal, v_client_portal, 'Report Review Client'),
    (v_outsider_user, 'client_admin', v_outsider, v_outsider, 'Report Review Outsider');

  insert into public.service_agreements (
    id, provider_organization_id, client_organization_id, name,
    agreement_type, starts_on, invitation_status,
    client_portal_reports_enabled, monthly_report_template_code
  ) values
    (
      v_portal_agreement, v_provider, v_client_portal, 'Portal Reporting Agreement',
      'operational', date '2098-01-01', 'accepted', true, 'review-monthly'
    ),
    (
      v_email_agreement, v_provider, v_client_email, 'Email Reporting Agreement',
      'operational', date '2098-01-01', 'accepted', true, 'review-monthly'
    );

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
  perform pg_temp.check(
    'generation writes two provider-private drafts',
    public.generate_due_report_packs(date '2098-01-01', date '2098-01-31') = 2
  );
  set local role postgres;

  select id, updated_at into v_portal_pack, v_updated_at
  from public.monthly_report_packs
  where service_agreement_id = v_portal_agreement;
  select id into v_email_pack
  from public.monthly_report_packs
  where service_agreement_id = v_email_agreement;

  perform pg_temp.check(
    'source metrics remain a separate generated snapshot',
    (select status = 'draft' and data ? 'delivery' and editorial = '{}'::jsonb
     from public.monthly_report_packs where id = v_portal_pack)
  );

  perform set_config('request.jwt.claim.sub', v_client_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client login cannot read a provider draft',
    not exists(select 1 from public.monthly_report_packs where id = v_portal_pack)
  );
  begin
    perform public.review_monthly_report_pack(
      v_portal_pack, v_updated_at, 'Changed by client', null, null, null, 'save'
    );
  exception when others then
    v_denied := sqlerrm like '%Provider administrator access required%';
  end;
  perform pg_temp.check('client login cannot edit a provider draft', v_denied);
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_result := public.review_monthly_report_pack(
    v_portal_pack,
    v_updated_at,
    'January accountability report',
    'Delivery remained within the agreed operating plan.',
    'The client can review this report in the live portal.',
    'Review the two open follow-up actions before next month.',
    'save'
  );
  perform pg_temp.check(
    'provider saves editable editorial content without publishing',
    v_result->>'status' = 'draft'
    and v_result->'editorial'->>'title' = 'January accountability report'
    and v_result->>'delivery_channel' is null
  );

  v_denied := false;
  begin
    perform public.review_monthly_report_pack(
      v_portal_pack, v_updated_at, 'Stale overwrite', null, null, null, 'save'
    );
  exception when others then
    v_denied := sqlerrm like '%changed since it was opened%';
  end;
  perform pg_temp.check('stale review cannot overwrite a newer edit', v_denied);

  select updated_at into v_updated_at
  from public.monthly_report_packs where id = v_portal_pack;
  v_result := public.review_monthly_report_pack(
    v_portal_pack,
    v_updated_at,
    'January accountability report',
    'Delivery remained within the agreed operating plan.',
    'The client can review this report in the live portal.',
    'Review the two open follow-up actions before next month.',
    'publish'
  );
  perform pg_temp.check(
    'publishing routes an active client login to the live portal',
    v_result->>'status' = 'generated'
    and v_result->>'delivery_channel' = 'portal'
    and (v_result->>'client_has_login')::boolean
  );

  select updated_at into v_updated_at
  from public.monthly_report_packs where id = v_email_pack;
  v_result := public.review_monthly_report_pack(
    v_email_pack,
    v_updated_at,
    'January emailed report',
    'No active client login exists for this agreement.',
    null,
    null,
    'publish'
  );
  perform pg_temp.check(
    'publishing retains email delivery when no client login exists',
    v_result->>'status' = 'generated'
    and v_result->>'delivery_channel' = 'email'
    and not (v_result->>'client_has_login')::boolean
  );
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_client_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'client login reads the published live report and editorial content',
    exists(
      select 1 from public.monthly_report_packs
      where id = v_portal_pack
        and status = 'generated'
        and editorial->>'executive_summary' = 'Delivery remained within the agreed operating plan.'
    )
  );
  set local role postgres;

  perform set_config('request.jwt.claim.sub', v_outsider_user::text, true);
  set local role authenticated;
  perform pg_temp.check(
    'unrelated client cannot read a published report',
    not exists(select 1 from public.monthly_report_packs where id = v_portal_pack)
  );
  set local role postgres;

  update public.monthly_report_packs set status = 'sent' where id = v_email_pack;
  select updated_at into v_updated_at
  from public.monthly_report_packs where id = v_email_pack;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform public.review_monthly_report_pack(
      v_email_pack, v_updated_at, 'Rewrite issued report', null, null, null, 'save'
    );
  exception when others then
    v_denied := sqlerrm like '%Sent report packs are immutable%';
  end;
  perform pg_temp.check('sent report remains immutable after delivery', v_denied);
  set local role postgres;

  perform pg_temp.check(
    'review save and publish actions are audited',
    (select count(*) = 3
     from public.audit_log
     where target_table = 'monthly_report_packs'
       and target_id in (v_portal_pack, v_email_pack)
       and action in ('monthly_report_pack_review_saved', 'monthly_report_pack_published'))
  );
end
$$;

rollback;
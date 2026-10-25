-- Behavioural truth table for Extra works orders and dispatch billing basis.
-- Runs in a transaction and rolls back.
BEGIN;
SET LOCAL role postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL role authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN SET LOCAL role postgres; END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.raises(p_sql text, p_fragment text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN others THEN
  IF sqlerrm NOT LIKE '%' || p_fragment || '%' THEN RAISE NOTICE 'unexpected error: %', sqlerrm; END IF;
  RETURN sqlerrm LIKE '%' || p_fragment || '%';
END $$;

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_outsider_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_other_agreement uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_order jsonb;
  v_replay jsonb;
  v_future jsonb;
  v_foreign jsonb;
  v_job uuid;
  v_result jsonb;
  v_line_basis text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Extra Works Provider', 'service_provider', true, 'active'),
    (v_client, 'Extra Works Client', 'government', true, 'active'),
    (v_outsider_org, 'Unrelated Provider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Extra Works Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Outsider Admin');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status) VALUES
    (v_agreement, v_provider, v_client, 'Base Security Agreement', 'operational', current_date - 30, 'accepted'),
    (v_other_agreement, v_provider, v_client, 'Second Agreement', 'operational', current_date - 30, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  VALUES (v_site, v_client, v_provider, 'Forest Gate', '1 Forest Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES (v_agreement, v_site, 'active') ON CONFLICT DO NOTHING;
    UPDATE public.client_sites SET service_agreement_id = v_agreement WHERE id = v_site;
    INSERT INTO public.reference_codes (organization_id, code_type, code, name, is_active) VALUES (v_provider, 'charge_code', '42061', 'Security | Lock | Remove', true);

  PERFORM pg_temp.as_user(v_admin);
  v_order := public.manage_agreement_extra_work_order(v_request, v_agreement, 'create', NULL, NULL,
    'Hunter weekend lock access', 'Remove locks Friday and replace Monday for public hunter access.',
    'written', 'Client email 24 Oct', '42061', 'Hourly plus km', current_date - 7, NULL, current_date + 60, NULL);
  PERFORM pg_temp.check('create assigns the first agreement reference', v_order->>'reference' = 'EW-001' AND (v_order->>'replayed')::boolean = false);

  v_replay := public.manage_agreement_extra_work_order(v_request, v_agreement, 'create', NULL, NULL,
    'Hunter weekend lock access', 'Remove locks Friday and replace Monday for public hunter access.',
    'written', 'Client email 24 Oct', '42061', 'Hourly plus km', current_date - 7, NULL, current_date + 60, NULL);
  PERFORM pg_temp.check('create replay is idempotent', v_replay->>'id' = v_order->>'id' AND (v_replay->>'replayed')::boolean);

  PERFORM pg_temp.check('verbal authority needs a note', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, null, null, %L, %L, %L, null, null, null, current_date, null, null, null)',
    gen_random_uuid(), v_agreement, 'create', 'Gate escort', 'Escort contractor through closed gate.', 'verbal'), 'Verbal authority'));
  PERFORM pg_temp.check('unknown charge code is refused', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, null, null, %L, %L, %L, null, %L, null, current_date, null, null, null)',
    gen_random_uuid(), v_agreement, 'create', 'Gate escort', 'Escort contractor through closed gate.', 'written', '99999'), 'not in this organisation'));
  PERFORM pg_temp.check('work cannot start before the agreement', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, null, null, %L, %L, %L, null, null, null, current_date - 90, null, null, null)',
    gen_random_uuid(), v_agreement, 'create', 'Gate escort', 'Escort contractor through closed gate.', 'written'), 'before the agreement'));
  PERFORM pg_temp.check('stale update is refused', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, %L, %L, %L, %L, %L, null, null, null, current_date - 7, null, null, null)',
    gen_random_uuid(), v_agreement, 'update', v_order->>'id', now() - interval '1 day', 'Hunter weekend lock access', 'Remove locks Friday and replace Monday.', 'written'), 'changed since it was opened'));

  v_future := public.manage_agreement_extra_work_order(gen_random_uuid(), v_agreement, 'create', NULL, NULL,
    'Summer fire watch', 'Additional fire watch patrols during the total fire ban.', 'purchase_order', 'PO 5512', NULL, NULL, current_date + 10, NULL, NULL, NULL);
  v_foreign := public.manage_agreement_extra_work_order(gen_random_uuid(), v_other_agreement, 'create', NULL, NULL,
    'Other contract extra', 'Work authorised under a different agreement.', 'written', NULL, NULL, NULL, current_date - 7, NULL, NULL, NULL);
  PERFORM pg_temp.check('second order on the agreement gets the next reference', v_future->>'reference' = 'EW-002' AND v_foreign->>'reference' = 'EW-001');

  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('outsider cannot create an order', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, null, null, %L, %L, %L, null, null, null, current_date, null, null, null)',
    gen_random_uuid(), v_agreement, 'create', 'Gate escort', 'Escort contractor through closed gate.', 'written'), 'Provider administrator required'));
  PERFORM pg_temp.check('outsider cannot read orders', NOT EXISTS (SELECT 1 FROM public.agreement_extra_work_orders WHERE service_agreement_id = v_agreement));

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('provider admin reads orders', (SELECT count(*) FROM public.agreement_extra_work_orders WHERE service_agreement_id = v_agreement) = 2);

  SELECT id INTO v_job FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'lock_access', 'normal', 60, NULL, 'Friday lock removal', NULL);
  PERFORM pg_temp.check('new dispatch job starts unclassified', (SELECT billing_basis IS NULL FROM public.dispatch_jobs WHERE id = v_job));

  PERFORM pg_temp.check('direct billing update is blocked', pg_temp.raises(format(
    'update public.dispatch_jobs set billing_basis = %L where id = %L', 'contract', v_job), 'set_dispatch_job_billing_basis'));
  PERFORM pg_temp.check('direct insert with a basis is blocked', pg_temp.raises(format(
    'insert into public.dispatch_jobs(organization_id, service_agreement_id, client_site_id, job_type, billing_basis) values (%L, %L, %L, %L, %L)',
    v_provider, v_agreement, v_site, 'x', 'extra'), 'set_dispatch_job_billing_basis'));
  PERFORM pg_temp.check('an order from another agreement is refused', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, %L, null)', v_job, 'extra', v_foreign->>'id'), 'same service agreement'));
  PERFORM pg_temp.check('an order not yet in force is refused', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, %L, null)', v_job, 'extra', v_future->>'id'), 'was not in force'));
  PERFORM pg_temp.check('contract jobs cannot sit under an order', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, %L, null)', v_job, 'contract', v_order->>'id'), 'Only Extra jobs'));

  v_result := public.set_dispatch_job_billing_basis(v_job, 'extra', (v_order->>'id')::uuid, NULL);
  PERFORM pg_temp.check('first classification needs no reason and links the order',
    (v_result->>'changed')::boolean AND v_result->>'extra_work_order_reference' = 'EW-001'
    AND (SELECT billing_basis = 'extra' AND extra_work_order_id = (v_order->>'id')::uuid AND billing_basis_set_by = v_admin FROM public.dispatch_jobs WHERE id = v_job));
  v_result := public.set_dispatch_job_billing_basis(v_job, 'extra', (v_order->>'id')::uuid, NULL);
  PERFORM pg_temp.check('same classification is a no-op', NOT (v_result->>'changed')::boolean);
  PERFORM pg_temp.check('reclassification needs a reason', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, null, null)', v_job, 'contract'), 'Say why'));

  PERFORM pg_temp.as_admin();
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description)
  VALUES (v_provider, v_job, v_client, v_agreement, 'hourly', 'Lock removal');
  SELECT billing_basis INTO v_line_basis FROM public.dispatch_job_charge_lines WHERE source_dispatch_id = v_job;
  PERFORM pg_temp.check('charge line inherits the job basis', v_line_basis = 'extra');

  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.set_dispatch_job_billing_basis(v_job, 'contract', NULL, 'Regular gate role, not extra');
  PERFORM pg_temp.check('reclassification with a reason moves the job and its uninvoiced lines',
    (SELECT billing_basis = 'contract' AND extra_work_order_id IS NULL FROM public.dispatch_jobs WHERE id = v_job)
    AND (SELECT billing_basis FROM public.dispatch_job_charge_lines WHERE source_dispatch_id = v_job) = 'contract');
  PERFORM pg_temp.check('classification is audited with before and after',
    (SELECT count(*) FROM public.audit_log WHERE target_id = v_job AND action = 'dispatch_job_billing_basis_set') = 2
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE target_id = v_job AND metadata->>'reason' = 'Regular gate role, not extra' AND metadata->'before'->>'billing_basis' = 'extra'));

  PERFORM pg_temp.check('ending needs a reason', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, %L, %L, null, null, null, null, null, null, null, current_date, null, null)',
    gen_random_uuid(), v_agreement, 'end', v_order->>'id', (SELECT updated_at FROM public.agreement_extra_work_orders WHERE id = (v_order->>'id')::uuid)), 'Say why'));
  v_result := public.manage_agreement_extra_work_order(gen_random_uuid(), v_agreement, 'end', (v_order->>'id')::uuid,
    (SELECT updated_at FROM public.agreement_extra_work_orders WHERE id = (v_order->>'id')::uuid),
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, current_date - 1, NULL, 'Hunting season closed');
  PERFORM pg_temp.check('ending records the end date, reason, and clears a later review date',
    (v_result->>'ends_on')::date = current_date - 1 AND v_result->>'end_reason' = 'Hunting season closed' AND v_result->>'review_on' IS NULL
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE target_id = (v_order->>'id')::uuid AND action = 'agreement_extra_work_order_end'));
  PERFORM pg_temp.check('an ended order is locked', pg_temp.raises(format(
    'select public.manage_agreement_extra_work_order(%L, %L, %L, %L, %L, %L, %L, %L, null, null, null, current_date - 7, null, null, null)',
    gen_random_uuid(), v_agreement, 'update', v_order->>'id', v_result->>'updated_at', 'Hunter weekend lock access', 'Remove locks Friday and replace Monday.', 'written'), 'has ended'));

  PERFORM pg_temp.as_admin();
  UPDATE public.dispatch_job_charge_lines SET invoice_line_item_id = gen_random_uuid() WHERE source_dispatch_id = v_job;
  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('invoiced jobs cannot be reclassified', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, null, %L)', v_job, 'extra', 'late change'), 'already invoiced'));

  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;

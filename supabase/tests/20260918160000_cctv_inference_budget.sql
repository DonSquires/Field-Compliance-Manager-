-- Behavioural truth table for 20260918160000_cctv_inference_budget.sql.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE postgres;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_stranger uuid := gen_random_uuid();
  v_evidence uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_lease uuid := gen_random_uuid();
  v_claimed record;
  v_result jsonb;
  v_budget public.cctv_inference_budgets%rowtype;
  v_row public.inference_jobs%rowtype;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_BUDGET_ORG', 'service_provider'), (v_other_org, 'T_BUDGET_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'BudgetAdmin'), (v_officer, v_org, 'officer', 'BudgetOfficer'), (v_stranger, v_other_org, 'admin', 'BudgetStranger');
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path)
  VALUES (v_evidence, v_org, 'cctv_review', 'video', 'org/t/budget.mp4');
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
  VALUES (v_job, v_org, v_evidence, 'video_motion', 'queued');

  -- ── defaults ──
  PERFORM pg_temp.as_service();
  v_result := public.cctv_inference_budget_check(v_org);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an organisation without a budget row gets the platform default and is not exhausted',
    (v_result->>'daily_frame_budget')::int = 20000 AND (v_result->>'frames_used_today')::int = 0 AND NOT (v_result->>'exhausted')::boolean);

  -- ── setting a budget ──
  BEGIN
    PERFORM pg_temp.as_user(v_officer);
    PERFORM public.set_cctv_inference_budget(v_org, 500, 'Officer tries');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an officer cannot set the budget', v_error LIKE '%administrator%');
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.set_cctv_inference_budget(v_org, 500, 'Stranger tries');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an administrator of another organisation cannot set it either', v_error LIKE '%administrator%');
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.set_cctv_inference_budget(v_org, 10, 'Too small');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a budget below the floor is refused', v_error LIKE '%at least 100%');
  PERFORM pg_temp.as_user(v_admin);
  v_budget := public.set_cctv_inference_budget(v_org, 300, 'Pilot tenant, keep GPU spend small');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the administrator sets a budget and it is audited',
    v_budget.daily_frame_budget = 300 AND v_budget.set_by = v_admin
    AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_inference_budget_set' AND a.organization_id = v_org AND (a.metadata->>'daily_frame_budget')::int = 300));
  PERFORM pg_temp.as_user(v_officer);
  PERFORM pg_temp.check('the organisation can read its own budget row', (SELECT daily_frame_budget FROM public.cctv_inference_budgets WHERE organization_id = v_org) = 300);
  PERFORM pg_temp.as_user(v_stranger);
  PERFORM pg_temp.check('another organisation cannot see it', NOT EXISTS (SELECT 1 FROM public.cctv_inference_budgets WHERE organization_id = v_org));
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    UPDATE public.cctv_inference_budgets SET daily_frame_budget = 999999 WHERE organization_id = v_org;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the budget table is not writable directly from a browser session', v_error LIKE '%permission denied%' OR (SELECT daily_frame_budget FROM public.cctv_inference_budgets WHERE organization_id = v_org) = 300);

  -- ── metering ──
  PERFORM pg_temp.as_service();
  v_result := public.record_cctv_inference_usage(v_job, jsonb_build_object('frames_sampled', 120, 'frames_recognised', 4, 'frames_sent', 124, 'gpu_calls', 21, 'gpu_ms', 61234, 'plate', 'ABC123'));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('usage is recorded as counts only, attributed to the organisation',
    (v_result->>'frames_used_today')::int = 124
    AND EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_inference_usage_recorded' AND a.target_id = v_job AND a.organization_id = v_org
                  AND (a.metadata->>'gpu_calls')::int = 21 AND NOT (a.metadata ? 'plate')));
  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_inference_usage(v_job, jsonb_build_object('frames_sent', 200, 'gpu_calls', 30));
  v_result := public.cctv_inference_budget_check(v_org);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('once today''s frames pass the budget the check reports exhausted with a reset time',
    (v_result->>'frames_used_today')::int = 324 AND (v_result->>'exhausted')::boolean AND (v_result->>'remaining')::int = 0 AND (v_result->>'resets_at') IS NOT NULL);
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.record_cctv_inference_usage(v_job, '{"frames_sent": 1}'::jsonb);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('only the service identity records usage', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  -- ── deferral ──
  PERFORM pg_temp.as_service();
  SELECT * INTO v_claimed FROM public.claim_cctv_inference_job(v_job, v_lease, 900);
  PERFORM pg_temp.check('the worker claims the job', v_claimed.status = 'processing');
  PERFORM pg_temp.check('a deferral with the wrong lease changes nothing', NOT public.defer_cctv_inference_job(v_job, gen_random_uuid(), 'wrong lease', 900));
  PERFORM pg_temp.check('the worker defers the claimed job', public.defer_cctv_inference_job(v_job, v_lease, 'Deferred: daily inference budget reached; resumes automatically', 900));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.inference_jobs WHERE id = v_job;
  PERFORM pg_temp.check('a deferred job is queued again with a not-before time, no lease, and a plain-words label',
    v_row.status = 'queued' AND v_row.stage = 'deferred' AND v_row.lease_token IS NULL AND v_row.lease_expires_at > clock_timestamp()
    AND v_row.progress_label LIKE 'Deferred: daily inference budget reached%' AND v_row.attempt_count = 0);
  PERFORM pg_temp.check('the deferral is audited', EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_inference_job_deferred' AND a.target_id = v_job));
  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('stale recovery leaves a deferred (queued) job alone', public.recover_stale_cctv_inference_jobs() = 0);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the not-before time survives recovery', (SELECT lease_expires_at FROM public.inference_jobs WHERE id = v_job) > clock_timestamp());

  -- ── readout ──
  PERFORM pg_temp.as_user(v_officer);
  v_result := public.cctv_inference_usage(v_org, 7);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the organisation sees its usage, budget, exhaustion and deferred jobs',
    (v_result->>'daily_frame_budget')::int = 300 AND NOT (v_result->>'budget_is_default')::boolean AND (v_result->>'frames_used_today')::int = 324
    AND (v_result->>'exhausted')::boolean AND (v_result->>'deferred_jobs')::int = 1
    AND jsonb_array_length(v_result->'days') = 1 AND (v_result->'days'->0->>'frames_sent')::int = 324 AND (v_result->'days'->0->>'jobs')::int = 2);
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.cctv_inference_usage(v_org, 7);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('another organisation cannot read the usage', v_error LIKE '%access denied%');
END $$;
ROLLBACK;

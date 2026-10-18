DO $$
DECLARE
  source public.builder_jobs;
  parent public.builder_jobs;
  child public.builder_jobs;
  retried public.builder_jobs;
  unbound public.builder_jobs;
BEGIN
  SELECT * INTO source FROM public.builder_jobs
  WHERE id = 'f6df4b84-03f1-4ad2-adfb-7d7fd9d32704';
  IF source.id IS NULL THEN RAISE EXCEPTION 'Owner-approved source fixture is unavailable'; END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT * INTO parent FROM public.builder_create_job_v2(
    source.organization_id, source.project_id, 'Continuation rollback probe', 'Synthetic brief',
    repeat('a', 40), 'main', NULL, true, false, 'human', NULL, 'prepare_release', 'production'
  );
  PERFORM public.builder_autopilot_bind(parent.id, source.autopilot_requested_by, NULL);
  child := public.builder_create_autopilot_child(parent.id, repeat('b',40), parent.title, parent.task_description, NULL, true, false, 'human');
  IF child.parent_job_id <> parent.id OR child.organization_id <> parent.organization_id
     OR child.project_id <> parent.project_id OR child.target_sha <> repeat('b',40)
     OR child.autopilot_requested_by <> source.autopilot_requested_by OR child.autopilot_state <> 'driving'
     OR child.target_environment <> 'production' OR child.requested_action <> 'prepare_release' THEN
    RAISE EXCEPTION 'FAIL: continuation lost lineage, authority, pin or release policy';
  END IF;
  IF (SELECT count(*) FROM public.builder_job_steps WHERE job_id=child.id) <> 8 THEN
    RAISE EXCEPTION 'FAIL: continuation did not create the governed pipeline';
  END IF;
  retried := public.builder_create_autopilot_child(parent.id, repeat('c',40), parent.title, parent.task_description, NULL, true, false, 'human');
  IF retried.id <> child.id OR retried.target_sha <> child.target_sha THEN
    RAISE EXCEPTION 'FAIL: lost-response retry created another job or changed its pin';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_audit_events WHERE job_id=child.id AND new_value->>'parent_job_id'=parent.id::text) THEN
    RAISE EXCEPTION 'FAIL: lineage audit is missing';
  END IF;
  BEGIN
    PERFORM public.builder_create_autopilot_child(parent.id, repeat('c',40), 'Unsafe review downgrade', parent.task_description, NULL, true, false, 'none');
    RAISE EXCEPTION 'FAIL: production review policy was weakened';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Parent code-review policy cannot be weakened%' THEN RAISE; END IF;
  END;
  SELECT * INTO unbound FROM public.builder_create_job_v2(
    source.organization_id, source.project_id, 'Unbound rollback probe', 'Synthetic brief',
    repeat('a',40)
  );
  BEGIN
    PERFORM public.builder_create_autopilot_child(unbound.id, repeat('b',40), unbound.title, unbound.task_description);
    RAISE EXCEPTION 'FAIL: an unbound job acquired standing authority';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Parent autopilot requester cannot approve%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.builder_jobs WHERE parent_job_id=unbound.id) THEN
    RAISE EXCEPTION 'FAIL: rejected continuation left an orphan job';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  BEGIN
    PERFORM public.builder_create_autopilot_child(parent.id, repeat('b',40), parent.title, parent.task_description);
    RAISE EXCEPTION 'FAIL: non-service caller accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Service identity required%' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE p record; j1 public.builder_jobs; j2 public.builder_jobs; j3 public.builder_jobs; n int;
BEGIN
  SELECT id, organization_id INTO p FROM public.builder_projects WHERE status='active' LIMIT 1;
  UPDATE public.builder_jobs SET status='cancelled' WHERE autopilot_source='main_monitor' AND status NOT IN ('failed','cancelled','deployed');
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
  j1 := public.builder_open_main_health_repair(p.organization_id, p.id, repeat('a',40), repeat('a',40), 'Repair probe', 'probe brief', ARRAY['apps/web/src/lib/x.guard.test.ts']);
  j2 := public.builder_open_main_health_repair(p.organization_id, p.id, repeat('b',40), repeat('b',40), 'Repair probe', 'probe brief', ARRAY['apps/web/src/lib/x.guard.test.ts']);
  IF j1.id <> j2.id THEN RAISE EXCEPTION 'FAIL: same file set opened a second root repair'; END IF;
  j3 := public.builder_open_main_health_repair(p.organization_id, p.id, repeat('c',40), repeat('c',40), 'Repair probe', 'probe brief', ARRAY['apps/web/src/lib/y.guard.test.ts']);
  IF j3.id = j1.id THEN RAISE EXCEPTION 'FAIL: a different file set reused the repair'; END IF;
  PERFORM set_config('role', 'postgres', true);
  UPDATE public.builder_jobs SET status='failed' WHERE id=j1.id;
  PERFORM set_config('role', 'service_role', true);
  j2 := public.builder_open_main_health_repair(p.organization_id, p.id, repeat('d',40), repeat('d',40), 'Repair probe', 'probe brief', ARRAY['apps/web/src/lib/x.guard.test.ts']);
  IF j2.id = j1.id THEN RAISE EXCEPTION 'FAIL: a failed repair blocked a fresh one'; END IF;
  RAISE NOTICE 'PASS';
END $$;

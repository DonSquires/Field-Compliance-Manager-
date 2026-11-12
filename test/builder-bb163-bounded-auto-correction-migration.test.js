'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261113100000_builder_bb163_bounded_auto_correction.sql');

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8');
}

test('BB-163 correction transition is service-only and retains its bounded report metadata', () => {
  assert.ok(fs.existsSync(migrationPath), 'the BB-163 correction migration must exist');
  const migration = readMigration();
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_autopilot_begin_bb163_correction\(_job_id uuid, _blockers text\)/);
  assert.match(migration, /IF auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  assert.match(migration, /bb163_auto_correction_rounds/);
  assert.match(migration, /bb163_auto_correction_history/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /TO service_role/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_autopilot_record/);
});

test('BB-163 correction is atomic, bounded, same-job, and preserves step attempts', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 90000,
}, async () => {
  const name = `fcm-bb163-correction-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'isolated PostgreSQL becomes ready');
    const sql = query => execFileSync('docker', ['exec', '-i', name, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: `DO $$ BEGIN PERFORM set_config('test.role','service_role',false); END $$;\n${query}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const fails = (query, expected) => assert.throws(() => sql(query), error => expected.test(String(error.stderr || error.message)));

    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
      CREATE TABLE public.builder_jobs(
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, human_reference text, status text NOT NULL,
        autopilot_state text NOT NULL, autopilot_source text, repair_risk text, autopilot_report jsonb,
        autopilot_requested_by uuid, autopilot_updated_at timestamptz, autopilot_reported_at timestamptz,
        source_friction_packet_id uuid, current_step_name text, current_step_index integer, last_error text,
        workspace_published_at timestamptz, workspace_published_head_sha text, workspace_pull_request_url text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_job_steps(
        id uuid PRIMARY KEY, job_id uuid NOT NULL, step_id text NOT NULL, status text NOT NULL,
        attempt_count integer NOT NULL DEFAULT 0, started_at timestamptz, completed_at timestamptz,
        evidence_refs jsonb NOT NULL DEFAULT '[]', artifact_ids uuid[], retryable boolean NOT NULL DEFAULT false,
        error text, result_summary text, blocked_reason text, blocked_dependencies text[],
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.builder_worker_runs(job_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE public.builder_model_runs(job_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE public.builder_approvals(job_id uuid NOT NULL, status text NOT NULL);
      CREATE TABLE public.builder_artifacts(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, step_id uuid,
        artifact_type text NOT NULL, status text NOT NULL
      );
      CREATE TABLE public.builder_audit_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, job_id uuid NOT NULL,
        event_type text NOT NULL, actor_user_id uuid, actor_type text, previous_value jsonb, new_value jsonb,
        change_summary text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION public.builder_autopilot_record(_job_id uuid, _state text, _report jsonb DEFAULT NULL)
      RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
      AS $function$
      DECLARE _job public.builder_jobs%rowtype;
      BEGIN
        UPDATE public.builder_jobs SET autopilot_state = _state, autopilot_report = COALESCE(_report, autopilot_report)
        WHERE id = _job_id RETURNING * INTO _job;
        RETURN _job;
      END;
      $function$;
      ${readMigration()}
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      SELECT set_config('test.role','service_role',false);
    `);

    const org = '0bb16300-0000-4000-8000-000000000001';
    const job = '0bb16300-0000-4000-8000-000000000163';
    const other = '0bb16300-0000-4000-8000-000000000164';
    const step = n => `0bb16300-0000-4000-8000-${String(n).padStart(12, '0')}`;
    sql(`
      INSERT INTO public.builder_jobs(id,organization_id,human_reference,status,autopilot_state,autopilot_source,repair_risk,autopilot_report)
      VALUES ('${job}','${org}','BB-163','security_review','blocked','routine_monitor','routine',
        '{"state":"blocked","text":"Stopped. Why: Whole-job acceptance incomplete: DR-1 missing a changed regression test with a passing worker command."}'),
        ('${other}','${org}','BB-164','security_review','blocked','routine_monitor','routine',
        '{"state":"blocked","reason":"Whole-job acceptance incomplete: other job."}');
      INSERT INTO public.builder_job_steps(id,job_id,step_id,status,attempt_count,result_summary)
      VALUES ('${step(1)}','${job}','product_analysis','completed',3,'plan'),
        ('${step(2)}','${job}','ui_design','completed',2,'design'),
        ('${step(3)}','${job}','frontend_implementation','completed',2,'patch'),
        ('${step(4)}','${job}','backend_implementation','skipped',0,'No backend scope requested'),
        ('${step(5)}','${job}','test_suite','completed',0,'Whole-job acceptance incomplete: DR-1 missing a changed regression test with a passing worker command.'),
        ('${step(6)}','${job}','security_review','completed',1,'Independent security review passed'),
        ('${step(7)}','${job}','code_review','pending',0,NULL),
        ('${step(8)}','${job}','release_prep','pending',0,NULL);
    `);

    assert.equal(sql(`SELECT has_function_privilege('authenticated',
      'public.builder_autopilot_begin_bb163_correction(uuid,text)','EXECUTE') OR
      has_function_privilege('anon','public.builder_autopilot_begin_bb163_correction(uuid,text)','EXECUTE');`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('service_role',
      'public.builder_autopilot_begin_bb163_correction(uuid,text)','EXECUTE');`), 't');
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${other}','Whole-job acceptance incomplete: wrong job');`, /BB-163 routine repair required/);

    const blockers = 'Whole-job acceptance incomplete: DR-1 missing a changed regression test with a passing worker command.';
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', 'A different Builder failure');`, /acceptance blocker is required/);
    sql(`INSERT INTO public.builder_worker_runs(job_id,status) VALUES ('${job}','running');`);
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`, /acceptance gap is not idle/);
    sql(`DELETE FROM public.builder_worker_runs WHERE job_id='${job}'; UPDATE public.builder_jobs SET workspace_published_at=now() WHERE id='${job}';`);
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`, /unpublished BB-163 job/);
    sql(`UPDATE public.builder_jobs SET workspace_published_at=NULL WHERE id='${job}';`);
    sql(`INSERT INTO public.builder_jobs(id,organization_id,human_reference,status,autopilot_state,autopilot_source,repair_risk,autopilot_report)
      VALUES ('0bb16300-0000-4000-8000-000000000165','${org}','BB-163','security_review','blocked','routine_monitor','routine',
        '{"state":"blocked","text":"Whole-job acceptance incomplete: duplicate"}');`);
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`, /unique routine BB-163 job is required/);
    sql(`DELETE FROM public.builder_jobs WHERE id='0bb16300-0000-4000-8000-000000000165';`);
    assert.equal(JSON.parse(sql(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`)).round, 1);
    const first = JSON.parse(sql(`SELECT json_build_object(
      'job',(SELECT row_to_json(j) FROM public.builder_jobs j WHERE j.id='${job}'),
      'steps',(SELECT json_agg(s) FROM public.builder_job_steps s WHERE s.job_id='${job}'),
      'artifacts',(SELECT json_agg(a) FROM public.builder_artifacts a WHERE a.job_id='${job}'),
      'events',(SELECT json_agg(e) FROM public.builder_audit_events e WHERE e.job_id='${job}'));`));
    assert.equal(first.job.status, 'implementation_pending');
    assert.equal(first.job.autopilot_state, 'driving');
    assert.equal(first.job.autopilot_report.bb163_auto_correction_rounds, 1);
    assert.equal(first.steps.find(row => row.step_id === 'frontend_implementation').status, 'pending');
    assert.equal(first.steps.find(row => row.step_id === 'frontend_implementation').attempt_count, 2);
    assert.equal(first.steps.find(row => row.step_id === 'backend_implementation').status, 'skipped');
    assert.equal(first.steps.find(row => row.step_id === 'test_suite').status, 'pending');
    assert.equal(first.steps.find(row => row.step_id === 'security_review').status, 'pending');
    assert.equal(first.steps.find(row => row.step_id === 'code_review').status, 'pending');
    assert.ok(first.events.some(event => event.event_type === 'job_status_changed'));
    fails(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`, /acceptance gate is required/);

    sql(`SELECT public.builder_autopilot_record('${job}','blocked','{"state":"blocked","reason":"another scheduler report"}');`);
    assert.equal(JSON.parse(sql(`SELECT autopilot_report FROM public.builder_jobs WHERE id='${job}';`)).bb163_auto_correction_rounds, 1);

    for (const [round, attempt] of [[2, 3], [3, 4]]) {
      sql(`
        SELECT public.builder_autopilot_record('${job}','blocked','{"state":"blocked","text":"Whole-job acceptance incomplete: ${blockers}"}');
        UPDATE public.builder_jobs SET status='security_review' WHERE id='${job}';
        UPDATE public.builder_job_steps SET status=CASE WHEN step_id='backend_implementation' THEN 'skipped'
          WHEN step_id IN ('product_analysis','ui_design','frontend_implementation','test_suite','security_review') THEN 'completed'
          ELSE 'pending' END,
          attempt_count=CASE WHEN step_id='frontend_implementation' THEN ${attempt} ELSE attempt_count END,
          result_summary=CASE WHEN step_id='test_suite' THEN '${blockers}' ELSE result_summary END
        WHERE job_id='${job}';
      `);
      assert.equal(JSON.parse(sql(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`)).round, round);
      const current = JSON.parse(sql(`SELECT json_build_object(
        'job',(SELECT row_to_json(j) FROM public.builder_jobs j WHERE j.id='${job}'),
        'steps',(SELECT json_agg(s) FROM public.builder_job_steps s WHERE s.job_id='${job}'));`));
      assert.equal(current.job.autopilot_report.bb163_auto_correction_rounds, round);
      assert.equal(current.steps.find(row => row.step_id === 'frontend_implementation').attempt_count, attempt);
    }

    sql(`
      SELECT public.builder_autopilot_record('${job}','blocked','{"state":"blocked","text":"Whole-job acceptance incomplete: ${blockers}"}');
      UPDATE public.builder_jobs SET status='security_review' WHERE id='${job}';
      UPDATE public.builder_job_steps SET status=CASE WHEN step_id='backend_implementation' THEN 'skipped'
        WHEN step_id IN ('product_analysis','ui_design','frontend_implementation','test_suite','security_review') THEN 'completed'
        ELSE 'pending' END
      WHERE job_id='${job}';
    `);
    assert.equal(JSON.parse(sql(`SELECT public.builder_autopilot_begin_bb163_correction('${job}', '${blockers}');`)).outcome, 'parked');
    const parked = JSON.parse(sql(`SELECT json_build_object(
      'job',(SELECT row_to_json(j) FROM public.builder_jobs j WHERE j.id='${job}'),
      'steps',(SELECT json_agg(s) FROM public.builder_job_steps s WHERE s.job_id='${job}'));`));
    assert.equal(parked.job.status, 'security_review');
    assert.equal(parked.job.autopilot_state, 'blocked');
    assert.equal(parked.job.autopilot_report.bb163_auto_correction_rounds, 3);
    assert.equal(parked.job.autopilot_report.bb163_auto_correction_parked, true);
    assert.equal(parked.steps.find(row => row.step_id === 'frontend_implementation').status, 'completed');
    assert.equal(parked.steps.find(row => row.step_id === 'frontend_implementation').attempt_count, 4);
    assert.equal(sql(`SELECT count(*) FROM public.builder_audit_events WHERE job_id='${job}' AND change_summary LIKE '%parked%';`), '1');
  } finally {
    if (created) {
      try { docker(['rm', '--force', name]); } catch {}
    }
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { acceptanceIdentity } = require('../builder-implementation-acceptance');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261026120000_builder_whole_job_acceptance.sql'), 'utf8');

test('whole-job gate adds no parallel records, approval authority or model execution grant', () => {
  assert.doesNotMatch(migration, /CREATE TABLE|GRANT EXECUTE[\s\S]*TO authenticated/);
  assert.match(migration, /builder_whole_job_acceptance_step/);
  assert.match(migration, /builder_whole_job_acceptance_approval/);
  assert.match(migration, /builder_whole_job_acceptance_release/);
});

test('actual PostgreSQL guards review/approval/release, deduplicates receipts and invalidates changed evidence', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-acceptance-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '-d', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'isolated PostgreSQL becomes ready');
    const psql = sql => execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    psql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role') $$;
      CREATE TABLE builder_jobs(id uuid PRIMARY KEY, organization_id uuid, status text, target_sha text, code_review_revision jsonb, code_review_mode text);
      CREATE TABLE builder_job_steps(id uuid PRIMARY KEY, job_id uuid, step_id text, status text,
        input_context jsonb, result_summary text, updated_at timestamptz);
      CREATE TABLE builder_artifacts(id uuid PRIMARY KEY, job_id uuid, step_id uuid, artifact_type text, status text, checksum text);
      CREATE TABLE builder_worker_runs(id uuid PRIMARY KEY, job_id uuid, step_id uuid, status text,
        profile text, patch_artifact_id uuid, output_artifact_ids uuid[]);
      CREATE TABLE builder_model_runs(job_id uuid, status text);
      CREATE TABLE builder_approvals(id uuid PRIMARY KEY, job_id uuid, approval_type text, status text);
      CREATE TABLE builder_audit_events(organization_id uuid,job_id uuid,event_type text,actor_type text,new_value jsonb,change_summary text);
      CREATE FUNCTION expect_error(command text, expected text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
        IF position(expected in SQLERRM)=0 THEN RAISE EXCEPTION 'Unexpected error: %',SQLERRM; END IF; RETURN;
      END; RAISE EXCEPTION 'Expected error: %',expected; END $$;
      ${migration}
      SELECT set_config('test.role','service_role',false);
      INSERT INTO builder_jobs VALUES('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
        'security_review',repeat('a',40),NULL,'none');
      INSERT INTO builder_job_steps(id,job_id,step_id,status)
        SELECT ('20000000-0000-4000-8000-00000000000'||n)::uuid,'10000000-0000-4000-8000-000000000001',s,st
        FROM (VALUES(1,'frontend_implementation','skipped'),(2,'backend_implementation','completed'),
          (3,'test_suite','completed'),(4,'code_review','pending'),(5,'release_prep','pending')) v(n,s,st);
      INSERT INTO builder_artifacts VALUES
        ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL,'product_specification','final','spec'),
        ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','code_implementation','final','patch'),
        ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','changed_file_manifest','final','manifest'),
        ('30000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','build_logs','final','logs');
      INSERT INTO builder_worker_runs VALUES('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002','completed','backend-verify','30000000-0000-4000-8000-000000000002',
        ARRAY['30000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003']::uuid[]);
      INSERT INTO builder_approvals VALUES('50000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001','implementation_review','pending');
    `);
    const state = JSON.parse(psql(`SELECT json_build_object('job', (SELECT row_to_json(j) FROM builder_jobs j),
      'steps', (SELECT json_agg(s) FROM builder_job_steps s), 'artifacts', (SELECT json_agg(a) FROM builder_artifacts a),
      'workerRuns', (SELECT json_agg(r) FROM builder_worker_runs r));`).trim());
    const identity = acceptanceIdentity(state);
    assert.deepEqual(JSON.parse(psql(`SELECT builder_implementation_acceptance_identity('10000000-0000-4000-8000-000000000001');`)), identity,
      'JavaScript and PostgreSQL compute exactly the same evidence identity');
    const identityLiteral = `'${JSON.stringify(identity)}'::jsonb`;
    psql(`
      SELECT set_config('test.role','service_role',false);
      DO $f$
      DECLARE j uuid := '10000000-0000-4000-8000-000000000001'; ident jsonb := ${identityLiteral};
        passed jsonb := '{"version":1,"passed":true,"requirements":[{"requirement_id":"DR-1","status":"covered"}],"blockers":[]}';
        failed jsonb := '{"version":1,"passed":false,"requirements":[{"requirement_id":"DR-1","status":"blocked"}],"blockers":["DR-1: missing workflow"]}';
        action text; receipt jsonb; n integer;
      BEGIN
        FOR action IN SELECT unnest(ARRAY[
          'UPDATE builder_job_steps SET status=''blocked'' WHERE step_id=''code_review''',
          'UPDATE builder_job_steps SET status=''running'' WHERE step_id=''code_review''',
          'UPDATE builder_job_steps SET status=''skipped'' WHERE step_id=''code_review''',
          'UPDATE builder_job_steps SET status=''completed'' WHERE step_id=''code_review''',
          'UPDATE builder_job_steps SET status=''running'' WHERE step_id=''release_prep''',
          'UPDATE builder_job_steps SET status=''completed'' WHERE step_id=''release_prep''',
          'UPDATE builder_approvals SET status=''approved''',
          'UPDATE builder_jobs SET status=''release_ready'''
        ]) LOOP
          PERFORM expect_error(action,'Whole-job acceptance incomplete');
        END LOOP;
        PERFORM set_config('test.role','authenticated',false);
        PERFORM expect_error(format('SELECT builder_record_implementation_acceptance(%L,%L,%L)',j,ident,passed),'Service identity required');
        PERFORM set_config('test.role','service_role',false);
        IF has_function_privilege('authenticated','builder_record_implementation_acceptance(uuid,jsonb,jsonb)','EXECUTE')
          OR has_function_privilege('anon','builder_record_implementation_acceptance(uuid,jsonb,jsonb)','EXECUTE')
          OR has_function_privilege('service_role','builder_require_implementation_acceptance(uuid,boolean)','EXECUTE')
        THEN RAISE EXCEPTION 'Unexpected execution authority'; END IF;
        PERFORM builder_record_implementation_acceptance(j,ident,failed);
        PERFORM builder_record_implementation_acceptance(j,ident,failed);
        IF (SELECT count(*) FROM builder_audit_events) <> 1 THEN RAISE EXCEPTION 'Receipt replay duplicated audit'; END IF;
        IF (SELECT result_summary FROM builder_job_steps WHERE step_id='test_suite') NOT LIKE '%DR-1: missing workflow%'
          THEN RAISE EXCEPTION 'Missing durable failure summary'; END IF;
        PERFORM expect_error('UPDATE builder_job_steps SET status=''blocked'' WHERE step_id=''code_review''','Whole-job acceptance incomplete');
        UPDATE builder_jobs SET code_review_mode='human';
        UPDATE builder_job_steps SET status='blocked' WHERE step_id='code_review';
        PERFORM expect_error('UPDATE builder_approvals SET status=''approved''','Whole-job acceptance incomplete');
        UPDATE builder_job_steps SET status='pending' WHERE step_id='code_review';
        PERFORM expect_error(format('SELECT builder_record_implementation_acceptance(%L,%L,%L)',j,ident,
          jsonb_set(passed,'{requirements}','[]')),'unresolved requirements');
        INSERT INTO builder_model_runs VALUES(j,'running');
        PERFORM expect_error(format('SELECT builder_record_implementation_acceptance(%L,%L,%L)',j,ident,passed),'work is active');
        DELETE FROM builder_model_runs;
        PERFORM builder_record_implementation_acceptance(j,ident,passed);
        PERFORM builder_require_implementation_acceptance(j);
        -- Existing review startup replaces its own input_context. Coverage lives on test_suite.
        UPDATE builder_job_steps SET status='blocked',input_context='{"reviewed_artifact_ids":[]}' WHERE step_id='code_review';
        UPDATE builder_approvals SET status='approved';
        UPDATE builder_job_steps SET status='completed' WHERE step_id='code_review';
        UPDATE builder_job_steps SET status='running' WHERE step_id='release_prep';
        UPDATE builder_jobs SET status='release_ready';
        UPDATE builder_jobs SET status='security_review';
        UPDATE builder_job_steps SET status='pending' WHERE step_id IN ('code_review','release_prep');
        UPDATE builder_approvals SET status='pending';
        SELECT input_context->'implementation_acceptance' INTO receipt FROM builder_job_steps WHERE step_id='test_suite';
        FOR action IN SELECT unnest(ARRAY[
          'UPDATE builder_jobs SET code_review_revision=''{"approval_id":"new-cycle"}''',
          'UPDATE builder_jobs SET target_sha=repeat(''b'',40)',
          'UPDATE builder_artifacts SET checksum=''replacement'' WHERE artifact_type=''code_implementation''',
          'UPDATE builder_artifacts SET status=''superseded'' WHERE artifact_type=''code_implementation''',
          'UPDATE builder_worker_runs SET output_artifact_ids=''{}''',
          'UPDATE builder_job_steps SET status=''completed'' WHERE step_id=''frontend_implementation'''
        ]) LOOP
          BEGIN
            EXECUTE action;
            PERFORM expect_error(format('SELECT builder_require_implementation_acceptance(%L)',j),'incomplete or stale');
            PERFORM expect_error('UPDATE builder_approvals SET status=''approved''','incomplete or stale');
            RAISE EXCEPTION 'rollback-test-change';
          EXCEPTION WHEN OTHERS THEN
            IF SQLERRM <> 'rollback-test-change' THEN RAISE; END IF;
          END;
        END LOOP;
        PERFORM builder_require_implementation_acceptance(j);
        UPDATE builder_jobs SET code_review_revision='{"approval_id":"new-cycle"}';
        PERFORM expect_error(format('SELECT builder_record_implementation_acceptance(%L,%L,%L)',j,ident,passed),'evidence changed');
        -- Reject/correct/cancel remain possible; acceptance never grants or revokes that authority.
        UPDATE builder_approvals SET status='rejected';
        UPDATE builder_job_steps SET status='failed' WHERE step_id='code_review';
        UPDATE builder_job_steps SET status='pending' WHERE step_id='code_review';
      END $f$;
    `);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

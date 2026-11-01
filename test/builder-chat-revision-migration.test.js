'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261026082000_builder_chat_spec_revision.sql'), 'utf8');

test('revision is confirmed by the owner, gate-bound, replay-safe and does not overwrite the immutable task', () => {
  assert.match(migration, /builder_chat_require_owner/);
  assert.match(migration, /FOR UPDATE OF m/);
  assert.match(migration, /requested_target_sha/);
  assert.match(migration, /status = 'superseded'/);
  assert.match(migration, /status = 'cancelled'/);
  assert.match(migration, /'specification_revision'/);
  assert.match(migration, /FROM PUBLIC, anon, service_role/);
  assert.doesNotMatch(migration, /INSERT INTO public.builder_jobs|task_description\s*=/);
});

test('revision migration enforces actual authorization, stale gate, idle work and exactly-once effects', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-revision-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready);
    const fixture = `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE FUNCTION builder_chat_require_owner() RETURNS uuid LANGUAGE sql AS $f$
        SELECT current_setting('test.actor')::uuid $f$;
      CREATE FUNCTION can_approve_action(uuid,uuid) RETURNS boolean LANGUAGE sql AS $f$
        SELECT current_setting('test.authorized') = 'yes' $f$;
      CREATE TABLE builder_chat_threads(id uuid PRIMARY KEY, created_by uuid);
      CREATE TABLE builder_chat_messages(id uuid PRIMARY KEY,thread_id uuid,kind text,role text,
        status text,created_by uuid,payload jsonb);
      CREATE TABLE builder_jobs(id uuid PRIMARY KEY,organization_id uuid,status text,target_sha text,last_error text,
        autopilot_requested_by uuid,autopilot_state text,updated_at timestamptz);
      CREATE TABLE builder_approvals(id uuid PRIMARY KEY,job_id uuid,organization_id uuid,status text,approval_type text,
        expires_at timestamptz,requested_from_users uuid[],requested_target_sha text,reviewed_artifact_ids uuid[],
        decided_by uuid,approval_comment text,responded_at timestamptz,updated_at timestamptz);
      CREATE TABLE builder_job_steps(id uuid PRIMARY KEY,job_id uuid,builder_mode text,status text,started_at timestamptz,
        completed_at timestamptz,result_summary text,error text,retryable boolean,input_context jsonb,updated_at timestamptz);
      CREATE TABLE builder_artifacts(id uuid PRIMARY KEY,job_id uuid,status text,updated_at timestamptz);
      CREATE TABLE builder_worker_runs(job_id uuid);
      CREATE TABLE builder_model_runs(job_id uuid,status text);
      CREATE TABLE builder_audit_events(id uuid DEFAULT gen_random_uuid(),organization_id uuid,job_id uuid,
        event_type text,actor_user_id uuid,actor_type text,previous_value jsonb,new_value jsonb,change_summary text,
        related_artifact_ids uuid[],related_approval_id uuid);
      CREATE FUNCTION expect_error(command text,expected text) RETURNS void LANGUAGE plpgsql AS $f$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
          IF position(expected in SQLERRM)=0 THEN RAISE EXCEPTION 'Unexpected: %', SQLERRM; END IF; RETURN;
        END;
        RAISE EXCEPTION 'Expected error: %',expected;
      END $f$;
    `;
    const checks = `
      SELECT set_config('test.actor','11111111-1111-4111-8111-111111111111',false);
      SELECT set_config('test.authorized','yes',false);
      DO $f$
      #variable_conflict use_variable
      DECLARE scope text;
      BEGIN
      FOR scope IN SELECT unnest(ARRAY['fullstack','frontend','backend']) LOOP
      DECLARE owner_id uuid := current_setting('test.actor')::uuid; thread_id uuid := gen_random_uuid();
        job_id uuid := gen_random_uuid(); org_id uuid := gen_random_uuid(); source_id uuid := gen_random_uuid();
        card_id uuid := gen_random_uuid(); approval_id uuid := gen_random_uuid(); artifact_id uuid := gen_random_uuid();
        analyst_id uuid := gen_random_uuid(); other_id uuid := gen_random_uuid();
        ux_id uuid := gen_random_uuid(); backend_id uuid := gen_random_uuid(); receipt uuid; again uuid;
        command text;
      BEGIN
        INSERT INTO builder_chat_threads VALUES(thread_id,owner_id);
        INSERT INTO builder_jobs(id,organization_id,status,target_sha,autopilot_requested_by,autopilot_state)
          VALUES(job_id,org_id,'specification_ready',repeat('a',40),owner_id,'awaiting_human');
        INSERT INTO builder_approvals(id,job_id,organization_id,status,approval_type,expires_at,requested_target_sha,reviewed_artifact_ids)
          VALUES(approval_id,job_id,org_id,'pending','specification_review',now()+interval '1 day',repeat('a',40),ARRAY[artifact_id]);
        INSERT INTO builder_artifacts VALUES(artifact_id,job_id,'final',now());
        INSERT INTO builder_job_steps(id,job_id,builder_mode,status,input_context) VALUES
          (analyst_id,job_id,'product_analyst','completed','{"preserve":"existing"}'),
          (other_id,job_id,'frontend_engineer',CASE WHEN scope='backend' THEN 'skipped' ELSE 'pending' END,'{}'),
          (ux_id,job_id,'ux_designer',CASE WHEN scope='backend' THEN 'skipped' ELSE 'pending' END,'{}'),
          (backend_id,job_id,'backend_engineer',CASE WHEN scope='frontend' THEN 'skipped' ELSE 'pending' END,'{}');
        INSERT INTO builder_chat_messages(id,thread_id,kind,payload) VALUES
          (gen_random_uuid(),thread_id,'proposal',jsonb_build_object('job_id',job_id));
        INSERT INTO builder_chat_messages VALUES(source_id,thread_id,'message','owner','done',owner_id,
          '{"pm_purpose":"pm","research_consent":{"allowed":true}}');
        INSERT INTO builder_chat_messages(id,thread_id,kind,payload) VALUES(card_id,thread_id,'proposal',
          jsonb_build_object('message_id',source_id,'revision',jsonb_build_object('job_id',job_id,'source_message_id',source_id,
            'approval_id',approval_id,'target_sha',repeat('a',40),'feedback','Investigate the current reported path before approving any implementation.')));
        command := format('SELECT builder_chat_request_spec_revision(%L)',card_id);
        PERFORM set_config('test.actor',gen_random_uuid()::text,false);
        PERFORM expect_error(command,'card not found');
        PERFORM set_config('test.actor',owner_id::text,false);
        PERFORM set_config('test.authorized','no',false);
        PERFORM expect_error(command,'not authorized');
        PERFORM set_config('test.authorized','yes',false);
        UPDATE builder_jobs SET target_sha=repeat('b',40) WHERE id=job_id;
        PERFORM expect_error(command,'moved beyond');
        UPDATE builder_jobs SET target_sha=repeat('a',40) WHERE id=job_id;
        UPDATE builder_approvals SET status='approved' WHERE id=approval_id;
        PERFORM expect_error(command,'moved or expired');
        UPDATE builder_approvals SET status='pending' WHERE id=approval_id;
        UPDATE builder_job_steps SET status='running' WHERE id=other_id;
        PERFORM expect_error(command,'idle initial');
        UPDATE builder_job_steps SET status=CASE WHEN scope='backend' THEN 'skipped' ELSE 'pending' END WHERE id=other_id;
        UPDATE builder_job_steps SET started_at=now() WHERE id=other_id;
        PERFORM expect_error(command,'idle initial');
        UPDATE builder_job_steps SET started_at=NULL WHERE id=other_id;
        INSERT INTO builder_worker_runs VALUES(job_id);
        PERFORM expect_error(command,'idle initial');
        DELETE FROM builder_worker_runs;
        receipt := builder_chat_request_spec_revision(card_id);
        again := builder_chat_request_spec_revision(card_id);
        IF receipt IS DISTINCT FROM again OR (SELECT count(*) FROM builder_audit_events a WHERE a.job_id=job_id)<>1
          OR (SELECT status FROM builder_jobs WHERE id=job_id)<>'analysis_pending'
          OR (SELECT status FROM builder_artifacts WHERE id=artifact_id)<>'superseded'
          OR (SELECT status FROM builder_approvals WHERE id=approval_id)<>'cancelled'
          OR (SELECT status FROM builder_job_steps WHERE id=analyst_id)<>'pending'
          OR (SELECT input_context->>'preserve' FROM builder_job_steps WHERE id=analyst_id)<>'existing'
          OR (SELECT input_context->'specification_revision'->>'feedback' FROM builder_job_steps WHERE id=analyst_id) IS NULL
          THEN RAISE EXCEPTION 'Revision state or receipt incorrect'; END IF;
        IF has_function_privilege('anon','builder_chat_request_spec_revision(uuid)','EXECUTE')
          OR has_function_privilege('service_role','builder_chat_request_spec_revision(uuid)','EXECUTE')
          OR NOT has_function_privilege('authenticated','builder_chat_request_spec_revision(uuid)','EXECUTE')
          THEN RAISE EXCEPTION 'Wrong execute grants'; END IF;
      END;
      END LOOP;
      END $f$;
    `;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      input: fixture + migration + checks, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

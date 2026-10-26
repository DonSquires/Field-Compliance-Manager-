'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261026101500_builder_chat_code_changes.sql'), 'utf8');
const cycleMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261026103000_builder_correction_verification_cycles.sql'), 'utf8');
const recoveryMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261026110000_builder_chat_implementation_recovery.sql'), 'utf8');
const skipSql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260830181000_builder_implementation_skip.sql'), 'utf8');
const skipFunction = skipSql.slice(skipSql.indexOf('CREATE OR REPLACE FUNCTION'), skipSql.indexOf('$$;') + 3);

test('code corrections preserve immutable task/target/attempts and have owner-only execution', () => {
  assert.match(migration, /builder_chat_require_owner/);
  assert.match(migration, /status = 'superseded'/);
  assert.match(migration, /status = 'cancelled'/);
  assert.match(migration, /FROM PUBLIC, anon, service_role/);
  assert.doesNotMatch(migration, /INSERT INTO public.builder_jobs|task_description\s*=|(?:SET|,)\s*target_sha\s*=|attempt_count\s*=/);
});

test('actual PostgreSQL enforces same-job correction authorization, stale/active guards, retained seeds and replay', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-code-changes-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  const recoveryChecks = `
    SELECT set_config('test.role','authenticated',false);
    DO $f$
    #variable_conflict use_variable
    DECLARE job_id uuid; source_id uuid; thread_id uuid; step_id uuid;
      card_id uuid:=gen_random_uuid(); stale_card uuid:=gen_random_uuid();
      owner_id uuid:=auth.uid(); approval_id uuid; receipt uuid; again uuid;
      command text; original_revision jsonb; original_attempt integer; before_events integer;
    BEGIN
      SELECT id, code_review_revision INTO job_id,original_revision FROM builder_jobs
        WHERE code_review_revision->'seed_patch_ids' ? 'frontend_implementation'
          AND code_review_revision->'seed_patch_ids' ? 'backend_implementation' LIMIT 1;
      source_id:=(original_revision->>'source_message_id')::uuid;
      approval_id:=(original_revision->>'approval_id')::uuid;
      SELECT m.thread_id INTO thread_id FROM builder_chat_messages m WHERE id=source_id;
      SELECT id,attempt_count INTO step_id,original_attempt FROM builder_job_steps b
        WHERE b.job_id=job_id AND b.step_id='frontend_implementation';
      UPDATE builder_jobs SET status='failed',code_review_status='pending',updated_at=now() WHERE id=job_id;
      UPDATE builder_job_steps b SET status=CASE WHEN id=step_id THEN 'failed' ELSE 'pending' END,
        started_at=NULL,completed_at=NULL,error=CASE WHEN id=step_id THEN 'generation: Protected lane boundary: backend-owned fix' END
        WHERE b.job_id=job_id AND b.step_id NOT IN ('product_analysis','ui_design');
      UPDATE builder_artifacts SET status='superseded' WHERE builder_artifacts.job_id=job_id AND artifact_type='code_implementation';
      INSERT INTO builder_chat_messages(id,thread_id,kind,role,payload)
        SELECT card_id,thread_id,'proposal','bob',jsonb_build_object('message_id',source_id,'revision',
          jsonb_build_object('kind','recovery','job_id',job_id,'source_message_id',source_id,
            'approval_id',approval_id,'target_sha',repeat('a',40),'job_updated_at',updated_at,
            'failed_step_id',step_id,'feedback','Recover routing without unrelated edits; backend must prove the original reader integration.'))
        FROM builder_jobs WHERE id=job_id;
      INSERT INTO builder_chat_messages SELECT stale_card,thread_id,kind,role,status,created_by,content,payload
        FROM builder_chat_messages WHERE id=card_id;
      command:=format('SELECT builder_chat_recover_implementation(%L)',card_id);
      PERFORM set_config('test.actor',gen_random_uuid()::text,false); PERFORM expect_error(command,'card not found');
      PERFORM set_config('test.actor',owner_id::text,false);
      PERFORM set_config('test.authorized','no',false); PERFORM expect_error(command,'not authorized');
      PERFORM set_config('test.authorized','yes',false);
      UPDATE builder_approvals SET requested_from_users=ARRAY[gen_random_uuid()] WHERE id=approval_id;
      PERFORM expect_error(command,'not authorized');
      UPDATE builder_approvals SET requested_from_users=ARRAY[owner_id] WHERE id=approval_id;
      UPDATE builder_chat_messages SET status='failed' WHERE id=source_id;
      PERFORM expect_error(command,'completed approved PM');
      UPDATE builder_chat_messages SET status='done',payload=jsonb_set(payload,'{pm_purpose}','"qa"') WHERE id=source_id;
      PERFORM expect_error(command,'completed approved PM');
      UPDATE builder_chat_messages SET payload=jsonb_set(payload,'{pm_purpose}','"pm"') WHERE id=source_id;
      UPDATE builder_jobs SET target_sha=repeat('b',40) WHERE id=job_id; PERFORM expect_error(command,'changed or is published');
      UPDATE builder_jobs SET target_sha=repeat('a',40),workspace_pull_request_url='https://example.invalid/pr' WHERE id=job_id;
      PERFORM expect_error(command,'changed or is published');
      UPDATE builder_jobs SET workspace_pull_request_url=NULL,updated_at=now()+interval '1 second' WHERE id=job_id;
      PERFORM expect_error(command,'changed or is published'); UPDATE builder_jobs SET updated_at=now() WHERE id=job_id;
      UPDATE builder_job_steps SET error='repair: verification failed' WHERE id=step_id;
      PERFORM expect_error(command,'idle author failure'); UPDATE builder_job_steps SET error='generation: lane boundary' WHERE id=step_id;
      UPDATE builder_job_steps b SET status='skipped' WHERE b.job_id=job_id AND b.step_id='backend_implementation';
      PERFORM expect_error(command,'idle author failure');
      UPDATE builder_job_steps b SET status='pending' WHERE b.job_id=job_id AND b.step_id='backend_implementation';
      INSERT INTO builder_model_runs(job_id,status) VALUES(job_id,'running'); PERFORM expect_error(command,'idle author failure');
      DELETE FROM builder_model_runs WHERE builder_model_runs.job_id=job_id AND status='running';
      INSERT INTO builder_worker_runs(job_id,status) VALUES(job_id,'running'); PERFORM expect_error(command,'idle author failure');
      DELETE FROM builder_worker_runs WHERE builder_worker_runs.job_id=job_id AND status='running';
      UPDATE builder_job_steps b SET started_at=now() WHERE b.job_id=job_id AND b.step_id='test_suite';
      PERFORM expect_error(command,'idle author failure');
      UPDATE builder_job_steps b SET started_at=NULL WHERE b.job_id=job_id AND b.step_id='test_suite';
      INSERT INTO builder_artifacts(id,job_id,step_id,artifact_type,status)
        VALUES(gen_random_uuid(),job_id,step_id,'code_implementation','final');
      PERFORM expect_error(command,'idle author failure');
      DELETE FROM builder_artifacts a WHERE a.job_id=job_id AND a.step_id=step_id AND status='final' AND artifact_type='code_implementation';
      SELECT count(*) INTO before_events FROM builder_audit_events a WHERE a.job_id=job_id;
      receipt:=builder_chat_recover_implementation(card_id); again:=builder_chat_recover_implementation(card_id);
      IF receipt IS DISTINCT FROM again
        OR (SELECT count(*) FROM builder_audit_events a WHERE a.job_id=job_id)<>before_events+1
        OR (SELECT status FROM builder_jobs WHERE id=job_id)<>'implementation_pending'
        OR (SELECT attempt_count FROM builder_job_steps WHERE id=step_id)<>original_attempt
        OR (SELECT code_review_revision->>'recovery_id' FROM builder_jobs WHERE id=job_id)<>receipt::text
        OR (SELECT code_review_revision->'seed_patch_ids' FROM builder_jobs WHERE id=job_id) IS DISTINCT FROM original_revision->'seed_patch_ids'
        OR (SELECT code_review_revision->>'approval_id' FROM builder_jobs WHERE id=job_id)<>approval_id::text
        OR (SELECT task_description FROM builder_jobs WHERE id=job_id)<>'Immutable original task'
        OR (SELECT target_sha FROM builder_jobs WHERE id=job_id)<>repeat('a',40)
        OR (SELECT status FROM builder_job_steps WHERE id=step_id)<>'pending'
        THEN RAISE EXCEPTION 'Recovery did not preserve job, seeds, attempts, or exactly-once receipt'; END IF;
      PERFORM expect_error(format('SELECT builder_chat_recover_implementation(%L)',stale_card),'changed or is published');
      IF has_function_privilege('anon','builder_chat_recover_implementation(uuid)','EXECUTE')
        OR has_function_privilege('service_role','builder_chat_recover_implementation(uuid)','EXECUTE')
        OR NOT has_function_privilege('authenticated','builder_chat_recover_implementation(uuid)','EXECUTE')
        THEN RAISE EXCEPTION 'Wrong recovery execute grants'; END IF;
    END $f$;
    SELECT set_config('test.role','service_role',false);
    DO $f$
    DECLARE j uuid:=gen_random_uuid(); f uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
      command text;
    BEGIN
      INSERT INTO builder_jobs(id,status) VALUES(j,'implementation_pending');
      INSERT INTO builder_job_steps(id,job_id,step_id,builder_mode,status)
        VALUES(f,j,'frontend_implementation','frontend_engineer','pending'),
          (b,j,'backend_implementation','backend_engineer','skipped');
      command:=format('SELECT builder_skip_implementation_step(%L,%L,%L,%L)',j,f,'frontend_engineer',
        'Nothing to change in this lane; author evidence says this fix belongs to the backend lane.');
      PERFORM expect_error(command,'Destination implementation lane is unavailable');
      IF (SELECT status FROM builder_job_steps WHERE id=f)<>'pending'
        OR (SELECT status FROM builder_jobs WHERE id=j)<>'implementation_pending'
        THEN RAISE EXCEPTION 'Refused redirect changed state'; END IF;
      DELETE FROM builder_job_steps WHERE id=b;
      PERFORM expect_error(command,'Destination implementation lane is unavailable');
      INSERT INTO builder_job_steps(id,job_id,step_id,builder_mode,status)
        VALUES(b,j,'backend_implementation','backend_engineer','pending');
      EXECUTE command;
      IF (SELECT status FROM builder_job_steps WHERE id=f)<>'skipped'
        OR (SELECT status FROM builder_job_steps WHERE id=b)<>'pending'
        OR (SELECT status FROM builder_jobs WHERE id=j)<>'implementation_pending'
        THEN RAISE EXCEPTION 'Available sibling was not left runnable'; END IF;
    END $f$;
  `;
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
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $f$ SELECT current_setting('test.actor')::uuid $f$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $f$ SELECT current_setting('test.role') $f$;
      CREATE FUNCTION builder_chat_require_owner() RETURNS uuid LANGUAGE sql AS $f$ SELECT auth.uid() $f$;
      CREATE FUNCTION can_approve_action(uuid,uuid) RETURNS boolean LANGUAGE sql AS $f$ SELECT current_setting('test.authorized')='yes' $f$;
      CREATE TABLE builder_chat_threads(id uuid PRIMARY KEY,created_by uuid);
      CREATE TABLE builder_chat_messages(id uuid PRIMARY KEY,thread_id uuid,kind text,role text,status text,created_by uuid,content text,payload jsonb);
      CREATE TABLE builder_jobs(id uuid PRIMARY KEY,organization_id uuid,status text,target_sha text,task_description text,
        last_error text,autopilot_requested_by uuid,autopilot_state text,updated_at timestamptz,code_review_mode text,code_review_status text,
        code_review_artifact_id uuid,current_step_name text,current_step_index integer,
        workspace_published_at timestamptz,workspace_published_head_sha text,workspace_pull_request_url text);
      CREATE TABLE builder_approvals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,organization_id uuid,status text,approval_type text,
        expires_at timestamptz DEFAULT now()+interval '1 day',triggered_at_status text,requested_from_users uuid[],requested_target_sha text,
        reviewed_artifact_ids uuid[],decided_by uuid,approved_by uuid,approval_comment text,responded_at timestamptz,updated_at timestamptz);
      CREATE TABLE builder_job_steps(id uuid PRIMARY KEY,job_id uuid,step_id text,builder_mode text,status text,attempt_count integer DEFAULT 1,
        ordinal_position integer,started_at timestamptz,completed_at timestamptz,result_summary text,error text,retryable boolean,
        blocked_reason text,input_context jsonb,artifact_ids uuid[],updated_at timestamptz);
      CREATE TABLE builder_artifacts(id uuid PRIMARY KEY,job_id uuid,step_id uuid,artifact_type text,status text,updated_at timestamptz);
      CREATE TABLE builder_worker_runs(id uuid,job_id uuid,step_id uuid,organization_id uuid,status text,target_sha text,profile text,patch_artifact_id uuid);
      CREATE TABLE builder_model_runs(job_id uuid,status text);
      CREATE TABLE builder_audit_events(id uuid DEFAULT gen_random_uuid(),organization_id uuid,job_id uuid,
        event_type text,actor_user_id uuid,actor_type text,previous_value jsonb,new_value jsonb,change_summary text,
        related_artifact_ids uuid[],related_approval_id uuid);
      CREATE FUNCTION expect_error(command text,expected text) RETURNS void LANGUAGE plpgsql AS $f$
      BEGIN BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
        IF position(expected in SQLERRM)=0 THEN RAISE EXCEPTION 'Unexpected: %',SQLERRM; END IF; RETURN;
      END; RAISE EXCEPTION 'Expected error: %',expected; END $f$;
    `;
    const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
    const reviewFunctions = ['builder_start_code_review', 'builder_decide_human_code_review', 'builder_enforce_release_review_policy']
      .map(symbol => {
        const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${symbol}"(`);
        assert.ok(start >= 0, symbol);
        return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
      }).join('\n');
    const claimFunctions = ['builder_claim_frontend_worker', 'builder_claim_backend_worker'].map(symbol => {
      const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${symbol}"(`);
      assert.ok(start >= 0, symbol);
      return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
    }).join('\n');
    const originalClaimFunctions = [
      ['20260830090000_builder_frontend_worker_leases.sql', 'builder_claim_frontend_worker'],
      ['20260830180000_builder_backend_worker_leases.sql', 'builder_claim_backend_worker'],
    ].map(([file, symbol]) => {
      const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations', file), 'utf8');
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${symbol}(`);
      const end = sql.indexOf('$$;', start);
      assert.ok(start >= 0 && end > start, symbol);
      return sql.slice(start, end + '$$;'.length);
    }).join('\n');
    const cycleFixture = `
      CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      ALTER TABLE builder_artifacts ADD COLUMN checksum text;
      ALTER TABLE builder_model_runs ADD COLUMN step_id uuid,
        ADD COLUMN input_artifact_ids uuid[], ADD COLUMN output_artifact_ids uuid[];
      ALTER TABLE builder_worker_runs ALTER COLUMN id SET DEFAULT gen_random_uuid(),
        ADD COLUMN runner_id text, ADD COLUMN worker_isolation_level text,
        ADD COLUMN command text, ADD COLUMN command_args text[], ADD COLUMN environment_variables_snapshot jsonb,
        ADD COLUMN idempotency_key text, ADD COLUMN lease_token_hash text, ADD COLUMN lease_expires_at timestamptz,
        ADD COLUMN heartbeat_at timestamptz, ADD COLUMN started_at timestamptz, ADD COLUMN completed_at timestamptz,
        ADD COLUMN updated_at timestamptz, ADD COLUMN timeout_seconds integer;
      CREATE UNIQUE INDEX ON builder_worker_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `;
    const cycleChecks = `
      SELECT set_config('test.role','service_role',false);
      DO $f$
      #variable_conflict use_variable
      <<cycleChecks>>
      DECLARE lane text; job_id uuid; step_id uuid; patch_id uuid; source_id uuid; spec_id uuid;
        org_id uuid:=gen_random_uuid(); result jsonb; original_key text; original_run uuid; cycle_id uuid;
        previous_count integer; cycle integer; claim text;
      BEGIN
      FOREACH lane IN ARRAY ARRAY['frontend','backend'] LOOP
        job_id:=gen_random_uuid(); step_id:=gen_random_uuid(); patch_id:=gen_random_uuid();
        source_id:=gen_random_uuid(); spec_id:=gen_random_uuid();
        INSERT INTO builder_jobs(id,organization_id,status,target_sha)
          VALUES(job_id,org_id,'implementation_pending',repeat('b',40));
        INSERT INTO builder_job_steps(id,job_id,step_id,builder_mode,status,attempt_count)
          VALUES(step_id,job_id,lane||'_implementation',lane||'_engineer','pending',0),
          (source_id,job_id,'source',CASE lane WHEN 'frontend' THEN 'ux_designer' ELSE 'product_analyst' END,'completed',1);
        INSERT INTO builder_artifacts(id,job_id,step_id,artifact_type,status,checksum)
          VALUES(patch_id,job_id,step_id,'code_implementation','final','identical-checksum'),
          (spec_id,job_id,source_id,CASE lane WHEN 'frontend' THEN 'ui_design_plan' ELSE 'product_specification' END,'final','source-checksum');
        INSERT INTO builder_model_runs(job_id,step_id,status,input_artifact_ids,output_artifact_ids)
          VALUES(job_id,step_id,'completed',ARRAY[spec_id],ARRAY[patch_id]);
        claim:=format('SELECT builder_claim_%s_worker(%L,%L,%L,%L,%L)',lane,job_id,step_id,patch_id,'test-runner',repeat('b',40));
        EXECUTE claim INTO result;
        original_run:=(result->>'run_id')::uuid;
        original_key:=job_id::text||'::'||step_id::text||'::'||repeat('b',40)||'::identical-checksum';
        IF (SELECT idempotency_key FROM builder_worker_runs WHERE id=original_run) IS DISTINCT FROM original_key
          THEN RAISE EXCEPTION 'Non-correction key changed'; END IF;
        FOR cycle IN 1..3 LOOP
          UPDATE builder_worker_runs SET status='completed' WHERE id=(result->>'run_id')::uuid;
          UPDATE builder_jobs SET status='implementation_pending' WHERE id=job_id;
          UPDATE builder_job_steps SET status='pending' WHERE id=step_id;
          SELECT count(*) INTO previous_count FROM builder_worker_runs WHERE builder_worker_runs.job_id=cycleChecks.job_id;
          PERFORM expect_error(claim,'already verified');
          cycle_id:=gen_random_uuid();
          UPDATE builder_jobs SET code_review_revision=jsonb_build_object('approval_id',cycle_id) WHERE id=job_id;
          EXECUTE claim INTO result;
          IF (SELECT count(*) FROM builder_worker_runs WHERE builder_worker_runs.job_id=cycleChecks.job_id)<>previous_count+1
            OR (SELECT status FROM builder_worker_runs WHERE id=original_run)<>'completed'
            OR (SELECT idempotency_key FROM builder_worker_runs WHERE id=(result->>'run_id')::uuid)
              IS DISTINCT FROM original_key||'::correction::'||cycle_id::text
            THEN RAISE EXCEPTION 'Correction did not preserve history and claim a fresh cycle'; END IF;
        END LOOP;
        UPDATE builder_worker_runs SET status='completed' WHERE id=(result->>'run_id')::uuid;
      END LOOP;
      END $f$;
    `;
    const checks = `
      CREATE TRIGGER review_policy BEFORE UPDATE OF status ON builder_job_steps
        FOR EACH ROW EXECUTE FUNCTION builder_enforce_release_review_policy();
      SELECT set_config('test.actor','11111111-1111-4111-8111-111111111111',false);
      SELECT set_config('test.authorized','yes',false);
      SELECT set_config('test.role','authenticated',false);
      DO $f$
      #variable_conflict use_variable
      DECLARE scope text;
      BEGIN
      FOR scope IN SELECT unnest(ARRAY['fullstack','frontend','backend']) LOOP
      DECLARE owner_id uuid:=auth.uid(); org_id uuid:=gen_random_uuid(); job_id uuid:=gen_random_uuid();
        thread_id uuid:=gen_random_uuid(); source_id uuid:=gen_random_uuid(); card_id uuid:=gen_random_uuid();
        approval_id uuid:=gen_random_uuid(); other_card uuid:=gen_random_uuid();
        receipt uuid; again uuid; command text; s record; patch_id uuid; seeds uuid[]:='{}'; old_ids uuid[]:='{}';
        review_step uuid; new_ids uuid[]:='{}'; fresh_approval uuid; t text; artifact_id uuid;
      BEGIN
        INSERT INTO builder_chat_threads VALUES(thread_id,owner_id);
        INSERT INTO builder_jobs(id,organization_id,status,target_sha,task_description,code_review_mode,code_review_status,autopilot_requested_by)
          VALUES(job_id,org_id,'security_review',repeat('a',40),'Immutable original task','human','pending',owner_id);
        INSERT INTO builder_job_steps(id,job_id,step_id,builder_mode,status) SELECT gen_random_uuid(),job_id,x,
          CASE WHEN x='frontend_implementation' THEN 'frontend_engineer' WHEN x='backend_implementation' THEN 'backend_engineer'
            WHEN x='code_review' THEN 'code_reviewer' ELSE 'other' END,
          CASE WHEN x='release_prep' THEN 'pending' WHEN x='code_review' THEN 'blocked'
            WHEN x='frontend_implementation' AND scope='backend' OR x='backend_implementation' AND scope='frontend' THEN 'skipped'
            ELSE 'completed' END
          FROM unnest(ARRAY['product_analysis','ui_design','frontend_implementation','backend_implementation','test_suite','security_review','code_review','release_prep']) x;
        FOR s IN SELECT * FROM builder_job_steps b WHERE b.job_id=job_id AND builder_mode IN ('frontend_engineer','backend_engineer') AND status='completed' LOOP
          patch_id:=gen_random_uuid(); seeds:=array_append(seeds,patch_id);
          INSERT INTO builder_artifacts VALUES(patch_id,job_id,s.id,'code_implementation','final',now());
          INSERT INTO builder_worker_runs VALUES(gen_random_uuid(),job_id,s.id,org_id,'completed',repeat('a',40),
            CASE s.builder_mode WHEN 'frontend_engineer' THEN 'frontend-verify' ELSE 'backend-verify' END,patch_id);
        END LOOP;
        old_ids:=seeds;
        INSERT INTO builder_approvals(id,job_id,organization_id,status,approval_type,requested_target_sha,reviewed_artifact_ids)
          VALUES(approval_id,job_id,org_id,'pending','implementation_review',repeat('a',40),old_ids);
        INSERT INTO builder_chat_messages VALUES(source_id,thread_id,'message','owner','done',owner_id,'Original human report',
          '{"pm_purpose":"pm","research_consent":{"allowed":true}}');
        INSERT INTO builder_chat_messages(id,thread_id,kind,payload) VALUES(gen_random_uuid(),thread_id,'proposal',jsonb_build_object('job_id',job_id));
        INSERT INTO builder_chat_messages(id,thread_id,kind,role,payload) VALUES(card_id,thread_id,'proposal','bob',
          jsonb_build_object('message_id',source_id,'revision',jsonb_build_object('kind','implementation','job_id',job_id,
            'source_message_id',source_id,'approval_id',approval_id,'target_sha',repeat('a',40),
            'feedback','Inspect the real receipt reader and prove retry safety with actual integration.')));
        INSERT INTO builder_chat_messages SELECT other_card,thread_id,kind,role,status,created_by,content,payload FROM builder_chat_messages WHERE id=card_id;
        command:=format('SELECT builder_chat_request_code_changes(%L)',card_id);
        PERFORM set_config('test.actor',gen_random_uuid()::text,false); PERFORM expect_error(command,'card not found');
        PERFORM set_config('test.actor',owner_id::text,false);
        PERFORM set_config('test.authorized','no',false); PERFORM expect_error(command,'not authorized');
        PERFORM set_config('test.authorized','yes',false);
        UPDATE builder_approvals SET requested_from_users=ARRAY[gen_random_uuid()] WHERE id=approval_id;
        PERFORM expect_error(command,'not authorized');
        UPDATE builder_approvals SET requested_from_users=ARRAY[owner_id],expires_at=now()-interval '1 second' WHERE id=approval_id;
        PERFORM expect_error(command,'moved or expired');
        UPDATE builder_approvals SET expires_at=now()+interval '1 day' WHERE id=approval_id;
        UPDATE builder_jobs SET target_sha=repeat('b',40) WHERE id=job_id; PERFORM expect_error(command,'unpublished pending');
        UPDATE builder_jobs SET target_sha=repeat('a',40),workspace_pull_request_url='https://example.invalid/pr' WHERE id=job_id;
        PERFORM expect_error(command,'unpublished pending');
        UPDATE builder_jobs SET workspace_pull_request_url=NULL WHERE id=job_id;
        UPDATE builder_chat_messages SET status='running' WHERE id=source_id; PERFORM expect_error(command,'completed approved PM');
        UPDATE builder_chat_messages SET status='done',payload=jsonb_set(payload,'{pm_purpose}','"qa"') WHERE id=source_id;
        PERFORM expect_error(command,'completed approved PM');
        UPDATE builder_chat_messages SET payload=jsonb_set(payload,'{pm_purpose}','"pm"') WHERE id=source_id;
        INSERT INTO builder_model_runs VALUES(job_id,'running'); PERFORM expect_error(command,'idle completed'); DELETE FROM builder_model_runs;
        UPDATE builder_worker_runs b SET status='running' WHERE b.job_id=job_id; PERFORM expect_error(command,'idle completed');
        UPDATE builder_worker_runs b SET status='completed' WHERE b.job_id=job_id;
        UPDATE builder_job_steps b SET started_at=now() WHERE b.job_id=job_id AND step_id='release_prep';
        PERFORM expect_error(command,'idle completed');
        UPDATE builder_job_steps b SET started_at=NULL WHERE b.job_id=job_id AND step_id='release_prep';
        UPDATE builder_artifacts SET status='superseded' WHERE id=seeds[1]; PERFORM expect_error(command,'Exactly one reviewed');
        UPDATE builder_artifacts SET status='final' WHERE id=seeds[1];
        receipt:=builder_chat_request_code_changes(card_id); again:=builder_chat_request_code_changes(card_id);
        IF receipt IS DISTINCT FROM again OR (SELECT count(*) FROM builder_audit_events a WHERE a.job_id=job_id)<>1
          OR (SELECT status FROM builder_jobs WHERE id=job_id)<>'implementation_pending'
          OR (SELECT code_review_revision->>'review_quote' FROM builder_jobs WHERE id=job_id)<>'Original human report'
          OR (SELECT task_description FROM builder_jobs WHERE id=job_id)<>'Immutable original task'
          OR (SELECT target_sha FROM builder_jobs WHERE id=job_id)<>repeat('a',40)
          OR EXISTS(SELECT 1 FROM builder_artifacts WHERE id=ANY(seeds) AND status<>'superseded')
          OR EXISTS(SELECT 1 FROM builder_job_steps b WHERE b.job_id=job_id AND attempt_count<>1)
          OR EXISTS(SELECT 1 FROM builder_job_steps b WHERE b.job_id=job_id AND step_id='product_analysis' AND status<>'completed')
          THEN RAISE EXCEPTION 'Correction state, preservation or receipt incorrect'; END IF;
        PERFORM expect_error(format('SELECT builder_chat_request_code_changes(%L)',other_card),'moved or expired');
        PERFORM expect_error(format('SELECT builder_decide_human_code_review(%L,%L,NULL)',approval_id,'approved'),'missing or decided');
        PERFORM expect_error(format('UPDATE builder_job_steps SET status=%L WHERE job_id=%L AND step_id=%L','running',job_id,'release_prep'),'Configured code review must pass');
        SELECT id INTO review_step FROM builder_job_steps b WHERE b.job_id=job_id AND step_id='code_review';
        PERFORM set_config('test.role','service_role',false);
        PERFORM expect_error(format('SELECT builder_start_code_review(%L,%L,%L::uuid[])',job_id,review_step,old_ids),'not ready');
        UPDATE builder_jobs SET status='security_review' WHERE id=job_id;
        PERFORM expect_error(format('SELECT builder_start_code_review(%L,%L,%L::uuid[])',job_id,review_step,old_ids),'security review must complete');
        UPDATE builder_job_steps b SET status='completed' WHERE b.job_id=job_id AND step_id='security_review';
        PERFORM expect_error(format('SELECT builder_start_code_review(%L,%L,%L::uuid[])',job_id,review_step,old_ids),'incomplete');
        FOREACH t IN ARRAY ARRAY['code_implementation','changed_file_manifest','build_logs','security_review'] LOOP
          artifact_id:=gen_random_uuid(); new_ids:=array_append(new_ids,artifact_id);
          INSERT INTO builder_artifacts VALUES(artifact_id,job_id,review_step,t,'final',now());
        END LOOP;
        PERFORM builder_start_code_review(job_id,review_step,new_ids,ARRAY[owner_id]);
        SELECT id INTO fresh_approval FROM builder_approvals b WHERE b.job_id=job_id AND status='pending';
        IF fresh_approval IS NULL OR fresh_approval=approval_id THEN RAISE EXCEPTION 'Fresh human review not required'; END IF;
        PERFORM set_config('test.role','authenticated',false);
        PERFORM builder_decide_human_code_review(fresh_approval,'approved','Fresh evidence reviewed');
        IF (SELECT code_review_status FROM builder_jobs WHERE id=job_id)<>'passed' THEN RAISE EXCEPTION 'Fresh review did not complete'; END IF;
      END;
      END LOOP;
      IF has_function_privilege('anon','builder_chat_request_code_changes(uuid)','EXECUTE')
        OR has_function_privilege('service_role','builder_chat_request_code_changes(uuid)','EXECUTE')
        OR NOT has_function_privilege('authenticated','builder_chat_request_code_changes(uuid)','EXECUTE')
        THEN RAISE EXCEPTION 'Wrong execute grants'; END IF;
      END $f$;
    `;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: fixture + migration + skipFunction + recoveryMigration + reviewFunctions + checks + recoveryChecks + cycleFixture
          + originalClaimFunctions + cycleMigration + cycleChecks + claimFunctions + cycleChecks,
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) { throw new Error(`PostgreSQL correction checks failed: ${error.stderr || error.message}`); }
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

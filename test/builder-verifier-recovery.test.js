const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { accountVerifierRecoveries } = require('../builder-verifier-recovery');

test('recovery accounting is fail-closed and scoped to one job', async () => {
  assert.equal(await accountVerifierRecoveries({ rpc: async (name, args) => {
    assert.equal(name, 'builder_account_verifier_recoveries');
    assert.deepEqual(args, { _job_id: 'job' });
    return { data: 1 };
  } }, 'job'), 1);
  await assert.rejects(accountVerifierRecoveries({ rpc: async () => ({ error: { message: 'unavailable' } }) }, 'job'), /accounting failed/);
  await assert.rejects(accountVerifierRecoveries({ rpc: async () => ({ data: null }) }, 'job'), /invalid evidence/);
});

test('Postgres refunds infrastructure once per lease, preserves real failures, and parks repeated recovery', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 60000
}, () => {
  const name = `bob-recovery-test-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000 }).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.equal(ready, true, 'isolated PostgreSQL started');
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261018160000_builder_verifier_recovery_accounting.sql'), 'utf8');
    const sql = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE TABLE public.builder_jobs (id uuid primary key, organization_id uuid, target_sha text, status text);
CREATE TABLE public.builder_job_steps (id uuid primary key, job_id uuid, attempt_count integer, retryable boolean, error text, updated_at timestamptz, status text, input_context jsonb);
CREATE TABLE public.builder_worker_runs (id uuid primary key, job_id uuid, organization_id uuid, step_id uuid, target_sha text, profile text, status text, log_summary text, created_at timestamptz, started_at timestamptz, patch_artifact_id uuid);
CREATE TABLE public.builder_audit_events (organization_id uuid, job_id uuid, event_type text, actor_type text, new_value jsonb, change_summary text, related_artifact_ids uuid[]);
${migration}
INSERT INTO builder_jobs VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','pin','implementation_pending');
INSERT INTO builder_job_steps VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',6,true,'lease expired',now(),'failed','{"patch_artifact_id":"00000000-0000-4000-8000-000000000004"}');
INSERT INTO builder_worker_runs VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','pin','frontend-verify','timeout',NULL,now(),now(),'00000000-0000-4000-8000-000000000004');
SET request.jwt.claim.role = 'service_role';
DO $check$
DECLARE j uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF builder_account_verifier_recoveries(j) <> 1 THEN RAISE EXCEPTION 'first recovery not counted'; END IF;
 IF NOT (SELECT retryable FROM builder_job_steps) THEN RAISE EXCEPTION 'first recovery not resumable'; END IF;
 IF (SELECT attempt_count FROM builder_job_steps) <> 5 THEN RAISE EXCEPTION 'infra consumed engineering budget'; END IF;
 IF builder_account_verifier_recoveries(j) <> 0 THEN RAISE EXCEPTION 'duplicate refunded twice'; END IF;
 UPDATE builder_worker_runs SET started_at = started_at + interval '1 second', status='failed', log_summary='Frontend patch verification failed';
 UPDATE builder_job_steps SET attempt_count=6;
 IF builder_account_verifier_recoveries(j) <> 0 THEN RAISE EXCEPTION 'real regression was refunded'; END IF;
 UPDATE builder_worker_runs SET log_summary='Frontend verifier infrastructure failure (OOM); the same patch is re-verified';
 IF builder_account_verifier_recoveries(j) <> 1 THEN RAISE EXCEPTION 'second recovery not recorded'; END IF;
 IF (SELECT retryable FROM builder_job_steps) THEN RAISE EXCEPTION 'unbounded infrastructure retry'; END IF;
 IF (SELECT count(*) FROM builder_audit_events) <> 2 THEN RAISE EXCEPTION 'recovery history not append-only'; END IF;
 IF (SELECT attempt_count FROM builder_job_steps) <> 5 THEN RAISE EXCEPTION 'second infra consumed repair budget'; END IF;
 UPDATE builder_worker_runs SET started_at = started_at + interval '1 second';
 UPDATE builder_job_steps SET retryable=true, error='Evidence conflict: immutable task scope';
 IF builder_account_verifier_recoveries(j) <> 0 THEN RAISE EXCEPTION 'evidence conflict was overridden'; END IF;
 IF (SELECT error FROM builder_job_steps) <> 'Evidence conflict: immutable task scope' THEN RAISE EXCEPTION 'immutable conflict lost'; END IF;
 UPDATE builder_job_steps SET retryable=true, error='Frontend worker verification failed', attempt_count=6;
 UPDATE builder_worker_runs SET started_at = started_at + interval '1 second', log_summary='Repository is red at the pinned commit (matching failure); not caused by this patch';
 IF builder_account_verifier_recoveries(j) <> 1 THEN RAISE EXCEPTION 'baseline was counted as a code revision'; END IF;
 IF (SELECT retryable FROM builder_job_steps) THEN RAISE EXCEPTION 'baseline was blindly retried'; END IF;
 IF (SELECT error FROM builder_job_steps) NOT LIKE 'baseline: repository red at the pinned commit:%' THEN RAISE EXCEPTION 'baseline attribution lost'; END IF;
 IF (SELECT attempt_count FROM builder_job_steps) <> 5 THEN RAISE EXCEPTION 'baseline consumed repair budget'; END IF;
END $check$;
SET request.jwt.claim.role = 'authenticated';
DO $check$
BEGIN
 BEGIN
  PERFORM builder_account_verifier_recoveries('00000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'caller role bypassed';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'Service identity required' THEN RAISE; END IF;
 END;
END $check$;
`;
    const result = execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000
    });
    assert.match(result, /DO/);
  } finally {
    docker(['rm', '-f', name]);
  }
});

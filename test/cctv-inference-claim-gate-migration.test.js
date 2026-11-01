'use strict';
// CCTV inference claim gate (review of PR #298, 2026-11-01): the release lane pauses claims in the database before
// replacing the vision watcher, because a queue read cannot stop a watcher claiming a job a moment later. A claim
// already in flight must commit before the pause does, so the lane's drain read sees it. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261102170000_cctv_inference_claim_gate.sql'), 'utf8');
const lane = fs.readFileSync(path.join(__dirname, '../scripts/bob-release-lane.sh'), 'utf8');

test('claim gate RPCs are service-only, fail closed and keep the claim contract the watcher relies on', () => {
  for (const signature of ['pause_cctv_inference_claims\\(text, text, integer\\)', 'resume_cctv_inference_claims\\(text\\)', 'claim_cctv_inference_job\\(uuid, uuid, integer\\)']) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated, service_role;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO postgres, service_role;`));
  }
  assert.match(migration, /ALTER TABLE public\.cctv_inference_claim_pauses ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.cctv_inference_claim_pauses FROM PUBLIC, anon, authenticated, service_role;/);
  assert.equal((migration.match(/IF coalesce\(auth\.role\(\), ''\) <> 'service_role' AND session_user NOT IN \('postgres', 'supabase_admin'\) THEN/g) || []).length, 3);
  assert.doesNotMatch(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /RETURNS TABLE\(id uuid, organization_id uuid, evidence_item_id uuid, domain text, status text, lease_token uuid\)/);
  assert.match(migration, /pg_advisory_xact_lock_shared\(hashtextextended\('public\.cctv_inference_claim_gate', 0\)\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('public\.cctv_inference_claim_gate', 0\)\)/);
  assert.match(lane, /rpc\/pause_cctv_inference_claims/);
  assert.match(lane, /rpc\/resume_cctv_inference_claims/);
  assert.match(lane, /"p_holder":"release-lane"/);
});

test('the claim gate blocks claims while paused, waits for in-flight claims and expires, against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-cctv-claim-gate-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psqlAs = (user) => (sql) => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = psqlAs('postgres');
  const api = psqlAs('api_gateway');
  const raises = (fn, pattern, message) => assert.throws(fn, (error) => pattern.test(String(error.stderr || error.message)), message);
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    psql(`
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE ROLE api_gateway LOGIN NOINHERIT; GRANT anon, authenticated, service_role TO api_gateway;
      END $$;
      CREATE EXTENSION dblink;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $fn$;
      CREATE TABLE public.inference_jobs (id uuid PRIMARY KEY, organization_id uuid NOT NULL, evidence_item_id uuid, domain text NOT NULL,
        status text NOT NULL DEFAULT 'queued', attempt_count integer NOT NULL DEFAULT 0, lease_token uuid, lease_expires_at timestamptz,
        heartbeat_at timestamptz, stage text NOT NULL DEFAULT 'queued', error_message text);
      ${migration}
    `);
    const job = (n) => `f${n}000000-0000-4000-8000-00000000000${n}`;
    psql(`INSERT INTO public.inference_jobs (id, organization_id, domain) SELECT ('f' || n || '000000-0000-4000-8000-00000000000' || n)::uuid,
      '0a000000-0000-4000-8000-00000000000a', 'video_motion' FROM generate_series(1, 5) n;`);
    const service = (sql) => api(`SET ROLE service_role; SELECT set_config('request.jwt.claim.role', 'service_role', false); ${sql}`).trim();
    const claim = (n) => service(`SELECT count(*) FROM public.claim_cctv_inference_job('${job(n)}', gen_random_uuid(), 900);`).split('\n').at(-1);

    assert.equal(claim(1), '1', 'an unpaused claim succeeds');
    assert.match(service(`SELECT public.pause_cctv_inference_claims('release-lane', 'release fixture is replacing the watcher', 600) > now();`), /t$/);
    assert.equal(claim(2), '0', 'a paused claim returns no job');
    assert.equal(psql(`SELECT status FROM public.inference_jobs WHERE id = '${job(2)}';`).trim(), 'queued');
    assert.match(service(`SELECT public.resume_cctv_inference_claims('release-lane');`), /t$/);
    assert.match(service(`SELECT public.resume_cctv_inference_claims('release-lane');`), /f$/, 'resuming twice is harmless');
    assert.equal(claim(2), '1', 'claims resume');
    psql(`INSERT INTO public.cctv_inference_claim_pauses (holder, reason, paused_until) VALUES ('crashed-lane', 'holder died', now() - interval '1 second');`);
    assert.equal(claim(3), '1', 'an expired pause is inert');

    raises(() => service(`SELECT public.pause_cctv_inference_claims('Release Lane', 'x', 600);`), /valid pause holder/);
    raises(() => service(`SELECT public.pause_cctv_inference_claims('release-lane', ' ', 600);`), /pause reason/);
    raises(() => service(`SELECT public.pause_cctv_inference_claims('release-lane', 'x', 30);`), /between 60 and 7200/);
    raises(() => api(`SET ROLE service_role; SELECT public.pause_cctv_inference_claims('release-lane', 'x', 600);`), /Service identity required/, 'a missing request role fails closed');
    raises(() => api(`SET ROLE service_role; SELECT count(*) FROM public.claim_cctv_inference_job('${job(4)}', gen_random_uuid(), 900);`), /Service identity required/, 'the replaced claim guard fails closed');
    for (const role of ['anon', 'authenticated']) {
      raises(() => api(`SET ROLE ${role}; SELECT public.pause_cctv_inference_claims('release-lane', 'x', 600);`), /permission denied/);
      raises(() => api(`SET ROLE ${role}; SELECT public.resume_cctv_inference_claims('release-lane');`), /permission denied/);
      raises(() => api(`SET ROLE ${role}; SELECT * FROM public.cctv_inference_claim_pauses;`), /permission denied/);
    }

    // Race: a claim in an open transaction holds the shared gate lock, so the pause waits for it to commit and the
    // lane's drain read then sees the job processing. Without the lock the pause would commit first and miss it.
    const race = psql(`
      SELECT dblink_connect('claimer', 'host=127.0.0.1 dbname=postgres user=postgres');
      SELECT dblink_exec('claimer', 'BEGIN');
      SELECT n FROM dblink('claimer', 'SELECT count(*) FROM public.claim_cctv_inference_job(''${job(4)}'', gen_random_uuid(), 900)') AS t(n bigint);
      SET lock_timeout = '300ms';
      DO $$ BEGIN
        PERFORM public.pause_cctv_inference_claims('release-lane', 'race fixture', 600);
        RAISE EXCEPTION 'pause did not wait for the in-flight claim';
      EXCEPTION WHEN lock_not_available THEN NULL;
      END $$;
      SELECT dblink_exec('claimer', 'COMMIT');
      RESET lock_timeout;
      SELECT public.pause_cctv_inference_claims('release-lane', 'race fixture', 600) IS NOT NULL;
      SELECT count(*) FROM public.inference_jobs WHERE status = 'processing' AND domain = 'video_motion';
    `).trim().split('\n');
    assert.equal(race.at(-1), '4', 'the in-flight claim is committed and visible once the pause returns');
    assert.equal(claim(5), '0', 'claims after the pause see it');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});

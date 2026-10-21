const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { executeBuilderAction } = require('../builder-runtime-coordinator');
const { validateAcceptanceEvidence } = require('../builder-agentic-engineer');
const { automergeEligible, routineRepairHold } = require('../builder-autopilot');

function repairFixture(scopes) {
  const bytes = Buffer.from(JSON.stringify({
    delivery_requirements: scopes.map((source_scope, index) => ({ id: `DR-${index}`, source_scope })),
  }));
  const calls = [];
  const snapshot = {
    job: { id: 'job', autopilot_source: 'main_monitor' },
    steps: [
      { id: 'product', step_id: 'product_analysis', status: 'completed' },
      { id: 'front', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer', status: 'pending' },
      { id: 'back', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'pending' },
    ],
    artifacts: [{ id: 'spec', step_id: 'product', artifact_type: 'product_specification', status: 'final' }],
    workerRuns: [],
  };
  const supabase = {
    from() {
      return { select() { return this; }, eq() { return this; }, single: async () => ({ data: {
        id: 'spec', job_id: 'job', artifact_type: 'product_specification', status: 'final',
        checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
        storage_location: 'supabase_storage://builder-artifacts/org/job/spec',
      } }) };
    },
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => bytes } }) }) },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: {} }; },
  };
  return { snapshot, supabase, calls };
}

test('main-health routes backend-only work without forcing a frontend edit or model invocation', async () => {
  const fixture = repairFixture([['services/fcm-api/src/bob/plan.js', 'test/plan.test.js']]);
  const result = await executeBuilderAction({
    ...fixture, action: { type: 'run_frontend', step: fixture.snapshot.steps[1] }, context: {},
    handlers: { frontend: async () => assert.fail('no frontend scope') },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.specification_artifact_id, 'spec');
  assert.equal(fixture.calls[0].name, 'builder_skip_implementation_step');
  assert.match(fixture.calls[0].args._reason, /services\/fcm-api\/src\/bob\/plan.js/);
  assert.equal(fixture.calls[0].args._builder_mode, 'frontend_engineer');
  fixture.snapshot.steps[1].status = 'skipped';
  let invoked = false;
  await executeBuilderAction({
    ...fixture, action: { type: 'run_backend', step: fixture.snapshot.steps[2] }, context: {},
    handlers: { backend: async () => { invoked = true; return { success: true }; } },
  });
  assert.equal(invoked, true);
});

test('frontend-only and fullstack repairs invoke only the engineers named by the specification', async () => {
  for (const scopes of [[['apps/web/src/lib/example.ts']], [['apps/web/src/lib/example.ts'], ['supabase/functions/example/index.ts']]]) {
    const fixture = repairFixture(scopes);
    const invoked = [];
    const handlers = {
      frontend: async () => { invoked.push('frontend'); return { success: true }; },
      backend: async () => { invoked.push('backend'); return { success: true }; },
    };
    await executeBuilderAction({ ...fixture, action: { type: 'run_frontend', step: fixture.snapshot.steps[1] }, context: {}, handlers });
    fixture.snapshot.steps[1].status = 'completed';
    await executeBuilderAction({ ...fixture, action: { type: 'run_backend', step: fixture.snapshot.steps[2] }, context: {}, handlers });
    assert.deepEqual(invoked, scopes.length === 1 ? ['frontend'] : ['frontend', 'backend']);
  }
});

test('missing, invalid, or unusable sibling scope cannot silently skip a repair', async () => {
  for (const scopes of [[], [[]], [['../escape']], [[null]]]) {
    const fixture = repairFixture(scopes);
    await assert.rejects(executeBuilderAction({
      ...fixture, action: { type: 'run_frontend', step: fixture.snapshot.steps[1] }, context: {},
    }), /valid implementation scope/);
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = repairFixture([['test/fix.test.js']]);
  fixture.snapshot.steps[2].status = 'skipped';
  await assert.rejects(executeBuilderAction({
    ...fixture, action: { type: 'run_frontend', step: fixture.snapshot.steps[1] }, context: {},
  }), /sibling implementation/);
  fixture.snapshot.steps[2].status = 'pending';
  fixture.supabase.rpc = async () => ({ error: { message: 'unavailable' } });
  await assert.rejects(executeBuilderAction({
    ...fixture, action: { type: 'run_frontend', step: fixture.snapshot.steps[1] }, context: {},
  }), /could not be recorded: unavailable/);
});

test('cross-lane acceptance requires this lane to implement its share, not claim sibling completion', () => {
  const front = 'apps/web/src/lib/example.ts', back = 'supabase/functions/example/index.ts';
  const specification = { delivery_requirements: [
    { id: 'FRONT', source_scope: [front] }, { id: 'BACK', source_scope: [back] },
    { id: 'BOTH', source_scope: [front, back] },
  ] };
  const args = { acceptance_evidence: [
    { requirement_id: 'FRONT', status: 'completed', evidence: `Implemented ${front}` },
    { requirement_id: 'BOTH', status: 'completed', evidence: `Implemented ${front}` },
  ] };
  assert.equal(validateAcceptanceEvidence({ args, specification, files: [front], lane: 'frontend' }), null);
  assert.match(validateAcceptanceEvidence({ args, specification, files: [back], lane: 'backend' }), /BACK.*no completed/);
  assert.match(validateAcceptanceEvidence({ args: { acceptance_evidence: [args.acceptance_evidence[0]] }, specification, files: [front], lane: 'frontend' }), /BOTH.*no completed/);
  assert.match(validateAcceptanceEvidence({ args, specification, files: [front] }), /BACK.*no completed/, 'whole-job acceptance still checks both lanes');
});

test('backend and browser repair preparation does not authorize unattended release', () => {
  const job = { autopilot_source: 'main_monitor', repair_risk: 'routine',
    source_main_health_files: ['apps/web/e2e/example.spec.ts'] };
  const evidence = { verifyRun: {}, verificationContract: { passed: true }, security: { passed: true },
    review: { verdict: 'passed' }, changedFiles: ['services/fcm-api/src/bob/plan.js'] };
  assert.match(routineRepairHold({ job, approval: { approval_type: 'release_approval' }, evidence }).reasons[0], /outside the web app/);
  assert.equal(automergeEligible({ job, evidence, env: { BOB_AUTOPILOT_AUTOMERGE: 'true' } }).ok, false);
  evidence.changedFiles = ['apps/web/src/lib/example.ts'];
  assert.equal(automergeEligible({ job, evidence, env: { BOB_AUTOPILOT_AUTOMERGE: 'true' } }).ok, true, 'browser failure provenance can lead to a verified app-source fix');
});

test('Postgres creates fullstack repairs, deduplicates, scopes tenancy, and denies non-service callers', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 60000,
}, () => {
  const name = `bob-fullstack-test-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000 }).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.equal(ready, true);
    const migration = [
      '20261019150000_builder_fullstack_main_health_repairs.sql',
      '20261021081500_builder_root_health_tests.sql',
    ].map(file => fs.readFileSync(path.resolve(__dirname, '../supabase/migrations', file), 'utf8')).join('\n');
    const sql = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE TABLE builder_projects(id uuid PRIMARY KEY, organization_id uuid, status text);
CREATE TABLE builder_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, project_id uuid, parent_job_id uuid,
  status text DEFAULT 'intake', autopilot_source text, repair_risk text, source_main_health_sha text, source_main_health_files text[],
  autopilot_state text, autopilot_updated_at timestamptz, updated_at timestamptz, created_at timestamptz DEFAULT now(),
  frontend_required boolean, backend_required boolean, target_sha text, source_friction_packet_id uuid, last_error text);
CREATE TABLE builder_audit_events(organization_id uuid, job_id uuid, event_type text, actor_type text, new_value jsonb, change_summary text,
 actor_user_id uuid, previous_value jsonb, related_artifact_ids uuid[], related_approval_id uuid);
CREATE TABLE builder_approvals(id uuid PRIMARY KEY, job_id uuid, organization_id uuid, status text, approval_type text,
 triggered_at_status text, requested_target_sha text, reviewed_artifact_ids uuid[], expires_at timestamptz,
 approved_by uuid, decided_by uuid, approval_comment text, responded_at timestamptz, updated_at timestamptz);
CREATE TABLE bob_friction_packets(id uuid, repair_risk text, route text, stop_line_hit text, user_id uuid);
CREATE TABLE builder_artifacts(id uuid, job_id uuid, status text);
CREATE FUNCTION builder_autopilot_decide_approval(uuid,text) RETURNS builder_jobs LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'unexpected human-request fallback';
END $$;
CREATE FUNCTION builder_create_job_v2(uuid,uuid,text,text,text,text,text,boolean,boolean,text,uuid,text,text) RETURNS builder_jobs
LANGUAGE sql AS $$ INSERT INTO builder_jobs(organization_id,project_id,frontend_required,backend_required) VALUES($1,$2,$8,$9) RETURNING * $$;
${migration}
SET request.jwt.claim.role = 'service_role';
INSERT INTO builder_projects VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','active'),
 ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','active');
DO $check$
DECLARE j builder_jobs; again builder_jobs; p uuid := '00000000-0000-4000-8000-000000000001'; o uuid := '00000000-0000-4000-8000-000000000002';
BEGIN
 SELECT * INTO j FROM builder_open_main_health_repair(o,p,repeat('a',40),repeat('a',40),'Repair','Root cause',ARRAY['apps/web/e2e/example.spec.ts']);
 IF NOT j.frontend_required OR NOT j.backend_required OR j.autopilot_source <> 'main_monitor' THEN RAISE EXCEPTION 'not fullstack'; END IF;
 SELECT * INTO again FROM builder_open_main_health_repair(o,p,repeat('b',40),repeat('b',40),'Repair','Root cause',ARRAY['apps/web/e2e/example.spec.ts']);
 IF again.id <> j.id THEN RAISE EXCEPTION 'dedupe failed'; END IF;
 SELECT * INTO again FROM builder_open_main_health_repair(o,p,repeat('c',40),repeat('c',40),'Root repair','Root cause',ARRAY['test/root.test.js','test/module.test.mjs']);
 IF again.source_main_health_files[1] <> 'test/root.test.js' THEN RAISE EXCEPTION 'root scope lost'; END IF;
 UPDATE builder_jobs SET status = 'specification_ready', target_sha = repeat('c',40) WHERE id = again.id;
 INSERT INTO builder_approvals(id,job_id,organization_id,status,approval_type,triggered_at_status,requested_target_sha,reviewed_artifact_ids,expires_at)
 VALUES ('00000000-0000-4000-8000-000000000099',again.id,o,'pending','specification_review','specification_ready',repeat('c',40),ARRAY[]::uuid[],now()+interval '1 hour');
 SELECT * INTO again FROM builder_autopilot_decide_approval_guarded('00000000-0000-4000-8000-000000000099','Bounded root repair');
 IF again.status <> 'design_pending' THEN RAISE EXCEPTION 'root specification gate blocked'; END IF;
 IF builder_main_health_test_path_valid(NULL) OR builder_main_health_test_path_valid('test/../escape.test.js')
    OR builder_main_health_test_path_valid('test/nested/root.test.js') THEN RAISE EXCEPTION 'unsafe root scope accepted'; END IF;
 SELECT * INTO again FROM builder_open_main_health_repair('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003',repeat('a',40),repeat('a',40),'Repair','Root cause',ARRAY['apps/web/src/example.test.ts']);
 IF again.id = j.id THEN RAISE EXCEPTION 'cross-tenant reuse'; END IF;
 BEGIN
  PERFORM builder_open_main_health_repair(o,p,repeat('a',40),repeat('a',40),'Repair','Root cause',ARRAY['../escape.test.ts']);
  RAISE EXCEPTION 'unsafe path accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'unsafe path accepted' THEN RAISE; END IF; END;
 BEGIN
  PERFORM builder_open_main_health_repair(o,p,repeat('a',40),repeat('a',40),'Repair','Root cause',ARRAY['apps/web/src/example.test.ts'],again.id);
  RAISE EXCEPTION 'cross-project parent accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'cross-project parent accepted' THEN RAISE; END IF; END;
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 BEGIN
  PERFORM builder_open_main_health_repair(o,p,repeat('a',40),repeat('a',40),'Repair','Root cause',ARRAY['apps/web/src/example.test.ts']);
  RAISE EXCEPTION 'non-service caller accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'non-service caller accepted' THEN RAISE; END IF; END;
 IF has_function_privilege('authenticated','builder_open_main_health_repair(uuid,uuid,text,text,text,text,text[],uuid)','EXECUTE') THEN RAISE EXCEPTION 'public execute grant'; END IF;
END;
$check$;`;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});

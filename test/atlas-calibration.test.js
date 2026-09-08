const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectCalibrationStatus, syncCalibrationStatus } = require('../scripts/atlas-calibration');
const { buildAtlasGraph, syncAtlasGraph } = require('../scripts/atlas-graph');
const { buildRefreshPlan } = require('../scripts/atlas-refresh');

test('atlas, oracle, caddie, conductor, endpoint, db, and UI/UX calibration stays synchronized', () => {
  const rootDir = path.resolve(__dirname, '..');
  const status = collectCalibrationStatus(rootDir);

  assert.equal(status.ok, true);
  assert.ok(status.modules.includes('atlas'));
  assert.ok(status.modules.includes('oracle'));
  assert.ok(status.modules.includes('caddie'));
  assert.ok(status.modules.includes('conductor'));
  assert.ok(status.modules.includes('endpoint_contract'));
  assert.ok(status.modules.includes('database_schema'));
  assert.ok(status.modules.includes('workflow_lease'));
  assert.ok(status.modules.includes('gitlab_read_boundary'));
  assert.ok(status.modules.includes('repo_read_progress'));
  assert.ok(status.modules.includes('frontend_patch_worker'));
  assert.ok(status.modules.includes('backend_engineer'));
  assert.ok(status.modules.includes('backend_patch_worker'));
  assert.ok(status.modules.includes('backend_database_verifier'));
  assert.ok(status.modules.includes('independent_security_worker'));
  assert.ok(status.modules.includes('aggregate_builder_review'));
  assert.ok(status.modules.includes('builder_runtime_coordinator'));
  assert.ok(status.modules.includes('builder_control_room'));
  assert.ok(status.modules.includes('release_preparation'));
  assert.ok(status.modules.includes('optional_code_review'));
  assert.ok(status.modules.includes('officer_safety_system'));
  assert.ok(status.modules.includes('safety_gating'));
  assert.ok(status.modules.includes('officer_pin_status'));
  assert.ok(status.modules.includes('ui_ux_contract'));
  assert.equal(status.missing.length, 0);

  const synced = syncCalibrationStatus(rootDir);
  assert.equal(synced.ok, true);
  assert.ok(synced.updatedAt);
});

test('calibration update writes a fresh status artifact across all surfaces', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-calibration-'));
  const files = {
    'supabase/functions/bob-query-atlas/index.ts': 'blast_radius\nflow_reach\nfk_reach',
    'supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts': 'buildOracleTurnTruthState\nconductorSafetyPrecedence',
    'supabase/functions/onspace-ai-chat/caddie.ts': 'generateToolCatalogue\nclassifyToolEffect',
    'supabase/functions/onspace-ai-chat/index.ts': 'execQueryAtlas\ngenerateToolCatalogue',
    'bob-control-plane-server.js': 'health\nassessment\n/jobs\n/webhooks/gitea',
    'supabase/schema.sql': 'CREATE TABLE public.organizations\nCREATE TABLE public.client_sites',
    'supabase/migrations/20260828000000_workflow_run_leases.sql': 'lease_token\nlease_expires_at\nwf_runs_one_active_lease_per_job\nwf_heartbeat_run\nwf_service_pickup_run\nwf_service_return_artifact',
    'supabase/functions/bob-repo-search/index.ts': 'GITLAB_READ_TOKEN\nGITLAB_TOKEN\nGITLAB_WRITE_TOKEN\nGITLAB_ALLOWED_PROJECTS\nwrite_bob_chat\ntrackReadProgress',
    'supabase/migrations/20260828010000_bob_repo_read_progress.sql': 'bob_repo_read_progress\nmax_line_read\nconversation_id',
    'frontend-worker.js': 'validatePatchText\ngit apply\nchanged-files.json\nverification.json\nredactLog',
    'supabase/functions/_shared/builder-backend-engineer.js': 'collectBackendSourceContext\nclassifyBackendChangeRisk\nparseBackendProposal\nrollback_notes\nrequires_human_approval',
    'backend-worker.js': 'executeBackendPatch\nstatic_backend_patch\nmigration_execution\nchanged-files.json\nbackend-verification.json',
    'backend-database-verifier.js': 'executeBackendDatabaseVerification\npublic.ecr.aws/supabase/postgres\nnetwork=none\ncanonical_schema\ncandidate_migrations',
    'security-worker.js': 'reviewPatch\ncredential-material\nprotected-surface-change\npatch_sha256\nmanifest_sha256',
    'builder-security-handoff.js': 'builder_claim_aggregate_security_review\nimplementationWorkerRunIds\naggregate security evidence\nbuilder_recover_expired_security_review',
    'builder-runtime-coordinator.js': 'planBuilderAction\nadvanceBuilderJob\nrunBuilderUntilPause\nwaiting_for_human\naction_limit',
    'supabase/functions/bob-builder-control-room/index.ts': "CAN_BUILD\nadmin.rpc('builder_create_job'\ncanAccessOrganization\naction === 'advance' || action === 'run'\nsafeSnapshot",
    'supabase/functions/_shared/builder-release-engineer.js': 'deriveReleaseImpact\nrollback_steps\ndeployment_enabled\napproval',
    'supabase/functions/_shared/builder-independent-code-review.js': 'parseIndependentCodeReview\nreviewerModelName\nabortIndependentCodeReview\nno approval',
    'apps/web/src/hooks/useOfficerSafety.ts': 'recordMovement\nacknowledgeAlert\ndetectionState\nactiveAlert',
    'apps/web/src/components/SafetyGate.tsx': 'getModuleAccessMessage\nsafetyRelevant',
    'apps/web/src/lib/officerPinStatus.ts': 'gpsAgeMs\nsafetyStatus\nalerting',
    'src/types/database.ts': 'export type Database',
    'README.md': 'Architecture\nLocal validation\nWorker isolation',
    'docs/backend-integration-blueprint.md': 'Assessment before implementation\nHistorical application'
  };

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  const status = syncCalibrationStatus(rootDir);

  assert.equal(status.ok, true);
  const artifactPath = path.join(rootDir, '.bob', 'atlas-calibration.json');
  assert.equal(fs.existsSync(artifactPath), true);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.equal(artifact.ok, true);
  assert.ok(artifact.updatedAt);

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('atlas graph inventories app, platform, deployment, and governance without synthetic concrete edges', () => {
  const rootDir = path.resolve(__dirname, '..');
  const graph = buildAtlasGraph(rootDir);

  assert.equal(graph.ok, true);
  assert.ok(graph.domains.includes('app'));
  assert.ok(graph.domains.includes('platform'));
  assert.ok(graph.domains.includes('deployment'));
  assert.ok(graph.domains.includes('governance'));
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.nodes.some((node) => node.type === 'route' && node.name === '/assessment'));
  assert.ok(graph.nodes.some((node) => node.type === 'edge_function' && node.name === 'bob-query-atlas'));
  assert.ok(graph.nodes.some((node) => node.type === 'table' && node.name === 'bob_capability_map'));
  assert.ok(graph.nodes.some((node) => node.type === 'service' && node.name === 'bob-control-plane'));
  assert.equal(graph.concreteEdges.length, 0);

  const synced = syncAtlasGraph(rootDir);
  assert.equal(synced.ok, true);
  assert.ok(synced.updatedAt);
  const artifact = JSON.parse(fs.readFileSync(path.join(rootDir, '.bob', 'atlas-graph.json'), 'utf8'));
  assert.equal(artifact.ok, true);
  assert.ok(artifact.domains.includes('governance'));
});

test('Atlas refresh derives internal conductor callFn dispatches as live edges', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-fn-'));
  const functionPath = path.join(rootDir, 'supabase/functions/onspace-ai-chat/index.ts');
  const targetPath = path.join(rootDir, 'supabase/functions/bob-query-atlas/index.ts');
  fs.mkdirSync(path.dirname(functionPath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(functionPath, "callFn('bob-query-atlas', authHeader, { action: 'gap_report' });");
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'onspace-ai-chat'
    && edge.target_type === 'edge_function'
    && edge.target_name === 'bob-query-atlas'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives conductor wrapper and variable-dispatched function calls', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dynamic-call-'));
  const functionPath = path.join(rootDir, 'supabase/functions/onspace-ai-chat/index.ts');
  for (const name of ['bob-inference', 'bob-perceive-image', 'bob-perceive-video']) {
    const targetPath = path.join(rootDir, `supabase/functions/${name}/index.ts`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'export default {}');
  }
  fs.mkdirSync(path.dirname(functionPath), { recursive: true });
  fs.writeFileSync(functionPath, "const fn = isImage ? 'bob-perceive-image' : 'bob-perceive-video'; callFn(fn, authHeader, {}); callInference({ action: 'embed' });");

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);
  const targets = manifest.edges.filter((edge) => edge.source_name === 'onspace-ai-chat').map((edge) => edge.target_name);

  assert.ok(targets.includes('bob-perceive-image'));
  assert.ok(targets.includes('bob-perceive-video'));
  assert.ok(targets.includes('bob-inference'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives root workflow-client endpoint map dispatches', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-workflow-client-'));
  const clientPath = path.join(rootDir, 'supabase-workflow-client.js');
  const targetPath = path.join(rootDir, 'supabase/functions/wf-create-job/index.ts');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, 'export default {}');
  fs.writeFileSync(clientPath, "const functionNames = { createJob: 'wf-create-job' }; fetch(`\${url}/functions/v1/\${functionName}`);");

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'supabase-workflow-client'
    && edge.target_name === 'wf-create-job'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives explicit function URL variables passed to fetch', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-url-variable-'));
  const sourcePath = path.join(rootDir, 'supabase/functions/bob-job-plan-approve/index.ts');
  const targetPath = path.join(rootDir, 'supabase/functions/bob-notify-conductor/index.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(sourcePath, "const url = `\${SUPABASE_URL}/functions/v1/bob-notify-conductor`; fetch(url, {});");
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'bob-job-plan-approve'
    && edge.target_name === 'bob-notify-conductor'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives named function URL variables passed to fetch', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-named-url-variable-'));
  const sourcePath = path.join(rootDir, 'supabase/functions/process-officer-scan/index.ts');
  const targetPath = path.join(rootDir, 'supabase/functions/classify-parking-scene/index.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(sourcePath, "const classifyUrl = `${SUPABASE_URL}/functions/v1/classify-parking-scene`; fetch(classifyUrl, {});");
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'process-officer-scan'
    && edge.target_name === 'classify-parking-scene'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives canonical schema trigger invocations', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trigger-'));
  const schemaPath = path.join(rootDir, 'supabase/schema.sql');
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(schemaPath, `
    create table public.samples (id uuid);
    create function public.touch_sample() returns trigger language plpgsql as $$ begin return new; end; $$;
    create trigger samples_touch before update on public.samples for each row execute function public.touch_sample();
  `);

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'samples'
    && edge.target_name === 'touch_sample'
    && edge.edge_kind === 'triggers'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives Ops scheduler HTTP calls to edge functions', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ops-scheduler-'));
  const migrationPath = path.join(rootDir, 'supabase/migrations/20260908005000_schedule.sql');
  const targetPath = path.join(rootDir, 'supabase/functions/welfare-escalation-tick/index.ts');
  fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(migrationPath, `create function ops.enqueue_tick() returns bigint language plpgsql as $$ begin perform net.http_post(url := v_project_url || '/functions/v1/welfare-escalation-tick'); return 1; end; $$;`);
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'enqueue_tick'
    && edge.target_name === 'welfare-escalation-tick'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives FCM Desktop evidence registration calls', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-desktop-bridge-'));
  const sourcePath = path.join(rootDir, 'apps/sd-card-bridge/src/main.tsx');
  const targetPath = path.join(rootDir, 'supabase/functions/register-desktop-video-import/index.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(sourcePath, "supabase.functions.invoke('register-desktop-video-import', { body: {} });");
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'apps/sd-card-bridge/src/main'
    && edge.target_name === 'register-desktop-video-import'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives edge-function URLs supplied to a client library', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-client-url-'));
  const sourcePath = path.join(rootDir, 'apps/web/src/components/Map.tsx');
  const targetPath = path.join(rootDir, 'supabase/functions/linz-map-tile/index.ts');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(sourcePath, "const tileUrl = `${base}/functions/v1/linz-map-tile?z={z}`; L.tileLayer(tileUrl);");
  fs.writeFileSync(targetPath, 'export default {}');

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'components/Map'
    && edge.target_name === 'linz-map-tile'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas refresh derives direct SQL RPC calls', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sql-rpc-call-'));
  const schemaPath = path.join(rootDir, 'supabase/schema.sql');
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(schemaPath, `
    create function public.target_helper() returns void language plpgsql as $$ begin end; $$;
    create function public.source_worker() returns void language plpgsql as $$ begin perform public.target_helper(); end; $$;
  `);

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.edges.some((edge) => edge.source_name === 'source_worker'
    && edge.target_type === 'rpc'
    && edge.target_name === 'target_helper'
    && edge.edge_kind === 'calls'));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('Atlas derives dispatch pay and travel feature capabilities from SQL flow', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rate-features-'));
  const schemaPath = path.join(rootDir, 'supabase/schema.sql');
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(schemaPath, `
    create function public.compute_travel_distance_km() returns void language plpgsql as $$ begin end; $$;
    create function public.resolve_dispatch_job_pay_lines() returns void language plpgsql as $$ begin perform public.compute_travel_distance_km(); end; $$;
    create function public.advance_dispatch_job_status() returns void language plpgsql as $$ begin perform public.resolve_dispatch_job_pay_lines(); end; $$;
  `);

  const manifest = require('../scripts/atlas-refresh').collectAtlasRefresh(rootDir);

  assert.ok(manifest.capabilities.some((capability) => capability.entity_type === 'feature'
    && capability.entity_name === 'rate_rules_pay_resolve_pay_lines'
    && capability.wired));
  assert.ok(manifest.capabilities.some((capability) => capability.entity_type === 'feature'
    && capability.entity_name === 'travel_km_rate_context_distance'
    && capability.wired));
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('derived feature wiring replaces stale manual exercise assertions with unknown', () => {
  const plan = buildRefreshPlan({
    capabilities: [{
      entity_type: 'feature', entity_name: 'rate_rules_pay_resolve_pay_lines', present: true,
      wired: true, exercised: null, caller_summary: 'advance_dispatch_job_status', notes: 'derived',
      refresh_source: 'ci_generator', retirement_status: 'live'
    }],
    edges: [],
    repository_files: []
  }, [{
    id: 'feature-id', entity_type: 'feature', entity_name: 'rate_rules_pay_resolve_pay_lines', present: true,
    wired: false, exercised: false, caller_summary: null, notes: 'legacy', refresh_source: 'manual_seed', retirement_status: 'live'
  }], []);

  assert.equal(plan.capabilityUpserts[0].exercised, null);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectCalibrationStatus, syncCalibrationStatus } = require('../scripts/atlas-calibration');
const { buildAtlasGraph, syncAtlasGraph } = require('../scripts/atlas-graph');

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
  assert.ok(status.modules.includes('independent_security_worker'));
  assert.ok(status.modules.includes('release_preparation'));
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
    'security-worker.js': 'reviewPatch\ncredential-material\nprotected-surface-change\npatch_sha256\nmanifest_sha256',
    'supabase/functions/_shared/builder-release-engineer.js': 'deriveReleaseImpact\nrollback_steps\ndeployment_enabled\napproval',
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

test('atlas graph maps app, platform, deployment, and governance domains with change-impact edges', () => {
  const rootDir = path.resolve(__dirname, '..');
  const graph = buildAtlasGraph(rootDir);

  assert.equal(graph.ok, true);
  assert.ok(graph.domains.includes('app'));
  assert.ok(graph.domains.includes('platform'));
  assert.ok(graph.domains.includes('deployment'));
  assert.ok(graph.domains.includes('governance'));
  assert.ok(graph.edges.some((edge) => edge.source === 'app' && edge.target === 'platform'));
  assert.ok(graph.edges.some((edge) => edge.source === 'platform' && edge.target === 'deployment'));
  assert.ok(graph.nodes.some((node) => node.type === 'route' && node.name === '/assessment'));
  assert.ok(graph.nodes.some((node) => node.type === 'edge_function' && node.name === 'bob-query-atlas'));
  assert.ok(graph.nodes.some((node) => node.type === 'table' && node.name === 'bob_capability_map'));
  assert.ok(graph.nodes.some((node) => node.type === 'service' && node.name === 'bob-control-plane'));
  assert.ok(graph.concreteEdges.some((edge) => edge.source === 'route:/assessment' && edge.target === 'service:bob-control-plane'));
  assert.ok(graph.concreteEdges.some((edge) => edge.source === 'edge_function:bob-query-atlas' && edge.target === 'table:bob_app_map_edges'));

  const synced = syncAtlasGraph(rootDir);
  assert.equal(synced.ok, true);
  assert.ok(synced.updatedAt);
  const artifact = JSON.parse(fs.readFileSync(path.join(rootDir, '.bob', 'atlas-graph.json'), 'utf8'));
  assert.equal(artifact.ok, true);
  assert.ok(artifact.domains.includes('governance'));
});

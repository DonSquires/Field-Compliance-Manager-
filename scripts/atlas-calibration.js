const fs = require('node:fs');
const path = require('node:path');

const REQUIREMENTS = [
  {
    name: 'atlas',
    file: 'supabase/functions/bob-query-atlas/index.ts',
    requiredMarkers: ['blast_radius', 'flow_reach', 'fk_reach']
  },
  {
    name: 'oracle',
    file: 'supabase/functions/onspace-ai-chat/conductor-welfare-seam.ts',
    requiredMarkers: ['buildOracleTurnTruthState', 'conductorSafetyPrecedence']
  },
  {
    name: 'caddie',
    file: 'supabase/functions/onspace-ai-chat/caddie.ts',
    requiredMarkers: ['generateToolCatalogue', 'classifyToolEffect']
  },
  {
    name: 'conductor',
    file: 'supabase/functions/onspace-ai-chat/index.ts',
    requiredMarkers: ['execQueryAtlas', 'generateToolCatalogue']
  },
  {
    name: 'endpoint_contract',
    file: 'bob-control-plane-server.js',
    requiredMarkers: ['/health', '/assessment', '/jobs', '/webhooks/gitea']
  },
  {
    name: 'database_schema',
    file: 'supabase/schema.sql',
    requiredMarkers: [
      'create table',
      'organizations',
      'client_sites'
    ]
  },
  {
    name: 'workflow_lease',
    file: 'supabase/migrations/20260828000000_workflow_run_leases.sql',
    requiredMarkers: ['lease_token', 'lease_expires_at', 'wf_runs_one_active_lease_per_job', 'wf_heartbeat_run', 'wf_service_pickup_run', 'wf_service_return_artifact']
  },
  {
    name: 'gitlab_read_boundary',
    file: 'supabase/functions/bob-repo-search/index.ts',
    requiredMarkers: ['GITLAB_READ_TOKEN', 'GITLAB_WRITE_TOKEN', 'GITLAB_ALLOWED_PROJECTS', 'write_bob_chat', 'trackReadProgress']
  },
  {
    name: 'repo_read_progress',
    file: 'supabase/migrations/20260828010000_bob_repo_read_progress.sql',
    requiredMarkers: ['bob_repo_read_progress', 'max_line_read', 'conversation_id']
  },
  {
    name: 'frontend_patch_worker',
    file: 'frontend-worker.js',
    requiredMarkers: ['validatePatchText', 'git apply', 'changed-files.json', 'verification.json', 'redactLog']
  },
  {
    name: 'backend_engineer',
    file: 'supabase/functions/_shared/builder-backend-engineer.js',
    requiredMarkers: ['collectBackendSourceContext', 'classifyBackendChangeRisk', 'parseBackendProposal', 'rollback_notes', 'requires_human_approval']
  },
  {
    name: 'backend_patch_worker',
    file: 'backend-worker.js',
    requiredMarkers: ['executeBackendPatch', 'static_backend_patch', 'migration_execution', 'changed-files.json', 'backend-verification.json']
  },
  {
    name: 'backend_database_verifier',
    file: 'backend-database-verifier.js',
    requiredMarkers: ['executeBackendDatabaseVerification', 'public.ecr.aws/supabase/postgres', 'network=none', 'canonical_schema', 'candidate_migrations']
  },
  {
    name: 'independent_security_worker',
    file: 'security-worker.js',
    requiredMarkers: ['reviewPatch', 'credential-material', 'protected-surface-change', 'patch_sha256', 'manifest_sha256']
  },
  {
    name: 'aggregate_builder_review',
    file: 'builder-security-handoff.js',
    requiredMarkers: ['builder_claim_aggregate_security_review', 'implementationWorkerRunIds', 'aggregate security evidence', 'builder_recover_expired_security_review']
  },
  {
    name: 'builder_runtime_coordinator',
    file: 'builder-runtime-coordinator.js',
    requiredMarkers: ['planBuilderAction', 'advanceBuilderJob', 'runBuilderUntilPause', 'waiting_for_human', 'action_limit']
  },
  {
    name: 'builder_control_room',
    file: 'supabase/functions/bob-builder-control-room/index.ts',
    requiredMarkers: ['CAN_BUILD', "admin.rpc('builder_create_job'", 'canAccessOrganization', "action === 'advance' || action === 'run'", 'safeSnapshot']
  },
  {
    name: 'release_preparation',
    file: 'supabase/functions/_shared/builder-release-engineer.js',
    requiredMarkers: ['deriveReleaseImpact', 'rollback_steps', 'deployment_enabled', 'approval']
  },
  {
    name: 'optional_code_review',
    file: 'supabase/functions/_shared/builder-independent-code-review.js',
    requiredMarkers: ['parseIndependentCodeReview', 'reviewerModelName', 'abortIndependentCodeReview', 'no approval']
  },
  {
    name: 'officer_safety_system',
    file: 'apps/web/src/hooks/useOfficerSafety.ts',
    requiredMarkers: ['recordMovement', 'acknowledgeAlert', 'detectionState', 'activeAlert']
  },
  {
    name: 'safety_gating',
    file: 'apps/web/src/components/SafetyGate.tsx',
    requiredMarkers: ['getModuleAccessMessage', 'safetyRelevant']
  },
  {
    name: 'officer_pin_status',
    file: 'apps/web/src/lib/officerPinStatus.ts',
    requiredMarkers: ['gpsAgeMs', 'safetyStatus', 'alerting']
  },
  {
    name: 'ui_ux_contract',
    file: 'README.md',
    requiredMarkers: ['Architecture', 'Local validation', 'Worker isolation']
  }
];

function normalizeMarker(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_"'`\s/]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function markerIsPresent(content, marker) {
  const normalizedContent = normalizeMarker(content);
  const normalizedMarker = normalizeMarker(marker);
  return normalizedContent.includes(normalizedMarker);
}

function collectCalibrationStatus(rootDir = process.cwd()) {
  const modules = [];
  const missing = [];

  for (const spec of REQUIREMENTS) {
    const filePath = path.join(rootDir, spec.file);
    if (!fs.existsSync(filePath)) {
      missing.push({ module: spec.name, file: spec.file, reason: 'missing file' });
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const foundMarkers = spec.requiredMarkers.filter((marker) => markerIsPresent(content, marker));
    if (foundMarkers.length !== spec.requiredMarkers.length) {
      missing.push({
        module: spec.name,
        file: spec.file,
        reason: `missing markers: ${spec.requiredMarkers.filter((marker) => !markerIsPresent(content, marker)).join(', ')}`
      });
      continue;
    }

    modules.push({
      name: spec.name,
      file: spec.file,
      markers: spec.requiredMarkers,
      status: 'current'
    });
  }

  const now = new Date().toISOString();
  return {
    ok: missing.length === 0,
    updatedAt: now,
    modules: modules.map((module) => module.name),
    missing,
    details: modules
  };
}

function syncCalibrationStatus(rootDir = process.cwd()) {
  const status = collectCalibrationStatus(rootDir);
  const artifactDir = path.join(rootDir, '.bob');
  fs.mkdirSync(artifactDir, { recursive: true });

  const artifactPath = path.join(artifactDir, 'atlas-calibration.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify({ ...status, generatedBy: 'atlas-calibration' }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });

  return status;
}

if (require.main === module) {
  const rootDir = path.resolve(process.argv[2] || process.cwd());
  const status = syncCalibrationStatus(rootDir);

  if (!status.ok) {
    console.error('Atlas calibration failed:');
    for (const item of status.missing) {
      console.error(`- ${item.module}: ${item.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Atlas calibration ok: ${status.modules.join(', ')} (${status.updatedAt})`);
}

module.exports = {
  collectCalibrationStatus,
  syncCalibrationStatus
};

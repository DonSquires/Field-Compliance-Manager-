import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveNztaPlateFromOcr } = require(path.join(root, 'services/fcm-api/src/bob/identityDocument.js'));
const { guardPlateLines, guardProposedEntities } = require(path.join(root, 'services/fcm-api/src/bob/documents.js'));

export const enterpriseDomains = Object.freeze([
  {
    id: 'governance',
    label: 'One Bob, orchestration, Guardian and egress',
    state: 'implemented',
    authority: 'Server-owned rank, tenant, privacy and effect gates',
    evidence: [
      'docs/canon/BOB_DOCTRINE.md',
      'supabase/functions/onspace-ai-chat/index.ts',
      'services/fcm-api/src/bob/verify.js',
    ],
    tests: ['test/bob-conversation-agent-modes.test.js', 'test/fcm-api-bob-planner.test.js'],
  },
  {
    id: 'document_identity',
    label: 'Document OCR and high-risk identifiers',
    state: 'implemented',
    authority: 'Consensus candidate plus attributable human identity review',
    evidence: [
      'services/fcm-api/src/bob/identityDocument.js',
      'services/fcm-api/src/bob/documents.js',
      'supabase/migrations/20261010204538_govern_nzta_mvr_identity_checks.sql',
    ],
    tests: ['test/identity-records-workspace.test.js'],
  },
  {
    id: 'cctv_perception',
    label: 'CCTV ALPR, face/person, vehicle attributes and enhancement',
    state: 'implemented',
    authority: 'Immutable source and derivative receipts; dedicated human review',
    evidence: [
      'services/vision/vision_job_watcher.js',
      'services/fcm-inference/app.py',
      'supabase/migrations/20261010230154_cctv_alpr_perception_envelope_adapter.sql',
      'supabase/migrations/20261010231809_cctv_person_face_perception_envelope_adapter.sql',
      'supabase/migrations/20261010232800_cctv_vehicle_attribute_perception_adapter.sql',
    ],
    tests: [
      'test/cctv-enhancement-pipeline.test.js',
      'test/cctv-worker-observations.test.js',
      'test/perception-evidence-envelope.test.js',
    ],
  },
  {
    id: 'parking_freedom_camping',
    label: 'Parking and freedom-camping field decisions',
    state: 'partial',
    authority: 'Geofence, movement and jurisdiction rules; officer/enforcement review',
    evidence: [
      'supabase/functions/process-officer-scan/index.ts',
      'docs/canon/FREEDOM_CAMPING_IMPLEMENTATION_BLUEPRINT.md',
    ],
    tests: [
      'test/mobile-officer-scan-contract.test.js',
      'test/officer-parking-place-context.test.js',
      'test/geofence-p1-callers.test.js',
    ],
    gap: 'Shared evidence-envelope projection and calibrated multi-visit ambiguity receipts remain to be completed.',
  },
  {
    id: 'access_control',
    label: 'Access-control recognition and entitlement',
    state: 'gap',
    authority: 'Entitlement engine remains authoritative; recognition must never grant access directly',
    evidence: ['apps/web/src/pages/AccessControlPage.tsx', 'docs/canon/ACCESS_MODEL.md'],
    tests: ['test/operational-only-location-access.test.js'],
    gap: 'No domain-specific perception adapter yet compiles recognition candidates into the shared evidence contract.',
  },
  {
    id: 'environmental',
    label: 'Smoke, noise and biosecurity',
    state: 'implemented',
    authority: 'Advisory visible-image candidates separated from legal and workflow decisions',
    evidence: [
      'supabase/functions/submit-smoke-assessment/index.ts',
      'supabase/functions/submit-noise-assessment/index.ts',
      'supabase/functions/submit-biosecurity-assessment/index.ts',
    ],
    tests: [
      'test/smoke-photo-perception.test.js',
      'test/noise-photo-perception.test.js',
      'test/biosecurity-photo-perception.test.js',
    ],
  },
  {
    id: 'desktop_v2',
    label: 'Desktop V2 local acquisition and perception node',
    state: 'partial',
    authority: 'Read-only source acquisition, hashes and governed upload registration',
    evidence: [
      'apps/sd-card-bridge-v2/src/main.tsx',
      'apps/sd-card-bridge-v2/src-tauri/src/lib.rs',
      'apps/sd-card-bridge-v2/README.md',
    ],
    tests: ['test/sd-card-bridge-v2-product-surface.test.js'],
    gap: 'Signed local model manifests, offline perception receipts and conflict reconciliation are not complete.',
  },
  {
    id: 'builder_self_heal',
    label: 'Builder and bounded self-heal',
    state: 'implemented',
    authority: 'Isolated workers may repair to release_ready; humans retain merge and deploy authority',
    evidence: [
      'supabase/functions/_shared/builder-job-orchestrator.js',
      'builder-autopilot.js',
      'apps/web/src/pages/BuilderControlRoomPage.tsx',
    ],
    tests: [
      'test/builder-agentic-engineer.test.js',
      'test/builder-autopilot.test.js',
      'test/bob-builder-runtime-coordinator.test.js',
    ],
  },
  {
    id: 'experience',
    label: 'Operations, Studio and Builder UX',
    state: 'partial',
    authority: 'One Bob identity; capabilities vary by server-owned caller rank and governed lane',
    evidence: [
      'apps/web/src/components/BobPanel.tsx',
      'apps/web/src/components/BobStudio.tsx',
      'apps/web/src/pages/BuilderControlRoomPage.tsx',
    ],
    tests: ['apps/web/src/components/BobPanel.test.tsx'],
    gap: 'Who-is-flying, takeback and consistent result-in-habitat receipts are not complete across every module.',
  },
  {
    id: 'exercise_calibration',
    label: 'Invocation evidence and model calibration',
    state: 'gap',
    authority: 'Exercise and calibration must come from invocation receipts, not wiring claims',
    evidence: [
      'supabase/migrations/20261010224625_shared_perception_evidence_envelope.sql',
      'scripts/atlas-refresh.js',
    ],
    tests: ['test/perception-evidence-envelope.test.js', 'test/atlas-calibration.test.js'],
    gap: 'Atlas exercised remains unpopulated and there is no cross-domain accuracy/overturn dashboard.',
  },
]);

function fileExists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function verifyPlateRegression() {
  const variants = [
    'Current details query results\nShow the results for plate/VIN\n11739\nPlate: 11739\nPlate type: Standard',
    'Current details query results\nShow the results for plate/VIN\nJJJ739\nPlate: JJJ739\nPlate type: Standard',
  ];
  const result = resolveNztaPlateFromOcr(variants);
  const structuredFiles = [{
    structured_extraction: {
      document_kind: 'nzta_mvr_record',
      identifier_verification: { plate_number: result },
    },
  }];
  const guardedText = guardPlateLines('Plate: 11739', structuredFiles);
  const guardedEntity = guardProposedEntities({ vehicle: { plate_number: '11739' } }, structuredFiles);
  const invalidCandidate = result.candidates.find((candidate) => candidate.value === '11739');
  const passed = result.status === 'verified_candidate'
    && result.value === 'JJJ739'
    && invalidCandidate?.valid_shape === false
    && guardedText === 'Plate: JJJ739'
    && guardedEntity?.vehicle?.plate_number === 'JJJ739';
  return {
    passed,
    expected: 'JJJ739',
    resolved: result.value,
    rejected_candidate: invalidCandidate?.value ?? null,
    rejected_valid_shape: invalidCandidate?.valid_shape ?? null,
    guarded_text: guardedText,
    guarded_entity: guardedEntity?.vehicle?.plate_number ?? null,
  };
}

function inspectReadiness() {
  const domains = enterpriseDomains.map((domain) => {
    const missingEvidence = domain.evidence.filter((file) => !fileExists(file));
    const missingTests = domain.tests.filter((file) => !fileExists(file));
    return { ...domain, missingEvidence, missingTests };
  });
  const plateRegression = verifyPlateRegression();
  const missingFiles = domains.flatMap((domain) => [
    ...domain.missingEvidence.map((file) => `${domain.id}:evidence:${file}`),
    ...domain.missingTests.map((file) => `${domain.id}:test:${file}`),
  ]);
  return {
    generated_at: new Date().toISOString(),
    plate_regression: plateRegression,
    summary: {
      implemented: domains.filter((domain) => domain.state === 'implemented').length,
      partial: domains.filter((domain) => domain.state === 'partial').length,
      gap: domains.filter((domain) => domain.state === 'gap').length,
      missing_files: missingFiles.length,
    },
    domains,
    missing_files: missingFiles,
  };
}

function printHuman(report) {
  console.log('Bob enterprise acceptance');
  console.log(`Plate regression: ${report.plate_regression.passed ? 'PASS' : 'FAIL'} (expected JJJ739, resolved ${report.plate_regression.resolved ?? 'none'}, rejected 11739)`);
  for (const domain of report.domains) {
    const suffix = domain.gap ? ` — ${domain.gap}` : '';
    console.log(`[${domain.state.toUpperCase()}] ${domain.label}${suffix}`);
  }
  console.log(`Summary: ${report.summary.implemented} implemented, ${report.summary.partial} partial, ${report.summary.gap} gaps, ${report.summary.missing_files} missing evidence files`);
}

const args = new Set(process.argv.slice(2));
const report = inspectReadiness();
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else printHuman(report);

if (!report.plate_regression.passed || report.missing_files.length) process.exit(2);
const strictFailure = args.has('--strict') && report.domains.some((domain) => domain.state !== 'implemented');

if (args.has('--run-tests')) {
  const testFiles = [...new Set([
    'test/bob-enterprise-acceptance.test.js',
    ...report.domains.flatMap((domain) => domain.tests),
  ])]
    .filter((file) => file.startsWith('test/'));
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`Could not run Bob enterprise tests: ${result.error.message}`);
    process.exit(4);
  }
  if (result.status !== 0) process.exit(result.status ?? 4);
}

if (strictFailure) process.exit(3);

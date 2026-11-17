const crypto = require('node:crypto');
const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata
} = require('./builder-model-adapter');
const { downloadVerifiedArtifact } = require('../../../builder-frontend-handoff');
const { isAllowedBackendPath } = require('./builder-backend-engineer');
const { isDependencyPath } = require('../../../builder-path-policy');

const RELEASE_ENGINEER_PROMPT_VERSION = 'release-engineer-v2';

function deriveReleaseImpact(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) throw new Error('changed files are required');
  for (const file of changedFiles) {
    if (typeof file !== 'string' || (!file.startsWith('apps/web/') && !isAllowedBackendPath(file))) {
      throw new Error(`release file is outside approved implementation scope: ${file}`);
    }
  }
  const schema = changedFiles.some(file => file.startsWith('supabase/migrations/'));
  return {
    schema,
    authentication: changedFiles.some(file => file.includes('/context/AuthContext.') || file.includes('/lib/supabase.') || /(?:auth|identity)/i.test(file)),
    authorization: changedFiles.some(file => file.includes('/routing/') || file.includes('/components/access/') || file.endsWith('/SafetyGate.tsx') || /(?:policy|rls|permission|role)/i.test(file)),
    dependencies: changedFiles.some(isDependencyPath),
    environment: changedFiles.some(file => /(?:^|\/)\.env(?:\.|$)/.test(file)),
    infrastructure: false
  };
}

function parseReleasePackage(content, evidence) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('release package is empty');
  let release;
  try {
    release = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new Error('release package must be valid JSON');
  }
  if (release.summary && typeof release.summary === 'object' && !Array.isArray(release.summary)) {
    // Models sometimes return the summary as a structured object (job 42b542a5); keep the facts as prose.
    release.summary = Object.entries(release.summary).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('; ');
  }
  if (typeof release.summary !== 'string' || !release.summary.trim()) throw new Error('release summary is required');
  for (const key of ['changed_files', 'deployment_checklist', 'rollback_steps', 'release_notes', 'known_risks', 'unresolved_questions']) {
    if (!Array.isArray(release[key])) throw new Error(`${key} must be an array`);
  }
  if (release.deployment_checklist.length === 0 || release.rollback_steps.length === 0 || release.release_notes.length === 0) {
    throw new Error('release checklist, rollback steps, and notes must not be empty');
  }
  const actualFiles = [...new Set(evidence.changedFiles)].sort();
  if (JSON.stringify([...new Set(release.changed_files)].sort()) !== JSON.stringify(actualFiles)) {
    throw new Error('release changed files do not match verified manifest');
  }
  if (JSON.stringify(release.impact) !== JSON.stringify(evidence.impact)) {
    throw new Error('release impact does not match derived evidence');
  }
  return { ...release, changed_files: actualFiles };
}

function artifactList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function mergeImplementationEvidence(manifests, verifications) {
  if (manifests.length === 0 || manifests.length !== verifications.length) {
    throw new Error('implementation evidence sets are incomplete');
  }
  const changedFiles = manifests.flatMap(manifest => manifest.map(item => item?.path).filter(Boolean));
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new Error('implementation evidence changes the same file more than once');
  }
  if (verifications.some(verification => verification?.succeeded !== true)) {
    throw new Error('implementation verification evidence did not pass');
  }
  return { changedFiles: [...changedFiles].sort(), verification: verifications.length === 1 ? verifications[0] : verifications };
}

async function loadReleaseEvidence({ supabase, job, artifacts }) {
  const patchArtifacts = artifactList(artifacts.patch);
  const manifestArtifacts = artifactList(artifacts.manifest);
  const buildLogArtifacts = artifactList(artifacts.buildLogs);
  if (patchArtifacts.length === 0 || patchArtifacts.length > 2
      || patchArtifacts.length !== manifestArtifacts.length || patchArtifacts.length !== buildLogArtifacts.length) {
    throw new Error('one or two complete implementation artifact sets are required');
  }
  const [patches, manifests, buildLogs, securityReview, codeReview] = await Promise.all([
    Promise.all(patchArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'code_implementation'))),
    Promise.all(manifestArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'changed_file_manifest'))),
    Promise.all(buildLogArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'build_logs'))),
    downloadVerifiedArtifact(supabase, artifacts.securityReview.id, job.id, 'security_review'),
    artifacts.codeReview
      ? downloadVerifiedArtifact(supabase, artifacts.codeReview.id, job.id, 'code_review')
      : Promise.resolve(null)
  ]);
  let changedManifests;
  let verifications;
  let security;
  let independentReview = null;
  try {
    changedManifests = manifests.map(manifest => JSON.parse(manifest.bytes.toString('utf8')));
    verifications = buildLogs.map(log => JSON.parse(log.bytes.toString('utf8')));
    security = JSON.parse(securityReview.bytes.toString('utf8'));
    independentReview = codeReview ? JSON.parse(codeReview.bytes.toString('utf8')) : null;
  } catch {
    throw new Error('release evidence contains malformed JSON');
  }
  const implementation = mergeImplementationEvidence(changedManifests, verifications);
  if (!security.passed || security.counts?.critical !== 0 || security.counts?.high !== 0) {
    throw new Error('clean security review evidence is required');
  }
  if (job.code_review_mode === 'independent_ai'
      && (!independentReview || independentReview.verdict !== 'passed')) {
    throw new Error('passed independent code review evidence is required');
  }
  if (Array.isArray(security.reviewed_files)
      && JSON.stringify([...security.reviewed_files].sort()) !== JSON.stringify(implementation.changedFiles)) {
    throw new Error('security review files do not match implementation evidence');
  }
  return {
    patches,
    codeReview: independentReview,
    changedFiles: implementation.changedFiles,
    verification: implementation.verification,
    security,
    impact: deriveReleaseImpact(implementation.changedFiles)
  };
}

async function startReleasePreparation(supabase, jobId, stepId, securityWorkerRunId) {
  const { data, error } = await supabase.rpc('builder_start_release_preparation', {
    _job_id: jobId,
    _step_id: stepId,
    _security_worker_run_id: securityWorkerRunId
  });
  if (error) return { success: false, error: 'release preparation could not be started' };
  return { success: true, step: data };
}

async function registerReleaseArtifact(supabase, job, step, artifactType, content) {
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  const metadata = contentMetadata(serialized);
  const objectPath = `${job.organization_id}/${job.id}/release/${artifactType}-${metadata.checksum.slice(0, 16)}-${crypto.randomUUID()}.json`;
  const bucket = supabase.storage.from('builder-artifacts');
  const { error: uploadError } = await bucket.upload(objectPath, metadata.bytes, { contentType: 'application/json', upsert: false });
  if (uploadError) throw new Error(`${artifactType} upload failed`);
  try {
    const { data: stored, error: downloadError } = await bucket.download(objectPath);
    if (downloadError || !stored) throw new Error(`${artifactType} verification failed`);
    const storedContent = Buffer.from(await stored.arrayBuffer()).toString('utf8');
    if (contentMetadata(storedContent).checksum !== metadata.checksum) throw new Error(`${artifactType} integrity check failed`);
    const { data, error } = await supabase.rpc('builder_register_release_artifact', {
      _job_id: job.id,
      _step_id: step.id,
      _artifact_type: artifactType,
      _object_path: objectPath,
      _sha256: metadata.checksum,
      _size_bytes: metadata.bytes.length
    });
    if (error || !data?.id) throw new Error(`${artifactType} registration failed`);
    return data;
  } catch (error) {
    await bucket.remove([objectPath]);
    throw error;
  }
}

async function persistReleasePackage(supabase, job, step, release, releaseNotesArtifact) {
  const [rollbackPlan, deploymentManifest] = await Promise.all([
    registerReleaseArtifact(supabase, job, step, 'rollback_plan', {
      target_sha: job.target_sha,
      rollback_steps: release.rollback_steps,
      verification_required: true
    }),
    registerReleaseArtifact(supabase, job, step, 'deployment_manifest', {
      target_sha: job.target_sha,
      deployment_enabled: false,
      impact: release.impact,
      checklist: release.deployment_checklist,
      known_risks: release.known_risks,
      unresolved_questions: release.unresolved_questions
    })
  ]);
  return { success: true, artifacts: { releaseNotes: releaseNotesArtifact, rollbackPlan, deploymentManifest } };
}

async function completeReleasePreparation(supabase, input) {
  const { data, error } = await supabase.rpc('builder_complete_release_preparation', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _release_notes_id: input.releaseNotesId,
    _rollback_plan_id: input.rollbackPlanId,
    _deployment_manifest_id: input.deploymentManifestId,
    _reviewed_artifact_ids: input.reviewedArtifactIds,
    _requested_from_users: input.requestedFromUsers
  });
  if (error) return { success: false, error: 'release preparation could not be completed' };
  return { success: true, approval: data };
}

async function abortReleasePreparation(supabase, jobId, stepId, reason) {
  const { error } = await supabase.rpc('builder_abort_release_preparation', {
    _job_id: jobId,
    _step_id: stepId,
    _reason: reason
  });
  if (error) return { success: false };
  return { success: true };
}

async function runReleaseEngineer({
  supabase,
  gateway,
  job,
  step,
  artifacts,
  securityWorkerRunId,
  requestedFromUsers = [],
  loadEvidence = loadReleaseEvidence,
  startRelease = startReleasePreparation,
  executeModelRun = executeBuilderModelRun,
  persistPackage = persistReleasePackage,
  completeRelease = completeReleasePreparation,
  abortRelease = abortReleasePreparation
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.step_id !== 'release_prep' || step.builder_mode !== 'release_engineer') throw new Error('Release Engineer step is required');
  const evidence = await loadEvidence({ supabase, job, artifacts });
  const started = await startRelease(supabase, job.id, step.id, securityWorkerRunId);
  if (!started.success) return { ok: false, status: 409, error: started.error };
  const artifactIds = [
    ...artifactList(artifacts.patch).map(artifact => artifact.id),
    ...artifactList(artifacts.manifest).map(artifact => artifact.id),
    ...artifactList(artifacts.buildLogs).map(artifact => artifact.id),
    artifacts.securityReview.id,
    ...(artifacts.codeReview ? [artifacts.codeReview.id] : [])
  ];
  const systemPrompt = [
    'You are the Release Engineer for Field Compliance Manager.',
    'Prepare release evidence only; production deployment is disabled.',
    'Use the supplied verified files, build result, security result, and derived impact without changing those facts.',
    'Return exactly this JSON object and nothing else: {"summary": string (prose, one paragraph), "changed_files": [string] (exactly the supplied changed_files), "impact": (the supplied impact object, unchanged), "deployment_checklist": [string] (non-empty), "rollback_steps": [string] (non-empty), "release_notes": [string] (non-empty), "known_risks": [string], "unresolved_questions": [string]}.'
  ].join(' ');
  const userPrompt = JSON.stringify({
    target_sha: job.target_sha,
    changed_files: evidence.changedFiles,
    impact: evidence.impact,
    verification: evidence.verification,
    security: evidence.security,
    code_review: evidence.codeReview
  });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'release_engineer',
    workloadKind: 'release_preparation',
    promptVersion: RELEASE_ENGINEER_PROMPT_VERSION,
    systemPrompt,
    userPrompt,
    inputArtifactIds: artifactIds,
    outputSchema: { type: 'object' }
  });
  let result = await executeModelRun({
    supabase,
    gateway,
    modelRequest,
    validateOutput: content => parseReleasePackage(content, evidence)
  });
  if (!result.ok && result.status === 422) {
    // One repair turn with the validator's reason; an output-shape slip must not fail a fully verified job.
    result = await executeModelRun({
      supabase,
      gateway,
      modelRequest: {
        ...modelRequest,
        idempotency_key: `${modelRequest.idempotency_key}::repair`,
        request: { ...modelRequest.request, system_prompt: `${systemPrompt} Your previous reply was rejected: ${String(result.error || 'invalid output').slice(0, 300)}. Reply again with the exact JSON shape.` }
      },
      validateOutput: content => parseReleasePackage(content, evidence)
    });
  }
  if (!result.ok) {
    await abortRelease(supabase, job.id, step.id, result.error || 'Release model failed');
    return { ...result, release_package: null };
  }
  try {
    const persisted = await persistPackage(supabase, job, step, result.validated_output, result.artifact);
    const completion = await completeRelease(supabase, {
      jobId: job.id,
      stepId: step.id,
      releaseNotesId: persisted.artifacts.releaseNotes.id,
      rollbackPlanId: persisted.artifacts.rollbackPlan.id,
      deploymentManifestId: persisted.artifacts.deploymentManifest.id,
      reviewedArtifactIds: artifactIds,
      requestedFromUsers
    });
    if (!completion.success) {
      await abortRelease(supabase, job.id, step.id, completion.error);
      return { ...result, ok: false, status: 503, error: completion.error };
    }
    return { ...result, release_package: result.validated_output, release_artifacts: persisted.artifacts, approval: completion.approval };
  } catch (error) {
    await abortRelease(supabase, job.id, step.id, 'Release artifact persistence failed');
    throw error;
  }
}

module.exports = {
  RELEASE_ENGINEER_PROMPT_VERSION,
  deriveReleaseImpact,
  parseReleasePackage,
  artifactList,
  mergeImplementationEvidence,
  loadReleaseEvidence,
  startReleasePreparation,
  registerReleaseArtifact,
  persistReleasePackage,
  completeReleasePreparation,
  abortReleasePreparation,
  runReleaseEngineer
};
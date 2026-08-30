const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validatePatchText } = require('../../../frontend-worker');
const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata
} = require('./builder-model-adapter');

const FRONTEND_ENGINEER_PROMPT_VERSION = 'frontend-engineer-v1';
const MAX_SOURCE_FILES = 30;
const MAX_SOURCE_FILE_BYTES = 50000;
const MAX_SOURCE_TOTAL_BYTES = 300000;

function collectFrontendSourceContext({ sourceDir, targetSha, requestedFiles }) {
  if (!sourceDir || !targetSha) throw new Error('sourceDir and targetSha are required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  if (head !== targetSha) throw new Error('repository HEAD does not match target SHA');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: sourceDir,
    encoding: 'utf8'
  }).trim();
  if (status) throw new Error('Frontend Engineer requires a clean checkout');
  if (!Array.isArray(requestedFiles) || requestedFiles.length === 0) {
    throw new Error('at least one source file is required');
  }
  if (requestedFiles.length > MAX_SOURCE_FILES) throw new Error('too many source files requested');

  let totalBytes = 0;
  const files = [...new Set(requestedFiles)].sort().map(relativePath => {
    const normalized = path.posix.normalize(relativePath);
    if (normalized !== relativePath || !relativePath.startsWith('apps/web/src/')) {
      throw new Error(`source file is outside apps/web/src: ${relativePath}`);
    }
    const absolutePath = path.resolve(sourceDir, relativePath);
    const expectedRoot = `${path.resolve(sourceDir, 'apps/web/src')}${path.sep}`;
    if (!absolutePath.startsWith(expectedRoot)) throw new Error(`unsafe source path: ${relativePath}`);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`source path must be a regular file: ${relativePath}`);
    if (stat.size > MAX_SOURCE_FILE_BYTES) throw new Error(`source file exceeds size limit: ${relativePath}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error('source context exceeds total size limit');
    const content = fs.readFileSync(absolutePath, 'utf8');
    return {
      path: relativePath,
      sha256: crypto.createHash('sha256').update(Buffer.from(content)).digest('hex'),
      content
    };
  });
  return { target_sha: targetSha, files };
}

async function loadVerifiedUxPlan(supabase, artifactId, jobId) {
  const { data: artifact, error } = await supabase
    .from('builder_artifacts')
    .select('id, job_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId)
    .eq('job_id', jobId)
    .single();
  if (error || !artifact || artifact.artifact_type !== 'ui_design_plan' || artifact.status !== 'final') {
    throw new Error('final UX design artifact is unavailable');
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error('UX design artifact provenance is invalid');
  }
  const { data: object, error: downloadError } = await supabase.storage
    .from('builder-artifacts')
    .download(artifact.storage_location.slice(prefix.length));
  if (downloadError || !object) throw new Error('UX design artifact could not be read');
  const content = Buffer.from(await object.arrayBuffer()).toString('utf8');
  if (contentMetadata(content).checksum !== artifact.checksum) throw new Error('UX design artifact integrity check failed');
  try {
    return { artifact, designPlan: JSON.parse(content) };
  } catch {
    throw new Error('UX design artifact is not valid JSON');
  }
}

function buildFrontendEngineerPrompt({ designPlan, sourceContext }) {
  const systemPrompt = [
    'You are the Frontend Engineer for Field Compliance Manager.',
    'Implement only the approved UX plan using only the supplied commit-pinned source files.',
    'Return one JSON object containing summary, patch, changed_files, and tests.',
    'The patch must be a standard unified git diff limited to apps/web and must apply to the supplied files.',
    'Do not change dependencies, environment files, authentication, routing, access control, or safety gates.',
    'Do not invent APIs, schema, permissions, or behavior absent from the approved artifacts.',
    'Do not use markdown fences.'
  ].join(' ');
  return {
    systemPrompt,
    userPrompt: JSON.stringify({
      approved_ux_plan: designPlan,
      target_sha: sourceContext.target_sha,
      source_files: sourceContext.files,
      required_output: {
        summary: 'string',
        patch: 'unified git diff string',
        changed_files: ['apps/web/src/path.tsx'],
        tests: ['fixed validation command or test description']
      }
    })
  };
}

function parseFrontendProposal(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('frontend proposal is empty');
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let proposal;
  try {
    proposal = JSON.parse(normalized);
  } catch {
    throw new Error('frontend proposal must be valid JSON');
  }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) throw new Error('frontend proposal summary is required');
  if (!Array.isArray(proposal.changed_files) || !Array.isArray(proposal.tests)) throw new Error('changed_files and tests must be arrays');
  const actualFiles = validatePatchText(proposal.patch);
  const declaredFiles = [...new Set(proposal.changed_files)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) throw new Error('changed_files do not match patch');
  return { ...proposal, changed_files: declaredFiles };
}

async function runFrontendEngineer({
  supabase,
  gateway,
  job,
  step,
  uxArtifact,
  sourceDir,
  requestedFiles,
  loadUxPlan = loadVerifiedUxPlan,
  executeModelRun = executeBuilderModelRun
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.builder_mode !== 'frontend_engineer') throw new Error('Frontend Engineer step is required');
  if (!uxArtifact?.id || uxArtifact.artifact_type !== 'ui_design_plan' || uxArtifact.status !== 'final') {
    throw new Error('a final UX design artifact is required');
  }
  const [ux, sourceContext] = await Promise.all([
    loadUxPlan(supabase, uxArtifact.id, job.id),
    Promise.resolve(collectFrontendSourceContext({ sourceDir, targetSha: job.target_sha, requestedFiles }))
  ]);
  const prompt = buildFrontendEngineerPrompt({ designPlan: ux.designPlan, sourceContext });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'frontend_engineer',
    workloadKind: 'frontend_implementation',
    promptVersion: FRONTEND_ENGINEER_PROMPT_VERSION,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    inputArtifactIds: [uxArtifact.id],
    outputSchema: { type: 'object', required: ['summary', 'patch', 'changed_files', 'tests'] }
  });
  const result = await executeModelRun({ supabase, gateway, modelRequest, validateOutput: parseFrontendProposal });
  return {
    ...result,
    proposal: result.validated_output || null,
    patch_artifact: result.artifact || null,
    routing: {
      provider: modelRequest.provider,
      reason: modelRequest.routing_reason,
      prompt_version: FRONTEND_ENGINEER_PROMPT_VERSION
    }
  };
}

module.exports = {
  FRONTEND_ENGINEER_PROMPT_VERSION,
  collectFrontendSourceContext,
  loadVerifiedUxPlan,
  buildFrontendEngineerPrompt,
  parseFrontendProposal,
  runFrontendEngineer
};
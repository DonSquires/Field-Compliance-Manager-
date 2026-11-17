const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata,
  parseArtifactJson
} = require('./builder-model-adapter');
const { collectRepositoryContext } = require('./builder-repository-context');
const { laneAllows } = require('../../../builder-path-policy');
const { loadCodeReviewSeed } = require('../../../builder-artifact-read');

const BACKEND_ENGINEER_PROMPT_VERSION = 'backend-engineer-v4';
const MAX_SOURCE_FILES = 40;
const MAX_SOURCE_FILE_BYTES = 100000;
const MAX_SOURCE_TOTAL_BYTES = 500000;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

// Legacy narrow patterns kept for reference; the lane now follows builder-path-policy
// (everything outside apps/web that is not a protected path).
const BACKEND_SOURCE_PATTERNS = [
  /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/,
  /^supabase\/functions\/(?:_shared|[a-z0-9-]+)\/[A-Za-z0-9_.-]+\.(?:js|ts)$/,
  /^test\/[A-Za-z0-9_.-]+\.test\.js$/,
  /^src\/types\/database\.ts$/
];

const DESTRUCTIVE_SQL = /(?:\bdrop\s+(?:table|schema|database|type|column)\b|\btruncate\s+table\b|\balter\s+table[\s\S]{0,120}\bdrop\b|\bdelete\s+from\s+\S+\s*;)/i;

function isAllowedBackendPath(relativePath) {
  return laneAllows('backend', relativePath, { allowAgenticDependencies: true });
}

function collectBackendSourceContext({ sourceDir, targetSha, requestedFiles }) {
  if (!sourceDir || !targetSha) throw new Error('sourceDir and targetSha are required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim();
  if (head !== targetSha) throw new Error('repository HEAD does not match target SHA');
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: sourceDir,
    encoding: 'utf8'
  }).trim();
  if (status) throw new Error('Backend Engineer requires a clean checkout');
  if (!Array.isArray(requestedFiles) || requestedFiles.length === 0) {
    throw new Error('at least one backend source file is required');
  }
  if (requestedFiles.length > MAX_SOURCE_FILES) throw new Error('too many source files requested');

  let totalBytes = 0;
  const files = [...new Set(requestedFiles)].sort().map(relativePath => {
    const normalized = path.posix.normalize(relativePath);
    if (normalized !== relativePath || !isAllowedBackendPath(relativePath)) {
      throw new Error(`source file is outside approved backend paths: ${relativePath}`);
    }
    const absolutePath = path.resolve(sourceDir, relativePath);
    if (!absolutePath.startsWith(`${path.resolve(sourceDir)}${path.sep}`)) {
      throw new Error(`unsafe source path: ${relativePath}`);
    }
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
  return {
    target_sha: targetSha,
    repository_context: collectRepositoryContext({ sourceDir, targetSha }),
    files
  };
}

async function loadVerifiedProductSpecification(supabase, artifactId, jobId) {
  const { data: artifact, error } = await supabase
    .from('builder_artifacts')
    .select('id, job_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId)
    .eq('job_id', jobId)
    .single();
  if (error || !artifact || artifact.artifact_type !== 'product_specification' || artifact.status !== 'final') {
    throw new Error('final product specification artifact is unavailable');
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error('product specification artifact provenance is invalid');
  }
  const { data: object, error: downloadError } = await supabase.storage
    .from('builder-artifacts')
    .download(artifact.storage_location.slice(prefix.length));
  if (downloadError || !object) throw new Error('product specification artifact could not be read');
  const content = Buffer.from(await object.arrayBuffer()).toString('utf8');
  if (contentMetadata(content).checksum !== artifact.checksum) {
    throw new Error('product specification artifact integrity check failed');
  }
  try {
    return { artifact, specification: parseArtifactJson(content) };
  } catch {
    throw new Error('product specification artifact is not valid JSON');
  }
}

function changedFilesFromPatch(patchText) {
  if (typeof patchText !== 'string' || !patchText.trim()) throw new Error('backend patch is empty');
  if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) throw new Error('backend patch exceeds size limit');
  if (/GIT binary patch|Binary files .* differ/m.test(patchText)) throw new Error('binary patches are not allowed');
  if (/^(?:new|old) mode (?:120000|160000)$/m.test(patchText)) throw new Error('symlink and submodule patches are not allowed');
  const files = [...patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(match => match[2].trim());
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length === 0) throw new Error('backend patch has no changed files');
  for (const file of uniqueFiles) {
    if (path.posix.normalize(file) !== file || file.startsWith('/') || file.includes('\0') || !isAllowedBackendPath(file)) {
      throw new Error(`backend patch cannot modify ${file}`);
    }
  }
  return uniqueFiles;
}

function addedPatchText(patchText) {
  return patchText.split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
}

function requireAdditiveMigrations(patchText, migrationFiles) {
  for (const file of migrationFiles) {
    const header = `diff --git a/${file} b/${file}\n`;
    const start = patchText.indexOf(header);
    const next = start < 0 ? -1 : patchText.indexOf('\ndiff --git ', start + header.length);
    const section = start < 0 ? '' : patchText.slice(start + header.length, next < 0 ? undefined : next);
    if (!/^new file mode 100644$/m.test(section) || !/^--- \/dev\/null$/m.test(section)) {
      throw new Error(`database migration must be a new additive file: ${file}`);
    }
  }
}

function classifyBackendChangeRisk(patchText, changedFiles) {
  const additions = addedPatchText(patchText);
  if (DESTRUCTIVE_SQL.test(additions)) throw new Error('destructive SQL is not allowed in an autonomous backend proposal');
  const schemaChange = changedFiles.some(file => file.startsWith('supabase/migrations/'));
  const authorizationChange = /\b(?:create|alter|drop)\s+policy\b|\b(?:grant|revoke)\b|auth\.(?:users|admin)|service_role/i.test(additions);
  const storageChange = /storage\.(?:buckets|objects)|\.storage\b/i.test(additions);
  const integrationChange = /\bfetch\s*\(|https?:\/\//i.test(additions);
  const reasons = [];
  if (schemaChange) reasons.push('schema_change');
  if (authorizationChange) reasons.push('authorization_change');
  if (storageChange) reasons.push('storage_change');
  if (integrationChange) reasons.push('external_integration_change');
  return {
    schema_change: schemaChange,
    authorization_change: authorizationChange,
    storage_change: storageChange,
    integration_change: integrationChange,
    requires_human_approval: reasons.length > 0,
    approval_reasons: reasons
  };
}

function parseBackendProposal(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('backend proposal is empty');
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let proposal;
  try {
    proposal = JSON.parse(normalized);
  } catch {
    throw new Error('backend proposal must be valid JSON');
  }
  if (typeof proposal.summary !== 'string' || !proposal.summary.trim()) throw new Error('backend proposal summary is required');
  for (const key of ['changed_files', 'database_migrations', 'edge_functions', 'tests', 'rollback_notes']) {
    if (!Array.isArray(proposal[key])) throw new Error(`${key} must be an array`);
  }
  if (proposal.rollback_notes.length === 0) throw new Error('rollback_notes must not be empty');
  const actualFiles = changedFilesFromPatch(proposal.patch);
  const declaredFiles = [...new Set(proposal.changed_files)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) throw new Error('changed_files do not match patch');
  const actualMigrations = actualFiles.filter(file => file.startsWith('supabase/migrations/'));
  requireAdditiveMigrations(proposal.patch, actualMigrations);
  const declaredMigrations = [...new Set(proposal.database_migrations)].sort();
  if (JSON.stringify(actualMigrations) !== JSON.stringify(declaredMigrations)) {
    throw new Error('database_migrations do not match patch');
  }
  const actualFunctions = actualFiles
    .filter(file => /^supabase\/functions\/(?!_shared\/)[^/]+\//.test(file))
    .map(file => file.split('/')[2]);
  const declaredFunctions = [...new Set(proposal.edge_functions)].sort();
  if (JSON.stringify([...new Set(actualFunctions)].sort()) !== JSON.stringify(declaredFunctions)) {
    throw new Error('edge_functions do not match patch');
  }
  return {
    ...proposal,
    changed_files: declaredFiles,
    database_migrations: declaredMigrations,
    edge_functions: declaredFunctions,
    risk: classifyBackendChangeRisk(proposal.patch, actualFiles)
  };
}

function buildBackendEngineerPrompt({ specification, sourceContext, liveContext = null, codeReviewRevision = null, previousImplementation = null }) {
  return {
    systemPrompt: [
      'You are the Backend Engineer for Field Compliance Manager.',
      'Understand the supplied commit-pinned whole-build map before making a module-local change.',
      'Implement only the approved product specification using the supplied commit-pinned backend sources.',
      'Return one JSON object containing summary, patch, changed_files, database_migrations, edge_functions, tests, acceptance_evidence, and rollback_notes.',
      'Supply acceptance_evidence entries {requirement_id,status:"completed",evidence} for actual approved outcomes, naming full changed source and regression-test paths. Whole-job acceptance checks every mandatory delivery requirement after independent verification, even if another lane was skipped. Do not invent IDs, silently waive outcomes, or claim test execution before workers run.',
      'Use additive schema changes, preserve tenant isolation and provenance, and keep secrets server-side.',
      'Install or update dependencies only when required by the approved specification. Include manifest and lockfile changes in the patch, explain the need, and verify the installed tool in the isolated workspace. Do not include destructive SQL, environment files, deployment commands, or production credentials.',
      'Do not claim execution, migration application, approval, or deployment.',
      'When confirmed code review corrections are supplied, inspect the previous implementation and address the reported findings within the approved scope. Preserve unrelated correct behavior and tests. Return a COMPLETE replacement patch against the pinned source, not an incremental diff. Reported feedback is not independently verified evidence.',
      'Do not invent schema or behavior absent from the supplied evidence, and do not use markdown fences.'
    ].join(' '),
    userPrompt: JSON.stringify({
      approved_product_specification: specification,
      confirmed_code_review_corrections: codeReviewRevision,
      previous_implementation: previousImplementation,
      target_sha: sourceContext.target_sha,
      repository_context: sourceContext.repository_context,
      live_context: liveContext,
      source_files: sourceContext.files,
      required_output: {
        summary: 'string',
        patch: 'unified git diff string',
        changed_files: ['approved backend path'],
        database_migrations: ['supabase/migrations/<timestamp>_<name>.sql'],
        edge_functions: ['function-name'],
        tests: ['fixed validation command or test description'],
        acceptance_evidence: [{ requirement_id: 'approved delivery requirement ID', status: 'completed', evidence: 'Full changed source and regression-test paths; observable proof of the whole outcome' }],
        rollback_notes: ['non-destructive rollback or forward-fix step']
      }
    })
  };
}

async function runBackendEngineer({
  supabase,
  gateway,
  job,
  step,
  productArtifact,
  sourceDir,
  requestedFiles,
  liveContext = null,
  loadProductSpecification = loadVerifiedProductSpecification,
  executeModelRun = executeBuilderModelRun
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha) throw new Error('commit-pinned job identity is required');
  if (!step?.id || step.builder_mode !== 'backend_engineer') throw new Error('Backend Engineer step is required');
  if (!productArtifact?.id || productArtifact.artifact_type !== 'product_specification' || productArtifact.status !== 'final') {
    throw new Error('a final product specification artifact is required');
  }
  const [product, sourceContext] = await Promise.all([
    loadProductSpecification(supabase, productArtifact.id, job.id),
    Promise.resolve(collectBackendSourceContext({ sourceDir, targetSha: job.target_sha, requestedFiles }))
  ]);
  const previousImplementation = await loadCodeReviewSeed(supabase, job, step);
  const prompt = buildBackendEngineerPrompt({ specification: product.specification, sourceContext, liveContext,
    codeReviewRevision: job.code_review_revision, previousImplementation: previousImplementation?.text });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'backend_engineer',
    workloadKind: 'backend_implementation',
    promptVersion: BACKEND_ENGINEER_PROMPT_VERSION,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    inputArtifactIds: [productArtifact.id],
    outputSchema: {
      type: 'object',
      required: ['summary', 'patch', 'changed_files', 'database_migrations', 'edge_functions', 'tests', 'acceptance_evidence', 'rollback_notes']
    }
  });
  const result = await executeModelRun({ supabase, gateway, modelRequest, validateOutput: parseBackendProposal });
  return {
    ...result,
    proposal: result.validated_output || null,
    patch_artifact: result.artifact || null,
    routing: {
      provider: modelRequest.provider,
      reason: modelRequest.routing_reason,
      prompt_version: BACKEND_ENGINEER_PROMPT_VERSION
    }
  };
}

module.exports = {
  BACKEND_ENGINEER_PROMPT_VERSION,
  BACKEND_SOURCE_PATTERNS,
  isAllowedBackendPath,
  collectBackendSourceContext,
  collectRepositoryContext,
  loadVerifiedProductSpecification,
  changedFilesFromPatch,
  requireAdditiveMigrations,
  classifyBackendChangeRisk,
  parseBackendProposal,
  buildBackendEngineerPrompt,
  runBackendEngineer
};
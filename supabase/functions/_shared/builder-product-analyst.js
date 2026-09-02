const {
  buildModelRunRequest,
  executeBuilderModelRun
} = require('./builder-model-adapter');

const PRODUCT_ANALYST_PROMPT_VERSION = 'product-analyst-v2';

const PRODUCT_SPEC_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'product_brief',
    'user_roles',
    'user_journeys',
    'functional_requirements',
    'non_functional_requirements',
    'data_model_proposal',
    'acceptance_criteria',
    'unresolved_questions',
    'assumptions'
  ]
});

function boundedString(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function normalizeRepositoryContext(context = {}) {
  const buildMap = context.build_map && typeof context.build_map === 'object' ? context.build_map : {};
  const liveContext = context.live_context && typeof context.live_context === 'object' ? context.live_context : null;
  return {
    repository: boundedString(context.repository, 300),
    ref: boundedString(context.ref, 200),
    commit_sha: boundedString(context.commit_sha, 64),
    architecture_summary: boundedString(context.architecture_summary, 12000),
    relevant_files: Array.isArray(context.relevant_files)
      ? context.relevant_files.filter(value => typeof value === 'string').slice(0, 200)
      : [],
    known_capabilities: Array.isArray(context.known_capabilities)
      ? context.known_capabilities.filter(value => typeof value === 'string').slice(0, 200)
      : [],
    build_map: {
      target_sha: boundedString(buildMap.target_sha, 64),
      file_count: Number.isInteger(buildMap.file_count) ? buildMap.file_count : 0,
      tracked_files: Array.isArray(buildMap.tracked_files) ? buildMap.tracked_files.filter(value => typeof value === 'string').slice(0, 2000) : [],
      packages: Array.isArray(buildMap.packages) ? buildMap.packages.slice(0, 20) : [],
      compose: Array.isArray(buildMap.compose) ? buildMap.compose.slice(0, 20) : [],
      supabase_edge_functions: Array.isArray(buildMap.supabase_edge_functions) ? buildMap.supabase_edge_functions.filter(value => typeof value === 'string').slice(0, 500) : [],
      schema: {
        available: buildMap.schema?.available === true,
        tables: Array.isArray(buildMap.schema?.tables) ? buildMap.schema.tables.filter(value => typeof value === 'string').slice(0, 1000) : [],
        views: Array.isArray(buildMap.schema?.views) ? buildMap.schema.views.filter(value => typeof value === 'string').slice(0, 1000) : [],
        functions: Array.isArray(buildMap.schema?.functions) ? buildMap.schema.functions.filter(value => typeof value === 'string').slice(0, 1000) : []
      },
      recent_commits: Array.isArray(buildMap.recent_commits) ? buildMap.recent_commits.filter(value => typeof value === 'string').slice(0, 20) : [],
      secret_files_excluded: buildMap.secret_files_excluded === true
    },
    live_context: liveContext
  };
}

function buildProductAnalystPrompt({ taskDescription, repositoryContext, constraints = [] }) {
  const task = boundedString(taskDescription, 12000);
  if (!task) throw new Error('taskDescription is required');
  const context = normalizeRepositoryContext(repositoryContext);
  const safeConstraints = Array.isArray(constraints)
    ? constraints.filter(value => typeof value === 'string').slice(0, 100)
    : [];

  const systemPrompt = [
    'You are the Product Analyst for Field Compliance Manager.',
    'Produce a grounded implementation specification, not code.',
    'Use only the supplied task and repository context.',
    'Never invent schema, users, integrations, policies, or completed behavior.',
    'Put every unknown that affects implementation in unresolved_questions.',
    'Return one JSON object matching the supplied schema, with no markdown fence.'
  ].join(' ');
  const userPrompt = JSON.stringify({
    task,
    repository_context: context,
    constraints: safeConstraints,
    required_output: {
      product_brief: { problem: 'string', outcome: 'string', scope: ['string'] },
      user_roles: [{ role: 'string', needs: ['string'] }],
      user_journeys: [{ actor: 'string', goal: 'string', steps: ['string'] }],
      functional_requirements: [{ id: 'FR-1', requirement: 'string', priority: 'must|should|could' }],
      non_functional_requirements: [{ id: 'NFR-1', requirement: 'string' }],
      data_model_proposal: [{ entity: 'string', purpose: 'string', relationships: ['string'] }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'string' }],
      unresolved_questions: ['string'],
      assumptions: ['string']
    }
  });
  return { systemPrompt, userPrompt, context };
}

function requireArray(specification, key) {
  if (!Array.isArray(specification[key])) throw new Error(`${key} must be an array`);
}

function parseProductSpecification(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('product specification is empty');
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let specification;
  try {
    specification = JSON.parse(normalized);
  } catch {
    throw new Error('product specification must be valid JSON');
  }
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
    throw new Error('product specification must be an object');
  }
  if (!specification.product_brief || typeof specification.product_brief !== 'object') {
    throw new Error('product_brief is required');
  }
  for (const key of PRODUCT_SPEC_SCHEMA.required.filter(key => key !== 'product_brief')) {
    requireArray(specification, key);
  }
  if (specification.acceptance_criteria.length === 0) {
    throw new Error('acceptance_criteria must not be empty');
  }
  return specification;
}

async function startProductAnalysis(supabase, jobId, stepId) {
  const { data, error } = await supabase.rpc('builder_start_product_analysis', {
    _job_id: jobId,
    _step_id: stepId
  });
  if (error) return { success: false, error: 'product analysis could not be started' };
  return { success: true, step: data };
}

async function completeProductAnalysis(supabase, {
  jobId,
  stepId,
  artifactId,
  resultSummary,
  requestedFromUsers = []
}) {
  const { data, error } = await supabase.rpc('builder_complete_product_analysis', {
    _job_id: jobId,
    _step_id: stepId,
    _artifact_id: artifactId,
    _result_summary: resultSummary,
    _requested_from_users: requestedFromUsers
  });
  if (error) return { success: false, error: 'product analysis could not be completed' };
  return { success: true, approval: data };
}

async function runProductAnalyst({
  supabase,
  gateway,
  job,
  step,
  repositoryContext,
  constraints = [],
  requestedFromUsers = [],
  executeModelRun = executeBuilderModelRun,
  startAnalysis = startProductAnalysis,
  completeAnalysis = completeProductAnalysis
}) {
  if (!job?.id || !job?.organization_id) throw new Error('job identity is required');
  if (!step?.id || step.builder_mode !== 'product_analyst') throw new Error('product analyst step is required');
  const started = await startAnalysis(supabase, job.id, step.id);
  if (!started.success) return { ok: false, status: 409, error: started.error };
  const prompts = buildProductAnalystPrompt({
    taskDescription: job.task_description,
    repositoryContext,
    constraints
  });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'product_analyst',
    workloadKind: 'product_analysis',
    promptVersion: PRODUCT_ANALYST_PROMPT_VERSION,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    inputArtifactIds: [],
    outputSchema: PRODUCT_SPEC_SCHEMA
  });

  const result = await executeModelRun({
    supabase,
    gateway,
    modelRequest,
    validateOutput: parseProductSpecification
  });
  if (!result.ok) {
    return {
      ...result,
      specification: null,
      routing: {
        provider: modelRequest.provider,
        reason: modelRequest.routing_reason,
        prompt_version: PRODUCT_ANALYST_PROMPT_VERSION
      }
    };
  }

  const completion = await completeAnalysis(supabase, {
    jobId: job.id,
    stepId: step.id,
    artifactId: result.artifact?.id,
    resultSummary: result.validated_output?.product_brief?.outcome || 'Product specification prepared',
    requestedFromUsers
  });
  if (!completion.success) {
    return { ...result, ok: false, status: 503, error: completion.error, specification: result.validated_output };
  }
  return {
    ...result,
    specification: result.validated_output || null,
    approval: completion.approval,
    routing: {
      provider: modelRequest.provider,
      reason: modelRequest.routing_reason,
      prompt_version: PRODUCT_ANALYST_PROMPT_VERSION
    }
  };
}

module.exports = {
  PRODUCT_ANALYST_PROMPT_VERSION,
  PRODUCT_SPEC_SCHEMA,
  normalizeRepositoryContext,
  buildProductAnalystPrompt,
  parseProductSpecification,
  startProductAnalysis,
  completeProductAnalysis,
  runProductAnalyst
};
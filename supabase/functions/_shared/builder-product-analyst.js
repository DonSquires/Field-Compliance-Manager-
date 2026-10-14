const {
  buildModelRunRequest,
  executeBuilderModelRun
} = require('./builder-model-adapter');
const { fitRepositoryContext } = require('./builder-repository-context');

const PRODUCT_ANALYST_PROMPT_VERSION = 'product-analyst-v6';

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
    'workflow_verification',
    'terrain_verification',
    'human_acceptance',
    'research_evidence',
    'unresolved_questions',
    'assumptions'
  ]
});

function boundedString(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedDirectoryCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => typeof key === 'string' && Number.isInteger(count) && count >= 0)
    .slice(0, 50)
    .map(([key, count]) => [key.slice(0, 120), count]));
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
      tracked_files_truncated: buildMap.tracked_files_truncated === true,
      directory_counts: boundedDirectoryCounts(buildMap.directory_counts),
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

function researchEvidenceRequired(taskDescription) {
  return /\b(?:web research|internet|online research|public sources?|inspiration from|inspired by|current (?:standards?|patterns?|guidance))\b/i.test(String(taskDescription || ''));
}

function suppliedResearchUrls(taskDescription) {
  return [...new Set(String(taskDescription || '').match(/https:\/\/[^\s<>()\]\["']+/g) || [])]
    .map((url) => url.replace(/[.,;:!?]+$/, ''))
    .slice(0, 10);
}

function specificationStrings(value, path = [], output = []) {
  if (typeof value === 'string') {
    output.push({ path: path.join('.'), value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => specificationStrings(item, [...path, String(index)], output));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => specificationStrings(item, [...path, key], output));
  }
  return output;
}

function validateRepositoryGrounding(specification, { repositoryContext = {}, taskDescription = '' } = {}) {
  const context = repositoryContext && typeof repositoryContext === 'object' ? repositoryContext : {};
  const buildMap = context.build_map && typeof context.build_map === 'object' ? context.build_map : {};
  const schema = buildMap.schema && typeof buildMap.schema === 'object' ? buildMap.schema : {};
  const schemaEntities = new Set([
    ...(Array.isArray(schema.tables) ? schema.tables : []),
    ...(Array.isArray(schema.views) ? schema.views : []),
    ...(Array.isArray(schema.functions) ? schema.functions : [])
  ].filter(value => typeof value === 'string').map(value => value.toLowerCase()));
  const knownCapabilities = new Set((Array.isArray(context.known_capabilities) ? context.known_capabilities : [])
    .filter(value => typeof value === 'string')
    .map(value => value.toLowerCase()));
  const task = String(taskDescription || '');
  const taskLower = task.toLowerCase();
  const forbidsNewBackend = /\bfrontend-only\b|\bdo not invent (?:schema|apis?)\b|\bwithout (?:new|inventing) (?:routes?|apis?|schema)\b/i.test(task);
  const neutralEntities = new Set(['none', 'no new entity', 'no new entities', 'existing frontend state', 'existing ui state']);

  if (forbidsNewBackend) {
    for (const proposal of specification.data_model_proposal || []) {
      const entity = boundedString(proposal?.entity, 300).toLowerCase();
      if (entity && !neutralEntities.has(entity) && !schemaEntities.has(entity)) {
        throw new Error(`data_model_proposal contains an entity not supplied by repository schema: ${entity}`);
      }
      const relationships = Array.isArray(proposal?.relationships) ? proposal.relationships : [];
      for (const relationship of relationships) {
        const invented = String(relationship).match(/\b(?:fk|rpc|table|column|function)_[a-z0-9_]+\b/gi) || [];
        const unknown = invented.find(identifier => !schemaEntities.has(identifier.toLowerCase()) && !taskLower.includes(identifier.toLowerCase()));
        if (unknown) throw new Error(`data_model_proposal contains a relationship identifier not supplied by repository evidence: ${unknown}`);
      }
    }
  }

  for (const check of specification.terrain_verification?.atlas_capability_checks || []) {
    const identifiers = String(check).match(/\b(?:bob|builder)[_-][a-z0-9_-]+\b/gi) || [];
    const unknown = identifiers.find(identifier => !knownCapabilities.has(identifier.toLowerCase()) && !taskLower.includes(identifier.toLowerCase()));
    if (unknown) throw new Error(`terrain_verification names an Atlas capability not supplied by repository evidence: ${unknown}`);
  }

  const inspirationOnly = /\b(?:patterns? only|bounded inspiration|for inspiration)\b/i.test(task)
    || /\brather than copying\b/i.test(task);
  if (inspirationOnly) {
    for (const item of specificationStrings(specification)) {
      if (item.path.startsWith('research_evidence.')) continue;
      const claimsIntegration = /\b(?:integrat(?:e|ion)|embed|connect)\b/i.test(item.value);
      const namesExternalProduct = /\b(?:github copilot|codespaces|visual studio code|vs code|v0|vercel)\b/i.test(item.value);
      if (claimsIntegration && namesExternalProduct) {
        throw new Error('product specification turns an inspiration source into an unrequested product integration');
      }
    }
  }
}

function buildProductAnalystPrompt({ taskDescription, repositoryContext, constraints = [] }) {
  const task = boundedString(taskDescription, 12000);
  if (!task) throw new Error('taskDescription is required');
  const context = fitRepositoryContext(normalizeRepositoryContext(repositoryContext), task);
  const researchRequired = researchEvidenceRequired(task);
  const researchUrls = researchRequired ? suppliedResearchUrls(task) : [];
  const safeConstraints = Array.isArray(constraints)
    ? constraints.filter(value => typeof value === 'string').slice(0, 100)
    : [];

  const systemPrompt = [
    'You are the Product Analyst for Field Compliance Manager.',
    'Produce a grounded implementation specification, not code.',
    'Use only the supplied task and repository context.',
    'Never invent schema, users, integrations, policies, or completed behavior.',
    'Describe expected versus present behavior before, during, and after the workflow.',
    'Require schema and Atlas checks, keeping proven flow reach separate from structural FK reach and treating references-only edges as weak evidence.',
    'Define a responsive, accessible human-glass acceptance route for the affected role, including loading, empty, error, permission, success, and safe-next-action states that apply.',
    'Put every unknown that affects implementation in unresolved_questions.',
    'When research is required, cite only URLs supplied in the task; record the exact observed pattern and how it applies, never invent a source or claim browsing.',
    'Research products are design evidence only unless the task explicitly requests an integration; never turn inspiration into a dependency, API, or product integration.',
    'Every proposed data entity, relationship identifier, named Atlas capability, route, API, and integration must exist in the supplied repository evidence or be quoted explicitly by the task.',
    'For frontend-only work that forbids new schema or APIs, use an existing schema entity or state clearly that no new data entity is proposed.',
    'When supplied_research_urls is non-empty, copy at least the first four exact URLs into research_evidence and provide every required field for each.',
    'Return one JSON object matching the supplied schema, with no markdown fence.'
  ].join(' ');
  const userPrompt = JSON.stringify({
    task,
    repository_context: context,
    constraints: safeConstraints,
    research_requirements: {
      required: researchRequired,
      minimum_sources: researchRequired ? 4 : 0,
      supplied_research_urls: researchUrls
    },
    required_output: {
      product_brief: { problem: 'string', outcome: 'string', scope: ['string'] },
      user_roles: [{ role: 'string', needs: ['string'] }],
      user_journeys: [{ actor: 'string', goal: 'string', steps: ['string'] }],
      functional_requirements: [{ id: 'FR-1', requirement: 'string', priority: 'must|should|could' }],
      non_functional_requirements: [{ id: 'NFR-1', requirement: 'string' }],
      data_model_proposal: [{ entity: 'string', purpose: 'string', relationships: ['string'] }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'string' }],
      workflow_verification: {
        before: ['precondition, permission, source record, configuration, route, or initial data check'],
        during: ['visible control, request/RPC, policy, write, audit, loading, error, or transition check'],
        after: ['persisted record, receipt, derived state, notification, downstream screen, report, or next-actor check']
      },
      terrain_verification: {
        schema_checks: ['table, column, function, trigger, policy, or real writer to verify'],
        atlas_capability_checks: ['present/wired capability to verify without claiming exercised'],
        flow_reach_checks: ['reads/writes/calls/invokes path to verify'],
        fk_reach_checks: ['structural FK adjacency to keep separate from proven flow'],
        weak_reference_checks: ['references-only claim that needs stronger source evidence']
      },
      human_acceptance: {
        role: 'string',
        route: 'string',
        job_to_be_done: 'string',
        steps: ['string'],
        expected_visible_result: 'string',
        required_states: ['loading|empty|error|permission|success|safe_next_action']
      },
      research_evidence: [{ url: 'supplied https URL', publisher: 'string', observed_pattern: 'exact sourced observation', applicability: 'bounded design implication' }],
      unresolved_questions: ['string'],
      assumptions: ['string']
    }
  });
  return { systemPrompt, userPrompt, context };
}

function requireArray(specification, key) {
  if (!Array.isArray(specification[key])) throw new Error(`${key} must be an array`);
}

function parseProductSpecification(content, {
  requiredResearchUrls = [],
  researchRequired = false,
  repositoryContext = null,
  taskDescription = ''
} = {}) {
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
  for (const key of PRODUCT_SPEC_SCHEMA.required.filter(key => !['product_brief', 'workflow_verification', 'terrain_verification', 'human_acceptance'].includes(key))) {
    requireArray(specification, key);
  }
  if (specification.acceptance_criteria.length === 0) {
    throw new Error('acceptance_criteria must not be empty');
  }
  for (const phase of ['before', 'during', 'after']) {
    if (!Array.isArray(specification.workflow_verification?.[phase]) || specification.workflow_verification[phase].length === 0) {
      throw new Error(`workflow_verification.${phase} must be a non-empty array`);
    }
  }
  for (const key of ['schema_checks', 'atlas_capability_checks', 'flow_reach_checks', 'fk_reach_checks', 'weak_reference_checks']) {
    if (!Array.isArray(specification.terrain_verification?.[key])) {
      throw new Error(`terrain_verification.${key} must be an array`);
    }
  }
  if (specification.terrain_verification.schema_checks.length === 0
      || specification.terrain_verification.atlas_capability_checks.length === 0
      || specification.terrain_verification.flow_reach_checks.length === 0) {
    throw new Error('terrain verification must include schema, Atlas capability, and proven flow checks');
  }
  const allowedResearchUrls = new Set(requiredResearchUrls);
  if (researchRequired) {
    if (allowedResearchUrls.size < 4) throw new Error('research-required task must supply at least four source URLs');
    if (specification.research_evidence.length < 4) throw new Error('research_evidence must cite at least four supplied sources');
    for (const evidence of specification.research_evidence) {
      const url = boundedString(evidence?.url, 2000).replace(/[.,;:!?]+$/, '');
      if (!url || !allowedResearchUrls.has(url)) throw new Error('research_evidence contains a URL that was not supplied in the task');
      if (!boundedString(evidence?.publisher, 300) || !boundedString(evidence?.observed_pattern, 2000) || !boundedString(evidence?.applicability, 2000)) {
        throw new Error('research_evidence must include publisher, observed_pattern, and applicability');
      }
    }
  }
  const acceptance = specification.human_acceptance;
  if (!acceptance || typeof acceptance !== 'object'
      || !boundedString(acceptance.role, 200)
      || !boundedString(acceptance.route, 500)
      || !boundedString(acceptance.job_to_be_done, 1000)
      || !boundedString(acceptance.expected_visible_result, 2000)
      || !Array.isArray(acceptance.steps) || acceptance.steps.length === 0
      || !Array.isArray(acceptance.required_states) || acceptance.required_states.length === 0) {
    throw new Error('human_acceptance must define role, route, job, steps, visible result, and required states');
  }
  if (repositoryContext) validateRepositoryGrounding(specification, { repositoryContext, taskDescription });
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
  completeAnalysis = completeProductAnalysis,
  abortStep = null
}) {
  if (!job?.id || !job?.organization_id) throw new Error('job identity is required');
  if (!step?.id || step.builder_mode !== 'product_analyst') throw new Error('product analyst step is required');
  const abort = abortStep || require('./builder-ux-designer').abortModelStep;
  const started = await startAnalysis(supabase, job.id, step.id);
  if (!started.success) return { ok: false, status: 409, error: started.error };
  const researchRequired = researchEvidenceRequired(job.task_description);
  const requiredResearchUrls = researchRequired ? suppliedResearchUrls(job.task_description) : [];
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
    validateOutput: (content) => parseProductSpecification(content, {
      requiredResearchUrls,
      researchRequired,
      repositoryContext: prompts.context,
      taskDescription: job.task_description
    })
  });
  if (!result.ok) {
    await abort(supabase, { jobId: job.id, stepId: step.id, reason: `product analysis: ${result.error || 'model run failed'}` });
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
  researchEvidenceRequired,
  suppliedResearchUrls,
  validateRepositoryGrounding,
  buildProductAnalystPrompt,
  parseProductSpecification,
  startProductAnalysis,
  completeProductAnalysis,
  runProductAnalyst
};
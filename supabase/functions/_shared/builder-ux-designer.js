const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata
} = require('./builder-model-adapter');

const UX_DESIGNER_PROMPT_VERSION = 'ux-designer-v2';

const UX_DESIGN_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'information_architecture',
    'route_map',
    'component_inventory',
    'responsive_behavior',
    'accessibility_requirements',
    'interface_states',
    'design_tokens',
    'unresolved_questions',
    'assumptions'
  ]
});

function normalizeDesignContext(context = {}) {
  const buildMap = context.build_map && typeof context.build_map === 'object' ? context.build_map : {};
  const liveContext = context.live_context && typeof context.live_context === 'object' ? context.live_context : null;
  return {
    existing_design_system: typeof context.existing_design_system === 'string'
      ? context.existing_design_system.trim().slice(0, 12000)
      : '',
    relevant_components: Array.isArray(context.relevant_components)
      ? context.relevant_components.filter(value => typeof value === 'string').slice(0, 200)
      : [],
    existing_routes: Array.isArray(context.existing_routes)
      ? context.existing_routes.filter(value => typeof value === 'string').slice(0, 200)
      : [],
    viewport_requirements: Array.isArray(context.viewport_requirements)
      ? context.viewport_requirements.filter(value => typeof value === 'string').slice(0, 20)
      : [],
    build_map: {
      target_sha: typeof buildMap.target_sha === 'string' ? buildMap.target_sha.slice(0, 64) : '',
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

function buildUxDesignerPrompt({ specification, repositoryContext }) {
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
    throw new Error('approved specification is required');
  }
  const context = normalizeDesignContext(repositoryContext);
  const systemPrompt = [
    'You are the UX/UI Designer for Field Compliance Manager.',
    'Design from the approved product specification and supplied repository context.',
    'Do not invent product behavior, routes, schema, permissions, or capabilities.',
    'Reuse the existing design system and components where they satisfy the approved requirements.',
    'Cover desktop and mobile behavior, accessibility, and loading, empty, error, and success states.',
    'Return one JSON object matching the supplied schema, with no markdown fence.'
  ].join(' ');
  return {
    systemPrompt,
    userPrompt: JSON.stringify({
      approved_specification: specification,
      repository_context: context,
      required_output: {
        information_architecture: [{ area: 'string', purpose: 'string' }],
        route_map: [{ route: 'string', purpose: 'string', access: ['string'] }],
        component_inventory: [{ component: 'string', responsibility: 'string' }],
        responsive_behavior: [{ surface: 'string', behavior: 'string' }],
        accessibility_requirements: ['string'],
        interface_states: { loading: 'string', empty: 'string', error: 'string', success: 'string' },
        design_tokens: { color: ['string'], spacing: ['string'] },
        unresolved_questions: ['string'],
        assumptions: ['string']
      }
    })
  };
}

function parseUxDesignPlan(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('UX design plan is empty');
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let plan;
  try {
    plan = JSON.parse(normalized);
  } catch {
    throw new Error('UX design plan must be valid JSON');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('UX design plan must be an object');
  }
  const arrayKeys = UX_DESIGN_SCHEMA.required.filter(key => !['interface_states', 'design_tokens'].includes(key));
  for (const key of arrayKeys) {
    if (!Array.isArray(plan[key])) throw new Error(`${key} must be an array`);
  }
  for (const key of ['information_architecture', 'route_map', 'component_inventory', 'responsive_behavior', 'accessibility_requirements']) {
    if (plan[key].length === 0) throw new Error(`${key} must not be empty`);
  }
  if (!plan.interface_states || typeof plan.interface_states !== 'object') {
    throw new Error('interface_states is required');
  }
  for (const state of ['loading', 'empty', 'error', 'success']) {
    if (typeof plan.interface_states[state] !== 'string' || !plan.interface_states[state].trim()) {
      throw new Error(`interface_states.${state} is required`);
    }
  }
  if (!plan.design_tokens || typeof plan.design_tokens !== 'object') throw new Error('design_tokens is required');
  return plan;
}

async function loadApprovedSpecification(supabase, artifactId, jobId) {
  const { data: artifact, error } = await supabase
    .from('builder_artifacts')
    .select('id, job_id, artifact_type, status, storage_location, checksum')
    .eq('id', artifactId)
    .eq('job_id', jobId)
    .single();
  if (error || !artifact
      || artifact.artifact_type !== 'product_specification'
      || artifact.status !== 'final') {
    throw new Error('approved product specification artifact is unavailable');
  }
  const prefix = 'supabase_storage://builder-artifacts/';
  if (!artifact.storage_location?.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(artifact.checksum || '')) {
    throw new Error('product specification artifact provenance is invalid');
  }
  const objectPath = artifact.storage_location.slice(prefix.length);
  const { data: storedObject, error: downloadError } = await supabase.storage
    .from('builder-artifacts')
    .download(objectPath);
  if (downloadError || !storedObject) throw new Error('product specification artifact could not be read');
  const content = Buffer.from(await storedObject.arrayBuffer()).toString('utf8');
  if (contentMetadata(content).checksum !== artifact.checksum) {
    throw new Error('product specification artifact integrity check failed');
  }
  try {
    return { artifact, specification: JSON.parse(content) };
  } catch {
    throw new Error('product specification artifact is not valid JSON');
  }
}

async function startUxDesign(supabase, jobId, stepId, specificationArtifactId) {
  const { data, error } = await supabase.rpc('builder_start_ux_design', {
    _job_id: jobId,
    _step_id: stepId,
    _specification_artifact_id: specificationArtifactId
  });
  if (error) return { success: false, error: 'UX design could not be started' };
  return { success: true, step: data };
}

async function completeUxDesign(supabase, { jobId, stepId, artifactId, resultSummary }) {
  const { data, error } = await supabase.rpc('builder_complete_ux_design', {
    _job_id: jobId,
    _step_id: stepId,
    _artifact_id: artifactId,
    _result_summary: resultSummary
  });
  if (error) return { success: false, error: 'UX design could not be completed' };
  return { success: true, job: data };
}

async function runUxDesigner({
  supabase,
  gateway,
  job,
  step,
  specificationArtifact,
  repositoryContext,
  executeModelRun = executeBuilderModelRun,
  startDesign = startUxDesign,
  completeDesign = completeUxDesign,
  loadSpecification = loadApprovedSpecification
}) {
  if (!job?.id || !job?.organization_id) throw new Error('job identity is required');
  if (!step?.id || step.builder_mode !== 'ux_designer') throw new Error('UX Designer step is required');
  if (!specificationArtifact?.id
      || specificationArtifact.artifact_type !== 'product_specification'
      || specificationArtifact.status !== 'final') {
    throw new Error('a final product specification artifact is required');
  }
  const loaded = await loadSpecification(supabase, specificationArtifact.id, job.id);
  const prompt = buildUxDesignerPrompt({ specification: loaded.specification, repositoryContext });
  const started = await startDesign(supabase, job.id, step.id, specificationArtifact.id);
  if (!started.success) return { ok: false, status: 409, error: started.error };
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'ux_designer',
    workloadKind: 'ux_design',
    promptVersion: UX_DESIGNER_PROMPT_VERSION,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    inputArtifactIds: [specificationArtifact.id],
    outputSchema: UX_DESIGN_SCHEMA
  });
  const result = await executeModelRun({
    supabase,
    gateway,
    modelRequest,
    validateOutput: parseUxDesignPlan
  });
  if (!result.ok) return { ...result, design_plan: null };

  const completion = await completeDesign(supabase, {
    jobId: job.id,
    stepId: step.id,
    artifactId: result.artifact?.id,
    resultSummary: `${result.validated_output.component_inventory.length} components across ${result.validated_output.route_map.length} routes`
  });
  if (!completion.success) {
    return { ...result, ok: false, status: 503, error: completion.error, design_plan: result.validated_output };
  }
  return {
    ...result,
    design_plan: result.validated_output,
    job: completion.job,
    routing: {
      provider: modelRequest.provider,
      reason: modelRequest.routing_reason,
      prompt_version: UX_DESIGNER_PROMPT_VERSION
    }
  };
}

module.exports = {
  UX_DESIGNER_PROMPT_VERSION,
  UX_DESIGN_SCHEMA,
  normalizeDesignContext,
  buildUxDesignerPrompt,
  parseUxDesignPlan,
  loadApprovedSpecification,
  startUxDesign,
  completeUxDesign,
  runUxDesigner
};
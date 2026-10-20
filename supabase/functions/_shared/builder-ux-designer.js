const {
  buildModelRunRequest,
  executeBuilderModelRun,
  contentMetadata
} = require('./builder-model-adapter');
const { fitRepositoryContext } = require('./builder-repository-context');

const UX_DESIGNER_PROMPT_VERSION = 'ux-designer-v9';

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

function designOutputSchema(context) {
  const strings = { type: 'array', items: { type: 'string' } };
  const choices = values => values.length
    ? { type: 'array', items: { type: 'string', enum: values } }
    : { type: 'array', items: { type: 'string' }, maxItems: 0 };
  const records = fields => ({
    type: 'array', minItems: 1,
    items: { type: 'object', required: fields, properties: Object.fromEntries(fields.map(key => [key, { type: 'string' }])) }
  });
  return {
    ...UX_DESIGN_SCHEMA,
    properties: {
      information_architecture: records(['area', 'purpose']),
      route_map: context.existing_routes.length ? {
        type: 'array', minItems: 1,
        items: {
          type: 'object', required: ['route', 'purpose', 'access'],
          properties: {
            route: { type: 'string', enum: context.existing_routes },
            purpose: { type: 'string' },
            access: choices(context.existing_access_boundaries)
          }
        }
      } : { type: 'array', maxItems: 0, items: { type: 'object' } },
      component_inventory: records(['component', 'responsibility']),
      responsive_behavior: records(['surface', 'behavior']),
      accessibility_requirements: { ...strings, minItems: 1 },
      interface_states: {
        type: 'object', required: ['loading', 'empty', 'error', 'success'],
        properties: Object.fromEntries(['loading', 'empty', 'error', 'success'].map(key => [key, { type: 'string', minLength: 1 }]))
      },
      design_tokens: {
        type: 'object', required: ['color', 'spacing'],
        properties: { color: choices(context.design_tokens), spacing: choices(context.design_tokens) }
      },
      unresolved_questions: strings,
      assumptions: strings
    }
  };
}

function boundedDirectoryCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => typeof key === 'string' && Number.isInteger(count) && count >= 0)
    .slice(0, 50)
    .map(([key, count]) => [key.slice(0, 120), count]));
}

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
    existing_access_boundaries: Array.isArray(context.existing_access_boundaries)
      ? context.existing_access_boundaries.filter(value => typeof value === 'string').slice(0, 50)
      : [],
    design_tokens: Array.isArray(context.design_tokens)
      ? context.design_tokens.filter(value => typeof value === 'string' && /^--[a-z0-9-]+$/i.test(value)).slice(0, 200)
      : [],
    viewport_requirements: Array.isArray(context.viewport_requirements)
      ? context.viewport_requirements.filter(value => typeof value === 'string').slice(0, 20)
      : [],
    build_map: {
      target_sha: typeof buildMap.target_sha === 'string' ? buildMap.target_sha.slice(0, 64) : '',
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

function buildUxDesignerPrompt({ specification, repositoryContext, constraints = [] }) {
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) {
    throw new Error('approved specification is required');
  }
  const context = fitRepositoryContext(normalizeDesignContext(repositoryContext), JSON.stringify(specification));
  const allowedSpacingTokens = context.design_tokens.filter((token) => /(?:space|gap|padding|margin|radius)/i.test(token));
  const systemPrompt = [
    'You are the UX/UI Designer for Field Compliance Manager.',
    'Design from the approved product specification and supplied repository context.',
    'Do not invent product behavior, routes, schema, permissions, or capabilities.',
    'Reuse only design tokens supplied in repository_context.design_tokens; never translate them into Tailwind-style or invented names.',
    'In design_tokens, copy bare token names exactly as supplied (for example --color-bg-base), without var(...), labels, values, or explanatory prose.',
    'The design_tokens.spacing array may be empty when token_constraints.allowed_spacing_tokens is empty; never invent a spacing scale to fill it.',
    'Resolve ownership, navigation, access, and design-system questions from supplied repository evidence rather than repeating them as unresolved.',
    'component_inventory must include at least one exact owner name from repository_context.relevant_components when that list is non-empty; proposed subcomponents may be added after that grounded owner.',
    'Cover desktop and mobile behavior, accessibility, and loading, empty, error, and success states.',
    'route_map lists only exact identifiers supplied in repository_context.existing_routes; for a component-only change with no supplied route it is an empty array — never invent a route to fill it.',
    'Copy every route_map.route and route_map.access value byte-for-byte from route_contract.allowed_routes and route_contract.allowed_access; do not shorten, paraphrase, or convert a page identifier into a URL.',
    'route_map access values use only repository_context.existing_access_boundaries.',
    'Treat correction_constraints as mandatory corrections from prior validation attempts; correct the output rather than weakening or discussing the constraint.',
    'Return one JSON object matching the supplied schema, with no markdown fence.'
  ].join(' ');
  return {
    systemPrompt,
    context,
    outputSchema: designOutputSchema(context),
    userPrompt: JSON.stringify({
      approved_specification: specification,
      repository_context: context,
      token_constraints: {
        allowed_tokens: context.design_tokens,
        allowed_spacing_tokens: allowedSpacingTokens
      },
      route_contract: {
        allowed_routes: context.existing_routes,
        allowed_access: context.existing_access_boundaries
      },
      correction_constraints: Array.isArray(constraints)
        ? constraints.filter(value => typeof value === 'string' && value.trim()).slice(0, 20)
        : [],
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

function parseUxDesignPlan(content, { repositoryContext = {}, enforceRepositoryEvidence = false } = {}) {
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
  // route_map may be empty: a component-only or native-mobile change has no web route (job 958829bd).
  for (const key of ['information_architecture', 'component_inventory', 'responsive_behavior', 'accessibility_requirements']) {
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
  const context = normalizeDesignContext(repositoryContext);
  const allowedRoutes = new Set(context.existing_routes);
  const allowedAccess = new Set(context.existing_access_boundaries);
  const allowedTokens = new Set(context.design_tokens);
  if (enforceRepositoryEvidence && allowedRoutes.size && plan.route_map.length === 0) {
    throw new Error('route_map must include the supplied route or page identifier for this routed surface');
  }
  const sample = (set) => [...set].slice(0, 12).map(value => JSON.stringify(value)).join(', ');
  if (enforceRepositoryEvidence) for (const entry of plan.route_map) {
    if (!entry || typeof entry.route !== 'string' || !allowedRoutes.has(entry.route)) {
      // Named so the fallback chain's correction feedback tells the next model exactly what to fix.
      throw new Error(`route_map contains a route or page identifier not supplied by repository evidence: ${JSON.stringify(String(entry?.route ?? '')).slice(0, 120)}; use one of: ${sample(allowedRoutes)}`);
    }
    const unknownAccess = Array.isArray(entry.access) ? entry.access.filter(value => !allowedAccess.has(value)) : null;
    if (!unknownAccess || unknownAccess.length) {
      throw new Error(`route_map contains an access boundary not supplied by repository evidence: ${unknownAccess ? unknownAccess.slice(0, 5).map(value => JSON.stringify(value)).join(', ') : 'access must be an array'}; use only: ${sample(allowedAccess)}`);
    }
  }
  const componentIdentity = (value) => String(value ?? '').trim().replace(/\\/g, '/').split('/').at(-1).replace(/\.(?:tsx?|jsx?|css)$/i, '').toLowerCase();
  const ownerComponents = new Set(context.relevant_components.flatMap(value => [String(value).trim().toLowerCase(), componentIdentity(value)]));
  if (enforceRepositoryEvidence && context.relevant_components.length
      && !plan.component_inventory.some(entry => entry && (
        ownerComponents.has(String(entry.component ?? '').trim().toLowerCase())
        || ownerComponents.has(componentIdentity(entry.component))
      ))) {
    throw new Error('component_inventory must include at least one owner component supplied by repository evidence');
  }
  for (const group of ['color', 'spacing']) {
    if (!Array.isArray(plan.design_tokens[group])) continue;
    plan.design_tokens[group] = [...new Set(plan.design_tokens[group].map((value) => {
      if (typeof value !== 'string') return value;
      const exact = value.trim();
      if (allowedTokens.has(exact)) return exact;
      const referenced = [...new Set(exact.match(/--[a-z0-9-]+/gi) || [])];
      return referenced.length === 1 && allowedTokens.has(referenced[0]) ? referenced[0] : exact;
    }))];
  }
  const usedTokens = [...(Array.isArray(plan.design_tokens.color) ? plan.design_tokens.color : []), ...(Array.isArray(plan.design_tokens.spacing) ? plan.design_tokens.spacing : [])];
  const invalidTokens = usedTokens.filter(value => !allowedTokens.has(value));
  if (allowedTokens.size && (usedTokens.length === 0 || invalidTokens.length > 0)) {
    const detail = invalidTokens.length ? `; invalid: ${invalidTokens.slice(0, 12).join(', ')}` : '';
    throw new Error(`design_tokens must use only exact canonical tokens supplied by repository evidence${detail}`);
  }
  if ((allowedRoutes.size || allowedTokens.size || context.relevant_components.length)
      && plan.unresolved_questions.some(value => /(?:route|page path|component.*owner|true owner|design system|theme token|token set|access gate|role.*gate)/i.test(String(value)))) {
    throw new Error('unresolved_questions repeats ownership, route, access, or token facts supplied by repository evidence');
  }
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

// A model run that fails after the step started must not leave the step 'running' (job 958829bd
// sat at design_pending with "the Builder is blocked" and no reason). Best-effort: never throws.
async function abortModelStep(supabase, { jobId, stepId, reason }) {
  try {
    const { error } = await supabase.rpc('builder_abort_model_step', { _job_id: jobId, _step_id: stepId, _reason: String(reason || 'model run failed').slice(0, 2000) });
    return !error;
  } catch {
    return false;
  }
}

async function runUxDesigner({
  supabase,
  gateway,
  job,
  step,
  specificationArtifact,
  repositoryContext,
  constraints = [],
  executeModelRun = executeBuilderModelRun,
  startDesign = startUxDesign,
  completeDesign = completeUxDesign,
  abortStep = abortModelStep,
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
  const prompt = buildUxDesignerPrompt({ specification: loaded.specification, repositoryContext, constraints });
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
    outputSchema: prompt.outputSchema
  });
  const result = await executeModelRun({
    supabase,
    gateway,
    modelRequest,
    validateOutput: (content) => parseUxDesignPlan(content, { repositoryContext: prompt.context, enforceRepositoryEvidence: true })
  });
  if (!result.ok) {
    await abortStep(supabase, { jobId: job.id, stepId: step.id, reason: `ux design: ${result.error || 'model run failed'}` });
    return { ...result, design_plan: null };
  }

  const completion = await completeDesign(supabase, {
    jobId: job.id,
    stepId: step.id,
    artifactId: result.artifact?.id,
    resultSummary: `${result.validated_output.component_inventory.length} components across ${result.validated_output.route_map.length} routes`
  });
  if (!completion.success) {
    await abortStep(supabase, { jobId: job.id, stepId: step.id, reason: `ux design: ${completion.error}` });
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
  abortModelStep,
  normalizeDesignContext,
  buildUxDesignerPrompt,
  parseUxDesignPlan,
  loadApprovedSpecification,
  startUxDesign,
  completeUxDesign,
  runUxDesigner
};
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  UX_DESIGNER_PROMPT_VERSION,
  buildUxDesignerPrompt,
  parseUxDesignPlan,
  loadApprovedSpecification,
  runUxDesigner
} = require('../supabase/functions/_shared/builder-ux-designer');

function validDesignPlan() {
  return {
    information_architecture: [{ area: 'Approvals', purpose: 'Review governed work' }],
    route_map: [{ route: '/admin/approvals', purpose: 'Approval queue', access: ['administrator'] }],
    component_inventory: [{ component: 'ApprovalList', responsibility: 'Display review items' }],
    responsive_behavior: [{ surface: 'ApprovalList', behavior: 'Single column on narrow screens' }],
    accessibility_requirements: ['Decision buttons have explicit accessible names'],
    interface_states: {
      loading: 'Stable loading state',
      empty: 'No pending approvals',
      error: 'Retryable error alert',
      success: 'Decision confirmation'
    },
    design_tokens: { color: ['existing semantic variables'], spacing: ['existing spacing scale'] },
    unresolved_questions: [],
    assumptions: []
  };
}

test('UX Designer prompt carries approved specification and forbids invented behavior', () => {
  const prompt = buildUxDesignerPrompt({
    specification: { product_brief: { outcome: 'Governed approvals' }, acceptance_criteria: [{ id: 'AC-1' }] },
    repositoryContext: { existing_design_system: 'PageStyles.css variables', relevant_components: ['ApprovalList'], build_map: { target_sha: 'a'.repeat(64), file_count: 2, tracked_files: ['apps/web/src/App.tsx'], secret_files_excluded: true }, live_context: { atlas: { capability_count: 2 }, live_data: { scope: 'aggregate row counts only' } } }
  });

  assert.match(prompt.systemPrompt, /approved product specification/);
  assert.match(prompt.systemPrompt, /Do not invent/);
  assert.match(prompt.systemPrompt, /exact identifiers supplied in repository_context\.existing_routes/);
  assert.match(prompt.systemPrompt, /only design tokens supplied in repository_context\.design_tokens/);
  assert.equal(JSON.parse(prompt.userPrompt).approved_specification.product_brief.outcome, 'Governed approvals');
  assert.equal(JSON.parse(prompt.userPrompt).repository_context.build_map.file_count, 2);
  assert.equal(JSON.parse(prompt.userPrompt).repository_context.live_context.atlas.capability_count, 2);
});

test('UX Designer parser enforces complete responsive and accessibility output', () => {
  const plan = validDesignPlan();
  assert.deepEqual(parseUxDesignPlan(JSON.stringify(plan)), plan);
  // A component-only or native-mobile change has no web route (job 958829bd failed validation here).
  assert.deepEqual(parseUxDesignPlan(JSON.stringify({ ...plan, route_map: [] })).route_map, []);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...plan, component_inventory: [] })), /component_inventory must not be empty/);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...plan, accessibility_requirements: 'none' })), /must be an array/);
});

test('UX Designer rejects invented routes, access boundaries, tokens, and already-resolved questions', () => {
  const context = {
    relevant_components: ['BuilderControlRoomPage'],
    existing_routes: ['AdminShell page id "builder" (renders BuilderControlRoomPage; no standalone URL is established)'],
    existing_access_boundaries: ['platform-only AdminShell page'],
    design_tokens: ['--color-bg-base', '--color-text-primary', '--touch-target-admin']
  };
  const grounded = {
    ...validDesignPlan(),
    route_map: [{ route: context.existing_routes[0], purpose: 'Builder workspace', access: [context.existing_access_boundaries[0]] }],
    component_inventory: [{ component: 'BuilderControlRoomPage', responsibility: 'Existing Builder owner surface' }],
    design_tokens: { color: ['--color-bg-base', '--color-text-primary'], spacing: ['--touch-target-admin'] }
  };
  assert.deepEqual(parseUxDesignPlan(JSON.stringify(grounded), { repositoryContext: context, enforceRepositoryEvidence: true }), grounded);
  assert.deepEqual(
    parseUxDesignPlan(JSON.stringify({
      ...grounded,
      design_tokens: {
        color: ['var(--color-bg-base)', '--color-text-primary — primary copy'],
        spacing: ['var(--touch-target-admin)']
      }
    }), { repositoryContext: context, enforceRepositoryEvidence: true }).design_tokens,
    grounded.design_tokens
  );
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...grounded, route_map: [] }), { repositoryContext: context, enforceRepositoryEvidence: true }), /must include the supplied route/);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...grounded, route_map: [{ route: '/builder/control-room', purpose: 'invented', access: ['AUTHORIZED_BUILDER_OPERATOR'] }] }), { repositoryContext: context, enforceRepositoryEvidence: true }), /route or page identifier/);
  assert.deepEqual(
    parseUxDesignPlan(JSON.stringify({
      ...grounded,
      component_inventory: [
        ...grounded.component_inventory,
        { component: 'EvidenceRail', responsibility: 'Proposed presentation subcomponent' }
      ]
    }), { repositoryContext: context, enforceRepositoryEvidence: true }).component_inventory.length,
    2
  );
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...grounded, component_inventory: [{ component: 'EvidenceRail', responsibility: 'Proposed presentation subcomponent' }] }), { repositoryContext: context, enforceRepositoryEvidence: true }), /must include at least one owner component/);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...grounded, design_tokens: { color: ['neutral-900'], spacing: ['spacing-1'] } }), { repositoryContext: context, enforceRepositoryEvidence: true }), /exact canonical tokens/);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...grounded, unresolved_questions: ['What is the exact route path?'] }), { repositoryContext: context, enforceRepositoryEvidence: true }), /repeats ownership/);
});

test('UX Designer uses approved specification artifact as model provenance', async () => {
  let captured;
  const route = 'AdminShell page id "builder"';
  const access = 'platform-only AdminShell page';
  const plan = {
    ...validDesignPlan(),
    route_map: [{ route, purpose: 'Builder workspace', access: [access] }],
    component_inventory: [{ component: 'BuilderControlRoomPage', responsibility: 'Existing Builder owner surface' }],
    design_tokens: { color: ['--color-bg-base', '--color-text-primary'], spacing: ['--touch-target-admin'] }
  };
  const result = await runUxDesigner({
    supabase: {},
    gateway: {},
    job: { id: 'job-1', organization_id: 'org-1' },
    step: { id: 'step-2', builder_mode: 'ux_designer' },
    specificationArtifact: { id: 'artifact-spec', artifact_type: 'product_specification', status: 'final' },
    repositoryContext: {
      relevant_components: ['BuilderControlRoomPage'],
      existing_routes: [route],
      existing_access_boundaries: [access],
      design_tokens: ['--color-bg-base', '--color-text-primary', '--touch-target-admin']
    },
    loadSpecification: async () => ({
      artifact: { id: 'artifact-spec' },
      specification: { product_brief: { outcome: 'Governed approvals' }, acceptance_criteria: [{ id: 'AC-1' }] }
    }),
    startDesign: async () => ({ success: true }),
    executeModelRun: async input => {
      captured = input;
      return { ok: true, validated_output: plan, artifact: { id: 'artifact-design' } };
    },
    completeDesign: async () => ({ success: true, job: { status: 'implementation_pending' } })
  });

  assert.deepEqual(captured.modelRequest.chain, ['openai', 'gpu_workstation']);
  assert.equal(captured.modelRequest.provider, 'openai');
  assert.equal(captured.modelRequest.prompt_version, UX_DESIGNER_PROMPT_VERSION);
  assert.deepEqual(captured.modelRequest.input_artifact_ids, ['artifact-spec']);
  assert.deepEqual(captured.validateOutput(JSON.stringify(plan)), plan);
  assert.equal(result.job.status, 'implementation_pending');
  assert.deepEqual(result.design_plan, plan);
});

test('UX Designer verifies approved specification bytes against stored checksum', async () => {
  const content = JSON.stringify({ product_brief: { outcome: 'Grounded design' } });
  const crypto = require('node:crypto');
  const checksum = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');
  const query = {
    select() { return this; },
    eq() { return this; },
    single: async () => ({
      data: {
        id: 'artifact-spec',
        job_id: 'job-1',
        artifact_type: 'product_specification',
        status: 'final',
        storage_location: 'supabase_storage://builder-artifacts/org/job/spec.json',
        checksum
      },
      error: null
    })
  };
  const supabase = {
    from: () => query,
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => Buffer.from(content) }, error: null })
      })
    }
  };

  const loaded = await loadApprovedSpecification(supabase, 'artifact-spec', 'job-1');
  assert.equal(loaded.specification.product_brief.outcome, 'Grounded design');
});

test('UX Designer rejects specification bytes that do not match the reviewed checksum', async () => {
  const query = {
    select() { return this; },
    eq() { return this; },
    single: async () => ({
      data: {
        id: 'artifact-spec', job_id: 'job-1', artifact_type: 'product_specification', status: 'final',
        storage_location: 'supabase_storage://builder-artifacts/org/job/spec.json', checksum: 'a'.repeat(64)
      }, error: null
    })
  };
  const supabase = {
    from: () => query,
    storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from('{}') }, error: null }) }) }
  };

  await assert.rejects(
    loadApprovedSpecification(supabase, 'artifact-spec', 'job-1'),
    /integrity check failed/
  );
});

test('UX Designer rejects unapproved specification artifacts before dispatch', async () => {
  let started = false;
  await assert.rejects(runUxDesigner({
    supabase: {},
    gateway: {},
    job: { id: 'job-1', organization_id: 'org-1' },
    step: { id: 'step-2', builder_mode: 'ux_designer' },
    specificationArtifact: { id: 'artifact-spec', artifact_type: 'product_specification', status: 'draft' },
    specification: {},
    startDesign: async () => { started = true; }
  }), /final product specification artifact/);
  assert.equal(started, false);
});
test('a failed designer model run returns the step to failed/retryable with the reason instead of leaving it running', async () => {
  const aborted = [];
  const result = await runUxDesigner({
    supabase: {},
    gateway: {},
    job: { id: 'job-1', organization_id: 'org-1' },
    step: { id: 'step-2', builder_mode: 'ux_designer' },
    specificationArtifact: { id: 'artifact-spec', artifact_type: 'product_specification', status: 'final' },
    repositoryContext: {},
    loadSpecification: async () => ({ artifact: { id: 'artifact-spec' }, specification: { product_brief: { outcome: 'x' } } }),
    startDesign: async () => ({ success: true }),
    executeModelRun: async () => ({ ok: false, status: 422, error: 'model output failed validation: interface_states.error is required' }),
    abortStep: async (_supabase, args) => { aborted.push(args); return true; },
    completeDesign: async () => { throw new Error('must not complete'); }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(aborted, [{ jobId: 'job-1', stepId: 'step-2', reason: 'ux design: model output failed validation: interface_states.error is required' }]);
  // The real abort calls the service-role RPC and never throws.
  const { abortModelStep } = require('../supabase/functions/_shared/builder-ux-designer');
  const calls = [];
  assert.equal(await abortModelStep({ rpc: async (name, args) => { calls.push({ name, args }); return { data: {}, error: null }; } }, { jobId: 'j', stepId: 's', reason: 'r' }), true);
  assert.deepEqual(calls, [{ name: 'builder_abort_model_step', args: { _job_id: 'j', _step_id: 's', _reason: 'r' } }]);
  assert.equal(await abortModelStep({ rpc: async () => { throw new Error('down'); } }, { jobId: 'j', stepId: 's', reason: 'r' }), false);
});

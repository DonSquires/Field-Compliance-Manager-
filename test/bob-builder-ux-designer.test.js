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
    repositoryContext: { existing_design_system: 'PageStyles.css variables', relevant_components: ['ApprovalList'] }
  });

  assert.match(prompt.systemPrompt, /approved product specification/);
  assert.match(prompt.systemPrompt, /Do not invent/);
  assert.equal(JSON.parse(prompt.userPrompt).approved_specification.product_brief.outcome, 'Governed approvals');
});

test('UX Designer parser enforces complete responsive and accessibility output', () => {
  const plan = validDesignPlan();
  assert.deepEqual(parseUxDesignPlan(JSON.stringify(plan)), plan);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...plan, route_map: [] })), /route_map must not be empty/);
  assert.throws(() => parseUxDesignPlan(JSON.stringify({ ...plan, accessibility_requirements: 'none' })), /must be an array/);
});

test('UX Designer uses approved specification artifact as model provenance', async () => {
  let captured;
  const plan = validDesignPlan();
  const result = await runUxDesigner({
    supabase: {},
    gateway: {},
    job: { id: 'job-1', organization_id: 'org-1' },
    step: { id: 'step-2', builder_mode: 'ux_designer' },
    specificationArtifact: { id: 'artifact-spec', artifact_type: 'product_specification', status: 'final' },
    repositoryContext: {},
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

  assert.equal(captured.modelRequest.provider, 'ollama');
  assert.equal(captured.modelRequest.prompt_version, UX_DESIGNER_PROMPT_VERSION);
  assert.deepEqual(captured.modelRequest.input_artifact_ids, ['artifact-spec']);
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
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PRODUCT_ANALYST_PROMPT_VERSION,
  normalizeRepositoryContext,
  researchEvidenceRequired,
  suppliedResearchUrls,
  buildProductAnalystPrompt,
  parseProductSpecification,
  runProductAnalyst
} = require('../supabase/functions/_shared/builder-product-analyst');

function validSpecification() {
  return {
    product_brief: { problem: 'Manual review is slow', outcome: 'A governed queue', scope: ['approval queue'] },
    user_roles: [{ role: 'administrator', needs: ['review evidence'] }],
    user_journeys: [{ actor: 'administrator', goal: 'approve a change', steps: ['open queue', 'review', 'decide'] }],
    functional_requirements: [{ id: 'FR-1', requirement: 'Display pending approvals', priority: 'must' }],
    non_functional_requirements: [{ id: 'NFR-1', requirement: 'Preserve tenant isolation' }],
    data_model_proposal: [{ entity: 'approval', purpose: 'record decisions', relationships: ['belongs to job'] }],
    acceptance_criteria: [{ id: 'AC-1', criterion: 'Unauthorized users cannot decide' }],
    workflow_verification: {
      before: ['authorized administrator has pending approvals'],
      during: ['decision RPC checks organization scope and shows progress'],
      after: ['receipt and downstream status show the persisted decision']
    },
    terrain_verification: {
      schema_checks: ['confirm the approval writer and policy in supabase/schema.sql'],
      atlas_capability_checks: ['confirm the approval capability is present and wired'],
      flow_reach_checks: ['confirm the page calls the governed decision RPC'],
      fk_reach_checks: ['record approval-to-job FK adjacency separately'],
      weak_reference_checks: []
    },
    research_evidence: [],
    human_acceptance: {
      role: 'administrator',
      route: '/admin/approvals',
      job_to_be_done: 'review and decide a pending action',
      steps: ['open the action', 'review evidence', 'approve or reject'],
      expected_visible_result: 'the decision receipt and next state are visible',
      required_states: ['loading', 'permission', 'success', 'safe_next_action']
    },
    unresolved_questions: [],
    assumptions: []
  };
}

test('Product Analyst context excludes arbitrary content and secret fields', () => {
  const context = normalizeRepositoryContext({
    repository: 'owner/repo',
    relevant_files: ['src/App.tsx'],
    build_map: { target_sha: 'a'.repeat(64), file_count: 3, tracked_files: ['src/App.tsx'], secret_files_excluded: true },
    live_context: { atlas: { capability_count: 2 }, live_data: { scope: 'aggregate row counts only' } },
    file_contents: 'private source',
    api_token: 'secret'
  });

  assert.deepEqual(context.relevant_files, ['src/App.tsx']);
  assert.equal(context.build_map.target_sha, 'a'.repeat(64));
  assert.deepEqual(context.build_map.tracked_files, ['src/App.tsx']);
  assert.equal(context.live_context.atlas.capability_count, 2);
  assert.equal('file_contents' in context, false);
  assert.equal('api_token' in context, false);
});

test('Product Analyst prompt requires grounded JSON and unresolved unknowns', () => {
  const prompt = buildProductAnalystPrompt({
    taskDescription: 'Build a governed approval queue',
    repositoryContext: { repository: 'owner/repo' }
  });

  assert.match(prompt.systemPrompt, /Never invent/);
  assert.match(prompt.systemPrompt, /unresolved_questions/);
  assert.match(prompt.systemPrompt, /flow reach separate from structural FK reach/);
  assert.equal(JSON.parse(prompt.userPrompt).task, 'Build a governed approval queue');
  assert.equal(JSON.parse(prompt.userPrompt).repository_context.build_map.file_count, 0);
  assert.deepEqual(JSON.parse(prompt.userPrompt).research_requirements, {
    required: false,
    minimum_sources: 0,
    supplied_research_urls: []
  });
});

test('Product Analyst prompt makes the required source allowlist explicit', () => {
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'];
  const prompt = buildProductAnalystPrompt({
    taskDescription: `Use internet research for this redesign. Sources: ${urls.join(' ')}`,
    repositoryContext: { repository: 'owner/repo' }
  });
  assert.deepEqual(JSON.parse(prompt.userPrompt).research_requirements, {
    required: true,
    minimum_sources: 4,
    supplied_research_urls: urls
  });
});

test('Product Analyst parser accepts the complete specification contract', () => {
  assert.deepEqual(parseProductSpecification(JSON.stringify(validSpecification())), validSpecification());
});

test('Product Analyst requires supplied provenance for research-driven work', () => {
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'];
  assert.equal(researchEvidenceRequired('Use internet research and app inspiration'), true);
  assert.deepEqual(suppliedResearchUrls(`Sources: ${urls.join(' ')}`), urls);
  assert.throws(() => parseProductSpecification(JSON.stringify(validSpecification()), { researchRequired: true, requiredResearchUrls: urls }), /cite at least four/);
  const specification = {
    ...validSpecification(),
    research_evidence: urls.map((url, index) => ({ url, publisher: `Publisher ${index}`, observed_pattern: 'A sourced queue pattern', applicability: 'Use only for the Builder queue hierarchy' }))
  };
  assert.deepEqual(parseProductSpecification(JSON.stringify(specification), { researchRequired: true, requiredResearchUrls: urls }), specification);
  specification.research_evidence[0].url = 'https://invented.example/source';
  assert.throws(() => parseProductSpecification(JSON.stringify(specification), { researchRequired: true, requiredResearchUrls: urls }), /was not supplied/);
});

test('Product Analyst parser rejects malformed or incomplete output', () => {
  assert.throws(() => parseProductSpecification('not json'), /valid JSON/);
  assert.throws(() => parseProductSpecification(JSON.stringify({ product_brief: {} })), /must be an array/);
  assert.throws(() => parseProductSpecification(JSON.stringify({
    ...validSpecification(), acceptance_criteria: []
  })), /must not be empty/);
  assert.throws(() => parseProductSpecification(JSON.stringify({
    ...validSpecification(), workflow_verification: { before: [], during: ['x'], after: ['y'] }
  })), /workflow_verification.before/);
});

test('Product Analyst routes complex analysis through the governed model runner', async () => {
  let captured;
  const specification = validSpecification();
  const result = await runProductAnalyst({
    supabase: {},
    gateway: { gatewayUrl: 'https://control.example', apiToken: 'token' },
    job: { id: 'job-1', organization_id: 'org-1', task_description: 'Build approvals' },
    step: { id: 'step-1', builder_mode: 'product_analyst' },
    repositoryContext: { repository: 'owner/repo', relevant_files: ['src/App.tsx'] },
    startAnalysis: async () => ({ success: true }),
    executeModelRun: async input => {
      captured = input;
      return { ok: true, validated_output: specification, artifact: { id: 'artifact-1' } };
    },
    completeAnalysis: async (_supabase, input) => ({ success: true, approval: { id: 'approval-1', ...input } })
  });

  assert.deepEqual(captured.modelRequest.chain, ['openai', 'gpu_workstation']);
  assert.equal(captured.modelRequest.provider, 'openai');
  assert.equal(captured.modelRequest.prompt_version, PRODUCT_ANALYST_PROMPT_VERSION);
  assert.deepEqual(captured.validateOutput(JSON.stringify(specification)), specification);
  assert.deepEqual(result.specification, specification);
  assert.equal(result.approval.id, 'approval-1');
});

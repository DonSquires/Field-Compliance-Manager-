const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PRODUCT_ANALYST_PROMPT_VERSION,
  normalizeRepositoryContext,
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
  assert.equal(JSON.parse(prompt.userPrompt).task, 'Build a governed approval queue');
  assert.equal(JSON.parse(prompt.userPrompt).repository_context.build_map.file_count, 0);
});

test('Product Analyst parser accepts the complete specification contract', () => {
  assert.deepEqual(parseProductSpecification(JSON.stringify(validSpecification())), validSpecification());
});

test('Product Analyst parser rejects malformed or incomplete output', () => {
  assert.throws(() => parseProductSpecification('not json'), /valid JSON/);
  assert.throws(() => parseProductSpecification(JSON.stringify({ product_brief: {} })), /must be an array/);
  assert.throws(() => parseProductSpecification(JSON.stringify({
    ...validSpecification(), acceptance_criteria: []
  })), /must not be empty/);
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

  // In-house first: analysis work tries the laptop GPU, then OpenAI.
  assert.deepEqual(captured.modelRequest.chain, ['gpu_workstation', 'openai']);
  assert.equal(captured.modelRequest.provider, 'gpu_workstation');
  assert.equal(captured.modelRequest.prompt_version, PRODUCT_ANALYST_PROMPT_VERSION);
  assert.equal(captured.validateOutput, parseProductSpecification);
  assert.deepEqual(result.specification, specification);
  assert.equal(result.approval.id, 'approval-1');
});
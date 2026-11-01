const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PRODUCT_ANALYST_PROMPT_VERSION,
  normalizeRepositoryContext,
  researchEvidenceRequired,
  suppliedResearchUrls,
  requiredSourceScope,
  isBroadUiRedesign,
  validateDeliveryRequirements,
  validateRepositoryGrounding,
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
    delivery_requirements: [{ id: 'DR-1', outcome: 'Pending approvals are visibly grouped by status', evidence: 'Component test and human review show the grouped queue', source_scope: ['apps/web/src/pages/ApprovalsPage.tsx'] }],
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

test('contradictory main-health receipts abort before any model request', async () => {
  let aborted;
  const result = await runProductAnalyst({
    job: { id: 'j', organization_id: 'o', autopilot_source: 'main_monitor',
      source_main_health_files: ['apps/web/src/lib/patrolImportLifecycle.guard.test.ts'],
      task_description: '❯ src/lib/dispatchCreationSchema.guard.test.ts (2 tests | 1 failed)' },
    step: { id: 's', builder_mode: 'product_analyst' },
    startAnalysis: async () => ({ success: true }),
    abortStep: async (_supabase, args) => { aborted = args; },
    executeModelRun: async () => { assert.fail('conflicting evidence must not consume a model request'); },
  });
  assert.equal(result.status, 409);
  assert.match(aborted.reason, /Evidence conflict/);
});

test('schema-backed Atlas RPC names are known identifiers, but invented capabilities still fail', () => {
  const spec = validSpecification();
  spec.terrain_verification.atlas_capability_checks = ['Inspect bob_atlas_flow_reach'];
  const repositoryContext = { build_map: { schema: { functions: ['bob_atlas_flow_reach'] } } };
  assert.doesNotThrow(() => validateRepositoryGrounding(spec, { repositoryContext }));
  spec.terrain_verification.atlas_capability_checks = ['Inspect bob_invented_capability'];
  assert.throws(() => validateRepositoryGrounding(spec, { repositoryContext }), /not supplied by repository evidence/);
});
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
  assert.equal(JSON.parse(prompt.userPrompt).scope_contract.frontend_only_no_new_backend, false);
});

test('Product Analyst frontend-only prompt requires an empty data model proposal', () => {
  const prompt = buildProductAnalystPrompt({
    taskDescription: 'Frontend-only redesign. Do not create or propose any database entity, RPC, route, or API.',
    repositoryContext: { repository: 'owner/repo' }
  });
  const request = JSON.parse(prompt.userPrompt);
  assert.deepEqual(request.scope_contract, {
    frontend_only_no_new_backend: true,
    data_model_proposal_must_be_empty: true,
    required_source_scope: []
  });
  assert.deepEqual(request.required_output.data_model_proposal, []);
});

test('Product Analyst prompt exposes the exact broad redesign delivery contract', () => {
  const prompt = buildProductAnalystPrompt({
    taskDescription: 'Redesign the Builder workspace UI and UX as a professional interface',
    repositoryContext: { repository: 'owner/repo' }
  });
  const request = JSON.parse(prompt.userPrompt);
  assert.deepEqual(request.broad_ui_redesign_delivery_contract, {
    minimum_delivery_requirements: 5,
    minimum_acceptance_criteria: 5,
    required_categories: [
      'information hierarchy or workspace composition',
      'responsive desktop and mobile behavior',
      'accessibility and keyboard behavior',
      'loading, empty, error, permission, and success states',
      'operational status, evidence, or receipt visibility'
    ],
    required_human_acceptance_states: ['loading', 'empty', 'error', 'permission', 'success', 'safe_next_action'],
    source_scope_rule: 'Use only exact repository paths supplied by repository_context or named byte-for-byte in the task.'
  });
  assert.match(prompt.systemPrompt, /literal state words loading, empty, error, permission, and success/);
});

test('Product Analyst constrains delivery requirements to required source scope', () => {
  const taskDescription = 'Repair the guard.\nRequired source scope: apps/web/src/pages/FinanceBureauPage.guard.test.ts.';
  assert.deepEqual(requiredSourceScope(taskDescription), ['apps/web/src/pages/FinanceBureauPage.guard.test.ts']);
  const prompt = buildProductAnalystPrompt({
    taskDescription,
    repositoryContext: { build_map: { tracked_files: ['apps/web/src/pages/FinanceBureauPage.guard.test.ts', 'apps/web/src/pages/FinanceBureauPage.tsx'] } }
  });
  assert.deepEqual(JSON.parse(prompt.userPrompt).scope_contract.required_source_scope, ['apps/web/src/pages/FinanceBureauPage.guard.test.ts']);

  const specification = {
    ...validSpecification(),
    delivery_requirements: [{
      id: 'DR-1',
      outcome: 'Repair the failing guard',
      evidence: 'The guard test passes',
      source_scope: ['apps/web/src/pages/FinanceBureauPage.tsx']
    }]
  };
  assert.throws(() => validateRepositoryGrounding(specification, {
    repositoryContext: { build_map: { tracked_files: ['apps/web/src/pages/FinanceBureauPage.guard.test.ts', 'apps/web/src/pages/FinanceBureauPage.tsx'], schema: {} } },
    taskDescription
  }), /outside the task's required source scope/);
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

test('Product Analyst rejects invented backend terrain and product integrations in frontend-only redesigns', () => {
  const specification = {
    ...validSpecification(),
    data_model_proposal: [{
      entity: 'bob_job_run',
      purpose: 'invented workflow state',
      relationships: ['fk_to_atlas_schema']
    }],
    terrain_verification: {
      ...validSpecification().terrain_verification,
      atlas_capability_checks: ['Verify bob-job-plan-create is wired']
    },
    functional_requirements: [{
      id: 'FR-1',
      requirement: 'Enable pull request review with GitHub Copilot integration',
      priority: 'must'
    }]
  };
  const repositoryContext = {
    build_map: {
      schema: {
        tables: ['builder_jobs'],
        views: [],
        functions: ['builder_create_job_v2']
      }
    },
    known_capabilities: []
  };
  const taskDescription = 'Frontend-only redesign. Use GitHub Copilot for bounded inspiration rather than copying it. Do not invent schema or APIs.';

  assert.throws(
    () => validateRepositoryGrounding(specification, { repositoryContext, taskDescription }),
    /must be empty for frontend-only work/
  );

  specification.data_model_proposal = [];
  assert.throws(
    () => validateRepositoryGrounding(specification, { repositoryContext, taskDescription }),
    /Atlas capability not supplied/
  );

  specification.terrain_verification.atlas_capability_checks = ['Verify the existing Builder job capability without inventing a name'];
  assert.throws(
    () => validateRepositoryGrounding(specification, { repositoryContext, taskDescription }),
    /unrequested product integration/
  );

  specification.functional_requirements[0].requirement = 'Use the supplied review pattern to improve the existing Builder receipt hierarchy';
  assert.doesNotThrow(
    () => validateRepositoryGrounding(specification, { repositoryContext, taskDescription })
  );
});

test('Product Analyst accepts exact source paths named by the owner brief when fitted context omits them', () => {
  const specification = {
    ...validSpecification(),
    delivery_requirements: [{
      id: 'DR-1',
      outcome: 'Builder receipts remain visible',
      evidence: 'Component test and human review',
      source_scope: ['apps/web/src/pages/BuilderControlRoomPage.tsx']
    }]
  };
  const repositoryContext = {
    relevant_files: ['apps/web/src/components/BobPanel.tsx'],
    build_map: { tracked_files: ['apps/web/src/components/BobPanel.tsx'], schema: {} }
  };
  assert.doesNotThrow(() => validateRepositoryGrounding(specification, {
    repositoryContext,
    taskDescription: 'Required source scope: apps/web/src/pages/BuilderControlRoomPage.tsx.'
  }));
  assert.throws(() => validateRepositoryGrounding(specification, {
    repositoryContext,
    taskDescription: 'Redesign the Builder workspace'
  }), /source_scope was not supplied by repository evidence/);
});

test('Product Analyst grounds source_scope against the full tracked inventory, not the window-fitted prompt list', () => {
  // Live 2026-10-21: main-health repairs named the real apps/web/src/shells/AdminShell.tsx and were
  // rejected 6/6 because the fitted context kept only 40 files.
  const specification = {
    ...validSpecification(),
    delivery_requirements: [{ id: 'DR-1', outcome: 'Admin shell guard passes', evidence: 'Guard test', source_scope: ['apps/web/src/shells/AdminShell.tsx'] }]
  };
  const repositoryContext = { build_map: { tracked_files: ['apps/web/src/components/BobPanel.tsx'], schema: {} } };
  const repositoryFiles = ['apps/web/src/components/BobPanel.tsx', 'apps/web/src/shells/AdminShell.tsx'];
  assert.doesNotThrow(() => validateRepositoryGrounding(specification, { repositoryContext, taskDescription: 'Repair main', repositoryFiles }));
  const invented = { ...specification, delivery_requirements: [{ ...specification.delivery_requirements[0], source_scope: ['apps/web/src/shells/InventedShell.tsx'] }] };
  assert.throws(() => validateRepositoryGrounding(invented, { repositoryContext, taskDescription: 'Repair main', repositoryFiles }), /not supplied by repository evidence/);
});

test('Product Analyst accepts tracked deploy/, Build-Plan/ and root files but rejects unsafe or untracked paths', () => {
  // Live 2026-10-21: deploy/bob-release-lane/bob-release-lane.timer and Build-Plan/bob-control-plane-server.js
  // are tracked, yet a prefix allowlist rejected them as "not a repository path".
  const tracked = ['deploy/bob-release-lane/bob-release-lane.timer', 'Build-Plan/bob-control-plane-server.js', 'builder-autopilot.js'];
  const repositoryContext = { build_map: { tracked_files: [], schema: {} } };
  const withScope = (scope) => ({
    ...validSpecification(),
    delivery_requirements: [{ id: 'DR-1', outcome: 'Release lane timer is correct', evidence: 'Unit test', source_scope: scope }]
  });
  assert.doesNotThrow(() => validateRepositoryGrounding(withScope(tracked), { repositoryContext, taskDescription: 'Repair', repositoryFiles: tracked }));
  for (const unsafe of ['/etc/passwd', '../secrets.env', 'apps/../x.js', '.env', 'apps/web/']) {
    assert.throws(() => validateRepositoryGrounding(withScope([unsafe]), { repositoryContext, taskDescription: 'Repair', repositoryFiles: tracked }), /not a repository path/, unsafe);
  }
  assert.throws(() => validateRepositoryGrounding(withScope(['deploy/invented.service']), { repositoryContext, taskDescription: 'Repair', repositoryFiles: tracked }), /not supplied by repository evidence/);
});

test('Product Analyst parser accepts one complete object wrapped in prose, never a truncated one', () => {
  const spec = JSON.stringify(validSpecification());
  assert.equal(parseProductSpecification(`Here is the specification:\n${spec}\nDone.`).product_brief.problem, validSpecification().product_brief.problem);
  assert.throws(() => parseProductSpecification(spec.slice(0, -20)), /valid JSON/);
  assert.throws(() => parseProductSpecification(`Here: ${spec.slice(0, -20)}`), /valid JSON/);
});

test('Product Analyst prompt forbids weakening lane guards and grounds Atlas gap work in live gaps', () => {
  const { systemPrompt } = buildProductAnalystPrompt({ taskDescription: 'Repair Atlas gaps one by one', repositoryContext: {} });
  assert.match(systemPrompt, /never propose removing or weakening a guard/);
  assert.match(systemPrompt, /live_context\.atlas\.gaps/);
  assert.match(systemPrompt, /claim to verify, not evidence/);
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

test('Product Analyst rejects generic acceptance for a broad UI redesign', () => {
  const taskDescription = 'Redesign the Builder workspace UI and UX to be a professional enterprise interface';
  assert.equal(isBroadUiRedesign(taskDescription), true);
  const generic = {
    ...validSpecification(),
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'Tests pass' },
      { id: 'AC-2', criterion: 'WCAG passes' }
    ]
  };
  assert.throws(
    () => validateDeliveryRequirements(generic, taskDescription),
    /at least five delivery requirements and five measurable acceptance criteria/
  );

  const complete = {
    ...validSpecification(),
    acceptance_criteria: Array.from({ length: 5 }, (_, index) => ({ id: `AC-${index + 1}`, criterion: `Observable criterion ${index + 1}` })),
    delivery_requirements: [
      { id: 'DR-1', outcome: 'A coherent enterprise workspace groups conversation and Studio controls', evidence: 'Human glass review', source_scope: ['apps/web/src/pages/BuilderControlRoomPage.tsx'] },
      { id: 'DR-2', outcome: 'Responsive desktop and mobile breakpoints preserve context', evidence: 'Desktop and mobile browser checks', source_scope: ['apps/web/src/pages/BuilderControlRoomPage.css'] },
      { id: 'DR-3', outcome: 'Accessible keyboard focus and screen reader labels meet WCAG', evidence: 'Keyboard and accessibility checks', source_scope: ['apps/web/src/components/BobStudio.tsx'] },
      { id: 'DR-4', outcome: 'Loading, empty, error, permission, and success states provide a safe next action', evidence: 'State-focused component tests', source_scope: ['apps/web/src/components/BobStudio.tsx'] },
      { id: 'DR-5', outcome: 'Job progress status and verification receipt evidence stay visible', evidence: 'Human glass review of operational receipts', source_scope: ['apps/web/src/pages/BuilderControlRoomPage.tsx'] }
    ],
    human_acceptance: {
      ...validSpecification().human_acceptance,
      required_states: ['loading', 'empty', 'error', 'permission', 'success', 'safe_next_action']
    }
  };
  assert.doesNotThrow(() => validateDeliveryRequirements(complete, taskDescription));
  complete.delivery_requirements = complete.delivery_requirements.map(requirement => ({
    ...requirement,
    source_scope: ['apps/web/src/pages/BuilderControlRoomPage.css']
  }));
  assert.throws(
    () => validateDeliveryRequirements(complete, taskDescription),
    /at least three source files including behavioral UI code and styling/
  );
});

test('Product Analyst routes complex analysis through the governed model runner', async () => {
  let captured;
  const specification = validSpecification();
  const result = await runProductAnalyst({
    supabase: {},
    gateway: { gatewayUrl: 'https://control.example', apiToken: 'token' },
    job: { id: 'job-1', organization_id: 'org-1', task_description: 'Build approvals' },
    step: { id: 'step-1', builder_mode: 'product_analyst' },
    repositoryContext: { repository: 'owner/repo', relevant_files: ['src/App.tsx', 'apps/web/src/pages/ApprovalsPage.tsx'] },
    startAnalysis: async () => ({ success: true }),
    executeModelRun: async input => {
      captured = input;
      return { ok: true, validated_output: specification, artifact: { id: 'artifact-1' } };
    },
    completeAnalysis: async (_supabase, input) => ({ success: true, approval: { id: 'approval-1', ...input } })
  });

  assert.deepEqual(captured.modelRequest.chain, ['gpu_workstation', 'ollama_cloud', 'openai']);
  assert.equal(captured.modelRequest.provider, 'gpu_workstation');
  assert.equal(captured.modelRequest.prompt_version, PRODUCT_ANALYST_PROMPT_VERSION);
  assert.deepEqual(captured.validateOutput(JSON.stringify(specification)), specification);
  assert.deepEqual(result.specification, specification);
  assert.equal(result.approval.id, 'approval-1');
});

test('product analyst rejects placeholder source_scope paths even without a tracked-file map', () => {
  const { validateRepositoryGrounding: ground } = require('../supabase/functions/_shared/builder-product-analyst.js');
  for (const file of ['apps/web/src/pages/ExamplePage.tsx', 'supabase/functions/example/index.ts']) {
    assert.throws(() => ground({ delivery_requirements: [{ id: 'r1', source_scope: [file] }] }, {}), /placeholder/);
  }
  assert.doesNotThrow(() => ground({ delivery_requirements: [{ id: 'r1', source_scope: ['apps/web/src/pages/OrganizationSetupPage.tsx'] }] }, {}));
});

test('revised analysis consumes confirmed feedback from the freshly locked step without changing the task', async () => {
  let request;
  const feedback = 'Revisit the reported current workflow and distinguish map leads from checked facts.';
  const report = 'The final answer failed after the diary save succeeded.';
  const constraints = Array.from({ length: 100 }, (_, index) => `Existing constraint ${index}`);
  const job = { id: 'job', organization_id: 'org', task_description: 'Original immutable request' };
  await runProductAnalyst({
    job, step: { id: 'step', builder_mode: 'product_analyst' }, repositoryContext: {},
    constraints,
    startAnalysis: async () => ({ success: true, step: { input_context: { specification_revision: { feedback, review_quote: report } } } }),
    executeModelRun: async input => {
      request = input.modelRequest;
      return { ok: true, validated_output: validSpecification(), artifact: { id: 'revised-spec' } };
    },
    completeAnalysis: async () => ({ success: true, approval: { id: 'new-approval' } }),
  });
  assert.ok(request.request.user_prompt.includes(feedback));
  assert.ok(request.request.user_prompt.includes('Original immutable request'));
  assert.deepEqual(JSON.parse(request.request.user_prompt).constraints, constraints);
  assert.deepEqual(JSON.parse(request.request.user_prompt).specification_revision, { feedback, human_report: report });
  assert.match(request.request.system_prompt, /Atlas is a map, not evidence/);
  assert.match(request.request.system_prompt, /file inventory proves existence, not source inspection/);
  assert.equal(job.task_description, 'Original immutable request');
});

test('Atlas gap specifications must name a live gap, and live gap names are known capabilities', () => {
  const repositoryContext = { build_map: { tracked_files: ['scripts/atlas-refresh.js'], schema: { tables: ['bob_capability_map'] } }, live_context: { atlas: { gaps: { total: 1, items: [{ entity_type: 'rpc', entity_name: 'compact_cctv_inference_results', gap_kind: 'unwired' }] } } } };
  const task = 'Repair Atlas gaps one by one.';
  const spec = (outcome) => ({
    ...validSpecification(),
    delivery_requirements: [{ id: 'DR-1', outcome, evidence: 'Atlas refresh shows wired', source_scope: ['scripts/atlas-refresh.js'] }],
    terrain_verification: { ...validSpecification().terrain_verification, atlas_capability_checks: ['bob_capability_map row for compact_cctv_inference_results'] }
  });
  assert.doesNotThrow(() => validateRepositoryGrounding(spec('Register the caller of compact_cctv_inference_results'), { repositoryContext, taskDescription: task }));
  assert.throws(() => validateRepositoryGrounding(spec('Close the BuilderLiveActivity gap in the Atlas page seed'), { repositoryContext, taskDescription: task }), /must name at least one live gap/);
  assert.doesNotThrow(() => validateRepositoryGrounding(spec('Close the BuilderLiveActivity gap'), { repositoryContext: { ...repositoryContext, live_context: null }, taskDescription: task }));
});

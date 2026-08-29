import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeJob,
  normalizeJobStep,
  JOB_LIFECYCLE,
  BUILDER_MODES,
  getDefaultJobSteps,
  createBuilderJob,
  getNextBuilderStep,
  checkDependenciesMet,
  buildJobCheckpoint,
  getNextJobStatus,
  sanitizeBuilderEvidence
} from '../supabase/functions/_shared/builder-job-orchestrator.js';

test('Builder job system: normalizeJob converts raw to standard shape', () => {
  const raw = {
    id: 'job-123',
    organization_id: 'org-456',
    title: 'Build auth module',
    status: 'intake'
  };

  const normalized = normalizeJob(raw);

  assert.equal(normalized.id, 'job-123');
  assert.equal(normalized.organization_id, 'org-456');
  assert.equal(normalized.title, 'Build auth module');
  assert.equal(normalized.status, 'intake');
  assert.equal(normalized.approval_required_at.length, 0);
});

test('Builder job system: normalizeJob handles missing fields with defaults', () => {
  const raw = { id: 'job-123' };
  const normalized = normalizeJob(raw);

  assert.equal(normalized.title, '');
  assert.equal(normalized.status, 'intake');
  assert.equal(normalized.current_step_index, 0);
  assert.equal(normalized.error_count, 0);
  assert.deepEqual(normalized.approval_required_at, []);
});

test('Builder job system: normalizeJob returns null for invalid input', () => {
  assert.equal(normalizeJob(null), null);
  assert.equal(normalizeJob(undefined), null);
  assert.equal(normalizeJob('not an object'), null);
});

test('Builder job system: normalizeJobStep converts step to standard shape', () => {
  const raw = {
    step_id: 'product_analysis',
    builder_mode: 'product_analyst',
    status: 'pending',
    attempt_count: 0
  };

  const normalized = normalizeJobStep(raw, 0);

  assert.equal(normalized.step_id, 'product_analysis');
  assert.equal(normalized.builder_mode, 'product_analyst');
  assert.equal(normalized.status, 'pending');
  assert.equal(normalized.ordinal_position, 1);
  assert.equal(normalized.retryable, false);
});

test('Builder job system: getDefaultJobSteps returns ordered builder workflow', () => {
  const steps = getDefaultJobSteps();

  assert.equal(steps.length, 7);
  assert.equal(steps[0].step_id, 'product_analysis');
  assert.equal(steps[0].builder_mode, 'product_analyst');
  assert.equal(steps[1].step_id, 'ui_design');
  assert.equal(steps[1].builder_mode, 'ux_designer');
  assert.equal(steps[2].step_id, 'frontend_implementation');
  assert.equal(steps[3].step_id, 'backend_implementation');
  assert.equal(steps[4].step_id, 'test_suite');
  assert.equal(steps[5].step_id, 'security_review');
  assert.equal(steps[6].step_id, 'release_prep');
});

test('Builder job system: default workflow respects dependencies', () => {
  const steps = getDefaultJobSteps();

  // UI design depends on product analysis
  const uiStep = steps.find(s => s.step_id === 'ui_design');
  assert.ok(uiStep.blocked_dependencies.includes('product_analysis'));

  // Frontend depends on UI design
  const frontendStep = steps.find(s => s.step_id === 'frontend_implementation');
  assert.ok(frontendStep.blocked_dependencies.includes('ui_design'));

  // Test suite depends on both implementations
  const testStep = steps.find(s => s.step_id === 'test_suite');
  assert.ok(testStep.blocked_dependencies.includes('frontend_implementation'));
  assert.ok(testStep.blocked_dependencies.includes('backend_implementation'));
});

test('Builder job system: createBuilderJob initializes with intake status', () => {
  const { job, steps } = createBuilderJob({
    organizationId: 'org-123',
    projectId: 'proj-456',
    title: 'Add payment module',
    description: 'Integrate Stripe',
    taskDescription: 'User story: customers can pay with card or bank transfer',
    branchName: 'feature/payment',
    targetSha: 'abc123'
  });

  assert.equal(job.organization_id, 'org-123');
  assert.equal(job.project_id, 'proj-456');
  assert.equal(job.title, 'Add payment module');
  assert.equal(job.status, JOB_LIFECYCLE.INTAKE);
  assert.equal(job.current_step_index, 0);
  assert.equal(job.total_steps, 7);
  assert.ok(job.approval_required_at.includes('specification_ready'));
});

test('Builder job system: createBuilderJob returns normalized steps', () => {
  const { steps } = createBuilderJob({
    organizationId: 'org-123',
    projectId: 'proj-456',
    title: 'Test',
    taskDescription: 'Test'
  });

  assert.equal(steps.length, 7);
  assert.equal(steps[0].step_id, 'product_analysis');
  assert.equal(steps[0].status, 'pending');
  assert.equal(steps[0].builder_mode, 'product_analyst');
});

test('Builder job system: checkDependenciesMet returns true when no dependencies', () => {
  const step = { blocked_dependencies: [] };
  const allSteps = [];

  assert.equal(checkDependenciesMet(step, allSteps), true);
});

test('Builder job system: checkDependenciesMet returns true when all dependencies completed', () => {
  const step = {
    step_id: 'ui_design',
    blocked_dependencies: ['product_analysis']
  };

  const allSteps = [
    { step_id: 'product_analysis', status: 'completed' },
    { step_id: 'ui_design', status: 'pending' }
  ];

  assert.equal(checkDependenciesMet(step, allSteps), true);
});

test('Builder job system: checkDependenciesMet returns false when dependency not completed', () => {
  const step = {
    step_id: 'ui_design',
    blocked_dependencies: ['product_analysis']
  };

  const allSteps = [
    { step_id: 'product_analysis', status: 'pending' },
    { step_id: 'ui_design', status: 'pending' }
  ];

  assert.equal(checkDependenciesMet(step, allSteps), false);
});

test('Builder job system: getNextBuilderStep prioritizes retryable-failed > pending', () => {
  const job = { status: 'building' };
  const steps = [
    { step_id: 'product_analysis', status: 'completed', blocked_dependencies: [] },
    { step_id: 'ui_design', status: 'failed', retryable: true, blocked_dependencies: ['product_analysis'] },
    { step_id: 'frontend', status: 'pending', blocked_dependencies: ['ui_design'] }
  ];

  const nextStep = getNextBuilderStep(job, steps);

  assert.equal(nextStep.step_id, 'ui_design');
});

test('Builder job system: getNextBuilderStep respects dependencies', () => {
  const job = { status: 'building' };
  const steps = [
    { step_id: 'product_analysis', status: 'pending', blocked_dependencies: [] },
    { step_id: 'ui_design', status: 'pending', blocked_dependencies: ['product_analysis'] }
  ];

  const nextStep = getNextBuilderStep(job, steps);

  // Should get product_analysis first, ui_design is blocked
  assert.equal(nextStep.step_id, 'product_analysis');
});

test('Builder job system: getNextBuilderStep returns null when all complete', () => {
  const job = { status: 'building' };
  const steps = [
    { step_id: 'product_analysis', status: 'completed', blocked_dependencies: [] },
    { step_id: 'ui_design', status: 'completed', blocked_dependencies: [] }
  ];

  const nextStep = getNextBuilderStep(job, steps);

  assert.equal(nextStep, null);
});

test('Builder job system: buildJobCheckpoint tracks completed steps and next work', () => {
  const job = {
    id: 'job-123',
    status: 'building',
    current_step_index: 1,
    total_steps: 7
  };

  const steps = [
    { step_id: 'product_analysis', status: 'completed', blocked_dependencies: [] },
    { step_id: 'ui_design', status: 'pending', blocked_dependencies: ['product_analysis'] },
    { step_id: 'frontend', status: 'pending', blocked_dependencies: ['ui_design'] }
  ];

  const checkpoint = buildJobCheckpoint(job, steps);

  assert.deepEqual(checkpoint.completed_step_ids, ['product_analysis']);
  assert.equal(checkpoint.next_step_id, 'ui_design');
  assert.equal(checkpoint.progress_unverified, false);
});

test('Builder job system: buildJobCheckpoint fails closed with null job', () => {
  const checkpoint = buildJobCheckpoint(null, []);

  assert.equal(checkpoint.progress_unverified, true);
  assert.deepEqual(checkpoint.completed_step_ids, []);
  assert.equal(checkpoint.next_step_id, null);
});

test('Builder job system: getNextJobStatus progresses through workflow', () => {
  const approval = ['specification_ready', 'design_ready', 'approval_pending'];

  // intake → analysis_pending
  let next = getNextJobStatus(JOB_LIFECYCLE.INTAKE, 'N/A', approval);
  assert.equal(next, JOB_LIFECYCLE.ANALYSIS_PENDING);

  // analysis_pending → specification_ready (hits approval gate)
  next = getNextJobStatus(JOB_LIFECYCLE.ANALYSIS_PENDING, 'product_analysis', approval);
  assert.equal(next, JOB_LIFECYCLE.APPROVAL_PENDING);

  // specification_ready → design_pending (after approval)
  next = getNextJobStatus(JOB_LIFECYCLE.SPECIFICATION_READY, 'design_pending', approval);
  assert.equal(next, JOB_LIFECYCLE.DESIGN_PENDING);
});

test('Builder job system: sanitizeBuilderEvidence strips secrets but keeps proof', () => {
  const result = {
    specification_outline: {
      sections: [
        { title: 'Requirements' },
        { title: 'User Stories' }
      ]
    }
  };

  const evidence = sanitizeBuilderEvidence(result, 'product_analyst');

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].type, 'specification_outline');
  assert.equal(evidence[0].section_count, 2);
  assert.equal(evidence[0].status, 'found');
});

test('Builder job system: sanitizeBuilderEvidence keeps file paths, not content', () => {
  const result = {
    changed_files: [
      'src/auth/login.ts',
      'src/auth/logout.ts',
      'src/components/LoginForm.tsx'
    ],
    commit_sha: 'abc123def456abc123def456abc123def456abc1'
  };

  const evidence = sanitizeBuilderEvidence(result, 'frontend_engineer');

  const fileEv = evidence.find(e => e.type === 'file_paths');
  assert.ok(fileEv);
  assert.equal(fileEv.file_count, 3);
  assert.deepEqual(fileEv.files, [
    'src/auth/login.ts',
    'src/auth/logout.ts',
    'src/components/LoginForm.tsx'
  ]);

  const commitEv = evidence.find(e => e.type === 'commit_reference');
  assert.ok(commitEv);
  assert.equal(commitEv.sha, 'abc123def456'); // First 12 chars of SHA
});

test('Builder job system: sanitizeBuilderEvidence marks test results and security findings', () => {
  const result = {
    test_results: { passed: 42, failed: 2, skipped: 1 },
    security_findings: { critical: 0, high: 1, medium: 3 }
  };

  const evidence = sanitizeBuilderEvidence(result, 'qa_security_reviewer');

  const testEv = evidence.find(e => e.type === 'test_results');
  assert.ok(testEv);
  assert.equal(testEv.passed, 42);
  assert.equal(testEv.failed, 2);
  assert.equal(testEv.status, 'failed'); // Has failures

  const secEv = evidence.find(e => e.type === 'security_findings');
  assert.ok(secEv);
  assert.equal(secEv.critical, 0);
  assert.equal(secEv.high, 1);
  assert.equal(secEv.status, 'reviewed'); // No critical findings
});

test('Builder job system: JOB_LIFECYCLE includes all required states', () => {
  assert.ok(JOB_LIFECYCLE.INTAKE);
  assert.ok(JOB_LIFECYCLE.SPECIFICATION_READY);
  assert.ok(JOB_LIFECYCLE.APPROVAL_PENDING);
  assert.ok(JOB_LIFECYCLE.RELEASE_READY);
  assert.ok(JOB_LIFECYCLE.DEPLOYED);
  assert.ok(JOB_LIFECYCLE.FAILED);
  assert.ok(JOB_LIFECYCLE.CANCELLED);
});

test('Builder job system: BUILDER_MODES includes all required roles', () => {
  assert.ok(BUILDER_MODES.includes('product_analyst'));
  assert.ok(BUILDER_MODES.includes('ux_designer'));
  assert.ok(BUILDER_MODES.includes('frontend_engineer'));
  assert.ok(BUILDER_MODES.includes('backend_engineer'));
  assert.ok(BUILDER_MODES.includes('qa_security_reviewer'));
  assert.ok(BUILDER_MODES.includes('release_engineer'));
});

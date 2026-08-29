/**
 * builder-job-orchestrator.js
 *
 * Orchestration logic for Builder Job System
 * Wires to task continuity (bob_task_runs/bob_task_steps) for resumable multi-step workflows
 *
 * Handles:
 * - Job state machine transitions (intake → analysis → spec → design → implementation → testing → security → approval → release)
 * - Step orchestration (Product Analyst → UX Designer → Frontend Engineer → QA → Release Engineer)
 * - Approval gate management
 * - Artifact collection and versioning
 * - Audit event recording (immutable trail per Build-Plan.md doctrine)
 * - Integration with task continuity for resume capability
 */

/**
 * Normalize job into standard shape for pure function operations
 * @param {Object} job - Raw job object from DB or creation
 * @returns {Object|null} Normalized job object
 */
function normalizeJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id || null,
    organization_id: job.organization_id || null,
    project_id: job.project_id || null,
    task_run_id: job.task_run_id || null,

    title: job.title || '',
    description: job.description || '',
    task_description: job.task_description || '',

    status: job.status || 'intake',
    current_step_name: job.current_step_name || null,
    current_step_index: Number.isInteger(job.current_step_index) ? job.current_step_index : 0,
    total_steps: Number.isInteger(job.total_steps) ? job.total_steps : 0,

    branch_name: job.branch_name || null,
    target_sha: job.target_sha || null,

    approval_required_at: Array.isArray(job.approval_required_at) ? job.approval_required_at : [],

    last_error: job.last_error || null,
    error_count: Number.isInteger(job.error_count) ? job.error_count : 0,

    created_by: job.created_by || null,
    created_at: job.created_at || null,
    updated_at: job.updated_at || null
  };
}

/**
 * Normalize step into standard shape
 * @param {Object} step - Raw step object from DB
 * @param {number} index - Ordinal index in steps array
 * @returns {Object|null} Normalized step object
 */
function normalizeJobStep(step, index) {
  if (!step || typeof step !== 'object') return null;
  const status = step.status || 'pending';
  return {
    id: step.id || null,
    job_id: step.job_id || null,
    step_id: step.step_id || `step-${index + 1}`,
    ordinal_position: Number.isInteger(step.ordinal_position) ? step.ordinal_position : index + 1,

    builder_mode: step.builder_mode || null, // product_analyst, ux_designer, frontend_engineer, etc.
    model_provider: step.model_provider || null,
    model_name: step.model_name || null,

    status,
    attempt_count: Number.isInteger(step.attempt_count) ? step.attempt_count : 0,
    started_at: step.started_at || null,
    completed_at: step.completed_at || null,

    input_context: step.input_context || {},
    result_summary: step.result_summary || null,

    evidence_refs: Array.isArray(step.evidence_refs) ? step.evidence_refs : [],
    artifact_ids: Array.isArray(step.artifact_ids) ? step.artifact_ids : [],

    error: step.error || null,
    retryable: Boolean(step.retryable),

    blocked_reason: step.blocked_reason || null,
    blocked_dependencies: Array.isArray(step.blocked_dependencies) ? step.blocked_dependencies : [],

    created_at: step.created_at || null,
    updated_at: step.updated_at || null
  };
}

/**
 * Job lifecycle states per Build-Plan.md
 * Defines valid transitions and approval requirements
 */
const JOB_LIFECYCLE = {
  INTAKE: 'intake', // Initial state, collect requirements
  ANALYSIS_PENDING: 'analysis_pending', // Waiting for product analyst
  SPECIFICATION_READY: 'specification_ready', // ← Approval gate here
  DESIGN_PENDING: 'design_pending', // Waiting for UX designer
  DESIGN_READY: 'design_ready', // ← Approval gate here
  IMPLEMENTATION_PENDING: 'implementation_pending', // Waiting for frontend/backend
  BUILDING: 'building', // Active build in worker
  TESTING: 'testing', // Running test suite
  SECURITY_REVIEW: 'security_review', // QA/security scanning
  APPROVAL_PENDING: 'approval_pending', // ← Approval gate here
  RELEASE_READY: 'release_ready', // Ready for deployment
  DEPLOYED: 'deployed', // Successfully deployed
  FAILED: 'failed', // Unrecoverable failure
  CANCELLED: 'cancelled' // User cancelled
};

const BUILDER_MODES = [
  'product_analyst',
  'ux_designer',
  'frontend_engineer',
  'backend_engineer',
  'qa_security_reviewer',
  'release_engineer'
];

/**
 * Define standard job steps for a builder workflow
 * Each step maps to a builder mode
 * @returns {Array<Object>} Step definitions with ordering and dependencies
 */
function getDefaultJobSteps() {
  return [
    {
      step_id: 'product_analysis',
      ordinal_position: 1,
      builder_mode: 'product_analyst',
      blocked_dependencies: []
    },
    {
      step_id: 'ui_design',
      ordinal_position: 2,
      builder_mode: 'ux_designer',
      blocked_dependencies: ['product_analysis'] // Waits for spec ready
    },
    {
      step_id: 'frontend_implementation',
      ordinal_position: 3,
      builder_mode: 'frontend_engineer',
      blocked_dependencies: ['ui_design'] // Waits for design ready
    },
    {
      step_id: 'backend_implementation',
      ordinal_position: 4,
      builder_mode: 'backend_engineer',
      blocked_dependencies: ['product_analysis'] // Waits for spec
    },
    {
      step_id: 'test_suite',
      ordinal_position: 5,
      builder_mode: 'qa_security_reviewer',
      blocked_dependencies: ['frontend_implementation', 'backend_implementation']
    },
    {
      step_id: 'security_review',
      ordinal_position: 6,
      builder_mode: 'qa_security_reviewer',
      blocked_dependencies: ['test_suite']
    },
    {
      step_id: 'release_prep',
      ordinal_position: 7,
      builder_mode: 'release_engineer',
      blocked_dependencies: ['security_review']
    }
  ];
}

/**
 * Create a new builder job, linked to a task run
 * @param {Object} params - { organizationId, projectId, title, description, taskDescription, branchName, targetSha }
 * @returns {Object} { job, steps } normalized job and step definitions
 */
function createBuilderJob({
  organizationId,
  projectId,
  title,
  description,
  taskDescription,
  branchName,
  targetSha
}) {
  const defaultSteps = getDefaultJobSteps();

  const job = normalizeJob({
    organization_id: organizationId,
    project_id: projectId,
    title,
    description,
    task_description: taskDescription,
    status: JOB_LIFECYCLE.INTAKE,
    current_step_index: 0,
    total_steps: defaultSteps.length,
    branch_name: branchName,
    target_sha: targetSha,
    approval_required_at: ['specification_ready', 'design_ready', 'approval_pending']
  });

  if (!job) {
    throw new Error('Invalid job parameters');
  }

  const normalizedSteps = defaultSteps.map((step, idx) => normalizeJobStep(step, idx));

  return {
    job,
    steps: normalizedSteps
  };
}

/**
 * Get next step to execute (priority: retryable-failed > pending > blocked)
 * Respects dependencies: only returns step if all blocked_dependencies are completed
 * @param {Object} job - Normalized job
 * @param {Array<Object>} steps - Normalized step array
 * @returns {Object|null} Next step to execute, or null if all complete
 */
function getNextBuilderStep(job, steps) {
  const normalizedJob = normalizeJob(job);
  if (!normalizedJob || !Array.isArray(steps) || steps.length === 0) {
    return null;
  }

  // Enrich steps with dependency state
  const enrichedSteps = steps.map((step, index) => ({
    ...normalizeJobStep(step, index),
    index,
    dependenciesMet: checkDependenciesMet(step, steps)
  }));

  // Priority 1: Retryable-failed steps (resume failed attempt)
  const retryable = enrichedSteps.find(s =>
    s.status === 'failed' && s.retryable && s.dependenciesMet
  );
  if (retryable) return retryable;

  // Priority 2: Pending steps (first time execution)
  const pending = enrichedSteps.find(s =>
    s.status === 'pending' && s.dependenciesMet
  );
  if (pending) return pending;

  // Priority 3: Blocked steps (waiting for dependencies)
  // Don't return these; they stay blocked until dependencies complete

  return null;
}

/**
 * Check if all dependencies for a step are completed
 * @param {Object} step - Step with blocked_dependencies array
 * @param {Array<Object>} allSteps - All steps in job
 * @returns {boolean} True if all dependencies are completed
 */
function checkDependenciesMet(step, allSteps) {
  if (!step.blocked_dependencies || step.blocked_dependencies.length === 0) {
    return true;
  }

  const completed = allSteps
    .filter(s => s.status === 'completed')
    .map(s => s.step_id);

  return step.blocked_dependencies.every(dep => completed.includes(dep));
}

/**
 * Build job checkpoint for resumption (mirrors task-ledger.js pattern)
 * @param {Object} job - Normalized job
 * @param {Array<Object>} steps - Normalized step array
 * @returns {Object} Checkpoint with completed IDs, next step, blocked reason, progress state
 */
function buildJobCheckpoint(job, steps) {
  const normalizedJob = normalizeJob(job);
  if (!normalizedJob) {
    return {
      completed_step_ids: [],
      next_step_id: null,
      blocked_reason: null,
      progress_unverified: true,
      current_step_index: 0,
      total_steps: 0
    };
  }

  const completed = (steps || [])
    .filter(step => step && step.status === 'completed')
    .map(step => step.step_id || step.id || null)
    .filter(Boolean);

  const nextStep = getNextBuilderStep(normalizedJob, steps || []);
  const blockedStep = (steps || []).find(step => step && step.status === 'blocked');

  return {
    completed_step_ids: completed,
    next_step_id: nextStep ? nextStep.step_id : null,
    blocked_reason: blockedStep ? blockedStep.blocked_reason : null,
    progress_unverified: false,
    current_step_index: normalizedJob.current_step_index,
    total_steps: normalizedJob.total_steps,
    last_error: normalizedJob.last_error
  };
}

/**
 * Determine next job state based on step completion and approval gates
 * @param {string} currentStatus - Current job status
 * @param {string} completedStepId - Step that just completed
 * @param {Array<string>} approvalRequired - Steps requiring approval before progression
 * @returns {string} Next job status
 */
function getNextJobStatus(currentStatus, completedStepId, approvalRequired = []) {
  const STATUS_PROGRESSION = {
    [JOB_LIFECYCLE.INTAKE]: JOB_LIFECYCLE.ANALYSIS_PENDING,
    [JOB_LIFECYCLE.ANALYSIS_PENDING]: JOB_LIFECYCLE.SPECIFICATION_READY,
    [JOB_LIFECYCLE.SPECIFICATION_READY]: JOB_LIFECYCLE.DESIGN_PENDING,
    [JOB_LIFECYCLE.DESIGN_PENDING]: JOB_LIFECYCLE.DESIGN_READY,
    [JOB_LIFECYCLE.DESIGN_READY]: JOB_LIFECYCLE.IMPLEMENTATION_PENDING,
    [JOB_LIFECYCLE.IMPLEMENTATION_PENDING]: JOB_LIFECYCLE.BUILDING,
    [JOB_LIFECYCLE.BUILDING]: JOB_LIFECYCLE.TESTING,
    [JOB_LIFECYCLE.TESTING]: JOB_LIFECYCLE.SECURITY_REVIEW,
    [JOB_LIFECYCLE.SECURITY_REVIEW]: JOB_LIFECYCLE.APPROVAL_PENDING
  };

  const nextStatus = STATUS_PROGRESSION[currentStatus];
  if (!nextStatus) return currentStatus;

  // If next status requires approval, return APPROVAL_PENDING instead
  if (approvalRequired.includes(nextStatus)) {
    return JOB_LIFECYCLE.APPROVAL_PENDING;
  }

  return nextStatus;
}

/**
 * Classify evidence from a builder step (similar to evidence-sanitizer.js)
 * @param {Object} toolResult - Result from builder mode execution
 * @param {string} builderMode - Which builder mode produced this
 * @returns {Array<Object>} Array of sanitized evidence refs
 */
function sanitizeBuilderEvidence(toolResult, builderMode) {
  if (!toolResult) return [];

  const evidence = [];

  // Extract relevant evidence based on builder mode
  if (builderMode === 'product_analyst') {
    // Product spec: keep requirements, user stories, acceptance criteria (no content, just structure)
    if (toolResult.specification_outline) {
      evidence.push({
        type: 'specification_outline',
        section_count: (toolResult.specification_outline.sections || []).length,
        status: toolResult.status || 'found'
      });
    }
  } else if (builderMode === 'ux_designer') {
    // UI plan: keep component count, routes, design decisions (no actual design)
    if (toolResult.component_inventory) {
      evidence.push({
        type: 'component_inventory',
        component_count: Array.isArray(toolResult.component_inventory) ? toolResult.component_inventory.length : 0,
        status: toolResult.status || 'found'
      });
    }
    if (toolResult.routes) {
      evidence.push({
        type: 'route_map',
        route_count: Array.isArray(toolResult.routes) ? toolResult.routes.length : 0
      });
    }
  } else if (builderMode === 'frontend_engineer' || builderMode === 'backend_engineer') {
    // Code: keep file paths and commit SHAs (no actual code)
    if (toolResult.changed_files) {
      evidence.push({
        type: 'file_paths',
        file_count: Array.isArray(toolResult.changed_files) ? toolResult.changed_files.length : 0,
        files: (toolResult.changed_files || []).map(f => typeof f === 'string' ? f : f.path).filter(Boolean)
      });
    }
    if (toolResult.commit_sha) {
      evidence.push({
        type: 'commit_reference',
        sha: toolResult.commit_sha.substring(0, 12)
      });
    }
  } else if (builderMode === 'qa_security_reviewer') {
    // Tests/security: keep pass/fail counts, vulnerability counts (no actual output)
    if (toolResult.test_results) {
      evidence.push({
        type: 'test_results',
        passed: toolResult.test_results.passed || 0,
        failed: toolResult.test_results.failed || 0,
        skipped: toolResult.test_results.skipped || 0,
        status: toolResult.test_results.failed > 0 ? 'failed' : 'passed'
      });
    }
    if (toolResult.security_findings) {
      evidence.push({
        type: 'security_findings',
        critical: toolResult.security_findings.critical || 0,
        high: toolResult.security_findings.high || 0,
        medium: toolResult.security_findings.medium || 0,
        status: (toolResult.security_findings.critical || 0) > 0 ? 'critical' : 'reviewed'
      });
    }
  }

  return evidence;
}

export {
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
};

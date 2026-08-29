-- Builder Job System Schema
-- Enables multi-step agentic AI work with task continuity, approval gates, and audit trails
-- Wires to bob_task_runs/bob_task_steps for resumable orchestration
-- Follows Build-Plan.md doctrinal requirements:
--   - Parent before child (org scoped, no orphans)
--   - Live schema is authority
--   - Provenance travels with record
--   - Immutable audit trail
--   - Human approval for consequential changes

-- ============================================================================
-- BUILDER PROJECTS
-- ============================================================================
-- Workspace/repository context for builder jobs
-- Links to Gitea repository, organization, and access control
CREATE TABLE IF NOT EXISTS public.builder_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Repository identity and location
  gitea_owner TEXT NOT NULL,
  gitea_repo TEXT NOT NULL,
  gitea_repo_id BIGINT,
  gitea_clone_url TEXT,

  -- Project metadata
  name TEXT NOT NULL,
  description TEXT,

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'suspended')),

  -- Audit trail
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT builder_projects_unique_repo_per_org UNIQUE (organization_id, gitea_owner, gitea_repo)
);

CREATE INDEX idx_builder_projects_org ON public.builder_projects(organization_id);
CREATE INDEX idx_builder_projects_status ON public.builder_projects(status);

-- ============================================================================
-- BUILDER JOBS
-- ============================================================================
-- Top-level job container, state machine for entire workflow
-- Holds orchestration state, links to task continuity via task_run_id
CREATE TABLE IF NOT EXISTS public.builder_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.builder_projects(id) ON DELETE CASCADE,

  -- Task continuity integration: wires to bob_task_runs
  task_run_id UUID REFERENCES public.bob_task_runs(id) ON DELETE SET NULL,

  -- Job identity and spec
  title TEXT NOT NULL,
  description TEXT,
  task_description TEXT, -- User-provided goal for builders

  -- Workflow state machine (from Build-Plan.md job lifecycle)
  status TEXT NOT NULL DEFAULT 'intake' CHECK (
    status IN (
      'intake',
      'analysis_pending',
      'specification_ready',
      'design_pending',
      'implementation_pending',
      'building',
      'testing',
      'security_review',
      'approval_pending',
      'release_ready',
      'deployed',
      'failed',
      'cancelled'
    )
  ),

  -- Current work context
  current_step_name TEXT, -- e.g., 'product_analysis', 'ui_design', 'frontend_build'
  current_step_index INT DEFAULT 0,
  total_steps INT DEFAULT 0,

  -- Repository branch/commit context
  branch_name TEXT,
  target_sha TEXT,

  -- Controlled approvals
  approval_required_at TEXT[], -- JSON array of states requiring approval: ['specification_ready', 'approval_pending']

  -- Error tracking (non-fatal, allows fail-closed recovery)
  last_error TEXT,
  error_count INT DEFAULT 0,

  -- Audit trail
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT builder_jobs_unique_task_per_project UNIQUE (project_id, task_run_id)
);

CREATE INDEX idx_builder_jobs_org ON public.builder_jobs(organization_id);
CREATE INDEX idx_builder_jobs_project ON public.builder_jobs(project_id);
CREATE INDEX idx_builder_jobs_status ON public.builder_jobs(status);
CREATE INDEX idx_builder_jobs_task_run ON public.builder_jobs(task_run_id);
CREATE INDEX idx_builder_jobs_created_by ON public.builder_jobs(created_by);

-- ============================================================================
-- BUILDER JOB STEPS
-- ============================================================================
-- Orchestrated steps within a job (tied to task continuity)
-- Each step is a builder mode (Product Analyst, UX Designer, Frontend, QA, Release)
-- Step state mirrors bob_task_steps: pending → running → completed|failed|blocked
CREATE TABLE IF NOT EXISTS public.builder_job_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.builder_jobs(id) ON DELETE CASCADE,

  -- Step identity and ordering
  step_id TEXT NOT NULL, -- e.g., 'product_analysis', 'ui_design', 'frontend_build', 'test_run', 'security_review', 'release_prep'
  ordinal_position INT NOT NULL,

  -- Builder mode and model config
  builder_mode TEXT NOT NULL CHECK (
    builder_mode IN (
      'product_analyst',
      'ux_designer',
      'frontend_engineer',
      'backend_engineer',
      'qa_security_reviewer',
      'release_engineer'
    )
  ),
  model_provider TEXT, -- 'openai' or 'ollama'
  model_name TEXT, -- 'gpt-4o', 'gpt-4', 'mistral', etc.

  -- Step state (mirrors bob_task_steps)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped')
  ),

  -- Execution tracking
  attempt_count INT DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Step inputs and outputs
  input_context JSONB, -- Artifact references, prior step results, requirements
  result_summary TEXT, -- Brief summary of what step produced

  -- Evidence and artifacts (sanitized, no secrets)
  evidence_refs JSONB DEFAULT '[]', -- Array of {type, ...fields}
  artifact_ids UUID[], -- Links to builder_artifacts created by this step

  -- Error and retry tracking
  error TEXT,
  retryable BOOLEAN DEFAULT false,

  -- Blocking logic (if blocked, why and waiting for what)
  blocked_reason TEXT, -- e.g., "Waiting for specification_ready approval"
  blocked_dependencies TEXT[], -- Step IDs this step depends on

  -- Audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT builder_job_steps_unique_per_job UNIQUE (job_id, step_id)
);

CREATE INDEX idx_builder_job_steps_job ON public.builder_job_steps(job_id);
CREATE INDEX idx_builder_job_steps_status ON public.builder_job_steps(status);
CREATE INDEX idx_builder_job_steps_model_provider ON public.builder_job_steps(model_provider);

-- ============================================================================
-- BUILDER ARTIFACTS
-- ============================================================================
-- Immutable outputs produced by job steps
-- Examples: product spec, UI plan, code diff, test report, security review, release notes
CREATE TABLE IF NOT EXISTS public.builder_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.builder_jobs(id) ON DELETE CASCADE,
  step_id UUID REFERENCES public.builder_job_steps(id) ON DELETE SET NULL, -- Which step produced this

  -- Artifact identity and type
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN (
      'product_specification',
      'ui_design_plan',
      'component_inventory',
      'code_implementation',
      'test_results',
      'test_coverage_report',
      'security_review',
      'dependency_analysis',
      'build_logs',
      'deployment_manifest',
      'rollback_plan',
      'release_notes',
      'screenshots',
      'design_tokens',
      'accessibility_report'
    )
  ),

  -- Content storage strategy
  content_type TEXT, -- 'text/markdown', 'application/json', 'text/html', etc.
  content_size_bytes INT,
  storage_location TEXT, -- 's3://bucket/path', 'supabase_storage://bucket/path', 'database'
  content_preview TEXT, -- First 500 chars for quick inspection

  -- Artifact validation and provenance
  checksum TEXT, -- SHA256 of content for integrity verification
  produced_by_model TEXT, -- 'openai', 'ollama', 'human_input'
  produced_by_user UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- If human-edited

  -- Artifact status and versioning
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'superseded', 'archived')),
  version_number INT DEFAULT 1,

  -- Audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_builder_artifacts_job ON public.builder_artifacts(job_id);
CREATE INDEX idx_builder_artifacts_step ON public.builder_artifacts(step_id);
CREATE INDEX idx_builder_artifacts_type ON public.builder_artifacts(artifact_type);
CREATE INDEX idx_builder_artifacts_status ON public.builder_artifacts(status);

-- ============================================================================
-- BUILDER APPROVALS
-- ============================================================================
-- Approval gates for state transitions (mandatory per Build-Plan.md)
-- Handles: spec review, design review, implementation review, security review, release approval
CREATE TABLE IF NOT EXISTS public.builder_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.builder_jobs(id) ON DELETE CASCADE,

  -- Approval context
  approval_type TEXT NOT NULL CHECK (
    approval_type IN (
      'specification_review',
      'design_review',
      'implementation_review',
      'security_review',
      'release_approval'
    )
  ),

  -- State transition trigger (when we enter approval_pending)
  triggered_at_status TEXT NOT NULL, -- e.g., 'specification_ready', 'testing'

  -- Approval tracking
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),

  -- Approver identity
  requested_from_users UUID[], -- User IDs who can approve (role-based later)
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Context for decision
  approval_comment TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,

  -- Audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_builder_approvals_job ON public.builder_approvals(job_id);
CREATE INDEX idx_builder_approvals_status ON public.builder_approvals(status);
CREATE INDEX idx_builder_approvals_approved_by ON public.builder_approvals(approved_by);

-- ============================================================================
-- BUILDER AUDIT EVENTS
-- ============================================================================
-- Immutable log of every decision, transition, and approval
-- Enables compliance traceability and decision reconstruction
CREATE TABLE IF NOT EXISTS public.builder_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES public.builder_jobs(id) ON DELETE CASCADE,

  -- Event identity
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'job_created',
      'job_status_changed',
      'step_started',
      'step_completed',
      'step_failed',
      'step_blocked',
      'artifact_created',
      'approval_requested',
      'approval_approved',
      'approval_rejected',
      'model_run_started',
      'model_run_completed',
      'model_run_failed',
      'error_recorded',
      'job_cancelled'
    )
  ),

  -- Actor identity
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- Who triggered this
  actor_type TEXT, -- 'user', 'bot', 'builder_mode'

  -- Event context
  previous_value JSONB, -- For state changes, the old state
  new_value JSONB, -- For state changes, the new state
  change_summary TEXT, -- Human-readable description

  -- Additional context
  related_artifact_ids UUID[], -- Artifacts involved
  related_approval_id UUID REFERENCES public.builder_approvals(id) ON DELETE SET NULL,

  -- Audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_builder_audit_events_job ON public.builder_audit_events(job_id);
CREATE INDEX idx_builder_audit_events_event_type ON public.builder_audit_events(event_type);
CREATE INDEX idx_builder_audit_events_actor ON public.builder_audit_events(actor_user_id);
CREATE INDEX idx_builder_audit_events_created_at ON public.builder_audit_events(created_at);

-- ============================================================================
-- BUILDER PROTECTED VARIABLES
-- ============================================================================
-- Allowlist of environment variables that can be passed to isolated workers
-- Prevents credential leakage; requires explicit approval to add new ones
CREATE TABLE IF NOT EXISTS public.builder_protected_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Variable identity
  variable_name TEXT NOT NULL, -- e.g., 'NPM_REGISTRY_TOKEN', 'DOCKER_BUILD_TIMEOUT'
  variable_category TEXT NOT NULL CHECK (
    variable_category IN (
      'build_tool',
      'registry',
      'ci_cd',
      'testing',
      'security_scanner',
      'model_config',
      'other'
    )
  ),

  -- Variable security
  value_is_secret BOOLEAN NOT NULL DEFAULT false, -- If true, value is encrypted and never logged
  allowed_in_modes TEXT[] NOT NULL, -- Which builder modes can access this

  -- Approval gating
  requires_approval BOOLEAN DEFAULT true,
  approval_status TEXT DEFAULT 'pending_approval' CHECK (
    approval_status IN ('pending_approval', 'approved', 'revoked')
  ),

  -- Documentation
  description TEXT,
  default_value TEXT, -- If not secret, can have a default

  -- Audit trail
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_builder_protected_variables_org ON public.builder_protected_variables(organization_id);
CREATE INDEX idx_builder_protected_variables_approval_status ON public.builder_protected_variables(approval_status);

-- ============================================================================
-- BUILDER WORKER RUNS
-- ============================================================================
-- Execution log for isolated worker invocations
-- Tracks: command, arguments, timeout, exit code, resource usage, secret redaction
CREATE TABLE IF NOT EXISTS public.builder_worker_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.builder_jobs(id) ON DELETE CASCADE,
  step_id UUID REFERENCES public.builder_job_steps(id) ON DELETE SET NULL,

  -- Worker execution context
  worker_container_id TEXT, -- Docker container ID or Pod ID
  worker_isolation_level TEXT NOT NULL DEFAULT 'container' CHECK (
    worker_isolation_level IN ('container', 'vm', 'sandbox')
  ),

  -- Command and environment
  command TEXT NOT NULL, -- Full command line (sanitized of secrets)
  command_args TEXT[], -- Argument array
  environment_variables_snapshot JSONB, -- Encrypted snapshot of env vars passed

  -- Execution tracking
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'timeout', 'failed', 'cancelled')
  ),

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  timeout_seconds INT DEFAULT 3600,

  -- Exit code and output
  exit_code INT,
  stdout_location TEXT, -- Where logs are stored (s3, supabase, etc.)
  stderr_location TEXT,
  log_summary TEXT, -- First 1000 chars

  -- Resource usage
  cpu_peak_percent NUMERIC,
  memory_peak_mb NUMERIC,
  disk_usage_mb NUMERIC,

  -- Safety checks
  secrets_redacted_count INT DEFAULT 0,
  dangerous_patterns_detected TEXT[], -- e.g., ['rm -rf /', 'credential']

  -- Artifact outputs
  output_artifact_ids UUID[],

  -- Audit trail
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_builder_worker_runs_job ON public.builder_worker_runs(job_id);
CREATE INDEX idx_builder_worker_runs_step ON public.builder_worker_runs(step_id);
CREATE INDEX idx_builder_worker_runs_status ON public.builder_worker_runs(status);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- All builder entities are organization-scoped
-- Service role (Bob) can read/write; other roles are restricted

ALTER TABLE public.builder_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_protected_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.builder_worker_runs ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (bot/orchestrator access)
CREATE POLICY builder_projects_service_role ON public.builder_projects
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_jobs_service_role ON public.builder_jobs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_job_steps_service_role ON public.builder_job_steps
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_artifacts_service_role ON public.builder_artifacts
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_approvals_service_role ON public.builder_approvals
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_audit_events_service_role ON public.builder_audit_events
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_protected_variables_service_role ON public.builder_protected_variables
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY builder_worker_runs_service_role ON public.builder_worker_runs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Future: Organization members can view (not edit) their org's jobs
-- (Role-based access control will be implemented in application layer)

COMMIT;

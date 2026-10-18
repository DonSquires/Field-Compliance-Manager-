import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';
import { modelFailure, inferenceUsage, modelReceiptKind } from '../_shared/builder-run-telemetry.ts';

const FUNCTION_NAME = 'bob-builder-control-room';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CONTROL_PLANE_URL = Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '';
const CONTROL_PLANE_TOKEN = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN') ?? '';
const CAN_BUILD = new Set(['grand_master', 'master']);
const ARTIFACT_PREVIEW_LIMIT_BYTES = 256 * 1024;
const ARTIFACT_PREVIEW_TYPES = new Set(['application/json', 'text/markdown', 'text/plain', 'text/x-diff']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function strings(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, maximum);
}

function safeJob(job: Record<string, unknown> | null) {
  if (!job) return null;
  const keys = ['id', 'organization_id', 'project_id', 'title', 'description', 'task_description', 'status', 'current_step_name', 'current_step_index', 'total_steps', 'branch_name', 'target_sha', 'workspace_branch', 'workspace_head_sha', 'workspace_published_at', 'workspace_published_head_sha', 'workspace_pull_request_url', 'workspace_pull_request_head_sha', 'requested_action', 'target_environment', 'frontend_required', 'backend_required', 'code_review_mode', 'code_review_status', 'last_error', 'autopilot_requested_by', 'autopilot_state', 'autopilot_report', 'autopilot_updated_at', 'autopilot_reported_at', 'created_at', 'updated_at'];
  return Object.fromEntries(keys.map(key => [key, job[key]]));
}

const LIVE_MODEL_RUN_LIMIT = 12;
const LIVE_EVENT_LIMIT = 30;
const CHANGED_FILE_LIMIT = 200;

function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

// Local runners record input/output tokens; OpenAI-compatible runs record prompt/completion tokens.
function modelUsage(value: unknown) {
  const usage = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const input = count(usage.input_tokens) ?? count(usage.prompt_tokens);
  const output = count(usage.output_tokens) ?? count(usage.completion_tokens);
  const total = count(usage.total_tokens) ?? (input == null && output == null ? null : (input ?? 0) + (output ?? 0));
  return {
    input_tokens: input, output_tokens: output, total_tokens: total,
    turns: count(usage.turns) ?? count(usage.turn), phase: typeof usage.phase === 'string' ? usage.phase.slice(0, 40) : null,
    ...inferenceUsage(usage),
  };
}

function eventDetail(value: unknown) {
  const detail = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (input: unknown) => typeof input === 'string' ? input.slice(0, 120) : null;
  return {
    step: text(detail.step), step_status: text(detail.step_status), status: text(detail.status),
    artifact_type: text(detail.artifact_type), outcome: text(detail.outcome),
    retryable: typeof detail.retryable === 'boolean' ? detail.retryable : null,
    failed_files: strings(detail.failed_files, 20),
  };
}

function safeSnapshot(value: Record<string, unknown>) {
  const rows = (input: unknown) => Array.isArray(input) ? input as Array<Record<string, unknown>> : [];
  return {
    job: safeJob(value.job as Record<string, unknown> | null),
    steps: rows(value.steps).map(step => ({
      id: step.id, step_id: step.step_id, ordinal_position: step.ordinal_position,
      builder_mode: step.builder_mode, status: step.status, attempt_count: step.attempt_count,
      result_summary: step.result_summary, error: step.error, retryable: step.retryable,
      started_at: step.started_at, completed_at: step.completed_at,
    })),
    artifacts: rows(value.artifacts).map(artifact => ({
      id: artifact.id, step_id: artifact.step_id, artifact_type: artifact.artifact_type,
      status: artifact.status, checksum: artifact.checksum, content_type: artifact.content_type,
      content_size_bytes: artifact.content_size_bytes, created_at: artifact.created_at,
    })),
    workerRuns: rows(value.workerRuns).map(run => ({
      id: run.id, step_id: run.step_id, profile: run.profile, status: run.status,
      target_sha: run.target_sha, exit_code: run.exit_code, started_at: run.started_at,
      completed_at: run.completed_at, heartbeat_at: run.heartbeat_at,
    })),
    modelRuns: rows(value.modelRuns).map(run => ({
      id: run.id, step_id: run.step_id, provider: run.provider, model_name: run.model_name,
      status: run.status, started_at: run.started_at, completed_at: run.completed_at,
      failure_kind: modelFailure(run),
      receipt_kind: modelReceiptKind(run),
      created_at: run.created_at, updated_at: run.updated_at,
      ...modelUsage(modelReceiptKind(run) === 'artifact' ? null : run.usage_metadata),
    })),
    events: rows(value.events).map(event => ({
      id: event.id, event_type: event.event_type, actor_type: event.actor_type,
      change_summary: typeof event.change_summary === 'string' ? event.change_summary.slice(0, 280) : null,
      detail: eventDetail(event.new_value), created_at: event.created_at,
    })),
    approvals: rows(value.approvals).map(approval => ({
      id: approval.id, approval_type: approval.approval_type, triggered_at_status: approval.triggered_at_status,
      status: approval.status, requested_at: approval.requested_at, requested_target_sha: approval.requested_target_sha,
      reviewed_artifact_ids: approval.reviewed_artifact_ids, approval_comment: approval.approval_comment, responded_at: approval.responded_at,
    })),
  };
}

async function relay(path: string, method: 'GET' | 'POST', body?: unknown) {
  const response = await fetch(`${CONTROL_PLANE_URL.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${CONTROL_PLANE_TOKEN}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  return { ok: response.ok, status: response.status, payload };
}

// Callers here already hold a Builder role; a short, bounded reason turns a dead-end 409 into
// something the operator (or Bob's self-heal loop) can act on. Never the raw payload.
function failureDetail(source: unknown): string | undefined {
  const candidate = source && typeof source === 'object'
    ? (source as Record<string, unknown>).detail ?? (source as Record<string, unknown>).message ?? (source as Record<string, unknown>).error
    : source;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 300) : undefined;
}

serve(async req => {
  let stage = 'request';
  try {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Builder control room is unavailable' }, 503);
  }
  stage = 'authenticate';
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authError } = await callerClient.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  stage = 'load_profile';
  const { data: profile, error: profileError } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids, email').eq('id', user.id).single();
  if (profileError || !profile) return json({ error: 'Builder identity could not be loaded' }, 503);
  const role = resolveEffectiveRole(user.email ?? profile?.email, profile?.role);
  if (!profile || !CAN_BUILD.has(role)) return json({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === 'string' ? body.action : '';
  const requestedOrgId = typeof body.organization_id === 'string' ? body.organization_id : null;
  const allowedOrganizations = new Set([profile.organization_id, ...strings(profile.authorized_organization_ids, 200)].filter(Boolean));
  const canAccessOrganization = (organizationId: string | null) => role === 'grand_master' || Boolean(organizationId && allowedOrganizations.has(organizationId));

  const audit = async (organizationId: string | null, result: string, jobId: string | null = null) => {
    try {
      await admin.from('audit_log').insert({
        organization_id: organizationId,
        user_id: user.id,
        action: FUNCTION_NAME,
        entity_type: 'builder_job',
        entity_id: jobId,
        change_summary: JSON.stringify({ action, result }),
      });
    } catch {}
  };

  // Bob autopilot: the caller's instruction is the key turn. Binding records that person so the control
  // plane can drive the job to its gates on their behalf (recorded); merge and deployment stay human.
  const bindAutopilot = async (jobId: string, organizationId: string | null) => {
    const conversationId = typeof body.conversation_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.conversation_id) ? body.conversation_id : null;
    const { data: bound, error: bindError } = await admin.rpc('builder_autopilot_bind', { _job_id: jobId, _requested_by: user.id, _conversation_id: conversationId });
    await audit(organizationId, bindError ? 'autopilot_bind_failed' : 'autopilot_bound', jobId);
    return bindError ? { job: null, error: failureDetail(bindError) ?? 'Bob could not take this job' } : { job: bound as Record<string, unknown>, error: null };
  };

  if (action === 'refresh_atlas') {
    if (role !== 'grand_master') return json({ error: 'Atlas refresh is restricted to grand master' }, 403);
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay('/api/bob/builder/atlas/refresh', 'POST');
    await audit(profile.organization_id, result.ok ? 'atlas_refreshed' : 'atlas_refresh_failed');
    if (!result.ok) return json({ error: 'Atlas refresh failed' }, result.status);
    return json({ atlas_refresh: result.payload });
  }

  if (action === 'human_test_start' || action === 'human_test_status') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const mode = body.mode === 'suite' ? 'suite' : body.mode === 'live' ? 'live' : 'fixture';
    if ((mode === 'live' || mode === 'suite') && role !== 'grand_master') return json({ error: 'Live human testing is restricted to grand master' }, 403);
    const expectedSha = typeof body.expected_sha === 'string' && /^[a-f0-9]{40}$/i.test(body.expected_sha.trim())
      ? body.expected_sha.trim().toLowerCase()
      : null;
    const targetRoute = typeof body.target_route === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(body.target_route.trim())
      ? body.target_route.trim()
      : null;
    const runId = typeof body.run_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.run_id) ? body.run_id : null;
    const result = action === 'human_test_start'
      ? await relay('/api/bob/human-tests', 'POST', {
          mode,
          scope: 'full',
          requested_by: user.id,
          ...(expectedSha ? { expected_sha: expectedSha } : {}),
          ...(targetRoute ? { target_route: targetRoute } : {}),
        })
      : await relay(runId ? `/api/bob/human-tests/${runId}` : '/api/bob/human-tests/latest', 'GET');
    const run = result.payload.run && typeof result.payload.run === 'object'
      ? result.payload.run as Record<string, unknown>
      : null;
    await audit(profile.organization_id, result.ok ? action : `${action}_failed`, runId);
    if (!result.ok || !run) return json({ error: failureDetail(result.payload) ?? 'Human-test run is unavailable' }, result.status);
    return json({ run, existing: result.payload.existing === true }, result.status);
  }

  // Bob's terminal on the owner's laptop (owner instruction 2026-09-26). Grand master only: the laptop
  // is the owner's personal machine, reached over Tailscale, and switched on/off by the owner. The
  // command has already been shown to and confirmed by the owner in chat; the control plane applies
  // its own deny list and records the command's head and hash (never the output).
  if (action === 'laptop_status' || action === 'laptop_run') {
    if (role !== 'grand_master') return json({ error: 'The laptop terminal is restricted to the platform owner' }, 403);
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    if (action === 'laptop_status') {
      const result = await relay('/api/bob/laptop/status', 'GET');
      await audit(profile.organization_id, result.ok ? 'laptop_status' : 'laptop_status_failed');
      return json({ laptop: result.payload }, result.ok ? 200 : result.status);
    }
    const command = typeof body.command === 'string' ? body.command.slice(0, 4000) : '';
    const purpose = typeof body.purpose === 'string' ? body.purpose.slice(0, 300) : '';
    if (!command.trim()) return json({ error: 'A command is required' }, 400);
    const result = await relay('/api/bob/laptop/run', 'POST', {
      command,
      purpose,
      timeout_ms: Number.isFinite(Number(body.timeout_ms)) ? Number(body.timeout_ms) : undefined,
      requested_by: user.id,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id.slice(0, 64) : null,
    });
    await audit(profile.organization_id, result.ok ? 'laptop_command_ran' : `laptop_command_${result.status}`);
    return json({ run: result.payload }, result.ok ? 200 : result.status);
  }

  if (action === 'list') {
    stage = 'list_builder_state';
    const organizations = role === 'grand_master' ? null : [...allowedOrganizations];
    let projectsQuery = admin.from('builder_projects').select('id, organization_id, gitea_owner, gitea_repo, name, status').eq('status', 'active').order('name');
    let jobsQuery = admin.from('builder_jobs').select('id, organization_id, project_id, title, status, current_step_name, target_sha, frontend_required, backend_required, code_review_mode, code_review_status, last_error, autopilot_requested_by, autopilot_state, created_at, updated_at').order('created_at', { ascending: false }).limit(100);
    if (organizations) {
      projectsQuery = projectsQuery.in('organization_id', organizations);
      jobsQuery = jobsQuery.in('organization_id', organizations);
    }
    const [projects, jobs] = await Promise.all([projectsQuery, jobsQuery]);
    const failed = Boolean(projects.error || jobs.error);
    await audit(profile.organization_id, failed ? 'failed' : 'listed');
    if (failed) return json({ error: 'Builder activity could not be loaded' }, 503);
    return json({ projects: projects.data ?? [], jobs: (jobs.data ?? []).map(job => safeJob(job)) });
  }

  if (action === 'create') {
    stage = 'create_builder_job';
    if (!canAccessOrganization(requestedOrgId)) return json({ error: 'Organization access denied' }, 403);
    const projectId = typeof body.project_id === 'string' ? body.project_id : '';
    const requestedAction = typeof body.requested_action === 'string' ? body.requested_action : '';
    const targetEnvironment = typeof body.target_environment === 'string' ? body.target_environment : '';
    const codeReviewMode = typeof body.code_review_mode === 'string' ? body.code_review_mode : 'none';
    if (!['prepare_change', 'prepare_release'].includes(requestedAction)) return json({ error: 'Select a supported Builder action' }, 400);
    if (!['development', 'staging', 'production'].includes(targetEnvironment)) return json({ error: 'Select a supported target environment' }, 400);
    if (targetEnvironment === 'production' && requestedAction !== 'prepare_release') return json({ error: 'Production jobs must prepare a release' }, 400);
    if (targetEnvironment === 'production' && codeReviewMode !== 'human') return json({ error: 'Production jobs require human code review' }, 400);
    const { data: project } = await admin.from('builder_projects').select('id, organization_id, gitea_owner, gitea_repo').eq('id', projectId).eq('organization_id', requestedOrgId).eq('status', 'active').single();
    if (!project) return json({ error: 'Builder project is unavailable' }, 404);
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
    const taskDescription = typeof body.task_description === 'string' ? body.task_description.slice(0, 12000) : '';
    // Idempotent create: an autonomous owner request already being driven wins even when a later
    // research pass enriches its brief. Manual submissions retain the narrower exact-brief window.
    const duplicateSince = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let duplicateQuery = admin.from('builder_jobs')
      .select('*')
      .eq('organization_id', requestedOrgId)
      .eq('project_id', projectId)
      .eq('title', title)
      .not('status', 'in', '("release_ready","deployed","failed","cancelled")');
    if (body.autopilot === true) {
      duplicateQuery = duplicateQuery
        .eq('autopilot_requested_by', user.id)
        .in('autopilot_state', ['driving', 'awaiting_human']);
    } else {
      duplicateQuery = duplicateQuery.eq('task_description', taskDescription).gte('created_at', duplicateSince);
    }
    const { data: duplicate } = await duplicateQuery.order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (duplicate) {
      await audit(requestedOrgId, 'duplicate_returned', String(duplicate.id));
      return json({ job: safeJob(duplicate as Record<string, unknown>), duplicate: true, autopilot: Boolean((duplicate as Record<string, unknown>).autopilot_requested_by) }, 200);
    }
    // Bob's self-heal path names a ref (usually main); pin it to the live head so the job is commit-pinned.
    let targetSha = typeof body.target_sha === 'string' ? body.target_sha : '';
    if (!/^[a-f0-9]{40}$/i.test(targetSha)) {
      const targetRef = typeof body.target_ref === 'string' && /^[A-Za-z0-9_./-]{1,120}$/.test(body.target_ref) ? body.target_ref : 'main';
      if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
      const head = await relay(`/api/bob/builder/repository/head?ref=${encodeURIComponent(targetRef)}`, 'GET');
      targetSha = head.ok && typeof head.payload.sha === 'string' ? head.payload.sha : '';
      if (!/^[a-f0-9]{40}$/i.test(targetSha)) return json({ error: 'Builder target commit could not be resolved' }, 503);
    }
    const { data: created, error: createError } = await admin.rpc('builder_create_job_v2', {
      _organization_id: requestedOrgId,
      _project_id: projectId,
      _title: title,
      _task_description: taskDescription,
      _target_sha: targetSha,
      _branch_name: typeof body.branch_name === 'string' ? body.branch_name.slice(0, 200) : 'main',
      _description: typeof body.description === 'string' ? body.description.slice(0, 2000) : null,
      _frontend_required: body.frontend_required !== false,
      _backend_required: body.backend_required === true,
      _code_review_mode: codeReviewMode,
      _task_run_id: null,
      _requested_action: requestedAction,
      _target_environment: targetEnvironment,
    });
    await audit(requestedOrgId, createError ? 'failed' : 'created', String(created?.id ?? '') || null);
    if (createError) return json({ error: 'Builder job could not be created', detail: failureDetail(createError) }, 409);
    let job = created as Record<string, unknown>;
    // Bob autopilot: the caller's chat instruction is the key turn. Bind the job to that person so the
    // control plane can clear its gates on their behalf (recorded), publish the branch, open the PR and
    // leave a plain-language report. Merge and deployment stay human (BOB_DOCTRINE §9).
    if (body.autopilot === true) {
      const bound = await bindAutopilot(String(job.id), requestedOrgId);
      if (!bound.job) return json({ job: safeJob(job), autopilot: false, autopilot_error: bound.error }, 201);
      job = bound.job;
    }
    return json({ job: safeJob(job), autopilot: body.autopilot === true }, 201);
  }

  const jobId = typeof body.job_id === 'string' ? body.job_id : '';
  stage = 'load_builder_job';
  const { data: job } = await admin.from('builder_jobs').select('id, organization_id').eq('id', jobId).single();
  if (!job || !canAccessOrganization(job.organization_id)) return json({ error: 'Builder job is unavailable' }, 404);

  if (action === 'context_snapshot') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ context: null, unavailable: true, error: 'Builder execution host is unavailable' });
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/context`, 'GET');
    await audit(job.organization_id, result.ok ? 'context_viewed' : 'context_failed', jobId);
    if (!result.ok) return json({ context: null, unavailable: true, error: 'Builder context is unavailable', status: result.status });
    return json({ context: result.payload });
  }

  if (action === 'get') {
    stage = 'load_builder_snapshot';
    const [jobResult, stepsResult, artifactsResult, runsResult, approvalsResult, modelRunsResult, eventsResult] = await Promise.all([
      admin.from('builder_jobs').select('*').eq('id', jobId).single(),
      admin.from('builder_job_steps').select('*').eq('job_id', jobId).order('ordinal_position'),
      admin.from('builder_artifacts').select('*').eq('job_id', jobId).order('created_at'),
      admin.from('builder_worker_runs').select('*').eq('job_id', jobId).order('started_at'),
      admin.from('builder_approvals').select('id, approval_type, triggered_at_status, status, requested_at, requested_target_sha, reviewed_artifact_ids, approval_comment, responded_at').eq('job_id', jobId).order('requested_at', { ascending: false }),
      admin.from('builder_model_runs').select('id, step_id, provider, model_name, status, error, usage_metadata, prompt_version, idempotency_key, started_at, completed_at, created_at, updated_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(LIVE_MODEL_RUN_LIMIT),
      admin.from('builder_audit_events').select('id, event_type, actor_type, change_summary, new_value, created_at').eq('job_id', jobId).order('created_at', { ascending: false }).limit(LIVE_EVENT_LIMIT),
    ]);
    const failed = jobResult.error || stepsResult.error || artifactsResult.error || runsResult.error || approvalsResult.error;
    // Live polls refresh an already-audited view; only their failures are written to audit_log.
    if (body.live_poll !== true || failed) await audit(job.organization_id, failed ? 'failed' : 'viewed', jobId);
    if (failed) return json({ error: 'Builder job could not be loaded' }, 503);
    return json({
      ...safeSnapshot({ job: jobResult.data, steps: stepsResult.data, artifacts: artifactsResult.data, workerRuns: runsResult.data, approvals: approvalsResult.data, modelRuns: modelRunsResult.data, events: eventsResult.data }),
      telemetry: { model_runs_available: !modelRunsResult.error, events_available: !eventsResult.error, observed_at: new Date().toISOString() },
    });
  }
  if (action === 'changed_files') {
    stage = 'load_changed_files';
    const { data: manifest, error: manifestError } = await admin
      .from('builder_artifacts')
      .select('id, content_size_bytes, storage_location, checksum, created_at')
      .eq('job_id', jobId)
      .eq('artifact_type', 'changed_file_manifest')
      .eq('status', 'final')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (manifestError) return json({ error: 'Changed files could not be loaded' }, 503);
    if (!manifest) return json({ manifest: null, files: [] });
    if (!manifest.storage_location?.startsWith('supabase_storage://builder-artifacts/') || (manifest.content_size_bytes ?? 0) > ARTIFACT_PREVIEW_LIMIT_BYTES) {
      return json({ error: 'Changed-file manifest cannot be read in the workspace' }, 409);
    }
    const objectPath = manifest.storage_location.slice('supabase_storage://builder-artifacts/'.length);
    const { data: object, error: downloadError } = await admin.storage.from('builder-artifacts').download(objectPath);
    if (downloadError || !object) return json({ error: 'Changed-file manifest content is unavailable' }, 503);
    let entries: unknown = null;
    try { entries = JSON.parse(await object.text()); } catch {}
    if (!Array.isArray(entries)) return json({ error: 'Changed-file manifest is not readable' }, 422);
    const files = entries
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && typeof (entry as Record<string, unknown>).path === 'string')
      .slice(0, CHANGED_FILE_LIMIT)
      .map(entry => ({
        path: String(entry.path).slice(0, 300),
        change: !entry.before_sha256 ? 'added' : !entry.after_sha256 ? 'deleted' : 'modified',
      }));
    return json({ manifest: { id: manifest.id, checksum: manifest.checksum, created_at: manifest.created_at, total: entries.length }, files });
  }
  if (action === 'decide_approval') {
    const approvalId = typeof body.approval_id === 'string' ? body.approval_id : '';
    const decision = typeof body.decision === 'string' ? body.decision : '';
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (!approvalId || !['approved', 'rejected'].includes(decision) || !comment) return json({ error: 'Approval, decision, and review rationale are required' }, 400);
    const { data: approval, error: approvalError } = await admin.from('builder_approvals').select('id, organization_id, approval_type, status').eq('id', approvalId).eq('job_id', jobId).single();
    if (approvalError || !approval || !canAccessOrganization(approval.organization_id)) return json({ error: 'Builder approval is unavailable' }, 404);
    if (approval.status !== 'pending') return json({ error: 'Builder approval is no longer pending' }, 409);
    const rpc = approval.approval_type === 'implementation_review' ? 'builder_decide_human_code_review' : 'builder_decide_approval';
    const { data, error: decisionError } = await callerClient.rpc(rpc, { _approval_id: approvalId, _decision: decision, _comment: comment });
    await audit(approval.organization_id, decisionError ? 'approval_failed' : `approval_${decision}`, jobId);
    if (decisionError) return json({ error: decisionError.message }, 409);
    return json({ job: safeJob(data as Record<string, unknown>) });
  }
  if (action === 'cancel') {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return json({ error: 'Cancellation reason is required' }, 400);
    const { data, error } = await callerClient.rpc('builder_cancel_job', { _job_id: jobId, _reason: reason });
    if (error) return json({ error: error.message }, 409);
    await audit(job.organization_id, 'cancelled', jobId);
    return json({ job: safeJob(data as Record<string, unknown>) });
  }
  if (action === 'read_artifact') {
    const artifactId = typeof body.artifact_id === 'string' ? body.artifact_id : '';
    if (!artifactId) return json({ error: 'Artifact is required' }, 400);
    const { data: artifact, error: artifactError } = await admin
      .from('builder_artifacts')
      .select('id, job_id, content_type, content_size_bytes, storage_location, checksum, status')
      .eq('id', artifactId)
      .eq('job_id', jobId)
      .single();
    if (artifactError || !artifact) return json({ error: 'Builder artifact is unavailable' }, 404);
    if (artifact.status !== 'final' || !ARTIFACT_PREVIEW_TYPES.has(artifact.content_type ?? '') || !artifact.storage_location?.startsWith('supabase_storage://builder-artifacts/')) {
      return json({ error: 'This artifact cannot be previewed in the workspace' }, 409);
    }
    if ((artifact.content_size_bytes ?? 0) > ARTIFACT_PREVIEW_LIMIT_BYTES) return json({ error: 'Artifact is too large for browser preview' }, 413);
    const objectPath = artifact.storage_location.slice('supabase_storage://builder-artifacts/'.length);
    const { data: object, error: downloadError } = await admin.storage.from('builder-artifacts').download(objectPath);
    if (downloadError || !object) return json({ error: 'Builder artifact content is unavailable' }, 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > ARTIFACT_PREVIEW_LIMIT_BYTES) return json({ error: 'Artifact is too large for browser preview' }, 413);
    const content = new TextDecoder().decode(bytes);
    await audit(job.organization_id, 'artifact_previewed', jobId);
    return json({ artifact: { id: artifact.id, content_type: artifact.content_type, checksum: artifact.checksum, content } });
  }
  if (action === 'create_workspace') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/workspace`, 'POST');
    await audit(job.organization_id, result.ok ? 'workspace_created' : 'workspace_failed', jobId);
    if (!result.ok) return json({ error: 'Builder workspace could not be created', detail: failureDetail(result.payload) }, result.status);
    return json({ workspace: result.payload });
  }
  if (action === 'create_followup') {
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
    const taskDescription = typeof body.task_description === 'string' ? body.task_description.slice(0, 12000) : '';
    if (!title || !taskDescription) return json({ error: 'Follow-up title and task description are required' }, 400);
    const { data, error } = await admin.rpc('builder_create_followup_job', {
      _parent_job_id: jobId,
      _title: title,
      _task_description: taskDescription,
      _frontend_required: body.frontend_required !== false,
      _backend_required: body.backend_required === true,
      _code_review_mode: typeof body.code_review_mode === 'string' ? body.code_review_mode : 'none',
    });
    await audit(job.organization_id, error ? 'followup_failed' : 'followup_created', jobId);
    if (error || !data?.id) return json({ error: 'Builder follow-up could not be created' }, 409);
    if (body.autopilot === true) {
      const bound = await bindAutopilot(String(data.id), job.organization_id);
      if (!bound.job) return json({ job: safeJob(data), autopilot: false, autopilot_error: bound.error }, 201);
      return json({ job: safeJob(bound.job), autopilot: true }, 201);
    }
    return json({ job: safeJob(data), autopilot: false }, 201);
  }
  // Hand an existing job (for example one created before autopilot was the default) to Bob to drive.
  if (action === 'drive') {
    stage = 'bind_builder_autopilot';
    const bound = await bindAutopilot(jobId, job.organization_id);
    if (!bound.job) return json({ error: 'Bob could not take this job', detail: bound.error }, 409);
    return json({ job: safeJob(bound.job), autopilot: true });
  }
  if (action === 'commit_verified_patch') {
    const artifactId = typeof body.artifact_id === 'string' ? body.artifact_id : '';
    if (!artifactId || !CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Verified patch and Builder execution host are required' }, 400);
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/commit`, 'POST', { artifactId });
    await audit(job.organization_id, result.ok ? 'workspace_patch_committed' : 'workspace_commit_failed', jobId);
    if (!result.ok) return json({ error: 'Verified Builder patch could not be committed', detail: failureDetail(result.payload) }, result.status);
    return json({ commit: result.payload });
  }
  if (action === 'publish_workspace') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/publish`, 'POST');
    await audit(job.organization_id, result.ok ? 'workspace_published' : 'workspace_publish_failed', jobId);
    if (!result.ok) return json({ error: 'Builder branch could not be published', detail: failureDetail(result.payload) }, result.status);
    return json({ publication: result.payload });
  }
  if (action === 'create_pull_request') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/pull-request`, 'POST');
    await audit(job.organization_id, result.ok ? 'pull_request_created' : 'pull_request_failed', jobId);
    if (!result.ok) return json({ error: 'Builder pull request could not be created', detail: failureDetail(result.payload) }, result.status);
    return json({ pull_request: result.payload });
  }
  if (action === 'advance' || action === 'run') {
    stage = 'relay_builder_execution';
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) {
      await audit(job.organization_id, 'unavailable', jobId);
      return json({ error: 'Builder execution host is unavailable' }, 503);
    }
    const result = await relay(`/api/bob/builder/jobs/${encodeURIComponent(jobId)}/${action}`, 'POST', {
      frontendFiles: strings(body.frontend_files, 30),
      backendFiles: strings(body.backend_files, 40),
      constraints: strings(body.constraints, 100),
      requestedFromUsers: strings(body.requested_from_users, 100),
      reviewerModelName: typeof body.reviewer_model_name === 'string' ? body.reviewer_model_name.slice(0, 200) : null,
      repositoryContext: body.repository_context && typeof body.repository_context === 'object' ? body.repository_context : {},
      designContext: body.design_context && typeof body.design_context === 'object' ? body.design_context : {},
      maxActions: action === 'run' ? Math.min(Math.max(Number(body.max_actions) || 8, 1), 8) : undefined,
    });
    await audit(job.organization_id, result.ok ? action : 'failed', jobId);
    if (!result.ok) return json({ error: `Builder job could not ${action}`, detail: failureDetail(result.payload) }, result.status);
    const snapshot = result.payload.snapshot && typeof result.payload.snapshot === 'object'
      ? safeSnapshot(result.payload.snapshot as Record<string, unknown>)
      : null;
    return json({
      accepted: result.payload.accepted,
      already_running: result.payload.already_running,
      started_at: result.payload.started_at,
      advanced: result.payload.advanced,
      paused: result.payload.paused,
      reason: result.payload.reason,
      action: result.payload.action,
      history: result.payload.history,
      snapshot,
    }, result.status);
  }

  return json({ error: 'Unsupported Builder action' }, 400);
  } catch (error) {
    console.error(`[${FUNCTION_NAME}] ${stage}`, error);
    return json({ error: 'Builder control room is unavailable', stage }, 503);
  }
});

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';

const FUNCTION_NAME = 'bob-builder-control-room';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CONTROL_PLANE_URL = Deno.env.get('BOB_CONTROL_PLANE_URL') ?? Deno.env.get('FCM_API_URL') ?? '';
const CONTROL_PLANE_TOKEN = Deno.env.get('BOB_ADMIN_TOKEN') ?? Deno.env.get('FCM_API_TOKEN') ?? '';
const CAN_BUILD = new Set(['grand_master', 'master']);
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
  const keys = ['id', 'organization_id', 'project_id', 'title', 'description', 'task_description', 'status', 'current_step_name', 'current_step_index', 'total_steps', 'branch_name', 'target_sha', 'frontend_required', 'backend_required', 'code_review_mode', 'code_review_status', 'last_error', 'created_at', 'updated_at'];
  return Object.fromEntries(keys.map(key => [key, job[key]]));
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
      completed_at: run.completed_at,
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

serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Builder control room is unavailable' }, 503);
  }
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authError } = await callerClient.auth.getUser();
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: profile } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids, email').eq('id', user.id).single();
  const role = resolveEffectiveRole(user.email ?? profile?.email, profile?.role);
  if (!profile || !CAN_BUILD.has(role)) return json({ error: 'Forbidden' }, 403);

  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === 'string' ? body.action : '';
  const requestedOrgId = typeof body.organization_id === 'string' ? body.organization_id : null;
  const allowedOrganizations = new Set([profile.organization_id, ...strings(profile.authorized_organization_ids, 200)].filter(Boolean));
  const canAccessOrganization = (organizationId: string | null) => role === 'grand_master' || Boolean(organizationId && allowedOrganizations.has(organizationId));

  const audit = async (organizationId: string | null, result: string, jobId: string | null = null) => {
    await admin.from('audit_log').insert({
      organization_id: organizationId,
      user_id: user.id,
      action: FUNCTION_NAME,
      entity_type: 'builder_job',
      entity_id: jobId,
      change_summary: JSON.stringify({ action, result }),
    }).catch(() => {});
  };

  if (action === 'browser-checks') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay('/api/bob/builder/browser-checks', 'GET');
    if (!result.ok) return json({ error: 'Browser check history is unavailable' }, result.status);
    return json(Array.isArray(result.payload) ? result.payload : []);
  }

  if (action === 'browser-check') {
    if (!CONTROL_PLANE_URL || !CONTROL_PLANE_TOKEN) return json({ error: 'Builder execution host is unavailable' }, 503);
    const result = await relay('/api/bob/builder/browser-check', 'POST', {
      appUrl: body.appUrl || body.url || null,
      testName: typeof body.testName === 'string' ? body.testName : 'live-app-check',
    });
    if (!result.ok) return json({ error: 'Browser check could not be run' }, result.status);
    return json(result.payload);
  }

  if (action === 'list') {
    const organizations = role === 'grand_master' ? null : [...allowedOrganizations];
    let projectsQuery = admin.from('builder_projects').select('id, organization_id, gitea_owner, gitea_repo, name, status').eq('status', 'active').order('name');
    let jobsQuery = admin.from('builder_jobs').select('id, organization_id, project_id, title, status, current_step_name, target_sha, frontend_required, backend_required, code_review_mode, code_review_status, last_error, created_at, updated_at').order('created_at', { ascending: false }).limit(100);
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
    if (!canAccessOrganization(requestedOrgId)) return json({ error: 'Organization access denied' }, 403);
    const projectId = typeof body.project_id === 'string' ? body.project_id : '';
    const { data: project } = await admin.from('builder_projects').select('id, organization_id, gitea_owner, gitea_repo').eq('id', projectId).eq('organization_id', requestedOrgId).eq('status', 'active').single();
    if (!project) return json({ error: 'Builder project is unavailable' }, 404);
    const { data: created, error: createError } = await admin.rpc('builder_create_job', {
      _organization_id: requestedOrgId,
      _project_id: projectId,
      _title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
      _task_description: typeof body.task_description === 'string' ? body.task_description.slice(0, 12000) : '',
      _target_sha: typeof body.target_sha === 'string' ? body.target_sha : '',
      _branch_name: typeof body.branch_name === 'string' ? body.branch_name.slice(0, 200) : 'main',
      _description: typeof body.description === 'string' ? body.description.slice(0, 2000) : null,
      _frontend_required: body.frontend_required !== false,
      _backend_required: body.backend_required === true,
      _code_review_mode: body.code_review_mode,
      _task_run_id: null,
    });
    await audit(requestedOrgId, createError ? 'failed' : 'created', String(created?.id ?? '') || null);
    return createError ? json({ error: 'Builder job could not be created' }, 409) : json({ job: safeJob(created) }, 201);
  }

  const jobId = typeof body.job_id === 'string' ? body.job_id : '';
  const { data: job } = await admin.from('builder_jobs').select('id, organization_id').eq('id', jobId).single();
  if (!job || !canAccessOrganization(job.organization_id)) return json({ error: 'Builder job is unavailable' }, 404);

  if (action === 'get') {
    const [jobResult, stepsResult, artifactsResult, runsResult] = await Promise.all([
      admin.from('builder_jobs').select('*').eq('id', jobId).single(),
      admin.from('builder_job_steps').select('*').eq('job_id', jobId).order('ordinal_position'),
      admin.from('builder_artifacts').select('*').eq('job_id', jobId).order('created_at'),
      admin.from('builder_worker_runs').select('*').eq('job_id', jobId).order('started_at'),
    ]);
    const failed = jobResult.error || stepsResult.error || artifactsResult.error || runsResult.error;
    await audit(job.organization_id, failed ? 'failed' : 'viewed', jobId);
    if (failed) return json({ error: 'Builder job could not be loaded' }, 503);
    return json(safeSnapshot({ job: jobResult.data, steps: stepsResult.data, artifacts: artifactsResult.data, workerRuns: runsResult.data }));
  }
  if (action === 'advance' || action === 'run') {
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
    if (!result.ok) return json({ error: `Builder job could not ${action}` }, result.status);
    const snapshot = result.payload.snapshot && typeof result.payload.snapshot === 'object'
      ? safeSnapshot(result.payload.snapshot as Record<string, unknown>)
      : null;
    return json({ advanced: result.payload.advanced, paused: result.payload.paused, reason: result.payload.reason, action: result.payload.action, history: result.payload.history, snapshot });
  }

  return json({ error: 'Unsupported Builder action' }, 400);
});

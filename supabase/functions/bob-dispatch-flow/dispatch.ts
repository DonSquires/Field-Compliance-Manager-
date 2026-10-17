import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const REPOSITORY = 'https://github.com/DonSquires/Field-Compliance-Manager-.git';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOWS = ['developer', 'fix_pipeline', 'code_review'];
const PROJECT_COLUMNS = 'id,organization_id,gitea_owner,gitea_repo';
type ControlPlane = { configured: boolean; request: (path: string, payload?: Record<string, unknown>) => Promise<Response> };
const failure = (error: string, status: number, jobId: string | null = null) => ({
  status, body: { ok: false, error, workflow_id: jobId, workflow_url: null },
});

export async function dispatchBuilder(admin: SupabaseClient, body: Record<string, unknown>, userId: string, cp: ControlPlane) {
  const flow = String(body.flow ?? '').trim();
  if (!FLOWS.includes(flow)) return failure(`Invalid flow '${flow}'. Must be one of: ${FLOWS.join(', ')}`, 400);
  const goal = String(body.goal ?? '').trim().slice(0, 500);
  const brief = String(body.brief ?? '').trim();
  if (!goal) return failure('goal is required (non-empty string describing the task)', 400);
  if (!brief) return failure('brief is required (non-empty string with the full dispatch brief)', 400);
  if (brief.length > 8000) return failure('brief must not exceed 8000 characters', 400);
  if (!cp.configured) return failure('Builder control plane is not configured. Fail-closed.', 500);
  for (const key of ['project_id', 'organization_id', 'task_run_id', 'job_id', 'conversation_id']) {
    if (body[key] !== undefined && body[key] !== null && !UUID.test(String(body[key]))) {
      return failure(`${key} must be a UUID`, 400);
    }
  }
  const requestedAction = String(body.requested_action ?? 'prepare_change');
  const targetEnvironment = String(body.target_environment ?? 'development');
  const reviewMode = String(body.code_review_mode ?? (flow === 'code_review' ? 'human' : 'independent_ai'));
  if (!['prepare_change', 'prepare_release'].includes(requestedAction)
    || !['development', 'staging', 'production'].includes(targetEnvironment)
    || !['human', 'independent_ai'].includes(reviewMode)
    || (targetEnvironment === 'production' && (requestedAction !== 'prepare_release' || reviewMode !== 'human'))) {
    return failure('Unsupported Builder action, environment or review mode; production requires release preparation and human review.', 400);
  }
  let projectQuery = admin.from('builder_projects').select(PROJECT_COLUMNS).eq('status', 'active')
    .eq('gitea_owner', 'DonSquires').eq('gitea_repo', 'Field-Compliance-Manager-').limit(2);
  if (body.project_id) projectQuery = projectQuery.eq('id', String(body.project_id));
  if (body.organization_id) projectQuery = projectQuery.eq('organization_id', String(body.organization_id));
  const { data: projects, error: projectError } = await projectQuery;
  if (projectError) throw projectError;
  if (projects.length !== 1) return failure('Select one active Builder project for the GitHub repository; project_id and organization_id may be required.', 400);
  const project = projects[0];
  let job: { id: string; target_sha: string; status: string; requested_action?: string; target_environment?: string; code_review_mode?: string } | null = null;
  const taskRunId = body.task_run_id ? String(body.task_run_id) : null;
  if (taskRunId) {
    const { data: task, error } = await admin.from('bob_task_runs').select('id,organization_id').eq('id', taskRunId)
      .eq('organization_id', project.organization_id).maybeSingle();
    if (error) throw error;
    if (!task) return failure('Task run was not found in this Builder organisation.', 400);
  }
  if (body.job_id || taskRunId) {
    let query = admin.from('builder_jobs').select('id,target_sha,status,requested_action,target_environment,code_review_mode')
      .eq('organization_id', project.organization_id).eq('project_id', project.id);
    query = body.job_id ? query.eq('id', String(body.job_id)) : query.eq('task_run_id', taskRunId);
    if (body.job_id && taskRunId) query = query.eq('task_run_id', taskRunId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    job = data;
    if (body.job_id && !job) return failure('Bob job was not found in Builder job records.', 404);
    if (job && ((body.requested_action !== undefined && job.requested_action !== requestedAction)
      || (body.target_environment !== undefined && job.target_environment !== targetEnvironment)
      || (body.code_review_mode !== undefined && job.code_review_mode !== reviewMode))) {
      return failure('Existing job action, environment and review mode must match the confirmed dispatch.', 409, job.id);
    }
  }
  if (!job && !body.job_id && !taskRunId) {
    const { data, error } = await admin.from('builder_jobs')
      .select('id,target_sha,status,requested_action,target_environment,code_review_mode')
      .eq('organization_id', project.organization_id).eq('project_id', project.id)
      .eq('title', goal).eq('task_description', brief)
      .eq('description', `Confirmed ${flow} dispatch by ${userId}`)
      .eq('requested_action', requestedAction).eq('target_environment', targetEnvironment).eq('code_review_mode', reviewMode)
      .not('status', 'in', '(deployed,failed,cancelled)')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    job = data;
  }
  if (job && ['failed', 'cancelled', 'deployed'].includes(job.status)) {
    return failure('This job cannot resume. Create a reviewed child rerun from the Builder control room.', 409, job.id);
  }
  if (!job) {
    const headResponse = await cp.request('/api/bob/builder/repository/head?ref=main');
    if (!headResponse.ok) return failure(`Builder repository head returned HTTP ${headResponse.status}`, 502);
    const head = await headResponse.json();
    if (!/^[a-f0-9]{40}$/i.test(String(head.sha ?? ''))) return failure('Builder repository head did not return a valid commit.', 502);
    if (body.target_sha && body.target_sha !== head.sha) return failure('Requested target SHA is not current GitHub main. Refresh the dispatch brief.', 409);
    const created = await cp.request('/api/bob/builder/jobs', {
      repository: REPOSITORY, organizationId: project.organization_id, projectId: project.id,
      title: goal, taskDescription: brief, description: `Confirmed ${flow} dispatch by ${userId}`,
      targetSha: head.sha, requestedAction, targetEnvironment, branchName: 'main',
      frontendRequired: body.frontend_required !== false, backendRequired: body.backend_required !== false,
      codeReviewMode: reviewMode, taskRunId,
    });
    if (!created.ok) return failure(`Builder job create failed (HTTP ${created.status})`, 502);
    const data = await created.json();
    if (!UUID.test(String(data.id ?? ''))) return failure('Builder did not return a durable job ID.', 502);
    job = data;
  }
  if (!job) throw new Error('Builder job receipt is missing.');
  // The existing autonomous driver advances through gates and publishes a GitHub PR.
  const { data: bound, error: bindError } = await admin.rpc('builder_autopilot_bind', {
    _job_id: job.id, _requested_by: userId, _conversation_id: body.conversation_id ?? null,
  });
  if (bindError || bound?.id !== job.id) return failure('Builder job exists, but autonomous execution could not be authorised. Resume using this job ID.', 502, job.id);
  let started: Response;
  try {
    started = await cp.request(`/api/bob/builder/jobs/${job.id}/run`, { maxActions: 8 });
  } catch (error) {
    console.error('[bob-dispatch-flow] run request failed', error instanceof Error ? error.name : 'request error');
    return failure('Builder job exists, but runner acceptance could not be verified. Resume using this job ID.', 502, job.id);
  }
  if (!started.ok) return failure(`Builder job exists, but runner returned HTTP ${started.status}. Resume using this job ID.`, 502, job.id);
  const receipt = await started.json();
  if (receipt.accepted !== true || receipt.job_id !== job.id) return failure('Builder runner did not confirm this job. Resume using this job ID.', 502, job.id);
  return {
    status: 200,
    body: { ok: true, workflow_id: job.id, workflow_url: null, flow,
      workflow_definition: 'github_builder', job_id: job.id, status: job.status,
      target_sha: job.target_sha, runner_started: true, repository: REPOSITORY },
  };
}

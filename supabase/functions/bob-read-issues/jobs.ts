import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const JOB_COLUMNS = 'id,organization_id,project_id,parent_job_id,task_run_id,title,description,task_description,status,branch_name,workspace_branch,target_sha,workspace_pull_request_url,last_error,created_by,created_at,updated_at';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{7,40}$/i;
const ACTIONABLE = new Set(['implementation_pending', 'building', 'testing', 'approval_pending']);
export interface Job {
  id: string; organization_id: string; project_id: string; parent_job_id: string | null;
  task_run_id: string | null; title: string; status: string; branch_name: string | null;
  workspace_branch: string | null; target_sha: string | null; created_at: string;
  description?: string | null; task_description?: string | null; last_error?: string | null;
  workspace_pull_request_url?: string | null; created_by?: string | null; updated_at?: string;
}
const MAX_LINEAGE = 200;

export function issueView(job: Job, detail = false) {
  return {
    ...(detail ? job : {}),
    iid: job.id, title: job.title, state: job.status, labels: [job.status],
    web_url: job.workspace_pull_request_url ?? null,
    ...(detail ? {
      description: [job.task_description ?? job.description ?? '', job.last_error ? `Last error: ${job.last_error}` : ''].filter(Boolean).join('\n\n').slice(0, 8000),
      author: job.created_by,
    } : {}),
  };
}

export function selectJob(root: Job, lineage: Job[]) {
  return lineage.filter(job => job.id !== root.id && ACTIONABLE.has(job.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))[0] ?? root;
}

export async function findJobs(admin: SupabaseClient, identifier: string): Promise<Job[]> {
  const matches = new Map<string, Job>();
  const collect = async (field: string) => {
    const { data, error } = await admin.from('builder_jobs').select(JOB_COLUMNS).eq(field, identifier).limit(MAX_LINEAGE + 1);
    if (error) throw error;
    if (data.length > MAX_LINEAGE) throw new Error('Builder lookup is too broad; use a job ID.');
    for (const job of data) matches.set(job.id, job);
  };
  if (UUID.test(identifier)) await collect('id');
  await collect('branch_name');
  await collect('workspace_branch');
  if (!matches.size && SHA.test(identifier)) await collect('target_sha');
  return [...matches.values()];
}

export async function jobLineage(admin: SupabaseClient, seed: Job) {
  const seen = new Set<string>();
  let root = seed;
  while (root.parent_job_id) {
    if (seen.has(root.id) || seen.size >= MAX_LINEAGE) throw new Error('Builder job ancestry could not be verified.');
    seen.add(root.id);
    const { data, error } = await admin.from('builder_jobs').select(JOB_COLUMNS).eq('id', root.parent_job_id)
      .eq('organization_id', seed.organization_id).eq('project_id', seed.project_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Builder parent job was not found in the same project.');
    root = data;
  }
  const jobs = new Map<string, Job>([[root.id, root]]);
  let pending = [root.id];
  while (pending.length) {
    const { data, error } = await admin.from('builder_jobs').select(JOB_COLUMNS).in('parent_job_id', pending)
      .eq('organization_id', root.organization_id).eq('project_id', root.project_id).limit(MAX_LINEAGE + 1);
    if (error) throw error;
    pending = [];
    for (const job of data) {
      if (jobs.has(job.id)) throw new Error('Builder job lineage contains a cycle.');
      jobs.set(job.id, job); pending.push(job.id);
    }
    if (jobs.size > MAX_LINEAGE) throw new Error('Builder job lineage is too large; use a more specific job ID.');
  }
  const lineage = [...jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return { root, lineage, selected: selectJob(root, lineage) };
}

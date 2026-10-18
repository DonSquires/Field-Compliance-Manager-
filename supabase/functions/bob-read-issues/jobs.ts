import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const JOB_COLUMNS = 'id,organization_id,project_id,parent_job_id,task_run_id,title,description,task_description,status,branch_name,workspace_branch,target_sha,workspace_pull_request_url,last_error,autopilot_state,autopilot_report,created_by,created_at,updated_at';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{7,40}$/i;
const ACTIONABLE = new Set(['implementation_pending', 'building', 'testing', 'approval_pending']);
export interface Job {
  id: string; organization_id: string; project_id: string; parent_job_id: string | null;
  task_run_id: string | null; title: string; status: string; branch_name: string | null;
  workspace_branch: string | null; target_sha: string | null; created_at: string;
  description?: string | null; task_description?: string | null; last_error?: string | null;
  workspace_pull_request_url?: string | null; created_by?: string | null; updated_at?: string;
  autopilot_state?: string | null; autopilot_report?: Record<string, unknown> | null;
}
const MAX_LINEAGE = 200;

export function issueView(job: Job, detail = false) {
  return {
    ...(detail ? job : {}),
    iid: job.id, title: job.title, state: job.status, labels: [job.status],
    autopilot_state: job.autopilot_state ?? null, resumed_as_job_id: continuationId(job),
    web_url: job.workspace_pull_request_url ?? null,
    ...(detail ? {
      description: [job.task_description ?? job.description ?? '', job.last_error ? `Last error: ${job.last_error}` : ''].filter(Boolean).join('\n\n').slice(0, 8000),
      author: job.created_by,
    } : {}),
  };
}

export function selectJob(root: Job, lineage: Job[]) {
  return lineage.filter(job => job.id !== root.id && ACTIONABLE.has(job.status)
    && job.autopilot_state !== 'done' && !continuationId(job))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))[0] ?? root;
}

function continuationId(job: Job) {
  const value = job.autopilot_report?.resumed_as_job_id;
  if (value == null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Recorded Builder continuation has an invalid job ID.');
  return value.toLowerCase();
}

function verifyLineageGraph(jobs: Map<string, Job>) {
  const edges = new Map([...jobs.keys()].map(id => [id, new Set<string>()]));
  for (const job of jobs.values()) {
    if (job.parent_job_id) edges.get(job.parent_job_id)?.add(job.id);
    const successor = continuationId(job);
    if (successor) edges.get(job.id)?.add(successor);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Builder job lineage contains a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) visit(next);
    visiting.delete(id); visited.add(id);
  };
  for (const id of jobs.keys()) visit(id);
}

const asUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

// People paste what Bob or GitHub showed them: a UUID, its first 8 characters, the dash-less
// workspace suffix ("a7c916f5b98047f7ac47" from bob/job-a7c916f5b98047f7ac47) or a commit.
export function identifierForms(raw: string) {
  const identifier = raw.trim().replace(/^#/, '').replace(/^job\s+/i, '');
  const compact = identifier.toLowerCase().replace(/^(?:bob\/)?job-/, '').replace(/-/g, '');
  const hex = /^[0-9a-f]+$/.test(compact) ? compact : '';
  return {
    identifier,
    uuid: UUID.test(identifier) ? identifier.toLowerCase() : hex.length === 32 ? asUuid(hex) : null,
    branch: hex.length === 20 ? `bob/job-${hex}` : null,
    idPrefix: hex.length >= 8 && hex.length < 32 ? hex : null,
  };
}

export async function findJobs(admin: SupabaseClient, raw: string): Promise<Job[]> {
  const matches = new Map<string, Job>();
  const { identifier, uuid, branch, idPrefix } = identifierForms(raw);
  const add = (data: Job[]) => {
    if (data.length > MAX_LINEAGE) throw new Error('Builder lookup is too broad; use a job ID.');
    for (const job of data) matches.set(job.id, job);
  };
  const collect = async (field: string, value: string) => {
    const { data, error } = await admin.from('builder_jobs').select(JOB_COLUMNS).eq(field, value).limit(MAX_LINEAGE + 1);
    if (error) throw error;
    add(data);
  };
  if (uuid) await collect('id', uuid);
  for (const value of new Set([identifier, branch].filter(Boolean) as string[])) {
    await collect('branch_name', value);
    await collect('workspace_branch', value);
  }
  if (!matches.size && idPrefix) {
    // UUIDs order byte-wise, so a hex prefix is a closed range on the primary key.
    const { data, error } = await admin.from('builder_jobs').select(JOB_COLUMNS)
      .gte('id', asUuid(idPrefix.padEnd(32, '0'))).lte('id', asUuid(idPrefix.padEnd(32, 'f'))).limit(MAX_LINEAGE + 1);
    if (error) throw error;
    add(data);
  }
  if (!matches.size && SHA.test(identifier)) await collect('target_sha', identifier.toLowerCase());
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
    // Older automatic continuations recorded their handoff but omitted parent_job_id.
    // Read that evidence without inventing or writing a structural parent relationship.
    const successors = [...new Set(pending.flatMap(id => {
      const job = jobs.get(id);
      const next = job ? continuationId(job) : null;
      return next && !jobs.has(next) ? [next] : [];
    }))];
    const [children, continued] = await Promise.all([
      admin.from('builder_jobs').select(JOB_COLUMNS).in('parent_job_id', pending)
        .eq('organization_id', root.organization_id).eq('project_id', root.project_id).limit(MAX_LINEAGE + 1),
      successors.length ? admin.from('builder_jobs').select(JOB_COLUMNS).in('id', successors)
        .eq('organization_id', root.organization_id).eq('project_id', root.project_id).limit(MAX_LINEAGE + 1)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (children.error) throw children.error;
    if (continued.error) throw continued.error;
    const continuationJobs: Job[] = continued.data;
    if (successors.some(id => !continuationJobs.some(job => job.id === id))) {
      throw new Error('Recorded Builder continuation was not found in the same project.');
    }
    pending = [];
    for (const job of [...children.data, ...continuationJobs]) {
      if (jobs.has(job.id)) continue;
      jobs.set(job.id, job); pending.push(job.id);
    }
    verifyLineageGraph(jobs);
    if (jobs.size > MAX_LINEAGE) throw new Error('Builder job lineage is too large; use a more specific job ID.');
  }
  const lineage = [...jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return { root, lineage, selected: selectJob(root, lineage) };
}

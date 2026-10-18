export interface SearchableBuilderJob {
  id: string;
  title: string;
  status: string;
  current_step_name?: string | null;
  last_error?: string | null;
  target_sha?: string | null;
  workspace_branch?: string | null;
  branch_name?: string | null;
  workspace_pull_request_url?: string | null;
}

const compact = (value: string) => value.toLowerCase().replace(/[^0-9a-z]/g, '');

/**
 * People paste whatever identifier Bob or GitHub showed them: a full job UUID, its first eight
 * characters, the dash-less workspace suffix (bob/job-a7c916f5b98047f7ac47), a branch, a PR URL
 * or a commit. Every one of those must find the job.
 */
export function jobMatchesSearch(job: SearchableBuilderJob, rawQuery: string) {
  const query = rawQuery.toLowerCase().trim().replace(/^#/, '');
  if (!query) return true;
  const text = [job.title, job.current_step_name, job.status, job.last_error, job.target_sha, job.workspace_branch, job.branch_name, job.workspace_pull_request_url, job.id]
    .map(value => String(value ?? '').toLowerCase());
  if (text.some(value => value.includes(query))) return true;
  const idQuery = compact(query.replace(/^(?:bob\/)?job-/, ''));
  return idQuery.length >= 6 && /^[0-9a-f]+$/.test(idQuery) && compact(job.id).startsWith(idQuery);
}

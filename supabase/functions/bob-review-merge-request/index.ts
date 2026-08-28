/**
 * bob-review-merge-request — ADMIRAL-ONLY read-only MR inspection
 *
 * Lets Bob fetch the RAW FACTS of a merge request in THIS project so he can
 * reason over the ACTUAL diff, metadata, and pipeline status — not a
 * human-supplied summary. Diagnostic only: this function NEVER writes,
 * approves, merges, or changes draft state.
 *
 * Returns structured data for Bob to reason over:
 *   (a) MR metadata (title, state, draft, source/target branch, author, labels)
 *   (b) The actual diff / changed-file list (truncated to fit edge budget)
 *   (c) Head pipeline status + failing jobs
 *   (d) The MR description
 *
 * DEFENCE IN DEPTH:
 *   1. Auth: JWT required; caller MUST be grand_master (admiral). No other rank.
 *   2. Read-only: uses GitLab MR GET + diffs GET + pipelines GET only.
 *   3. Never writes, approves, merges, or changes any MR state.
 *   4. Secret-safe: diffs are scanned for obvious secret-looking lines and
 *      those lines are redacted (same pattern as bob-repo-search).
 *
 * Env:
 *   GITLAB_TOKEN        — read_api PAT (same token as bob-repo-search)
 *   GITLAB_PROJECT_ID   — numeric id or raw namespace/project path (default 83317421)
 *   GITLAB_BASE_URL     — default https://gitlab.com
 *
 * Body:
 *   { mr_iid: number | string }
 *   OR
 *   { mr_url: string }  — extracts iid from a GitLab MR URL
 *
 * Response: {
 *   ok: boolean,
 *   requested_iid: number,          // ECHO: the iid the caller asked for
 *   fetched_iid: number,            // ECHO: the iid GitLab actually returned
 *   fetched_title: string,          // ECHO: title of the MR GitLab returned
 *   fetched_source_branch: string,  // ECHO: source branch of the fetched MR
 *   fetched_target_branch: string,  // ECHO: target branch of the fetched MR
 *   identity_match: boolean,        // true iff requested_iid === fetched_iid
 *   mr: { iid, title, state, draft, description, source_branch, target_branch,
 *          author, labels, web_url, created_at, updated_at, merged_by, merged_at },
 *   diff: { changed_files: number, files: [{ path, renamed_from?, status, diff }], truncated },
 *   pipeline: { id, status, web_url, failing_jobs: [{ name, stage, status, web_url }] } | null,
 *   error?: string
 * }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole, roleTier } from '../_shared/auth.ts';
import { extractIidFromUrl, buildMrMetadataPath, buildMrDiffsPath, buildGitLabApiUrl, checkIdentityMatch } from '../_shared/mr-review-utils.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GITLAB_TOKEN = Deno.env.get('GITLAB_TOKEN') ?? '';
const GITLAB_PROJECT_ID = Deno.env.get('GITLAB_PROJECT_ID') ?? '83317421';
const GITLAB_BASE_URL = (Deno.env.get('GITLAB_BASE_URL') ?? 'https://gitlab.com').replace(/\/+$/, '');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Auth gate: admiral-only — uses centralized roleTier() from _shared/auth.ts
// instead of a local role-gate set (Pillar C, Epic #135 / Issue #138).
// Same secret-line redaction as bob-repo-search (defence in depth).
const SECRET_LINE = /((?:api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key)\s*[:=]\s*)(\S+)/i;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function redactSecretLines(text) {
  return text.split('\n').map((l)=>l.replace(SECRET_LINE, '$1[redacted]')).join('\n');
}
async function gl(path) {
  return fetch(buildGitLabApiUrl(GITLAB_BASE_URL, GITLAB_PROJECT_ID, path), {
    headers: {
      'PRIVATE-TOKEN': GITLAB_TOKEN
    }
  });
}
// Max total diff size to return (chars). Keeps the response within edge fn
// budget and prevents a 500-file MR from blowing up the planner context.
// Sized for Bob's gpt-5.2 brain (large context). Old 12k/3k values were
// gpt-4o-mini-era and left the reviewer effectively blind on real MRs.
const MAX_DIFF_CHARS = 90000;
// Max per-file diff size (chars). Large generated files are truncated.
const MAX_PER_FILE_DIFF_CHARS = 24000;
// Max diff pages to fetch (100 files/page). Bounds a pathological giant MR
// while still fetching far beyond the old page-1-only limit.
const MAX_DIFF_PAGES = 20;
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role').eq('id', user.id).single();
    const effectiveRole = resolveEffectiveRole(user.email, String(profile?.role ?? 'guest'));
    if (roleTier(effectiveRole) !== 'admiral') {
      return json({
        error: 'Forbidden: admiral (grand_master) only'
      }, 403);
    }
    if (!GITLAB_TOKEN) return json({
      error: 'MR review not configured (GITLAB_TOKEN missing)'
    }, 503);
    const body = await req.json().catch(()=>({}));
    // B1: job log path ONLY when action='job_log' is explicitly set.
    if (String(body.action ?? '').trim() === 'job_log') {
      const jobId = body.job_id ? parseInt(String(body.job_id), 10) : null;
      if (!jobId || !Number.isFinite(jobId) || jobId < 1) return json({
        error: 'job_id required for action=job_log'
      }, 400);
      const logRes = await gl(`/jobs/${jobId}/trace`);
      if (!logRes.ok) return json({
        ok: false,
        error: `GitLab job log API returned ${logRes.status}`
      }, 502);
      const rawLog = await logRes.text();
      // deno-lint-ignore no-control-regex
      const cleanLog = redactSecretLines(rawLog.replace(/\x1b\[[0-9;]*m/g, ''));
      const truncated = cleanLog.length > 8000;
      return json({
        ok: true,
        job_id: jobId,
        log: truncated ? cleanLog.slice(-8000) : cleanLog,
        truncated,
        total_chars: cleanLog.length
      });
    }
    // Resolve the MR iid from either mr_iid or mr_url
    let iid = null;
    if (body.mr_iid !== undefined && body.mr_iid !== null) {
      iid = typeof body.mr_iid === 'number' ? body.mr_iid : parseInt(String(body.mr_iid), 10);
    } else if (typeof body.mr_url === 'string' && body.mr_url.trim()) {
      iid = extractIidFromUrl(body.mr_url.trim());
    }
    if (!iid || !Number.isFinite(iid) || iid < 1) {
      return json({
        error: 'mr_iid (number) or mr_url (GitLab MR URL) is required'
      }, 400);
    }
    // ── 1. Fetch MR metadata ──────────────────────────────────────────────
    const mrRes = await gl(buildMrMetadataPath(iid));
    if (mrRes.status === 404) {
      return json({
        ok: false,
        error: `MR !${iid} not found in this project`
      }, 404);
    }
    if (!mrRes.ok) {
      return json({
        ok: false,
        error: `GitLab MR API returned ${mrRes.status}`
      }, 502);
    }
    const mrData = await mrRes.json();
    const mr = {
      iid: mrData.iid,
      title: mrData.title,
      state: mrData.state,
      draft: mrData.draft ?? (typeof mrData.title === 'string' && /^draft:/i.test(mrData.title)),
      description: typeof mrData.description === 'string' ? mrData.description.slice(0, 8000) : null,
      source_branch: mrData.source_branch,
      target_branch: mrData.target_branch,
      author: mrData.author && typeof mrData.author === 'object' ? {
        username: mrData.author.username,
        name: mrData.author.name
      } : null,
      labels: Array.isArray(mrData.labels) ? mrData.labels : [],
      web_url: mrData.web_url,
      created_at: mrData.created_at,
      updated_at: mrData.updated_at,
      merged_by: mrData.merged_by && typeof mrData.merged_by === 'object' ? mrData.merged_by.username : null,
      merged_at: mrData.merged_at ?? null,
      has_conflicts: mrData.has_conflicts ?? null,
      changes_count: mrData.changes_count ?? null
    };
    // ── 2. Fetch the diff / changed-file list ─────────────────────────────
    // Use the MR diffs endpoint (paginated, up to 100 files per page).
    // Fetch ALL pages (bounded by MAX_DIFF_PAGES) so a multi-file MR is not
    // silently reduced to its first 100 files — the old page-1-only limit
    // was a core cause of the blind reviewer.
    let diffData = {
      changed_files: 0,
      files: [],
      truncated: false
    };
    const rawDiffs = [];
    let diffFetchOk = false;
    let pagesTruncated = false;
    for(let page = 1; page <= MAX_DIFF_PAGES; page++){
      const pageRes = await gl(`${buildMrDiffsPath(iid)}&page=${page}`);
      if (!pageRes.ok) break;
      diffFetchOk = true;
      const pageRows = await pageRes.json();
      if (!Array.isArray(pageRows) || pageRows.length === 0) break;
      rawDiffs.push(...pageRows);
      // A short page (< per_page) is the last page.
      if (pageRows.length < 100) break;
      // Hit the page ceiling with a full final page — more may remain.
      if (page === MAX_DIFF_PAGES) pagesTruncated = true;
    }
    if (diffFetchOk) {
      let totalChars = 0;
      const files = [];
      for (const d of rawDiffs){
        const rawDiff = typeof d.diff === 'string' ? d.diff : '';
        const redacted = redactSecretLines(rawDiff);
        // Truncate per-file diff
        const fileDiff = redacted.length > MAX_PER_FILE_DIFF_CHARS ? redacted.slice(0, MAX_PER_FILE_DIFF_CHARS) + `\n... [truncated, ${redacted.length - MAX_PER_FILE_DIFF_CHARS} more chars]` : redacted;
        const file = {
          path: d.new_path ?? d.old_path,
          status: d.new_file ? 'added' : d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified'
        };
        if (d.renamed_file && d.old_path !== d.new_path) {
          file.renamed_from = d.old_path;
        }
        // Check total budget — break on first exceed so omitted diffs are
        // contiguous from this point onward (no confusing included/omitted/included).
        if (totalChars + fileDiff.length > MAX_DIFF_CHARS) {
          file.diff = '[diff omitted — total diff budget exceeded]';
          files.push(file);
          // Mark remaining files as omitted too
          for (const remaining of rawDiffs.slice(rawDiffs.indexOf(d) + 1)){
            const remFile = {
              path: remaining.new_path ?? remaining.old_path,
              status: remaining.new_file ? 'added' : remaining.deleted_file ? 'deleted' : remaining.renamed_file ? 'renamed' : 'modified',
              diff: '[diff omitted — total diff budget exceeded]'
            };
            if (remaining.renamed_file && remaining.old_path !== remaining.new_path) {
              remFile.renamed_from = remaining.old_path;
            }
            files.push(remFile);
          }
          diffData.truncated = true;
          break;
        }
        file.diff = fileDiff;
        totalChars += fileDiff.length;
        files.push(file);
      }
      diffData = {
        changed_files: rawDiffs.length,
        files,
        truncated: diffData.truncated || pagesTruncated
      };
    }
    // ── 3. Fetch head pipeline status + failing jobs ──────────────────────
    let pipeline = null;
    // The MR object includes head_pipeline if available
    const headPipeline = mrData.head_pipeline;
    if (headPipeline && typeof headPipeline === 'object') {
      const pipelineId = headPipeline.id;
      pipeline = {
        id: pipelineId,
        status: headPipeline.status,
        web_url: headPipeline.web_url,
        failing_jobs: []
      };
      // If pipeline is not success, fetch failing jobs
      if (headPipeline.status !== 'success' && pipelineId) {
        try {
          const jobsRes = await gl(`/pipelines/${pipelineId}/jobs?scope[]=failed&per_page=20`);
          if (jobsRes.ok) {
            const jobs = await jobsRes.json();
            pipeline.failing_jobs = jobs.map((j)=>({
                name: j.name,
                stage: j.stage,
                status: j.status,
                web_url: j.web_url
              }));
          }
        } catch (_e) {
          // Best-effort: failing jobs are advisory, not critical
          console.warn('[bob-review-merge-request] failed to fetch failing jobs:', _e);
        }
      }
    }
    // ── 4. Returned-identity echo ────────────────────────────────────────
    // First-class fields so the caller (conductor / Bob) can verify the
    // fetched MR matches the requested one. Detects wrong-room bugs where
    // the iid resolves against a different project or a stale/cached ref.
    const rawFetchedIid = typeof mr.iid === 'number' ? mr.iid : parseInt(String(mr.iid), 10);
    // Guard: parseInt yields NaN when mr.iid is undefined/null/garbage.
    // A non-finite fetched iid must be treated as "could not determine",
    // not silently fed into checkIdentityMatch where it would produce a
    // false mismatch (NaN === anything is always false). checkIdentityMatch
    // also guards for NaN, but catching it here produces a clear log line.
    const fetchedIid = Number.isFinite(rawFetchedIid) ? rawFetchedIid : null;
    if (fetchedIid === null) {
      console.warn(`[bob-review-merge-request] could not determine fetched iid from mr.iid=${mr.iid}`);
    }
    const identity = checkIdentityMatch(iid, fetchedIid);
    if (!identity.match) {
      console.warn(`[bob-review-merge-request] IDENTITY MISMATCH: requested iid=${iid}, fetched iid=${fetchedIid}`);
    }
    // B2: fetch comments + commits, degrade gracefully on failure.
    let notes = [];
    if (body.include_comments !== false) {
      try {
        const notesRes = await gl(`/merge_requests/${iid}/notes?sort=desc&order_by=created_at&per_page=50`);
        if (notesRes.ok) {
          const raw = await notesRes.json();
          notes = raw.map((n)=>({
              id: n.id,
              author: n.author && typeof n.author === 'object' ? {
                username: n.author.username
              } : null,
              body: typeof n.body === 'string' ? n.body.slice(0, 2000) : null,
              created_at: n.created_at,
              system: n.system ?? false,
              resolved: n.resolved ?? null
            }));
        }
      } catch (_e) {
        console.warn('[bob-review-merge-request] notes fetch failed (non-fatal)');
      }
    }
    let commits = [];
    if (body.include_commits !== false) {
      try {
        const commitsRes = await gl(`/merge_requests/${iid}/commits?per_page=20`);
        if (commitsRes.ok) {
          const raw = await commitsRes.json();
          commits = raw.map((c)=>({
              short_id: c.short_id,
              title: c.title,
              author_name: c.author_name,
              authored_date: c.authored_date
            }));
        }
      } catch (_e) {
        console.warn('[bob-review-merge-request] commits fetch failed (non-fatal)');
      }
    }
    return json({
      ok: true,
      requested_iid: iid,
      fetched_iid: fetchedIid,
      fetched_title: mr.title,
      fetched_source_branch: mr.source_branch,
      fetched_target_branch: mr.target_branch,
      identity_match: identity.match,
      mr,
      diff: diffData,
      pipeline,
      notes,
      commits
    });
  } catch (err) {
    console.error('[bob-review-merge-request] error:', err);
    return json({
      ok: false,
      error: 'MR review failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

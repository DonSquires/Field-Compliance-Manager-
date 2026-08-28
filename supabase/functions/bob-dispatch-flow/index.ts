/**
 * bob-dispatch-flow -- Governed GitLab Duo flow dispatch (issue #234, step 1b)
 *
 * Thin edge function that authenticates the caller, enforces ADMIRAL-ONLY
 * server-side (defence in depth -- the conductor gate also checks), and
 * invokes the Duo Workflows API to start a coding flow (developer,
 * fix_pipeline, code_review).
 *
 * The dispatch logic mirrors scripts/bob/flow-dispatcher.mjs (the proven
 * CI path that returned HTTP 201 with workflow_definition='software_development'
 * in job 15661942396). This edge function reuses the same API endpoint and
 * parameters -- it does NOT reimplement the Duo API call from scratch.
 *
 * GOVERNANCE (owner rulings, FIXED):
 *   - ADMIRAL ONLY (grand_master). Defence-in-depth: the conductor gate
 *     restricts dispatch_flow to admiral tier, AND this edge function
 *     independently verifies the caller is grand_master before proceeding.
 *   - Output always lands as a DRAFT MR. Bob NEVER merges.
 *   - The conductor dispatches this ONLY after human confirmation (propose/
 *     confirm two-turn pattern). This edge function is the execution step.
 *
 * Body: {
 *   flow: 'developer' | 'fix_pipeline' | 'code_review',
 *   goal: string,       // short goal (max 500 chars)
 *   brief: string,      // full dispatch brief (max 8000 chars)
 *   project_id?: string // defaults to GITLAB_PROJECT_ID env
 * }
 *
 * Response: {
 *   ok: boolean,
 *   workflow_id: string | null,
 *   workflow_url: string | null,
 *   error?: string
 * }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GITLAB_TOKEN = Deno.env.get('GITLAB_TOKEN') ?? '';
const GITLAB_PROJECT_ID = Deno.env.get('GITLAB_PROJECT_ID') ?? '';
const GITLAB_API_URL = (Deno.env.get('GITLAB_API_URL') ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Valid flow types and their Duo workflow_definition mappings.
// 'software_development' is CONFIRMED (job 15661942396 returned HTTP 201).
// 'fix_pipeline' and 'code_review' are UNVERIFIED -- kept but noted.
const FLOW_TO_DEFINITION = {
  developer: 'software_development',
  fix_pipeline: 'fix_pipeline',
  code_review: 'code_review'
};
const VALID_FLOWS = Object.keys(FLOW_TO_DEFINITION);
const MAX_GOAL_CHARS = 500;
const MAX_BRIEF_CHARS = 8000;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    // -- 1. Authenticate caller -----------------------------------------------
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
    // -- 2. Resolve role + enforce ADMIRAL ONLY (defence in depth) -----------
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    const dbRole = String(profile?.role ?? 'guest');
    const userEmail = (user.email ?? '').toLowerCase().trim();
    const effectiveRole = resolveEffectiveRole(userEmail, dbRole);
    if (effectiveRole !== 'grand_master') {
      return json({
        ok: false,
        error: 'dispatch_flow is restricted to admiral (grand_master) only.',
        workflow_id: null,
        workflow_url: null
      }, 403);
    }
    // -- 3. Parse and validate request body ------------------------------------
    const body = await req.json().catch(()=>({}));
    const flow = String(body.flow ?? '').trim();
    if (!VALID_FLOWS.includes(flow)) {
      return json({
        ok: false,
        error: `Invalid flow '${flow}'. Must be one of: ${VALID_FLOWS.join(', ')}`,
        workflow_id: null,
        workflow_url: null
      }, 400);
    }
    const goal = String(body.goal ?? '').trim().slice(0, MAX_GOAL_CHARS);
    if (!goal) {
      return json({
        ok: false,
        error: 'goal is required (non-empty string describing the task)',
        workflow_id: null,
        workflow_url: null
      }, 400);
    }
    let brief = String(body.brief ?? '').trim();
    if (!brief) {
      return json({
        ok: false,
        error: 'brief is required (non-empty string with the full dispatch brief)',
        workflow_id: null,
        workflow_url: null
      }, 400);
    }
    if (brief.length > MAX_BRIEF_CHARS) {
      brief = brief.slice(0, MAX_BRIEF_CHARS - 80) + `\n\n[... truncated at ${MAX_BRIEF_CHARS} chars]`;
    }
    const projectId = String(body.project_id ?? GITLAB_PROJECT_ID).trim();
    // -- 4. Validate infra env vars --------------------------------------------
    if (!GITLAB_TOKEN) {
      return json({
        ok: false,
        error: 'GITLAB_TOKEN is not configured. Fail-closed.',
        workflow_id: null,
        workflow_url: null
      }, 500);
    }
    if (!projectId) {
      return json({
        ok: false,
        error: 'GITLAB_PROJECT_ID is not configured and no project_id was provided.',
        workflow_id: null,
        workflow_url: null
      }, 500);
    }
    // -- 5. Dispatch the Duo flow ----------------------------------------------
    // Mirrors the proven path from scripts/bob/flow-dispatcher.mjs:
    //   POST /api/v4/ai/duo_workflows/workflows
    const workflowDefinition = FLOW_TO_DEFINITION[flow];
    const endpoint = `${GITLAB_API_URL}/ai/duo_workflows/workflows`;
    // The brief is the substance; prefix the short goal for list readability.
    // Pass the FULL brief -- no truncation on the conductor->edge path.
    const flowGoal = `${goal}\n\n${brief}`.slice(0, MAX_GOAL_CHARS + MAX_BRIEF_CHARS);
    const requestBody = {
      project_id: projectId,
      workflow_definition: workflowDefinition,
      goal: flowGoal,
      start_workflow: true
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': GITLAB_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    const rawBody = await resp.text().catch(()=>'(no body)');
    if (!resp.ok) {
      return json({
        ok: false,
        error: `Duo flow create failed (HTTP ${resp.status}): ${rawBody.slice(0, 800)}`,
        workflow_id: null,
        workflow_url: null,
        http_status: resp.status
      }, 502);
    }
    // -- 6. Extract workflow reference from response -------------------------
    // The Duo API 201 response shape (confirmed from job 15661942396):
    //   { id: <string>, ... } -- web_url was NOT present in the real response.
    // Construct a usable workflow URL from the id and gitlab_url fields,
    // or fall back to a project-relative path.
    let parsed = {};
    try {
      parsed = JSON.parse(rawBody);
    } catch  {
      parsed = {};
    }
    const workflowId = String(parsed.id ?? parsed.workflow_id ?? parsed.workflowId ?? '') || null;
    // Build a usable URL: prefer gitlab_url if present, otherwise construct
    // from the project path. The Duo API response had no web_url field.
    const gitlabUrl = parsed.gitlab_url ?? parsed.web_url ?? null;
    let workflowUrl = null;
    if (typeof gitlabUrl === 'string' && gitlabUrl.trim()) {
      workflowUrl = gitlabUrl.trim();
    } else if (workflowId) {
      // Construct a reference URL from the project and workflow id
      workflowUrl = `https://gitlab.com/-/duo_workflows/${workflowId}`;
    }
    return json({
      ok: true,
      workflow_id: workflowId,
      workflow_url: workflowUrl,
      flow,
      workflow_definition: workflowDefinition
    });
  } catch (err) {
    console.error('[bob-dispatch-flow] error:', err);
    return json({
      ok: false,
      error: 'Internal error in bob-dispatch-flow',
      workflow_id: null,
      workflow_url: null
    }, 500);
  }
});

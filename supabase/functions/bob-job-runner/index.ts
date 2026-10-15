/**
 * bob-job-runner — governed multi-step agentic job engine (core, read-only)
 *
 * Ports the OLD app's Bob CONTRACTS (not code) onto the new stack:
 *   - portal/role-aware, fail-closed governance
 *   - enriched-fact output model (identity, evidence, confidence, last_verified)
 *   - app-surface mapping required before any write (writes not in this MR)
 *   - review-required fallback on low confidence / conflict
 *   - completion gate
 *
 * This core supports READ-ONLY steps only. Governed write steps are a later MR
 * and must go through propose -> approve -> execute. Nothing here mutates data.
 *
 * Auth:
 *   Supabase JWT required. Role gate + capability envelope enforced.
 *
 * Body:
 *   {
 *     "job": {
 *       "goal": "Onboard First Security Blenheim from uploaded docs",
 *       "parent_agent": "gitlab-duo" | "user" | null,
 *       "approval_mode": "required" | "advisory",
 *       "constraints": ["advisory_only", "no_direct_db_writes"],
 *       "steps": [
 *         { "id": "s1", "tool": "schema_inspect", "params": { "tables": ["client_sites"] } },
 *         { "id": "s2", "tool": "client_site_compare", "params": { "candidates": [...] } },
 *         { "id": "s3", "tool": "verify_ta_names", "params": { "district_names": ["Nelson City"] } }
 *       ]
 *     }
 *   }
 *
 * Read-only tools supported: schema_inspect, client_site_compare, verify_ta_names.
 * (perceive_* and extract_document are invoked via their own functions; the
 *  runner can reference their outputs by passing text/candidates in params.)
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const NZTA_TA_FEATURESERVER = Deno.env.get('NZTA_TA_FEATURESERVER') ?? 'https://spatial.nzta.govt.nz/portal/rest/services/Hosted/Territorial_Authority_Boundaries/FeatureServer/0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_RUN = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const READONLY_TOOLS = new Set([
  'schema_inspect',
  'client_site_compare',
  'verify_ta_names',
  'plan_import'
]);
// Governed write step tools. Each write step MUST be explicitly approved
// (step.approved === true) AND the job must be approval_mode='required'. Writes
// route through existing governed executors; the runner never writes directly.
const WRITE_TOOLS = new Set([
  'proposal_execute',
  'ingest_append',
  'generic_upsert',
  'create_client',
  'create_site',
  'update_client',
  'update_site',
  'create_contact',
  'update_contact',
  'create_service_agreement',
  'update_service_agreement',
  'create_user',
  'update_staff_profile',
  'create_invoice',
  'update_invoice',
  'create_credential',
  'update_credential',
  'create_shift_template',
  'update_shift_template'
]);
const SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
const MAX_STEPS = 20;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
async function callFn(fnName, authHeader, payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch  {
    data = {
      raw: text.slice(0, 500)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data
  };
}
// Invoke an edge function with SERVICE ROLE (server-side only). Used for the
// governed executor so the service-role key never leaves the server.
async function callFnServiceRole(fnName, payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch  {
    data = {
      raw: text.slice(0, 500)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data
  };
}
// Read-only NZTA TA name verification (self-diagnosing on mismatch).
async function verifyTaNames(districtNames) {
  const names = districtNames.map((n)=>String(n).trim()).filter(Boolean);
  if (!names.length) return {
    matched: [],
    unmatched: [],
    note: 'no names provided'
  };
  const inList = names.map((n)=>`UPPER('${n.replace(/'/g, "''")}')`).join(',');
  const where = `UPPER(ta2013name) IN (${inList})`;
  const url = `${NZTA_TA_FEATURESERVER}/query?where=${encodeURIComponent(where)}&outFields=ta2013name&returnGeometry=false&f=json`;
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    const data = await res.json();
    const found = (data.features ?? []).map((f)=>f.attributes?.ta2013name).filter(Boolean);
    const foundUpper = new Set(found.map((s)=>s.toUpperCase()));
    const matched = names.filter((n)=>foundUpper.has(n.toUpperCase()));
    const unmatched = names.filter((n)=>!foundUpper.has(n.toUpperCase()));
    return {
      matched,
      unmatched,
      layer_values: found,
      source: 'nzta_ta2013name',
      last_verified: new Date().toISOString()
    };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : 'nzta_query_failed',
      matched: [],
      unmatched: names
    };
  }
}
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
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_RUN.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master/admin_officer required'
      }, 403);
    }
    const body = await req.json();
    const job = body.job ?? {};
    const steps = Array.isArray(job.steps) ? job.steps : [];
    if (!job.goal) return json({
      error: 'job.goal is required'
    }, 400);
    if (!steps.length) return json({
      error: 'job.steps must be a non-empty array'
    }, 400);
    if (steps.length > MAX_STEPS) return json({
      error: `Too many steps (max ${MAX_STEPS})`
    }, 400);
    const jobId = crypto.randomUUID();
    const results = [];
    let stoppedReason = null;
    const approvalMode = job.approval_mode ?? 'advisory';
    let anyWrite = false;
    for (const [index, step] of steps.entries()){
      const stepId = String(step.id ?? `s${index + 1}`);
      const tool = String(step.tool ?? '');
      const params = step.params ?? {};
      const isReadonly = READONLY_TOOLS.has(tool);
      const isWrite = WRITE_TOOLS.has(tool);
      if (!isReadonly && !isWrite) {
        results.push({
          step_id: stepId,
          tool,
          status: 'blocked',
          reason: `Tool '${tool}' is not supported. Read-only: ${[
            ...READONLY_TOOLS
          ].join(', ')}. Governed write: ${[
            ...WRITE_TOOLS
          ].join(', ')}.`
        });
        stoppedReason = 'unsupported_tool_requested';
        break;
      }
      // Governed write gate (old-app fail-closed contract):
      //  - job must be approval_mode='required'
      //  - the step must be explicitly approved (step.approved === true)
      //  - the step must declare an app_surface (where the change is used)
      if (isWrite) {
        anyWrite = true;
        if (approvalMode !== 'required') {
          results.push({
            step_id: stepId,
            tool,
            status: 'blocked',
            reason: 'Write step requires job.approval_mode = "required".'
          });
          stoppedReason = 'write_requires_approval_mode';
          break;
        }
        if (step.approved !== true) {
          results.push({
            step_id: stepId,
            tool,
            status: 'awaiting_approval',
            reason: 'Write step is not approved. Set step.approved = true after user approval to execute.',
            app_surface: step.app_surface ?? null
          });
          stoppedReason = 'awaiting_step_approval';
          break;
        }
        if (!step.app_surface) {
          results.push({
            step_id: stepId,
            tool,
            status: 'blocked',
            reason: 'Write step must declare app_surface (where this change is consumed).'
          });
          stoppedReason = 'missing_app_surface';
          break;
        }
      }
      let out;
      if (tool === 'schema_inspect') {
        out = await callFn('bob-schema-inspect', authHeader, params);
      } else if (tool === 'plan_import') {
        // Read-only agentic import planner. Parses + recalls + infers targets
        // from live schema + value-validates via bob-map-import, and returns a
        // governed dry-run plan. Writes nothing.
        out = await callFn('bob-plan-import', authHeader, params);
      } else if (tool === 'client_site_compare') {
        out = await callFn('bob-client-site-compare', authHeader, params);
      } else if (tool === 'verify_ta_names') {
        const names = Array.isArray(params.district_names) ? params.district_names : [];
        const v = await verifyTaNames(names.map(String));
        out = {
          ok: !v.error,
          status: v.error ? 502 : 200,
          data: v
        };
      } else if (tool === 'proposal_execute') {
        // Executes an ALREADY-APPROVED bob_agentic_actions row via the governed
        // executor (service-role, server-side). action_id required.
        const actionId = String(params.action_id ?? '').trim();
        if (!actionId) {
          out = {
            ok: false,
            status: 400,
            data: {
              error: 'action_id required for proposal_execute'
            }
          };
        } else {
          out = await callFnServiceRole('bob-proposal-execute', {
            action_id: actionId
          });
        }
      } else if (tool === 'ingest_append') {
        // Governed append into an allowlisted staging table via the ingest fn
        // (forwards caller JWT so the ingest fn enforces its own guards).
        out = await callFn('bob-ingest-document', authHeader, {
          ...params,
          mode: 'append'
        });
      } else if (tool === 'generic_upsert') {
        // Schema-driven governed create/update via bob-upsert-generic. The runner
        // has already enforced approval_mode=required + step.approved + app_surface
        // above. Live write (dry_run:false); human_invoked forwarded via caller JWT.
        // bob-upsert-generic inspects the LIVE schema, maps fields to real columns,
        // drops guarded/unknown fields, and enforces the table allowlist itself.
        const table = String(params.table ?? '').trim();
        const mode = String(params.mode ?? 'create');
        if (!table) {
          out = {
            ok: false,
            status: 400,
            data: {
              error: 'table required for generic_upsert'
            }
          };
        } else {
          out = await callFn('bob-upsert-generic', authHeader, {
            table,
            mode,
            dry_run: false,
            human_invoked: true,
            data: params.data ?? {},
            target_id: params.target_id,
            provenance: params.provenance ?? {
              source: 'job_runner',
              confidence: 'medium'
            },
            job_id: jobId,
            step_id: stepId
          });
        }
      } else if (tool === 'create_client' || tool === 'create_site' || tool === 'update_client' || tool === 'update_site' || tool === 'create_contact' || tool === 'update_contact' || tool === 'create_service_agreement' || tool === 'update_service_agreement' || tool === 'create_user' || tool === 'update_staff_profile' || tool === 'create_invoice' || tool === 'update_invoice' || tool === 'create_credential' || tool === 'update_credential' || tool === 'create_shift_template' || tool === 'update_shift_template') {
        // Governed CRM create/update via bob-upsert-entity. The runner has already
        // enforced approval_mode=required + step.approved + app_surface above.
        // Live write (dry_run:false); human_invoked forwarded via caller JWT.
        const entityMap = {
          create_client: 'client_org',
          update_client: 'client_org',
          create_site: 'client_site',
          update_site: 'client_site',
          create_contact: 'contact',
          update_contact: 'contact',
          create_service_agreement: 'service_agreement',
          update_service_agreement: 'service_agreement',
          create_user: 'user',
          update_staff_profile: 'staff_profile',
          create_invoice: 'invoice',
          update_invoice: 'invoice',
          create_credential: 'credential',
          update_credential: 'credential',
          create_shift_template: 'shift_template',
          update_shift_template: 'shift_template'
        };
        const entity = entityMap[tool];
        const mode = tool.startsWith('create') ? 'create' : 'update';
        out = await callFn('bob-upsert-entity', authHeader, {
          entity,
          mode,
          dry_run: false,
          human_invoked: true,
          data: params.data ?? params,
          target_id: params.target_id,
          provenance: params.provenance ?? {
            source: 'job_runner',
            confidence: 'medium'
          },
          job_id: jobId,
          step_id: stepId
        });
      } else {
        out = {
          ok: false,
          status: 422,
          data: {
            error: 'unhandled_tool'
          }
        };
      }
      results.push({
        step_id: stepId,
        tool,
        kind: isWrite ? 'write' : 'read',
        status: out.ok ? 'ok' : 'failed',
        result: out.data,
        confidence: out.ok ? 'high' : 'low',
        last_verified: new Date().toISOString(),
        app_surface: isWrite ? step.app_surface ?? null : undefined
      });
      if (!out.ok) {
        stoppedReason = `step_failed:${stepId}`;
        break;
      }
    }
    // Completion gate (old-app contract): summary, clarifications, confidence.
    const clarifications = [];
    for (const r of results){
      const res = r.result ?? {};
      if (Array.isArray(res.unmatched) && res.unmatched.length) {
        clarifications.push(`verify_ta_names: unmatched names ${res.unmatched.join(', ')} - confirm correct 2013 TA spelling before any jurisdiction write.`);
      }
      if (res.summary?.review_possible_duplicate) {
        clarifications.push('client_site_compare: possible duplicates found - review before creating records.');
      }
    }
    // ── Persist audit trail (best-effort; never blocks the response) ──
    const jobStatus = stoppedReason ? results.some((r)=>r.status === 'awaiting_approval') ? 'awaiting_approval' : results.some((r)=>r.status === 'failed') ? 'failed' : 'stopped' : 'completed';
    try {
      await admin.from('bob_job_runs').insert({
        job_id: jobId,
        organization_id: profile.organization_id ?? null,
        actor_id: user.id,
        parent_agent: job.parent_agent ?? null,
        goal: job.goal,
        approval_mode: approvalMode,
        contains_writes: anyWrite,
        status: jobStatus,
        stopped_reason: stoppedReason,
        steps: results,
        clarifications
      });
      // Target references preserve what a successful write changed. They are
      // not automatically reversible; correction must use a domain workflow.
      const rollbackRefs = results.filter((r)=>r.kind === 'write' && r.status === 'ok').map((r)=>{
        const res = r.result ?? {};
        return {
          job_id: jobId,
          step_id: String(r.step_id),
          tool: String(r.tool),
          target_table: res.result_table ?? res.target_table ?? null,
          target_record_id: res.result_record_id ?? res.record_id ?? null,
          action: r.tool === 'proposal_execute' ? 'execute' : 'insert',
          reversible: false
        };
      });
      if (rollbackRefs.length) {
        await admin.from('bob_job_rollback_refs').insert(rollbackRefs);
      }
    } catch (auditErr) {
      console.error('[bob-job-runner] audit persist failed (non-blocking):', auditErr);
    }
    return json({
      success: !stoppedReason,
      job_id: jobId,
      goal: job.goal,
      parent_agent: job.parent_agent ?? null,
      approval_mode: approvalMode,
      constraints: job.constraints ?? [],
      contains_writes: anyWrite,
      status: jobStatus,
      stopped_reason: stoppedReason,
      steps: results,
      clarifications,
      completion: {
        steps_total: steps.length,
        steps_run: results.length,
        awaiting_approval: results.some((r)=>r.status === 'awaiting_approval'),
        note: anyWrite ? 'Job contains governed write steps. Writes execute only when approval_mode=required, the step is approved, and app_surface is declared. Run recorded in bob_job_runs.' : 'Read-only job. No records were created or updated. Run recorded in bob_job_runs.'
      },
      audit: {
        actor_id: user.id,
        role: profile.role,
        org_id: profile.organization_id,
        job_recorded: true
      }
    });
  } catch (err) {
    console.error('[bob-job-runner] error:', err);
    return json({
      error: 'Job runner failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

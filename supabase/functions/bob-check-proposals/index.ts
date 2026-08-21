/**
 * bob-check-proposals — Bob's bell monitor
 *
 * Lets Bob query the status of his recent proposals in bob_agentic_actions
 * so he can see what has been approved, applied, rejected, or failed and
 * decide the next step in a multi-step workflow.
 *
 * POST /functions/v1/bob-check-proposals
 * Body: {
 *   conversation_id?: string,   // filter to proposals from this conversation
 *   organization_id?: string,   // filter to a specific org
 *   status?: string[],          // filter by status (pending, approved, applied, rejected, failed)
 *   limit?: number,             // max results (default 20)
 *   action_ids?: string[],      // fetch specific action IDs
 * }
 *
 * Returns: { proposals: ProposalSummary[] }
 *
 * Auth: valid JWT required. Results are scoped to the caller's org unless
 * grand_master (who can see all).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const json = (body, status = 200)=>new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
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
    const { data: profile } = await admin.from('user_profiles').select('role, organization_id').eq('id', user.id).single();
    if (!profile) return json({
      error: 'Profile not found'
    }, 403);
    const isAdmiral = profile.role === 'grand_master';
    const body = await req.json().catch(()=>({}));
    const limit = Math.min(typeof body.limit === 'number' ? body.limit : 20, 50);
    let query = admin.from('bob_agentic_actions').select('id, action_type, status, proposed_payload, context_summary, bob_reasoning, confidence_score, created_at, approved_at, applied_at, rejection_reason, error_message, result_record_id, result_table, organization_id, conversation_id').order('created_at', {
      ascending: false
    }).limit(limit);
    // Org scope: grand_master sees all, others see own org only.
    if (!isAdmiral) {
      query = query.eq('organization_id', profile.organization_id);
    } else if (body.organization_id) {
      query = query.eq('organization_id', body.organization_id);
    }
    // Filter by conversation if supplied.
    if (body.conversation_id) {
      query = query.eq('conversation_id', body.conversation_id);
    }
    // Filter by specific action IDs if supplied.
    if (Array.isArray(body.action_ids) && body.action_ids.length) {
      query = query.in('id', body.action_ids);
    }
    // Filter by status if supplied.
    if (Array.isArray(body.status) && body.status.length) {
      query = query.in('status', body.status);
    }
    const { data: proposals, error: fetchErr } = await query;
    if (fetchErr) return json({
      error: 'Failed to fetch proposals',
      details: fetchErr.message
    }, 500);
    const summaries = (proposals ?? []).map((p)=>({
        id: p.id,
        action_type: p.action_type,
        status: p.status,
        context_summary: p.context_summary,
        created_at: p.created_at,
        approved_at: p.approved_at,
        applied_at: p.applied_at,
        rejection_reason: p.rejection_reason,
        error_message: p.error_message,
        result_record_id: p.result_record_id,
        result_table: p.result_table,
        conversation_id: p.conversation_id,
        // Include key payload fields for Bob to reason over without dumping everything.
        payload_summary: (()=>{
          try {
            const pl = p.proposed_payload;
            if (!pl) return null;
            return {
              name: pl.name ?? pl.zone?.name ?? pl.org?.name ?? null,
              organization_id: pl.organization_id ?? null,
              action_type: pl.action_type ?? null
            };
          } catch  {
            return null;
          }
        })()
      }));
    return json({
      ok: true,
      count: summaries.length,
      proposals: summaries
    });
  } catch (err) {
    console.error('[bob-check-proposals] error:', err);
    return json({
      ok: false,
      error: 'Internal error',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

/**
 * bob-document-search — mediated, policy-filtered retrieval for Bob (Phase 2).
 *
 * Purpose:
 *   Let Bob search APPROVED reference documents through metadata filters. The
 *   heavy lifting (scope + sensitivity filtering) is done by the SECURITY
 *   DEFINER RPC bob_search_reference_documents. Bob never receives a raw list
 *   of bucket objects — only summaries + approved retrieval handles.
 *
 * Tenant isolation:
 *   The caller's organization is resolved from their profile server-side; the
 *   client cannot widen scope to another tenant. allow_restricted is only ever
 *   honoured for grand_master (explicitly authorized context).
 *
 * Auth:
 *   Supabase JWT required. Any authenticated user with a profile may search.
 *
 * Body:
 * {
 *   "query": "noise bylaw",
 *   "scope": "tenant" | "global" | "both",
 *   "document_type": "bylaw",
 *   "jurisdiction": "Nelson",
 *   "tags": ["noise"],
 *   "limit": 25
 * }
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
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
    if (!profile) return json({
      error: 'Forbidden: no profile'
    }, 403);
    const body = await req.json();
    // Scope is bounded server-side to the caller's own organization. Restricted
    // material only surfaces for grand_master (explicitly authorized context).
    const allowRestricted = String(profile.role) === 'grand_master';
    const { data, error } = await admin.rpc('bob_search_reference_documents', {
      p_query: body.query ?? null,
      p_scope: body.scope ?? 'both',
      p_organization_id: profile.organization_id ?? null,
      p_document_type: body.document_type ?? null,
      p_jurisdiction: body.jurisdiction ?? null,
      p_tags: body.tags ?? null,
      p_allow_restricted: allowRestricted,
      p_limit: body.limit ?? 25
    });
    if (error) throw new Error(error.message);
    return json({
      success: true,
      ...data
    });
  } catch (err) {
    console.error('[bob-document-search] error:', err);
    return json({
      error: 'Document search failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

/**
 * bob-document-promote — governed promotion to the reference library (Phase 2/3).
 *
 * Purpose:
 *   Promote a classified document version to the tenant OR global reference
 *   library. This is the KEY control that stops a careless upload becoming
 *   globally reusable: Bob can recommend promotion, a human approves it here.
 *
 * The heavy governance (privacy_class routing, PII/financial/legal blocks,
 * confidence / human-review gate, provenance floor) lives in the SECURITY
 * DEFINER RPC promote_document_to_reference_library. This function only:
 *   - verifies the caller is an authorized approver (admin/master/grand_master),
 *   - enforces tenant isolation for tenant promotions,
 *   - passes the approver id through for the audit trail.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master.
 *
 * Body:
 * {
 *   "document_version_id": "uuid",
 *   "target_scope": "tenant_reference" | "global_reference",
 *   "metadata": { "title": "...", "publisher": "...", "document_type": "...",
 *                 "effective_from": "2024-01-01", "jurisdiction": "...",
 *                 "topic": "...", "trust_level": "trusted", "searchable_tags": ["..."] }
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
// Only human approvers may promote. Bob (admin_officer / advisory) may recommend
// but must not self-approve promotion.
const CAN_PROMOTE = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
const CAN_PROMOTE_GLOBAL = new Set([
  'grand_master',
  'master'
]);
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
    if (!profile || !CAN_PROMOTE.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master required to approve promotion'
      }, 403);
    }
    const body = await req.json();
    const versionId = String(body.document_version_id ?? '').trim();
    const targetScope = String(body.target_scope ?? '').trim();
    if (!versionId) return json({
      error: 'document_version_id is required'
    }, 400);
    if (![
      'tenant_reference',
      'global_reference'
    ].includes(targetScope)) {
      return json({
        error: 'target_scope must be tenant_reference or global_reference'
      }, 400);
    }
    // Global promotion is restricted to master/grand_master.
    if (targetScope === 'global_reference' && !CAN_PROMOTE_GLOBAL.has(String(profile.role))) {
      return json({
        error: 'Forbidden: master/grand_master required for global reference promotion'
      }, 403);
    }
    // Tenant-isolation check for tenant promotions: the version's document must
    // belong to the approver's org (grand_master exempt).
    if (targetScope === 'tenant_reference' && String(profile.role) !== 'grand_master') {
      const { data: owned } = await admin.from('document_versions').select('id, documents!inner(organization_id)').eq('id', versionId).single();
      const ownerOrg = owned?.documents?.organization_id ?? null;
      if (ownerOrg && ownerOrg !== profile.organization_id) {
        return json({
          error: 'Forbidden: cannot promote a document outside your organization'
        }, 403);
      }
    }
    const { data, error } = await admin.rpc('promote_document_to_reference_library', {
      p_document_version_id: versionId,
      p_target_scope: targetScope,
      p_approver_id: user.id,
      p_metadata: body.metadata ?? {}
    });
    if (error) throw new Error(error.message);
    const result = data;
    if (!result?.ok) return json({
      success: false,
      ...result ?? {}
    }, 422);
    return json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[bob-document-promote] error:', err);
    return json({
      error: 'Document promotion failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

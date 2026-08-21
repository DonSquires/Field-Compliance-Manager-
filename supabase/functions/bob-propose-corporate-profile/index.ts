/**
 * bob-propose-corporate-profile — governed producer for an org's corporate
 * standing (registration number/NZBN, corporate status, directors/shareholders).
 *
 * POST /functions/v1/bob-propose-corporate-profile
 * Body: {
 *   organization_id,               // EXPLICIT id (resolved by name via
 *                                   // bob-query-records find_org BEFORE this call
 *                                   // — identity discipline, same as every other
 *                                   // propose-* producer: never resolved by name here)
 *   company_registration_number?, nzbn?,
 *   corporate_status?,             // 'registered' | 'removed' | 'in_liquidation' | 'receivership' | 'unknown'
 *   corporate_status_as_of?,       // ISO timestamp — registry data drifts; never presented as real-time
 *   officers?: [ { officer_role, full_name, address_for_service?, contact_email?,
 *                  contact_phone?, shareholding_percentage?, source?, source_as_of?, notes? } ],
 *   reasoning?,
 *   conversation_id?, context_summary?
 * }
 *
 * Files ONE pending set_org_corporate_profile action; the executor performs the
 * real writes (organizations columns + org_corporate_officers rows) on approval.
 * Bob is the PROPOSER; a human approves in the bell (#87 dry-run shows every
 * officer field before it lands — including address_for_service, so an approver
 * can catch a personal address slipping in before it is ever written).
 *
 * SAFETY: this producer NEVER accepts a field literally named "home_address",
 * "residential_address", or similar — only address_for_service. If Bob's lookup
 * only returned a personal address, it must leave address_for_service blank and
 * say so in reasoning, never repurpose a home address as the service address.
 *
 * registry_verified on each officer row means Bob's lookup returned this data —
 * it does NOT mean a human confirmed it. corporate_profile_verified_by/at on
 * organizations is set ONLY when a human approves this action in the bell.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = [
  'grand_master',
  'master',
  'admin'
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORPORATE_STATUSES = new Set([
  'registered',
  'removed',
  'in_liquidation',
  'receivership',
  'unknown'
]);
const OFFICER_ROLES = new Set([
  'director',
  'shareholder',
  'director_and_shareholder'
]);
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids').eq('id', caller.id).single();
    if (!callerProfile || !CAN_PROPOSE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    // Owning org: EXPLICIT id only (identity discipline — never a name here,
    // per bob_name_first_resolution: query_records resolves the name BEFORE
    // this producer is ever called).
    const targetOrgId = (body.organization_id ?? '').trim();
    if (!targetOrgId) return json({
      error: 'organization_id is required (resolve the name via query_records first)'
    }, 400);
    if (!UUID_RE.test(targetOrgId)) return json({
      error: 'organization_id must be an explicit org id (UUID), not a name'
    }, 400);
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    let allowed = targetOrgId === callerProfile.organization_id || authorizedOrgs.includes(targetOrgId) || callerProfile.role === 'grand_master';
    if (!allowed) {
      const { data: mtree } = await callerClient.rpc('is_master_for_org', {
        p_org_id: targetOrgId
      });
      allowed = mtree === true;
    }
    if (!allowed) return json({
      error: 'Not authorised for the specified organization_id'
    }, 403);
    const { data: org } = await admin.from('organizations').select('id, name').eq('id', targetOrgId).maybeSingle();
    if (!org) return json({
      error: `organization_id ${targetOrgId} does not exist`
    }, 422);
    if (body.corporate_status && !CORPORATE_STATUSES.has(body.corporate_status)) {
      return json({
        error: `Unknown corporate_status '${body.corporate_status}'`,
        valid: [
          ...CORPORATE_STATUSES
        ]
      }, 422);
    }
    const ADVERSE_NOTICE_STATUSES = new Set([
      'none_found',
      'bankruptcy',
      'liquidation_associated',
      'receivership_associated',
      'other_notice'
    ]);
    const officersIn = Array.isArray(body.officers) ? body.officers : [];
    const officers = [];
    for (const o of officersIn){
      const role = String(o.officer_role ?? '').trim();
      const fullName = String(o.full_name ?? '').trim();
      if (!role || !fullName) return json({
        error: 'Each officer requires officer_role and full_name'
      }, 400);
      if (!OFFICER_ROLES.has(role)) return json({
        error: `Unknown officer_role '${role}'`,
        valid: [
          ...OFFICER_ROLES
        ]
      }, 422);
      if (o.adverse_notice_status && !ADVERSE_NOTICE_STATUSES.has(o.adverse_notice_status)) {
        return json({
          error: `Unknown adverse_notice_status '${o.adverse_notice_status}'`,
          valid: [
            ...ADVERSE_NOTICE_STATUSES
          ]
        }, 422);
      }
      // #206: a Gazette search that found nothing MUST carry a search_as_of
      // timestamp — 'none_found' with no timestamp would let a stale/never-run
      // search silently read as a fresh clean record.
      if (o.adverse_notice_status === 'none_found' && !o.adverse_notice_search_as_of) {
        return json({
          error: 'adverse_notice_status=none_found requires adverse_notice_search_as_of (never present a clear result without when it was searched)'
        }, 400);
      }
      // SAFETY: reject any payload that smuggles a personal/residential address
      // under a different key name. Only address_for_service is ever accepted.
      const bad = Object.keys(o).find((k)=>/resid|home_address|personal_address/i.test(k));
      if (bad) return json({
        error: `Field '${bad}' is not accepted — only address_for_service (legal address for service), never a personal/residential address`
      }, 400);
      officers.push({
        officer_role: role,
        full_name: fullName,
        address_for_service: o.address_for_service ? String(o.address_for_service).trim() : undefined,
        contact_email: o.contact_email ? String(o.contact_email).trim() : undefined,
        contact_phone: o.contact_phone ? String(o.contact_phone).trim() : undefined,
        shareholding_percentage: typeof o.shareholding_percentage === 'number' ? o.shareholding_percentage : undefined,
        source: o.source ? String(o.source).trim() : 'companies_office',
        source_as_of: o.source_as_of ? String(o.source_as_of).trim() : undefined,
        notes: o.notes ? String(o.notes).trim() : undefined,
        adverse_notice_status: o.adverse_notice_status,
        adverse_notice_reference: o.adverse_notice_reference ? String(o.adverse_notice_reference).trim() : undefined,
        adverse_notice_source_url: o.adverse_notice_source_url ? String(o.adverse_notice_source_url).trim() : undefined,
        adverse_notice_published_at: o.adverse_notice_published_at,
        adverse_notice_effective_at: o.adverse_notice_effective_at,
        adverse_notice_search_as_of: o.adverse_notice_search_as_of
      });
    }
    const payload = {
      organization_id: targetOrgId,
      triggered_by: caller.id,
      company_registration_number: body.company_registration_number ?? null,
      nzbn: body.nzbn ?? null,
      corporate_status: body.corporate_status ?? 'unknown',
      corporate_status_as_of: body.corporate_status_as_of ?? null,
      officers
    };
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes a corporate profile for '${org.name}' (${officers.length} officer${officers.length !== 1 ? 's' : ''}) resolved via trusted-source lookup. Registry-resolved only — requires human approval before being treated as verified.`;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id.trim() ? body.conversation_id.trim() : null;
    const contextSummary = typeof body.context_summary === 'string' && body.context_summary.trim() ? body.context_summary.trim() : `Corporate profile: ${org.name}`;
    const queueOrgId = String(callerProfile.organization_id);
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: caller.id,
      action_type: 'set_org_corporate_profile',
      context_table: 'organizations',
      proposed_payload: payload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: conversationId,
      context_summary: contextSummary
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the corporate-profile action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: action.id,
      note: `Proposed (pending approval): corporate profile for '${org.name}' — ${officers.length} officer${officers.length !== 1 ? 's' : ''}. Approve it in the bell (review every officer field, especially address_for_service, before approving).`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});

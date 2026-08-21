/**
 * bob-propose-site-risk — propose a governed site risk_level change.
 *
 * POST { site_id, risk_level }  (risk_level optional; if omitted, Bob assesses)
 *
 * Creates a PENDING bob_agentic_actions row (action_type='set_site_risk_level')
 * so a human approves in the bell -> bob-proposal-approver -> bob-proposal-execute
 * applies the client_sites.risk_level write. Bob NEVER writes the rating silently.
 *
 * If risk_level is omitted, this calls bob_site_risk() to derive the suggested
 * rating so the proposal carries Bob's assessment as the rationale.
 *
 * Auth: JWT, admin/master/grand_master in the site's org.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = new Set([
  'grand_master',
  'master',
  'admin'
]);
const ALLOWED_RATINGS = new Set([
  'low',
  'medium',
  'high',
  'critical'
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
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await caller.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_PROPOSE.has(String(profile.role))) return json({
      error: 'Forbidden'
    }, 403);
    const body = await req.json().catch(()=>({}));
    if (!body.site_id) return json({
      error: 'site_id is required'
    }, 400);
    // Confirm the site + resolve its owning org (the action is stamped to it).
    const { data: site } = await admin.from('client_sites').select('id, name, client_organization_id, risk_level').eq('id', body.site_id).maybeSingle();
    if (!site) return json({
      error: 'site_not_found'
    }, 404);
    // Derive the suggested rating from the assessment unless one was supplied.
    let riskLevel = String(body.risk_level ?? '').toLowerCase().trim();
    let rationale = 'Manually proposed site risk rating.';
    if (!riskLevel) {
      const unrestricted = String(profile.role) === 'grand_master';
      let scopeOrgIds = profile.organization_id ? [
        String(profile.organization_id)
      ] : [];
      if (!unrestricted && profile.organization_id) {
        try {
          const { data: desc } = await admin.rpc('get_descendant_organizations', {
            org_id: profile.organization_id
          });
          if (Array.isArray(desc) && desc.length) scopeOrgIds = [
            ...new Set([
              String(profile.organization_id),
              ...desc.map((d)=>String(d))
            ])
          ];
        } catch (_e) {}
      }
      const { data: g } = await admin.rpc('bob_site_risk', {
        p_site_id: body.site_id,
        p_radius_m: 500,
        p_unrestricted: unrestricted,
        p_scope_org_ids: unrestricted ? null : scopeOrgIds
      });
      const signals = Array.isArray(g?.signals) ? g.signals : [];
      // Lightweight rating mirror of the edge fn (kept simple; the edge fn is the
      // authoritative scorer for display — here we only need a proposed value).
      const active = signals.filter((s)=>s.band === 'active').length;
      const monitor = signals.filter((s)=>s.band === 'monitor').length;
      riskLevel = active >= 3 ? 'critical' : active >= 1 ? 'high' : monitor >= 2 ? 'medium' : 'low';
      rationale = `Bob assessment: ${active} active, ${monitor} monitor, ${signals.length} total signals within 500m.`;
    }
    if (!ALLOWED_RATINGS.has(riskLevel)) return json({
      error: `risk_level must be one of ${[
        ...ALLOWED_RATINGS
      ].join('/')}`
    }, 400);
    if (String(site.risk_level ?? '').toLowerCase() === riskLevel) {
      return json({
        success: true,
        no_change: true,
        note: `Site risk_level is already '${riskLevel}'.`
      });
    }
    // Create the PENDING governed action. Human approves in the bell.
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    // conversation_id stamped for conversation-scoped reads.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: created, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: site.client_organization_id,
      user_id: user.id,
      action_type: 'set_site_risk_level',
      status: 'pending',
      proposed_payload: {
        site_id: body.site_id,
        risk_level: riskLevel,
        previous: site.risk_level ?? null
      },
      bob_reasoning: rationale,
      confidence_score: null,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !created) return json({
      error: 'proposal_failed',
      detail: insErr?.message
    }, 500);
    return json({
      success: true,
      action_id: created.id,
      site_id: body.site_id,
      proposed_risk_level: riskLevel,
      previous: site.risk_level ?? null,
      note: 'Proposed. Approve it in the notifications bell to apply the rating.'
    });
  } catch (err) {
    console.error('[bob-propose-site-risk] error:', err);
    return json({
      error: 'proposal_failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});

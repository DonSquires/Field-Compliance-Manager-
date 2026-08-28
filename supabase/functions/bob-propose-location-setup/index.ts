/**
 * bob-propose-location-setup -- governed proposal for the unified location +
 * contract model (epic #179, D5).
 *
 * Supported action_types:
 *   create_location              -> client_sites OR location_zones
 *   create_service_agreement_location -> service_agreements + service_agreement_locations
 *   create_location_assignment   -> patrol_route_sites OR patrol_route_zones (G4 validated)
 *   update_location_visibility   -> service_agreement_locations (share_* columns)
 *   create_location_note         -> location_notes (org-private, Tier 3)
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
  'admin',
  'admin_officer'
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_EMAILS = new Set([
  'don.squires@firstsecurity.co.nz',
  'squires.don@live.com',
  'squires.don@gmail.com'
]);
const VALID_ACTION_TYPES = new Set([
  'create_location',
  'create_service_agreement_location',
  'create_location_assignment',
  'update_location_visibility',
  'create_location_note'
]);
const CONTEXT_TABLE = {
  create_location: 'client_sites',
  create_service_agreement_location: 'service_agreement_locations',
  create_location_assignment: 'patrol_route_sites',
  update_location_visibility: 'service_agreement_locations',
  create_location_note: 'location_notes'
};
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
    const callerEmail = (caller.email ?? '').toLowerCase().trim();
    const effectiveRole = OWNER_EMAILS.has(callerEmail) ? 'grand_master' : callerProfile?.role ?? '';
    if (!callerProfile || !CAN_PROPOSE.includes(effectiveRole)) return json({
      error: 'Forbidden: admin or above required'
    }, 403);
    const body = await req.json();
    const actionType = (body.action_type ?? '').trim();
    if (!VALID_ACTION_TYPES.has(actionType)) return json({
      error: `action_type must be one of: ${[
        ...VALID_ACTION_TYPES
      ].join(', ')}`
    }, 400);
    const payload = body.payload ?? {};
    const targetOrgId = (body.organization_id ?? '').trim();
    if (targetOrgId) {
      if (!UUID_RE.test(targetOrgId)) return json({
        error: 'organization_id must be a UUID, not a name'
      }, 400);
      const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
      let allowed = targetOrgId === callerProfile.organization_id || authorizedOrgs.includes(targetOrgId) || effectiveRole === 'grand_master';
      if (!allowed) {
        const { data: mt } = await callerClient.rpc('is_master_for_org', {
          p_org_id: targetOrgId
        });
        allowed = mt === true;
      }
      if (!allowed) return json({
        error: 'Not authorised for the specified organization_id'
      }, 403);
    }
    if (actionType === 'create_location') {
      const lt = String(payload.location_type ?? '').trim();
      if (!lt || ![
        'site',
        'zone'
      ].includes(lt)) return json({
        error: 'payload.location_type must be "site" or "zone"'
      }, 400);
      if (!String(payload.name ?? '').trim()) return json({
        error: 'payload.name is required'
      }, 400);
      if (!targetOrgId) return json({
        error: 'organization_id is required for create_location'
      }, 400);
    }
    if (actionType === 'create_service_agreement_location') {
      if (!String(payload.site_id ?? '').trim() && !String(payload.zone_id ?? '').trim()) return json({
        error: 'payload.site_id or payload.zone_id is required'
      }, 400);
      const saId = String(payload.service_agreement_id ?? '').trim();
      if (!saId || !UUID_RE.test(saId)) return json({
        error: 'payload.service_agreement_id must be a valid UUID'
      }, 400);
      if (Array.isArray(payload.modules) && targetOrgId) {
        const { data: em } = await admin.from('organization_modules').select('module_key').eq('organization_id', targetOrgId).eq('enabled', true);
        const enabledSet = new Set((em ?? []).map((m)=>m.module_key));
        const bad = payload.modules.filter((m)=>!enabledSet.has(m));
        if (bad.length) return json({
          error: `Modules not enabled for this org: ${bad.join(', ')}`,
          disabled_modules: bad
        }, 422);
      }
    }
    if (actionType === 'create_location_assignment') {
      const prId = String(payload.patrol_route_id ?? '').trim();
      const siteId = String(payload.site_id ?? '').trim();
      const zoneId = String(payload.zone_id ?? '').trim();
      if (!prId || !UUID_RE.test(prId)) return json({
        error: 'payload.patrol_route_id must be a valid UUID'
      }, 400);
      if (!siteId && !zoneId) return json({
        error: 'payload.site_id or payload.zone_id is required'
      }, 400);
      const { data: pr } = await admin.from('patrol_routes').select('organization_id').eq('id', prId).maybeSingle();
      if (!pr) return json({
        error: `Assignment ${prId} not found`
      }, 422);
      const aOrgId = pr.organization_id;
      let ok = false;
      if (siteId) {
        const { data: s } = await admin.from('client_sites').select('client_organization_id').eq('id', siteId).maybeSingle();
        ok = s?.client_organization_id === aOrgId;
      } else {
        const { data: z } = await admin.from('location_zones').select('organization_id').eq('id', zoneId).maybeSingle();
        ok = z?.organization_id === aOrgId;
      }
      if (!ok) {
        const { data: sal } = await admin.from('service_agreement_locations').select('id, service_agreements(provider_organization_id)').eq(siteId ? 'site_id' : 'zone_id', siteId || zoneId).eq('status', 'active').limit(10);
        ok = (sal ?? []).some((r)=>{
          const sa = r.service_agreements?.[0];
          return sa?.provider_organization_id === aOrgId;
        });
      }
      if (!ok) return json({
        error: 'G4: assignment org does not own this location and has no active service agreement for it.',
        g4_validation: true
      }, 422);
    }
    if (actionType === 'create_location_note') {
      if (!String(payload.body ?? '').trim()) return json({
        error: 'payload.body is required'
      }, 400);
      const nOrgId = String(payload.organization_id ?? targetOrgId ?? '').trim();
      if (nOrgId && nOrgId !== callerProfile.organization_id && effectiveRole !== 'grand_master') return json({
        error: 'create_location_note: organization_id must be your own org (Tier 3 -- always private).'
      }, 403);
    }
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes: ${actionType.replace(/_/g, ' ')}.`;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id.trim() ? body.conversation_id.trim() : null;
    const contextSummary = typeof body.context_summary === 'string' && body.context_summary.trim() ? body.context_summary.trim() : `Location setup: ${actionType.replace(/_/g, ' ')}${targetOrgId ? ` (org ${targetOrgId.slice(0, 8)}...)` : ''}`;
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: String(callerProfile.organization_id),
      user_id: caller.id,
      action_type: actionType,
      context_table: CONTEXT_TABLE[actionType] ?? 'client_sites',
      proposed_payload: {
        ...payload,
        ...targetOrgId ? {
          organization_id: targetOrgId
        } : {},
        triggered_by: caller.id
      },
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: conversationId,
      context_summary: contextSummary,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !action) return json({
      error: 'Could not create the location action proposal',
      details: insErr?.message
    }, 500);
    return json({
      success: true,
      action_id: action.id,
      action_type: actionType,
      note: `Proposed (pending approval): ${actionType.replace(/_/g, ' ')}. Approve in the bell.`
    });
  } catch (err) {
    return json({
      error: 'Server error',
      details: err instanceof Error ? err.message : 'Internal error'
    }, 500);
  }
});

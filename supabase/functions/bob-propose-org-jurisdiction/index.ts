/**
 * Proposes an organization service-area boundary from canonical New Zealand
 * Territorial Authority names. The proposal writes only to bob_agentic_actions;
 * approval and execution remain separate governed steps.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CAN_PROPOSE = new Set(['grand_master', 'master', 'admin']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (!profile || !CAN_PROPOSE.has(String(profile.role))) {
      return json({ error: 'Forbidden: admin, master, or grand_master required' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const organizationId = typeof body.organization_id === 'string' ? body.organization_id.trim() : '';
    const districtNames = Array.isArray(body.district_names)
      ? [...new Set(body.district_names.map((name: unknown) => String(name).trim()).filter(Boolean))]
      : [];
    if (!organizationId) return json({ error: 'organization_id is required' }, 400);
    if (districtNames.length === 0) return json({ error: 'district_names must be a non-empty array' }, 400);
    if (districtNames.length > 40) return json({ error: 'Too many district_names (maximum 40)' }, 400);

    const { data: canOperate, error: scopeError } = await callerClient.rpc('user_can_operate_organization', {
      p_organization_id: organizationId,
    });
    if (scopeError || canOperate !== true) {
      return json({ error: 'Not authorized to operate this organization' }, 403);
    }

    const { data: organization } = await admin
      .from('organizations')
      .select('id, name')
      .eq('id', organizationId)
      .maybeSingle();
    if (!organization) return json({ error: 'Organization not found' }, 404);

    const { data: validation, error: validationError } = await admin.rpc('validate_ta_names', {
      p_names: districtNames,
    });
    if (validationError) {
      return json({ error: 'Territorial Authority validation is unavailable', detail: validationError.message }, 503);
    }
    const invalid = (validation ?? []).filter((result: { valid: boolean }) => !result.valid);
    if (invalid.length > 0) {
      return json({
        error: 'One or more council areas are not canonical Territorial Authority names',
        invalid_names: invalid,
      }, 422);
    }

    const payload = {
      target_org_id: organizationId,
      district_names: districtNames,
      triggered_by: user.id,
    };
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key.trim()
      ? body._idempotency_key.trim()
      : `set_org_jurisdiction:${organizationId}:${districtNames.slice().sort().join('|')}`;
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim()
      ? body.reasoning.trim()
      : `Set ${organization.name}'s service area from the approved council boundaries: ${districtNames.join(', ')}.`;

    const { data: action, error: insertError } = await admin
      .from('bob_agentic_actions')
      .insert({
        organization_id: organizationId,
        user_id: BOB_SYSTEM_USER_ID,
        action_type: 'set_org_jurisdiction',
        context_table: 'organizations',
        proposed_payload: payload,
        status: 'pending',
        bob_reasoning: reasoning,
        confidence_score: null,
        conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
        idempotency_key: idempotencyKey,
        triggered_by: user.id,
      })
      .select('id')
      .single();
    if (insertError || !action) {
      if (insertError?.code === '23505') {
        const { data: existing } = await admin
          .from('bob_agentic_actions')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('idempotency_key', idempotencyKey)
          .in('status', ['pending', 'approved', 'applying'])
          .maybeSingle();
        if (existing) {
          return json({
            success: true,
            action_id: existing.id,
            duplicate: true,
            note: 'This service-area proposal is already waiting in Approvals.',
          });
        }
      }
      return json({ error: 'Could not create the service-area proposal', detail: insertError?.message }, 500);
    }

    return json({
      success: true,
      action_id: action.id,
      note: `Service area proposed for ${organization.name}. Review and approve it in Approvals before routing uses it.`,
    });
  } catch (error) {
    console.error('[bob-propose-org-jurisdiction] error:', error);
    return json({
      error: 'Service-area proposal failed',
      detail: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

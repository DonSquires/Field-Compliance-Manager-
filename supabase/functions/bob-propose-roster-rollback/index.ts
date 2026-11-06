/** Creates a pending human-reviewable rollback proposal for a Bob roster plan. */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const authHeader = request.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from('user_profiles').select('id,role,organization_id').eq('id', caller.id).single();
  if (!profile || !['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) return json({ error: 'Forbidden' }, 403);
  try {
    const body = await request.json();
    const planId = typeof body.plan_id === 'string' ? body.plan_id : '';
    if (!planId) return json({ error: 'plan_id is required' }, 400);
    const { data: plan } = await admin.from('bob_roster_plans').select('id,organization_id,status').eq('id', planId).single();
    if (!plan || (plan.organization_id !== profile.organization_id && profile.role !== 'grand_master')) return json({ error: 'Roster plan not found in your scope' }, 404);
    if (plan.status !== 'applied') return json({ error: 'Only an applied roster plan can be rolled back' }, 409);
    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim() ? body.idempotency_key.trim() : `roster-rollback:${planId}`;
    const { data: action, error: insertError } = await admin.from('bob_agentic_actions').insert({
      organization_id: plan.organization_id,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'rollback_bob_roster_plan',
      context_page: 'roster', context_record_id: plan.id, context_table: 'bob_roster_plans',
      proposed_payload: { plan_id: plan.id, reason: body.reason ?? 'Rollback requested by human', triggered_by: caller.id },
      status: 'pending', triggered_by: caller.id, idempotency_key: idempotencyKey,
      bob_reasoning: 'Rollback is limited to assignments that remain unchanged draft slots. Published or human-edited slots fail closed.',
      context_summary: `Rollback roster plan ${plan.id}`,
    }).select('id').single();
    if (insertError || !action) return json({ error: insertError?.message ?? 'Could not create rollback proposal' }, 409);
    return json({ success: true, action_id: action.id, note: 'Pending human approval. Published or human-edited slots will not be rolled back automatically.' });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Rollback proposal failed' }, 500); }
});

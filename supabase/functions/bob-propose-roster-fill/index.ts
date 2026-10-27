/**
 * Bob roster fill producer.
 *
 * Creates a pending, human-reviewable roster plan. It never writes roster slots,
 * publishes work, or changes an accepted/in-progress/completed assignment.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

  const authHeader = request.headers.get('Authorization') ?? '';
  if (!authHeader) return json({ error: 'Unauthorized' }, 401);

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from('user_profiles')
    .select('id,role,organization_id,authorized_organization_ids')
    .eq('id', caller.id).single();
  if (!profile || !['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role)) {
    return json({ error: 'Forbidden: roster planning requires an administrator' }, 403);
  }

  try {
    const body = await request.json();
    const organizationId = typeof body.organization_id === 'string' ? body.organization_id : profile.organization_id;
    const allowedOrgs = profile.authorized_organization_ids ?? [];
    if (organizationId !== profile.organization_id && !allowedOrgs.includes(organizationId) && profile.role !== 'grand_master') {
      return json({ error: 'Organization is outside your planning scope' }, 403);
    }

    const from = new Date(body.period_start);
    const to = new Date(body.period_end);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 31 * 86400000) {
      return json({ error: 'period_start and period_end must define a window of one to 31 days' }, 400);
    }

    const { data: candidates, error: candidateError } = await admin.rpc('get_bob_roster_fill_candidates', {
      p_organization_id: organizationId,
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
    if (candidateError) return json({ error: candidateError.message }, 422);

    const grouped = new Map<string, any>();
    for (const candidate of candidates ?? []) {
      if (!grouped.has(candidate.roster_slot_id)) grouped.set(candidate.roster_slot_id, candidate);
    }
    const assignments = [...grouped.values()].map((candidate) => ({
      roster_slot_id: candidate.roster_slot_id,
      staff_id: candidate.staff_id,
      score: Number(candidate.score ?? 0),
      rationale: candidate.rationale,
    }));
    if (!assignments.length) return json({ error: 'No eligible open roster slots and staff matches were found' }, 422);

    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : `roster-fill:${organizationId}:${from.toISOString()}:${to.toISOString()}`;
    const { data: action, error: insertError } = await admin.from('bob_agentic_actions').insert({
      organization_id: organizationId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'apply_roster_fill_plan',
      context_page: 'roster',
      context_table: 'roster_slots',
      proposed_payload: {
        period_start: from.toISOString(),
        period_end: to.toISOString(),
        assignments,
        human_review_required: true,
        publish_required: true,
        triggered_by: caller.id,
      },
      status: 'pending',
      bob_reasoning: 'Ranked only work-ready, available, fatigue-clear staff for open draft slots. Human review and separate publication are required.',
      triggered_by: caller.id,
      idempotency_key: idempotencyKey,
      context_summary: `Roster fill proposal for ${from.toISOString()} to ${to.toISOString()}`,
    }).select('id').single();
    if (insertError || !action) return json({ error: insertError?.message ?? 'Could not create roster proposal' }, 409);

    return json({
      success: true,
      action_id: action.id,
      assignments_proposed: assignments.length,
      note: 'Pending human approval. Approval applies editable draft assignments only; a human must publish them.',
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Roster proposal failed' }, 500);
  }
});

/**
 * Bob tentative roster block producer.
 *
 * Turns a written staffing request (several date windows, shift patterns, sites,
 * rates and holidays) into ONE pending, human-reviewable proposal: open draft
 * roster slots (no staff, never published) plus a draft quote. It writes nothing
 * to the roster or quote tables; approval applies it through
 * apply_bob_tentative_roster_block.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { planTentativeRosterBlock } from '../_shared/roster-block-plan.mjs';

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

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
  if (authError || !caller) return json({ error: 'Unauthorized' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await admin.from('user_profiles')
    .select('id,role,organization_id,authorized_organization_ids')
    .eq('id', caller.id).single();
  if (!profile || !['grand_master', 'master', 'admin'].includes(profile.role)) {
    return json({ error: 'Forbidden: roster planning requires an administrator' }, 403);
  }

  try {
    const body = await request.json();
    const organizationId = typeof body.organization_id === 'string' ? body.organization_id : profile.organization_id;
    const allowedOrgs = profile.authorized_organization_ids ?? [];
    if (organizationId !== profile.organization_id && !allowedOrgs.includes(organizationId) && profile.role !== 'grand_master') {
      return json({ error: 'Organization is outside your planning scope' }, 403);
    }

    const requestedSites = Array.isArray(body.sites) ? body.sites : [];
    if (!requestedSites.length || requestedSites.length > 20) return json({ error: 'sites must list 1 to 20 sites' }, 400);

    // Every site must resolve to exactly one active work unit; never guess a place.
    const { data: units, error: unitError } = await admin.from('roster_work_units')
      .select('id,name').eq('organization_id', organizationId).eq('active', true);
    if (unitError) return json({ error: unitError.message }, 422);
    const resolved: Array<{ key: string; label: string; work_unit_id: string }> = [];
    const missing: string[] = [];
    requestedSites.forEach((site: any, index: number) => {
      const label = String(site?.label ?? '').trim();
      if (!label) { missing.push(`site ${index + 1} has no label`); return; }
      const wanted = label.toLowerCase();
      const exact = site.work_unit_id ? (units ?? []).filter((u: any) => u.id === site.work_unit_id) : [];
      const named = (units ?? []).filter((u: any) => String(u.name).toLowerCase().includes(wanted));
      const match = exact.length === 1 ? exact : named;
      if (match.length !== 1) { missing.push(match.length ? `${label} matches ${match.length} work units` : `${label} has no roster work unit`); return; }
      resolved.push({ key: String(index), label, work_unit_id: match[0].id });
    });
    if (missing.length) {
      return json({
        error: `Cannot place these sites on the roster yet: ${missing.join('; ')}. Create or name the roster work unit for each site first.`,
        missing_sites: missing,
      }, 422);
    }

    let clientOrgId: string | null = null;
    if (typeof body.client_org_id === 'string' && body.client_org_id) {
      const { data: client } = await admin.from('organizations').select('id,active').eq('id', body.client_org_id).maybeSingle();
      if (!client?.active) return json({ error: 'client_org_id is not an active organisation' }, 422);
      clientOrgId = client.id;
    }

    const plan = planTentativeRosterBlock({
      sites: resolved,
      blocks: body.blocks,
      rates: body.rates,
      holidays: body.holidays,
      gst_rate: body.gst_rate,
      guards_per_shift: body.guards_per_shift,
    });

    const idempotencyKey = typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
      ? body.idempotency_key.trim()
      : `tentative-roster-block:${organizationId}:${plan.summary.first_start}:${plan.summary.last_end}:${plan.summary.shifts}`;
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Static guard roster block';

    const { data: action, error: insertError } = await admin.from('bob_agentic_actions').insert({
      organization_id: organizationId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'apply_tentative_roster_block',
      context_page: 'roster',
      context_table: 'roster_slots',
      proposed_payload: {
        sites: resolved,
        shifts: plan.shifts,
        quote: { ...plan.quote, title, client_org_id: clientOrgId },
        summary: plan.summary,
        human_review_required: true,
        publish_required: true,
        triggered_by: caller.id,
      },
      status: 'pending',
      bob_reasoning: 'Expanded the request into open draft shifts (no staff, unpublished). Unpaid breaks are excluded from paid and charged hours; hours falling on listed public holidays use the holiday rate. A human must approve, then assign staff and publish separately.',
      triggered_by: caller.id,
      idempotency_key: idempotencyKey,
      context_summary: `Tentative roster block: ${plan.summary.shifts} open shifts, quote ${plan.quote.total_charge} incl GST`,
    }).select('id').single();
    if (insertError || !action) return json({ error: insertError?.message ?? 'Could not create roster block proposal' }, 409);

    return json({
      success: true,
      action_id: action.id,
      summary: plan.summary,
      quote: {
        subtotal_charge: plan.quote.subtotal_charge,
        gst_amount: plan.quote.gst_amount,
        total_charge: plan.quote.total_charge,
        total_cost: plan.quote.total_cost,
        will_create_draft_quote: Boolean(clientOrgId),
      },
      note: 'Pending human approval. Approval creates open draft slots and, when a client organisation is set, a draft quote. Nothing is published.',
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Roster block proposal failed' }, 400);
  }
});

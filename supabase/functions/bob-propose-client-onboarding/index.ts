/**
 * bob-propose-client-onboarding — Phase 2 MR-3: parent-first governed producer.
 *
 * POST /functions/v1/bob-propose-client-onboarding
 * Body: {
 *   provider_organization_id?,          // owning branch/provider; resolved like bob-promote-action
 *   client: { name, contact_email?, contact_phone?, billing_email?,
 *             billing_address?, account_notes? },
 *   sites?: [ { name, address?, site_type?, site_origin?, gps_lat?, gps_lng?,
 *              address_match_key?, site_brief?, access_instructions?, hs_notes? } ],
 *   reasoning?                          // Bob's rationale (audit)
 * }
 *
 * This is the PRODUCER that turns Bob's reasoned "create this client + its sites"
 * into the governed ledger, PARENT-FIRST:
 *   1. one PENDING `create_client_org` action (parent = the branch/provider), then
 *   2. one PENDING `create_client_site` action PER site, each carrying
 *      proposed_payload.parent_action_id = the org action's id.
 *
 * The executor (bob-proposal-execute) enforces ordering: a create_client_site
 * with a parent_action_id refuses to run until that create_client_org action is
 * status='applied' (MR-2 guard). So org is approved+executed first, then sites.
 *
 * Governance (matches bob-promote-action / bob-propose-site-risk):
 *   - JWT; admin/master/grand_master only.
 *   - Bob is the PROPOSER (BOB_SYSTEM_USER_ID); the triggering human is recorded
 *     in proposed_payload.triggered_by. The human approves each action in the bell.
 *   - Nothing is written to organizations/client_sites here — only PENDING ledger
 *     rows. All real writes go through approve -> execute.
 *
 * Provider-org resolution (owner rule, same as bob-promote-action):
 *   explicit + authorised, else single-org default to caller's org, else 409
 *   'organization_required' (no guessing across multiple orgs).
 *
 * Live-schema verified: bob_agentic_actions(organization_id, user_id,
 *   action_type, context_table, proposed_payload, status, bob_reasoning,
 *   confidence_score, ...). Insert shape mirrors the proven producers.
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
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
// Owner elevation: mirrors the conductor's OWNER_EMAILS set so the downstream
// permission check is consistent with what the conductor already advertised as
// available. Without this, the conductor elevates the owner to grand_master
// (canPromote=true, propose tools in the catalogue) but this function rejects
// the call because user_profiles.role is the un-elevated value — a permission-
// envelope mismatch (#125, same class as #107).
const OWNER_EMAILS = new Set([
  'don.squires@firstsecurity.co.nz',
  'squires.don@live.com',
  'squires.don@gmail.com'
]);
// Optional client-org columns we forward to the create_client_org payload.
const CLIENT_OPTIONAL = [
  'contact_email',
  'contact_phone',
  'billing_email',
  'billing_address',
  'account_notes'
];
// Optional site columns we forward to each create_client_site payload.
const SITE_OPTIONAL = [
  'address',
  'site_type',
  'site_origin',
  'address_match_key',
  'site_brief',
  'access_instructions',
  'hs_notes'
];
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
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, employer_organization_id, authorized_organization_ids').eq('id', caller.id).single();
    // Owner elevation: mirrors the conductor (#125, same class as #107).
    const callerEmail = (caller.email ?? '').toLowerCase().trim();
    const effectiveRole = OWNER_EMAILS.has(callerEmail) ? 'grand_master' : callerProfile?.role ?? '';
    if (!callerProfile || !CAN_PROPOSE.includes(effectiveRole)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const client = body.client ?? {};
    const clientName = typeof client.name === 'string' ? client.name.trim() : '';
    if (!clientName) return json({
      error: 'client.name is required'
    }, 400);
    const sites = Array.isArray(body.sites) ? body.sites : [];
    for (const s of sites){
      if (!s || typeof s.name !== 'string' || !s.name.trim()) {
        return json({
          error: 'each site requires a name'
        }, 400);
      }
    }
    // ── Provider-org resolution (owner rule, same as bob-promote-action) ──
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    const isMultiOrg = authorizedOrgs.length > 1;
    let providerOrgId = (body.provider_organization_id ?? '').trim();
    // ── Resolve a NAME/LABEL to a UUID before any UUID-typed use (auth RPC / FK).
    // Bob may pass "Nelson Branch" instead of the org id; is_master_for_org(uuid)
    // returns 400 on a non-UUID. Resolve within the CALLER'S OWN TREE only, never
    // fabricating and never reaching outside their authority.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (providerOrgId && !UUID_RE.test(providerOrgId)) {
      const anchor = String(callerProfile.organization_id ?? '') || null;
      const employer = callerProfile.employer_organization_id ?? null;
      const treeIds = new Set();
      for (const a of [
        anchor,
        employer
      ]){
        if (!a) continue;
        const { data: desc } = await admin.rpc('get_descendant_organizations', {
          org_id: a
        });
        for (const id of desc ?? [])treeIds.add(id);
      }
      const scopeIds = Array.from(treeIds);
      // Fetch all in-tree branch/provider orgs once, then match in safe tiers.
      let orgs = [];
      if (scopeIds.length) {
        const { data: rows } = await admin.from('organizations').select('id, name').in('organization_type', [
          'branch',
          'service_provider'
        ]).in('id', scopeIds);
        orgs = rows ?? [];
      }
      const norm = (s)=>s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const GENERIC = new Set([
        'branch',
        'office',
        'depot',
        'the',
        'and',
        'ltd',
        'limited',
        'co',
        'company'
      ]);
      const sigTokens = (s)=>norm(s).split(' ').filter((t)=>t.length >= 3 && !GENERIC.has(t));
      const labelN = norm(providerOrgId);
      const labelTokens = sigTokens(providerOrgId);
      // Tier 1: exact (case-insensitive). Tier 2: substring either direction.
      // Tier 3: every significant label token present in the org name.
      const tier1 = orgs.filter((o)=>norm(o.name) === labelN);
      const tier2 = orgs.filter((o)=>norm(o.name).includes(labelN) || labelN.includes(norm(o.name)));
      const tier3 = labelTokens.length ? orgs.filter((o)=>{
        const on = norm(o.name);
        return labelTokens.every((t)=>on.includes(t));
      }) : [];
      const candidates = tier1.length ? tier1 : tier2.length ? tier2 : tier3;
      console.log('[propose-onboarding] resolve-name', JSON.stringify({
        label: providerOrgId,
        scope_size: scopeIds.length,
        tiers: {
          t1: tier1.length,
          t2: tier2.length,
          t3: tier3.length
        },
        matched: candidates.map((c)=>c.id)
      }));
      if (candidates.length === 1) {
        providerOrgId = candidates[0].id;
      } else if (candidates.length > 1) {
        return json({
          error: 'provider_organization_ambiguous',
          message: `More than one org matches '${providerOrgId}'. Specify which one.`,
          candidates
        }, 409);
      } else {
        return json({
          error: 'provider_organization_not_found',
          message: `No branch or provider matching '${providerOrgId}' in your organisation tree. Valid options are listed.`,
          valid_organizations: orgs
        }, 422);
      }
    }
    if (providerOrgId) {
      // Flat checks: own operational home, mirrored operates-at branches, admiral.
      let allowed = providerOrgId === callerProfile.organization_id || authorizedOrgs.includes(providerOrgId) || effectiveRole === 'grand_master';
      // A MASTER governs by the OWNERSHIP TREE, not the flat operates-at list.
      // Mirror the RLS write policies (0093 master_manage_orgs_insert): a master
      // may act on any org descending from their employer/organization anchor.
      // is_master_for_org keys off auth.uid(), so call it on callerClient (JWT),
      // NOT admin (service role -> auth.uid() is null -> always false).
      let masterTree = null;
      if (!allowed) {
        const { data: mtree } = await callerClient.rpc('is_master_for_org', {
          p_org_id: providerOrgId
        });
        masterTree = mtree === true;
        allowed = masterTree;
      }
      // TEMP debug (remove after graduation chore confirmed): reveals whether the
      // branch id was resolved correctly, or a separate branch-resolution fix is needed.
      console.log('[propose-onboarding] auth', JSON.stringify({
        providerOrgId,
        caller_org: callerProfile.organization_id,
        role: callerProfile.role,
        in_authorized: authorizedOrgs.includes(providerOrgId),
        master_tree: masterTree,
        allowed
      }));
      if (!allowed) return json({
        error: 'Not authorised for the specified provider_organization_id'
      }, 403);
    } else if (!isMultiOrg) {
      providerOrgId = String(callerProfile.organization_id);
    } else {
      return json({
        error: 'organization_required',
        message: 'You manage multiple organizations. Specify which branch/provider this client belongs under.',
        authorized_organization_ids: authorizedOrgs
      }, 409);
    }
    if (!providerOrgId) return json({
      error: 'Could not resolve a provider organization'
    }, 422);
    // Confirm the parent (branch/provider) org exists.
    const { data: parentOrg } = await admin.from('organizations').select('id').eq('id', providerOrgId).maybeSingle();
    if (!parentOrg) return json({
      error: `provider_organization_id ${providerOrgId} does not exist`
    }, 422);
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes onboarding client '${clientName}'${sites.length ? ` with ${sites.length} site(s)` : ''}, parent-first.`;
    // ── 1. PENDING create_client_org ──
    const orgPayload = {
      name: clientName,
      parent_organization_id: providerOrgId,
      triggered_by: caller.id
    };
    for (const k of CLIENT_OPTIONAL){
      if (typeof client[k] === 'string' && String(client[k]).trim()) orgPayload[k] = String(client[k]).trim();
    }
    // Ledger organization_id = the APPROVAL QUEUE (caller's home org): it decides
    // which bell the action shows in AND who may approve it (bob-proposal-approver
    // requires action.organization_id === caller org). The OWNERSHIP target (the
    // branch) lives in proposed_payload.parent_organization_id, which is unchanged
    // and is what the executor creates the client under.
    const queueOrgId = String(callerProfile.organization_id);
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate
    // pending proposals for the same entity.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
    const { data: orgAction, error: orgErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_client_org',
      context_table: 'organizations',
      proposed_payload: orgPayload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: conversationId,
      context_summary: `Client onboarding: ${clientName}`,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (orgErr || !orgAction) {
      return json({
        error: 'Could not create the client-org action',
        details: orgErr?.message
      }, 500);
    }
    // ── 2. One PENDING create_client_site per site, linked to the org action ──
    const siteActionIds = [];
    for (const s of sites){
      const sitePayload = {
        name: String(s.name).trim(),
        parent_action_id: orgAction.id,
        triggered_by: caller.id
      };
      for (const k of SITE_OPTIONAL){
        if (typeof s[k] === 'string' && String(s[k]).trim()) sitePayload[k] = String(s[k]).trim();
      }
      if (typeof s.gps_lat === 'number') sitePayload.gps_lat = s.gps_lat;
      if (typeof s.gps_lng === 'number') sitePayload.gps_lng = s.gps_lng;
      // Geometry is BOB'S resolved decision, not the producer's. Bob verifies the
      // address and resolves the fence himself (LINZ primary -> Google secondary
      // -> provisional point; see his geofence card) using linz-lookup/Google as
      // TOOLS he chooses, then supplies the result here. The producer only FILES
      // what Bob resolved; it never auto-resolves (that would let a helper do
      // Bob's reasoning). If geometry is absent, the executor's guard (!679)
      // fails the action cleanly, which is Bob's cue to do the resolution chore.
      if (s.boundary && typeof s.boundary === 'object') sitePayload.boundary = s.boundary;
      // Pillar E (#273): site actions get a per-entity idempotency key derived
      // from the conductor's key + the site name, so each site deduplicates
      // independently. conversation_id is stamped for conversation-scoped reads.
      const siteIdempotencyKey = idempotencyKey ? `create_client_site::${String(s.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'}` : null;
      const { data: siteAction, error: siteErr } = await admin.from('bob_agentic_actions').insert({
        organization_id: queueOrgId,
        user_id: BOB_SYSTEM_USER_ID,
        action_type: 'create_client_site',
        context_table: 'client_sites',
        proposed_payload: sitePayload,
        status: 'pending',
        bob_reasoning: typeof s.geofence_reasoning === 'string' && s.geofence_reasoning.trim() ? `Site '${String(s.name).trim()}' under client '${clientName}' (parent-first; waits for the client org). Geofence (Bob-resolved): ${String(s.geofence_reasoning).trim()}` : `Site '${String(s.name).trim()}' under client '${clientName}' (parent-first; waits for the client org to be created).`,
        confidence_score: null,
        conversation_id: conversationId,
        idempotency_key: siteIdempotencyKey
      }).select('id').single();
      if (siteErr || !siteAction) {
        // Partial success: the org action + any earlier sites were created. Report
        // honestly rather than rolling back (each pending action is independently
        // reviewable/rejectable in the bell).
        return json({
          error: 'Client-org proposed, but a site action failed',
          details: siteErr?.message,
          org_action_id: orgAction.id,
          site_action_ids: siteActionIds
        }, 500);
      }
      siteActionIds.push(siteAction.id);
    }
    return json({
      success: true,
      org_action_id: orgAction.id,
      site_action_ids: siteActionIds,
      note: `Proposed (pending approval): create client '${clientName}'` + (sites.length ? ` + ${sites.length} site(s)` : '') + '. Approve the client org in the bell first, then the site(s) (they wait for the org to be created).'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});

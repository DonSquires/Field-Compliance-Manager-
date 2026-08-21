/**
 * check-house-conflict-any-org — governed READ-ONLY edge function for the
 * cross-org M3 conflict check on locations (houses).
 *
 * Convergence Step 2, Slice 2a-bis (CONVERGENCE_STEP2_SLICE2ABIS_M3_EDGE.md).
 *
 * IMPORTANT: this is a CHECK-THEN-CREATE guard, NOT a race-safe uniqueness
 * invariant. Slice 2e still owns the hard uniqueness/enforcement constraint.
 * Do not treat 2a-bis as the final integrity control — it is a governed
 * pre-flight check that prevents the most common conflict scenario.
 *
 * PURPOSE: detect whether a house (locations row) with a given
 * address_match_key already exists under a DIFFERENT organisation than the
 * effective owner. The `locations` table has RLS (`locations_select` policy
 * gated by `org_access_allowed(organization_id)`) — a user-scoped client
 * cannot see another org's rows. This edge function performs the cross-org
 * read SERVER-SIDE using the service-role key (RLS bypass), then returns a
 * ROLE-TIERED verdict to the caller.
 *
 * AUTH (§6 OWNER RULING — R2-invoke + role-tiered response):
 *   - INVOKE: ANY AUTHENTICATED USER (JWT required, valid auth.getUser()).
 *     Do NOT admin-gate the invoke — field officers must not be blocked
 *     (the enforcement house-create is coupled to the observations write path).
 *   - RESPONSE TIER: read the caller's `user_profiles.role` and resolve the
 *     effective role via `resolveEffectiveRole()` from `_shared/auth.ts`
 *     (applies OWNER-EMAIL elevation to grand_master). The response tier
 *     picks the detail level, NOT access.
 *     * CAN_PROPOSE roles (admin / master / grand_master) → full detail
 *       (conflict_org_id, existing_location_id).
 *     * officer / field / all other authenticated roles → verdict only
 *       (conflict: true/false). On a cross-org conflict: NO conflict_org_id,
 *       NO other-org existing_location_id. Intentional minimum existence
 *       signal — same egress discipline as #296 redaction family.
 *   - ORG VERIFICATION: the caller's `effective_owner_org_id` is verified
 *     server-side against the caller's `user_profiles.organization_id` and
 *     `authorized_organization_ids`. If the caller does not belong to the
 *     claimed org, the own-org dedup branch NEVER returns that org's
 *     existing_location_id — the org is treated as "not own-org" to prevent
 *     a cross-tenant read routed around the redaction.
 *
 * BODY: { address_match_key: string, effective_owner_org_id: string }
 *
 * WRITES NOTHING. No bob_agentic_actions, no executor chain, no migration.
 *
 * Mirrors the auth + service-role SHAPE of bob-propose-place-org-from-parcel
 * (JWT via anon-key caller client → auth.getUser(); read user_profiles.role;
 * admin client uses SUPABASE_SERVICE_ROLE_KEY; CORS/preflight/JSON helpers).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CAN_PROPOSE, resolveEffectiveRole } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
/**
 * Response-tier gate: roles that receive full conflict detail.
 * Sourced from _shared/auth.ts (CAN_PROPOSE) to prevent role-gate drift
 * (incidents #107 and #125). Do NOT define a local role set.
 */ const FULL_DETAIL_ROLES = CAN_PROPOSE;
serve(async (req)=>{
  // ── CORS preflight ──
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
    // ── AUTH: JWT required, any authenticated user ──
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
    // ── Service-role admin client (RLS bypass) ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // ── Read caller's profile for RESPONSE TIER + ORG VERIFICATION ──
    // Fail-closed: if the role read fails, callerRole defaults to '' which
    // is NOT in FULL_DETAIL_ROLES → falls to verdict-only tier. This is the
    // SAFE direction (under-discloses, never over-discloses cross-tenant
    // identity). Intentional fail-closed design — not an error swallow.
    const { data: callerProfile, error: profileErr } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids').eq('id', caller.id).single();
    if (profileErr) {
      // Fail-closed: profile read failure → hard deny. We cannot determine
      // the caller's org membership or role tier without a profile.
      // Intentional hard-deny (not fail-open) per review B2 ruling.
      return json({
        error: 'Profile read failed'
      }, 403);
    }
    const dbRole = callerProfile?.role ?? '';
    const callerEmail = caller.email ?? '';
    // Apply owner-email elevation via resolveEffectiveRole from _shared/auth.ts.
    // An owner-by-email is elevated to grand_master regardless of DB role.
    const callerRole = resolveEffectiveRole(callerEmail, dbRole);
    // ── Parse + validate body ──
    // Wrap req.json() separately so malformed JSON returns 400, not 500.
    let body;
    try {
      body = await req.json();
    } catch  {
      return json({
        error: 'Invalid JSON body'
      }, 400);
    }
    const addressMatchKey = typeof body.address_match_key === 'string' ? body.address_match_key.trim() : '';
    const effectiveOwnerOrgId = typeof body.effective_owner_org_id === 'string' ? body.effective_owner_org_id.trim() : '';
    if (!addressMatchKey) {
      return json({
        error: 'address_match_key is required'
      }, 400);
    }
    if (!effectiveOwnerOrgId) {
      return json({
        error: 'effective_owner_org_id is required'
      }, 400);
    }
    // ── ORG VERIFICATION (Fix #1 — security) ──
    // Verify the caller legitimately belongs to the claimed effective_owner_org_id.
    // Without this, a caller could pass an org they don't belong to and, via
    // the own-org dedup branch, learn another org's existing_location_id —
    // a cross-tenant read routed around the redaction.
    //
    // The caller belongs to an org if:
    //   (a) it is their primary organization_id, OR
    //   (b) it is in their authorized_organization_ids array.
    // If neither, the org is treated as "not own-org" — its rows can NEVER
    // be returned as an own-org dedup hit.
    const callerPrimaryOrg = callerProfile?.organization_id ?? '';
    const callerAuthorizedOrgs = callerProfile?.authorized_organization_ids ?? [];
    const callerBelongsToEffectiveOrg = effectiveOwnerOrgId === callerPrimaryOrg || callerAuthorizedOrgs.includes(effectiveOwnerOrgId);
    // ── SERVICE-ROLE READ (RLS-bypassing, READ-ONLY) ──
    // SELECT on `locations` by address_match_key across ALL orgs.
    //
    // NO .limit(): an unordered .limit(2) is UNSAFE for the own-org vs
    // other-org partition — if ≥3 rows exist (e.g. 2 own-org + 1 other-org),
    // the DB may return only the 2 own-org rows, hiding the conflict.
    // address_match_key is a dedup key with very low cardinality (typically
    // 1–3 rows), so unbounded is safe and correct.
    // Proven safe-as-changed by vitest: ".limit(2) order-independence" suite.
    const { data: rows, error: queryErr } = await admin.from('locations').select('id, organization_id').eq('address_match_key', addressMatchKey);
    if (queryErr) {
      // Do NOT echo queryErr.message — it may contain cross-tenant detail
      // (table structure, org ids from error context). Return a generic error.
      return json({
        error: 'Cross-org conflict query failed'
      }, 500);
    }
    // ── INTERPRET VERDICT ──
    const matches = rows ?? [];
    // Case 1: no row → no conflict
    if (matches.length === 0) {
      return json({
        conflict: false
      });
    }
    // Partition: own-org rows vs other-org rows.
    // SECURITY: only treat rows as "own-org" if the caller actually belongs
    // to the effective_owner_org_id. If the caller does NOT belong to it,
    // ALL rows are treated as other-org — the own-org dedup branch is
    // unreachable, preventing the cross-tenant read attack.
    const ownOrgRows = callerBelongsToEffectiveOrg ? matches.filter((r)=>r.organization_id === effectiveOwnerOrgId) : [];
    const otherOrgRows = callerBelongsToEffectiveOrg ? matches.filter((r)=>r.organization_id !== effectiveOwnerOrgId) : matches; // All rows are "other-org" when caller doesn't belong
    // Case 2: row(s) only under effective_owner_org_id → no conflict (own-org dedup hit)
    // Only reachable when callerBelongsToEffectiveOrg is true.
    if (otherOrgRows.length === 0 && ownOrgRows.length > 0) {
      return json({
        conflict: false,
        existing_location_id: ownOrgRows[0].id
      });
    }
    // Case 3: row under a DIFFERENT org → cross-org signal.
    // Response is ROLE-TIERED per §6 ruling.
    // Uses resolveEffectiveRole (owner-email elevation) + CAN_PROPOSE from
    // _shared/auth.ts — no local role set (prevents role-gate drift).
    //
    // AMENDMENT !1328 (Slice 2a-ter), TRI-STATE — MUST stay behaviourally
    // aligned with houseConflictVerdict.ts::computeVerdict (the vitest mirror):
    //   This branch is only reached on enforcement origins (the helper invokes
    //   this fn ONLY for enforcement). Escalation to a CONFIRMED conflict
    //   (`true`) requires same-parcel corroboration. `locations` has NO parcel
    //   id (0145), so that corroboration is structurally unavailable → return
    //   `'review'` (weak signal, human confirmation), NOT `true`. The `true`
    //   branch is written but DORMANT until Slice 2e persists a parcel. Do NOT
    //   substitute a geometry heuristic for parcel corroboration (!1328 §2.2).
    const conflictRow = otherOrgRows[0];
    // Dormant today: no parcel data exists, so this is always false. 2e seam.
    const parcelCorroborated = false; // see !1328 §2.1/§2.3
    if (parcelCorroborated) {
      // CONFIRMED cross-org conflict (dormant until 2e).
      if (FULL_DETAIL_ROLES.has(callerRole)) {
        return json({
          conflict: true,
          conflict_org_id: conflictRow.organization_id,
          existing_location_id: conflictRow.id
        });
      }
      // officer / field / all other: verdict only — NO cross-tenant detail.
      return json({
        conflict: true
      });
    }
    // Enforcement + parcel-unknown → REVIEW (reachable Path-B interim).
    // Same role-tiered egress as `true`: full-detail roles may see the
    // cross-tenant identifiers; officer/field get the review verdict ONLY.
    if (FULL_DETAIL_ROLES.has(callerRole)) {
      return json({
        conflict: 'review',
        conflict_org_id: conflictRow.organization_id,
        existing_location_id: conflictRow.id
      });
    }
    // officer / field / all other authenticated roles: review verdict only
    // NO conflict_org_id, NO other-org existing_location_id.
    // Intentional minimum existence signal — prevents anchor forking;
    // existence never identity for field roles.
    return json({
      conflict: 'review'
    });
  } catch  {
    // Do NOT echo err.message — it may contain cross-tenant identifiers
    // (org ids, location ids, address details) from the query/partition
    // logic. Return a generic error to prevent log/response leakage.
    return json({
      error: 'Server error'
    }, 500);
  }
});

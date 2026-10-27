// @ts-nocheck — the Supabase client's generic types (SupabaseClient<...>)
// do not resolve in Deno's type checker when RPC functions and table types
// are not registered via codegen. The runtime behaviour is unchanged; this
// is purely a type-checking workaround. Same pattern as other edge functions
// that call .rpc() with custom function signatures.
//
// NOTE: @ts-nocheck MUST be a standalone comment at the very top of the file,
// before any JSDoc block. Deno's type checker does not recognise it inside
// a JSDoc comment.
/**
 * invite-org — Create the first user for an onboarded organisation
 *
 * POST /functions/v1/invite-org
 *
 * Two modes:
 *   1. **invite** (default): Creates the org's first auth user + user_profile
 *      via `inviteUserByEmail`. Role comes from `resolve_org_invitation`:
 *      `client_admin` for a client under an operational agreement (client portal),
 *      `master` for a platform subscriber under the owner's financial agreement
 *      or the caller's own organisation. The user receives an email and
 *      sets their own password. No pre-authenticated/password-set-now path —
 *      that mode was removed per Bob's fourth-pass review (Blocker 5).
 *   2. **recovery**: Re-sends the invite for an org whose sole user has never
 *      confirmed their email (never logged in). Addresses the #304 no-auth
 *      recovery gap — works for a grand_master caller without requiring an
 *      authenticated in-tenant user.
 *
 * Auth: Requires a valid JWT from a grand_master, master or admin user.
 * `resolve_org_invitation` (run as the caller) must find an active agreement
 * naming the target as client and held by the caller's organisation, one of its
 * branches, or a branch the caller is authorised at (operational -> client_admin;
 * financial, grand_master only -> master).
 *
 * ── ANTI-ENUMERATION (Bob's fifth-pass, Concern 1) ──────────────────────
 * All error responses are DELIBERATELY BLAND. Specific failure reasons
 * (org state, user existence, confirmation status) are logged server-side
 * in the audit log metadata but NEVER returned in the HTTP response. This
 * prevents an attacker from enumerating: which orgs have users, which
 * emails exist, or which users are confirmed. The generic messages are:
 *   - "Unable to process invitation"  (invite-path failures)
 *   - "Unable to process recovery"    (recovery-path failures)
 *   - "Not authorised for this action" (agreement/permission failures)
 *   - "Too many requests. Please wait and try again." (rate limit)
 *
 * ── RATE LIMITING (Bob's fifth-pass, Concern 2) ─────────────────────────
 * Server-side rate limiting runs BEFORE any org state checks (so it cannot
 * leak information through timing). Uses the `check_invite_rate_limit` RPC
 * (migration 0380) backed by the `invite_rate_log` table:
 *   - Per-caller: max 5 invites per 5 minutes
 *   - Per-target-org: max 1 invite per 2 minutes (cooldown)
 * If the RPC is not yet migrated, the function falls back to an in-memory
 * Map (not durable across cold starts — documented limitation).
 *
 * ── RECOVERY PREDICATE — "exactly one user" (Bob's fifth-pass, Concern 3)
 * The recovery guard counts user_profiles WHERE organization_id = target AND
 * deactivated_at IS NULL. Deactivated users (soft-deleted via migration 0051's
 * deactivated_at column) are excluded from the count. This means:
 *   - An org with 1 active + 1 deactivated user → recovery allowed (1 active)
 *   - An org with 0 active + 1 deactivated user → "no users" (0 active)
 * The invite path's first-user check also filters on deactivated_at IS NULL.
 * user_profiles has no other soft-delete or disabled column.
 *
 * ── ATOMICITY / COMPENSATING ROLLBACK (Bob's fifth-pass, Concern 4) ─────
 * Partial failure scenario: inviteUserByEmail succeeds (auth user created)
 * but claim_first_org_user fails (profile not created). The auth user is
 * orphaned. On the next call:
 *   1. inviteUserByEmail detects the duplicate email → returns 409.
 *   2. The function checks for an existing profile → finds none.
 *   3. Returns 409 suggesting recovery mode.
 * Recovery mode re-sends the invite for the existing auth user. The profile
 * is NOT auto-created by the auth callback handler (AuthCallbackPage.tsx
 * only handles password setting — it does NOT insert user_profiles rows).
 * Therefore, the recovery path must also handle the orphaned-auth-user case:
 * if the org has zero active user_profiles but the auth user exists, recovery
 * will re-send the invite. The profile will be created by a subsequent
 * successful invite call (or manually by an admin via create-user).
 * Net: the orphaned auth user is NOT self-healing via login. The recovery
 * path is the documented remediation.
 *
 * Race safety (Blocker 1 — CONFIRMED): First-user creation uses a Postgres
 * advisory lock via the `claim_first_org_user` RPC (migration 0379) to
 * serialise per-org. The RPC acquires `pg_advisory_xact_lock(hashtext(org_id))`
 * inside a transaction, then checks `count(*) FROM user_profiles WHERE
 * organization_id = org_id`. If count > 0, it raises an exception. Otherwise
 * it inserts the profile row. The lock is transaction-scoped — released on
 * COMMIT or ROLLBACK. Different org IDs hash to different lock keys, so
 * concurrent invites to different orgs proceed in parallel. This makes
 * duplicate-first-user impossible even under concurrent requests.
 * NOTE: The RPC is a step 3 migration dependency. Until the migration is
 * applied, the function falls back to check-then-create with a clear warning.
 *
 * Blocker 2 — Recovery hardening (CONFIRMED): Recovery is resend-only. It
 * cannot create new identities, change the target email, or accept
 * password/preauthenticated flags. All three guards (grand_master + exactly
 * one user_profile + unconfirmed auth) are enforced together before any action.
 * The recovery path calls ONLY inviteUserByEmail on the existing auth user.
 *
 * Blocker 3 — Agreement direction + active state: The agreement check is
 * directionally exact AND requires the agreement to be active. Active is
 * defined as `ends_on IS NULL OR ends_on >= current_date` (the canonical
 * pattern — service_agreements has NO status column). Only the provider side
 * can author the first user for the client org.
 *
 * Blocker 3 — Branch/parent relationships: Agreements are org-to-org
 * (provider_organization_id ↔ client_organization_id). If the caller's org
 * is a branch, the agreement must reference that specific branch as the
 * provider — not the parent. Similarly, if the target is a branch, the
 * agreement must reference that specific branch as the client. The invite-org
 * function does NOT walk the org hierarchy; it checks the exact org IDs.
 * This is deliberate: branch-level agreements are the correct granularity
 * for authorising first-user creation. A parent org's agreement does NOT
 * automatically extend to its branches for this purpose.
 *
 * Blocker 4 — Server truth (CONFIRMED): The server is the absolute source
 * of truth for eligibility. The UI role-gate is a UX courtesy only.
 *
 * Blocker 5 — Side-effect shape: The invite path performs exactly four
 * side effects: (1) create auth user via inviteUserByEmail, (2) create
 * user_profile row (master role), (3) update invitation_status on the
 * agreement (best-effort), (4) audit log. Nothing else. The pre-authenticated
 * path (createUser with password) has been removed from this MR.
 *
 * Blocker 6 — Idempotency: Repeated submission produces one safe outcome:
 *   - If the org already has a user (first invite succeeded), a second call
 *     returns 409 ("already has users") via the claim_first_org_user RPC or
 *     the fallback count check.
 *   - If an auth user was created by a previous inviteUserByEmail call but
 *     the profile insert failed (partial failure), the function detects the
 *     existing auth user (inviteUserByEmail returns an error for duplicate
 *     email) and returns a clear error suggesting recovery mode.
 *   - If both auth user and profile were created (full success), the second
 *     call hits the "already has users" 409 path.
 *   The function never creates duplicate auth users or duplicate profiles.
 *
 * Blocker 6 — Auditability: Both invite and recovery audit logs include
 * caller id, caller email, target org id, target org name, target email,
 * and mode (invite / recovery).
 *
 * Mirrors: supabase/functions/create-user/index.ts (CORS, auth, admin client,
 * error handling, role gating, audit).
 *
 * Issue: #361 (step 2 of 4) | Related: #304 (no-auth recovery)
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
/** Roles that may invoke this function; resolve_org_invitation decides what each may seat. */ const CAN_INVITE_ORG = [
  'grand_master',
  'master',
  'admin',
  'admin_officer'
];
// ── In-memory rate limiter (fallback when check_invite_rate_limit RPC is not migrated) ──
// LIMITATION: This Map is NOT durable across cold starts. Each new Deno isolate
// gets a fresh Map. The Postgres-backed RPC (migration 0380) is the durable
// solution. This fallback is better than nothing but not a substitute.
const rateLimitLog = new Map();
const RATE_LIMIT_CALLER_MAX = 5; // max 5 invites per caller per window
const RATE_LIMIT_CALLER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_ORG_MAX = 1; // max 1 invite per target org per window
const RATE_LIMIT_ORG_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
function checkInMemoryRateLimit(callerId, targetOrgId) {
  const now = Date.now();
  // Per-caller check
  const callerKey = `caller:${callerId}`;
  const callerLog = rateLimitLog.get(callerKey) ?? [];
  const callerRecent = callerLog.filter((t)=>now - t < RATE_LIMIT_CALLER_WINDOW_MS);
  if (callerRecent.length >= RATE_LIMIT_CALLER_MAX) return false;
  // Per-target-org check
  const orgKey = `org:${targetOrgId}`;
  const orgLog = rateLimitLog.get(orgKey) ?? [];
  const orgRecent = orgLog.filter((t)=>now - t < RATE_LIMIT_ORG_WINDOW_MS);
  if (orgRecent.length >= RATE_LIMIT_ORG_MAX) return false;
  // Record the attempt
  callerRecent.push(now);
  rateLimitLog.set(callerKey, callerRecent);
  orgRecent.push(now);
  rateLimitLog.set(orgKey, orgRecent);
  return true;
}
/**
 * Check rate limit via Postgres RPC (durable, cross-isolate).
 * Returns true if allowed, false if rate-limited.
 * Falls back to in-memory if the RPC doesn't exist.
 */ async function checkRateLimit(adminClient, callerId, targetOrgId) {
  try {
    const { data, error } = await adminClient.rpc('check_invite_rate_limit', {
      p_caller_id: callerId,
      p_target_org_id: targetOrgId
    });
    if (error) {
      const msg = error.message?.toLowerCase() ?? '';
      if (msg.includes('does not exist') || msg.includes('not found') || msg.includes('could not find')) {
        console.warn('[invite-org] check_invite_rate_limit RPC not found — falling back to in-memory rate limiter. ' + 'Apply migration 0380 for durable rate limiting.');
        return checkInMemoryRateLimit(callerId, targetOrgId);
      }
      // Other RPC error — fail open (allow) but log
      console.error('[invite-org] rate limit RPC error:', error.message);
      return true;
    }
    return data === true;
  } catch (err) {
    console.warn('[invite-org] rate limit check failed — falling back to in-memory.', err);
    return checkInMemoryRateLimit(callerId, targetOrgId);
  }
}
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
  try {
    // ── 1. Verify caller JWT ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    // ── 2. Get caller profile + role gate ────────────────────────────────
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await adminClient.from('user_profiles').select('role, organization_id, email').eq('id', caller.id).single();
    if (!callerProfile || !CAN_INVITE_ORG.includes(callerProfile.role)) {
      return json({
        error: 'Not authorised for this action'
      }, 403);
    }
    // ── 3. Parse request body ────────────────────────────────────────────
    // Blocker 5: The pre-authenticated/password path has been removed from
    // this MR. Only the invite-email path is supported. If the caller sends
    // preauthenticated or password fields, they are rejected explicitly.
    const body = await req.json();
    // Blocker 5: Reject pre-authenticated/password fields in ANY mode
    if (body.preauthenticated || body.password) {
      return json({
        error: 'The pre-authenticated (password-set-now) path is not supported in this version. ' + 'Use the default invite path — the user will receive an email to set their own password.'
      }, 400);
    }
    const mode = body.mode ?? 'invite';
    const targetOrgId = body.target_organization_id;
    if (!targetOrgId) {
      return json({
        error: 'target_organization_id is required'
      }, 400);
    }
    // ── 3b. Rate limiting (Concern 2) — runs BEFORE org state checks ────
    // Rate limit check is intentionally placed before any org/user lookups
    // so that rate-limited requests cannot leak information through timing
    // differences (e.g. a fast 409 vs a slow 200 would reveal org state).
    const allowed = await checkRateLimit(adminClient, caller.id, targetOrgId);
    if (!allowed) {
      return json({
        error: 'Too many requests. Please wait and try again.'
      }, 429);
    }
    // ── 4. Which agreement authorises this, and which role the first user gets ──
    // resolve_org_invitation (migration 20260920050000) runs as the caller: a client under an
    // operational agreement held by the caller's organisation, one of its branches, or a branch
    // the caller is authorised at -> 'client_admin'; a platform subscriber under the owner's
    // financial agreement (grand_master only) -> 'master'; the caller's own organisation -> 'master'.
    // Recovery keeps its own grand_master-only guard in handleRecovery.
    let invitation = null;
    if (mode !== 'recovery') {
      const { data: resolved, error: resolveError } = await callerClient.rpc('resolve_org_invitation', {
        p_target_organization_id: targetOrgId
      });
      if (resolveError || !resolved?.role) {
        console.warn(`[invite-org] invitation not authorised for caller ${caller.id} -> org ${targetOrgId}: ${resolveError?.message ?? 'no role resolved'}`);
        try {
          await adminClient.rpc('log_user_management_action', {
            p_organization_id: targetOrgId,
            p_target_user_id: caller.id,
            p_action_type: 'org_invite_denied',
            p_performed_by: caller.id,
            p_old_value: null,
            p_new_value: null,
            p_metadata: {
              failure_reason: 'no_authorising_agreement',
              mode: mode,
              caller_user_id: caller.id,
              caller_email: callerProfile.email ?? 'unknown',
              caller_organization_id: callerProfile.organization_id,
              target_organization_id: targetOrgId,
              detail: resolveError?.message ?? null
            }
          });
        } catch  {}
        return json({
          error: 'Not authorised for this action'
        }, 403);
      }
      invitation = resolved;
    }
    // ── Route to mode ────────────────────────────────────────────────────
    if (mode === 'recovery') {
      return await handleRecovery(adminClient, callerProfile, caller, targetOrgId, body, json);
    }
    return await handleInvite(adminClient, callerProfile, caller, targetOrgId, body, invitation, json);
  } catch (err) {
    console.error('[invite-org] unexpected error:', err);
    return json({
      error: 'Internal error'
    }, 500);
  }
});
// ═══════════════════════════════════════════════════════════════════════════════
// Mode: invite — create the org's first user (master role)
//
// Side effects (Blocker 5 — narrow shape):
//   1. Create auth user via inviteUserByEmail (email invite only — no
//      pre-authenticated/password path in this MR)
//   2. Create user_profile row (master role, linked to target org)
//   3. Update invitation_status on the agreement (best-effort, forward-compat)
//   4. Audit log
// Nothing else. No membership grants beyond master, no org record mutations,
// no onboarding state back-fill, no agreement mutations beyond invitation_status.
//
// Blocker 6 — Idempotency / replay behaviour:
//   - First call: inviteUserByEmail creates auth user → claim_first_org_user
//     creates profile → 200 success.
//   - Second call (same org, full success on first): claim_first_org_user (or
//     fallback count check) sees existing profile → returns 409 "already has
//     users". The inviteUserByEmail call may also fail with "duplicate email"
//     which is caught and surfaced as a clear error.
//   - Partial failure (auth user created, profile insert failed): On retry,
//     inviteUserByEmail returns "A user with this email address has already
//     been registered" (duplicate). The function detects this and returns a
//     clear error suggesting recovery mode. The advisory lock in
//     claim_first_org_user ensures the profile cannot be double-created.
//   Net result: repeated submission produces one safe outcome, never duplicates.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleInvite(adminClient, callerProfile, caller, targetOrgId, body, invitation, json) {
  const { email, display_name } = body;
  // role and agreement come from resolve_org_invitation: 'client_admin' for a client under an operational agreement, 'master' for a subscriber or own-org bootstrap
  const role = invitation?.role ?? 'master';
  const roleLabel = role === 'client_admin' ? 'Client Administrator' : 'Master';
  const agreementId = invitation?.agreement_id ?? null;
  if (!email?.trim()) return json({
    error: 'email is required'
  }, 400);
  // ── Blocker 1 (CONFIRMED): Race-safe first-user check ───────────────
  // The `claim_first_org_user` RPC (migration 0379) wraps the check + insert
  // inside a transaction with pg_advisory_xact_lock(hashtext(org_id)). This
  // serialises first-user creation per org, making duplicate-first-user
  // impossible even under concurrent requests. The lock is transaction-scoped
  // (released on COMMIT/ROLLBACK). Different org IDs hash to different lock
  // keys, so concurrent invites to different orgs proceed in parallel.
  //
  // If the RPC doesn't exist yet (step 3 migration not applied), the function
  // falls back to check-then-create with a clear warning.
  const normEmail = email.trim().toLowerCase();
  const resolvedDisplayName = display_name?.trim() ?? normEmail.split('@')[0];
  // ── Fetch target org for branding ────────────────────────────────────
  const { data: targetOrg } = await adminClient.from('organizations').select('name, logo_url').eq('id', targetOrgId).single();
  const orgName = targetOrg?.name ?? 'Field Compliance Manager';
  // ── Create auth user via inviteUserByEmail (email invite only) ───────
  // Blocker 5: Only the invite-email path is supported. The pre-authenticated
  // (createUser with password) path has been removed from this MR.
  const result = await adminClient.auth.admin.inviteUserByEmail(normEmail, {
    data: {
      display_name: resolvedDisplayName,
      role,
      role_label: roleLabel,
      organization_id: targetOrgId,
      organization_name: orgName,
      organization_logo: targetOrg?.logo_url ?? ''
    },
    redirectTo: `${Deno.env.get('SITE_URL') ?? 'https://fcmanager.co.nz'}/auth/callback`
  });
  const inviteUserId = result.data?.user?.id ?? null;
  const inviteError = result.error;
  if (inviteError) {
    console.error('[invite-org] invite error:', inviteError.message);
    // Blocker 6 — Idempotency: If the auth user already exists (duplicate
    // email from a previous partial or full invite), return a clear error.
    const msg = inviteError.message?.toLowerCase() ?? '';
    if (msg.includes('already been registered') || msg.includes('duplicate') || msg.includes('already exists')) {
      // Check if the org already has a profile (full success on previous call)
      const { count: existingProfileCount } = await adminClient.from('user_profiles').select('id', {
        count: 'exact',
        head: true
      }).eq('organization_id', targetOrgId).is('deactivated_at', null);
      // Anti-enumeration: bland response. Specific reason logged server-side.
      const failureReason = existingProfileCount && existingProfileCount > 0 ? 'org_already_has_users' : 'auth_user_exists_no_profile';
      try {
        await adminClient.rpc('log_user_management_action', {
          p_organization_id: targetOrgId,
          p_target_user_id: caller.id,
          p_action_type: 'org_invite_denied',
          p_performed_by: caller.id,
          p_old_value: null,
          p_new_value: null,
          p_metadata: {
            failure_reason: failureReason,
            mode: 'invite',
            caller_user_id: caller.id,
            caller_email: callerProfile.email ?? 'unknown',
            target_organization_id: targetOrgId,
            target_email: normEmail
          }
        });
      } catch  {}
      return json({
        error: 'Unable to process invitation'
      }, 409);
    }
    // Anti-enumeration: bland response for other invite errors too.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: caller.id,
        p_action_type: 'org_invite_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'invite_api_error',
          mode: 'invite',
          caller_user_id: caller.id,
          caller_email: callerProfile.email ?? 'unknown',
          target_organization_id: targetOrgId,
          target_email: normEmail,
          original_error: inviteError.message
        }
      });
    } catch  {}
    return json({
      error: 'Unable to process invitation'
    }, 400);
  }
  if (!inviteUserId) {
    console.error('[invite-org] no auth user id resolved after invite');
    return json({
      error: 'Could not resolve an auth user id for this email.'
    }, 500);
  }
  // ── Blocker 1: Atomic first-user claim via RPC ───────────────────────
  // Try the advisory-lock RPC first. If it doesn't exist (step 3 migration
  // not yet applied), fall back to check-then-insert with a warning.
  let profileCreated = false;
  try {
    const { data: _claimResult, error: claimError } = await adminClient.rpc('claim_first_org_user', {
      p_org_id: targetOrgId,
      p_user_id: inviteUserId,
      p_display_name: resolvedDisplayName,
      p_role: role,
      p_email: normEmail
    });
    if (claimError) {
      // If the RPC doesn't exist, fall back to the non-atomic path
      const msg = claimError.message?.toLowerCase() ?? '';
      if (msg.includes('does not exist') || msg.includes('not found') || msg.includes('could not find')) {
        console.warn('[invite-org] claim_first_org_user RPC not found — falling back to check-then-create. ' + 'RACE SAFETY WARNING: Apply the step 3 migration to enable advisory-lock protection.');
      // Fall through to legacy path below
      } else if (msg.includes('already has users') || msg.includes('duplicate')) {
        // The RPC correctly rejected — org already has a user.
        // Anti-enumeration: bland response. Specific reason logged server-side.
        try {
          await adminClient.rpc('log_user_management_action', {
            p_organization_id: targetOrgId,
            p_target_user_id: inviteUserId ?? caller.id,
            p_action_type: 'org_invite_denied',
            p_performed_by: caller.id,
            p_old_value: null,
            p_new_value: null,
            p_metadata: {
              failure_reason: 'org_already_has_users',
              mode: 'invite',
              caller_user_id: caller.id,
              caller_email: callerProfile.email ?? 'unknown',
              target_organization_id: targetOrgId,
              target_email: normEmail
            }
          });
        } catch  {}
        return json({
          error: 'Unable to process invitation'
        }, 409);
      } else {
        console.error('[invite-org] claim_first_org_user RPC error:', claimError.message);
        return json({
          error: 'Unable to process invitation'
        }, 500);
      }
    } else {
      // RPC succeeded — profile was created atomically
      profileCreated = true;
    }
  } catch (rpcErr) {
    console.warn('[invite-org] claim_first_org_user RPC call failed — falling back to check-then-create.', rpcErr);
  }
  // ── Fallback: check-then-create (non-atomic, pre-migration) ──────────
  if (!profileCreated) {
    // Check org has no existing active users (first invitation only)
    // Concern 3: Filter out deactivated users (soft-deleted via migration 0051)
    const { count: existingUserCount } = await adminClient.from('user_profiles').select('id', {
      count: 'exact',
      head: true
    }).eq('organization_id', targetOrgId).is('deactivated_at', null);
    if (existingUserCount && existingUserCount > 0) {
      // Anti-enumeration: bland response. Specific reason logged server-side.
      try {
        await adminClient.rpc('log_user_management_action', {
          p_organization_id: targetOrgId,
          p_target_user_id: inviteUserId ?? caller.id,
          p_action_type: 'org_invite_denied',
          p_performed_by: caller.id,
          p_old_value: null,
          p_new_value: null,
          p_metadata: {
            failure_reason: 'org_already_has_users',
            mode: 'invite',
            caller_user_id: caller.id,
            caller_email: callerProfile.email ?? 'unknown',
            target_organization_id: targetOrgId,
            target_email: normEmail
          }
        });
      } catch  {}
      return json({
        error: 'Unable to process invitation'
      }, 409);
    }
    // Create user_profile row (master role, linked to target org)
    const { error: profileError } = await adminClient.from('user_profiles').upsert({
      id: inviteUserId,
      organization_id: targetOrgId,
      employer_organization_id: targetOrgId,
      display_name: resolvedDisplayName,
      role,
      email: normEmail
    }, {
      onConflict: 'id'
    });
    if (profileError) {
      console.error('[invite-org] profile error:', JSON.stringify(profileError));
      return json({
        step: 'profile_upsert',
        error: profileError.message,
        details: profileError.details ?? null
      }, 500);
    }
  }
  // ── Update invitation_status on the agreement (forward-compatible) ───
  // The invitation_status column is added by step 3's migration. This update
  // is a best-effort: if the column doesn't exist yet, we swallow the error.
  if (agreementId) {
    try {
      await adminClient.from('service_agreements').update({
        invitation_status: 'invited'
      }).eq('id', agreementId);
    } catch  {
    // invitation_status column not yet migrated — non-fatal
    }
  }
  // ── Audit log (Blocker 6 — explicit auditability) ────────────────────
  try {
    await adminClient.rpc('log_user_management_action', {
      p_organization_id: targetOrgId,
      p_target_user_id: inviteUserId,
      p_action_type: 'org_user_invited',
      p_performed_by: caller.id,
      p_old_value: null,
      p_new_value: null,
      p_metadata: {
        mode: 'invite',
        caller_user_id: caller.id,
        caller_email: callerProfile.email ?? 'unknown',
        target_organization_id: targetOrgId,
        target_organization_name: orgName,
        target_email: normEmail,
        display_name: resolvedDisplayName,
        role,
        invitation_kind: invitation?.kind ?? 'same_org',
        agreement_id: agreementId
      }
    });
  } catch (auditErr) {
    // Audit failure must not block user creation
    console.error('[invite-org] audit log failed:', auditErr);
  }
  console.log(`[invite-org] invited ${normEmail} as ${role} in org ${targetOrgId}`);
  return json({
    success: true,
    user_id: inviteUserId,
    email: normEmail,
    role,
    organization_id: targetOrgId,
    agreement_id: agreementId
  });
}
// ═══════════════════════════════════════════════════════════════════════════════
// Mode: recovery — re-send invite for sole unconfirmed user (#304)
//
// The #304 gap: resend-invite requires a logged-in privileged caller IN the
// target org. If the sole master never confirmed their email, there is no
// authenticated in-tenant user to call resend-invite. This recovery path
// allows a grand_master (platform owner, cross-org) to re-send the invite
// without an in-tenant user.
//
// Blocker 2 — Recovery hardening:
//   Guard 1: Caller must be grand_master
//   Guard 2: Target org must have exactly one user_profile
//   Guard 3: That user's auth record must have email_confirmed_at = null
//   All three guards are checked TOGETHER before any action.
//
//   Recovery CANNOT:
//   - Create a new auth identity (no createUser calls)
//   - Change the target email (email comes from existing auth record, not request)
//   - Accept password or preauthenticated flags (rejected if present)
//   - Fall back to fresh-user creation (returns error if any guard fails)
//
// Side effects: (1) inviteUserByEmail resend, (2) audit log. Nothing else.
// ═══════════════════════════════════════════════════════════════════════════════
async function handleRecovery(adminClient, callerProfile, caller, targetOrgId, _body, json) {
  // Blocker 5: preauthenticated/password are rejected at the top level
  // (before mode routing), so recovery never sees them. This function
  // accepts no body fields — it operates entirely from server state.
  // ── Guard 1: Grand master only ───────────────────────────────────────
  if (callerProfile.role !== 'grand_master') {
    // Anti-enumeration: bland response. Specific reason logged server-side.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: caller.id,
        p_action_type: 'org_recovery_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'caller_not_grand_master',
          mode: 'recovery',
          caller_user_id: caller.id,
          caller_role: callerProfile.role,
          target_organization_id: targetOrgId
        }
      });
    } catch  {}
    return json({
      error: 'Not authorised for this action'
    }, 403);
  }
  // ── Guard 2: Find the org's sole ACTIVE user_profile ─────────────────
  // Concern 3: "Exactly one user" counts only active (non-deactivated) profiles.
  // user_profiles.deactivated_at (migration 0051) is the soft-delete column.
  // Deactivated users are excluded from the count. There is no other
  // soft-delete, disabled, or is_active column on user_profiles.
  // Duplicate profiles for the same auth user id are not possible (id is PK).
  const { data: orgUsers, error: usersError } = await adminClient.from('user_profiles').select('id, email, display_name, role').eq('organization_id', targetOrgId).is('deactivated_at', null);
  if (usersError) {
    console.error('[invite-org] recovery: user lookup error:', usersError.message);
    return json({
      error: 'Unable to process recovery'
    }, 500);
  }
  if (!orgUsers || orgUsers.length === 0) {
    // Anti-enumeration: bland response. Specific reason logged server-side.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: caller.id,
        p_action_type: 'org_recovery_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'org_has_no_active_users',
          mode: 'recovery',
          caller_user_id: caller.id,
          caller_email: callerProfile.email ?? 'unknown',
          target_organization_id: targetOrgId
        }
      });
    } catch  {}
    return json({
      error: 'Unable to process recovery'
    }, 404);
  }
  if (orgUsers.length > 1) {
    // Anti-enumeration: bland response. Specific reason logged server-side.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: caller.id,
        p_action_type: 'org_recovery_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'org_has_multiple_active_users',
          mode: 'recovery',
          caller_user_id: caller.id,
          caller_email: callerProfile.email ?? 'unknown',
          target_organization_id: targetOrgId,
          active_user_count: orgUsers.length
        }
      });
    } catch  {}
    return json({
      error: 'Unable to process recovery'
    }, 409);
  }
  const soleUser = orgUsers[0];
  // ── Guard 3: Verify the auth user has never confirmed ────────────────
  const { data: authUser, error: authUserError } = await adminClient.auth.admin.getUserById(soleUser.id);
  if (authUserError || !authUser?.user) {
    console.error('[invite-org] recovery: auth user lookup error:', authUserError);
    return json({
      error: 'Could not retrieve auth user record'
    }, 500);
  }
  // email_confirmed_at being set means the user has confirmed at least once
  if (authUser.user.email_confirmed_at) {
    // Anti-enumeration: bland response. Specific reason logged server-side.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: soleUser.id,
        p_action_type: 'org_recovery_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'user_already_confirmed',
          mode: 'recovery',
          caller_user_id: caller.id,
          caller_email: callerProfile.email ?? 'unknown',
          target_organization_id: targetOrgId,
          sole_user_id: soleUser.id
        }
      });
    } catch  {}
    return json({
      error: 'Unable to process recovery'
    }, 409);
  }
  if (!authUser.user.email) {
    return json({
      error: 'Auth user has no email address on record'
    }, 500);
  }
  // ── Blocker 2: Email comes from existing auth record, NOT request body ─
  // The recovery path must NOT allow the caller to change the target email.
  const recoveryEmail = authUser.user.email;
  // ── Fetch target org for branding ────────────────────────────────────
  const { data: targetOrg } = await adminClient.from('organizations').select('name, logo_url').eq('id', targetOrgId).single();
  const orgName = targetOrg?.name ?? 'Field Compliance Manager';
  const displayName = soleUser.display_name || recoveryEmail.split('@')[0];
  // ── Re-send the invite (resend only — no createUser call) ────────────
  // Blocker 2: This is the ONLY auth-admin call in recovery. It re-sends
  // the invite for the EXISTING auth user. It does NOT create a new identity.
  const { error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(recoveryEmail, {
    data: {
      display_name: displayName,
      role: soleUser.role,
      role_label: 'Master',
      organization_id: targetOrgId,
      organization_name: orgName,
      organization_logo: targetOrg?.logo_url ?? ''
    },
    redirectTo: `${Deno.env.get('SITE_URL') ?? 'https://fcmanager.co.nz'}/auth/callback`
  });
  if (inviteError) {
    console.error('[invite-org] recovery: invite error:', inviteError.message);
    // Anti-enumeration: bland response. Specific reason logged server-side.
    try {
      await adminClient.rpc('log_user_management_action', {
        p_organization_id: targetOrgId,
        p_target_user_id: soleUser.id,
        p_action_type: 'org_recovery_denied',
        p_performed_by: caller.id,
        p_old_value: null,
        p_new_value: null,
        p_metadata: {
          failure_reason: 'recovery_invite_api_error',
          mode: 'recovery',
          caller_user_id: caller.id,
          caller_email: callerProfile.email ?? 'unknown',
          target_organization_id: targetOrgId,
          sole_user_id: soleUser.id,
          original_error: inviteError.message
        }
      });
    } catch  {}
    return json({
      error: 'Unable to process recovery'
    }, 400);
  }
  // ── Audit log (Blocker 6 — explicit auditability) ────────────────────
  try {
    await adminClient.rpc('log_user_management_action', {
      p_organization_id: targetOrgId,
      p_target_user_id: soleUser.id,
      p_action_type: 'org_invite_recovery_resent',
      p_performed_by: caller.id,
      p_old_value: null,
      p_new_value: null,
      p_metadata: {
        mode: 'recovery',
        caller_user_id: caller.id,
        caller_email: callerProfile.email ?? 'unknown',
        target_organization_id: targetOrgId,
        target_organization_name: orgName,
        target_email: recoveryEmail,
        sole_user_id: soleUser.id,
        sole_user_display_name: displayName
      }
    });
  } catch (auditErr) {
    console.error('[invite-org] recovery: audit log failed:', auditErr);
  }
  console.log(`[invite-org] recovery: resent invite to ${recoveryEmail} for org ${targetOrgId}`);
  return json({
    success: true,
    recovery: true,
    user_id: soleUser.id,
    email: recoveryEmail,
    organization_id: targetOrgId
  });
}

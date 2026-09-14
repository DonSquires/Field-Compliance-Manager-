// Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
// apps/web/src/lib/resolveOrCreateHouse.ts @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

/**
 * resolveOrCreateHouse.ts — THE single canonical house (locations) place-attach helper.
 *
 * Convergence Step 2, Slice 2a (CONVERGENCE_STEP2_WRITE_PATH.md §3 / §3.2 / §8).
 * Owner ruling (B), 2026-08-06: effective-owner resolution LIVES IN THE HELPER.
 * Writers pass CONTEXT; the helper DECIDES ownership. No caller resolves
 * ownership itself — that is precisely the divergence this program removes.
 *
 * Contract:
 *   INPUT:  caller org id, origin/module context, resolved parcel/address
 *           identity (address_match_key, label, lat/lng, parcel polygon),
 *           dedup keys.
 *   INTERNAL SUBSTEP: resolveEffectiveOwnerOrg(...) — a DISTINCT, separately-
 *           exported function so its behaviour can be pinned independently.
 *   THEN:   dedup the house by (effective-owner org, effective dedup key);
 *           create the locations row if absent (organization_id = effective owner);
 *           return { locationId, effectiveOwnerOrgId, action }.
 *
 * Dedup contract (M2):
 *   Dedup is ALWAYS by (effective-owner org, effective dedup key) — NEVER by
 *   address key alone. The same physical address may legitimately exist under
 *   DIFFERENT effective owners (ordinary→caller org; enforcement→place-record
 *   org). The helper does NOT assume global address uniqueness while attaching
 *   an org. Two houses at the same address under different orgs are DISTINCT.
 *
 * Effective dedup key (M1):
 *   The effective dedup key is computed ONCE and used for BOTH the dedup query
 *   AND the written address_match_key. When the LINZ matchKey is null, the key
 *   is synthesized from the label using normaliseAddress (same normalisation as
 *   canonicalSiteEntry / canonicalZoneEntry — S2 parity). A synthesized key is
 *   deduped identically to a real LINZ key — no create-without-dedup path.
 *
 * Legacy wrong-org conflict (M3):
 *   For ENFORCEMENT origins, the helper invokes the governed edge function
 *   `check-house-conflict-any-org` (Slice 2a-bis) to perform a SERVICE-ROLE,
 *   RLS-bypassing cross-org read. If an existing locations row matches the
 *   dedup identity but is attached to a DIFFERENT org than the resolved
 *   effective owner, the helper STOPS with a clear error. Silent reuse would
 *   preserve bad ownership; silent recreate would fork anchors.
 *
 * Enforcement caller-role precondition (M4):
 *   bob-propose-place-org-from-parcel is role-gated to admin/master/grand_master
 *   callers. When enforcement-origin place-org resolution is unavailable or
 *   denied, the helper throws a clear error naming the role/gov requirement.
 *   It NEVER degrades to caller-org ownership for enforcement origins.
 *
 * Program B seam (S3):
 *   The return type (ResolveOrCreateHouseResult) is the single attachment point
 *   for Program B's later location_events dual-write. Slices 2b–2d will add
 *   the event write AFTER this helper returns, keyed on { locationId, action,
 *   effectiveOwnerOrgId }. This helper does NOT write location_events — that
 *   is Program B scope.
 *
 * Modelled on canonicalSiteEntry.ts enforcement-origin ownership branch and
 * canonicalZoneEntry.ts dedupByMatchKey pattern.
 *
 * HARD BOUNDARY (anti-slice-creep):
 *   - 2a does NOT rewire any writer (those are slices 2b–2d).
 *   - 2a writes NO location_events row (that is Program B).
 *   - 2a adds NO migration (0347 already installed the house preference).
 *
 * locations table columns (0143/0145): id, organization_id, name, address,
 * address_match_key, suburb, postcode, notes, created_by, timestamps.
 * NO geometry, NO client_organization_id.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normaliseAddress } from './siteAnchorAddress';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Origins where the place is an ENFORCEMENT target — a property that is NOT
 * the operator's client (a private residence, discovered at callout). The
 * evidence must anchor to the accountable PLACE, not the operating org.
 *
 * Modelled on canonicalSiteEntry.ts enforcement branch.
 */
export const ENFORCEMENT_ORIGINS: ReadonlySet<string> = new Set([
  'enforcement',
  'noise',
  'biosecurity',
  'smoke',
]);

/**
 * Origins where the caller org IS the effective owner (ordinary operations).
 */
export const ORDINARY_ORIGINS: ReadonlySet<string> = new Set([
  'contracted',
  'alarm',
  'adhoc',
  'site-management',
]);

/**
 * Closed union of all recognised house origins (S1).
 *
 * An unrecognised origin MUST throw — silent default to ordinary/caller-org
 * is the risky direction for an auth-adjacent ownership decision.
 */
export type HouseOrigin =
  | 'enforcement'
  | 'noise'
  | 'biosecurity'
  | 'smoke'
  | 'contracted'
  | 'alarm'
  | 'adhoc'
  | 'site-management';

/** All recognised origins as a set (for runtime validation). */
export const ALL_RECOGNISED_ORIGINS: ReadonlySet<string> = new Set([
  ...ENFORCEMENT_ORIGINS,
  ...ORDINARY_ORIGINS,
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Address/parcel identity resolved upstream (LINZ autocomplete, etc.). */
export interface ResolvedAddressIdentity {
  /** LINZ address_match_key — the dedup key. */
  addressMatchKey: string | null;
  /** Human-readable address label. */
  label: string | null;
  /** Latitude of the resolved point. */
  lat: number | null;
  /** Longitude of the resolved point. */
  lng: number | null;
  /** Suburb (optional, for the locations row). */
  suburb?: string | null;
  /** Postcode (optional, for the locations row). */
  postcode?: string | null;
}

/** Parcel polygon resolved from LINZ (required for enforcement origins). */
export interface ResolvedParcel {
  /** GeoJSON polygon geometry of the parcel. */
  parcelPolygon: Record<string, unknown>;
  /** LINZ parcel ID (optional, used for dedup in bob-propose-place-org-from-parcel). */
  parcelId?: string | null;
}

/** Input for the resolveOrCreateHouse pipeline. */
export interface ResolveOrCreateHouseInput {
  /** The caller's organisation ID (the operating org). */
  callerOrgId: string;
  /**
   * Origin/module context — determines enforcement vs ordinary ownership.
   * Must be a recognised HouseOrigin; unrecognised origins throw (S1).
   */
  origin: HouseOrigin;
  /** Resolved address identity from LINZ or equivalent. */
  address: ResolvedAddressIdentity;
  /** Resolved parcel (required for enforcement origins; optional otherwise). */
  parcel?: ResolvedParcel | null;
  /** Display name for the house (defaults to address label). */
  name?: string | null;
  /** User ID for created_by (optional). */
  createdBy?: string | null;
}

/** The action taken by the helper. */
export type HouseAction = 'existing' | 'created';

/**
 * Result returned by resolveOrCreateHouse().
 *
 * Program B seam (S3): this is the single attachment point for the later
 * location_events dual-write. Slices 2b–2d will add the event write AFTER
 * this helper returns, keyed on { locationId, action, effectiveOwnerOrgId }.
 * This helper does NOT write location_events.
 */
export interface ResolveOrCreateHouseResult {
  /** The locations.id of the resolved or created house. */
  locationId: string;
  /** The effective owner org ID (may differ from callerOrgId for enforcement). */
  effectiveOwnerOrgId: string;
  /** Whether the house was found (existing) or created (created). */
  action: HouseAction;
}

/** Result from resolveEffectiveOwnerOrg. */
export interface EffectiveOwnerResult {
  /** The effective owner org ID. */
  effectiveOwnerOrgId: string;
  /**
   * Whether the org was reassigned (enforcement) or retained (ordinary).
   * 'retained' = caller org is the owner; 'reassigned' = place-record org.
   */
  resolution: 'retained' | 'reassigned';
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Compute the effective dedup key for a house (M1 + S2).
 *
 * Uses the LINZ addressMatchKey when available; otherwise synthesizes from
 * the label using normaliseAddress() — the SAME normalisation used by
 * canonicalSiteEntry / canonicalZoneEntry (trim, collapse whitespace,
 * lowercase). Returns null only when both matchKey and label are absent.
 *
 * This value is computed ONCE and used for BOTH the dedup query AND the
 * written address_match_key, so a synthesized key is deduped identically
 * to a real LINZ key.
 */
export function computeEffectiveDedupKey(
  matchKey: string | null,
  label: string | null,
): string | null {
  if (matchKey) return matchKey;
  if (label) return normaliseAddress(label);
  return null;
}

// ---------------------------------------------------------------------------
// resolveEffectiveOwnerOrg — DISTINCT, separately-exported, independently testable
// ---------------------------------------------------------------------------

/**
 * Determine the effective owner organisation for a house.
 *
 * ENFORCEMENT origins (noise / biosecurity / smoke / enforcement):
 *   Reassign to the accountable place-record org (mint-or-reuse from the
 *   parcel via bob-propose-place-org-from-parcel). NEVER the operator/caller.
 *   Modelled on canonicalSiteEntry.ts enforcement branch.
 *
 *   Precondition (M4): bob-propose-place-org-from-parcel is role-gated to
 *   admin / master / grand_master callers. If the caller lacks the required
 *   role, the edge function will deny the request and this function will
 *   throw a clear error. The helper NEVER degrades to caller-org ownership
 *   for enforcement origins — that would re-create the org-scoping disease.
 *
 * ORDINARY origins (contracted / alarm / adhoc / site-management):
 *   Retain the caller org.
 *
 * UNRECOGNISED origins (S1):
 *   Throw immediately. Silent default to ordinary/caller-org is the risky
 *   direction for an auth-adjacent ownership decision.
 *
 * This function is exported separately so its behaviour can be pinned by
 * tests independently of the create/attach mechanics (§3.2 ruling).
 *
 * @param callerOrgId - The operating/caller organisation ID.
 * @param origin - The origin/module context (must be a recognised HouseOrigin).
 * @param parcel - Resolved parcel (required for enforcement origins).
 * @param addressLabel - Human-readable address label (for the place-org name).
 * @param addressMatchKey - LINZ address_match_key (for parcel dedup).
 * @param lat - Latitude of the resolved point.
 * @param lng - Longitude of the resolved point.
 * @param supabaseClient - Supabase client for the bob-propose-place-org-from-parcel invoke.
 */
export async function resolveEffectiveOwnerOrg(
  callerOrgId: string,
  origin: HouseOrigin,
  parcel: ResolvedParcel | null | undefined,
  addressLabel: string | null,
  addressMatchKey: string | null,
  lat: number | null,
  lng: number | null,
  supabaseClient: SupabaseClient,
): Promise<EffectiveOwnerResult> {
  // ── S1: reject unrecognised origins immediately ──
  if (!ALL_RECOGNISED_ORIGINS.has(origin)) {
    throw new Error(
      `resolveEffectiveOwnerOrg: unrecognised origin '${origin}'. ` +
      `Recognised origins: ${[...ALL_RECOGNISED_ORIGINS].join(', ')}. ` +
      'An unrecognised origin must not silently default to caller-org ownership.',
    );
  }

  // ── ORDINARY origins: retain the caller org ──
  if (!ENFORCEMENT_ORIGINS.has(origin)) {
    return { effectiveOwnerOrgId: callerOrgId, resolution: 'retained' };
  }

  // ── ENFORCEMENT origins: reassign to the accountable place-record org ──
  // The parcel polygon is REQUIRED for enforcement — without it we cannot
  // anchor the place to the accountable property. Refuse to silently fall
  // back to the operator org (that would re-create the org-scoping disease).
  if (!parcel?.parcelPolygon) {
    throw new Error(
      'resolveEffectiveOwnerOrg: enforcement origin requires a resolved parcel polygon ' +
      'to anchor the accountable place. Cannot silently fall back to operator ownership ' +
      'for an enforcement property.',
    );
  }

  if (lat == null || lng == null) {
    throw new Error(
      'resolveEffectiveOwnerOrg: enforcement origin requires lat/lng coordinates ' +
      'to mint/reuse the place-record org.',
    );
  }

  // Governed, auto-apply: mint (or dedup-reuse) the place-record org whose
  // jurisdiction IS this parcel. The edge function is service-role — the
  // client requests, the executor performs the tenant-root-adjacent write.
  //
  // M4 precondition: bob-propose-place-org-from-parcel is role-gated to
  // admin / master / grand_master. If the caller lacks the required role,
  // the edge function returns an auth error. We surface it clearly and
  // NEVER degrade to caller-org ownership.
  const { data: placeRes, error: placeErr } = await supabaseClient.functions.invoke(
    'bob-propose-place-org-from-parcel',
    {
      body: {
        name: addressLabel || 'Enforcement Place',
        gps_lat: lat,
        gps_lng: lng,
        parcel_polygon: parcel.parcelPolygon,
        resolved_from_address: addressLabel || null,
        parcel_id: parcel.parcelId ?? addressMatchKey ?? null,
      },
    },
  );

  if (placeErr) {
    throw new Error(
      'resolveEffectiveOwnerOrg: enforcement place-org resolution failed. ' +
      'This may be a role/governance denial — bob-propose-place-org-from-parcel ' +
      'requires the caller to hold admin, master, or grand_master role. ' +
      `Error: ${placeErr.message}. ` +
      'The helper NEVER degrades to caller-org ownership for enforcement origins.',
    );
  }

  const placeOrgId = (placeRes as { organization_id?: string } | null)?.organization_id ?? null;
  if (!placeOrgId) {
    throw new Error(
      'resolveEffectiveOwnerOrg: place-org creation returned no organization_id for enforcement origin' +
      `${(placeRes as { error?: string } | null)?.error ? ` (${(placeRes as { error?: string }).error})` : ''}. ` +
      'Refusing to anchor enforcement evidence to the operating org.',
    );
  }

  return { effectiveOwnerOrgId: placeOrgId, resolution: 'reassigned' };
}

// ---------------------------------------------------------------------------
// House dedup (by address_match_key within the effective owner org — M2)
// ---------------------------------------------------------------------------

/**
 * Check if a house (locations row) with this address_match_key already exists
 * for this organisation.
 *
 * Dedup contract (M2): dedup is ALWAYS by (effective-owner org, effective
 * dedup key) — NEVER by address key alone. The same physical address may
 * legitimately exist under DIFFERENT effective owners. This function queries
 * within a single org only.
 */
async function dedupHouseByMatchKey(
  matchKey: string,
  organizationId: string,
  supabaseClient: SupabaseClient,
): Promise<{ id: string; name: string; address: string | null; organization_id: string } | null> {
  if (!matchKey) return null;
  const { data, error } = await supabaseClient
    .from('locations')
    .select('id, name, address, organization_id')
    .eq('address_match_key', matchKey)
    .eq('organization_id', organizationId)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(
      `dedupHouseByMatchKey: locations dedup query failed: ${error.message}`,
    );
  }
  return data as { id: string; name: string; address: string | null; organization_id: string } | null;
}

/**
 * Check for a cross-org M3 conflict via the governed edge function
 * `check-house-conflict-any-org` (Slice 2a-bis).
 *
 * The edge function performs a SERVICE-ROLE, RLS-bypassing SELECT on
 * `locations` by address_match_key across ALL orgs, then returns a
 * ROLE-TIERED verdict. This replaces the former `findHouseByMatchKeyAnyOrg`
 * direct DB call, which was a silent no-op under RLS (a user-scoped client
 * cannot see another org's rows — the cross-org conflict was invisible).
 *
 * **Safe-by-default (F2 discipline from !1319):** if the edge invoke errors
 * or is unavailable, the helper THROWS — never proceeds as if no conflict
 * exists. The caller does NOT need `conflict_org_id` to refuse — refusal is
 * correct; resolution is the admin's job.
 *
 * @returns `{ conflict: true }` or `{ conflict: false, existing_location_id? }`
 */
async function checkHouseConflictViaEdge(
  matchKey: string,
  effectiveOwnerOrgId: string,
  supabaseClient: SupabaseClient,
): Promise<{ conflict: boolean | 'review'; existing_location_id?: string; conflict_org_id?: string }> {
  if (!matchKey) return { conflict: false };

  const { data, error } = await supabaseClient.functions.invoke(
    'check-house-conflict-any-org',
    {
      body: {
        address_match_key: matchKey,
        effective_owner_org_id: effectiveOwnerOrgId,
      },
    },
  );

  if (error) {
    throw new Error(
      `checkHouseConflictViaEdge: cross-org M3 conflict check failed (edge function error). ` +
      `Error: ${error.message}. ` +
      'The helper NEVER proceeds as if no conflict exists when the check is unavailable.',
    );
  }

  const result = data as { conflict?: boolean | 'review'; existing_location_id?: string; conflict_org_id?: string; error?: string } | null;

  // TRI-STATE (2a-ter): valid conflict values are boolean OR the literal
  // 'review'. Anything else (missing, or an unexpected string) is an invalid
  // response → throw (fail-closed; never proceed as if no conflict exists).
  const validConflict =
    result != null &&
    (typeof result.conflict === 'boolean' || result.conflict === 'review');

  if (!validConflict) {
    throw new Error(
      'checkHouseConflictViaEdge: cross-org M3 conflict check returned an invalid response ' +
      `(${result?.error ?? 'no/invalid conflict field'}). ` +
      'The helper NEVER proceeds as if no conflict exists when the check is unavailable.',
    );
  }

  return {
    conflict: result.conflict as boolean | 'review',
    existing_location_id: result.existing_location_id,
    conflict_org_id: result.conflict_org_id,
  };
}

// ---------------------------------------------------------------------------
// resolveOrCreateHouse — THE main pipeline
// ---------------------------------------------------------------------------

/**
 * resolveOrCreateHouse — THE single canonical house place-attach helper.
 *
 * Every site/zone writer MUST call this to resolve-or-create the house
 * (locations row) for a place. No writer resolves the place its own way.
 *
 * Pipeline:
 *   1. Validate origin (S1 — unrecognised origins throw).
 *   2. Compute the effective dedup key ONCE (M1 — used for both dedup and write).
 *   3. resolveEffectiveOwnerOrg — determine the effective owner org.
 *   4. Dedup by (effective-owner org, effective dedup key) (M2 — org-aware).
 *   5. M3: for enforcement origins, check for legacy wrong-org conflicts.
 *   6. If existing under correct org: return it (action = 'existing').
 *   7. If absent: create the locations row (action = 'created').
 *   8. Return { locationId, effectiveOwnerOrgId, action }.
 *
 * Preconditions:
 *   - origin must be a recognised HouseOrigin (S1).
 *   - For enforcement origins, the caller must hold admin/master/grand_master
 *     role (M4 — bob-propose-place-org-from-parcel is role-gated).
 *
 * Program B seam (S3): the return type is the single attachment point for
 * the later location_events dual-write. Slices 2b–2d will add the event
 * write AFTER this helper returns, keyed on { locationId, action,
 * effectiveOwnerOrgId }. This helper does NOT write location_events.
 *
 * @param input - The pipeline input (caller org, origin, address, parcel, etc.).
 * @param supabaseClient - Supabase client (injected for testability).
 */
export async function resolveOrCreateHouse(
  input: ResolveOrCreateHouseInput,
  supabaseClient: SupabaseClient,
): Promise<ResolveOrCreateHouseResult> {
  const {
    callerOrgId,
    origin,
    address,
    parcel,
    name: inputName,
    createdBy,
  } = input;

  // ── S1: validate origin ──
  if (!ALL_RECOGNISED_ORIGINS.has(origin)) {
    throw new Error(
      `resolveOrCreateHouse: unrecognised origin '${origin}'. ` +
      `Recognised origins: ${[...ALL_RECOGNISED_ORIGINS].join(', ')}. ` +
      'An unrecognised origin must not silently default to caller-org ownership.',
    );
  }

  const label = address.label;
  const matchKey = address.addressMatchKey;
  const houseName = (inputName?.trim() || label || '').trim();

  if (!houseName) {
    throw new Error('resolveOrCreateHouse: house name is required (from input name or address label).');
  }

  // ── M1 + S2: compute the effective dedup key ONCE ──
  // Uses the LINZ matchKey when available; otherwise synthesizes from the
  // label using normaliseAddress() (same normalisation as canonicalSiteEntry /
  // canonicalZoneEntry). This value is used for BOTH the dedup query AND the
  // written address_match_key, so a synthesized key is deduped identically.
  const effectiveDedupKey = computeEffectiveDedupKey(matchKey, label);

  // ── Step 1: Resolve the effective owner org ──
  const { effectiveOwnerOrgId } = await resolveEffectiveOwnerOrg(
    callerOrgId,
    origin,
    parcel,
    label,
    matchKey,
    address.lat,
    address.lng,
    supabaseClient,
  );

  // ── Step 2: Dedup by (effective-owner org, effective dedup key) — M2 ──
  // Dedup is org-aware: the same address under different orgs = different houses.
  const existing = effectiveDedupKey
    ? await dedupHouseByMatchKey(effectiveDedupKey, effectiveOwnerOrgId, supabaseClient)
    : null;

  if (existing) {
    return {
      locationId: existing.id,
      effectiveOwnerOrgId,
      action: 'existing',
    };
  }

  // ── M3: legacy wrong-org conflict detection (enforcement origins only) ──
  // For enforcement origins, invoke the governed edge function
  // `check-house-conflict-any-org` (Slice 2a-bis) to perform a SERVICE-ROLE,
  // RLS-bypassing cross-org read. If a house with this dedup key exists under
  // a DIFFERENT org than the resolved effective owner, STOP — silent reuse
  // preserves bad ownership; silent recreate forks anchors.
  //
  // The edge fn returns a ROLE-TIERED response: officer/field roles get
  // { conflict: true } only (no cross-tenant detail); admin/master/grand_master
  // get full detail. The helper does NOT need conflict_org_id to refuse —
  // refusal is correct; resolution is the admin's job.
  //
  // Safe-by-default (F2 discipline): if the edge invoke errors or is
  // unavailable, checkHouseConflictViaEdge throws — never proceeds as if
  // no conflict exists.
  if (ENFORCEMENT_ORIGINS.has(origin) && effectiveDedupKey) {
    const conflictResult = await checkHouseConflictViaEdge(
      effectiveDedupKey,
      effectiveOwnerOrgId,
      supabaseClient,
    );

    // TRI-STATE branch (Slice 2a-ter, owner §4 ruling). Branch EXPLICITLY on
    // === true and === 'review' — do NOT use a truthy check: a truthy check
    // would collapse 'review' into the confirmed-conflict path and let a
    // default branch make a policy decision nobody made.
    //   - false    → proceed (fall through).
    //   - true     → CONFIRMED conflict, hard stop (dormant until 2e).
    //   - 'review' → UNCONFIRMED cross-org signal, SEPARATE hard stop with a
    //                distinct 'needs human confirmation' message.
    const detailParts: string[] = [];
    if (conflictResult.existing_location_id) {
      detailParts.push(`location ${conflictResult.existing_location_id}`);
    }
    if (conflictResult.conflict_org_id) {
      detailParts.push(`attached to org '${conflictResult.conflict_org_id}'`);
    }
    const detail = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';

    if (conflictResult.conflict === true) {
      // CONFIRMED cross-org conflict (same-parcel corroborated). Dormant today.
      throw new Error(
        `resolveOrCreateHouse: legacy wrong-org conflict detected. ` +
        `A house with address_match_key '${effectiveDedupKey}' exists under a different ` +
        `organisation than the resolved effective owner '${effectiveOwnerOrgId}'${detail}. ` +
        `For enforcement origins, silent reuse would preserve bad ownership and silent ` +
        `recreate would fork anchors. This conflict requires manual resolution.`,
      );
    }

    if (conflictResult.conflict === 'review') {
      // UNCONFIRMED cross-org signal (enforcement + parcel-unknown). This is a
      // WEAK signal, not a proven conflict: a same-address row exists under a
      // different org, but without parcel corroboration we cannot call it a
      // true conflict OR clear it. STOP and require human confirmation —
      // proceeding on uncertainty would risk forking an anchor the check
      // exists to protect. Message MUST read as unconfirmed, distinct from the
      // confirmed-conflict error above.
      throw new Error(
        `resolveOrCreateHouse: cross-org signal requires human confirmation. ` +
        `A house with address_match_key '${effectiveDedupKey}' may exist under a different ` +
        `organisation than the resolved effective owner '${effectiveOwnerOrgId}'${detail}. ` +
        `This is an UNCONFIRMED weak signal (no parcel corroboration available), NOT a ` +
        `proven conflict. For enforcement origins the helper stops rather than proceed on ` +
        `an unconfirmed cross-org match; a human must confirm or clear this before the ` +
        `house is created.`,
      );
    }
    // conflictResult.conflict === false → no conflict, proceed.
  }

  // ── Step 3: Create the locations (house) row ──
  // locations table columns (0143/0145): id, organization_id, name, address,
  // address_match_key, suburb, postcode, notes, created_by, timestamps.
  // NO geometry, NO client_organization_id.
  const houseRow: Record<string, unknown> = {
    organization_id: effectiveOwnerOrgId,
    name: houseName,
    address: label || null,
    address_match_key: effectiveDedupKey,
    suburb: address.suburb || null,
    postcode: address.postcode || null,
  };

  if (createdBy) {
    houseRow.created_by = createdBy;
  }

  const { data: created, error: insertErr } = await supabaseClient
    .from('locations')
    .insert(houseRow)
    .select('id, name')
    .single();

  if (insertErr || !created) {
    throw new Error(
      `resolveOrCreateHouse: locations insert failed: ${insertErr?.message ?? 'unknown error'}`,
    );
  }

  return {
    locationId: created.id as string,
    effectiveOwnerOrgId,
    action: 'created',
  };
}

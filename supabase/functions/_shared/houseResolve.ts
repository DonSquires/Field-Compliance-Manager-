/**
 * houseResolve.ts — edge-native house (locations) resolve-or-create +
 * tri-state cross-org conflict guard for Deno edge functions.
 *
 * Convergence Step 2, Slice 2d. GENERIC SEAM, NARROW DELIVERY (owner + Bob
 * ruling 2026-08-07, option B): this is the reusable edge analogue of the web
 * `apps/web/src/lib/resolveOrCreateHouse.ts` M3 path. Edge functions run on
 * Deno and CANNOT import the web module, so the resolve-or-create + conflict
 * logic is provided here for edge consumers.
 *
 *   FIRST consumer: `create_freedom_camping_zone` in bob-proposal-execute (2d).
 *   LATER consumers: the site-side enforcement writer (2f) and other
 *   org/site onboarding writers — a FOLLOW-ON slice wires those; do NOT
 *   broaden 2d to them.
 *
 * TRI-STATE (amendment !1328, Slice 2a-ter — the deployed
 * `check-house-conflict-any-org` returns `false | true | 'review'`):
 *   - false    -> no conflict; proceed (resolve/create the house).
 *   - true     -> CONFIRMED cross-org conflict; hard stop
 *                 (dormant today — requires same-parcel corroboration that
 *                 `locations` cannot yet supply; kept for when 2e lands).
 *   - 'review' -> UNCONFIRMED cross-org signal; hard stop, distinct
 *                 'needs human confirmation' message. NOT a proven conflict,
 *                 NOT auto-cleared.
 * Branch EXPLICITLY on === true / === 'review' — never a truthy check (owner
 * §4 ruling: a truthy check would collapse 'review' into the confirmed path
 * and let a default branch make a policy decision nobody made).
 *
 * FAIL-CLOSED (F2 discipline): if the conflict invoke errors, is unavailable,
 * or returns an invalid verdict, THROW — never proceed as if no conflict.
 *
 * #297 (Model-A): the org passed in is the OWNER org (own-rooted). This seam
 * does NOT reason about the contractual-client role — that is the
 * service_agreement/module layer, out of scope here. Carries no legacy
 * "owning client organisation" framing.
 *
 * NOTE: like 2a-bis, this is a check-then-create guard, NOT a race-safe
 * uniqueness invariant (Slice 2e owns the hard constraint).
 */ import { computeEffectiveDedupKey } from './addressKey.ts';
/**
 * Distinguishes the two hard-stop states so the caller can record a distinct
 * audit outcome. `kind:'review'` MUST read as UNCONFIRMED, not proven.
 */ export class HouseConflictError extends Error {
  kind;
  constructor(kind, message){
    super(message);
    this.name = 'HouseConflictError';
    this.kind = kind;
  }
}
/**
 * Invoke the deployed governed `check-house-conflict-any-org` edge fn and
 * return the validated tri-state verdict. Fail-closed on error/invalid shape.
 */ export async function checkHouseConflictEdge(admin, addressMatchKey, effectiveOwnerOrgId) {
  const { data, error } = await admin.functions.invoke('check-house-conflict-any-org', {
    body: {
      address_match_key: addressMatchKey,
      effective_owner_org_id: effectiveOwnerOrgId
    }
  });
  if (error) {
    const msg = error?.message ?? String(error);
    throw new Error(`checkHouseConflictEdge: cross-org conflict check failed (edge invoke error: ${msg}). ` + 'Fail-closed: never proceeding as if no conflict exists when the check is unavailable.');
  }
  const result = data ?? null;
  const valid = result != null && (typeof result.conflict === 'boolean' || result.conflict === 'review');
  if (!valid) {
    throw new Error(`checkHouseConflictEdge: invalid conflict verdict (${result?.error ?? 'no/invalid conflict field'}). ` + 'Fail-closed: never proceeding as if no conflict exists.');
  }
  return result;
}
/**
 * Resolve-or-create the house (locations) row for a place, applying the
 * tri-state cross-org guard on enforcement origins.
 *
 * Steps:
 *   1. If addressMatchKey present: dedup within the OWNER org
 *      (locations by (organization_id, address_match_key)). Hit => return existing.
 *   2. ENFORCEMENT origin only: invoke the tri-state conflict guard.
 *        false -> continue; true -> throw HouseConflictError('conflict');
 *        'review' -> throw HouseConflictError('review').
 *   3. Insert the locations row (organization_id = owner org) and return created.
 *
 * The caller writes the returned locationId onto its facet row
 * (e.g. location_zones.location_id).
 */ export async function resolveOrCreateHouseEdge(admin, input) {
  const { orgId, addressMatchKey, origin } = input;
  // ── Central identity reconciliation (Duo review 3 / owner ruling Option 1) ──
  // The invariant "a place with an address has a dedup key, and any resolvable
  // identity is guarded" lives HERE, in the seam — NOT in each caller. A
  // reusable seam that trusts callers to keep address+key in sync is fragile
  // (documentation is not a security control). We derive ONE canonical key:
  //   supplied addressMatchKey, else computeEffectiveDedupKey(null, address).
  // computeEffectiveDedupKey normalises (trim/collapse/lowercase), so the same
  // canonical address string feeds BOTH the key and the stored address.
  const suppliedKey = (addressMatchKey ?? '').trim();
  const rawAddress = (input.address ?? '').trim();
  const hasResolvedAddress = !!rawAddress;
  const effectiveKey = (suppliedKey || computeEffectiveDedupKey(null, rawAddress || null) || '').trim();
  // Ruling B: no key AND no address => no defensible house identity => skip
  // (no synthetic house; caller leaves location_id null by design).
  if (!effectiveKey && !hasResolvedAddress) {
    return {
      locationId: null,
      action: 'skipped'
    };
  }
  // Fail-closed backstop (Option 1, DEFENCE-IN-DEPTH): an address that yields
  // NO derivable key after normalisation is a half-identified place; for an
  // ENFORCEMENT origin we must NOT create it un-guarded — hard stop.
  //
  // HONESTY: with the CURRENT normaliseAddress (trim/collapse/lowercase, no
  // punctuation strip), a non-empty trimmed rawAddress always yields a non-empty
  // key, so hasResolvedAddress <=> effectiveKey!=='' — this branch is currently
  // UNREACHABLE by construction. It is kept deliberately: if normaliseAddress
  // ever changes to strip characters that .trim() does not, this prevents an
  // un-guardable enforcement house from being created. Not falsely unit-tested
  // (it cannot be reached with the current normaliser); documented instead.
  if (!effectiveKey && hasResolvedAddress && origin === 'enforcement') {
    throw new Error('resolveOrCreateHouseEdge: enforcement place has an address but no derivable ' + 'dedup key after normalisation — refusing to create an un-guardable house (fail-closed).');
  }
  const key = effectiveKey;
  // Step 1: own-org dedup (only meaningful with a key).
  if (key) {
    const { data: existing, error: dedupErr } = await admin.from('locations').select('id').eq('organization_id', orgId).eq('address_match_key', key).maybeSingle();
    if (dedupErr) {
      throw new Error(`resolveOrCreateHouseEdge: own-org house dedup query failed: ${dedupErr?.message ?? 'unknown'}`);
    }
    if (existing?.id) {
      return {
        locationId: String(existing.id),
        action: 'existing'
      };
    }
  }
  // Step 2: ENFORCEMENT cross-org guard (tri-state). Runs whenever we have a
  // canonical key — which, after central reconciliation above, is present for
  // ANY resolvable identity (supplied key OR derived-from-address). The old
  // `origin==='enforcement' && key` gate keyed only on a SUPPLIED key, which
  // let an address-without-key enforcement place skip the guard (Duo review 3).
  if (origin === 'enforcement' && key) {
    const verdict = await checkHouseConflictEdge(admin, key, orgId);
    // EXPLICIT tri-state branching — never a truthy check (owner §4 ruling).
    if (verdict.conflict === true) {
      // CONFIRMED cross-org conflict (dormant until 2e supplies parcel corroboration).
      // REDACTION (Bob attack #5): do NOT include conflict_org_id / any other-org
      // identifier in this message — it is written verbatim into the owner-org-
      // readable bob_agentic_actions.error_message by the caller's failFc, which
      // would route the edge fn's redacted-out cross-tenant id back to the owner
      // and bypass check-house-conflict-any-org's role-tiering. Refusal does not
      // need the other org's identity (existence-not-identity, per 2a-ter).
      throw new HouseConflictError('conflict', `Cross-org conflict: a house with this address already exists under a different ` + `organisation than the resolved owner '${orgId}'. Silent reuse would preserve bad ` + `ownership; silent recreate would fork anchors. Manual resolution required.`);
    }
    if (verdict.conflict === 'review') {
      // UNCONFIRMED weak signal — hard stop, distinct 'needs human confirmation'.
      // REDACTION (Bob attack #5): no conflict_org_id / other-org identifier in
      // the message (see the `true` branch above — same audit-row leak reason).
      throw new HouseConflictError('review', `Cross-org signal requires human confirmation (UNCONFIRMED, not a proven conflict): ` + `a house with this address may exist under a different organisation than the resolved ` + `owner '${orgId}'. No parcel corroboration is available, so this is neither ` + `auto-confirmed nor auto-cleared. A human must confirm or clear it before the house is created.`);
    }
  // verdict.conflict === false -> fall through to create.
  }
  // (Skip / fail-closed decisions were made up-front during central identity
  // reconciliation — by this point we have a resolvable identity and, for
  // enforcement, the guard has run.)
  // Step 3: create the house. locations columns (0143/0145): id, organization_id,
  // name, address, address_match_key, suburb, postcode, notes, created_by, timestamps.
  const houseRow = {
    organization_id: orgId,
    name: (input.label ?? '').trim() || (input.address ?? '').trim() || 'Unnamed place',
    // address column takes ONLY a real address — never the zone display NAME
    // (Duo review): input.label is a display name, and writing it here would
    // pollute locations.address with non-address data that can desync from the
    // LINZ-derived address_match_key. The `name` column below may fall back to
    // the label (a display name is correct there); `address` must not.
    address: rawAddress || null,
    address_match_key: key || null,
    suburb: (input.suburb ?? null) || null,
    postcode: (input.postcode ?? null) || null
  };
  if (input.createdBy) houseRow.created_by = input.createdBy;
  const { data: created, error: insertErr } = await admin.from('locations').insert(houseRow).select('id').single();
  if (insertErr || !created?.id) {
    throw new Error(`resolveOrCreateHouseEdge: locations insert failed: ${insertErr?.message ?? 'unknown'}`);
  }
  return {
    locationId: String(created.id),
    action: 'created'
  };
}

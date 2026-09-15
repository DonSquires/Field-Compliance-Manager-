/**
 * houseResolve.ts — edge-native house (locations) resolve-or-create for Deno
 * edge functions.
 *
 * Owner ruling 2026-09-15 (docs/canon/LOCATION_HOUSE_MODEL.md): a house is an
 * organisation's link to ONE registry place (canonical_places). The same
 * address held by another organisation is the same place, not a conflict —
 * the database assigns both houses the same canonical_place_id. So this seam
 * only dedups inside the owner organisation and creates the house when none
 * exists; the old tri-state cross-org hard stop is gone. HouseConflictError is
 * kept only so existing callers keep compiling; it is no longer thrown here.
 *
 * #297 (Model-A): the org passed in is the OWNER org (own-rooted).
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
 * Resolve-or-create the house (locations) row for a place.
 *
 * Steps:
 *   1. If an address key can be derived: dedup within the OWNER org
 *      (locations by (organization_id, address_match_key)). Hit => return existing.
 *   2. Insert the locations row (organization_id = owner org) and return created.
 *      The database trigger assigns its canonical_place_id (shared across
 *      organisations for the same address).
 *
 * The caller writes the returned locationId onto its facet row
 * (e.g. location_zones.location_id).
 */ export async function resolveOrCreateHouseEdge(admin, input) {
  const { orgId, addressMatchKey } = input;
  // One key, derived with the same rule the database applies on write, so the
  // dedup query and the stored key never disagree.
  const rawAddress = (input.address ?? '').trim();
  const hasResolvedAddress = !!rawAddress;
  const effectiveKey = computeEffectiveDedupKey(addressMatchKey ?? null, rawAddress || null) ?? '';
  // Ruling B: no key AND no address => no defensible house identity => skip
  // (no synthetic house; caller leaves location_id null by design).
  if (!effectiveKey && !hasResolvedAddress) {
    return {
      locationId: null,
      action: 'skipped'
    };
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
  // Step 2 (removed 2026-09-15): no cross-org guard — the registry gives both
  // organisations' houses the same canonical place.
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

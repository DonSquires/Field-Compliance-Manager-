/**
 * addressKey.ts — SHARED address dedup-key derivation for edge functions.
 *
 * The key rule lives in the database as public.address_match_key(text)
 * (migration 20260915170000): lowercase the address and remove every run of
 * non-alphanumeric characters. Triggers on locations/client_sites re-derive the
 * stored key with that rule on every write, so edge code MUST look rows up with
 * the same shape or it will miss them and create duplicates. Pinned by
 * test/place-model-convergence.test.js against the SQL definition.
 *
 * PURE: no imports, no framework deps — just string logic.
 */ /**
 * Normalise an address string for display comparison: trim, collapse internal
 * whitespace to single spaces, lowercase.
 */ export function normaliseAddress(addr) {
  return addr.trim().replace(/\s+/g, ' ').toLowerCase();
}
/**
 * The single address key rule — identical to public.address_match_key(text).
 * Returns null when nothing alphanumeric remains.
 */ export function addressMatchKey(addr) {
  if (addr == null) return null;
  const key = String(addr).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key || null;
}
/**
 * Compute the effective dedup key for a house: a supplied key (e.g. a LINZ
 * canonical address) or the address label, both passed through the one rule.
 */ export function computeEffectiveDedupKey(matchKey, label) {
  return addressMatchKey(matchKey) ?? addressMatchKey(label);
}

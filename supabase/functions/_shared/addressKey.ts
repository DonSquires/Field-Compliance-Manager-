/**
 * addressKey.ts — SHARED pure address dedup-key derivation for edge functions.
 *
 * Convergence Step 2, Slice 2d (Bob attack #4: dedup-key parity). This is a
 * FAITHFUL PORT of the web `apps/web/src/lib` logic:
 *   - `normaliseAddress`        (from siteAnchorAddress.ts)
 *   - `computeEffectiveDedupKey` (from resolveOrCreateHouse.ts)
 * The bodies are intentionally IDENTICAL. Edge (Deno) code cannot import the
 * web module, so the SAME pure logic lives here for edge consumers.
 *
 * WHY THIS MATTERS (not a tidy-up): the dedup key IS part of the enforcement
 * decision. If web and edge normalise addresses differently, the same physical
 * address can produce different keys → different cross-org conflict verdicts
 * depending on which path created the row. Parity must hold.
 *
 * LOCKSTEP: if the web `normaliseAddress` / `computeEffectiveDedupKey` change,
 * update these to match (and vice versa). A later slice may re-point the web
 * path at this shared module to make the lockstep structural rather than
 * by-discipline; for now the bodies are kept identical and pinned by tests.
 *
 * PURE: no imports, no framework deps — just string logic.
 */ /**
 * Normalise an address string for comparison/keying: trim, collapse internal
 * whitespace to single spaces, lowercase. IDENTICAL to web
 * siteAnchorAddress.ts::normaliseAddress.
 */ export function normaliseAddress(addr) {
  return addr.trim().replace(/\s+/g, ' ').toLowerCase();
}
/**
 * Compute the effective dedup key for a house. IDENTICAL to web
 * resolveOrCreateHouse.ts::computeEffectiveDedupKey.
 *
 *   - LINZ matchKey present  → use it VERBATIM (label ignored).
 *   - else label present     → normaliseAddress(label).
 *   - else                   → null (no key; cannot dedup / cross-org match).
 *
 * Computed ONCE and used for BOTH the dedup query AND the written
 * address_match_key, so a synthesized key dedups identically to a real LINZ key.
 */ export function computeEffectiveDedupKey(matchKey, label) {
  if (matchKey) return matchKey;
  if (label) return normaliseAddress(label);
  return null;
}

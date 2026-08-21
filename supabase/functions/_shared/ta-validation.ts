/**
 * _shared/ta-validation.ts -- Shared TA name validation logic.
 *
 * Phase 2 of the geofence redesign (epic #226). Extracts the Levenshtein
 * distance, fuzzy suggestion, and NZTA FeatureServer fetch logic so that
 * BOTH the propose-time and execute-time paths share the same code.
 *
 * Reuses the proven logic from bob-proposal-execute/index.ts (Phase 0,
 * commit on !1052). The executor imports from here instead of maintaining
 * its own copy.
 *
 * Q1 ruling: canonical TA names from LIVE authoritative data, NEVER a
 * hardcoded 2013 list.
 */ // ---------------------------------------------------------------------------
// NZTA FeatureServer configuration
// ---------------------------------------------------------------------------
export const NZTA_TA_FEATURESERVER = Deno.env.get('NZTA_TA_FEATURESERVER') ?? 'https://spatial.nzta.govt.nz/portal/rest/services/Hosted/Territorial_Authority_Boundaries/FeatureServer/0';
const NZTA_TA_NAME_FIELD = Deno.env.get('NZTA_TA_NAME_FIELD') ?? '';
export const TA_NAME_CANDIDATES = NZTA_TA_NAME_FIELD ? [
  NZTA_TA_NAME_FIELD
] : [
  'ta2013name',
  'portalsearch',
  'TA2025_NAME',
  'TA_NAME',
  'NAME',
  'name'
];
// ---------------------------------------------------------------------------
// Levenshtein distance (pure, no deps)
// ---------------------------------------------------------------------------
export function levenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const prev = Array.from({
    length: lb + 1
  }, (_, i)=>i);
  for(let i = 1; i <= la; i++){
    let corner = i - 1;
    prev[0] = i;
    for(let j = 1; j <= lb; j++){
      const upper = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? corner : 1 + Math.min(corner, upper, prev[j - 1]);
      corner = upper;
    }
  }
  return prev[lb];
}
// ---------------------------------------------------------------------------
// Fuzzy top-N suggestions
// ---------------------------------------------------------------------------
export function fuzzyTopN(input, candidates, n = 3) {
  const lower = input.toLowerCase();
  return candidates.map((c)=>({
      name: c,
      dist: levenshtein(lower, c.toLowerCase())
    })).sort((a, b)=>a.dist - b.dist).slice(0, n).map((x)=>x.name);
}
// ---------------------------------------------------------------------------
// In-memory cache for live-fetched canonical TA names
// ---------------------------------------------------------------------------
let _canonicalTaNames = null;
let _canonicalTaNamesFetchedAt = 0;
const TA_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * Fetch the canonical TA name list from the LIVE NZTA FeatureServer.
 * Caches in memory for 10 minutes. Returns empty array on total failure
 * (caller decides whether to block or fall through).
 */ export async function fetchCanonicalTaNames() {
  const now = Date.now();
  if (_canonicalTaNames && now - _canonicalTaNamesFetchedAt < TA_CACHE_TTL_MS) {
    return _canonicalTaNames;
  }
  const candidates = NZTA_TA_NAME_FIELD ? [
    NZTA_TA_NAME_FIELD
  ] : [
    ...TA_NAME_CANDIDATES
  ];
  for (const field of candidates){
    try {
      const url = `${NZTA_TA_FEATURESERVER}/query` + `?where=1=1&outFields=${encodeURIComponent(field)}` + `&returnGeometry=false&returnDistinctValues=true` + `&resultRecordCount=200&f=json`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.error) continue;
      const features = body.features ?? [];
      if (features.length === 0) continue;
      const firstAttrs = features[0]?.attributes;
      if (!firstAttrs || !(field in firstAttrs)) continue;
      const names = features.map((f)=>f.attributes?.[field]).filter((v)=>typeof v === 'string' && v.trim().length > 0).map((v)=>v.trim());
      const unique = [
        ...new Set(names)
      ];
      if (unique.length > 0) {
        _canonicalTaNames = unique;
        _canonicalTaNamesFetchedAt = now;
        return unique;
      }
    } catch  {
      continue;
    }
  }
  console.error('[ta-validation] fetchCanonicalTaNames: could not fetch from NZTA FeatureServer (all candidate fields failed)');
  return [];
}
/**
 * Validate a single TA name against the live canonical set.
 * Returns null if valid, or an actionable error message with fuzzy suggestions
 * if invalid. If the live fetch fails, returns null (defence in depth: do not
 * hard-block on the validator being unavailable).
 */ export async function validateTaName(name) {
  let canonical;
  try {
    canonical = await fetchCanonicalTaNames();
  } catch (e) {
    console.error('[ta-validation] validateTaName: live TA name fetch failed, falling through:', e instanceof Error ? e.message : String(e));
    return null;
  }
  if (canonical.length === 0) {
    console.warn('[ta-validation] validateTaName: canonical TA name list is empty, falling through');
    return null;
  }
  // Exact match (case-insensitive)
  const match = canonical.find((c)=>c.toLowerCase() === name.toLowerCase());
  if (match) return null; // valid
  // No match -- compute fuzzy suggestions
  const suggestions = fuzzyTopN(name, canonical, 3);
  const suggestStr = suggestions.map((s)=>"'" + s + "'").join(', ');
  return "'" + name + "' is not a valid NZ Territorial Authority name. Did you mean: " + suggestStr + "?";
}
/**
 * Validate multiple TA names. Returns null if all valid, or the first
 * validation error message.
 */ export async function validateTaNames(names) {
  for (const name of names){
    const err = await validateTaName(name);
    if (err) return err;
  }
  return null;
}
/**
 * Force-clear the in-memory cache (useful after a refresh).
 */ export function clearTaNameCache() {
  _canonicalTaNames = null;
  _canonicalTaNamesFetchedAt = 0;
}

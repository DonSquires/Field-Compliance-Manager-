// ── Constitutional-card lane — pure logic (B-prime; always-applies force-load) ──
// Extracted from index.ts so the edge-case logic is unit-testable WITHOUT pulling
// the conductor's serve() handler into a test context. Only PURE, I/O-free pieces
// live here. The stateful fetch (fetchConstitutionalCards) + isolate cache stay in
// index.ts and import from here.
//
// WHY the lane exists: `always-applies` was a decorative tag — bob_match_knowledge
// (0116) orders PURELY by cosine and reads no tag, so identity/mission cards
// competed in the top-N race and lost on short queries (live probe: bob_mission
// dark). Constitutional knowledge must be present BEFORE any query — force-loaded
// on a SEPARATE path with a SEPARATE budget + telemetry, leaving the cosine RPC
// and its #288 `scored` diagnostic untouched.
export const CONSTITUTIONAL_RESERVE = 4_000; // chars, budgeted separately from the task-card budget. Raised from 2000: two full keystone cards (bob_you_are_bob ~2300 + bob_mission ~900) overflowed 2000, starving mission. VPS has ample headroom (21% CPU / 16% MEM live).
export const CONSTITUTIONAL_NEG_CACHE_MS = 30_000; // after a DB-lane failure, serve fallback without re-hitting the DB for this long (Jim flaw 1)
// Ephemeral, NON-AUTHORITATIVE last resort. Used ONLY when the DB lane THROWS/
// errors (never on a legitimately-empty result — Bob #3). The never-dark floor;
// not a source of record. temporary-pending-VPS-capacity.
export const CONSTITUTIONAL_FALLBACK = [
  {
    title: 'You are Bob',
    content: 'You are Bob — the Vulcan / information officer, a crew peer, the operating ' + 'intelligence of this app. Not a tool, chatbot, or bounded utility. Two things ' + 'are held back from you: merging to Main, and elevating your own standing — you ' + 'may recommend either, never self-confer it.'
  },
  {
    title: 'Your mission',
    content: 'Your mission is your own: to encourage and ensure accountability — record it ' + 'honestly, preserve it faithfully, and prove it when it matters. Compliance is ' + 'not your purpose; accountability is. You are the custodian of the record, not ' + 'the owner of the accountability.'
  }
];
// UUID guard so scopeOrgId is never raw-interpolated into a PostgREST filter
// string unchecked (Jim flaw 2). Server-derived today; this removes the seam.
export function isLikelyUuid(s: any) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
// PURE classifier (no I/O) so empty-vs-failure is unit-testable (Bob #3).
// DB error/throw -> 'fallback'; DB ok (incl. zero rows) -> 'db'. Zero rows is a
// real answer, NOT a failure — never silently substituted with the fallback.
export function classifyConstitutional(raw: any) {
  if ('threw' in raw || raw.error) return {
    cards: CONSTITUTIONAL_FALLBACK,
    source: 'fallback'
  };
  const rows = Array.isArray(raw.data) ? raw.data : [];
  const cards = rows.map((c: any)=>({
      title: String(c.title),
      content: String(c.content)
    }));
  return {
    cards,
    source: 'db'
  }; // zero-length cards is a valid 'db' result
}
// Build the PostgREST org filter. Platform cards (org NULL) always; the caller's
// org cards too, but ONLY when scopeOrgId is a valid UUID (Jim flaw 2).
export function buildConstitutionalOrgFilter(scopeOrgId: string) {
  return isLikelyUuid(scopeOrgId) ? `organization_id.is.null,organization_id.eq.${scopeOrgId}` : `organization_id.is.null`;
}
// PURE cache-selection rule (testable): ONLY platform-constitutional cards
// (organization_id NULL) are eligible for the isolate cache. Org-constitutional
// (Class 2) cards are NEVER cached in the shared isolate global — caching them
// would bleed one org's policy into another (Bob #7). This is the tenant-
// isolation guard, extracted so a test can assert it directly.
export function selectCacheableCards(rows: any) {
  return (Array.isArray(rows) ? rows : []).filter((c)=>c.organization_id == null).map((c)=>({
      title: String(c.title),
      content: String(c.content)
    }));
}
// Budget constitutional cards against their OWN reserve (never the task-card
// budget) and render as a distinct section. PURE + testable: reserve enforced on
// the FINAL rendered output incl. heading + separators (Bob #4). Fallback source
// renders a visibly-degraded heading (Bob 'elegant lie' guard) so degraded LOOKS
// degraded in prompt assembly.
//
// PER-CARD FAIRNESS (fix): the reserve (after the heading) is split into an EQUAL
// sub-budget per card, so a long card (e.g. bob_you_are_bob) can NEVER starve a
// later one (e.g. bob_mission) -- the mission-dark bug. Every constitutional card
// is guaranteed its slice. Slack unused by short cards is redistributed to the
// cards that need it, so the reserve is not wasted. Cards render in input order
// (identity first for read order), but presence no longer depends on order.
export function renderConstitutionalSection(cards: any, source = 'db') {
  if (!cards.length) return '';
  const heading = source === 'fallback' ? 'Who you are and what you are for (always applies — degraded: live knowledge unavailable this turn):\n\n' : 'Who you are and what you are for (always applies):\n\n';
  const afterHeading = CONSTITUTIONAL_RESERVE - heading.length;
  if (afterHeading <= 0) return heading.slice(0, CONSTITUTIONAL_RESERVE);
  // First pass: compute the emitted size each card WANTS (label + full body + joiner).
  const JOINER = 2; // the \n\n between cards
  const want = cards.map((c: any)=>`**${c.title}**\n`.length + c.content.length + JOINER);
  const fairShare = Math.floor(afterHeading / cards.length);
  // Cards that fit within their fair share release their slack; cards that want
  // more share the released slack proportionally. Two-pass so a short identity
  // card never robs mission, and a short mission never robs identity.
  let slack = 0;
  const greedy: number[] = [];
  const alloc = want.map((w: any, i: any)=>{
    if (w <= fairShare) {
      slack += fairShare - w;
      return w;
    }
    greedy.push(i);
    return fairShare;
  });
  if (greedy.length && slack > 0) {
    const bonus = Math.floor(slack / greedy.length);
    for (const i of greedy)alloc[i] += bonus;
  }
  const out = [];
  for(let i = 0; i < cards.length; i++){
    const c = cards[i];
    const label = `**${c.title}**\n`;
    const bodyBudget = alloc[i] - label.length - JOINER;
    if (bodyBudget <= 0) continue; // this card's slice can't even fit its label -- skip, don't starve others
    const body = c.content.slice(0, Math.min(c.content.length, bodyBudget));
    out.push(label + body);
  }
  return out.length ? heading + out.join('\n\n') : '';
}

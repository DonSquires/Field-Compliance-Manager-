// ── query-records-conductor.ts — pure conductor logic for query_records ──────
// Extracted from index.ts so the routing, promotion-guard, person-safe render,
// and terminal-refusal logic are unit-testable WITHOUT pulling the conductor's
// serve() handler into a test context. Only PURE, I/O-free pieces live here.
// The stateful callFn dispatch stays in index.ts and imports from here.
//
// Build-spec: #334 (F1a routing, F1b promotion-guard class fix, F1c person-safe
// render, F2 permanent-refusal terminal). Ratified by Don 2026-08-16.
// ── Types ────────────────────────────────────────────────────────────────────
/** The set of valid query types recognised by the conductor. */ export const VALID_QUERY_TYPES = new Set([
  'find_org',
  'get_org',
  'list_orgs',
  'list_sites',
  'list_routes',
  'list_zones',
  'find_user'
]);
/**
 * Query types that are ORG-shaped — eligible for name-promotion to find_org.
 * An EXPLICIT non-org query type (find_user, or any future person/other type)
 * must NEVER be promoted to find_org. This set is the positive list of types
 * that the promotion path may produce; everything else is excluded.
 *
 * #334 F1b class fix (Don): promotion fires ONLY when the caller did NOT
 * supply an explicit non-org query type. The old code promoted on the mere
 * presence of a name — no check for explicit type. That is the bug class.
 */ export const ORG_QUERY_TYPES = new Set([
  'find_org',
  'get_org',
  'list_orgs',
  'list_sites',
  'list_routes',
  'list_zones'
]);
// ── Person-safe Tier-0 field policy (#323 / #334 F1c) ────────────────────────
// Directory-mode find_user is Tier-0-ratified (#323, STAGING 2026-08-15):
//   surfaceable: display_name, role, managing-org
//   NEVER echoed: id, email, phone, uuid
//
// This is the SINGLE source of truth for which person fields may appear in
// human-facing reply text. Tests pin against this set.
/** Fields that MAY appear in human-facing person result text. */ // NOTE: organization_id was removed because renderPersonRow correctly declines
// to emit the org UUID (no org NAME is available). Managing-org NAME resolution
// is a deliberately deferred later slice — do NOT build it here.
export const PERSON_SURFACEABLE_FIELDS = new Set([
  'display_name',
  'role'
]);
/** Fields that must NEVER appear in human-facing person result text. */ export const PERSON_FORBIDDEN_FIELDS = new Set([
  'id',
  'email',
  'phone',
  'uuid'
]);
/**
 * Resolve the effective query type and apply the promotion guard.
 *
 * Rules (from #334, Don-ratified):
 * 1. If q is in VALID_QUERY_TYPES, it passes through unchanged (F1a).
 * 2. If q is NOT valid AND q is NOT an explicit non-org type (i.e. q is empty
 *    or not in any known set), AND a name-like arg is present, promote to
 *    find_org (the existing self-heal behaviour).
 * 3. If q is NOT valid AND q IS an explicit type (non-empty, not in
 *    ORG_QUERY_TYPES), it is NEVER promoted — the real error surfaces (F1b).
 * 4. If q is NOT valid and no name-like arg is present, the real error
 *    surfaces (existing behaviour).
 */ export function resolveQueryRouting(q, args) {
  // F1a: valid query types pass through unchanged.
  if (VALID_QUERY_TYPES.has(q)) {
    return {
      effectiveQuery: q,
      promoted: false,
      args
    };
  }
  // F1b class fix: if the caller supplied an explicit, non-empty query type
  // that is NOT an org-shaped type, do NOT promote it. Let the real error
  // surface so the reasoning loop can self-correct.
  // An explicit type is any non-empty string that was intentionally supplied.
  // The only types eligible for promotion are the org-shaped ones (or empty/
  // missing, which means "no type supplied").
  if (q !== '' && !ORG_QUERY_TYPES.has(q)) {
    // Explicit non-org type — never promote. Surface the real error.
    console.warn(`[conductor][query_records] explicit non-org query type "${q}" — not promoting to find_org (class fix #334 F1b)`);
    return {
      effectiveQuery: q,
      promoted: false,
      args
    };
  }
  // Legacy promotion path: q is empty or an unrecognised org-ish string.
  // Only promote if a name-like arg is present.
  let promoted = false;
  const mutatedArgs = {
    ...args
  };
  if (!args.name && !args.search && !args.args?.name) {
    const nameGuess = args.org_name ?? args.organization_name ?? args.client_name ?? args.branch_name ?? args.search_term ?? '';
    if (nameGuess) {
      mutatedArgs.args = {
        ...mutatedArgs.args ?? {},
        name: nameGuess
      };
      promoted = true;
    }
  } else {
    promoted = true;
  }
  if (promoted) {
    console.warn(`[conductor][query_records] no valid lookup type supplied (got "${q}"), defaulting to find_org (name-like arg found)`);
    return {
      effectiveQuery: 'find_org',
      promoted: true,
      args: mutatedArgs
    };
  }
  // No promotable name — let the real error surface.
  console.warn(`[conductor][query_records] invalid lookup type "${q}" with no promotable name — letting the real error surface`);
  return {
    effectiveQuery: q,
    promoted: false,
    args: mutatedArgs
  };
}
/**
 * Check whether a downstream error response is a terminal (permanent,
 * non-retryable) refusal.
 *
 * #334 F2 (Don-ratified, foundation-level):
 * - SEMANTIC, not transport-keyed: terminal if body says permanent === true
 *   OR retryable === false, regardless of HTTP status.
 * - TERMINATE-BEFORE-GENERATION: this check is ordered AHEAD of all retry/
 *   promotion/rewrite logic in the caller.
 * - CLEAN human-facing output: no retry instruction, no [INTERNAL:] text.
 * - NO SECOND DOOR: the caller must not allow any other path to defeat this.
 *
 * @param responseData The parsed response body from callFn (r.data).
 */ export function checkTerminalRefusal(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return {
      isTerminal: false
    };
  }
  const isPermanent = responseData.permanent === true;
  const isNotRetryable = responseData.retryable === false;
  if (isPermanent || isNotRetryable) {
    // Build a clean human-facing message. No retry instruction, no [INTERNAL:]
    // scaffolding, no prompt text.
    const reason = typeof responseData.error === 'string' ? responseData.error : typeof responseData.detail === 'string' ? responseData.detail : 'This lookup cannot be completed.';
    return {
      isTerminal: true,
      terminalMessage: reason
    };
  }
  return {
    isTerminal: false
  };
}
// ── F1c: Person-safe render ──────────────────────────────────────────────────
/**
 * Render a single person result row using ONLY Tier-0 surfaceable fields.
 * NEVER emits id, email, phone, or uuid into the human-facing text.
 *
 * #334 F1c (Don-ratified): fail-closed. If the row cannot be classified
 * (missing display_name), returns null — the caller must handle this as a
 * terminal safe response, NOT fall through to a generic formatter.
 */ export function renderPersonRow(row) {
  const displayName = row.display_name;
  if (typeof displayName !== 'string' || !displayName.trim()) {
    // Fail-closed: cannot classify this person row.
    return null;
  }
  const parts = [
    `- **${displayName.trim()}**`
  ];
  if (typeof row.role === 'string' && row.role.trim()) {
    parts.push(`(${row.role.trim()})`);
  }
  // Managing org: we have organization_id but not the org name in the person
  // result. The id is carry-only (never echoed). If a managing_org_name were
  // available we'd show it; for now we omit rather than leak the UUID.
  // This is the correct Tier-0 behaviour: show what's surfaceable, omit
  // what isn't, never guess.
  return parts.join(' ');
}
/**
 * Render person results (find_user) using the dedicated person-safe path.
 *
 * #334 F1c acceptance:
 * - Renders ONLY Tier-0 person shape: display_name, role, managing-org.
 * - NEVER emits raw id/UUID, email, or phone into reply text.
 * - The default/generic org formatter is UNREACHABLE for person results.
 * - FAIL-CLOSED: if the person-safe branch cannot classify/format the
 *   payload, it STOPS with a safe terminal message — does NOT fall through.
 * - Decline-don't-guess.
 *
 * @returns The rendered reply string. Always safe; never falls through.
 */ export function renderPersonResults(results) {
  if (!results.length) {
    return 'I looked but found no matching person records.';
  }
  const rendered = [];
  let failedCount = 0;
  for (const row of results.slice(0, 10)){
    const line = renderPersonRow(row);
    if (line !== null) {
      rendered.push(line);
    } else {
      failedCount++;
    }
  }
  if (rendered.length === 0) {
    // Fail-closed: none of the rows could be safely rendered.
    return 'I found person records but could not safely format them for display. Please refine your search.';
  }
  const header = `Found ${results.length} person record(s):`;
  const body = rendered.join('\n');
  const warning = failedCount > 0 ? `\n(${failedCount} result(s) could not be safely displayed.)` : '';
  return `${header}\n${body}${warning}`;
}
// ── Result rendering (org-shaped + person-safe dispatch) ─────────────────────
/**
 * Render query_records results into human-facing reply text.
 *
 * Dispatches to the person-safe renderer for find_user results.
 * All other query types use the existing org-shaped formatters.
 * The generic/default formatter is UNREACHABLE for find_user results.
 */ export function renderQueryResults(q, results) {
  // F1c: person results go through the dedicated person-safe path.
  // The generic formatter is unreachable for find_user.
  if (q === 'find_user') {
    return renderPersonResults(results);
  }
  // Org-shaped formatters (existing behaviour, unchanged).
  if (!results.length) {
    return `I looked but found no matching records for that ${q}.`;
  }
  const lines = results.slice(0, 10).map((row)=>{
    if (q === 'list_zones') {
      return `- ${row.name ?? '(unnamed zone)'}${row.rule_type ? ` [${row.rule_type}]` : ''} — ${row.has_boundary ? 'boundary set' : 'no boundary'} [id ${row.id}]`;
    }
    if (q === 'list_sites') {
      return `- ${row.name ?? '(unnamed site)'}${row.address ? ` — ${row.address}` : ''} [id ${row.id}]`;
    }
    if (q === 'list_routes') {
      return `- ${row.route_code ? `[${row.route_code}] ` : ''}${row.name ?? '(unnamed route)'}${row.route_type ? ` (${row.route_type})` : ''} [id ${row.id}]`;
    }
    // Default: org-shaped (find_org, get_org, list_orgs).
    return `- ${row.name ?? '(unnamed)'}${row.type || row.organization_type ? ` (${row.type ?? row.organization_type})` : ''} [id ${row.id}]`;
  }).join('\n');
  return `Found ${results.length} record(s):\n${lines}`;
}
// ── Self-heal error formatting ───────────────────────────────────────────────
/**
 * Format a query_records error for the self-heal loop.
 *
 * For terminal refusals (F2), returns a clean human-facing message with
 * NO retry instruction and NO [INTERNAL:] scaffolding.
 *
 * For retryable errors, returns the existing [INTERNAL:] self-correction
 * instruction so the reasoning loop can fix its own call.
 */ export function formatQueryError(responseData, httpStatus) {
  // F2: TERMINATE-BEFORE-GENERATION. Check terminal refusal FIRST,
  // before any retry/promotion/rewrite logic.
  const terminal = checkTerminalRefusal(responseData);
  if (terminal.isTerminal) {
    // Cap the terminal message at 400 chars (same as the retryable branch)
    // and defensively strip any [INTERNAL: or [SYSTEM: fragment so a
    // downstream body can never inject internal scaffolding into a user-facing
    // reply.
    const scrubbed = terminal.terminalMessage.replace(/\[INTERNAL:[^\]]*\]?/g, '').replace(/\[SYSTEM:[^\]]*\]?/g, '').trim().slice(0, 400);
    return {
      reply: scrubbed,
      meta: {
        tool: 'query_records',
        outcome: 'terminal_refusal',
        error: terminal.terminalMessage,
        http_status: httpStatus,
        permanent: true
      }
    };
  }
  // Retryable error: existing self-correction path.
  const qErr = responseData?.error ?? `HTTP ${httpStatus}`;
  const qDetail = responseData?.detail ? ` (detail: ${String(responseData.detail).slice(0, 300)})` : '';
  return {
    reply: `[INTERNAL: your query_records call FAILED with this error:\n${String(qErr).slice(0, 400)}${qDetail}\n\nDo NOT repeat the same call. Correct the query type/args (query_records needs { query: <type>, args: { name: <search term>, ... } } — the search term goes in the INNER args, e.g. args: { name: "..." } for find_org) and try again. Do NOT surface this error text or mention query_records to the user.]`,
    meta: {
      tool: 'query_records',
      outcome: 'failed',
      error: String(qErr).slice(0, 400),
      detail: String(responseData?.detail ?? '').slice(0, 300) || undefined,
      http_status: httpStatus,
      internal: true
    }
  };
}

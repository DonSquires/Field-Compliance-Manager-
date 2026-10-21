/**
 * _shared/deterministic-logic.ts -- TEST-SUPPORT MIRROR of Bob's pure,
 * deterministic decision logic (Pillar G, Epic #135 / issue #142).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The functions mirrored here currently live UN-EXPORTED inside the large
 * conductor module supabase/functions/onspace-ai-chat/index.ts, which also
 * calls serve() at module load (booting a Deno HTTP server on import). They
 * therefore cannot be imported in isolation for unit testing without either
 * (a) editing conductor product code to export them, or (b) mirroring the
 * pure logic here. Issue #142 explicitly scopes this task as TEST-INFRA and
 * forbids changing conductor product logic, so we take option (b).
 *
 * KEEP IN SYNC
 * ------------
 * These are faithful copies of the deterministic pieces as of Main. If the
 * originals change, update this mirror too. Source references (Main):
 *   - isValidGeoJsonBoundary          onspace-ai-chat/index.ts ~L521
 *   - PAYLOAD_SCHEMAS (fcz slice)      onspace-ai-chat/index.ts ~L1646
 *   - validateBusinessRules           onspace-ai-chat/index.ts ~L1792
 *   - computeProposalIdempotencyKey   onspace-ai-chat/index.ts ~L1185
 *
 * DETERMINISTIC + PURE: no LLM, no network, no DB. Safe to run in a plain
 * `deno test` with no environment.
 */ // ---------------------------------------------------------------------------
// GeoJSON boundary validation (mirror of isValidGeoJsonBoundary)
// ---------------------------------------------------------------------------
/**
 * A boundary must be a real GeoJSON geometry (Polygon or MultiPolygon with
 * actual coordinates), not just any truthy object. Feature / FeatureCollection
 * recurse to their inner geometry.
 */ export function isValidGeoJsonBoundary(b: any) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const geo = b;
  const t = geo.type;
  if (t !== "Polygon" && t !== "MultiPolygon" && t !== "Feature" && t !== "FeatureCollection") return false;
  if (t === "Feature") return isValidGeoJsonBoundary(geo.geometry);
  if (t === "FeatureCollection") {
    return Array.isArray(geo.features) && geo.features.length > 0 && geo.features.some((f: any)=>isValidGeoJsonBoundary(f));
  }
  if (!Array.isArray(geo.coordinates)) return false;
  const coords = geo.coordinates;
  if (coords.length === 0) return false;
  const first = coords[0];
  if (!Array.isArray(first) || first.length === 0) return false;
  return true;
}
/**
 * Registry slice mirrored from PAYLOAD_SCHEMAS. THIS SLICE:
 * create_freedom_camping_zone only (one rule: require_geometry_or_provisional).
 */ export const PAYLOAD_SCHEMAS: Record<string, { actionType: string; businessRules: Array<{ id: string; description: string; check: string }> }> = {
  create_freedom_camping_zone: {
    actionType: "create_freedom_camping_zone",
    businessRules: [
      {
        id: "require_geometry_or_provisional",
        description: "Zone must have either a valid boundary polygon or an explicit provisional GPS point",
        check: "require_geometry_or_provisional"
      }
    ]
  }
};
/**
 * Evaluate declarative business rules for an action type against a payload.
 * Fail-open for unregistered tools / no rules: returns valid:true.
 */ export function validateBusinessRules(actionType: string, payload: Record<string, any>) {
  const schema = PAYLOAD_SCHEMAS[actionType];
  if (!schema || !schema.businessRules || schema.businessRules.length === 0) {
    return {
      valid: true,
      violations: []
    };
  }
  const violations = [];
  for (const rule of schema.businessRules){
    switch(rule.check){
      case "require_geometry_or_provisional":
        {
          const zone = payload.zone && typeof payload.zone === "object" && !Array.isArray(payload.zone) ? payload.zone : null;
          if (!zone) {
            violations.push({
              id: rule.id,
              message: "Zone object is missing from the payload -- cannot verify geometry"
            });
            break;
          }
          const hasBoundary = isValidGeoJsonBoundary(zone.boundary);
          const hasPoint = typeof zone.gps_lat === "number" && typeof zone.gps_lng === "number";
          if (!hasBoundary && !hasPoint) {
            violations.push({
              id: rule.id,
              message: "Zone must have either a valid boundary polygon or a provisional GPS point (gps_lat + gps_lng) -- neither is present"
            });
          }
          break;
        }
      default:
        break;
    }
  }
  return {
    valid: violations.length === 0,
    violations
  };
}
/**
 * Compute the idempotency key for a proposal: action_type + '::' + active_slot.
 * Returns null when there is no active slot.
 */ export function computeProposalIdempotencyKey(actionType: string, facts: Record<string, any>) {
  if (!facts?.active_slot) return null;
  return `${actionType}::${facts.active_slot}`;
}
/**
 * Mirror of makeSlotKey from onspace-ai-chat/index.ts.
 * Deterministic slot key: kind + '_' + slugified name.
 * e.g. ("branch", "Regulatory Services") → "branch_regulatory_services"
 */ export function makeSlotKey(kind: string, name: any) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${kind.toLowerCase()}_${slug || 'unnamed'}`;
}
/**
 * Compute a fallback idempotency key for non-conversational / cron paths
 * (e.g. bob-plan-step-advance) that have no active slot.
 * Uses the same action_type::makeSlotKey contract from 0267, prefixed with
 * 'plan_' to distinguish from conversation-driven proposals.
 */ export function computePlanStepIdempotencyKey(actionType: string, entityName: any) {
  const slug = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed';
  return `${actionType}::plan_${slug}`;
}
/**
 * Compute a per-entity idempotency key for site actions within a client
 * onboarding batch. Each site gets its own key so they deduplicate
 * independently of the parent org action.
 */ export function computeSiteIdempotencyKey(siteName: any) {
  const slug = siteName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed';
  return `create_client_site::${slug}`;
}
// ---------------------------------------------------------------------------
// Pillar E -- action-id normalisation (mirror, #300)
//
// The post-dispatch slot transition needs the action id from the tool result
// meta. Most propose_* paths return `action_id`, but propose_client_onboarding
// returns `org_action_id` (and `site_action_ids`). This helper normalises
// across both field names so the transition reads a consistent value.
// ---------------------------------------------------------------------------
/**
 * Normalise the action id from a propose_* tool result meta.
 * Falls back across action_id → org_action_id. Returns undefined when
 * neither field is present (the transition will skip recording the id).
 *
 * PURE: no I/O, no side-effects.
 */ export function normalizeProposalActionId(meta: Record<string, any>) {
  const actionId = meta.action_id ?? meta.org_action_id;
  return typeof actionId === 'string' ? actionId : undefined;
}
// ---------------------------------------------------------------------------
// Pillar H -- event log helpers (mirror)
// ---------------------------------------------------------------------------
/**
 * Build a PII-free, small step_payload for a tool_dispatched event.
 *
 * Extracts a curated subset of tool args (no full GeoJSON, no raw emails,
 * no raw SQL). Returns a plain object safe for JSONB storage.
 */ export function buildToolDispatchedPayload(tool: string, toolArgs: Record<string, any>) {
  const summary: Record<string, unknown> = {
    tool
  };
  // Curate per-tool: extract only the fields that are operationally useful
  // for debugging without leaking PII or large objects.
  switch(tool){
    case "propose_freedom_camping_zone":
      {
        const zone = toolArgs.zone && typeof toolArgs.zone === "object" && !Array.isArray(toolArgs.zone) ? toolArgs.zone : toolArgs;
        if (typeof zone.name === "string") summary.zone_name = zone.name;
        if (typeof toolArgs.organization_id === "string") summary.organization_id = toolArgs.organization_id;
        summary.has_boundary = isValidGeoJsonBoundary(zone.boundary);
        summary.has_point = typeof zone.gps_lat === "number" && typeof zone.gps_lng === "number";
        break;
      }
    case "propose_client_onboarding":
      {
        const client = toolArgs.client && typeof toolArgs.client === "object" && !Array.isArray(toolArgs.client) ? toolArgs.client : toolArgs;
        if (typeof client.name === "string") summary.client_name = client.name;
        else if (typeof toolArgs.client_name === "string") summary.client_name = toolArgs.client_name;
        if (typeof toolArgs.provider_organization_id === "string") summary.provider_organization_id = toolArgs.provider_organization_id;
        summary.has_sites = Array.isArray(toolArgs.sites) && toolArgs.sites.length > 0;
        break;
      }
    case "propose_patrol_route_assignment":
      {
        if (typeof toolArgs.patrol_route_id === "string") summary.patrol_route_id = toolArgs.patrol_route_id;
        if (typeof toolArgs.site_id === "string") summary.site_id = toolArgs.site_id;
        if (typeof toolArgs.parent_action_id === "string") summary.has_parent_action = true;
        break;
      }
    case "propose_zone_patrol_stop":
      {
        if (typeof toolArgs.zone_id === "string") summary.zone_id = toolArgs.zone_id;
        if (typeof toolArgs.patrol_route_id === "string") summary.patrol_route_id = toolArgs.patrol_route_id;
        break;
      }
    case "propose_freedom_camping_org_strategy":
      {
        if (typeof toolArgs.organization_id === "string") summary.organization_id = toolArgs.organization_id;
        summary.has_settings = !!(toolArgs.settings && typeof toolArgs.settings === "object" && Object.keys(toolArgs.settings).length > 0);
        summary.has_zone_updates = Array.isArray(toolArgs.zone_updates) && toolArgs.zone_updates.length > 0;
        break;
      }
    case "resolve_geofence":
    case "resolve_address":
      {
        const q = String(toolArgs.query ?? toolArgs.q ?? toolArgs.name ?? toolArgs.address ?? "").slice(0, 120);
        if (q) summary.query = q;
        break;
      }
    case "query_records":
      {
        const q = String(toolArgs.query ?? toolArgs.q ?? "").slice(0, 60);
        if (q) summary.query_type = q;
        break;
      }
    case "sql_read":
      // Never log the query text (may contain org-specific data)
      summary.has_query = typeof toolArgs.query === "string" || typeof toolArgs.sql === "string";
      break;
    default:
      break;
  }
  return summary;
}
/**
 * Build a step_payload for a tool_outcome event.
 *
 * Extracts outcome + action_id (for propose tools) from the tool result meta.
 */ export function buildToolOutcomePayload(tool: string, meta: Record<string, any>) {
  const payload: Record<string, unknown> = {
    tool,
    outcome: typeof meta.outcome === "string" ? meta.outcome : "unknown"
  };
  if (typeof meta.action_id === "string") payload.action_id = meta.action_id;
  return payload;
}
// ---------------------------------------------------------------------------
// Pillar F -- introspect helpers (mirror)
//
// Pure, deterministic helpers for the introspect action (Pillar F, #141).
// buildIntrospectPayload merges slot facts + resolved_ids (resolved wins)
// and shapes the result for renderProposalConfirmation. The UUID-safety
// substitution for organization_id is applied here so the conductor never
// needs to pass a raw UUID to the rendering layer.
//
// TOOL_USER_LABELS and USER_MEANINGFUL_EVENT_TYPES support the event-log
// "what happened" summary: internal tool identifiers are mapped to
// user-facing labels, and only the user-meaningful event subset is surfaced.
// ---------------------------------------------------------------------------
/**
 * Map internal tool identifiers to user-facing labels.
 * Introspect MUST NOT surface internal tool names (TOOL SELF-HEALING HARD RULE).
 */ export const TOOL_USER_LABELS: Record<string, string> = {
  resolve_geofence: "geofence resolution",
  resolve_address: "address resolution",
  query_records: "record lookup",
  propose_freedom_camping_zone: "zone proposal",
  propose_client_onboarding: "client onboarding proposal",
  propose_patrol_route_assignment: "patrol route assignment",
  propose_zone_patrol_stop: "zone patrol stop proposal",
  propose_freedom_camping_org_strategy: "policy strategy proposal",
  propose_location_setup: "location setup proposal",
  schema_inspect: "schema inspection",
  client_site_compare: "client/site comparison",
  scv_lookup: "SCV certificate check",
  sql_read: "data lookup",
  repo_search: "code search",
  self_audit: "self-audit",
  web_research: "web research",
  perceive_media: "document/media observation",
  understand_documents: "document analysis",
  plan_import: "import planning",
  confirm_import: "import confirmation",
  fetch_bylaw_source: "bylaw source fetch",
  job_plan_create: "multi-step plan",
  job_runner: "chained read steps",
  promote_action: "action promotion",
  check_proposals: "proposal status check",
  retrieve_knowledge: "knowledge retrieval",
  read_bob_chat: "notepad check",
  write_bob_chat: "notepad write"
};
/**
 * The user-meaningful event types that introspect surfaces.
 * Internal conductor mechanics (auth_resolved, plan_received, loop_continued,
 * loop_halted, response_built) are NOT surfaced -- owner decision #1.
 */ export const USER_MEANINGFUL_EVENT_TYPES = new Set([
  "tool_dispatched",
  "tool_outcome",
  "fact_extracted",
  "validated"
]);
/**
 * Build the introspect payload from slot state for a given action type.
 *
 * Merges slot.facts + slot.resolved_ids (resolved_ids win on collision).
 * Applies UUID safety: if organization_id is present in resolved_ids,
 * it is replaced with the cached org name from facts (resolved_org_name)
 * or the sentinel "(resolved, name not cached)". The raw UUID is NEVER
 * included in the returned payload.
 *
 * For create_freedom_camping_zone, wraps the merged object as { zone: merged }.
 * For unsupported action types, returns supported:false with the raw merged
 * object (the conductor uses this to decide the fallback message).
 *
 * PURE: no LLM, no network, no DB.
 */ export function buildIntrospectPayload(slot: Record<string, any>, actionType: string) {
  // Merge: resolved_ids win over facts on key collision
  const merged = {
    ...slot.facts,
    ...slot.resolved_ids
  };
  // UUID safety for organization_id (IDENTITY PRESENTATION rule)
  let orgDisplayName = null;
  if (typeof merged.organization_id === "string" && merged.organization_id) {
    // Check for a cached human-readable name
    const cachedName = typeof slot.facts.resolved_org_name === "string" && slot.facts.resolved_org_name ? slot.facts.resolved_org_name : null;
    orgDisplayName = cachedName;
    // Replace the raw UUID with the display name
    merged.organization_id = cachedName ?? "(resolved, name not cached)";
  }
  // Phase 1: only create_freedom_camping_zone is supported
  if (actionType === "create_freedom_camping_zone") {
    return {
      payload: {
        zone: merged
      },
      merged,
      supported: true,
      orgDisplayName
    };
  }
  return {
    payload: null,
    merged,
    supported: false,
    orgDisplayName
  };
}
/**
 * Filter event log rows to the user-meaningful subset and map tool names
 * to user-facing labels.
 *
 * PURE: no LLM, no network, no DB.
 */ export function filterUserMeaningfulEvents(events: any) {
  return events.filter((e: any)=>USER_MEANINGFUL_EVENT_TYPES.has(e.event_type)).map((e: any)=>({
      event_type: e.event_type,
      tool_label: e.tool ? TOOL_USER_LABELS[e.tool] ?? "processing step" : "",
      outcome: e.outcome,
      turn_index: e.turn_index,
      step_index: e.step_index
    }));
}
// ---------------------------------------------------------------------------
// read_bob_chat — pure parsing helpers (extracted for testability)
//
// These are the SAME functions the runtime calls in bob-repo-search/index.ts.
// The runtime imports them from here; the test file also imports them from
// here. No mirror copies — one source of truth.
//
// BOB_CHAT_PATH is the hard-coded constant used by BOTH read_bob_chat and
// write_bob_chat. Exported so tests can assert path safety.
// ---------------------------------------------------------------------------
/** Hard-coded target path for Bob's private notepad. */ export const BOB_CHAT_PATH = "docs/bob/BOB_CHAT.md";
/** Tail window size (chars) returned for context. */ export const BOB_CHAT_TAIL_SIZE = 8000;
/**
 * Parse ALL unanswered entries from the FULL content of BOB_CHAT.md.
 *
 * Scans every line for headers matching the protocol:
 *   ### [AUTHOR] DATE | status:unanswered
 *
 * Body is collected from lines following the header until the next `---`
 * separator or next `### ` header.
 *
 * Returns entries in file order (first = oldest, last = newest in an
 * append-only file).
 *
 * PURE: no I/O, no side-effects.
 */ export function parseUnansweredEntries(content: any) {
  const ENTRY_HEADER = /^###\s+\[([^\]]+)\]\s+(\S+)\s*\|\s*status:unanswered\s*$/;
  const lines = content.split("\n");
  const entries = [];
  for(let i = 0; i < lines.length; i++){
    const match = ENTRY_HEADER.exec(lines[i]);
    if (!match) continue;
    const header = lines[i];
    const author = match[1];
    const date = match[2];
    // Collect body lines until the next --- separator or next ### header
    const bodyLines = [];
    for(let j = i + 1; j < lines.length; j++){
      if (lines[j].trim() === "---" || /^###\s/.test(lines[j])) break;
      bodyLines.push(lines[j]);
    }
    const body = bodyLines.join("\n").trim();
    entries.push({
      header,
      author,
      date,
      body,
      line_number: i + 1
    });
  }
  return entries;
}
/**
 * Select the latest (most-recent / last) unanswered entry, or null if none.
 *
 * In an append-only file the last entry in file order is the newest.
 *
 * PURE: no I/O, no side-effects.
 */ export function selectLatestUnanswered(entries: any) {
  if (!entries || entries.length === 0) return null;
  return entries[entries.length - 1];
}
// ---------------------------------------------------------------------------
// read_bob_chat — DISTINGUISHED + PAGEABLE tail window (Bob-A/B, Jim Attack 1/2)
//
// The conductor is handed `tail_content` = the last BOB_CHAT_TAIL_SIZE chars of
// an append-only file. Rendering the WHOLE tail into Bob's context is too large,
// so it must be windowed -- but the window must be (a) anchored to the NEWEST
// end (where a fresh note lives), and (b) DISTINGUISHED: Bob must be told it is a
// partial window and how to reach the rest, never handed a silent slice that
// can't be told apart from 'the note isn't here'. Mirrors the !1367 read-path
// fix (has_more / next_offset) for the notepad tail.
//
// `offset` is chars-back-from-the-newest-end of the tail: offset 0 = the newest
// `budget` chars; offset `budget` = the window immediately older; and so on,
// paging backward THROUGH THE TAIL. (Reaching content older than the tail
// itself is a separate tool-side concern, not this helper's.)
// ---------------------------------------------------------------------------
/** Default render budget (chars) for one notepad-tail window. */ export const NOTEPAD_TAIL_WINDOW = 3000;
/**
 * Render ONE distinguished, pageable window over the notepad tail.
 *
 * The window is anchored to the NEWEST end of the tail and walks BACKWARD by
 * `offset` chars. So offset 0 always contains the most-recently-appended
 * content (a just-written note); has_more/next_offset let Bob page to older
 * tail content instead of it silently vanishing into a middle blind spot.
 *
 * Boundary behaviour (all asserted in tests):
 * - offset <= 0 (or NaN): treated as 0 (newest window).
 * - budget <= 0 (or NaN): treated as NOTEPAD_TAIL_WINDOW.
 * - offset >= tailLength: returns an empty window, hasMore=false, nextOffset=null
 *   (paged past the start of the tail -- a DISTINGUISHED empty, not a silent one:
 *   the caller states 'no older tail content').
 * - a tail shorter than budget returns the whole tail, hasMore=false.
 *
 * PURE: no I/O, no side-effects.
 */ export function renderNotepadTail(tailContent: any, opts: Record<string, any>) {
  const tail = typeof tailContent === 'string' ? tailContent : '';
  const tailLength = tail.length;
  const rawBudget = opts?.budget;
  const budget = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : NOTEPAD_TAIL_WINDOW;
  const rawOffset = opts?.offset;
  let offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  if (offset > tailLength) offset = tailLength;
  // Window = [start, end) measured from the NEWEST end walking backward.
  // end index (exclusive) from the front of the tail:
  const endIdx = tailLength - offset; // newest char included is endIdx-1
  const startIdx = Math.max(0, endIdx - budget);
  const window = tail.slice(startIdx, endIdx);
  const returned = window.length;
  // Older content remains iff there is tail before this window's start.
  const hasMore = startIdx > 0;
  const nextOffset = hasMore ? offset + returned : null;
  return {
    window,
    hasMore,
    nextOffset,
    offset,
    tailLength,
    returned
  };
}

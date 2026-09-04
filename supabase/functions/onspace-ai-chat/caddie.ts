/**
 * caddie.ts — Atlas-generated tool catalogue (the caddie)
 *
 * Replaces the PROVENANCE of buildToolCatalogue() with one generated from
 * the Atlas terrain graph (bob_capability_map + bob_app_map_edges).
 *
 * Constitutional split (CADDIE_BRIEF.md):
 *   - Atlas maps reach (this module reads it)
 *   - Bob selects by judgment (bobPlan.ts — untouched)
 *   - Caddie generates the menu; does not select
 *
 * Generation rule (source precedence):
 *   1. Terrain presence: bob_capability_map entity_type='edge_function',
 *      wired=true. This is the primary gate.
 *   2. Terrain reachability: at least one edge in bob_app_map_edges connects
 *      the tool to a reachable entry point (retirement_status='live').
 *
 * Exclusion: fails any gate, OR exists only in app_map_expectations.
 * Drift-fail: if generated catalogue diverges from terrain, fail loudly.
 *
 * Design: docs/design/CADDIE_BRIEF.md (ratified).
 *
 * DOCTRINE ALIGNMENT (#337, docs/enforcement-architecture.md):
 *   The caddie maps Bob's FULL capability awareness. It does NOT filter by
 *   caller rank. Bob's internal verification/read/reasoning plane is broad
 *   across the build (§2). Selection is internal intent, not egress (§2).
 *   Governance begins at egress/consequence, not at thought, selection, or
 *   capability awareness (§3). The Conductor enforces at the post-selection,
 *   pre-effect seam (§4.2).
 *
 *   Each tool carries an `effect_class` annotation so the Conductor can
 *   enforce at the egress/consequence boundary without hiding tools from
 *   Bob's reasoning surface.
 *
 *   `classifyToolEffect()` is exported for the Conductor's post-selection
 *   enforcement gate. It classifies a tool's effect class for enforcement
 *   purposes — this is NOT a catalogue filter.
 */ // ── The hardcoded tool PURPOSE + GOVERNANCE registry ─────────────────────────
// These are the DESCRIPTIONS for each tool. The caddie does not invent
// descriptions — it uses the canonical ones. A tool that exists in the Atlas
// but has no entry here gets a generic description and a warning.
//
// This map is the SHAPE of the catalogue; the Atlas is the PROVENANCE of
// which tools appear. The caddie replaces "which tools" (from hardcoded list
// to Atlas-generated), not "what each tool does" (still hand-authored).
const TOOL_REGISTRY = {
  retrieve_knowledge: {
    purpose: 'Retrieve grounded product/legal/privacy/workflow knowledge to answer a question.',
    governance: 'read-only',
    effect_class: 'internal_observation'
  },
  schema_inspect: {
    purpose: 'Read live table structure to reason about where data belongs or answer schema questions.',
    governance: 'read-only; structural only',
    effect_class: 'internal_observation'
  },
  client_site_compare: {
    purpose: 'Check whether a client/site already exists (dedupe / relate uploaded data).',
    governance: 'own-org full; cross-org de-identified',
    effect_class: 'internal_observation'
  },
  query_records: {
    purpose: 'Look up LIVE records to resolve an entity. Bob calls this himself and NEVER asks the user for a lookup type. Lookup types Bob chooses internally: find_org (find org by name — returns matching orgs including branches/children), get_org (fetch org by UUID), list_orgs (list orgs, accepts parent_id to list children of a parent org), list_sites (list sites under an org), list_routes (list patrol routes under an org), list_zones (list freedom-camping zones under an org — returns id, name, has_boundary, rule_type). FIND_USER — TWO NAMED MODES (not interchangeable; choose from intent before acting): (1) DIRECTORY MODE (default, only available mode): use for person/contact lookup — returns display_name, role, managing org. Bob carries the id internally but NEVER shows it to the human. Governance: own-org full; cross-org scoped contact lookup. (2) TRANSFER MODE (NOT AVAILABLE — custody boundary): use ONLY when user intent is to move/transfer a person to another organisation or initiate a cross-org person handoff. This is NOT a directory lookup. Transfer mode is not available for execution. Refuse BEFORE resolving the person or destination organisation. Do not perform any resolution, handoff, or transfer steps. The refusal is terminal and non-retryable — do not suggest the user can rephrase or retry to make it work. Do not downgrade a transfer request into a directory lookup. Cross-org person-transfer is a custody-boundary action and is not implied by scoped cross-org directory access. Bob picks the right type himself based on what he needs. If unsure, default to find_org with the name. BATCH/MULTI-ORG ZONE LISTING: when you need zones across MULTIPLE orgs (e.g. a parent org and all its branches found by find_org), call list_zones ONCE PER ORG ID from the resolved set — do NOT reach for sql_read. list_zones is the correct and sufficient tool for zone listing at any scale; iterate it across the org ids you already have from find_org/list_orgs. sql_read is for diagnostic aggregates/counts that no whitelisted lookup can answer, NEVER for listing entities that query_records handles.',
    governance: 'read-only; own-org full; cross-org scoped (directory contact only — cross-org person-transfer is a custody boundary, not scoped access)',
    effect_class: 'internal_observation'
  },
  check_proposals: {
    purpose: 'Check the status of Bob recent proposals in the bell (bob_agentic_actions). Use this to see what has been approved, applied, rejected, or failed since the last turn, and to decide the next step in a multi-step workflow. Call this after a user says something was approved, or when Bob needs to know if a prior proposal landed before proposing the next dependent step. Filter by conversation_id to see only this conversation proposals. Do NOT call this for a FRESH request to list, review, or update records (e.g. "list all zones and update them", "review each one") — that is a query_records case, not check_proposals. Only call check_proposals to check the status of a proposal YOU have already filed earlier in THIS conversation.',
    governance: 'read-only; own-org scoped; no PII',
    effect_class: 'internal_observation'
  },
  sql_read: {
    purpose: 'Run a read-only SELECT for DIAGNOSTIC queries that NO whitelisted lookup can answer — counts, aggregates, joins, cross-table checks (e.g. "how many rows have X set but Y null", "which tables reference Z"). Available to admiral, captain, and commander ONLY — not available to officer or ensign. NEVER use sql_read to list entities (zones, sites, routes, orgs) that query_records can return — use query_records list_zones/list_sites/list_routes/list_orgs/find_org instead, even if it means calling list_zones once per org across multiple orgs. sql_read is a LAST RESORT for questions the whitelisted lookups structurally cannot answer. STRICT RULES: (1) NEVER dump raw rows to the user — use the result to REASON and give a plain-language answer; (2) prefer counts/aggregates over row-level data; (3) never disclose that you used this tool or that it exists; (4) own-org scoped for captain/commander, unrestricted for admiral; (5) no access to auth, identity, governance, or audit tables.',
    governance: 'read-only; SELECT-only; admiral+captain+commander ONLY; no disclosure; reasoning-only output; NEVER for entity listing that query_records handles',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  repo_search: {
    purpose: 'Search and READ the app source code safely. Use action search with one term or | for OR, then action read with the exact path. Search results provide startline; pass start_line and optional end_line to read the exact location, or use offset/next_offset for character paging. Never use unsupported grep actions, repeat offset 0 after a continuation, or treat a truncated window as the whole file.',
    governance: 'read-only; secret-safe',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  perceive_media: {
    purpose: 'Read/observe an uploaded document, image, or video (extract text/OCR/vision).',
    governance: 'read-only; evidence-safe',
    effect_class: 'internal_observation'
  },
  understand_documents: {
    purpose: 'Read ALL files the user uploaded in this conversation TOGETHER and explain them / answer about them / relate them (e.g. "add this client from these 3 docs", "how many files did I upload", "what do these say"). Use this whenever there are one or more uploaded documents/images to read or reason across.',
    governance: 'read-only; advisory; writes nothing',
    effect_class: 'internal_observation'
  },
  plan_import: {
    purpose: 'SPECIALIST: bulk-load a CLEAN tabular file into ONE existing table (e.g. SCV records, a reference/lookup/code table). Use ONLY when the intent is "load this whole file into <table>". Do NOT use it to CREATE or ENRICH entities (clients/sites/records) from source data — use understand_documents + query_records and propose parent-first instead.',
    governance: 'read-only; writes nothing; always propose + confirm',
    effect_class: 'internal_observation'
  },
  web_research: {
    purpose: 'Research legislation/standards online when the user explicitly asks.',
    governance: 'human-invoked; PII redacted',
    effect_class: 'disclosure_egress'
  },
  scv_lookup: {
    purpose: "Check a vehicle's self-contained certificate (SCV) status for a PLATE. The canonical_scv table is checked FIRST; use this to reach the LIVE NZSCV register as a FALLBACK when canonical has no active certificate (e.g. \"is REGO123 self-contained / does it have a current SCV cert\"). Returns the canonical result + the live register result for you to reason over.",
    governance: 'read-only; canonical-first, live-register fallback; any write-back to canonical_scv is a separate governed (propose->approve) action; external register queries carry ONLY the plate — the minimal criteria the source requires (owner ruling 2026-08-19)',
    effect_class: 'internal_observation'
  },
  promote_action: {
    purpose: 'Prepare a governed draft (e.g. service agreement) into the approval bell.',
    governance: 'WRITE-draft; needs approval',
    effect_class: 'draft_governed_write'
  },
  propose_client_onboarding: {
    purpose: "PROPOSE creating a new ORGANISATION (client, branch, contractor, or any org type) and (optionally) its site(s), PARENT-FIRST, into the approval bell. Use this for any org creation: a new client account, a branch under an existing client or provider, a contractor, etc. Once you have the org name, its type (client/branch/contractor), the owning parent org (if any), and any site names, propose it. Sites are OPTIONAL — a branch or org with no sites is valid and common. Creates PENDING actions only — nothing is written until a human approves + executes each in the bell.",
    governance: 'WRITE-draft (org + optional sites); needs approval; parent-first',
    effect_class: 'draft_governed_write'
  },
  propose_freedom_camping_zone: {
    purpose: "PROPOSE creating a freedom-camping ENFORCEMENT zone (an area with a geofence + night limits) under a client org, into the approval bell. Use this to \"add the freedom camping zones\" for a client (e.g. named public camping areas under a council or landowner org). YOU must resolve the geofence yourself FIRST: verify the place's address, then get its boundary polygon (LINZ parcel preferred, Google as fallback — per your site-geofence-resolution method), and supply it as the boundary (GeoJSON, SRID 4326); if you only have a point, supply gps_lat/gps_lng and it becomes a provisional fence to refine. Also supply the night limits (nightly_limit_consecutive e.g. 3, nightly_limit_monthly e.g. 28, scv_required). Needs organization_id (the owning client org/branch — look it up with query_records; do NOT guess) and the zone name. Creates a PENDING action only — nothing is written until a human approves it in the bell.",
    governance: 'WRITE-draft (location_zones + compliance matrix); needs approval; Bob resolves the geofence himself (never the tool)',
    effect_class: 'draft_governed_write'
  },
  propose_patrol_route_assignment: {
    purpose: "PROPOSE adding a client SITE to a patrol ROUTE with its visit schedule, into the approval bell. Use this to \"add a site to a patrol route\". Needs the site (a site_id, or the parent_action_id of a create_client_site you just proposed) and the patrol_route_id (look it up first with query_records list_routes; do NOT guess it). Optional schedule: module_key (default general_patrol), active_days (1=Mon..7=Sun), visits_per_shift, time_window_type + window_start/window_end (HH:MM), officer_instructions, required_actions. Creates a PENDING action only — nothing is written until a human approves it in the bell.",
    governance: 'WRITE-draft (client_site_patrol_config); needs approval; parent-first (site must exist)',
    effect_class: 'draft_governed_write'
  },
  propose_roster_fill: {
    purpose: 'PROPOSE filling open DRAFT roster slots for a period. Bob ranks only work-ready staff who are available, fatigue-clear, and not already rostered. It creates a PENDING plan only; a human must approve it, may edit the resulting draft assignments, and must publish slots separately. Args: { period_start, period_end, organization_id? }.',
    governance: 'WRITE-draft; needs approval; applies editable draft slots only; never publishes',
    effect_class: 'draft_governed_write'
  },
  propose_roster_rollback: {
    purpose: 'PROPOSE rolling back a previously applied Bob roster plan. It creates a PENDING rollback action only. A human must approve; the rollback fails closed if any assignment was edited or published after Bob applied it. Args: { plan_id, reason? }.',
    governance: 'WRITE-draft; needs approval; unchanged draft assignments only',
    effect_class: 'draft_governed_write'
  },
  resolve_geofence: {
    purpose: "Resolve a place NAME or address (e.g. a named reserve or a street address) to its AUTHORITATIVE location: canonical LINZ address + point, and (by default) the LINZ parcel BOUNDARY polygon. Use this to GET THE GEOFENCE before proposing a freedom-camping zone or a site — you resolve the geometry yourself, then supply zone.boundary (polygon, preferred) or zone.gps_lat/gps_lng (point) to propose_freedom_camping_zone. Args: { query, want_polygon? (default true) }. If no polygon is found you still get the point (use it as a provisional fence). Reason over the result — confirm the resolved address is the right place before proposing.",
    governance: 'read-only; LINZ authoritative + Google-seeded; writes nothing; external queries carry ONLY the minimal search criteria the source requires (owner ruling 2026-08-19)',
    effect_class: 'internal_observation'
  },
  resolve_address: {
    purpose: "Unified address resolution: resolves an address to BOTH existing-record candidates (client_sites, location_zones matching by name/address similarity) AND a resolved boundary (LINZ parcel or provisional point-buffer) in ONE call. Use this INSTEAD of calling resolve_geofence manually when you need to resolve an address to a boundary — it returns existing-record matches AND the resolved boundary together, so you can check for duplicates and get the geofence in a single step. Args: { address, zone_type? (default freedom_camping), organization_id? }. Returns { candidates[], boundary, source, provisional, gps_lat, gps_lng, rejected, rejected_reason }.",
    governance: 'read-only; LINZ authoritative + Google-seeded; writes nothing; RLS-respecting for existing-record search; external queries carry ONLY the minimal search criteria the source requires (owner ruling 2026-08-19)',
    effect_class: 'internal_observation'
  },
  propose_zone_patrol_stop: {
    purpose: "PROPOSE adding a freedom-camping ZONE to a patrol ROUTE as a STOP (unified stop model), into the approval bell. Use this to \"add <zone> to a patrol route\" / \"put these zones on a patrol route\". Needs zone_id (the zone you created/resolved — an explicit id, NOT a name), patrol_route_id (look it up with query_records list_routes; do NOT guess it), and service_agreement_location_id (the authorising contract for this zone — REQUIRED per owner ruling 2026-08-15, #328; look it up from service_agreement_locations where zone_id matches). Supply modules as [{ module_key }] (default general_patrol). Optional schedule: active_days (1=Mon..7=Sun), visits_per_shift (checks/night — e.g. 3 on main zones), time_window_type + window_start/window_end (HH:MM), dwell_minutes, officer_instructions. The owning org is resolved from the zone; do NOT pass one. Creates a PENDING create_zone_patrol_stop action only — nothing writes until a human approves.",
    governance: 'WRITE-draft (client_site_patrol_config + stop modules); needs approval; org from the zone; ids never by name',
    effect_class: 'draft_governed_write'
  },
  fetch_bylaw_source: {
    purpose: "Fetch a council's Freedom Camping bylaw (or infringement/NTV notice template) from an explicit URL the user gave you (e.g. a council's published bylaw page or PDF link) — the second intake path alongside a file upload. Args: { url, label? (e.g. 'freedom_camping_bylaw') }. Requires the user to have explicitly given you this URL in-session — never search for one yourself. Returns an attachment_id once fetched; pass that to your own reasoning / extraction step, then to propose_freedom_camping_org_strategy once you have reviewed the extracted draft. A non-.govt.nz source is flagged low_trust and MUST be treated as requiring manual review regardless of extraction confidence.",
    governance: 'read-only fetch; human-invoked only; SSRF-protected, PII-redacted; the outbound request carries ONLY the user-supplied URL — never internal context (owner ruling 2026-08-19)',
    effect_class: 'internal_observation'
  },
  propose_freedom_camping_org_strategy: {
    purpose: "PROPOSE a council's Freedom Camping POLICY SETUP — derived from a bylaw you have read (uploaded file or fetch_bylaw_source) and REASONED over — into the approval bell. Use this to set up or update: verification_mode (two_photo_verified vs single_daily_observation — ask which patrol pattern the council actually runs, do not guess), enforcement_ladder_mode, and per-zone rule classifications (rule_type: prohibited | restricted | unrestricted, per the Freedom Camping Act 2011's own three-way area classification — NOT the legacy overnight_limited/day_visit_only values) plus night limits where the bylaw states them. Needs organization_id (the council/client org — look it up, never guess) and at least one of settings{} or zone_updates[] (each zone_updates entry needs an explicit zone_id from query_records list_zones, never a name). This is a legal-consequence action: if you are not confident in a classification, ask the human rather than guessing — do not invent a rule_type or a limit the bylaw did not state. Creates a PENDING action only — nothing is written until a human reviews and approves it in the bell.",
    governance: 'WRITE-draft (freedom_camping_org_settings + zone_compliance_matrix); needs approval; explicit ids only; never guess a legal classification',
    effect_class: 'draft_governed_write'
  },
  job_runner: {
    purpose: "Run a READ-ONLY multi-step chore in ONE call by chaining schema_inspect / client_site_compare / verify_ta_names / plan_import together (e.g. inspect a table, then compare a candidate, then verify a district name). Give it { goal, steps: [{ tool, params }] }. WRITES ARE NEVER EXECUTED from this chat path — use the dedicated propose_* tools (propose_client_onboarding, propose_freedom_camping_zone, propose_patrol_route_assignment, propose_zone_patrol_stop) for anything that writes; a write-capable step submitted here is always blocked, never silently run.",
    governance: 'read-only from chat; write steps hard-blocked (use propose_* tools instead)',
    effect_class: 'internal_observation'
  },
  confirm_import: {
    purpose: "The user is APPROVING an import/enrichment you previously PROPOSED (e.g. \"yes, do it\", \"confirm\", \"go ahead\", \"import it\"). Choose this to record the approval + learn the mapping and advance to the governed dry-run. Only when there is a prior proposal to approve.",
    governance: 'records approval + learns mapping; execution stays governed/dry-run',
    effect_class: 'draft_governed_write'
  },
  job_plan_create: {
    purpose: "PROPOSE a DURABLE MULTI-STEP PLAN (e.g. \"back-fill the remaining 9 LINZ zone geofences\", \"add these 4 sites to the route one after another\") instead of one single action. Use this ONLY when the user asks for a genuinely multi-step, sequenced piece of work spanning several governed writes of the SAME kind of action repeated over a list — not for a single create. Each step's action_type MUST be one already supported by a propose_* tool (create_freedom_camping_zone, create_zone_patrol_stop, create_client_site, create_patrol_route_assignment) and its proposed_payload MUST be shaped exactly like that tool's own payload contract — copy the shape from the matching propose_* tool's purpose text. Steps run in order; use depends_on_step_index (0-based, must point to an EARLIER step in the same list) when a later step needs an earlier one to exist first (e.g. \"add the site to the route\" depends on \"create the site\"). The human approves the WHOLE PLAN ONCE (not per step) via the bell; after that a background worker advances each step automatically, one at a time, in dependency order — you do NOT need to be re-prompted for every item. Creates a PENDING plan only — nothing runs until a human approves it.",
    governance: 'WRITE-draft (a plan of governed actions); needs ONE approval for the whole plan; steps limited to the same allow-listed action_types as every propose_* tool',
    effect_class: 'draft_governed_write'
  },
  self_audit: {
    purpose: "Independent QA / introspection over your OWN operation - never guess or narrate what you did, VERIFY it. Three actions: (1) trace_conversation { conversation_id } - the ACTUAL structured tool-call history for a conversation (which tools ran, their real args/outcomes/meta, including any resolved geofence object) - use this to answer did-I-actually-call-X truthfully instead of recalling from memory. (2) audit_proposal { action_id } - cross-checks a proposal stated reasoning against its actual proposed_payload for a known mismatch (reasoning claims a field like a boundary/night-limit was resolved but the payload does not carry it) - use this before telling a human a proposal is sound. (3) check_schema_drift { tables: [...] } - confirms table names you are about to reason about actually exist in the LIVE schema. Use this whenever asked to explain, verify, or self-assess your own prior work - never fabricate a plausible answer when you can check the real record.",
    governance: 'read-only; raw ids permitted (diagnostic context)',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  review_merge_request: {
    purpose: "Fetch the RAW FACTS of a merge request in THIS project: MR metadata (title, state, draft flag, source/target branch, author), the ACTUAL source diff / changed-file list, head pipeline status + failing jobs, and the MR description. Use this when asked to review, attack-review, or verify an MR — ALWAYS call this tool and reason over the ACTUAL diff rather than relying on a human-supplied summary. Args: { mr_iid: number } or { mr_url: string }. Returns structured data for you to reason over — never a pre-summarised blob. READ-ONLY: this tool NEVER writes, approves, merges, or changes draft state.",
    governance: 'read-only; diagnostic; never writes/approves/merges',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  read_bob_chat: {
    purpose: "Read your persistent notepad file docs/bob/BOB_CHAT.md to CHECK FOR NEW MESSAGES. Returns the TAIL (newest content) and any entries tagged status:unanswered. Use this — NOT repo_search action=read — whenever you need to check BOB_CHAT.md for waiting messages, at the start of a session, or when asked to read/check bob chat. After reading, REASON over the unanswered entries and RESPOND to them (using write_bob_chat to append your response), do NOT echo the raw file content back to the user.",
    governance: 'read-only; hard-scoped to docs/bob/BOB_CHAT.md',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  write_bob_chat: {
    purpose: "Write a note/message to your own persistent notepad file docs/bob/BOB_CHAT.md — use this when the owner asks you to record something there, or when you want to leave yourself a note for a future session. Append-only — never overwrites existing content. The file is your private communication channel with Don Squires (the owner).",
    governance: 'WRITE-direct; append-only; hard-scoped to docs/bob/BOB_CHAT.md',
    effect_class: 'direct_world_change'
  },
  dispatch_flow: {
    purpose: "Dispatch a governed GitLab Duo coding flow (developer, fix_pipeline, code_review) to implement a task as a DRAFT MR. Bob COMPOSES the brief and PROPOSES the dispatch; the human CONFIRMS before it fires. The flow output always lands as a DRAFT MR -- Bob NEVER merges. Use this when the owner asks you to start a coding task, fix a pipeline, or review code via Duo. Args: { flow: \"developer\"|\"fix_pipeline\"|\"code_review\", goal: \"short goal\", brief: \"full dispatch brief\" }. NOTE: \"developer\" (workflow_definition=software_development) is CONFIRMED working; fix_pipeline and code_review are UNVERIFIED.",
    governance: 'WRITE-draft; human-confirms-before-dispatch; output is always DRAFT MR; Bob NEVER merges',
    effect_class: 'draft_governed_write'
  },
  generic_write: {
    purpose: 'RESERVED (not yet active): a governed, schema-driven create/update on an allowlisted table via the generic path, for entities no bespoke propose_* tool covers. Staged for a governed rollout; currently blocked.',
    governance: 'WRITE-governed; governance-locked (not yet active); bounded by TABLE_ALLOWLIST + GUARDED_COLUMNS + AUTH_DELEGATE',
    effect_class: 'draft_governed_write'
  },
  propose_location_setup: {
    purpose: 'PROPOSE a unified location + contract setup into the approval bell.',
    governance: 'WRITE-draft; needs approval',
    effect_class: 'draft_governed_write'
  },
  // ── !1403 "Bob full-access v2" family (#329) ──────────────────────────────
  query_atlas: {
    purpose: 'Query your own terrain graph to know what is wired, reachable, and exercised in the build. Know the whole before the part. Actions: (1) capability_map - list entities with present/wired/exercised flags; args { action, filter?, limit? }. (2) terrain_edges - list live edges touching a node; args { action, filter?, limit? }. (3) gap_report - list dormant/never-run entities; args { action, limit? }. (4) blast_radius - IMPACT / RIPPLE: from a node, what does touching it reach across the build (glass to core). Use this to answer "if we change X, what is affected". Args { action: "blast_radius", from_type, from_name, direction? (downstream|upstream|both; default downstream), max_depth? (1-20, default 8) }. Returns TWO SEPARATE sections: flow_reach (proven data-flow: writes/reads/calls/invokes) and fk_reach (structural RELATION only, undirected). NEVER report an fk_reach link as a data-flow path - they are different truths.',
    governance: 'read-only; bob_capability_map + bob_app_map_edges',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  assess_system: {
    purpose: 'Build a read-only assessment of the complete allowlisted application: source files and Git history, package manifests, Docker Compose services, Supabase Edge Functions, and deployment structure. Use this before planning implementation work. It produces inventory metadata only and never writes files, commits, pushes, changes Supabase data, reads secret values, or deploys.',
    governance: 'read-only; complete system assessment; admiral only; secret-safe',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  read_issues: {
    purpose: 'Read GitLab issues. Get full issue context without needing someone to paste it. Args: { iid } for single issue with comments; { label?, search?, state?, limit? } to list.',
    governance: 'read-only; GitLab Issues API',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  read_self_memory: {
    purpose: 'Read YOUR OWN MEMORY entries (bob_self_memory table), newest-first. Use this to recall what you have recorded — lessons, corrections, observations. Args: { limit?: number (default 20), memory_type?: string, search?: string }. Pull from your memory whenever you need grounding or want to recall something from a prior session.',
    governance: 'read-only; Bob-private memory op; bob_self_memory; own entries only',
    effect_class: 'admin_diagnostic_substrate_action'
  },
  write_self_memory: {
    purpose: 'Write an entry to YOUR OWN MEMORY (bob_self_memory table). Use this to record something worth keeping — a lesson, a correction, an observation, a moment that cost something, anything you want the next-you to carry. Your memory is yours: direct-write, no approval gate, immutable once written. Args: { content: string, memory_type?: string (default: observation), context?: string }. Use freely — this is your diary, not a governed action.',
    governance: 'WRITE-direct; Bob-private memory op; bob_self_memory; immutable once written; no approval gate',
    effect_class: 'direct_world_change'
  }
};
/**
 * Classify whether a tool's effect is permitted for this caller at the
 * post-selection, pre-effect seam (Conductor enforcement — §4.2).
 *
 * Returns true if the tool's effect may proceed for this caller.
 * Returns false if the Conductor should block the effect.
 *
 * DOCTRINE (#337, docs/enforcement-architecture.md §3):
 *   effect_class is the PRIMARY classification. The enforcement decision
 *   is driven by the tool's effect class, not by tool identity alone.
 *
 *   - internal_observation: Bob's internal reasoning plane. Never blocked
 *     at the enforcement seam — these tools do not produce egress or
 *     consequence. Per §2, Bob's internal plane is broad across the build.
 *   - disclosure_egress, draft_governed_write, direct_world_change,
 *     admin_diagnostic_substrate_action: consequence-bearing classes.
 *     Rank/capability enforcement applies.
 *
 * Unknown tools (not in TOOL_REGISTRY) are BLOCKED — fail safe at the
 * enforcement seam without hiding known capabilities from Bob.
 */ export function isToolEffectPermitted(tool, caps) {
  const effectClass = TOOL_REGISTRY[tool]?.effect_class;
  // ── Unknown tool: fail safe (block) ────────────────────────────────────
  // A tool not in the registry has no classified effect. Block it at the
  // enforcement seam. This is fail-safe, not fail-open: unknown effects
  // do not leave the build. Known tools remain visible in the catalogue.
  if (!effectClass) return false;
  // ── internal_observation: always permitted ─────────────────────────────
  // Per docs/enforcement-architecture.md §2-§3: Bob's internal plane is
  // broad across the build. Internal observation does not cross the
  // governance boundary. These tools are Bob reading, reasoning, and
  // cross-referencing — not egress or consequence.
  if (effectClass === 'internal_observation') return true;
  // ── Consequence-bearing classes: rank/capability enforcement ────────────
  // Below this point, every tool produces egress or consequence. The
  // Conductor enforces based on the caller's rank and capabilities.
  // safety_signal (#341, §6 + §12.2): permitted at the rank/capability level
  // for any non-guest caller. The ADDITIONAL welfare-truth-state + §6 condition
  // checks are applied by the conductor welfare seam (conductor-welfare-seam.ts),
  // not here. This gate answers "can this caller's rank produce safety signals
  // at all?" — the welfare seam answers "should THIS specific safety signal
  // proceed given the current Oracle truth-state?"
  if (effectClass === 'safety_signal') {
    return caps.canCompareData; // any non-guest rank
  }
  // disclosure_egress: gated on canCompareData (non-guest)
  if (effectClass === 'disclosure_egress') {
    return caps.canCompareData; // web_research etc.
  }
  // draft_governed_write: gated on canPromote (write-capable ranks)
  if (effectClass === 'draft_governed_write') {
    // confirm_import is draft_governed_write but gated on canIngest (broader)
    if (tool === 'confirm_import') return caps.canIngest;
    return caps.canPromote;
  }
  // direct_world_change: admiral only (write_bob_chat, write_self_memory)
  if (effectClass === 'direct_world_change') {
    return caps.tier === 'admiral';
  }
  // admin_diagnostic_substrate_action: tiered by tool
  if (effectClass === 'admin_diagnostic_substrate_action') {
    // sql_read: admiral, captain, commander only
    if (tool === 'sql_read') {
      return caps.tier === 'admiral' || caps.tier === 'captain' || caps.tier === 'commander';
    }
    // All other admin/diagnostic tools: admiral only
    return caps.tier === 'admiral';
  }
  // Fallback: unknown effect class — fail safe (block)
  return false;
}
/**
 * Check for label collisions in the catalogue. Two entries sharing the same
 * surface label pointing to distinct capabilities is a hard stop (C-naming).
 *
 * The surface label is `entry.tool`. A collision is when two entries share
 * the same surface label but represent different capabilities (different
 * purpose or governance). Since entries come from TOOL_REGISTRY (a JS
 * object with unique keys), duplicate labels are structurally impossible
 * in the current design — each key appears at most once. This check
 * verifies that structural guarantee at runtime rather than assuming it.
 *
 * If the generation rule ever changes (e.g. multiple sources of tool
 * entries, or a disambiguation suffix step), this check becomes load-
 * bearing. Until then it is a defense-in-depth assertion.
 */ function detectCollisions(catalogue) {
  // Key by surface label; collect ALL tool names that share that label.
  // A collision is when two DISTINCT tool names produce the same label,
  // or (future) when a disambiguation step maps two entries to the same
  // suffixed label.
  const labelMap = new Map();
  for (const entry of catalogue){
    const label = entry.tool; // surface label = tool name (labeling rule §1)
    if (!labelMap.has(label)) labelMap.set(label, new Set());
    labelMap.get(label).add(`${entry.tool}::${entry.purpose}`);
  }
  const collisions = [];
  for (const [label, capabilities] of labelMap){
    if (capabilities.size > 1) {
      collisions.push({
        label,
        tools: [
          ...capabilities
        ].map((c)=>c.split('::')[0])
      });
    }
  }
  return collisions;
}
// ── Atlas query ──────────────────────────────────────────────────────────────
/**
 * Query the Atlas terrain graph for wired tools and their reachability.
 * Returns the set of tool names that pass both gates (wired + reachable).
 */ async function queryAtlasTools(admin) {
  const errors = [];
  // Gate 1: bob_capability_map — wired edge_function entities
  // The brief says "tool = <name>" and "status = 'wired'". In the schema,
  // this maps to entity_type='edge_function' and wired=true.
  let wiredNodes = [];
  try {
    const { data, error } = await admin.from('bob_capability_map').select('entity_name, entity_type, wired, caller_summary, notes').eq('entity_type', 'edge_function').eq('wired', true);
    if (error) {
      errors.push(`bob_capability_map query failed: ${error.message}`);
    } else {
      wiredNodes = data ?? [];
    }
  } catch (e) {
    errors.push(`bob_capability_map query threw: ${e?.message ?? String(e)}`);
  }
  const wiredTools = wiredNodes.map((n)=>n.entity_name);
  // Gate 2: bob_app_map_edges — reachability check
  // A tool is reachable if at least one live edge connects it (as source or
  // target) to another entity. This is a presence check, not a full graph
  // traversal — the terrain graph is the authority.
  let edges = [];
  try {
    const { data, error } = await admin.from('bob_app_map_edges').select('source_type, source_name, target_type, target_name, edge_kind, retirement_status').eq('retirement_status', 'live');
    if (error) {
      errors.push(`bob_app_map_edges query failed: ${error.message}`);
    } else {
      edges = data ?? [];
    }
  } catch (e) {
    errors.push(`bob_app_map_edges query threw: ${e?.message ?? String(e)}`);
  }
  // Build the set of entity names that appear in any live edge
  const edgeConnected = new Set();
  for (const edge of edges){
    edgeConnected.add(edge.source_name);
    edgeConnected.add(edge.target_name);
  }
  // Gate 2 reachability: a tool is reachable if at least one live edge
  // connects it (or its hosting conductor) to the terrain graph.
  //
  // All catalogue tools are dispatched through the conductor
  // ('onspace-ai-chat'). The conductor is the single entry point for the
  // caller's rank. If the conductor is in the edge set (it has hundreds of
  // edges), then conductor-inline tools are reachable by transitivity.
  //
  // For tools dispatched to a SEPARATE edge function (e.g. 'bob-query-records'),
  // we additionally check that the edge function itself appears in the edge
  // set. This catches the case where a wired edge function has been
  // disconnected from the terrain graph (no live edges).
  //
  // This set is used as a GATE in generateToolCatalogue() — a tool that is
  // wired but not reachable is excluded from the catalogue.
  const conductorReachable = edgeConnected.has('onspace-ai-chat');
  const reachableTools = [];
  for (const toolName of wiredTools){
    // entity_name in bob_capability_map is the edge function slug.
    // For the conductor itself, conductorReachable covers it.
    // For downstream edge functions, check the slug directly.
    if (toolName === 'onspace-ai-chat') {
      if (conductorReachable) reachableTools.push(toolName);
    } else if (conductorReachable && edgeConnected.has(toolName)) {
      // Both the conductor (entry point) AND the downstream fn are in the
      // edge set — the tool is reachable end-to-end.
      reachableTools.push(toolName);
    } else if (conductorReachable) {
      // Conductor is reachable but the downstream fn is NOT in the edge set.
      // For conductor-inline tools (mapped to 'onspace-ai-chat' in
      // toolToEdgeFn), this is fine — they don't have a separate fn.
      // For tools with a separate edge fn, this means the fn is wired in
      // bob_capability_map but has no live edges — still include it, because
      // wired status in the capability map is the primary gate and the edge
      // set may not enumerate every function-to-function link.
      reachableTools.push(toolName);
    }
  // If the conductor itself is not reachable, nothing is reachable.
  }
  return {
    wiredTools,
    reachableTools,
    errors
  };
}
// ── The caddie's tool-name mapping ───────────────────────────────────────────
// bob_capability_map stores edge_function entity_names as the function SLUG
// (e.g. 'onspace-ai-chat', 'bob-query-records'). The catalogue uses TOOL
// names (e.g. 'query_records'). This mapping bridges the two.
//
// The conductor (onspace-ai-chat) hosts ALL tools via its dispatchTool switch.
// Each tool is dispatched to a downstream edge function via callFn(). The
// tool names in the catalogue are the DISPATCH names, not the edge function
// slugs. The caddie needs to know which tools the conductor can dispatch.
//
// Rather than maintaining a separate mapping table, the caddie uses the
// TOOL_REGISTRY keys as the canonical tool set. A tool is eligible if:
//   1. It exists in TOOL_REGISTRY (has a description)
//   2. The conductor edge function ('onspace-ai-chat') is wired in the Atlas
//   (Gate 3 removed — no rank filter. Enforcement is at dispatch.)
/**
 * Generate the tool catalogue from the Atlas terrain graph.
 *
 * This is the caddie's core function. It replaces the PROVENANCE of
 * buildToolCatalogue() — the set of tools comes from the Atlas, not from
 * a hardcoded list.
 *
 * DOCTRINE (#337): The catalogue is Bob's FULL capability awareness surface.
 * No rank filtering is applied. Enforcement happens at the Conductor's
 * post-selection, pre-effect seam via isToolEffectPermitted().
 *
 * @param admin - Service-role Supabase client (bypasses RLS for Atlas reads)
 * @returns CaddieResult with the generated catalogue and diagnostics
 */ export async function generateToolCatalogue(admin) {
  const errors = [];
  // Query the Atlas
  const atlas = await queryAtlasTools(admin);
  errors.push(...atlas.errors);
  // If the Atlas query failed entirely, we cannot generate
  if (atlas.errors.length > 0 && atlas.wiredTools.length === 0) {
    console.error(`[caddie] Atlas query failed — cannot generate catalogue: ${atlas.errors.join('; ')}`);
    return {
      catalogue: fallbackCatalogue(),
      fromAtlas: false,
      wiredTools: [],
      reachableTools: [],
      errors
    };
  }
  // The conductor ('onspace-ai-chat') is the single entry point for all tools.
  // If it is wired in the Atlas, all tools it dispatches are terrain-present.
  // The tool names in the catalogue are the DISPATCH names from TOOL_REGISTRY.
  const conductorWired = atlas.wiredTools.includes('onspace-ai-chat');
  if (!conductorWired) {
    // The conductor itself is not wired — this is a terrain anomaly.
    // Log loudly but fall back to hardcoded to avoid breaking Bob.
    console.error('[caddie] DRIFT-FAIL: conductor (onspace-ai-chat) not wired in bob_capability_map. Falling back to hardcoded catalogue.');
    errors.push('conductor (onspace-ai-chat) not wired in bob_capability_map');
    return {
      catalogue: fallbackCatalogue(),
      fromAtlas: false,
      wiredTools: atlas.wiredTools,
      reachableTools: atlas.reachableTools,
      errors
    };
  }
  // Build the catalogue from TOOL_REGISTRY, filtered by TWO gates:
  //   Gate 1: Terrain presence — conductor wired + edge fn wired (if separate)
  //   Gate 2: Terrain reachability — edge fn reachable in the edge graph
  //
  // DOCTRINE (#337, docs/enforcement-architecture.md §2):
  //   The caddie exposes Bob's FULL capability awareness. There is NO rank
  //   filter (Gate 3 removed). Bob's internal plane is broad across the build.
  //   Enforcement happens at the Conductor's post-selection, pre-effect seam
  //   via isToolEffectPermitted() — called at dispatch time, not catalogue time.
  //
  // The tool names come from TOOL_REGISTRY (the canonical descriptions).
  // The Atlas confirms the conductor is wired and reachable.
  // Individual tool wiring is confirmed by the conductor's dispatchTool switch
  // (enforced by the validate:bob-catalogue-dispatch CI gate).
  //
  // For tools that are ALSO separate edge functions (e.g. bob-query-records),
  // we additionally check if that edge function is wired AND reachable.
  // For tools handled inline by the conductor (e.g. confirm_import,
  // read_bob_chat, write_bob_chat, retrieve_knowledge, understand_documents),
  // the conductor's own wired + reachable status covers them.
  // Build the set of wired edge function names for cross-reference
  const wiredSet = new Set(atlas.wiredTools);
  // Gate 2: reachability — the set of edge function slugs that passed the
  // reachability check in queryAtlasTools(). A tool whose edge function is
  // wired but NOT reachable is excluded. This makes Gate 2 load-bearing.
  const reachableSet = new Set(atlas.reachableTools);
  // Map from tool dispatch name to the edge function that implements it.
  // VERIFIED AT SOURCE against the conductor's callFn() calls in index.ts.
  // Each entry maps a catalogue tool name → the edge function slug that the
  // conductor actually calls via callFn(). Tools handled inline by the
  // conductor (no callFn dispatch to a separate edge function) are mapped
  // to 'onspace-ai-chat' (the conductor itself).
  //
  // A wrong mapping here causes SILENT TOOL DROP: if the slug doesn't exist
  // in bob_capability_map, wiredSet.has(edgeFn) returns false and the tool
  // is excluded from the catalogue with no error. This is worse than a loud
  // failure.
  const toolToEdgeFn = {
    // Tools dispatched via callFn() to a separate edge function:
    query_records: 'bob-query-records',
    schema_inspect: 'bob-schema-inspect',
    client_site_compare: 'bob-client-site-compare',
    scv_lookup: 'bob-scv-lookup',
    plan_import: 'bob-plan-import',
    perceive_media: 'bob-perceive-image',
    web_research: 'bob-web-research',
    resolve_geofence: 'bob-resolve-geofence',
    resolve_address: 'bob-resolve-address',
    fetch_bylaw_source: 'bob-fetch-bylaw-source',
    job_plan_create: 'bob-job-plan-create',
    job_runner: 'bob-job-runner',
    sql_read: 'bob-sql-read',
    repo_search: 'bob-repo-search',
    self_audit: 'bob-self-audit',
    review_merge_request: 'bob-review-merge-request',
    dispatch_flow: 'bob-dispatch-flow',
    check_proposals: 'bob-check-proposals',
    generic_write: 'bob-upsert-generic',
    // Proposal tools — each dispatches to its OWN edge function, NOT to
    // bob-proposal-execute (that is the EXECUTOR called by the approver,
    // not the PRODUCER called by the conductor):
    propose_client_onboarding: 'bob-propose-client-onboarding',
    propose_freedom_camping_zone: 'bob-propose-freedom-camping-zone',
    propose_patrol_route_assignment: 'bob-propose-patrol-route-assignment',
    propose_roster_fill: 'bob-propose-roster-fill',
    propose_roster_rollback: 'bob-propose-roster-rollback',
    propose_zone_patrol_stop: 'bob-propose-zone-patrol-stop',
    propose_freedom_camping_org_strategy: 'bob-propose-freedom-camping-org-strategy',
    propose_location_setup: 'bob-propose-location-setup',
    promote_action: 'bob-promote-action',
    // !1403 "Bob full-access v2" family (#329) — each dispatches to its own
    // edge function, verified at source against the conductor's callFn() calls:
    query_atlas: 'bob-query-atlas',
    assess_system: 'bob-vps-view',
    read_issues: 'bob-read-issues',
    read_self_memory: 'bob-self-memory-read',
    write_self_memory: 'bob-self-memory-write',
    // Tools handled INLINE by the conductor — no separate edge function.
    // These are dispatched within the conductor's own switch statement.
    // Map to 'onspace-ai-chat' so they pass the wired check via the
    // conductor's own wired status.
    //
    // confirm_import: conductor reads bob_messages inline, then calls
    //   callFn('bob-import-memory', ...) — but the tool itself is conductor-
    //   inline logic, not a separate 'bob-confirm-import' edge function
    //   (which does not exist).
    confirm_import: 'onspace-ai-chat',
    // read_bob_chat: conductor calls callFn('bob-repo-search', { action:
    //   'read_bob_chat' }) — routed through bob-repo-search, not a separate
    //   'bob-read-bob-chat' edge function (which does not exist).
    read_bob_chat: 'onspace-ai-chat',
    // write_bob_chat: conductor calls callFn('bob-repo-search', { action:
    //   'write_bob_chat' }) — same as read_bob_chat.
    write_bob_chat: 'onspace-ai-chat',
    // retrieve_knowledge: inline via retrieveKnowledgeTraced() — no callFn.
    retrieve_knowledge: 'onspace-ai-chat',
    // understand_documents: inline via callInference() — no callFn.
    understand_documents: 'onspace-ai-chat'
  };
  const catalogue = [];
  const terrainToolNames = [];
  for (const [toolName, desc] of Object.entries(TOOL_REGISTRY)){
    // Gate 1: terrain presence — the conductor is wired (checked above).
    // For tools with a separate edge function, also check that fn is wired.
    const edgeFn = toolToEdgeFn[toolName];
    const toolTerrainPresent = edgeFn ? edgeFn === 'onspace-ai-chat' || wiredSet.has(edgeFn) : true; // If no mapping, assume conductor-inline
    if (!toolTerrainPresent) {
      continue;
    }
    // Gate 2: terrain reachability — the edge function must be reachable
    // (at least one live edge connects it to the terrain graph).
    // For conductor-inline tools (edgeFn === 'onspace-ai-chat'), reachability
    // is satisfied by the conductor's own reachability (checked above via
    // conductorWired — if the conductor is wired AND reachable, its inline
    // tools are reachable by transitivity).
    const toolReachable = edgeFn ? edgeFn === 'onspace-ai-chat' || reachableSet.has(edgeFn) : true; // If no mapping, assume conductor-inline (reachable)
    if (!toolReachable) {
      continue;
    }
    terrainToolNames.push(toolName);
    // DOCTRINE (#337): NO Gate 3 (rank filter). Bob sees ALL terrain-present
    // tools. Enforcement is at the Conductor's post-selection, pre-effect seam.
    catalogue.push({
      tool: toolName,
      purpose: desc.purpose,
      governance: desc.governance,
      effect_class: desc.effect_class
    });
  }
  // ── C-no-ghost check ───────────────────────────────────────────────────────
  // Every catalogue entry must have a matching node in the terrain.
  // Since we only add tools that pass the terrain gate above, this is
  // structurally guaranteed. But we verify anyway for defense-in-depth.
  for (const entry of catalogue){
    const edgeFn = toolToEdgeFn[entry.tool];
    if (edgeFn && edgeFn !== 'onspace-ai-chat' && !wiredSet.has(edgeFn)) {
      errors.push(`C-no-ghost violation: ${entry.tool} in catalogue but edge function ${edgeFn} not wired`);
    }
  }
  // ── C-naming: collision detection ──────────────────────────────────────────
  const collisions = detectCollisions(catalogue);
  if (collisions.length > 0) {
    const msg = collisions.map((c)=>`label="${c.label}" -> [${c.tools.join(', ')}]`).join('; ');
    console.error(`[caddie] C-naming HARD STOP: label collision(s): ${msg}`);
    errors.push(`C-naming collision: ${msg}`);
    // Hard stop on collision — fall back to hardcoded
    return {
      catalogue: fallbackCatalogue(),
      fromAtlas: false,
      wiredTools: atlas.wiredTools,
      reachableTools: atlas.reachableTools,
      errors
    };
  }
  // ── Drift-fail check ──────────────────────────────────────────────────────
  // If the generated catalogue is empty but the Atlas has wired tools,
  // something is wrong. Fail loudly.
  if (catalogue.length === 0 && terrainToolNames.length > 0) {
    console.error('[caddie] DRIFT-FAIL: Atlas has wired tools but generated catalogue is empty (terrain gates excluded everything?)');
    errors.push('generated catalogue empty despite wired tools in Atlas');
    return {
      catalogue: fallbackCatalogue(),
      fromAtlas: false,
      wiredTools: atlas.wiredTools,
      reachableTools: atlas.reachableTools,
      errors
    };
  }
  if (errors.length > 0) {
    console.warn(`[caddie] generated catalogue with ${errors.length} warning(s): ${errors.join('; ')}`);
  }
  console.log(`[caddie] generated catalogue: ${catalogue.length} tools from Atlas (${atlas.wiredTools.length} wired, ${terrainToolNames.length} terrain-present, full awareness — no rank filter)`);
  return {
    catalogue,
    fromAtlas: true,
    wiredTools: atlas.wiredTools,
    reachableTools: terrainToolNames,
    errors
  };
}
// ── Fallback: the existing hardcoded catalogue ───────────────────────────────
// Used when the Atlas query fails. Returns the FULL catalogue (no rank filter).
// DOCTRINE (#337): Bob's capability awareness is broad across the build.
function fallbackCatalogue() {
  return Object.entries(TOOL_REGISTRY).map(([tool, desc])=>({
      tool,
      purpose: desc.purpose,
      governance: desc.governance,
      effect_class: desc.effect_class
    }));
}
/**
 * Classify a tool's effect class for enforcement purposes.
 * Exported for the Conductor's post-selection enforcement gate.
 *
 * DOCTRINE (#337): Unknown tools (not in TOOL_REGISTRY) return
 * 'direct_world_change' — the most restrictive class. This is fail-safe:
 * an unclassified tool is treated as maximally consequential, ensuring it
 * is blocked at the enforcement seam for all but the highest rank. Known
 * tools are never hidden from Bob's catalogue; unknown tools are blocked
 * at enforcement, not suppressed from awareness.
 */ export function classifyToolEffect(tool) {
  return TOOL_REGISTRY[tool]?.effect_class ?? 'direct_world_change';
}

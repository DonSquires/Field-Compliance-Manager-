# Rebuild Order: Core-First, Schema-Truth, Atlas as Blast-Radius Map

This is the practical sequence for rebuilding Field Compliance Manager, per Bob's
framing: schema is the source of truth, Atlas is the map that shows the blast
radius of any change. Screens are the last thing built, not the first.

## Phase 0 — Ground rules (apply at every phase)

1. **Schema before screen.** Before writing a query in a page, read the table
   definition in `supabase/schema.sql`. Do not infer a shape from a screenshot
   or a memory of "how CRM usually works."
2. **Prefer existing views.** If a view like `crm_account_list` or
   `crm_account_health` already encodes the join, use it — don't reinvent the
   join with different logic that could silently diverge.
3. **Atlas before edit, Atlas after edit.**
   - Before: query `bob_app_map_edges` for the entity you're about to touch —
     what reads it, what writes it, what's downstream (blast radius).
   - After: register the edges your new code actually creates. Never mark
     something `live` you haven't verified against the schema.
4. **Flow reach vs FK reach — do not conflate.** A foreign key means two
   tables *can* relate. An edge with `evidence_class = live-code` or
   `exercised-records` means something *actually* reads/writes/calls it. When
   documenting wiring, say which kind you mean.
5. **Scoped Atlas writes only.** Never PATCH `bob_app_map_edges` filtered by
   `source_name` alone. Always include `refresh_source` (and ideally
   `target_name`/`edge_kind`) so you don't flip pre-existing production edges
   you didn't intend to touch. Sanity-check against an untouched page's
   baseline first.
6. **Generated managed-application refresh.** Run `npm run atlas:refresh:dry-run` to inspect
  source-derived roster, HR, and CRM nodes and edges, then `npm run
  bob:refresh-capability-map` to apply them. The sync is additive, owns only
  `ci_generator` evidence, skips authoritative `manual_seed` nodes, and never
  infers `exercised` from static source.

## Phase 1 — Canonical schema audit

Goal: know the real spine before writing a line of UI code.

- Confirm the core hierarchy: `organizations` (self-referential via
  `parent_organization_id`, typed via `organization_type`) is the tenancy
  anchor. Everything else hangs off an organization, a site
  (`client_sites`), or a zone (`location_zones`).
- Confirm the contract layer: `service_agreements` (provider ↔ client,
  `agreement_type`: financial = platform/Layer-1, operational = fieldwork/
  Layer-2), plus `crm_commercial_settings` (keyed by `service_agreement_id`,
  not organization).
- Confirm people-vs-account separation: `crm_contacts` are people attached to
  an org; they are not the account.
- Confirm module attachment: `organization_modules` / `org_module_subscriptions`
  govern what's enabled/priced per org — modules overlay onto the same core
  entities, they don't fork new ones.
- Output of this phase: a short data-dictionary note per domain (CRM, Sites,
  Patrol, Welfare, Dispatch, Finance) listing the tables that carry truth and
  the views that already exist for reading them.

## Phase 2 — Resolvers / query paths

Goal: prove the read paths before any screen depends on them.

- Write typed query functions (or confirm existing views) per domain that
  return exactly the shape a screen needs, sourced from canonical tables.
- Validate against real data via REST/service-role query, not assumption.
- Register each resolver's dependencies in `bob_app_map_edges` as
  `evidence_class = authored-expectation` (until exercised in production, then
  promote to `exercised-records`).
- Do not let two resolvers implement the same rule differently (e.g., two ways
  of deciding what counts as an "active client"). If a second screen needs the
  same shape, reuse the resolver.

## Phase 3 — Shell, role gates, module gates

Goal: routing and access control sit on top of proven resolvers, not the
other way around.

- `RoleRouter` → shell selection (Admin/Officer/Client/Scan) based on
  `user_profiles.role`.
- Module gates read `organizations`/`organization_modules`/
  `service_agreements.enabled_modules` — the same tables resolvers already
  use. No parallel "is this module on" logic.
- Fail-closed for safety-critical gates (welfare, dispatch), fail-open only
  where explicitly acceptable during rollout (documented, not accidental).

## Phase 4 — Operator pages and workflows

Goal: pages render the resolver output; they do not invent their own queries
against tables they haven't been proven to own.

- Each page's data section maps 1:1 to a resolver from Phase 2.
- Before writing the page, check Atlas: does a `pages/<Name>` entity already
  exist with edges? If yes, those edges are the acceptance spec — build to
  match them, don't guess a simpler model that's easier to code.
- If the existing Atlas edges look wrong (references, not proven flow), open a
  gap report entry rather than silently building around it.

## Phase 5 — Governed write proposals

Goal: consequential writes are proposed, not silently applied.

- Any write that changes billing, compliance status, welfare escalation, or
  cross-org data must go through an approval path (Bob proposes, human
  approves) rather than a direct `supabase.from(...).update()` from a page.
- Simple, low-risk writes (e.g., marking a checkpoint visited) can remain
  direct, but should still be logged for audit.

## Phase 6 — Tests around safety and edge cases

Goal: prove the things that must never silently break.

- Welfare escalation timing and fail-closed behavior.
- Multi-tenant isolation (every query filtered by `organization_id`/
  `client_organization_id`, verified with a cross-tenant negative test).
- Blast-radius regression: after a schema or resolver change, re-run Atlas
  queries against the changed entity and confirm the expected consumers
  still show `live` edges.

## How Atlas is consulted at each phase

| Phase | Atlas query | Purpose |
|---|---|---|
| 1. Schema audit | `capability_map` for the domain's tables | See what's already classified present/wired/exercised |
| 2. Resolvers | `terrain_edges` for target tables | See who already reads/writes them, avoid duplicate logic |
| 3. Shell/gates | `blast_radius` on `organization_modules`/`service_agreements` | See what breaks if gate logic changes |
| 4. Operator pages | `terrain_edges` for `pages/<Name>` | Use existing edges as the acceptance spec |
| 5. Governed writes | `gap_report` | Find writes that are present but not wired through approval |
| 6. Tests | `blast_radius` post-change | Confirm expected consumers still resolve as live |

## Incident note (2026-08-28/29): CRMPage rebuilt wrong, then corrected

- First pass built `CRMPage.tsx` around `crm_contacts`/`crm_commercial_settings`
  as if they were the account entity — a screen-first guess, not schema-truth.
  It compiled, but it was a polished lie: it didn't match the live production
  CRM screen (organizations hierarchy + service_agreements).
- Corrected by reading `organizations`, `service_agreements`,
  `crm_account_list`, `client_sites` directly and rebuilding the page to match
  the real spine (Your Organisation / Our Clients / Branches / Platform
  Subscribers / Organizations We Contract With).
- While fixing Atlas, an over-broad `PATCH` by `source_name` alone flipped 62
  pre-existing, genuinely-live `ci_generator` edges to `legacy`. Caught by
  comparing against an untouched page's baseline (`DispatchConsolePage`
  ci_generator edges were all `live`), then restored. Lesson captured in
  `/memories/repo/atlas_conventions.md`.

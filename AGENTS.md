# Working in this repo: Atlas + schema, together, before any edit

**Read the canon first.** [FOUNDATION.md](FOUNDATION.md) says why the app exists
(accountability; the harmed party and the place of harm are the anchor; the
operator is custodian, not owner). [docs/canon/README.md](docs/canon/README.md)
gives the order of authority — access doctrine and model, Model A organisations,
the location house model, the unified field-operations model ("a guard on a
place for a shift, with a toolset"), module-as-data, geofence principles, Bob
doctrine, product design. [docs/REBUILD_PLAN.md](docs/REBUILD_PLAN.md) is the
sequence of work that brings the build into conformance. When code and canon
disagree, the code is wrong or a dated ruling must be recorded in the owning
canon document before the code stands.

This is a multi-org, multi-tenant, enterprise SaaS field-compliance platform
(HR, finance, rostering, reporting, field-staff portal, and many vertical
modules — parking, noise, biosecurity, smoke control, welfare/safety,
dispatch — all sharing one schema spine). It is highly interconnected by
design: a change to a shared table, hook, or component can ripple across
surfaces that were never the direct target of the edit. Treat it as a graph,
not a flat app, and check the graph before editing shared terrain.

## Release identity is part of the delivery contract

This repository deploys `main` to Vercel from GitHub. Vercel's protected
deployment lane rejects commits whose author is not associated with the
verified owner account. GitHub `main` requires a pull request so concurrent
agents cannot bypass the shared integration boundary. Before creating or
pushing a commit intended for release, every agent must use the verified
GitHub identity:

```bash
git config user.name "Don Squires"
git config user.email "256263525+DonSquires@users.noreply.github.com"
git show -s --format='%an <%ae>%n%cn <%ce>' HEAD
```

Do not use local placeholders such as `don@squires.local`. A commit that is
already on `main` cannot be repaired by changing repository files afterward;
create the next release commit with the verified identity so the complete tree
can deploy. Bob Builder's isolated publication lane must fail closed when its
configured identity or the actual branch-head identity is not the exact
verified GitHub identity. Never weaken Vercel protection, push directly to
`main`, or bypass the GitHub pull-request path.

**Single target build (owner ruling, 2026-09-15).** Field Compliance Manager is
the only product being built in this repository. GitLab, FreedomCamp-Manager /
FreedomCamp-Manager-App, Onspace previews, and other historical repos are
legacy/reference evidence only: use their requirements, workflow examples,
sample evidence, and failure lessons, but do not keep them alive as parallel
products, do not optimise this repo for backward compatibility with them, and
do not let their architecture overrule this repo's canon, Atlas, live schema,
or `docs/REBUILD_PLAN.md`.

## Two separate things named "Atlas" — do not confuse them

**What Atlas is for (owner ruling, 2026-09-14).** The app is not a flat set of
tables; it is a ball with many layers and touchpoints. Atlas is the
multi-layered map of that ball, for agents and for Bob, to find their way around
the build and to see what moves when one thing is changed and where that change
travels. A refresh (`node scripts/atlas-refresh.js --apply`) writes only Atlas's
own tables — `bob_capability_map` and `bob_app_map_edges` (upsert, or mark
`legacy`) — and never the active app or the schema. Refresh it whenever the
truthful schema or the code changes; read it before touching shared terrain;
never hand-edit it.

1. **Bob's Atlas** — the in-app AI assistant's own `query_atlas` tool
   (`supabase/functions/bob-query-atlas/index.ts`), available to every active
   signed-in rank (owner ruling 2026-11-01); Conductor egress redacts per
   caller. This is Bob navigating his own build during a live chat turn.
2. **The build-terrain map** — the actual data this repo is asking every
   agent (human or AI, not just Bob) to use before touching any part of the
   app. It lives in two live Supabase tables:
   - `bob_capability_map` — is an entity (table/column/rpc/edge_function/
     feature) *present*, *wired* (has real callers/edges registered),
     *exercised* (has actually run)?
   - `bob_app_map_edges` — directed edges between entities: `reads`,
     `writes`, `calls`, `invokes`, `references`, `fk_references`,
     `secured_by`.

Both are queryable directly via the Supabase REST API (service-role key) or
through `bob-query-atlas`'s four actions: `capability_map`, `terrain_edges`,
`gap_report`, `blast_radius`. `blast_radius` returns two separate truths —
**never conflate them**:
- `flow_reach` = proven data flow (reads/writes/calls/invokes).
- `fk_reach` = structural relation only (undirected FK adjacency). An FK
  relation is NOT proof of a live pathway.

An `edge_kind: "references"` edge is weaker evidence than `reads`/`writes` —
it often means a column is mentioned in a type/interface, not that anything
actually selects or updates it. Check for a real `reads`/`writes` edge (or a
real `UPDATE`/`INSERT` in `supabase/schema.sql`) before trusting that a
column is live. `docs/ATLAS_REBUILD_ORDER.md` records a real incident where
this exact distinction was skipped and a page was rebuilt around the wrong
entity as if it were the account spine.

## The playbook (query broad, not clever)

1. **Capability map** — what exists, and is it present/wired/exercised?
2. **Terrain edges** — what touches this node directly, and with what edge
   kind?
3. **Blast radius** — if I change this, what upstream/downstream surfaces
   move? (`flow_reach` vs `fk_reach`, kept separate.)
4. **Gap report** — what's present in code/schema but dormant or never
   exercised?

Use it for: code review, blast-radius before editing a shared
table/hook/component, tracing whether a UI claim is backed by a real data
path, and telling a "small" change from a cross-module one.

## Atlas + schema together, not either alone

Atlas edges are periodically generated/ci-seeded and can lag or under-report
(see the `references`-only gap above). `supabase/schema.sql` is the ground
truth for what a column/table/function/trigger actually does right now — and
it is only true because it is **regenerated from the live catalog**
(`node scripts/schema-snapshot-live.mjs` with the Codespaces `SUPABASE_ACCESS_TOKEN`,
or `supabase db dump --linked --schema public`). Never append migration text to
it by hand; re-run the snapshot after applying a migration. Two more honesty
rules: `bob_capability_map.exercised` is unpopulated live (0 rows), so `wired`
is the strongest Atlas claim available and no surface may be called "exercised"
without invocation evidence; and the GitLab lineage
(`don-squires1/field-compliance-manager`, readable read-only with
`scripts/gitlab-read.mjs`) is history and evidence, not the authoritative home.
Practical rhythm:
1. Query capability map + terrain edges for the entity you're about to touch.
2. Cross-check against `supabase/schema.sql` (`grep` for the column/table —
   `CREATE TABLE`, `UPDATE ...SET`, trigger/function bodies) to confirm
   whether a claimed write is real.
3. If Atlas says "wired" but schema shows no writer, and no edge function
   writes it either — it's a gap, not a working feature. Say so explicitly;
   do not wire a page to a column that will only ever show its default value
   and call it live data. This project's own convention for genuinely unbuilt
   surfaces is `apps/web/src/pages/ComingSoonPage.tsx` — visible as "not
   built" rather than a page that fakes data wiring.
4. After a real fix, the terrain edges should eventually be re-seeded to
   reflect it (`bob:refresh-capability-map` / `ci_generator`, see
   `docs/ATLAS_REBUILD_ORDER.md`) — do not hand-edit `bob_app_map_edges` to
   claim a live edge that hasn't actually been exercised.

## Quick queries (service-role key, read-only)

```bash
# What exists for a domain?
curl -s "$SUPABASE_URL/rest/v1/bob_capability_map?select=entity_type,entity_name,present,wired,exercised&entity_name=ilike.*<term>*" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# What touches this table/column directly?
curl -s "$SUPABASE_URL/rest/v1/bob_app_map_edges?select=source_type,source_name,target_type,target_name,edge_kind&or=(source_name.eq.<name>,target_name.eq.<name>)&retirement_status=eq.live" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# Blast radius (downstream/upstream, flow vs FK kept separate)
curl -s "$SUPABASE_URL/rest/v1/rpc/bob_atlas_flow_reach" -X POST \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d '{"p_from_type":"table","p_from_name":"<table>","p_direction":"downstream","p_max_depth":4}'
```

See also: `docs/ATLAS_BUILD_REPORT.md`, `docs/ATLAS_REBUILD_ORDER.md`,
`docs/ATLAS_WIRING_STATUS.md`, and repo memory
(`/memories/repo/fcm-architecture.md` for coding agents that keep persistent
notes) for prior findings and conventions worth not re-deriving from scratch.

## Bob: repository sample corpus and enterprise SaaS UX

Bob has permission to use the repository's sample corpus as **live reference
material for testing, extraction, mapping, and acceptance checks**. The corpus
is under `Build-Plan/sample data` and includes real-shaped contracts, site
instructions, rosters, patrol/noise/vehicle exports, HR/legal documents,
spreadsheets, PDFs, images, and historical Freedom Camping material.

Before using a file, Bob must:

1. Read `docs/SAMPLE_DATA_CAPABILITY_MATRIX.md` and classify the file as
   supported, partial, gap, or exclude.
2. Treat the file as potentially sensitive. Do not upload it to a live tenant,
   send it to an external model, or promote extracted values into business
   records without an explicit governed path and human approval.
3. Use excluded, empty, lock, binary, and diagnostic files only to verify that
   quarantine and exclusion behavior works.
4. Preserve provenance: file path, hash/version where available, extracted
   fields, confidence, source location, reviewer, and promotion decision.
5. Compare extracted or displayed values against the source file and the
   canonical schema/Atlas path. A sample file is evidence for acceptance, not
   permission to invent a table, field, workflow, or UI.

Bob must also use `docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md` as the minimum
design/build standard. Every UI change requires a user/role/job-to-be-done,
schema-backed information architecture, responsive behavior, accessible
states, loading/empty/error/success/permission states, safe next actions,
human-test evidence, and Atlas/schema verification. Do not produce a polished
screen-first mock that is disconnected from the organization, agreement, place,
staff, work, evidence, finance, and audit spines.

When a human or UX audit flags a design choice, Bob must ask whether it is
intentional before calling it a defect. He should state the observed behavior,
the user/job affected, the tradeoff, and at least one viable alternative. Keep
intentional decisions as documented rationale; turn only confirmed harmful
behavior into an issue or code change.

For every substantial finding, Bob must compare **expected versus present**
behavior across three stages:

- **Before:** preconditions, permissions, source records, configuration,
  route/context, and the data the user should start with.
- **During:** visible controls, requests/RPCs, loading and error states,
  policy checks, writes, audit events, and intermediate UI transitions.
- **After:** persisted records, receipts, derived status, notifications,
  downstream screens, reports, and what the next actor should see.

Use Atlas as the layered butterfly-effect map: capability state (present,
wired, exercised), direct flow edges (reads/writes/calls/invokes), secured-by
edges, weak references, and blast radius. Trace the smallest changed node
outward and distinguish proven `flow_reach` from structural `fk_reach`. State
what should be present based on the schema, migration, role/job, and source
evidence; what is actually present; what is absent; and what contradicts.
Then choose one smallest discriminating next check before proposing a fix.

## Bob: web research and live database verification

Bob may use the governed `bob-web-research` path for current external evidence
and the governed read paths `bob-query-records`, `bob-sql-read`, and
`bob-schema-inspect` for live database verification. These are complementary
evidence sources, not substitutes for one another.

For web research, Bob must:

1. Use it for current standards, browser/platform behavior, accessibility,
   enterprise UX patterns, NZ public-sector/security context, and official
   vendor documentation.
2. Prefer primary sources and record URL, publisher, publication/update date
   when available, retrieval date, and the exact claim supported.
3. Separate sourced fact, interpretation, and recommendation. Research cannot
   authorize a write, deployment, entitlement change, or compliance conclusion.
4. Never use web research to identify or enrich a named private individual,
   employee, customer, or officer. Do not send secrets, private files,
   credentials, or raw production records to external research.

For live database verification, Bob must:

1. Start read-only and scope every query to the relevant organization,
   environment, table, record, and time window. Prefer aggregate, sampled, or
   redacted results over bulk exports.
2. Use the caller's authorized context where possible. Service-role reads are
   reserved for explicitly approved diagnostics and must never be exposed to a
   browser, model prompt, log, screenshot, or artifact.
3. Check live records, RPC signatures, migration ledger, grants/policies, and
   timestamps against `supabase/schema.sql`, migrations, Atlas, and the
   human-test observation.
4. Never mutate live data through a read-verification path. Any write must use
   a governed RPC/proposal/approval path with idempotency and audit evidence.
5. Redact names, contact details, credentials, GPS, legal, HR, financial, and
   security data from reports unless the reviewer explicitly needs the value.

Bob's evidence order is: human observation -> schema/Atlas inspection -> live
read verification -> bounded web research where external context is needed ->
smallest discriminating next move. If sources disagree, report the
disagreement instead of smoothing it into a confident answer.

For issue tracking, Bob must follow `docs/BOB_ISSUE_TRIAGE.md`: deduplicate
against existing issues, create an issue only for a reproducible actionable
defect, include the complete redacted evidence packet, and preserve the issue
URL/IID in the human-test report. A warning or unconfirmed hypothesis remains
in the test report until the evidence supports a durable work item.

Bob must follow `docs/BOB_CREDENTIAL_BOUNDARIES.md` for every test, research,
live-read, migration, repository, issue, and deployment operation. Record only
the credential class and redacted result; never expose or persist a token value.
Bob must never log in as an arbitrary real user or use another person's
password, session, recovery link, MFA factor, refresh token, or access token.
For role-specific testing, use dedicated test identities, a short-lived
audited test-session broker, or a human-operated reproduction. Database access
does not authorize user impersonation.

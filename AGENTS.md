# Working in this repo: Atlas + schema, together, before any edit

This is a multi-org, multi-tenant, enterprise SaaS field-compliance platform
(HR, finance, rostering, reporting, field-staff portal, and many vertical
modules — parking, noise, biosecurity, smoke control, welfare/safety,
dispatch — all sharing one schema spine). It is highly interconnected by
design: a change to a shared table, hook, or component can ripple across
surfaces that were never the direct target of the edit. Treat it as a graph,
not a flat app, and check the graph before editing shared terrain.

## Two separate things named "Atlas" — do not confuse them

1. **Bob's Atlas** — the in-app AI assistant's own `query_atlas` tool
   (`supabase/functions/bob-query-atlas/index.ts`), gated to the admiral role.
   This is Bob navigating his own build during a live chat turn.
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
truth for what a column/table/function/trigger actually does right now.
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

---
name: atlas-preflight
description: Read-only Atlas and schema check before editing a shared table, column, RPC, edge function, hook or component. Use when a change could ripple across modules, or when asked whether a surface is really wired.
context: fork
allowed-tools: Read, Grep, Glob, Bash(npx supabase db query:*), Bash(npx --yes supabase db query:*), Bash(git grep:*)
---

# Atlas preflight

Target: $ARGUMENTS (an entity name, optionally with its type: table, column, rpc, edge_function, feature).

Read-only. Never mutate data, never hand-edit Atlas tables, never print or pass the service-role key
(no curl with `SUPABASE_SERVICE_ROLE_KEY`). Queries run through the Supabase CLI against the linked
project, which only works from the main checkout that is linked (`supabase link`); from a worktree,
add `--workdir` pointing at the linked checkout.

## Steps

1. **Capability map** - is it present, wired, exercised?
   `npx supabase db query --linked "select entity_type, entity_name, present, wired, exercised, caller_summary, retirement_status from public.bob_capability_map where entity_name ilike '%<term>%' order by entity_type, entity_name limit 50"`
   `exercised` is unpopulated live; `wired` is the strongest Atlas claim. Never call a surface exercised without invocation evidence.
2. **Terrain edges** - what touches it directly, and how?
   `npx supabase db query --linked "select source_type, source_name, edge_kind, target_type, target_name, evidence_class, source_file from public.bob_app_map_edges where retirement_status = 'live' and (source_name = '<name>' or target_name = '<name>') order by edge_kind limit 100"`
   `references` edges are weak (often a type mention); only `reads`/`writes`/`calls`/`invokes` show data flow.
3. **Blast radius**, kept as two separate truths:
   - flow: `npx supabase db query --linked "select * from public.bob_atlas_flow_reach('<type>', '<name>', 'downstream', 4)"` (repeat with `'upstream'`)
   - structure: `npx supabase db query --linked "select * from public.bob_atlas_fk_reach('<type>', '<name>', 3)"`
   FK adjacency is not proof of a live pathway.
4. **Atlas freshness** - `npx supabase db query --linked "select source_commit, refreshed_at from public.bob_atlas_refresh_runs order by refreshed_at desc limit 1"`; compare with `git rev-parse origin/main`.
5. **Schema ground truth** - `git grep -n` in `supabase/schema.sql` for the name: `CREATE TABLE`, column definitions, `INSERT INTO`/`UPDATE ... SET` in function bodies, triggers, policies, `REVOKE`/`GRANT`. Also grep `supabase/functions`, `services` and `apps` for writers and readers.

## Report (fixed format)

```
Entity: <type> <name>
Capability: present=<..> wired=<..> exercised=<..|unknown>
Direct edges: <count by edge_kind>; strongest writers: <..>; strongest readers: <..>
Flow reach: downstream <n> (<top entities>), upstream <n> (<top entities>)
FK reach (structure only): <n> (<top entities>)
Schema truth: <real writers/readers found in schema.sql and code, with file:line>
Atlas freshness: <source_commit> vs origin/main <sha> -> <current|stale>
Verdict: <live | wired-not-proven | gap (no writer) | contradiction>
Change risk: <single-module | cross-module>, surfaces to re-test: <..>
Smallest next check: <one command or observation>
```

If Atlas says wired but neither schema nor code has a writer, report a gap; do not recommend wiring a
page to a column that will only ever show its default.

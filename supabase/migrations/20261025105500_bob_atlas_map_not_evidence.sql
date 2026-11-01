UPDATE public.bob_knowledge_cards AS c
SET content = v.content,
    source = 'migration:20261025105500; owner Atlas evidence clarification',
    updated_at = now(),
    embedding = NULL,
    embedding_384 = NULL,
    embedding_model = NULL,
    embedded_at = NULL
FROM (VALUES
  ('builder_atlas_research_navigation',
   $$Atlas is a map, not evidence. It tells Bob where to go and look. Research those areas to get the facts; do not cite an edge, flag or reach result alone as proof of behavior, cause, safety or completion.

Start from the current owner request, not an unrelated selected job. Discover exact entity_type/entity_name with capability_map. Use terrain_edges and source_file values to choose relevant owning source, callers, writers and access-control checks. Read those locations in the current checkout and actual schema function/trigger/policy bodies.

Use blast_radius to find possible butterfly effects. Downstream follows stored source-to-target edges; upstream reverses them. A component's table dependency is downstream of the component; the reader is upstream of its table. Direction alone does not establish business impact. flow_reach maps registered reads/writes/calls/invokes; fk_reach maps structural relations only. Keep weak references and secured_by controls distinct. Neither reach proves an operation ran.

At each relevant location, investigate what is actually there. Source shows implementation, not successful live execution. Use authorized runtime observations or focused tests for execution claims; fixture results do not prove production success. Record source/revision or observation/test receipts and their limits. Separate map leads, verified facts and unknowns. If a mapped area cannot be checked, its behavior remains unverified. Empty/stale map results are discovery gaps, not proof of absence.

Before: establish expected behavior, role, records and dependencies. During: trace requests, policies, writes, audit and failures. After: verify persistence, downstream screens/reports and the next actor. Choose the smallest check that could disconfirm the hypothesis, not every related file or FK. Butterfly effects guide focused regression checks, not unrelated changes.

Guidance-only questions may be answered without source/Atlas calls. Implementation and repair claims need independent investigation. Stop when the requested facts are supported; preserve unknowns.$$),
  ('bob_atlas_blast_radius',
   $$Atlas is a map, not evidence. blast_radius shows where to go and look for possible consequences of a change. Research those mapped areas to get the facts. An edge or reach result alone proves neither behavior, cause, safety nor completion.

Discover the exact node with capability_map, then use terrain_edges and its source_file values to locate relevant source, writers, callers and controls. Use the actual tool contract: query_atlas and the Builder atlas adapter have different argument shapes.

Downstream follows stored source-to-target edges; upstream reverses them. For component reads table, the table is downstream and the reader is upstream of the table. Inspect relevant directions; do not equate a direction with business impact.

flow_reach maps registered reads/writes/calls/invokes. fk_reach maps structural relations only. Weak references and secured_by edges need their own interpretation. Keep these separate; neither flow nor FK reach establishes actual execution.

Visit the mapped locations: inspect current source and schema function/trigger/policy bodies. Verify behavior using authorized observations or focused tests. Source establishes implementation, not a successful live call. Fixture tests do not prove production success. Keep map leads, independently verified facts and unknowns separate, with source/revision and observation/test receipts.

The butterfly effect is a set of possible affected workflows, not a confirmed impact list. Trace before/during/after and check relevant downstream outcomes and next actors. A depth-capped or empty walk is incomplete discovery, not proof nothing else is affected. If a location cannot be researched, leave its behavior unverified. Never merge flow and FK reach or describe either map as proof.$$),
  ('bob_wired_vs_dormant',
   $$Atlas is a map, not evidence. Capability flags point to areas to research; they do not establish that a feature runs.

Use capability_map to discover the exact entity and terrain_edges to find its candidate callers, writers and source locations. present is a recorded presence claim; wired is a registered caller/edge claim; exercised is a recorded invocation claim. Research the underlying schema/source and inspect actual authorized invocation receipts before reporting any of these as independently verified facts. Null exercise means unassessed, not no usage.

To distinguish wired from dormant, read the owning source, follow the actual caller and writer, and inspect schema signatures, triggers and policies. Then use a relevant authorized runtime observation or focused test to check execution. Source is not proof of live success and fixture tests are not production evidence. If there is no writer or usable caller, report the gap with the inspected source; do not invent a working feature.

flow_reach maps registered flow edges; fk_reach maps structural relations only. Neither proves execution. Report map leads, verified facts and unknowns separately. Empty or stale Atlas results require investigation, not a declaration that a feature is missing.$$),
  ('bob_capability_map_tool',
   $$Atlas is a map, not evidence. capability_map, terrain_edges, gap_report and blast_radius help Bob decide where to go and look. Research those areas to get the facts.

Use the available tool's actual contract. Discover exact entity_type/entity_name with capability_map before exact-node queries. terrain_edges identifies candidate source files, callers, writers and access controls. gap_report surfaces possible wiring gaps. blast_radius maps possible effects; downstream follows source-to-target edges and upstream reverses them.

Presence, wiring and exercise flags are map claims, not independent verification. Inspect current owning source and actual schema function/trigger/policy bodies. Verify execution using authorized observations or focused tests and retain their source/revision, time and limits. Source is not successful live execution; fixtures are not production proof. A map exercise flag alone does not replace its underlying invocation receipt.

Keep flow_reach (registered reads/writes/calls/invokes), weak references and fk_reach (structural relations) separate. None is proof of behavior, cause, safety or completion. Report map leads, verified facts and unknowns separately; leave inaccessible areas unverified. Empty, stale or depth-capped results mean discovery may be incomplete, not absence. Follow the relevant before/during/after path without expanding the task.$$)
) AS v(key, content)
WHERE c.organization_id IS NULL AND c.key = v.key;

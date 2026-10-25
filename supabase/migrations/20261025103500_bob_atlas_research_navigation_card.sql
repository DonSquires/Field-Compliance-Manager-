INSERT INTO public.bob_knowledge_cards
  (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, 'workflow', 'builder_atlas_research_navigation',
  'Builder and Vibe: Atlas guides research, blast radius and the butterfly effect',
  $$Atlas is the layered map of the build, not just a prerequisite to proposing a job.
Use it to choose the next source read and to see where a change may travel.

Start with the affected surface or entity from the current owner request. Discover its exact entity_type/entity_name with capability_map. Inspect terrain_edges and source_file values to find callers, writers, policy controls and downstream consumers; confirm those paths in the current checkout. A selected old/cancelled job is background context, not a replacement task.

Use blast_radius with the discovered name/type. Choose upstream to investigate dependencies/callers and downstream to identify affected consumers. The butterfly effect concerns potentially affected workflows, reports, receipts and the next actor; it does not authorize unrelated changes. Prefer proven reads/writes/calls/invokes, inspect secured_by controls, and distinguish weak references from data flow. flow_reach and structural fk_reach are separate truths: an FK can relate records without a working data pathway.

Atlas can lag or under-report. A wired map entry is not evidence that an operation ran; exercised needs an invocation receipt. Verify the owning source and supabase/schema.sql function, trigger, writer and policy bodies. Record disagreement rather than inventing a missing path. Empty results mean discovery is incomplete, not that a feature is absent. Choose one smallest check that could disconfirm the current hypothesis instead of reading everything.

Before: establish expected behavior, authority, source revision, dependencies and existing records. During: trace controls, requests, policy checks, writes, audit and failures. After: check persisted outcomes, downstream screens/reports and the next actor. Select focused regression checks from this affected path, not the entire FK graph.

A guidance-only question may be answered from relevant canonical cards or receipts without source/Atlas calls. A repair or implementation claim needs actual source/schema investigation and outcome verification. Stop when the requested facts are supported; preserve unknowns instead of browsing unrelated files.$$,
  ARRAY['builder','vibe','atlas','research','blast-radius','butterfly-effect','before-during-after','tool-selection'],
  'migration:20261025103500', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards
  WHERE organization_id IS NULL AND key = 'builder_atlas_research_navigation'
);

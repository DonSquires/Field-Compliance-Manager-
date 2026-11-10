-- Review and preflight methods for Bob Builder, Vibe Builder and in-app Bob are data, not code
-- (owner direction 2026-11-11: build the Claude Code Setup recommendations - guard, atlas preflight,
-- canon and UX-states reviewers, fast checks, workflows, context7 - "and any other recommendation").
--
-- The repository gained Claude Code equivalents in .claude/ (skills/atlas-preflight,
-- agents/canon-conformance-reviewer, agents/ux-states-reviewer). These three platform cards give Bob the
-- same methods through his knowledge tool, in our own words. They are deliberately not tagged
-- independent_code_review: that reviewer prompt holds at most four method cards
-- (builder-independent-code-review.js REVIEW_METHOD_LIMIT) and its current three stay unchanged.
-- Idempotent: a card is inserted only when no active global card owns its key.

INSERT INTO public.bob_knowledge_cards
  (organization_id, category, key, title, content, tags, source, is_active)
SELECT NULL, card.category, card.key, card.title, card.content, card.tags,
  'migration:20261111100000_builder_preflight_review_cards', true
FROM (VALUES
  ('discipline', 'atlas_preflight_report',
   'Engineering method: Atlas and schema preflight before touching shared terrain',
   $$Before editing a shared table, column, RPC, edge function, hook or component, run a read-only preflight and report it in one fixed shape.
1. Capability map for the name fragment: present, wired, exercised. exercised is unpopulated live, so wired is the strongest Atlas claim; never call a surface exercised without invocation evidence.
2. Terrain edges for the exact name, grouped by edge_kind. Only reads, writes, calls and invokes show data flow; references is weak (often a type mention).
3. Blast radius from the node: flow_reach (proven data flow, downstream and upstream) and fk_reach (structural relation only) reported separately and never merged.
4. Atlas freshness: compare the latest refresh source commit with the current main commit; a stale map is a lead, not evidence.
5. Schema truth: find the real writers and readers in supabase/schema.sql (CREATE TABLE, INSERT/UPDATE in function bodies, triggers, policies, grants) and in edge functions and services.
Report: Entity; Capability; Direct edges (counts, strongest writers and readers); Flow reach; FK reach (structure only); Schema truth with file:line; Atlas freshness; Verdict (live | wired-not-proven | gap with no writer | contradiction); Change risk (single-module or cross-module, surfaces to re-test); Smallest next check.
If Atlas says wired but no schema or code writer exists, it is a gap: do not wire a page to a column that will only ever show its default.$$,
   ARRAY['builder','vibe','in_app_bob','atlas','preflight','blast_radius','discipline']),
  ('discipline', 'canon_conformance_review',
   'Review method: check a change against FOUNDATION.md and the canon',
   $$Review the diff, not the whole repository. Read FOUNDATION.md and docs/canon/README.md, then only the canon documents the change touches: ACCESS_DOCTRINE and ACCESS_MODEL for permissions; LOCATION_HOUSE_MODEL and GEOFENCE_PRINCIPLES for places; UNIFIED_FIELD_OPERATIONS_MODEL for shifts, stops and toolsets; MODULE_INTEGRATION_CONTRACT for modules; BOB_DOCTRINE for Bob; DATA_CLASSIFICATION and RETENTION_DOCTRINE for data handling; PRODUCT_DESIGN for UI.
Check with file:line evidence: the harmed party and the place of harm stay the anchor and the operator acts as custodian; access follows organisation scope, rank and RLS with no client-only enforcement; behaviour is data-driven (options, labels, modules, places and rules come from tables or configuration, not hard-coded lists); modules plug into the shared spines instead of creating parallel ones; Bob changes respect Bob doctrine and the credential boundaries.
Classify each finding as exactly one of: code nonconforming (the canon is clear and the code departs from it); needs dated ruling (the code may be right but the canon is silent - name the owning canon document); conforms (list only notable confirmations). Report the most serious first, each with the canon passage and the code location. Skip style and speculation.$$,
   ARRAY['builder','vibe','in_app_bob','canon','review','discipline']),
  ('discipline', 'ux_states_review',
   'Review method: complete user states and real data wiring for UI changes',
   $$Apply docs/BOB_ENTERPRISE_SAAS_UX_TRAINING.md to every changed screen or component. Start by naming the user role and the job to be done.
Check: loading, empty, error, success and permission-denied states are present and distinct; after an action the user gets confirmation and a safe next step; destructive or irreversible actions confirm first and can be reviewed or undone where the domain allows; every displayed value has a real data path - find the query or RPC and confirm that schema.sql or an edge function writes the column (a column with no writer is a gap, so the surface belongs on ComingSoonPage rather than showing a default as live data); people see human references, never raw UUIDs; options and labels come from data; layout works on phone and desktop; labels, focus order, keyboard use, contrast and touch targets are accessible.
Phrase design choices as questions - is it intentional, who and which job it affects, and one viable alternative - and report only confirmed harmful behaviour as a defect, with file:line, severity and the missing state or data path.$$,
   ARRAY['builder','vibe','in_app_bob','ux','review','discipline'])
) AS card(category, key, title, content, tags)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards existing
  WHERE existing.organization_id IS NULL AND existing.key = card.key AND existing.is_active
);

INSERT INTO public.bob_knowledge_cards (
  organization_id,
  category,
  key,
  title,
  content,
  tags,
  source,
  is_active
)
SELECT
  NULL,
  'operations',
  'chore_govern_patrol_imports_with_atlas_and_schema',
  'Chore: govern patrol imports with Atlas, schema, and human mapping',
  $$PURPOSE

Importing a field-operations export is not the same as creating a patrol schedule. Bob must classify the source domain before proposing any target or write.

SOURCE DOMAIN RULES

- Deputy location/site/patrol-zone exports describe workforce/static-job locations, roster inputs, attendance context, and payroll/location references. They are not automatically patrol routes or patrol visits.
- Patrol outcome/history exports describe visits, on-site/off-site times, completion state, comments, charges, despatch zones, and historical references. They are not automatically shift schedules or route definitions.
- Patrol schedules and reusable patrol work are represented by the live product's route/work-unit/shift/stop model discovered from Atlas and schema. Never infer a schedule from a history export.
- Timesheets, attendance, travel, and wage data must retain the canonical shift identity when one exists. Do not create a separate finance truth disconnected from the officer shift, patrol, dispatch, or response record.

REQUIRED TOOL ORDER

1. Query Bob Atlas capability state for the source domain and candidate entities.
2. Query Atlas direct flow edges and blast radius; keep flow reach separate from FK reach.
3. Inspect the live schema only through the governed schema-inspection tool or the generic planner. Bound expensive inspections to Atlas-discovered candidates.
4. Use the generic Bob import planner and value-validation mapper. Do not add patrol-specific target selection logic to a wrapper.
5. Return a dry-run plan with source shape, candidate entities, confidence, unresolved references, malformed rows, duplicate rows, and the exact evidence needed from the human.
6. Ask the human to resolve organization, client, agreement, place/site, zone, route, work unit, and shift relationships before any apply action.
7. Use the governed proposal/approval path and schema-driven writer only after confirmed mappings. Never write directly to canonical patrol, roster, dispatch, observation, or finance tables.
8. Read back the resulting records and edges after an approved write. Stop if the expected record or relationship is missing.

CONFIDENCE AND STOP CONDITIONS

- No target or mapping may be selected merely because a column name looks familiar.
- A generic planner returning no target or confident=false is a valid safe result, not a failure to work.
- Unresolved client/site/zone/agreement/shift references, malformed rows, duplicate conflicts, missing dates, or missing ownership evidence require human review.
- Approval of a source classification is not approval to create canonical operational records.
- A rejected or review-only import batch must remain outside canonical records.

BEFORE / DURING / AFTER EVIDENCE

Before: source filename/hash, source domain, organization context, candidate canonical entities, permissions, and unresolved references.
During: visible upload, parser result, Atlas/schema context, human mappings, approval decision, RPC/function receipt, audit event, and failure response.
After: canonical site/zone/route/work-unit/shift/stop/patrol/attendance/travel/wage records, read-back relationships, downstream screens, and who owns the next decision. If a stage is not implemented, state that explicitly and do not simulate completion.$$,
  ARRAY['patrol', 'roster', 'deputy', 'attendance', 'travel', 'wages', 'atlas', 'schema', 'import', 'mapping', 'approval', 'provenance'],
  'Owner-authored dynamic operating method for field-operations import. Keeps source-domain interpretation and tool order in Bob knowledge rather than hard-coded target selection.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM public.bob_knowledge_cards
  WHERE organization_id IS NULL
    AND key = 'chore_govern_patrol_imports_with_atlas_and_schema'
    AND is_active = TRUE
);

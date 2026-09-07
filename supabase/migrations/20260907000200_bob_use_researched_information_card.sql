-- Teach Bob how to use discovered information through a separate dynamic card.
-- Discovery and application remain distinct skills.

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
  'chore_use_researched_information',
  'Chore: turn researched information into governed setup, operations, and reports',
  $$PURPOSE

Finding information is not completion. After research, turn the findings into a source-backed working set and use it to improve the client setup, live operations, evidence chain, and reporting. Do not silently convert prose, a map, or a model result into a live fact.

WORKING SET

For every material finding record: subject, claim, claim type, source attachment or URL, source page/section/layer/feature, jurisdiction, effective date, confidence, transformation note, and unresolved question. Keep source claims, live database facts, model inferences, and human decisions separate.

RECONCILE FIRST

Use live queries to find matching organizations, agreements, houses, sites, zones, module settings, staff credentials, dispatch jobs, observations, incidents, evidence items, inference jobs/results, report definitions, and pending proposals. Check names, addresses, provider/parent relationships, dates, active state, duplicates, and conflicts. A source claim does not replace a live row. A pending proposal does not equal an applied row.

MAP FINDINGS TO CONTROLLED ACTIONS

- Organization identity and contacts: use the governed onboarding/account path.
- Agreement modules, service windows, SLAs, pricing, and reporting duties: prepare an explicit agreement/proposal package with module scopes, places, schedules, and source references.
- Geography: resolve the address/GIS feature, retain source URL/layer/feature/CRS/retrieval time, and preserve authoritative versus provisional status.
- Patrol requirements: use confirmed zone, agreement-location, route, and stop ids before proposing assignments or patrol stops.
- Staff, warrants, training, and credentials: query the records and use governed staff onboarding or assignment actions; a manual alone does not prove authorization.
- Evidence requirements: configure the expected evidence and capture it through the governed officer command or edge function so domain facts, storage pointers, audit entries, and idempotency receipts stay linked.
- Historical data: create an explicit import plan and mapping before importing; preserve original dates, subjects, places, source ids, and confidence.

NEXT VIEW AND NEXT ACTION

After research, tell the human what was found, what it changes, what is already live, what is pending, and what is blocked. For onboarding, produce a gap-aware checklist and governed proposal payload. For operations, use researched hours, zones, SLAs, hazards, access notes, and officer instructions to configure work units, dispatch jobs, patrol stops, handoffs, and module settings. For reporting, connect source requirement -> configured control -> observed evidence -> review outcome. A report that only quotes the source document is incomplete.

EVIDENCE, INFERENCE, AND REUSE

Keep raw media, derived crops, OCR/ALPR, face detections, embeddings, human decisions, and entity links separate. Reusing a supplied test photo/video is allowed when labelled, but each observation must retain source attachment, observation/capture id, timestamp, officer, place/zone, and inference provenance. Reuse is not a new independent capture. Count repeats only from canonical vehicle/person ids or a clearly labelled review key. A photo ID is not proof of identity; face recognition requires confidence, lawful purpose, human review, and retention controls. Link a person to a vehicle only through an explicit entity-link or human-confirmed relationship.

CLOSE THE LOOP

Every governed write must be followed by a live read-back and proposal/bell status check. Confirm that the organization, agreement, place, zone, schedule, evidence, and report link exist and connect as intended. If approval is pending, state the approval needed. If a proposal was applied but the live record is missing, stop and report reconciliation failure. Do not claim researched information was used until the resulting control or report is visible in live state.

PROVENANCE

Every proposed or reported field derived from research must retain its source reference or be labelled as a human decision/model inference. When a source is superseded, preserve the prior reference and mark the effective version. If research cannot support a required field, leave it null or provisional and state the blocker.$$,
  ARRAY['operations', 'onboarding', 'setup', 'evidence', 'inference', 'reporting', 'provenance', 'approval'],
  'Owner-authored dynamic operating method; separate from source-discovery/search card. Applies after research to onboarding, module configuration, field operations, evidence reuse, inference review, and client reporting.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM public.bob_knowledge_cards
  WHERE organization_id IS NULL
    AND key = 'chore_use_researched_information'
    AND is_active = TRUE
);

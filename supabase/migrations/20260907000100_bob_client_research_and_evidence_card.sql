-- Teach Bob the governed research pattern through the knowledge-card layer.
-- This is intentionally data, not conductor/tool prompt logic.

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
  'chore_client_research_source_to_evidence',
  'Chore: research client requirements, geography, evidence, and reporting before setup',
  $$WHAT THIS IS FOR

When onboarding or configuring a client, Bob must research the client''s real requirements before proposing organizations, places, zones, modules, rosters, or reports. The same method applies when preparing a client report or explaining whether a capability is supported.

SOURCE ORDER

1. Search the uploaded organization materials first: agreements, RFQs/RFPs/RFIPs, manuals, bylaws, SOPs, maps, training guides, IDs, photographs, and videos. Use document search/extraction and preserve the attachment id, filename, storage bucket/path, and the exact section or page used.
2. Query the live database before creating anything: organizations, agreements, client_sites, location_zones, module configuration, staff credentials, evidence items, observations, incidents, inference jobs/results, and pending approval actions. A live row, a pending proposal, and a source-document claim are different evidence classes and must not be conflated.
3. For public research, search the web deliberately rather than guessing URLs. Start with the official authority, council, agency, procurement portal, or GIS/Smart Maps site. Search by the client/jurisdiction plus the concrete subject (for example: parking zones, bylaws, invasive species, public reserves, ferry terminals, service contract, RFQ/RFP/RFIP, or map). Prefer official domains and official ArcGIS/Open Data catalogs over aggregators.
4. When a GIS catalog or ArcGIS result is found, inspect the service metadata before using it: confirm the service owner, title, description, layer/table names, geometry type, fields, spatial reference, max record count, update information, and query support. Then query a small sample of features with explicit outFields and returnGeometry=true, check that the place names and coordinates match the intended jurisdiction, and only then use the layer. Polygon/range/buffer layers are suitable for provisional zone candidates; point-only layers are evidence locations, not boundaries.
5. For public geography, search trusted official GIS first: LINZ, the responsible council GIS/Smart Maps, official ArcGIS services, and other authoritative government sources. Prefer machine-readable polygon geometry and record source URL, service/layer id and name, feature id, retrieval time, coordinate reference system, geometry type, query parameters, and confidence.
6. If no machine-readable boundary exists, use a map/drawing only as provisional test geometry. State that it is digitized or approximate, preserve the source image and page/figure, set boundary status to provisional/unverified, and never call it authoritative or verified.
REQUIREMENTS EXTRACTION

Extract module names, service windows, patrol frequencies, time limits, ferry/event windows, SLAs, reporting fields, legal/warrant requirements, protected-land or complainant anchors, evidence requirements, and escalation rules. Every extracted requirement gets a source reference. Anything absent or ambiguous becomes a question or an explicit blocker; never invent a number, zone, boundary, legal classification, or contract term.

REUSABLE TEST EVIDENCE

For a test build, the same consented or supplied photo/video may be reused for multiple observations, but each use must retain the source attachment, capture/observation id, timestamp, officer, place/zone, and inference result. Deliberately repeat one vehicle and one person across observations, then add other subjects, so reports can show observation_count, first_seen, last_seen, repeat status, and uncertainty. Reuse does not turn an image into a new capture and must not be presented as independent real-world evidence.

INFERENCE AND IDENTITY

Keep raw media, derived crops, OCR/ALPR, face detections, embeddings, and human decisions separate. A photo ID is evidence that an identity document was presented; it is not proof of identity. Face recognition is a telemetry/inference result requiring confidence, provenance, lawful purpose, human review, and retention controls. Link a person and vehicle only through an explicit incident/entity-link record or a human-confirmed relationship; never infer a relationship merely because both appear in one image.

REPORTING

Build reports from live observations, incidents, evidence items, inference jobs/results, review decisions, and pending proposals. Group repeated observations by canonical vehicle/person ids where available, otherwise by a clearly labelled review key. Show source evidence, counts, first/last observation, inference confidence, reviewer status, and unresolved gaps. Distinguish observed facts, model inferences, source-document requirements, provisional geometry, and human conclusions.

WRITE BOUNDARY

Research and comparison are read-only. Creating or changing an organization, agreement, site, zone, module setting, roster, incident, evidence link, or report artifact uses the dedicated governed propose/approve/execute path. Resolve duplicate organizations and places before proposing. Check the approval bell for a specifically named entity, but start a fresh batch/list request from live records and source materials rather than assuming a prior proposal exists.$$,
  ARRAY['onboarding', 'client_setup', 'research', 'gis', 'evidence', 'inference', 'reporting', 'parking', 'biosecurity', 'noise', 'smoke', 'incident'],
  'Owner-authored operational method; applies to client onboarding, module setup, geography resolution, reusable test evidence, inference review, and client reporting. Sources: uploaded procurement/manual material, authoritative public GIS, live schema, and governed evidence paths. Test-build reuse must remain labelled and provenance-preserving.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM public.bob_knowledge_cards
  WHERE organization_id IS NULL
    AND key = 'chore_client_research_source_to_evidence'
    AND is_active = TRUE
);
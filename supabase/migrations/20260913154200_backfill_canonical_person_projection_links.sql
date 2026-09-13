-- Backfill tenant-scoped person projections into the global identity index.
-- No cross-organization names are merged automatically; human review can merge
-- canonical_people later when identity evidence supports it.

INSERT INTO public.canonical_people (
  canonical_key, display_name, normalized_name, metadata, review_state
)
SELECT
  'person_record:' || p.id::text,
  p.display_name,
  regexp_replace(lower(trim(coalesce(p.display_name, ''))), '[^a-z0-9]+', '', 'g'),
  jsonb_build_object('backfilled_from', 'person_records', 'source_id', p.id, 'source_organization_id', p.organization_id),
  p.review_state
FROM public.person_records p
ON CONFLICT (canonical_key) DO NOTHING;

INSERT INTO public.canonical_person_links (
  canonical_person_id, source_table, source_id, organization_id, link_kind, metadata
)
SELECT cp.id, 'person_records', p.id, p.organization_id, 'projection', jsonb_build_object('review_state', p.review_state)
FROM public.person_records p
JOIN public.canonical_people cp ON cp.canonical_key = 'person_record:' || p.id::text
ON CONFLICT (source_table, source_id) DO NOTHING;

COMMENT ON TABLE public.canonical_person_links IS
  'Global person identity links. Tenant-scoped person_records remain the access-controlled projection; canonical_people can be merged only with human identity evidence.';
